# Greybox — legal streaming-style site (Cloudflare Pages or Vercel)

A Netflix-style frontend where the "backend" is **other providers' legal APIs**:

| Need | Provider | How |
|---|---|---|
| Movie/TV metadata, posters, trending, search, cast, trailers list | **TMDB API** (free) | via `/api/tmdb/*` serverless proxy (key stays secret) |
| Trailers | **YouTube embeds** (from TMDB `/videos`) | iframe, no hosting |
| Where-to-watch legally (Netflix, Prime, Hotstar...) | **TMDB watch/providers + JustWatch link** | external deep links |
| Full-film playback demo (actually playable) | **Internet Archive public-domain films** | direct MP4 |
| Your own films | **Cloudflare Stream / R2 / S3 HLS/MP4** | paste URL in details → plays with hls.js |

> **Why not MovieBox API?** MovieBox / FlixHQ / VidSrc-style APIs serve pirated streams. Hosting or embedding those on Cloudflare Pages violates copyright law and Cloudflare's ToS (account + domain takedown risk). This project deliberately does **not** integrate them. You get the same UI/UX, but every play button is legal.

## Project structure

```
index.html                  # SPA: home, movies, tv, free films, my list, search, details, player
admin.html                  # Admin Control Panel (/admin): sections, collections, overrides, hero — vanilla JS
js/admin.js                 # Admin app (memory-only token session, talks only to /api/admin/*)
css/style.css
js/api.js                   # Greybox API client (NO secret in client code — calls /api/*)
js/app.js                   # UI
functions/lib/greybox.js     # shared Greybox shaping logic (single source of truth, no secrets;
                           # kept INSIDE functions/ — Cloudflare Pages only bundles in-functions imports)
functions/api/trending.js       # Cloudflare: GET /api/trending
functions/api/search.js         # Cloudflare: GET /api/search?q=
functions/api/movies/[category].js  # Cloudflare: GET /api/movies/:category
functions/api/movie/[id].js         # Cloudflare: GET /api/movie/:id (detail bundle)
functions/api/anime/[kind].js       # Cloudflare: GET /api/anime/:kind
functions/api/tv/[[rest]].js        # Cloudflare: GET /api/tv/:category | :id | :id/season/:n
functions/lib/db.js               # Cloudflare: D1 access layer (ONLY file with raw SQL)
functions/api/config/home.js          # Cloudflare: GET /api/config/home (D1 homepage structure)
functions/api/config/collections.js   # Cloudflare: GET /api/config/collections (D1, display order)
functions/api/config/collections/[slug].js  # Cloudflare: GET /api/config/collections/:slug (404 if hidden/unknown)
functions/api/config/overrides.js     # Cloudflare: GET /api/config/overrides (override fields only)
migrations/0001_schema.sql, migrations/0002_seed.sql  # D1 schema + seed (mirrors js/*.config.js)
wrangler.toml                     # Pages + D1 binding (DB); secrets stay in .dev.vars / dashboard
api/trending.js, api/search.js, api/movies/[category].js, api/movie/[id].js, api/anime/[kind].js, api/tv/[...rest].js
                        # Vercel equivalents of the same Greybox contract
functions/api/tmdb/[[path]].js  # Cloudflare Pages Function — legacy raw TMDB proxy (kept for static-preview fallback)
api/tmdb/[...path].js           # Vercel Serverless Function — same legacy /api/tmdb/* contract
public/_headers
package.json (wrangler)
```

Greybox API contract (backend calls TMDB internally, returns only needed fields):

```
GET /api/trending?page=1
GET /api/movies/popular|top-rated|upcoming|now-playing?page=1
GET /api/tv/popular|top-rated|on-the-air|airing-today?page=1
GET /api/anime/series|movies?page=1
GET /api/movie/:id?region=US            # detail + cast + trailer_key + providers
GET /api/tv/:id?region=US               # detail + cast + trailer_key + providers + seasons
GET /api/tv/:id/season/:n               # episodes
GET /api/search?q=...&page=1
```

No build step — deploy the folder as-is.

## 1) Get a free TMDB key (2 min)

1. Sign up at https://www.themoviedb.org → Settings → API → create app → copy **Read Access Token (v4, starts with `eyJ...`)**.
2. **Never paste it into `js/`, `index.html`, or any committed file.** The key lives only in:
   - hosting env vars: `TMDB_READ_TOKEN` on Cloudflare Pages **or** Vercel (production — secret, not in git), and
   - local env files (gitignored): `.dev.vars` for `wrangler pages dev`, or `.env` for `vercel dev` (copy from `.env.example`).
3. Verify it's hidden: `git grep -i eyJ` should return nothing (and `git check-ignore .env .dev.vars` should list both).

## 2) Run locally

