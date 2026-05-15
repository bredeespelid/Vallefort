/**
 * VALLEFORT — Cloudflare Worker
 * ─────────────────────────────
 * Endepunkter:
 *   GET  /api/meta          → Henter/returnerer cached tier list fra tftactics.gg
 *   GET  /api/meta/refresh  → Tvinger refresh (kun admins)
 *   GET  /api/config        → Returnerer set/patch/admins (public read)
 *   POST /api/config        → Oppdaterer config (kun admins)
 *   GET  /auth/callback     → Discord OAuth callback → returnerer JWT
 *   GET  /api/me            → Returnerer innlogget bruker (fra JWT)
 *
 * KV-namespaces som må opprettes i Cloudflare Dashboard:
 *   VALLEFORT_KV  (bind som "KV" i worker settings)
 *
 * Miljøvariabler som må settes i Cloudflare Dashboard:
 *   DISCORD_CLIENT_ID
 *   DISCORD_CLIENT_SECRET
 *   DISCORD_REDIRECT_URI    (f.eks. https://vallefort.pages.dev/auth/callback)
 *   ADMIN_DISCORD_IDS       (kommaseparert, f.eks. "123456789,987654321")
 *   JWT_SECRET              (valgfri tilfeldig streng)
 *   SITE_ORIGIN             (f.eks. https://vallefort.pages.dev)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ─── KV KEYS ────────────────────────────────────────────────────────────────
const KV_META        = 'meta:tierlist';
const KV_META_TTL    = 'meta:ttl';
const KV_CONFIG      = 'config';
const META_CACHE_SEC = 3600; // 1 time mellom fetches

// ─── ROUTER ─────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      if (url.pathname === '/api/meta')            return handleMeta(request, env);
      if (url.pathname === '/api/meta/refresh')    return handleMetaRefresh(request, env);
      if (url.pathname === '/api/config')          return handleConfig(request, env);
      if (url.pathname === '/auth/callback')       return handleDiscordCallback(request, env);
      if (url.pathname === '/api/me')              return handleMe(request, env);
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};

// ─── GET /api/meta ───────────────────────────────────────────────────────────
async function handleMeta(request, env) {
  const ttl    = await env.KV.get(KV_META_TTL);
  const now    = Date.now();
  const cached = await env.KV.get(KV_META);

  if (cached && ttl && now < Number(ttl)) {
    return json(JSON.parse(cached));
  }

  // Hent fersk data
  const fresh = await fetchTftacticsMeta();
  await env.KV.put(KV_META,     JSON.stringify(fresh));
  await env.KV.put(KV_META_TTL, String(now + META_CACHE_SEC * 1000));

  return json(fresh);
}

// ─── GET /api/meta/refresh ───────────────────────────────────────────────────
async function handleMetaRefresh(request, env) {
  const user = await getUser(request, env);
  if (!user || !isAdmin(user.id, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const fresh = await fetchTftacticsMeta();
  await env.KV.put(KV_META,     JSON.stringify(fresh));
  await env.KV.put(KV_META_TTL, String(Date.now() + META_CACHE_SEC * 1000));
  return json({ ok: true, refreshed: new Date().toISOString(), data: fresh });
}

// ─── GET/POST /api/config ────────────────────────────────────────────────────
async function handleConfig(request, env) {
  if (request.method === 'GET') {
    const raw = await env.KV.get(KV_CONFIG);
    const cfg = raw ? JSON.parse(raw) : defaultConfig();
    return json(cfg);
  }

  // POST — kun admins
  const user = await getUser(request, env);
  if (!user || !isAdmin(user.id, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const body   = await request.json();
  const raw    = await env.KV.get(KV_CONFIG);
  const current = raw ? JSON.parse(raw) : defaultConfig();

  const updated = {
    ...current,
    ...(body.set      !== undefined && { set: body.set }),
    ...(body.patch    !== undefined && { patch: body.patch }),
    ...(body.season   !== undefined && { season: body.season }),
    ...(body.admins   !== undefined && { admins: body.admins }),
    updatedAt: new Date().toISOString(),
    updatedBy: user.username,
  };

  await env.KV.put(KV_CONFIG, JSON.stringify(updated));
  return json(updated);
}

// ─── GET /auth/callback ──────────────────────────────────────────────────────
async function handleDiscordCallback(request, env) {
  const url    = new URL(request.url);
  const code   = url.searchParams.get('code');
  const state  = url.searchParams.get('state');

  if (!code) return new Response('Mangler code', { status: 400 });

  // Bytt code mot token
  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type:    'authorization_code',
      code,
      redirect_uri:  env.DISCORD_REDIRECT_URI,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    return new Response(`Token-feil: ${err}`, { status: 400 });
  }

  const tokenData = await tokenRes.json();

  // Hent brukerinfo
  const userRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const discordUser = await userRes.json();

  const payload = {
    id:            discordUser.id,
    username:      discordUser.username,
    discriminator: discordUser.discriminator,
    avatar:        discordUser.avatar
      ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
      : null,
    isAdmin:       isAdmin(discordUser.id, env),
    exp:           Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 dager
  };

  const token = await signJWT(payload, env.JWT_SECRET || 'vallefort-secret');
  const origin = env.SITE_ORIGIN || 'https://vallefort.pages.dev';

  // Redirect tilbake til siden med token i URL-hash
  return Response.redirect(`${origin}/?token=${token}`, 302);
}

// ─── GET /api/me ─────────────────────────────────────────────────────────────
async function handleMe(request, env) {
  const user = await getUser(request, env);
  if (!user) return json({ error: 'Ikke innlogget' }, 401);
  return json(user);
}

// ─── SCRAPER ─────────────────────────────────────────────────────────────────
// tftactics.gg er JS-rendret, men data-kilden er sunderarmor.com CDN.
// Vi forsøker å hente det statiske data-endepunktet direkte.
// Fallback: returnerer hardkodet struktur med lenke til siden.
async function fetchTftacticsMeta() {
  // Forsøk 1: kjent CDN-path for tier list data
  const candidates = [
    'https://sunderarmor.com/tierlist/comps.json',
    'https://sunderarmor.com/data/comps.json',
    'https://sunderarmor.com/api/comps',
  ];

  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Referer':    'https://tftactics.gg/',
        },
        cf: { cacheTtl: 0 },
      });
      if (res.ok) {
        const data = await res.json();
        return normaliseComps(data, url);
      }
    } catch (_) { /* prøv neste */ }
  }

  // Fallback: returner metadata med link — frontend viser link til tftactics.gg
  return {
    source:    'tftactics.gg',
    sourceUrl: 'https://tftactics.gg/tierlist/team-comps/',
    set:       17,
    patch:     '17.3',
    fetchedAt: new Date().toISOString(),
    fallback:  true,
    tiers: {
      S: [],
      A: [],
      B: [],
      C: [],
    },
    note: 'Live data utilgjengelig — tftactics.gg er JS-rendret. Se lenke.',
  };
}

