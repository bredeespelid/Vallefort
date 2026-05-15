# Vallefort — Oppsettguide

## Filer
- `index.html`    → Nettsiden (GitHub Pages)
- `logo.png`      → Logo
- `worker.js`     → Cloudflare Worker (API + OAuth + meta-henter)
- `wrangler.toml` → Worker-konfigurasjon

---

## Steg 1 — GitHub Pages

1. Lag et nytt repo på GitHub, f.eks. `vallefort`
2. Last opp `index.html` og `logo.png`
3. Gå til **Settings → Pages → Source: Deploy from branch → main → / (root)**
4. Siden er live på `https://DITTBRUKERNAVN.github.io/vallefort`

---

## Steg 2 — Discord Application

1. Gå til https://discord.com/developers/applications
2. Klikk **New Application** → gi den et navn
3. Under **OAuth2 → Redirects**, legg til:
   `https://vallefort-api.DITTBRUKERNAVN.workers.dev/auth/callback`
4. Kopier **Client ID** og **Client Secret**
5. Under **Bot**, aktiver **Server Members Intent** (valgfritt, for roller)

---

## Steg 3 — Finn Discord Admin-IDs

For å finne Discord User ID:
1. Åpne Discord → Innstillinger → Avansert → Aktiver **Developer Mode**
2. Høyreklikk brukerprofilen → **Kopier bruker-ID**
3. Du trenger IDene til de to adminene

---

## Steg 4 — Cloudflare Worker

### Installer Wrangler
```bash
npm install -g wrangler
wrangler login
```

### Opprett KV-namespace
```bash
wrangler kv:namespace create VALLEFORT_KV
# Kopier ID-en du får og lim inn i wrangler.toml
```

### Rediger wrangler.toml
Lim inn KV namespace ID-en der det står `LIMER_INN_KV_NAMESPACE_ID_HER`

### Sett secrets
```bash
wrangler secret put DISCORD_CLIENT_ID
# Lim inn Client ID fra Discord Developer Portal

wrangler secret put DISCORD_CLIENT_SECRET
# Lim inn Client Secret

wrangler secret put ADMIN_DISCORD_IDS
# Lim inn: DISCORD_ID_ADMIN1,DISCORD_ID_ADMIN2
# Eksempel: 123456789012345678,987654321098765432

wrangler secret put JWT_SECRET
# Skriv inn en tilfeldig lang streng, f.eks.: vallefort-super-secret-2026

wrangler secret put SITE_ORIGIN
# Din GitHub Pages URL, f.eks.: https://dittbrukernavn.github.io
```

### Deploy
```bash
wrangler deploy
# Worker blir tilgjengelig på:
# https://vallefort-api.DITTBRUKERNAVN.workers.dev
```

---

## Steg 5 — Koble sammen

Åpne `index.html` og finn disse to linjene øverst i `<script>`-blokken:

```js
const API_URL           = 'https://vallefort-api.dittbrukernavn.workers.dev';
const DISCORD_CLIENT_ID = 'DIN_DISCORD_CLIENT_ID';
```

Bytt ut med din faktiske Worker URL og Discord Client ID.

Også i `wrangler.toml`:
```toml
DISCORD_REDIRECT_URI = "https://vallefort-api.DITTBRUKERNAVN.workers.dev/auth/callback"
SITE_ORIGIN          = "https://DITTBRUKERNAVN.github.io"
```

---

## Steg 6 — Test

1. Gå til din GitHub Pages URL
2. Klikk **Logg inn med Discord**
3. Godkjenn i Discord
4. Du sendes tilbake og ser brukernavnet ditt i navbaren
5. Hvis du er admin: klikk **⚙ Admin** → juster Set/Patch/Sesong
6. Meta lastes automatisk (med demo-data til Worker er oppe)

---

## API-endepunkter

| Endepunkt | Metode | Beskrivelse |
|---|---|---|
| `/api/meta` | GET | Henter cached tier list (1t cache) |
| `/api/meta/refresh` | GET | Tvinger ny henting (kun admin) |
| `/api/config` | GET | Henter set/patch/sesong/admins |
| `/api/config` | POST | Oppdaterer config (kun admin) |
| `/auth/callback` | GET | Discord OAuth callback |
| `/api/me` | GET | Returnerer innlogget bruker |

---

## Om live meta fra tftactics.gg

tftactics.gg er fullstendig JavaScript-rendret — dataen kan ikke hentes
direkte med en enkel HTTP-forespørsel. Workeren forsøker kjente CDN-paths
på `sunderarmor.com` (deres asset-CDN). Hvis disse ikke fungerer, vises
demo-data med en lenke til tftactics.gg.

**For garantert live data** kan du bruke Puppeteer/Playwright i en
Cloudflare Browser Rendering Worker (betalt plan) eller sette opp et
cron-job som scraper siden og lagrer resultatet i KV manuelt.

Cloudflare Free plan er nok for alt annet (OAuth, config, caching).
