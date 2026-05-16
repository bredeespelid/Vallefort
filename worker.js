/**
 * VALLEFORT — Cloudflare Worker
 * ─────────────────────────────
 * GET  /api/stats                          → Medlemmer, lobbyer, turneringer
 * GET  /api/meta                           → Tier list
 * GET  /api/meta/refresh                   → Tving refresh (admin)
 * GET  /api/config                         → Set/patch/sesong/admins/contributors
 * POST /api/config                         → Oppdater config (admin)
 * GET  /auth/callback                      → Discord OAuth
 * GET  /api/me                             → Innlogget bruker
 * GET  /api/comments/:patch/:slug          → Hent kommentarer
 * POST /api/comments/:patch/:slug          → Legg til kommentar (login)
 * DELETE /api/comments/:patch/:slug/:id    → Slett kommentar (admin/eier)
 * GET  /api/lobbies                        → Liste aktive lobbyer
 * POST /api/lobbies                        → Opprett lobby (login)
 * POST /api/lobbies/:id/join               → Bli med i lobby (login)
 * POST /api/lobbies/:id/close              → Steng lobby (eier/admin)
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
const KV_LOBBIES     = 'lobbies';
const KV_TOURNAMENTS = 'tournaments';
const KV_MEMBERS     = 'members';
const SOURCE_URL     = 'https://tftacademy.com/tierlist/comps';

const MAX_COMMENT_LEN      = 500;
const MAX_COMMENTS_PER_COMP = 200;
const LOBBY_TTL_MS         = 4 * 60 * 60 * 1000; // 4 timer

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
      if (path === '/api/me')           return handleMe(request, env);
      if (path === '/api/lobbies')      return handleLobbies(request, env);
      if (path === '/api/tournaments')  return handleTournaments(request, env);

      const cmMatch = path.match(/^\/api\/comments\/([^/]+)\/([^/]+)$/);
      if (cmMatch) return handleComments(request, env, cmMatch[1], cmMatch[2]);

      const cmDelMatch = path.match(/^\/api\/comments\/([^/]+)\/([^/]+)\/([^/]+)$/);
      if (cmDelMatch) return handleDeleteComment(request, env, cmDelMatch[1], cmDelMatch[2], cmDelMatch[3]);

      const lobbyActM = path.match(/^\/api\/lobbies\/([^/]+)\/(join|close)$/);
      if (lobbyActM) return handleLobbyAction(request, env, lobbyActM[1], lobbyActM[2]);

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

// ─── STATS ────────────────────────────────────────────────────────────────────
async function handleStats(request, env) {
  const [membersRaw, lobbiesRaw, tournamentsRaw] = await Promise.all([
    env.KV.get(KV_MEMBERS),
    env.KV.get(KV_LOBBIES),
    env.KV.get(KV_TOURNAMENTS),
  ]);
  const members     = membersRaw     ? JSON.parse(membersRaw)     : [];
  const allLobbies  = lobbiesRaw     ? JSON.parse(lobbiesRaw)     : [];
  const tournaments = tournamentsRaw ? JSON.parse(tournamentsRaw) : [];

  const cutoff       = Date.now() - LOBBY_TTL_MS;
  const activeLobbies = allLobbies.filter(l => new Date(l.createdAt).getTime() > cutoff);
  const activeTours  = tournaments.filter(t => t.status !== 'cancelled');

  return json({ members: members.length, activeLobbies: activeLobbies.length, tournaments: activeTours.length });
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
      date:                body.date   || null,
      format:              VALID_FORMATS.includes(body.format) ? body.format : 'Enkelt utslagsspill',
      maxPlayers:          Math.min(Math.max(parseInt(body.maxPlayers) || 16, 4), 64),
      rankReq:             VALID_RANKS.includes(body.rankReq) ? body.rankReq : 'Alle',
      server:              (body.server || 'EUW').trim().slice(0, 10),
      prize1:              (body.prize1 || 'TBA').trim().slice(0, 60),
      prize2:              (body.prize2 || 'TBA').trim().slice(0, 60),
      description:         (body.description || '').trim().slice(0, 300),
      registrations:       [],
      status:              'open',
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
    if (body.format      !== undefined && VALID_FORMATS.includes(body.format))   t.format    = body.format;
    if (body.maxPlayers  !== undefined) t.maxPlayers = Math.min(Math.max(parseInt(body.maxPlayers) || 16, 4), 64);
    if (body.rankReq     !== undefined && VALID_RANKS.includes(body.rankReq))    t.rankReq   = body.rankReq;
    if (body.server      !== undefined) t.server     = (body.server || '').trim().slice(0, 10);
    if (body.prize1      !== undefined) t.prize1     = (body.prize1 || 'TBA').trim().slice(0, 60);
    if (body.prize2      !== undefined) t.prize2     = (body.prize2 || 'TBA').trim().slice(0, 60);
    if (body.description !== undefined) t.description = (body.description || '').trim().slice(0, 300);
    if (body.status      !== undefined && VALID_STATUSES.includes(body.status))  t.status    = body.status;
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

    const newComment = { id: crypto.randomUUID(), userId: user.id, username: user.username, avatar: user.avatar || null, text, patch, slug, createdAt: new Date().toISOString() };
    comments.push(newComment);
    await env.KV.put(key, JSON.stringify(comments));
    return json(newComment, 201);
  }

  return json({ error: 'Method not allowed' }, 405);
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
  if (body.admins       !== undefined) updated.admins       = body.admins;
  if (body.contributors !== undefined) updated.contributors = body.contributors;
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

  // Spor membre
  const membersRaw = await env.KV.get(KV_MEMBERS);
  const members    = membersRaw ? JSON.parse(membersRaw) : [];
  if (!members.includes(discordUser.id)) {
    members.push(discordUser.id);
    await env.KV.put(KV_MEMBERS, JSON.stringify(members));
  }

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