function normaliseComps(raw, source) {
  // Normaliserer ulike JSON-strukturer til et felles format
  const tiers = { S: [], A: [], B: [], C: [] };

  // Prøv vanlige strukturer
  const list = raw.comps || raw.tierlist || raw.data || raw;
  if (Array.isArray(list)) {
    for (const comp of list) {
      const tier  = (comp.tier || comp.rating || 'B').toUpperCase();
      const name  = comp.name || comp.title || comp.comp_name || 'Ukjent';
      const slug  = comp.slug || comp.url_slug || '';
      const url   = slug ? `https://tftactics.gg/tierlist/team-comps/${slug}` : source;
      if (tiers[tier] !== undefined) {
        tiers[tier].push({ name, url, playstyle: comp.playstyle || '', difficulty: comp.difficulty || '' });
      }
    }
  }

  return {
    source:    'tftactics.gg',
    sourceUrl: 'https://tftactics.gg/tierlist/team-comps/',
    set:       raw.set       || 17,
    patch:     raw.patch     || raw.version || 'ukjent',
    fetchedAt: new Date().toISOString(),
    fallback:  false,
    tiers,
  };
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function defaultConfig() {
  return {
    set:      17,
    patch:    '17.3',
    season:   'Sesong 14',
    admins:   [],
    updatedAt: new Date().toISOString(),
    updatedBy: 'system',
  };
}

function isAdmin(discordId, env) {
  const ids = (env.ADMIN_DISCORD_IDS || '').split(',').map(s => s.trim());
  return ids.includes(String(discordId));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ─── MINIMAL JWT (HMAC-SHA256) ────────────────────────────────────────────────
async function signJWT(payload, secret) {
  const header  = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body    = btoa(JSON.stringify(payload));
  const msg     = `${header}.${body}`;
  const key     = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig     = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  const sigB64  = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `${msg}.${sigB64}`;
}

async function verifyJWT(token, secret) {
  try {
    const [header, body, sig] = token.split('.');
    const msg = `${header}.${body}`;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const sigBytes = Uint8Array.from(atob(sig), c => c.charCodeAt(0));
    const valid    = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(msg));
    if (!valid) return null;
    const payload  = JSON.parse(atob(body));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

async function getUser(request, env) {
  const auth  = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  return verifyJWT(token, env.JWT_SECRET || 'vallefort-secret');
}
