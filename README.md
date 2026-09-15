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
js/blocked.config.js              # Offline blocklist fallback (window.GreyboxBlocked, starts empty)
migrations/0001_schema.sql, migrations/0002_seed.sql, migrations/0003_tags.sql, migrations/0004_blocked.sql, migrations/0005_navigation.sql, migrations/0006_detail_pages.sql, migrations/0007_playback.sql  # D1 schema + seed + tags + blocklist + navigation + detail pages + playback (mirrors js/*.config.js)
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
| `blocked_titles` | Permanent blocklist (`media`, `tmdb_id`, display snapshots, timestamps) — identity is always `media` + TMDB ID, enforced by PRIMARY KEY |
| `settings` | Single-row settings: `home_hero` (the ONE authoritative Home Hero config), `collection_heroes` (separate per-collection scope), `navigation` (the public navbar: ordered items + header-search flag), `detail_pages` (movie/TV detail visibility flags: header/actions/content/tv), and `playback` (catalog resolver strategy: `auto`/`direct`/`embed`) |

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

Hero title artwork (`js/hero.js` + `css/hero.css`): the big hero title is
 the title's official TMDB logo artwork whenever a usable one exists, and
 the normal text title otherwise — never both at once. Selection is from
 TMDB's `/images` logos (English preferred, then language-neutral, then
 other languages; highest community-rated wins), fetched once per
 `media_type + TMDB ID` through the existing `/api/tmdb/*` proxy (which
 forwards `include_image_language`) and cached for the page lifetime; logo
 data already carried by the hero item is reused instead of refetched. The
 artwork keeps its aspect ratio inside desktop/mobile max caps (never
 stretched, cropped, or boxed) with a cinematic drop shadow, and every hero
 change/loading/error state clears the previous logo first so stale artwork
 can never linger. Admin Heroes → Title/logo can force `Text title` or a
 `Custom logo URL` instead of the automatic TMDB logo.

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
npx wrangler d1 execute greybox-db --local --file=migrations/0004_blocked.sql
npx wrangler d1 execute greybox-db --local --file=migrations/0005_navigation.sql
npx wrangler d1 execute greybox-db --local --file=migrations/0006_detail_pages.sql
npx wrangler d1 execute greybox-db --local --file=migrations/0007_playback.sql
npx wrangler pages dev .
# verify: curl /api/config/home, /api/config/collections,
#         /api/config/collections/science-fiction, /api/config/overrides, /api/config/tags, /api/config/blocked, /api/config/navigation, /api/config/detail-pages, /api/config/playback
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
| `/api/admin/blocked`, `/api/admin/blocked/:media/:id` | list blocked titles · block (201, 409 when already blocked) · read one · unblock (204, 404 when not blocked) |
| `/api/admin/navigation` | read the full navigation config (GET) · replace it (PUT is full-replace: send all six items in display order + `searchVisible`) |
| `/api/config/navigation` | public navigation config (all items with visible flags, display order, controlled routes + `searchVisible`, short cache) — the browser filters by `visible` |
| `/api/admin/settings/detail-pages` | read the detail presentation config (GET) · replace it (PUT is full-replace: send all four groups with every boolean flag) |
| `/api/config/detail-pages` | public detail visibility flags (header/actions/content/tv, short cache) — the detail modal hides what is flagged off |
| `/api/admin/settings/playback` | read the playback resolver config (GET) · replace it (PUT is full-replace: send `{ mode }` with `auto`/`direct`/`embed`) |
| `/api/config/playback` | public playback mode (`{ mode }`, short cache) — the catalog resolver reads it via `getPlaybackConfig()`; unreachable config falls back to `auto` |
| `/api/config/blocked` | public identity-only blocklist (`[{ media, id }]`, short cache) — the browser filters through `isBlockedContent()` |
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
Live views: Dashboard, Home, Heroes, Collections, Tags, Overrides, Blocked
Titles, Navigation, Detail Pages, Playback, Greybox Picks, TMDB Search, General Settings. Auth stays a memory-only token
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
(rename = delete + create, same `media + TMDB ID` identity the Blocked
Titles workspace uses for its blocklist). Overrides apply everywhere TMDB data renders (lists,
collections, detail pages, search, Heroes) via `applyOverrides` — Heroes
and Collections configuration itself is never touched.