Option A — full Pages Functions emulation (recommended, secret stays server-side):
```powershell
# from this folder
Copy-Item .dev.vars.example .dev.vars   # then edit .dev.vars, paste real token
npm install
npm run dev
# open the URL wrangler prints
```

Option B — plain static (no backend; uses per-browser dev override only):
```powershell
python -m http.server 8080
# open http://localhost:8080 → ⚙️ Settings → paste token → Save (browser only, never committed)
```

## 3) Deploy

### Cloudflare Pages

1. Push this folder to GitHub.
2. Cloudflare Dashboard → **Workers & Pages → Create → Pages → Connect to Git** → select repo.
3. Build settings: **Framework preset: None**, Build command: *(empty)*, Output directory: `/` (root).
4. Environment variables (both Production + Preview):
   - `TMDB_READ_TOKEN` = your v4 token *(preferred)* — or `TMDB_API_KEY` = v3 key.
5. Deploy. Your site calls same-origin `/api/tmdb/...` (via `functions/api/tmdb/[[path]].js`), so no CORS or key leak.

Custom domain: Pages → Custom domains → add. HTTPS automatic.

### Vercel (alternative)

1. Push this folder to GitHub.
2. Vercel Dashboard → **Add New → Project → Import** → select repo. Framework preset: **Other**, Output directory: `./` (root). No build command.
3. **Settings → Environment Variables** (Production + Preview + Development):
   - `TMDB_READ_TOKEN` = your v4 token *(preferred)* — or `TMDB_API_KEY` = v3 key.
4. Deploy. The same-origin `/api/tmdb/...` route is served by `api/tmdb/[...path].js` — the key is read from `process.env` server-side and never appears in client code or API responses.

Local Vercel dev: `Copy-Item .env.example .env` (paste real token) → `vercel dev`.

> Only enable **one** platform's serverless proxy per deployment. If you deploy to Vercel, the `functions/` folder ships as inert static files (it contains no secrets); if you deploy to Cloudflare Pages, the `api/` folder ships as inert static files.

## 4) Greybox-owned config in D1 (homepage, collections, overrides)

TMDB stays the live source for all movie/TV metadata. D1 stores **only**
data that belongs to Greybox itself — never the TMDB catalog, never posters
in bulk, never API secrets:

| Table | Holds |
|---|---|
| `home_sections` | Homepage shelf order, titles, visibility, limits, rule sources |
| `collections` | Collection rules, ordering, pins/excludes, visibility |
| `overrides` | Explicit per-title field overrides (`media`, `tmdb_id`, override fields only) |
| `settings` | Single-row settings, currently `home_hero` |

Flow: browser → `GET /api/config/*` (Cloudflare Pages Functions, same-origin)
→ D1 read via `functions/lib/db.js` (the only file with raw SQL) → frontend
`js/data.js` preloads once at boot, then all existing getters, merge logic
(`applyOverrides`), and renderers work unchanged. If D1 is unreachable
(static preview, Vercel, binding missing), the local `js/*.config.js` files
take over automatically — they remain in the repo as the offline fallback.

Local D1 development (secret stays server-side via `.dev.vars`):

```powershell
npx wrangler d1 create greybox          # once: paste the id into wrangler.toml
npx wrangler d1 execute greybox-db --local --file=migrations/0001_schema.sql
npx wrangler d1 execute greybox-db --local --file=migrations/0002_seed.sql
npx wrangler pages dev .
# verify: curl /api/config/home, /api/config/collections,
#         /api/config/collections/science-fiction, /api/config/overrides
# edit check: wrangler d1 execute greybox-db --local --command="UPDATE home_sections SET title='X' WHERE id='popular-movies'"
#             → hard-refresh shows the new title (config cache is ~60s)
```

Production (Cloudflare dashboard):

1. **Workers & Pages → D1 → Create** a database named `greybox`.
2. Apply migrations remotely (or via `wrangler d1 execute greybox --remote --file=...` after `wrangler login`).
3. Pages project → **Settings → Functions → D1 database bindings** → add binding name `DB` pointing at the `greybox` database (Production + Preview).
4. Set `TMDB_READ_TOKEN` env var as before, redeploy.
5. Verify `/api/config/home` returns the seeded homepage, then change a title in D1 and hard-refresh within ~a minute.

> Vercel has no D1: the `api/` equivalents are untouched and `/api/config/*`
> 404s there, so Vercel deploys keep working off the local config files.

## 5) Management API for Greybox-owned D1 data (no admin UI yet)

Read/write layer for the same D1 tables, behind a server-side bearer-token
boundary. There is deliberately **no admin dashboard, no accounts, no login
flow** in this step — just the protected routes a future admin UI will call:

