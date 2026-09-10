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

## 4) How playback works (full logic, source slot left blank)

- **Browse/search**: `GET /api/trending`, `/api/movies/popular`, `/api/tv/popular`, `/api/search?q=...` — see `js/app.js:load()`. The Greybox backend (`functions/lib/greybox.js` + `functions/api/*`) calls TMDB internally and returns only the fields the UI needs.
- **Details**: `GET /api/movie/{id}?region=US` or `/api/tv/{id}?region=US` — one bundle with detail + cast + `trailer_key` (YouTube) + region-filtered `providers` (+ `seasons` for TV). Episodes via `GET /api/tv/{id}/season/{n}` with stills.
- **Player engine** (`js/stream.js`): embed pages in `<iframe>`, direct files in `<video>` (HLS via hls.js with native fallback), loading spinner, error overlay + retry, resume-from-position (localStorage), auto-next episode, prev/next episode bar.
- **Source slot — change ONE line** (`Stream.EMBED.base` in `js/stream.js`, marked PUT YOUR OFFICIAL API STREAMING LINK HERE): everything derives from it — `{base}/embed/movie/{tmdb_id}` and `{base}/embed/tv/{tmdb_id}/{season}/{episode}`. While it points at `example.com`, Watch buttons show "No stream source configured". Point it only at a host you own or license.
- **Free films**: `https://archive.org/metadata/{id}` → smallest MP4 → plays through the same engine with resume support.

## 5) Going further (all legal, all Pages-compatible)

- Add Cloudflare **D1 + Pages Functions** `/api/mylist` for cross-device watchlists (currently localStorage).
- Add **Cloudflare Stream** for your uploads; add **Access** if you want logins/paywall.
- Add genre/discover filters via `/discover/movie?with_genres=28`.
- Never add VidSrc/MovieBox/Consumet-scraped endpoints — same UI, but piracy liability.

## License / attribution

- Posters/metadata: TMDB Terms — attribute "This product uses the TMDB API but is not endorsed by TMDB".
- Films in Free section: public domain via Internet Archive; check each item's license.
- All the content shown in this website is neither hosted nor related to this site. we do not responsible for any content here. we just provide a pathway to that, we don't own any resposiblities
- The whole project is semi open-source, available for stream, but commertial use are strictly forbidden
