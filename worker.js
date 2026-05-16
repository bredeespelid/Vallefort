/**
 * VALLEFORT — Cloudflare Worker
 * ─────────────────────────────
 * GET  /api/stats                          → Medlemmer, spillere, turneringer
 * GET  /api/meta                           → Tier list
 * GET  /api/meta/refresh                   → Tving refresh (admin)
 * GET  /api/config                         → Set/patch/sesong/admins/contributors
 * POST /api/config                         → Oppdater config (admin)
 * GET  /auth/callback                      → Discord OAuth
 * GET  /api/me                             → Innlogget bruker
 * GET  /api/comments/:patch/:slug          → Hent kommentarer
 * POST /api/comments/:patch/:slug          → Legg til kommentar (login)
 * DELETE /api/comments/:patch/:slug/:id    → Slett kommentar (admin/eier)
 * GET  /api/players                        → Leaderboard
 * POST /api/players                        → Registrer Riot ID (login)
 * POST /api/players/me                     → Oppdater egen rank (login)
 * DELETE /api/players/me                   → Avregistrer (login)
 * POST /api/admin/players/refresh-all      → Refresh alle spillere (admin)
 * GET  /api/tournaments                    → Liste turneringer
 * POST /api/tournaments                    → Opprett turnering (contributor/admin)
 * PUT  /api/tournaments/:id               → Rediger turnering (eier contributor/admin)
 * DELETE /api/tournaments/:id             → Slett turnering (eier contributor/admin)
 * POST /api/tournaments/:id/register       → Meld på (login)
 * DELETE /api/tournaments/:id/register     → Meld av (login)
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const KV_META        = 'meta:tierlist';
const KV_META_TS     = 'meta:timestamp';
const KV_CONFIG      = 'config';
const KV_TOURNAMENTS = 'tournaments';
const KV_MEMBERS     = 'members';
const KV_POSTS       = 'posts';
const KV_PLAYERS     = 'players';
const SOURCE_URL     = 'https://tftacademy.com/tierlist/comps';

const MAX_COMMENT_LEN       = 500;
const MAX_COMMENTS_PER_COMP = 200;

const REGION_CLUSTER = {
  euw1:'europe', eun1:'europe', tr1:'europe', ru:'europe',
  na1:'americas', br1:'americas', la1:'americas', la2:'americas',
  kr:'asia', jp1:'asia', oc1:'sea',
};
const TIER_SCORE = { CHALLENGER:9000, GRANDMASTER:8000, MASTER:7000, DIAMOND:6000, EMERALD:5000, PLATINUM:4000, GOLD:3000, SILVER:2000, BRONZE:1000, IRON:0 };
const RANK_SCORE = { I:300, II:200, III:100, IV:0 };

const VALID_RANKS   = ['Alle', 'Iron+', 'Bronze+', 'Silver+', 'Gold+', 'Platinum+', 'Diamond+', 'Master+'];
const VALID_FORMATS = ['Enkelt utslagsspill', 'Dobbel utslagsspill', 'Roundrobin', 'Sveitsisk'];
const VALID_STATUSES = ['open', 'closed', 'ongoing', 'finished'];

// ─── ROUTER ───────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      if (path === '/api/stats')        return handleStats(request, env);
      if (path === '/api/meta')         return handleMeta(request, env);
      if (path === '/api/meta/refresh') return handleMetaRefresh(request, env);
      if (path === '/api/config')       return handleConfig(request, env);
      if (path === '/auth/callback')    return handleDiscordCallback(request, env);
      if (path === '/api/me')                          return handleMe(request, env);
      if (path === '/api/players')                     return handlePlayers(request, env);
      if (path === '/api/players/me')                  return handlePlayerMe(request, env);
      if (path === '/api/admin/players/refresh-all')   return handleAdminRefreshAllPlayers(request, env);
      if (path === '/api/tournaments')                 return handleTournaments(request, env);
      if (path === '/api/posts')        return handlePosts(request, env);
      if (path === '/api/admin/members') return handleAdminMembers(request, env);

      const postDelM = path.match(/^\/api\/posts\/([^/]+)$/);
      if (postDelM) return handlePostById(request, env, postDelM[1]);

      const cmMatch = path.match(/^\/api\/comments\/([^/]+)\/([^/]+)$/);
      if (cmMatch) return handleComments(request, env, cmMatch[1], cmMatch[2]);

      const cmVoteM = path.match(/^\/api\/comments\/([^/]+)\/([^/]+)\/([^/]+)\/vote$/);
      if (cmVoteM) return handleCommentVote(request, env, cmVoteM[1], cmVoteM[2], cmVoteM[3]);

      const cmDelMatch = path.match(/^\/api\/comments\/([^/]+)\/([^/]+)\/([^/]+)$/);
      if (cmDelMatch) return handleDeleteComment(request, env, cmDelMatch[1], cmDelMatch[2], cmDelMatch[3]);


      const tByIdM = path.match(/^\/api\/tournaments\/([^/]+)$/);
      if (tByIdM) return handleTournamentById(request, env, tByIdM[1]);

      const tRegM = path.match(/^\/api\/tournaments\/([^/]+)\/register$/);
      if (tRegM) return handleTournamentRegistration(request, env, tRegM[1]);

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyScrape(env));
  },
};

// ─── POSTS ────────────────────────────────────────────────────────────────────
async function handlePosts(request, env) {
  if (request.method === 'GET') {
    const raw = await env.KV.get(KV_POSTS);
    return json(raw ? JSON.parse(raw) : []);
  }
  if (request.method === 'POST') {
    const user = await getUser(request, env);
    if (!user) return json({ error: 'Ikke innlogget' }, 401);
    const cfg = await getConfig(env);
    if (!isAdminFull(user.id, env, cfg) && !isContributor(user.id, cfg)) return json({ error: 'Ingen tilgang' }, 403);
    const body = await request.json().catch(() => ({}));
    const title = (body.title || '').trim();
    const content = (body.content || '').trim();
    if (!title)   return json({ error: 'Tittel er påkrevd' }, 400);
    if (!content) return json({ error: 'Innhold er påkrevd' }, 400);
    const post = {
      id: crypto.randomUUID(),
      title:   title.slice(0, 100),
      content: content.slice(0, 1000),
      imageUrl: (body.imageUrl || '').trim().slice(0, 500) || null,
      createdBy: user.id,
      createdByUsername: user.username,
      createdByAvatar: user.avatar || null,
      createdAt: new Date().toISOString(),
    };
    const raw  = await env.KV.get(KV_POSTS);
    const posts = raw ? JSON.parse(raw) : [];
    posts.unshift(post); // Nyeste først
    if (posts.length > 20) posts.pop(); // Maks 20 innlegg
    await env.KV.put(KV_POSTS, JSON.stringify(posts));
    return json(post, 201);
  }
  return json({ error: 'Method not allowed' }, 405);
}

async function handlePostById(request, env, id) {
  if (request.method !== 'DELETE') return json({ error: 'Method not allowed' }, 405);
  const user = await getUser(request, env);
  if (!user) return json({ error: 'Ikke innlogget' }, 401);
  const raw   = await env.KV.get(KV_POSTS);
  const posts = raw ? JSON.parse(raw) : [];
  const post  = posts.find(p => p.id === id);
  if (!post) return json({ error: 'Innlegg ikke funnet' }, 404);
  const cfg = await getConfig(env);
  if (post.createdBy !== user.id && !isAdminFull(user.id, env, cfg)) return json({ error: 'Ingen tilgang' }, 403);
  await env.KV.put(KV_POSTS, JSON.stringify(posts.filter(p => p.id !== id)));
  return json({ ok: true });
}

// ─── STATS ────────────────────────────────────────────────────────────────────
async function handleAdminMembers(request, env) {
  const user = await getUser(request, env);
  if (!user) return json({ error: 'Ikke innlogget' }, 401);
  const cfg = await getConfig(env);
  if (!isAdminFull(user.id, env, cfg)) return json({ error: 'Ingen tilgang' }, 403);

  const membersRaw = await env.KV.get(KV_MEMBERS);
  const raw = membersRaw ? JSON.parse(membersRaw) : [];
  const members = raw.map(m => {
    const id = typeof m === 'string' ? m : m.id;
    return {
      id,
      username: typeof m === 'object' ? m.username : null,
      avatar:   typeof m === 'object' ? m.avatar   : null,
      joinedAt: typeof m === 'object' ? m.joinedAt : null,
      isAdmin:       isAdminFull(id, env, cfg),
      isContributor: isContributor(id, cfg),
      isProtected:   isAdmin(id, env),  // env-defined — cannot be demoted
    };
  });
  return json(members);
}

async function handleStats(request, env) {
  const [membersRaw, playersRaw, tournamentsRaw] = await Promise.all([
    env.KV.get(KV_MEMBERS),
    env.KV.get(KV_PLAYERS),
    env.KV.get(KV_TOURNAMENTS),
  ]);
  const members     = membersRaw     ? JSON.parse(membersRaw)     : [];
  const players     = playersRaw     ? JSON.parse(playersRaw)     : [];
  const tournaments = tournamentsRaw ? JSON.parse(tournamentsRaw) : [];
  const activeTours = tournaments.filter(t => t.status !== 'cancelled');
  return json({ members: members.length, registeredPlayers: players.length, tournaments: activeTours.length });
}

// ─── LOBBIES ──────────────────────────────────────────────────────────────────
async function handleLobbies(request, env) {
  const cutoff = Date.now() - LOBBY_TTL_MS;

  if (request.method === 'GET') {
    const raw      = await env.KV.get(KV_LOBBIES);
    const lobbies  = raw ? JSON.parse(raw) : [];
    const active   = lobbies.filter(l => new Date(l.createdAt).getTime() > cutoff);
    if (active.length !== lobbies.length) await env.KV.put(KV_LOBBIES, JSON.stringify(active));
    return json(active);
  }

  if (request.method === 'POST') {
    const user = await getUser(request, env);
    if (!user) return json({ error: 'Logg inn for å opprette lobby' }, 401);

    const body     = await request.json().catch(() => ({}));
    const name     = (body.name || '').trim();
    const rank     = VALID_RANKS.includes(body.rank) ? body.rank : 'Alle';
    const maxSlots = Math.min(Math.max(parseInt(body.maxSlots) || 8, 2), 8);

    if (!name)          return json({ error: 'Navn er påkrevd' }, 400);
    if (name.length > 60) return json({ error: 'Navn maks 60 tegn' }, 400);

    const raw     = await env.KV.get(KV_LOBBIES);
    const lobbies = raw ? JSON.parse(raw) : [];

    const hasActive = lobbies.some(l => l.hostId === user.id && new Date(l.createdAt).getTime() > cutoff);
    if (hasActive) return json({ error: 'Du har allerede en aktiv lobby' }, 400);

    const lobby = {
      id: crypto.randomUUID(), name, rank, maxSlots,
      joiners:    [],
      hostId:     user.id,
      hostName:   user.username,
      hostAvatar: user.avatar || null,
      createdAt:  new Date().toISOString(),
    };
    lobbies.push(lobby);
    await env.KV.put(KV_LOBBIES, JSON.stringify(lobbies));
    return json(lobby, 201);
  }

  return json({ error: 'Method not allowed' }, 405);
}

async function handleLobbyAction(request, env, lobbyId, action) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const user = await getUser(request, env);
  if (!user) return json({ error: 'Ikke innlogget' }, 401);

  const raw     = await env.KV.get(KV_LOBBIES);
  const lobbies = raw ? JSON.parse(raw) : [];
  const idx     = lobbies.findIndex(l => l.id === lobbyId);
  if (idx === -1) return json({ error: 'Lobby ikke funnet' }, 404);

  const lobby = lobbies[idx];

  if (action === 'join') {
    if (lobby.hostId === user.id)           return json({ error: 'Du er verten' }, 400);
    if (lobby.joiners.includes(user.id))    return json({ error: 'Du er allerede med' }, 400);
    if (lobby.joiners.length >= lobby.maxSlots - 1) return json({ error: 'Lobby er full' }, 400);
    lobby.joiners.push(user.id);
    lobbies[idx] = lobby;
    await env.KV.put(KV_LOBBIES, JSON.stringify(lobbies));
    return json(lobby);
  }

  if (action === 'close') {
    const cfg = await getConfig(env);
    if (lobby.hostId !== user.id && !isAdminFull(user.id, env, cfg)) return json({ error: 'Ingen tilgang' }, 403);
    lobbies.splice(idx, 1);
    await env.KV.put(KV_LOBBIES, JSON.stringify(lobbies));
    return json({ ok: true });
  }

  return json({ error: 'Ukjent handling' }, 400);
}

// ─── PLAYERS / LEADERBOARD ────────────────────────────────────────────────────
function playerScore(p) {
  if (!p.tier) return -1;
  return (TIER_SCORE[p.tier] || 0) + (RANK_SCORE[p.rank] || 0) + (p.lp || 0);
}

async function riotFetchRank(env, region, puuid, summonerId) {
  const key = env.RIOT_API_KEY;
  if (!summonerId) {
    const res = await fetch(`https://${region}.api.riotgames.com/tft/summoner/v1/summoners/by-puuid/${puuid}`, { headers:{'X-Riot-Token':key} });
    if (!res.ok) return null;
    summonerId = (await res.json()).id;
  }
  const lRes = await fetch(`https://${region}.api.riotgames.com/tft/league/v1/entries/by-summoner/${summonerId}`, { headers:{'X-Riot-Token':key} });
  if (!lRes.ok) return { summonerId, tier:null, rank:null, lp:0, wins:0, losses:0 };
  const entries = await lRes.json();
  const entry = entries.find(e => e.queueType === 'RANKED_TFT') || entries[0];
  if (!entry) return { summonerId, tier:null, rank:null, lp:0, wins:0, losses:0 };
  return { summonerId, tier:entry.tier, rank:entry.rank, lp:entry.leaguePoints, wins:entry.wins, losses:entry.losses };
}

async function handlePlayers(request, env) {
  if (request.method === 'GET') {
    const raw = await env.KV.get(KV_PLAYERS);
    const players = raw ? JSON.parse(raw) : [];
    players.sort((a, b) => playerScore(b) - playerScore(a));
    return json(players);
  }

  if (request.method === 'POST') {
    const user = await getUser(request, env);
    if (!user) return json({ error:'Ikke innlogget' }, 401);
    const body = await request.json().catch(() => ({}));
    const riotId = (body.riotId || '').trim();
    const region = (body.region || 'euw1').toLowerCase();
    if (!riotId.includes('#')) return json({ error:'Riot ID må ha format: Navn#TAG' }, 400);
    if (!REGION_CLUSTER[region]) return json({ error:'Ugyldig region' }, 400);
    const [gameName, tagLine] = riotId.split('#');
    const cluster = REGION_CLUSTER[region];
    const accRes = await fetch(`https://${cluster}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`, { headers:{'X-Riot-Token':env.RIOT_API_KEY} });
    if (!accRes.ok) return accRes.status === 404 ? json({ error:'Riot ID ikke funnet' }, 404) : json({ error:'Riot API feil, prøv igjen' }, 502);
    const acc = await accRes.json();
    const rankData = await riotFetchRank(env, region, acc.puuid, null);
    const raw = await env.KV.get(KV_PLAYERS);
    const players = raw ? JSON.parse(raw) : [];
    const player = {
      discordId: user.id, discordUsername: user.username, discordAvatar: user.avatar || null,
      riotId: `${acc.gameName}#${acc.tagLine}`, gameName: acc.gameName, tagLine: acc.tagLine,
      region, puuid: acc.puuid, summonerId: rankData?.summonerId || null,
      tier: rankData?.tier || null, rank: rankData?.rank || null,
      lp: rankData?.lp || 0, wins: rankData?.wins || 0, losses: rankData?.losses || 0,
      updatedAt: new Date().toISOString(),
    };
    const idx = players.findIndex(p => p.discordId === user.id);
    if (idx >= 0) players[idx] = player; else players.push(player);
    await env.KV.put(KV_PLAYERS, JSON.stringify(players));
    return json(player);
  }

  return json({ error:'Method not allowed' }, 405);
}

async function handlePlayerMe(request, env) {
  const user = await getUser(request, env);
  if (!user) return json({ error:'Ikke innlogget' }, 401);
  const raw = await env.KV.get(KV_PLAYERS);
  const players = raw ? JSON.parse(raw) : [];
  const idx = players.findIndex(p => p.discordId === user.id);

  if (request.method === 'DELETE') {
    if (idx >= 0) { players.splice(idx, 1); await env.KV.put(KV_PLAYERS, JSON.stringify(players)); }
    return json({ ok:true });
  }

  if (request.method === 'POST') {
    if (idx === -1) return json({ error:'Ikke registrert' }, 404);
    const p = players[idx];
    const rankData = await riotFetchRank(env, p.region, p.puuid, p.summonerId);
    if (rankData) {
      Object.assign(players[idx], { summonerId:rankData.summonerId, tier:rankData.tier, rank:rankData.rank, lp:rankData.lp, wins:rankData.wins, losses:rankData.losses, updatedAt:new Date().toISOString() });
      await env.KV.put(KV_PLAYERS, JSON.stringify(players));
    }
    return json(players[idx]);
  }

  return json({ error:'Method not allowed' }, 405);
}

async function handleAdminRefreshAllPlayers(request, env) {
  if (request.method !== 'POST') return json({ error:'Method not allowed' }, 405);
  const user = await getUser(request, env);
  if (!user) return json({ error:'Ikke innlogget' }, 401);
  const cfg = await getConfig(env);
  if (!isAdminFull(user.id, env, cfg)) return json({ error:'Krever admin' }, 403);
  const raw = await env.KV.get(KV_PLAYERS);
  const players = raw ? JSON.parse(raw) : [];
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const rankData = await riotFetchRank(env, p.region, p.puuid, p.summonerId);
    if (rankData) Object.assign(players[i], { summonerId:rankData.summonerId, tier:rankData.tier, rank:rankData.rank, lp:rankData.lp, wins:rankData.wins, losses:rankData.losses, updatedAt:new Date().toISOString() });
  }
  await env.KV.put(KV_PLAYERS, JSON.stringify(players));
  return json({ ok:true, count:players.length });
}

// ─── TOURNAMENTS ──────────────────────────────────────────────────────────────
async function handleTournaments(request, env) {
  if (request.method === 'GET') {
    const raw = await env.KV.get(KV_TOURNAMENTS);
    const all = raw ? JSON.parse(raw) : [];
    return json(all.filter(t => t.status !== 'cancelled'));
  }

  if (request.method === 'POST') {
    const user = await getUser(request, env);
    if (!user) return json({ error: 'Logg inn for å opprette turnering' }, 401);

    const cfg = await getConfig(env);
    if (!isAdminFull(user.id, env, cfg) && !isContributor(user.id, cfg)) {
      return json({ error: 'Krever contributor- eller admin-tilgang' }, 403);
    }

    const body = await request.json().catch(() => ({}));
    const name = (body.name || '').trim();
    if (!name)           return json({ error: 'Navn er påkrevd' }, 400);
    if (name.length > 80) return json({ error: 'Navn maks 80 tegn' }, 400);

    const tournament = {
      id:                  crypto.randomUUID(),
      name,
      date:                body.date      || null,
      startTime:           body.startTime || null,
      format:              VALID_FORMATS.includes(body.format) ? body.format : 'Enkelt utslagsspill',
      maxPlayers:          Math.min(Math.max(parseInt(body.maxPlayers) || 16, 4), 64),
      rankReq:             VALID_RANKS.includes(body.rankReq) ? body.rankReq : 'Alle',
      server:              (body.server || 'EUW').trim().slice(0, 10),
      prize1:              (body.prize1 || 'TBA').trim().slice(0, 60),
      prize2:              (body.prize2 || 'TBA').trim().slice(0, 60),
      description:         (body.description || '').trim().slice(0, 300),
      registrations:       [],
      status:              'open',
      winners:             null,
      createdBy:           user.id,
      createdByUsername:   user.username,
      createdAt:           new Date().toISOString(),
    };

    const raw  = await env.KV.get(KV_TOURNAMENTS);
    const all  = raw ? JSON.parse(raw) : [];
    all.push(tournament);
    await env.KV.put(KV_TOURNAMENTS, JSON.stringify(all));
    return json(tournament, 201);
  }

  return json({ error: 'Method not allowed' }, 405);
}

async function handleTournamentById(request, env, id) {
  const raw = await env.KV.get(KV_TOURNAMENTS);
  const all = raw ? JSON.parse(raw) : [];
  const idx = all.findIndex(t => t.id === id);
  if (idx === -1) return json({ error: 'Turnering ikke funnet' }, 404);

  const user = await getUser(request, env);
  if (!user) return json({ error: 'Ikke innlogget' }, 401);
  const cfg  = await getConfig(env);
  const t    = all[idx];
  const canEdit = isAdminFull(user.id, env, cfg) || (isContributor(user.id, cfg) && t.createdBy === user.id);
  if (!canEdit) return json({ error: 'Ingen tilgang' }, 403);

  if (request.method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    if (body.name        !== undefined) t.name       = (body.name || '').trim().slice(0, 80);
    if (body.date        !== undefined) t.date       = body.date || null;
    if (body.startTime   !== undefined) t.startTime  = body.startTime || null;
    if (body.format      !== undefined && VALID_FORMATS.includes(body.format))   t.format    = body.format;
    if (body.maxPlayers  !== undefined) t.maxPlayers = Math.min(Math.max(parseInt(body.maxPlayers) || 16, 4), 64);
    if (body.rankReq     !== undefined && VALID_RANKS.includes(body.rankReq))    t.rankReq   = body.rankReq;
    if (body.server      !== undefined) t.server     = (body.server || '').trim().slice(0, 10);
    if (body.prize1      !== undefined) t.prize1     = (body.prize1 || 'TBA').trim().slice(0, 60);
    if (body.prize2      !== undefined) t.prize2     = (body.prize2 || 'TBA').trim().slice(0, 60);
    if (body.description !== undefined) t.description = (body.description || '').trim().slice(0, 300);
    if (body.status      !== undefined && VALID_STATUSES.includes(body.status))  t.status    = body.status;
    if (body.winners     !== undefined) t.winners    = body.winners || null;
    all[idx] = t;
    await env.KV.put(KV_TOURNAMENTS, JSON.stringify(all));
    return json(t);
  }

  if (request.method === 'DELETE') {
    all.splice(idx, 1);
    await env.KV.put(KV_TOURNAMENTS, JSON.stringify(all));
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}

async function handleTournamentRegistration(request, env, id) {
  const user = await getUser(request, env);
  if (!user) return json({ error: 'Logg inn for å melde deg på' }, 401);

  const raw = await env.KV.get(KV_TOURNAMENTS);
  const all = raw ? JSON.parse(raw) : [];
  const idx = all.findIndex(t => t.id === id);
  if (idx === -1) return json({ error: 'Turnering ikke funnet' }, 404);
  const t = all[idx];

  if (request.method === 'POST') {
    if (t.status !== 'open')                           return json({ error: 'Påmelding er ikke åpen' }, 400);
    if (t.registrations.length >= t.maxPlayers)        return json({ error: 'Turneringen er full' }, 400);
    if (t.registrations.some(r => r.userId === user.id)) return json({ error: 'Du er allerede påmeldt' }, 400);
    t.registrations.push({ userId: user.id, username: user.username, avatar: user.avatar || null, registeredAt: new Date().toISOString() });
    all[idx] = t;
    await env.KV.put(KV_TOURNAMENTS, JSON.stringify(all));
    return json({ ok: true, count: t.registrations.length });
  }

  if (request.method === 'DELETE') {
    const before = t.registrations.length;
    t.registrations = t.registrations.filter(r => r.userId !== user.id);
    if (t.registrations.length === before) return json({ error: 'Du er ikke påmeldt' }, 400);
    all[idx] = t;
    await env.KV.put(KV_TOURNAMENTS, JSON.stringify(all));
    return json({ ok: true, count: t.registrations.length });
  }

  return json({ error: 'Method not allowed' }, 405);
}

// ─── COMMENTS ─────────────────────────────────────────────────────────────────
async function handleComments(request, env, patch, slug) {
  const key = `comments:${patch}:${slug}`;

  if (request.method === 'GET') {
    const raw      = await env.KV.get(key);
    const comments = raw ? JSON.parse(raw) : [];
    return json({ patch, slug, comments, count: comments.length });
  }

  if (request.method === 'POST') {
    const user = await getUser(request, env);
    if (!user) return json({ error: 'Logg inn med Discord for å kommentere' }, 401);

    const body = await request.json().catch(() => ({}));
    const text = (body.text || '').trim();
    if (!text)                         return json({ error: 'Kommentar kan ikke være tom' }, 400);
    if (text.length > MAX_COMMENT_LEN) return json({ error: `Maks ${MAX_COMMENT_LEN} tegn` }, 400);

    const raw      = await env.KV.get(key);
    const comments = raw ? JSON.parse(raw) : [];
    if (comments.length >= MAX_COMMENTS_PER_COMP) return json({ error: 'Maks antall kommentarer nådd' }, 400);

    const replyTo = body.replyTo && body.replyTo.id ? { id: body.replyTo.id, username: body.replyTo.username, text: String(body.replyTo.text || '').slice(0, 120) } : null;
    const newComment = { id: crypto.randomUUID(), userId: user.id, username: user.username, avatar: user.avatar || null, text, replyTo, patch, slug, createdAt: new Date().toISOString() };
    comments.push(newComment);
    await env.KV.put(key, JSON.stringify(comments));
    return json(newComment, 201);
  }

  return json({ error: 'Method not allowed' }, 405);
}

async function handleCommentVote(request, env, patch, slug, commentId) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const user = await getUser(request, env);
  if (!user) return json({ error: 'Ikke innlogget' }, 401);
  const body = await request.json().catch(() => ({}));
  const type = body.type;
  if (type !== 'like' && type !== 'dislike') return json({ error: 'Ugyldig stemme' }, 400);
  const key      = `comments:${patch}:${slug}`;
  const raw      = await env.KV.get(key);
  const comments = raw ? JSON.parse(raw) : [];
  const comment  = comments.find(c => c.id === commentId);
  if (!comment) return json({ error: 'Kommentar ikke funnet' }, 404);
  if (!comment.likes)    comment.likes    = [];
  if (!comment.dislikes) comment.dislikes = [];
  // Remove from opposite
  if (type === 'like')    comment.dislikes = comment.dislikes.filter(id => id !== user.id);
  if (type === 'dislike') comment.likes    = comment.likes.filter(id => id !== user.id);
  // Toggle
  const arr = type === 'like' ? comment.likes : comment.dislikes;
  const idx = arr.indexOf(user.id);
  if (idx >= 0) arr.splice(idx, 1); else arr.push(user.id);
  await env.KV.put(key, JSON.stringify(comments));
  return json({ likes: comment.likes.length, dislikes: comment.dislikes.length });
}

async function handleDeleteComment(request, env, patch, slug, commentId) {
  if (request.method !== 'DELETE') return json({ error: 'Method not allowed' }, 405);
  const user = await getUser(request, env);
  if (!user) return json({ error: 'Ikke innlogget' }, 401);

  const key      = `comments:${patch}:${slug}`;
  const raw      = await env.KV.get(key);
  const comments = raw ? JSON.parse(raw) : [];
  const comment  = comments.find(c => c.id === commentId);
  if (!comment) return json({ error: 'Kommentar ikke funnet' }, 404);

  const cfg = await getConfig(env);
  if (comment.userId !== user.id && !isAdminFull(user.id, env, cfg)) return json({ error: 'Ingen tilgang' }, 403);

  await env.KV.put(key, JSON.stringify(comments.filter(c => c.id !== commentId)));
  return json({ ok: true, deleted: commentId });
}

// ─── DAGLIG SCRAPE ────────────────────────────────────────────────────────────
async function runDailyScrape(env) {
  try {
    const data = await scrapeTftAcademy();
    await env.KV.put(KV_META,    JSON.stringify(data));
    await env.KV.put(KV_META_TS, new Date().toISOString());
  } catch (e) {
    console.error('Scrape feilet:', e.message);
  }
}

// ─── SCRAPER ──────────────────────────────────────────────────────────────────
async function scrapeTftAcademy() {
  const res = await fetch(SOURCE_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Vallefort/1.0)', 'Accept': 'text/html' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseTierList(res);
}

async function parseTierList(response) {
  const tiers = { S: [], A: [], B: [], C: [] };
  const seen  = new Set();
  let currentTier = null;
  let setNum      = 17;
  let patch       = '?';
  let h2Buf       = '';

  await new HTMLRewriter()
    .on('h2', {
      element() { h2Buf = ''; currentTier = null; },
      text(chunk) {
        h2Buf += chunk.text;
        const m = h2Buf.match(/([SABC])\s+tier/i);
        if (m) currentTier = m[1].toUpperCase();
      },
    })
    .on('a', {
      element(el) {
        const href = el.getAttribute('href') || '';
        const m    = href.match(/^\/tierlist\/comps\/(set-(\d+)-[\w-]+)/);
        if (!m || !currentTier || !tiers[currentTier]) return;
        const slug = m[1];
        if (seen.has(slug)) return;
        seen.add(slug);
        setNum = parseInt(m[2]);
        const name = slug
          .replace(/^set-\d+-/, '')
          .replace(/-(\d+)-(\d+)(?=-|$)/g, '-$1.$2')
          .replace(/-/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase());
        tiers[currentTier].push({ name, url: `https://tftacademy.com${href}`, slug });
      },
    })
    .on('*', {
      text(chunk) {
        if (patch !== '?') return;
        const m = chunk.text.match(/Patch\s+(\d+\.\d+[a-z]?)/i);
        if (m) patch = m[1];
      },
    })
    .transform(response)
    .text();

  return {
    source: 'tftacademy.com', sourceUrl: SOURCE_URL,
    set: setNum,
    patch: patch !== '?' ? patch : `${setNum}.1`,
    fetchedAt: new Date().toISOString(),
    fallback: false,
    tiers,
  };
}

// ─── META ─────────────────────────────────────────────────────────────────────
async function handleMeta(request, env) {
  const cached = await env.KV.get(KV_META);
  const ts     = await env.KV.get(KV_META_TS);
  if (cached) { const d = JSON.parse(cached); d.cachedAt = ts; return json(d); }
  try {
    const data = await scrapeTftAcademy();
    await env.KV.put(KV_META, JSON.stringify(data));
    await env.KV.put(KV_META_TS, new Date().toISOString());
    return json(data);
  } catch (e) { return json(getFallback(e.message)); }
}

async function handleMetaRefresh(request, env) {
  const user = await getUser(request, env);
  const cfg  = await getConfig(env);
  if (!user || !isAdminFull(user.id, env, cfg)) return json({ error: 'Unauthorized' }, 401);
  try {
    const data = await scrapeTftAcademy();
    await env.KV.put(KV_META, JSON.stringify(data));
    await env.KV.put(KV_META_TS, new Date().toISOString());
    return json({ ok: true, refreshed: new Date().toISOString(), data });
  } catch (e) { return json({ ok: false, error: e.message }, 500); }
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
async function handleConfig(request, env) {
  if (request.method === 'GET') {
    return json(await getConfig(env));
  }
  const user = await getUser(request, env);
  const cfg  = await getConfig(env);
  if (!user || !isAdminFull(user.id, env, cfg)) return json({ error: 'Unauthorized' }, 401);

  const body    = await request.json();
  const updated = { ...cfg };
  if (body.set          !== undefined) updated.set          = body.set;
  if (body.patch        !== undefined) updated.patch        = body.patch;
  if (body.season       !== undefined) updated.season       = body.season;
  if (body.contributors !== undefined) updated.contributors = body.contributors;
  if (body.admins !== undefined) {
    // Env-defined admins (ADMIN_DISCORD_IDS) are protected — cannot be removed via config
    const envAdmins = (env.ADMIN_DISCORD_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    const merged = [...new Set([...envAdmins, ...body.admins.filter(id => !envAdmins.includes(String(id)))])];
    updated.admins = merged;
  }
  updated.updatedAt = new Date().toISOString();
  updated.updatedBy = user.username;
  await env.KV.put(KV_CONFIG, JSON.stringify(updated));
  return json(updated);
}

// ─── DISCORD OAUTH ────────────────────────────────────────────────────────────
async function handleDiscordCallback(request, env) {
  const url  = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) return new Response('Mangler code', { status: 400 });

  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: env.DISCORD_REDIRECT_URI }),
  });
  if (!tokenRes.ok) return new Response(`Token-feil: ${await tokenRes.text()}`, { status: 400 });

  const { access_token } = await tokenRes.json();
  const discordUser = await (await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${access_token}` } })).json();

  // Spor membre med full brukerinfo
  const membersRaw = await env.KV.get(KV_MEMBERS);
  const members    = membersRaw ? JSON.parse(membersRaw) : [];
  const memberAvatar = discordUser.avatar
    ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
    : null;
  const existingIdx = members.findIndex(m => (typeof m === 'string' ? m : m.id) === discordUser.id);
  const memberEntry = { id: discordUser.id, username: discordUser.username, avatar: memberAvatar, joinedAt: existingIdx >= 0 ? (members[existingIdx].joinedAt || new Date().toISOString()) : new Date().toISOString() };
  if (existingIdx >= 0) members[existingIdx] = memberEntry;
  else members.push(memberEntry);
  await env.KV.put(KV_MEMBERS, JSON.stringify(members));

  const cfg    = await getConfig(env);
  const avatar = discordUser.avatar
    ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
    : null;

  const payload = {
    id:            discordUser.id,
    username:      discordUser.username,
    avatar,
    isAdmin:       isAdminFull(discordUser.id, env, cfg),
    isContributor: isContributor(discordUser.id, cfg),
    exp:           Date.now() + 7 * 24 * 60 * 60 * 1000,
  };
  const token  = await signJWT(payload, env.JWT_SECRET || 'vallefort-secret');
  const origin = env.SITE_ORIGIN || 'https://bredeespelid.github.io';
  return Response.redirect(`${origin}/Vallefort/?token=${token}`, 302);
}

async function handleMe(request, env) {
  const user = await getUser(request, env);
  if (!user) return json({ error: 'Ikke innlogget' }, 401);
  return json(user);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function getConfig(env) {
  const raw = await env.KV.get(KV_CONFIG);
  return raw ? JSON.parse(raw) : defaultConfig();
}

function defaultConfig() {
  return { set: 17, patch: '17.1', season: 'Sesong 14', admins: [], contributors: [], updatedAt: new Date().toISOString() };
}

function isAdmin(id, env) {
  return (env.ADMIN_DISCORD_IDS || '').split(',').map(s => s.trim()).filter(Boolean).includes(String(id));
}

function isAdminFull(id, env, cfg) {
  return isAdmin(id, env) || (cfg?.admins || []).includes(String(id));
}

function isContributor(id, cfg) {
  return (cfg?.contributors || []).includes(String(id));
}

function getFallback(e) {
  return { source: 'tftacademy.com', sourceUrl: SOURCE_URL, set: null, patch: null, fetchedAt: new Date().toISOString(), fallback: true, error: e, tiers: { S: [], A: [], B: [], C: [] } };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

async function signJWT(payload, secret) {
  const h = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const b = btoa(JSON.stringify(payload));
  const m = `${h}.${b}`;
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(m));
  return `${m}.${btoa(String.fromCharCode(...new Uint8Array(s)))}`;
}

async function verifyJWT(token, secret) {
  try {
    const [h, b, s] = token.split('.');
    const m = `${h}.${b}`;
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('HMAC', k, Uint8Array.from(atob(s), c => c.charCodeAt(0)), new TextEncoder().encode(m));
    if (!ok) return null;
    const p = JSON.parse(atob(b));
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch { return null; }
}

async function getUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const t    = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!t) return null;
  return verifyJWT(t, env.JWT_SECRET || 'vallefort-secret');
}
