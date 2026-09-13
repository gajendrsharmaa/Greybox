-- Greybox D1 migration 0003: custom editorial tags (content groups).
--
-- Why new tables instead of reusing an existing structure:
--   - `overrides.custom_badge` is a SINGLE visual label per title — it cannot
--     hold multiple tags per title, has no tag identity (name/slug), no
--     ordering, and is never a content source.
--   - `collections` with `custom` items can list titles, but a collection is
--     a public page with cover/hero/meta semantics — not a reusable label.
--   - `settings` JSON blobs cannot express ordered per-tag membership or
--     answer "which sections/collections use this tag" without full scans
--     in JS.
-- `tags` + `tag_members` give: arbitrary tags, multiple tags per title,
-- ordered membership (position), reusable `{type:"tag",tag:"slug"}`
-- references from home_sections/collections source_json, and cheap
-- reference/usage lookups — all keyed by media + TMDB ID, never titles.
--
-- Never stored here: TMDB catalog data (titles, posters, overviews),
-- posters in bulk, or secrets. Membership rows hold identity only.
--
-- Apply AFTER 0002_seed.sql. Re-running is safe (IF NOT EXISTS, no seed rows
-- — tags start empty and are created in Admin → Tags).
-- Remote: `wrangler d1 execute greybox-db --remote --file=migrations/0003_tags.sql`

-- Editorial tags. `slug` is the permanent identity (never renamed in place —
-- rename = delete + create, same rule as collection slugs). `visible = 0`
-- removes the tag from ALL public surfaces (shelves resolve empty/skipped,
-- badges hidden). `badge = 1` additionally shows the tag name as a card +
-- detail badge on member titles (visible tags only).
CREATE TABLE IF NOT EXISTS tags (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  badge INTEGER NOT NULL DEFAULT 0 CHECK (badge IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tags_order
  ON tags (sort_order ASC, slug ASC);

-- Ordered tag membership: identity only (media + TMDB ID). One title can
-- belong to many tags; position preserves editorial order (0-based,
-- gapless, unique per tag — enforced by the admin API on write).
CREATE TABLE IF NOT EXISTS tag_members (
  tag_slug TEXT NOT NULL REFERENCES tags(slug) ON DELETE CASCADE,
  media TEXT NOT NULL CHECK (media IN ('movie', 'tv')),
  tmdb_id INTEGER NOT NULL CHECK (tmdb_id > 0),
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  PRIMARY KEY (tag_slug, media, tmdb_id)
);
CREATE INDEX IF NOT EXISTS idx_tag_members_tag
  ON tag_members (tag_slug ASC, position ASC);