Blocked Titles workspace (`/admin` → Blocked Titles): permanent
server-side blocklist over D1 `blocked_titles` (migration
`0004_blocked.sql`; starts empty). Authoritative identity is always
`media_type` + TMDB ID — never title text (titles change, and `movie:123`
vs `tv:123` are different identities that never cross-block; the
`(media, tmdb_id)` PRIMARY KEY plus a server-side 409 makes duplicates
impossible). Stored rows carry display snapshots only (title, poster /
backdrop paths, year, timestamps) for the workspace cards — zero per-row
TMDB fetches. Workflow is search-first: + Block Title → TMDB search
(existing server-side proxy, stale-guarded) → select → confirmation
(poster, title, year, media, TMDB ID) → Block Title (201 + read-back
verification). The picker carries a media-type selector ([ All ] [
Movies ] [ TV Shows ]) that scopes the real TMDB request (Movies →
`/search/movie`, TV Shows → `/search/tv`, All → `/search/multi`) plus a
search-mode selector ([ Title ] [ TMDB ID ]): Title searches by name,
while TMDB ID resolves the numeric ID against the real detail endpoints
(Movies verifies `/movie/{id}`, TV Shows verifies `/tv/{id}`, All
verifies both and shows whichever identities exist — so a bare ID like
`95897` is never mis-searched as title text and never assigned the wrong
media type). Already-blocked results show BLOCKED + Unblock instead of a
duplicate action. Unblock uses the shared confirmation dialog, DELETEs the
D1 row, verifies a read-back 404, and re-renders without a reload.
Troubleshooting: `Blocked titles table is missing … Apply
migrations/0004_blocked.sql` (HTTP 503 on list, block, or unblock) means the
D1 `blocked_titles` table is missing — the backend is correct, the
migration was never applied. Apply `migrations/0004_blocked.sql` (local:
`npx wrangler d1 execute greybox-db --local --file=migrations/0004_blocked.sql`;
production: the same command with `--remote`, then rebind `DB` and
redeploy) and the list loads with no code change. The public
`GET /api/config/blocked` stays on an empty blocklist while the table is
missing so discovery keeps working; Admin writes report the actionable 503
instead of a generic `Internal error` (the real D1 `no such table:
blocked_titles` error is logged server-side only).
Public filtering is central, not scattered: the browser loads the
identity-only `GET /api/config/blocked` once at boot and every
TMDB-derived surface filters through the `isBlockedContent()` seam in
`js/data.js` (lists via `withImages`, search + suggestions, discover /
genre, hand-picked id lists including pins/custom/tag memberships).
Blocked detail URLs (`/movie/:id`, `/tv/:id`) refuse normal rendering and
show the existing "Not available" state with generic copy (no blocklist
internals leak). Admin TMDB search still finds blocked titles and marks
them BLOCKED. Greybox Picks on a blocked title never render because the
underlying title never resolves. Limitations: enforcement lives in the
Greybox frontend pipeline (direct `/api/movie/:id` calls still answer —
like overrides/tags, which are also client-rendered); My List (explicit
user saves in localStorage) is not filtered; block edits surface within
~60s (public config cache). Automated checks:
`node tests/blocked.test.cjs` (81 assertions: identity, duplicates,
validation, auth gating, public filtering, detail blocking, admin UX,
no-leak/no-regression guards, plus both older suites green).

Navigation workspace (`/admin` → Navigation): the public Greybox navbar
(Home, Movies, TV Shows, Anime, Collections, My List + the header search
box) as server-side configuration over the D1 `settings` row `navigation`
(migration `0005_navigation.sql`; seeded to reproduce the current navbar
exactly, offline fallback `js/navigation.config.js`).

- Model: a fixed six-item menu with stable keys (`home, movies, tv,
  anime, collections, my-list`) — identity is always the key, never the
  display label. Array order IS the display order. Each item is
  `{ key, label, visible }`; header search visibility is a separate
  clearly named `searchVisible` flag outside the item list. Routes are
  NOT stored: each key maps to its existing controlled route (`/` ,
  `/movies`, `/tv`, `/anime`, the existing collections dropdown menu,
  `/mylist`) — a label edit can never break routing and no arbitrary URL
  is ever accepted (PUT validates keys, labels 1–32 chars, booleans,
  exact-six/no-duplicates/no-omission → `400` on bad input).
- Visibility hides the navbar entry only: the item stays server-side, so
  re-showing restores it. My List storage/counts and search
  suggestions/`/search` behavior are untouched — only their navbar
  entries hide.
