-- Greybox D1 schema: Greybox-OWNED configuration only.
--
-- Never stored here: TMDB catalog data, posters, ratings, overviews, credits,
-- or the TMDB API secret. TMDB remains the live external source for all
-- movie/TV metadata; these tables only describe Greybox structure
-- (homepage order, collection rules, explicit metadata overrides).
--
-- Apply: `wrangler d1 execute greybox --local --file=migrations/0001_schema.sql`
-- Remote: `wrangler d1 execute greybox --remote --file=migrations/0001_schema.sql`

-- Homepage shelves. `source_json` holds ONE rule source, e.g.
-- {"type":"movies","category":"popular"}. Display order = sort_order.
CREATE TABLE IF NOT EXISTS home_sections (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  limit_count INTEGER NOT NULL DEFAULT 12 CHECK (limit_count > 0),
  source_json TEXT NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_home_sections_order
  ON home_sections (sort_order ASC, id ASC);

-- Greybox collections. `source_json` holds ONE rule source, e.g.
-- {"type":"discover","media":"movie","genre":878,"sort":"popularity.desc"}.
-- `pin_json` / `exclude_json` are arrays of {media,id} (or bare ids for
-- exclude). `meta_json` is an object like {"curator":"Greybox"} or NULL.
CREATE TABLE IF NOT EXISTS collections (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  limit_count INTEGER NOT NULL DEFAULT 20 CHECK (limit_count > 0),
  source_json TEXT NOT NULL DEFAULT '{}',
  pin_json TEXT NOT NULL DEFAULT '[]',
  exclude_json TEXT NOT NULL DEFAULT '[]',
  meta_json TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_collections_order
  ON collections (sort_order ASC, slug ASC);
CREATE INDEX IF NOT EXISTS idx_collections_visible
  ON collections (visible ASC);

-- Explicit Greybox metadata overrides. `fields_json` holds ONLY overridden
-- fields (title, description, poster_path, vote_average, featured,
-- custom_badge, ...). Anything absent falls back to live TMDB data.
CREATE TABLE IF NOT EXISTS overrides (
  media TEXT NOT NULL CHECK (media IN ('movie', 'tv')),
  tmdb_id INTEGER NOT NULL CHECK (tmdb_id > 0),
  fields_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (media, tmdb_id)
);

-- Single-row site settings as JSON. Known keys:
--   'home_hero' => {"mode":"follow-grid"|"custom","badge":"","pick":0,"source":null}
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
