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
js/admin.js                 # Admin app (memory-only token session; writes go to /api/admin/*, previews/links read the public /api/*)
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
functions/api/config/tags.js          # Cloudflare: GET /api/config/tags (visible tags with ordered members)
functions/api/admin/tags.js, functions/api/admin/tags/[slug].js  # Cloudflare: tag CRUD + membership (requireAdmin)
js/tags.config.js                 # Offline tag fallback (window.GreyboxTags, starts empty)
migrations/0001_schema.sql, migrations/0002_seed.sql, migrations/0003_tags.sql  # D1 schema + seed + tags (mirrors js/*.config.js)
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
| `tags` | Custom editorial tags (`slug`, `name`, `description`, `visible`, `badge`) |
| `tag_members` | Ordered tag membership (identity only: `media` + `tmdb_id`, never titles/posters) |
| `settings` | Single-row settings: `home_hero` (the ONE authoritative Home Hero config) and `collection_heroes` (separate per-collection scope) |

Authoritative Home Hero (`settings.home_hero` — the Admin and the public
homepage read the same row; `js/homepage.config.js` is the offline fallback):

| `mode` | Public homepage shows | Admin shows |
|---|---|---|
| `spotlight` | `heroItem` (`media` + TMDB `id`) | Configured + resolved: the same `media:id` |
| `custom` | `source` rule, item `pick` (`items[pick]`, fallback `items[0]`) | Configured rule + pick, and the resolved `media:id` (rule-based sources resolve at runtime) |
| `follow-grid` | First item of the homepage grid | "Follows the grid" + runtime note |

Identity is always `media_type` + TMDB ID — never title strings. Values
stored for an inactive mode (e.g. a `heroItem` while in `custom`) are
preserved but ignored, and the Admin labels them inactive. `artwork`
(backdrop/logo) and `trailer` (source/key/activation/delay/muted/loop)
travel with every mode. Collection heroes (`settings.collection_heroes`)
are a separate scope: a Home Hero update never touches them and vice versa.

Hero trailer presentation (`js/hero.js` + `css/hero.css`): the trailer plays
as a background video, never as a visible YouTube player. The embed
requests a chromeless player (`controls=0&fs=0`, keyboard input disabled,
modest branding, no annotations), the iframe is overscan-cropped inside the
`overflow:hidden` hero so residual YouTube edge chrome (title bar, playlist
affordances from loop mode) renders outside the visible area, clicks/focus
never reach YouTube (`pointer-events:none`, `tabindex=-1`), and a naturally
ending non-loop trailer falls back to the still instead of lingering on the
endscreen. Greybox's own controls stay independent: the circular
mute/unmute button (visible only while playing), Watch Now, More Info and
In My List. Limitation (platform-imposed): YouTube does not offer a fully
brand-free player — a watermark/"Watch on YouTube" affordance can still
exist inside the video frame; what is guaranteed is no visible playback
controls over the hero.

Custom editorial tags (`tags` + `tag_members` — Admin → Tags, offline
fallback `js/tags.config.js`):

- A tag is a Greybox-owned content group: `{ slug, name, description,
  visible, badge }` plus an ordered membership list of `media + TMDB ID`
  identities (never title text, never posters — TMDB supplies those live).
  One title can belong to many tags; each tag resolves its own list.
- This is NOT the override badge: `custom_badge` stays a single per-title
  visual label. Tag membership is the content group; the tag's `badge`
  flag only controls the extra card/detail badge, and the two can show
  together. A tag works as a content group with `badge` off.
- Visibility has one meaning: `visible: false` removes the tag from ALL
  public surfaces (shelves resolve empty/skipped, badges hidden).
  Membership is kept, so re-showing restores everything.
- Order is editorial: list position is the content order (gapless,
  deduped — re-adding a title never doubles it). Empty tags are valid
  drafts; public shelves skip them like any empty source.
- Reusable source: `{ type: 'tag', tag: 'kids-fav' }` works in Home
  sections AND Collections (same `resolveTagItems` rule both places —
  membership order, section limit applies, collection pins still lead and
  excludes still drop). Unknown/hidden tags skip the shelf instead of
  rendering a broken row. Slugs are permanent (rename = delete + create);
  deletion is blocked (409) while any section/collection references the
  tag — the API returns the real reference list.

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
npx wrangler d1 execute greybox-db --local --file=migrations/0003_tags.sql
npx wrangler pages dev .
# verify: curl /api/config/home, /api/config/collections,
#         /api/config/collections/science-fiction, /api/config/overrides, /api/config/tags
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

## 5) Management API for Greybox-owned D1 data (used by the Admin Control Panel below)

Read/write layer for the same D1 tables, behind a server-side bearer-token
boundary. The Admin Control Panel (`/admin`) calls these routes; there are
no accounts and no login flow beyond the token.

| Routes | Ops |
|---|---|
| `/api/admin/collections`, `/api/admin/collections/:slug` | list · read · create (201) · full update · delete (204) |
| `/api/admin/home-sections`, `/api/admin/home-sections/:id` | list · read · create (201) · full update · delete (204) |
| `/api/admin/overrides`, `/api/admin/overrides/:media/:id` | list · read · create (201) · replace fields · delete (204) |
| `/api/admin/tags`, `/api/admin/tags/:slug` | list (with counts) · read (members + usage) · create (201) · full update incl. members · delete (204, 409 while referenced) |
| `/api/admin/settings/home-hero` | read · replace hero setting (PUT is full-replace: send the complete hero object) |
| `/api/admin/settings/collection-heroes` | read · replace the collection-heroes map (read-modify-write so other collections are never clobbered) |

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
backend and a server read-back after every mutation (a 200 alone is never
shown as success).