| Routes | Ops |
|---|---|
| `/api/admin/collections`, `/api/admin/collections/:slug` | list · read · create (201) · full update · delete (204) |
| `/api/admin/home-sections`, `/api/admin/home-sections/:id` | list · read · create (201) · full update · delete (204) |
| `/api/admin/overrides`, `/api/admin/overrides/:media/:id` | list · read · create (201) · replace fields · delete (204) |
| `/api/admin/settings/home-hero` | read · replace hero setting |

Security model:

- Every `/api/admin/*` route (reads included) calls `requireAdmin()` in
  `functions/lib/admin.js` **before** touching D1. Missing credentials or an
  unconfigured server → `401`; wrong token → `403`. Fail-closed by design.
- The credential is the `GREYBOX_ADMIN_TOKEN` Pages secret (local: uncomment
  it in `.dev.vars`; it never appears in frontend JS, responses, or git).
- All bodies are validated by `functions/lib/validate.js` (slugs, media,
  TMDB ids, string lengths, sort/limit ranges, source-rule shapes mirroring
  `js/data.js`, override-field allowlist) → `400` on bad input.
- All SQL is parameterized inside `functions/lib/db.js` — route handlers
  contain no raw SQL. Errors never leak stacks, SQL, or secrets (`500
  { error: 'Internal error.' }`).
- The public site is untouched: `/api/config/*` stays public read-only and
  the frontend keeps reading D1 exactly as in Step 8.

Local trial (uses a scratch slug/override, then deletes it):

```powershell
# in .dev.vars, uncomment GREYBOX_ADMIN_TOKEN with a random local value
$H = @{ Authorization = 'Bearer <your-local-token>' }
Invoke-RestMethod http://127.0.0.1:8788/api/admin/collections -Headers $H
```

Production: add the `GREYBOX_ADMIN_TOKEN` **secret** (Pages → Settings →
Environment variables, Production + Preview, "Encrypt"), redeploy. Until
then, all `/api/admin/*` calls safely return `401`.

### Admin Control Panel (`/admin`, no build step)

`admin.html` + `js/admin.js` (vanilla JS, isolated from the public SPA) manage
homepage sections, collections, metadata overrides, and the hero setting
through the management API above — full CRUD plus reorder, visibility
toggles, and delete confirmations, with per-field validation mirroring the
backend and a refresh-from-API after every mutation.

Authentication is a **memory-only session**: paste the token once per tab; it
lives in a single JS variable, is sent as an `Authorization: Bearer` header,
and is never written to source, git, D1, cookies, `localStorage`,
`sessionStorage`, or the URL. Reload/Disconnect forgets it. No accounts, no
server-side sessions (deliberately — nothing to hijack or expire).

## 6) How playback works (full logic, source slot left blank).

- **Browse/search**: `GET /api/trending`, `/api/movies/popular`, `/api/tv/popular`, `/api/search?q=...` — see `js/app.js:load()`. The Greybox backend (`functions/lib/greybox.js` + `functions/api/*`) calls TMDB internally and returns only the fields the UI needs.
- **Details**: `GET /api/movie/{id}?region=US` or `/api/tv/{id}?region=US` — one bundle with detail + cast + `trailer_key` (YouTube) + region-filtered `providers` (+ `seasons` for TV). Episodes via `GET /api/tv/{id}/season/{n}` with stills.
- **Player engine** (`js/stream.js`): embed pages in `<iframe>`, direct files in `<video>` (HLS via hls.js with native fallback), loading spinner, error overlay + retry, resume-from-position (localStorage), auto-next episode, prev/next episode bar.
- **Source slot — change ONE line** (`Stream.EMBED.base` in `js/stream.js`, marked PUT YOUR OFFICIAL API STREAMING LINK HERE): everything derives from it — `{base}/embed/movie/{tmdb_id}` and `{base}/embed/tv/{tmdb_id}/{season}/{episode}`. While it points at `example.com`, Watch buttons show "No stream source configured". Point it only at a host you own or license.
- **Free films**: `https://archive.org/metadata/{id}` → smallest MP4 → plays through the same engine with resume support.

## 7) Going further (all legal, all Pages-compatible)

- Add Cloudflare **D1 + Pages Functions** `/api/mylist` for cross-device watchlists (currently localStorage).
- Add **Cloudflare Stream** for your uploads; add **Access** if you want logins/paywall.
- Add genre/discover filters via `/discover/movie?with_genres=28`.
- Never add VidSrc/MovieBox/Consumet-scraped endpoints — same UI, but piracy liability.

## License / attribution

- Posters/metadata: TMDB Terms — attribute "This product uses the TMDB API but is not endorsed by TMDB".
- Films in Free section: public domain via Internet Archive; check each item's license.
- All the content shown in this website is neither hosted nor related to this site. we do not responsible for any content here. we just provide a pathway to that, we don't own any resposiblities
- The whole project is semi open-source, available for stream, but commertial use are strictly forbidden
