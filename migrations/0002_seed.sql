-- Greybox D1 seed: mirrors the local config files exactly, so migrating
-- to D1 changes nothing visible. Source of truth for these rows used to be:
--   js/homepage.config.js  -> home_sections + settings('home_hero')
--   js/collections.config.js -> collections
--   js/overrides.config.js   -> overrides
-- Those files stay in the repo as offline fallback (static preview, Vercel).
--
-- Apply AFTER 0001_schema.sql. Re-running is safe (INSERT OR REPLACE).

-- Homepage hero: follow the main grid, exactly like the config default.
INSERT OR REPLACE INTO settings (key, value_json)
VALUES ('home_hero', '{"mode":"follow-grid","badge":"","pick":0,"source":null}');

-- Homepage shelves, in display order.
INSERT OR REPLACE INTO home_sections (id, title, description, visible, limit_count, source_json, sort_order)
VALUES
  ('popular-movies', 'Popular Movies', 'What everyone is watching right now.', 1, 12,
   '{"type":"movies","category":"popular"}', 0),
  ('popular-tv', 'Popular TV Shows', 'Binge-worthy series trending this week.', 1, 12,
   '{"type":"tv","category":"popular"}', 1);

-- Collections, in footer/display order.
INSERT OR REPLACE INTO collections (slug, title, description, cover, visible, limit_count, source_json, pin_json, exclude_json, meta_json, sort_order)
VALUES
  ('science-fiction', 'Science Fiction',
   'Space, time travel and robots — currently popular sci-fi, refreshed from TMDB.',
   '', 1, 24,
   '{"type":"discover","media":"movie","genre":878,"sort":"popularity.desc"}',
   '[]', '[]',
   '{"curator":"Greybox","updated":"2026-09"}', 0),
  ('top-rated', 'Top Rated',
   'The highest-rated films of all time, live from TMDB.',
   '', 1, 20,
   '{"type":"top-rated","media":"movie"}',
   '[]', '[]',
   '{"curator":"Greybox"}', 1),
  ('recently-released', 'Recently Released',
   'Now playing in cinemas — updated as new films arrive.',
   '', 1, 20,
   '{"type":"now-playing","media":"movie"}',
   '[]', '[]',
   '{"curator":"Greybox"}', 2),
  ('editor-picks', 'Editor''s Picks',
   'Exact titles, hand-picked by Greybox in viewing order.',
   '', 1, 12,
   '{"type":"custom","items":[{"media":"movie","id":550},{"media":"movie","id":155},{"media":"tv","id":1399}]}',
   '[]', '[]',
   '{"curator":"Greybox"}', 3);

-- Explicit Greybox metadata overrides (only overridden fields — no TMDB dump).
INSERT OR REPLACE INTO overrides (media, tmdb_id, fields_json)
VALUES
  ('movie', 550,
   '{"title":"Fight Club — Greybox Cut","description":"Greybox pick: an insomniac office worker and a soap salesman build something they cannot control.","featured":true,"custom_badge":"Greybox Pick"}'),
  ('tv', 1399,
   '{"description":"Greybox pick: Game of Thrones is an epic fantasy television series that follows noble families fighting for control of the Iron Throne of the Seven Kingdoms, while an ancient existential threat rises in the frozen north","custom_badge":"Greybox Pick"}');
