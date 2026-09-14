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
In My List. The bottom shade is a reduced cinematic fade covering only
approximately the bottom 20% of the hero (upper ~80% stays clear), with
enough darkness behind the title/buttons for readability. The page beneath
the hero is a dynamic poster-derived ambient background (`#page-ambient`):
the current hero artwork reused as a heavily blurred/scaled/darkened layer
plus a translucent glass gradient fading to the base color — no hardcoded
color, updates on every hero change, stays behind the trailer/text/navbar.
Limitation (platform-imposed): YouTube does not offer a fully
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

Control Center shell (`admin.html` + `css/admin.css`, same vanilla stack):
grouped icon sidebar (Control Center / Content / Experience / Appearance /
Site / System) with a refined active state (accent tint + edge indicator),
a desktop-only collapsible icon rail, and a mobile drawer under 60rem.
Roadmap entries are enabled buttons with a subtle `Soon` badge that open a
labeled Coming-soon panel — never dead/disabled rows. The sticky topbar
reads `[section] / [workspace]` (e.g. Content / Heroes); the ⌘K control is
a declared future affordance (per-workspace filters are the real search).
Live views: Dashboard, Home, Heroes, Collections, Tags, Overrides, Greybox
Picks, TMDB Search, General Settings. Auth stays a memory-only token
session; no shell change touches API contracts, D1, or workspace logic.

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
- **Player engine** (`js/stream.js` + `js/greybox-player.js`, §6.1): direct files (`.m3u8` / `.mp4` you own or license) play in the Greybox-owned HTML5 player — one `<video>` driven by native HLS where supported, otherwise HLS.js, with the Plyr control UI under a Greybox skin (`css/player.css`). The previously configured-host embed page still loads in `#embed-frame` for backward compatibility; the Greybox Player itself never uses an iframe and never loads another site's player. Loading spinner, error overlay + retry, resume-from-position (localStorage), auto-next episode, prev/next episode bar are unchanged.
- **Source slot — change ONE line** (`Stream.EMBED.base` in `js/stream.js`, marked PUT YOUR OFFICIAL API STREAMING LINK HERE): everything derives from it — `{base}/embed/movie/{tmdb_id}` and `{base}/embed/tv/{tmdb_id}/{season}/{episode}`. While it points at `example.com`, Watch buttons show "No stream source configured". Point it only at a host you own or license.
- **Free films**: `https://archive.org/metadata/{id}` → smallest MP4 → plays through the same engine with resume support.

## 6.1) Greybox Player (custom HLS player, no iframe, no third-party player)

```
Greybox
 → normalized playback source ({ title, sub, url, mode, ... } — unchanged contract)
 → Greybox Player (js/greybox-player.js)
 → HTML5 <video>
 → native HLS  OR  HLS.js
 → Plyr UI (Greybox skin, css/player.css)
```

Provider resolution stays separate from the player: `Stream.EMBED` /
`getMovieUrl` / `getEpisodeUrl` / `isConfigured` in `js/stream.js` resolve
*where* to play from (untouched — same hosts, same URL shapes, same priority);
the Greybox Player only knows *how* to play a direct file URL it is handed.
It is provider-agnostic (no host-specific logic, no branding, no ads) and
accepts the existing normalized source via a small isolated adapter
(`normalizeSource` — also passes through caller-supplied subtitle tracks
under `subtitles` / `tracks` / `captions`; nothing is invented).

- **Libraries** (pinned official CDN, no framework): Plyr 3.7.8
  (`cdn.plyr.io`, UI/controls only) + HLS.js (`cdn.jsdelivr.net`, HLS engine
  only). If the Plyr CDN is blocked the player falls back to native controls
  rather than breaking.
- **Native HLS detection**: `video.canPlayType('application/vnd.apple.mpegurl')`
  (`probably`/`maybe`, plus the legacy `application/x-mpegURL` alias). Native
  path sets `video.src` directly; otherwise HLS.js (`Hls.isSupported()` →
  `loadSource` + `attachMedia`) drives the same `<video>` Plyr wraps.
- **Controls**: play/pause, timeline/seek, current time, duration, volume,
  mute, fullscreen, playback speed (0.5–2x), PiP/airplay where supported,
  keyboard controls (scoped, not global), mobile-friendly layout, buffering
  indicator (existing `#player-loading`), clean error overlay (existing
  `#player-error`, no stack traces). Rows with no data never show (no quality
  menu for single-level streams, no caption menu without supplied tracks).
- **Quality**: offered only when the manifest exposes 2+ distinct levels
  (taken from the manifest, never assumed) — `Auto` (HLS.js ABR) plus each
  height; switching sets `hls.currentLevel` (`-1` = Auto).