- Admin workflow is staged: label inputs, Show/Hide toggles, ↑/↓ reorder
  and the search flag edit a local draft (Unsaved-changes badge +
  Save/Discard, Reset-to-defaults, Refresh); Save Changes PUTs the
  complete menu and verifies with a fresh GET. A draft preview shows the
  navbar order/visibility/labels (display only). Loads and saves are
  stale-guarded; failures show loading/error/retry/empty states through
  the existing toast/notice primitives.
- Public rendering: the browser preloads `GET /api/config/navigation`
  once at boot (`js/data.js`, same batch as the other config) and
  `js/navigation.js` moves/relables/hides the existing navbar nodes
  (listeners survive — nothing is rebuilt; `data-nav` wiring is never
  rewritten). If the config cannot be loaded, the static navbar stays
  exactly as-is. Public cache is `max-age=60`, so edits surface within
  ~a minute like every other config surface.
- Automated checks: `node tests/navigation.test.cjs` (87 assertions:
  defaults, visibility, labels, ordering, key stability, invalid
  key/label/order rejection, auth gating, public shape, fallback,
  save-to-navbar flow, hidden/reordered/relabeled rendering, My List and
  Search preservation, workspace UX, no-duplicate/no-leak guards, plus
  all three older suites green).

Detail Pages workspace (`/admin` → Detail Pages): site-wide visibility
flags for the public movie/TV detail modal over the D1 `settings` row
`detail_pages` (migration `0006_detail_pages.sql`; seeded all-shown to
reproduce the current detail page exactly, offline fallback
`js/detail-pages.config.js`).

- Model: four groups with stable `group.key` identity (never display
  labels), every flag a plain boolean defaulting to shown — `header`
  (backdrop, poster, badge, title, meta, rating, genres, overview),
  `actions` (watch, trailer, myList), `content` (providers, cast), `tv`
  (episodes, episodeOverview, episodeMeta). Only elements that actually
  exist in `renderTitleDetail` are exposed: there is no recommendations /
  original-title / logo setting because the detail page renders none of
  those. TV-only flags safely no-op for movies (movies never reach the
  season/episode renderers). PUT validates the complete grouped object
  (unknown groups/keys, missing keys, non-booleans → `400`).
- Public rendering: the browser preloads `GET /api/config/detail-pages`
  once at boot (`js/data.js`, same batch as the other config) and the new
  `js/detail-pages.js` wraps the four existing `GreyboxPages` entry
  points in place — `renderTitleDetail` (post-apply hide + meta-segment
  filtering), `renderSeasons`/`renderEpisodes` (section stays hidden when
  off; episode preferences folded into a copy, resume state and playback
  callbacks untouched), `renderPerson` (person pages always render full).
  No second renderer, no caller changes: `js/app.js`, `js/pages.js`,
  `js/components.js`, the router, playback, and TMDB queries are
  untouched. If the config cannot load, every flag reads as shown and the
  current detail page renders unchanged. Public cache is `max-age=60`.
- Blocked Titles always win: blocking is enforced in `js/data.js`
  `getMovie`/`getTVDetails` before any rendering, so the presentation
  layer only ever sees resolved, allowed titles — no flag here can
  render blocked content. The error state is never wrapped and always
  renders full.
- Admin workflow is staged like Navigation: grouped Show/Hide toggles
  edit a local draft (Unsaved-changes badge + Save/Discard,
  confirm-guarded Reset-to-defaults, Refresh); Save Changes PUTs the
  complete object and verifies with a fresh GET. Loads and saves are
  stale-guarded; failures show loading/error/retry states through the
  existing toast/notice/stateBox primitives. No live preview: a preview
  would duplicate the detail renderer, so the toggle list is the source
  of truth.
- Automated checks: `node tests/detail-pages.test.cjs` (80 assertions:
  defaults, GET/PUT, auth gating, invalid rejection, public shape,
  fallback, movie/TV/episode/cast/action integration, no invented
  recommendations, blocked-still-rejected, unblocked-unaffected,
  reset/defaults, stale protection, workspace UX, no-duplicate/no-leak
  guards, plus all four older suites green).

Playback workspace (`/admin` → Playback): catalog resolver strategy over
the D1 `settings` row `playback` (migration `0007_playback.sql`; seeded
`{"mode":"auto"}` to reproduce the historical behavior exactly, offline
fallback `js/playback.config.js`).

- Model: exactly ONE setting with stable mode-key identity (never display
  labels) — `mode: auto | direct | embed`. PUT validates the complete
  object (unknown modes, missing mode, unexpected keys, invalid types →
  `400`). No provider URLs, tokens, or secrets are accepted or stored.
