/**
 * VALLEFORT — Cloudflare Worker
 * ─────────────────────────────
 * Endepunkter:
 *   GET  /api/meta                        → Tier list fra tftacademy.com
 *   GET  /api/meta/refresh                → Tving refresh (admin)
 *   GET  /api/config                      → Set/patch/sesong
 *   POST /api/config                      → Oppdater config (admin)
 *   GET  /auth/callback                   → Discord OAuth
 *   GET  /api/me                          → Innlogget bruker
 *   GET  /api/comments/:patch/:slug       → Hent kommentarer for comp+patch
 *   POST /api/comments/:patch/:slug       → Legg til kommentar (krever login)
 *   DELETE /api/comments/:patch/:slug/:id → Slett kommentar (admin eller eier)
 *
 * KV-nøkler for kommentarer:
 *   comments:{patch}:{slug}  → JSON-array med kommentarer
 *
 * Kommentarer nullstilles automatisk per patch — ny patch = ny nøkkel.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const KV_META    = 'meta:tierlist';
const KV_META_TS = 'meta:timestamp';
const KV_CONFIG  = 'config';
const SOURCE_URL = 'https://tftacademy.com/tierlist/comps';
const MAX_COMMENT_LENGTH = 500;
const MAX_COMMENTS_PER_COMP = 200;

// ─── ROUTER ───────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      if (path === '/api/meta')                return handleMeta(request, env);
      if (path === '/api/meta/refresh')        return handleMetaRefresh(request, env);
      if (path === '/api/config')              return handleConfig(request, env);
      if (path === '/auth/callback')           return handleDiscordCallback(request, env);
      if (path === '/api/me')                  return handleMe(request, env);

      // /api/comments/:patch/:slug
      const cmMatch = path.match(/^\/api\/comments\/([^/]+)\/([^/]+)$/);
      if (cmMatch) return handleComments(request, env, cmMatch[1], cmMatch[2]);

      // /api/comments/:patch/:slug/:id
      const delMatch = path.match(/^\/api\/comments\/([^/]+)\/([^/]+)\/([^/]+)$/);
      if (delMatch) return handleDeleteComment(request, env, delMatch[1], delMatch[2], delMatch[3]);

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyScrape(env));
  },
};

// ─── COMMENTS: GET + POST ─────────────────────────────────────────────────────
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

    if (!text)                              return json({ error: 'Kommentar kan ikke være tom' }, 400);
    if (text.length > MAX_COMMENT_LENGTH)   return json({ error: `Maks ${MAX_COMMENT_LENGTH} tegn` }, 400);

    const raw      = await env.KV.get(key);
    const comments = raw ? JSON.parse(raw) : [];

    if (comments.length >= MAX_COMMENTS_PER_COMP) {
      return json({ error: 'Maks antall kommentarer nådd for denne compen' }, 400);
    }

    const newComment = {
      id:        crypto.randomUUID(),
      userId:    user.id,
      username:  user.username,
      avatar:    user.avatar || null,
      text,
      patch,
      slug,
      createdAt: new Date().toISOString(),
    };

    comments.push(newComment);
    await env.KV.put(key, JSON.stringify(comments));
    return json(newComment, 201);
  }

  return json({ error: 'Method not allowed' }, 405);
}

// ─── COMMENTS: DELETE ─────────────────────────────────────────────────────────
async function handleDeleteComment(request, env, patch, slug, commentId) {
  if (request.method !== 'DELETE') return json({ error: 'Method not allowed' }, 405);

  const user = await getUser(request, env);
  if (!user) return json({ error: 'Ikke innlogget' }, 401);

  const key      = `comments:${patch}:${slug}`;
  const raw      = await env.KV.get(key);
  const comments = raw ? JSON.parse(raw) : [];

  const comment = comments.find(c => c.id === commentId);
  if (!comment) return json({ error: 'Kommentar ikke funnet' }, 404);

  // Kun eier eller admin kan slette
  if (comment.userId !== user.id && !isAdmin(user.id, env)) {
    return json({ error: 'Ingen tilgang' }, 403);
  }

  const updated = comments.filter(c => c.id !== commentId);
  await env.KV.put(key, JSON.stringify(updated));
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
  return parseTierList(await res.text());
}

function parseTierList(html) {
  const tiers  = { S: [], A: [], B: [], C: [] };

  // Patch
  const patchM = html.match(/>(\d+\.\d+[a-z]?)</);
  const patch  = patchM ? patchM[1] : '17.3';

  // Set
  const setM   = html.match(/set-(\d+)-/);
  const setNum = setM ? parseInt(setM[1]) : 17;

  // Dataen ligger i en stor guides:[...] array i script-taggen.
  // Hent alle par av {tier:"X", compSlug:"set-17-...", metaTitle:"..."} med regex
  // Formatet er: tier:"S",...,compSlug:"set-17-dark-star",...,metaTitle:"Dark Star Flex"
  // eller compSlug først, så tier

  const seen = new Set();

  // Regex: finn alle compSlug + tier kombos
  // compSlug:"set-17-xxx" kan komme før eller etter tier:"S"
  // Vi bruker et vindu på ~500 tegn rundt hvert compSlug
  const slugRe = /compSlug:"(set-\d+-[^"]+)"/g;
  let sm;

  while ((sm = slugRe.exec(html)) !== null) {
    const slug = sm[1];
    if (seen.has(slug) || !slug) continue;

    // Søk i et vindu rundt slug-posisjonen etter tier
    const start  = Math.max(0, sm.index - 200);
    const end    = Math.min(html.length, sm.index + 500);
    const window = html.slice(start, end);

    // Finn tier i vinduet
    const tierM = window.match(/tier:"([SABCX])"/);
    if (!tierM) continue;

    const tier = tierM[1];
    if (!tiers[tier]) continue; // ignorer X-tier

    seen.add(slug);

    // Finn metaTitle i vinduet
    const titleM = window.match(/metaTitle:"([^"]+)"/);
    const name   = titleM?.[1] || slug.replace(/^set-\d+-/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    // Ignorer comps uten compSlug (tomme slugs er private/draft)
    tiers[tier].push({
      name,
      url:  `https://tftacademy.com/tierlist/comps/${slug}`,
      slug,
    });
  }

  return {
    source:    'tftacademy.com',
    sourceUrl: SOURCE_URL,
    set:       setNum,
    patch,
    fetchedAt: new Date().toISOString(),
    fallback:  false,
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
  if (!user || !isAdmin(user.id, env)) return json({ error: 'Unauthorized' }, 401);
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
    const raw = await env.KV.get(KV_CONFIG);
    return json(raw ? JSON.parse(raw) : defaultConfig());
  }
  const user = await getUser(request, env);
  if (!user || !isAdmin(user.id, env)) return json({ error: 'Unauthorized' }, 401);
  const body    = await request.json();
  const raw     = await env.KV.get(KV_CONFIG);
  const current = raw ? JSON.parse(raw) : defaultConfig();
  const updated = { ...current, ...(body.set !== undefined && { set: body.set }), ...(body.patch !== undefined && { patch: body.patch }), ...(body.season !== undefined && { season: body.season }), ...(body.admins !== undefined && { admins: body.admins }), updatedAt: new Date().toISOString(), updatedBy: user.username };
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

  const payload = { id: discordUser.id, username: discordUser.username, avatar: discordUser.avatar ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png` : null, isAdmin: isAdmin(discordUser.id, env), exp: Date.now() + 7 * 24 * 60 * 60 * 1000 };
  const token   = await signJWT(payload, env.JWT_SECRET || 'vallefort-secret');
  const origin  = env.SITE_ORIGIN || 'https://bredeespelid.github.io';
  return Response.redirect(`${origin}/Vallefort/?token=${token}`, 302);
}

async function handleMe(request, env) {
  const user = await getUser(request, env);
  if (!user) return json({ error: 'Ikke innlogget' }, 401);
  return json(user);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function getFallback(e) { return { source: 'tftacademy.com', sourceUrl: SOURCE_URL, set: null, patch: null, fetchedAt: new Date().toISOString(), fallback: true, error: e, tiers: { S: [], A: [], B: [], C: [] } }; }
function defaultConfig() { return { set: 17, patch: '17.3', season: 'Sesong 14', admins: [], updatedAt: new Date().toISOString() }; }
function isAdmin(id, env) { return (env.ADMIN_DISCORD_IDS || '').split(',').map(s => s.trim()).includes(String(id)); }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } }); }

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
