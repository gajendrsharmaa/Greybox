-- Greybox D1 migration 0004: permanent server-side blocklist.
--
-- A blocked title is excluded from ALL public Greybox discovery surfaces
-- (home shelves, movies, TV, anime, collections, genre/discover results,
-- trending, popular, search, Greybox Picks and every other TMDB-derived
-- shelf) via the centralized filter in js/data.js, and its detail page
-- refuses normal rendering. Admin TMDB search still finds blocked titles
-- (marked BLOCKED) so they can be inspected and unblocked.
--
-- Authoritative identity is ALWAYS (media, tmdb_id) — never title text:
-- titles change, "movie:12345" and "tv:12345" are different identities, and
-- the PRIMARY KEY enforces uniqueness so the same title can never be
-- blocked twice (the admin API also returns 409 on duplicates).
--
-- Snapshots (title, poster/backdrop paths, year) are display conveniences
-- for the Admin workspace ONLY — public filtering compares media + TMDB ID
-- and the public endpoint exposes identity only. Never stored here: TMDB
-- catalog data in bulk, API secrets, or the admin token.
--
-- Apply AFTER 0003_tags.sql. Re-running is safe (IF NOT EXISTS, no seed
-- rows — the blocklist starts empty and is managed in Admin → Blocked
-- Titles).
-- Remote: `wrangler d1 execute greybox-db --remote --file=migrations/0004_blocked.sql`

CREATE TABLE IF NOT EXISTS blocked_titles (
  media TEXT NOT NULL CHECK (media IN ('movie', 'tv')),
  tmdb_id INTEGER NOT NULL CHECK (tmdb_id > 0),
  title TEXT NOT NULL DEFAULT '',
  poster_path TEXT,
  backdrop_path TEXT,
  year TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (media, tmdb_id)
);
CREATE INDEX IF NOT EXISTS idx_blocked_titles_created
  ON blocked_titles (created_at DESC, media ASC, tmdb_id ASC);