Collections workspace (`/admin` → Collections): cards with live counts,
real search/visibility/source-type/media filters (all evaluated against
actual collection data — `source.type` and the media each collection
targets), public `/collection/:slug` links, per-card hero relationship
(Default = first title, Custom = configured hero) with a Configure Hero
entry point into the Heroes editor, and pin/exclude counts. The editor is
grouped (Identity / Content source / Presentation / Hero / Advanced),
adapts its fields to the selected source type (genre/year/search/discover/
custom show only their own settings; movie vs TV genre IDs stay distinct,
including the Movies + TV `movie_id`/`tv_id` pair), carries an unsaved
preview (first page only, capped at 12, pins lead, excludes applied) that
reuses the existing public Greybox APIs and never saves, and verifies saves
with a fresh GET. State is `visible`/`hidden` only (hidden collections 404
everywhere, including their public URL); ordering is the existing
`sort_order` display position (↑/↓ swaps plus an optional numeric field —
no new model); slugs are permanent (rename = delete + create); deletes also
remove that slug's hero override through the existing collection-heroes API
so no stale custom hero survives.

Tags workspace (`/admin` → Tags): cards with live title counts (movies/TV
split), real local search + visibility filter, and per-tag Edit / Manage
Titles / Show-Hide / Delete. Tag creation is top-level (+ New Tag with
name → slug suggestion; slugs permanent). Manage Titles is the central
place per tag: TMDB search with multi-select + Add N Titles (duplicate
safe), progressive title resolution (chunked, cached, stale-guarded —
rows stay usable as `media:id` before titles land), ↑/↓ reorder and
per-row Remove (membership only — never touches titles, overrides, picks
or TMDB). Real usage info (referencing Home sections/Collections) shows
in the editor and blocks deletion (409) while referenced. Home and
Collection editors gained a `tag` (Custom Tag) source type with a tag picker;
collection previews resolve tag sources through the same public rule.
Saves verify with a fresh GET; membership writes verify with read-back.

Overrides workspace (`/admin` → Overrides): cards with poster thumbnails
(rendered from override artwork with zero per-row fetches), live counts
(`N Overrides · M ★ Picks`, same predicate as the Dashboard), and real
local search plus media-type and Pick-state filters (all evaluated against
stored row data — no TMDB request per keystroke). Creation is
search-first: Search TMDB (existing server-side proxy) → Select a result
→ media + TMDB ID locks as the identity → override only needed fields.
The editor is grouped (Identity / Metadata / Artwork / Editorial) over
exactly the 11 allowlisted keys (`title, name, overview, description,
poster_path, backdrop_path, vote_average, release_date, first_air_date,
featured, custom_badge` — title/name sync as aliases and `description`
wins as the synopsis when both text keys are set, exactly as
`applyOverrides` resolves them). Each field shows Using-TMDB vs
Override-active status with a true Reset (clearing a field removes it on
save — PUT replaces all fields and empties are dropped server-side too),
plus an unsaved TMDB-vs-GREYBOX preview (text rows + same-identity
artwork thumbs + Pick state) from one stale-guarded detail fetch per
identity. A Greybox Pick is exactly `featured + custom_badge:
"Greybox Pick"` on the same row (ON/OFF switch, no second system).
Saves verify with a fresh GET (mismatch is reported, never shown as
success); deletes verify with a read-back 404; identity is permanent
(rename = delete + create, future Blocked Titles will reuse
`media + TMDB ID`). Overrides apply everywhere TMDB data renders (lists,
collections, detail pages, search, Heroes) via `applyOverrides` — Heroes
and Collections configuration itself is never touched.

Authentication is a **memory-only session**: paste the token once per tab; it
lives in a single JS variable, is sent as an `Authorization: Bearer` header,
and is never written to source, git, D1, cookies, `localStorage`,
`sessionStorage`, or the URL. Reload/Disconnect forgets it. No accounts, no
server-side sessions (deliberately — nothing to hijack or expire).

Hero consistency (Admin ↔ public homepage share one source of truth):

- Both read D1 `settings.home_hero` (Admin via
  `/api/admin/settings/home-hero`, public via `/api/config/home` +
  `getHomeConfig()` + `getHeroItem()`); there is no second hero store.
- The Heroes → Home Hero editor initializes from a fresh GET on every open
  and previews the same selection the public renderer uses (`items[pick]`
  for `ids` sources, the `heroItem` for spotlight).
- Hero cards distinguish **configured** items from the **currently resolved**
  hero (`media:id`), so the Admin never shows one movie while the public
  renderer uses another.
- Saves verify with a server read-back (a 200 alone is not trusted as
  success). The two Home Hero editors (Heroes studio + General Settings)
  edit the same row: General Settings owns mode/badge/pick/heroItem/source
  and carries the current server artwork/trailer through, so saving there
  never wipes Heroes-controlled presentation; collection heroes live under
  the separate `collection_heroes` key and are never touched by Home Hero
  saves.

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