- **Lifecycle**: `open()` fully destroys the previous HLS.js instance, Plyr
  instance, injected `<track>` nodes, and listeners before attaching the new
  source. Every open/destroy bumps a sequence so a stale manifest/metadata
  callback can never overwrite the current episode; rapid episode switching is
  additionally guarded in `js/stream.js` (`playerGen`). `routeGen`/`modalGen`
  routing protections are untouched. `Stream.Player.open/close/current/retry`
  keep their exact contract, so all existing callers (`app.js` movie/episode/
  custom-file, hero Watch) work unchanged.
- **Errors** (clean Greybox copy, URLs redacted in logs): unsupported source,
  HLS engine unavailable, manifest load failure, network failure, media error.
- **Dev-only test**: `js/greybox-test-source.js` holds one replaceable
  legitimate public test manifest (Mux HLS test stream, published for player
  testing — no scraping, no auth/DRM/referer bypass). Open the site with
  `?play-test=1` to play it through the normal `Stream.Player.open` file
  contract. To remove: delete that file + its one `<script>` tag in
  `index.html`.
- **Automated checks**: `node tests/greybox-player.test.cjs` (73 assertions:
  adapter units, native/HLS.js/Plyr wiring, quality/subtitle rules, lifecycle
  + stale safety, `Player.open()` compatibility, provider-resolution and
  routing untouched, no iframe/provider logic/secrets in the player) plus
  `node tests/source-routing.test.cjs` (51 assertions, Increment 2 — see
  §6.2).
  Browser-only items (real play/pause, seek, volume, fullscreen, speed, PiP,
  mobile controls) need one manual pass with `?play-test=1`.
- **Limitation**: native-HLS browsers (Safari) use platform-managed quality
  (no custom quality menu there); the legacy configured-host embed page is
  retained for compatibility and is NOT part of the Greybox Player.

## 6.2) Source routing (direct → Greybox Player, embed → legacy iframe)

```
Provider resolver (js/stream.js EMBED — unchanged hosts/URLs/priority)
    ↓  normalized source ({ title, sub, url, mode, ... } + optional sourceType)
Stream.resolveSourceType()
    ↓                               ↓
direct HLS / direct file      embed page URL
    ↓                               ↓
GreyboxPlayer.open()          legacy compatibility iframe (#embed-frame)
(HLS.js / native HLS + Plyr)  (Greybox Player never touches it)
```

- **Precedence** (`resolveSourceType`, pure and unit-tested): (1) an
  explicit provider-supplied type wins — never guess when the provider is
  explicit; (2) explicit `mode: 'embed'` stays on the legacy path whatever
  the URL looks like (all current movie/episode/hero callers); (3) otherwise
  (file/direct mode) `.m3u8` sniffs to HLS and everything else stays in the
  file bucket, where the player decides playability (clean `unsupported`
  error for non-media URLs — Increment 1 behavior, preserved).
- **Additive field** (backward compatible — every existing caller works
  without it): `sourceType` (or `contentType`/`mime`). Accepted values:
  `hls` / `m3u8` / HLS MIME → direct HLS; `file` / `video` / `video/*` /
  media extensions → direct file; `embed` / `iframe` / `page` → legacy
  iframe. No second schema: `url`, `mode`, `title`, `sub`, `progressKey`,
  `onEnded`, `showPrevNext`, subtitle keys all keep their meaning.
- **Where today's sources go**: the configured EMBED resolver supplies
  embed-page URLs only (no legitimate direct media URL is provided), so
  movie/episode/hero playback remains on the legacy path; user-pasted direct
  URLs (`playFile`), the dev test manifest (`?play-test=1`), and any future
  provider that legitimately returns a direct URL route to the Greybox
  Player. Nothing converts an embed URL into a media URL — no scraping, no
  auth/DRM/referer/hotlink bypass of any kind.
- **Player UI** is unchanged from Increment 1; only routing was connected.
  Cleanup and stale-request protection are unchanged (`GreyboxPlayer`
  teardown + `playerGen` + untouched `routeGen`/`modalGen`).
- **Automated checks**: `node tests/source-routing.test.cjs` (51
  assertions: same-provider resolution, HLS/file recognition, player
  handoff, legacy embed path, no-iframe-for-direct, no provider logic in
  the player, movie/TV/Anime/fallback-order unchanged, cleanup, guards,
  Increment 1 suite green, parse regression).
- **Manual browser pass** (with `?play-test=1` or a legitimately supplied
  direct URL): DevTools Network should show the `.m3u8` request + media
  segments with no provider iframe created for direct sources; Console
  should show no Plyr, HLS.js, or duplicate-initialization errors.

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