- Modes (implemented in `js/stream.js` `resolvePlayback`, read via
  `js/data.js` `getPlaybackConfig()`): `auto` = normal Greybox resolver
  strategy (catalog titles use the configured embed source; direct files
  use the Greybox Player); `direct` = catalog titles require a valid
  direct source and fail cleanly when none exists; `embed` = catalog
  titles use the configured embed source. Direct-file intents
  (user-pasted URLs, `?play-test=1`) always route to the Greybox Player
  regardless of mode. No mode ever converts an embed URL into a media URL.
- Direct-source availability: the EMBED resolver supplies embed-page URLs
  only, so today there is NO direct production source for normal
  movies/episodes. Direct mode is configured/validated but fails cleanly
  with "no direct production source" instead of iframing. The Admin Source
  Status panel states this honestly (mode, embed configured + hostname,
  direct Not configured, test available) without exposing tokens, cookies,
  headers, or full URLs. No scraping or extraction is added to manufacture
  a direct source.
- Player behaviors preserved (documented, not toggled in V1): autoplay is
  attempted for direct files but browsers may block audible autoplay;
  resume continues from localStorage progress keys; quality is Auto with
  manual heights only when the manifest exposes 2+ levels (Safari native
  HLS is platform-managed); captions appear only when the caller supplies
  tracks (catalog supplies none); cleanup destroys the previous HLS/Plyr
  instance and stale requests can never overwrite the current source.
- Public rendering: the browser preloads `GET /api/config/playback` once
  at boot (`js/data.js`, same batch as the other config) and catalog Watch
  paths (`playMovie`/`playEpisode`/hero Watch) resolve through
  `resolveCatalogMovie`/`resolveCatalogEpisode`. If the config cannot load,
  mode reads as `auto` and playback works as before. Public cache is
  `max-age=60`.
- Order stays: blocked filtering → detail presentation → playback. This
  workspace can never render blocked titles or override Detail Pages
  visibility. Hero trailers (YouTube background video, 7-second activation)
  are unaffected; only the hero Watch action follows the mode.
- Admin workflow is staged like Navigation/Detail Pages: mode cards edit a
  local draft (Unsaved-changes badge + Save/Discard, confirm-guarded
  Reset-to-defaults, Refresh); Save Changes PUTs `{ mode }` and verifies
  with a fresh GET. Loads and saves are stale-guarded; failures show
  loading/error/retry states through the existing toast/notice/stateBox
  primitives. A clearly marked Playback Test action opens `/?play-test=1`
  (existing safe Mux HLS test manifest — never a production source).
- Automated checks: `node tests/playback.test.cjs` (102 assertions:
  defaults, modes, invalid rejection, Admin GET/PUT, auth gating, public
  shape/fallback, resolver receives mode, direct clean failure, embed
  functional, auto preserved, player/test-source intact, no secret
  leakage, no extraction, Blocked/Detail/Hero interactions, workspace UX,
  no-duplicate/no-regression guards).

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

## 6.3) Playback mode (Admin-configured resolver strategy)

```
Admin Playback workspace (/admin → Playback)
  → D1 settings.playback { mode } (/api/admin/settings/playback)
  → public /api/config/playback (+ js/playback.config.js fallback)
  → js/data.js getPlaybackConfig()
  → js/stream.js resolvePlayback() / resolveCatalogMovie() / resolveCatalogEpisode()
  → GreyboxPlayer (direct files) or legacy iframe (embed pages)
```

- **Modes**: `auto` (default, historical behavior), `direct` (catalog
  requires a valid direct source — fails cleanly when none exists),
  `embed` (catalog uses the configured embed source). Strict enum,
  case-insensitive on read, `400` on unknown via Admin PUT.
- **Current availability**: embed configured (see `EMBED.base`);
  direct Not configured for normal movies/episodes; test available via
  `?play-test=1` (Mux HLS manifest, dev only). The Admin Source Status
  panel states exactly this with hostname-only diagnostics.
- **Preserved**: HLS quality rules (2+ heights → Auto + heights, Safari
  native-managed), Plyr controls, resume (localStorage), cleanup + stale
  guards (`playerGen`/`routeGen`/`modalGen`), hero 7-second trailer
  activation and visuals, Blocked → Detail → Playback order.
- **Automated checks**: `node tests/playback.test.cjs` (102 assertions).

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
