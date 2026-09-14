/**
 * Greybox D1 access layer — the ONLY place that contains raw SQL.
 *
 * Reads Greybox-OWNED configuration (homepage structure, collections,
 * explicit metadata overrides, custom editorial tags, permanent blocklist). Never touches TMDB data or secrets; those
 * keep flowing through functions/lib/greybox.js + TMDB credentials.
 *
 * Every helper returns plain config-shaped JSON (the same shape as the
 * local js/*.config.js files) so the frontend's existing normalizers
 * validate D1 rows exactly like file config. Callers, not this file,
 * decide what to do when the DB binding is missing (see getDb).
 */

import { sanitizeNavigation } from './validate.js';

/** D1 binding (wrangler.toml `[[d1_databases]] binding = "DB"`), or null. */
export function getDb(env) {
  return (env && env.DB) || null;
}

function parseJson(v, fallback) {
  if (v == null || v === '') return fallback;
  try {
    const x = JSON.parse(v);
    return x === undefined ? fallback : x;
  } catch {
    return fallback;
  }
}

function asBool(v, fallback = true) {
  if (v === 1 || v === true) return true;
  if (v === 0 || v === false) return false;
  return fallback;
}

function asInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function rowToHomeSection(r) {
  return {
    id: r.id,
    title: r.title,
    description: r.description || '',
    visible: asBool(r.visible, true),
    limit: asInt(r.limit_count, 12),
    source: parseJson(r.source_json, null),
  };
}

function rowToCollection(r) {
  return {
    slug: r.slug,
    title: r.title,
    description: r.description || '',
    cover: r.cover || '',
    visible: asBool(r.visible, true),
    limit: asInt(r.limit_count, 20),
    source: parseJson(r.source_json, null),
    pin: parseJson(r.pin_json, []),
    exclude: parseJson(r.exclude_json, []),
    meta: parseJson(r.meta_json, null),
  };
}

/** { hero, sections } in js/homepage.config.js shape. */
export async function readHomeConfig(db) {
  const heroRow = await db
    .prepare("SELECT value_json FROM settings WHERE key = 'home_hero'")
    .first();
  const heroRaw = parseJson(heroRow && heroRow.value_json, null) || {};
  const { results } = await db
    .prepare(
      'SELECT id, title, description, visible, limit_count, source_json ' +
        'FROM home_sections ORDER BY sort_order ASC, id ASC',
    )
    .all();
  // New hero keys (heroItem/artwork/trailer) pass through only when they
  // look structurally sound; the renderer + validateHero own strictness.
  // Old rows without them behave exactly as before (defaults apply).
  const heroItemRaw = heroRaw.heroItem;
  const heroItem = (heroItemRaw && typeof heroItemRaw === 'object' && !Array.isArray(heroItemRaw) &&
    (heroItemRaw.media === 'movie' || heroItemRaw.media === 'tv') &&
    Number.isInteger(heroItemRaw.id) && heroItemRaw.id > 0)
    ? { media: heroItemRaw.media, id: heroItemRaw.id }
    : null;
  const artworkRaw = (heroRaw.artwork && typeof heroRaw.artwork === 'object' && !Array.isArray(heroRaw.artwork)) ? heroRaw.artwork : null;
  const trailerRaw = (heroRaw.trailer && typeof heroRaw.trailer === 'object' && !Array.isArray(heroRaw.trailer)) ? heroRaw.trailer : null;
  return {
    hero: {
      mode: heroRaw.mode === 'custom' ? 'custom' : (heroRaw.mode === 'spotlight' ? 'spotlight' : 'follow-grid'),
      badge: typeof heroRaw.badge === 'string' ? heroRaw.badge : '',
      pick: Math.max(0, parseInt(heroRaw.pick, 10) || 0),
      source: heroRaw.source && typeof heroRaw.source === 'object' ? heroRaw.source : undefined,
      heroItem,
      artwork: artworkRaw,
      trailer: trailerRaw,
    },
    sections: (results || []).map(rowToHomeSection),
  };
}

/** Array of collections in js/collections.config.js shape, display order. */
export async function readCollections(db) {
  const { results } = await db
    .prepare(
      'SELECT slug, title, description, cover, visible, limit_count, ' +
        'source_json, pin_json, exclude_json, meta_json ' +
        'FROM collections ORDER BY sort_order ASC, slug ASC',
    )
    .all();
  return (results || []).map(rowToCollection);
}

/** Single collection row by slug (visibility NOT filtered here — the route
 *  handler decides: hidden slugs are 404, mirroring local-config behavior). */
export async function readCollection(db, slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!s) return null;
  const row = await db
    .prepare(
      'SELECT slug, title, description, cover, visible, limit_count, ' +
        'source_json, pin_json, exclude_json, meta_json ' +
        'FROM collections WHERE slug = ?',
    )
    .bind(s)
    .first();
  return row ? rowToCollection(row) : null;
}

/** Array of `{ tmdb_id, media, ...fields }` in js/overrides.config.js shape. */
export async function readOverrides(db) {
  const { results } = await db
    .prepare('SELECT media, tmdb_id, fields_json FROM overrides ORDER BY media ASC, tmdb_id ASC')
    .all();
  const out = [];
  for (const r of results || []) {
    const fields = parseJson(r.fields_json, null);
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    out.push({ tmdb_id: r.tmdb_id, media: r.media, ...fields });
  }
  return out;
}

/* ---------------- management writes (admin API only — always parameterized) ---------------- */

async function nextSortOrder(db, table) {
  // Table name is never user input: callers pass a fixed literal.
  const row = await db
    .prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM ${table}`)
    .first();
  return (row && Number.isFinite(row.n)) ? row.n : 0;
}

function toJson(v) {
  return JSON.stringify(v == null ? {} : v);
}

/** Insert a validated collection row ({ slug, title, description, cover, visible, limit, source, pin, exclude, meta, sort_order? }). Throws { status: 409 } on duplicate slug. */
export async function createCollection(db, c) {
  const existing = await readCollection(db, c.slug);
  if (existing) throw { status: 409, message: 'Collection already exists: ' + c.slug };
  const order = c.sort_order != null ? c.sort_order : await nextSortOrder(db, 'collections');
  await db
    .prepare(
      'INSERT INTO collections (slug, title, description, cover, visible, limit_count, source_json, pin_json, exclude_json, meta_json, sort_order) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      c.slug, c.title, c.description || '', c.cover || '', c.visible ? 1 : 0, c.limit,
      toJson(c.source), JSON.stringify(c.pin || []), JSON.stringify(c.exclude || []),
      c.meta ? JSON.stringify(c.meta) : null, order,
    )
    .run();
  return readCollection(db, c.slug);
}

/** Full-update a collection by slug. Returns the stored row, or null if missing. */
export async function updateCollection(db, slug, c) {
  const existing = await readCollection(db, slug);
  if (!existing) return null;
  let order = c.sort_order;
  if (order == null) {
    const cur = await db.prepare('SELECT sort_order AS n FROM collections WHERE slug = ?').bind(slug).first();
    order = (cur && Number.isFinite(cur.n)) ? cur.n : 0;
  }
  await db
    .prepare(
      'UPDATE collections SET title = ?, description = ?, cover = ?, visible = ?, ' +
        'limit_count = ?, source_json = ?, pin_json = ?, exclude_json = ?, meta_json = ?, ' +
        'sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE slug = ?',
    )
    .bind(
      c.title, c.description || '', c.cover || '', c.visible ? 1 : 0, c.limit,
      toJson(c.source), JSON.stringify(c.pin || []), JSON.stringify(c.exclude || []),
      c.meta ? JSON.stringify(c.meta) : null,
      order,
      slug,
    )
    .run();
  return readCollection(db, slug);
}

function changesOf(out) {
  // Real D1 reports { success, meta: { changes } }; node:sqlite-style
  // shims report { changes }. Accept both so tests mirror production.
  if (out && out.meta && typeof out.meta.changes === 'number') return out.meta.changes;
  if (out && typeof out.changes === 'number') return out.changes;
  return 0;
}

/** Delete a collection by slug. Returns true when a row was removed. */
export async function deleteCollection(db, slug) {
  const out = await db.prepare('DELETE FROM collections WHERE slug = ?').bind(slug).run();
  return changesOf(out) > 0;
}

/** Single home section by id, or null. */
export async function readHomeSection(db, id) {
  const key = String(id || '').trim();
  if (!key) return null;
  const row = await db
    .prepare('SELECT id, title, description, visible, limit_count, source_json FROM home_sections WHERE id = ?')
    .bind(key)
    .first();
  return row ? rowToHomeSection(row) : null;
}

/** Insert a validated home-section row. Throws { status: 409 } on duplicate id. */
export async function createHomeSection(db, s) {
  if (await readHomeSection(db, s.id)) throw { status: 409, message: 'Home section already exists: ' + s.id };
  const order = s.sort_order != null ? s.sort_order : await nextSortOrder(db, 'home_sections');
  await db
    .prepare(
      'INSERT INTO home_sections (id, title, description, visible, limit_count, source_json, sort_order) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(s.id, s.title, s.description || '', s.visible ? 1 : 0, s.limit, toJson(s.source), order)
    .run();
  return readHomeSection(db, s.id);
}

/** Full-update a home section by id. Returns the stored row, or null if missing. */
export async function updateHomeSection(db, id, s) {
  if (!(await readHomeSection(db, id))) return null;
  let order = s.sort_order;
  if (order == null) {
    const cur = await db.prepare('SELECT sort_order AS n FROM home_sections WHERE id = ?').bind(id).first();
    order = (cur && Number.isFinite(cur.n)) ? cur.n : 0;
  }
  await db
    .prepare(
      'UPDATE home_sections SET title = ?, description = ?, visible = ?, ' +
        'limit_count = ?, source_json = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    )
    .bind(s.title, s.description || '', s.visible ? 1 : 0, s.limit, toJson(s.source), order, id)
    .run();
  return readHomeSection(db, id);
}

/** Delete a home section by id. Returns true when a row was removed. */
export async function deleteHomeSection(db, id) {
  const out = await db.prepare('DELETE FROM home_sections WHERE id = ?').bind(id).run();
  return changesOf(out) > 0;
}

/** Single override by (media, tmdb_id): `{ tmdb_id, media, ...fields }`, or null. */
export async function readOverride(db, media, tmdbId) {
  if ((media !== 'movie' && media !== 'tv') || !(tmdbId > 0)) return null;
  const row = await db
    .prepare('SELECT media, tmdb_id, fields_json FROM overrides WHERE media = ? AND tmdb_id = ?')
    .bind(media, tmdbId)
    .first();
  if (!row) return null;
  const fields = parseJson(row.fields_json, null);
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
  return { tmdb_id: row.tmdb_id, media: row.media, ...fields };
}

/** Insert an override ({ media, tmdb_id, fields }). Throws { status: 409 } on duplicate. */
export async function createOverride(db, o) {
  if (await readOverride(db, o.media, o.tmdb_id)) {
    throw { status: 409, message: 'Override already exists: ' + o.media + ':' + o.tmdb_id };
  }
  await db
    .prepare('INSERT INTO overrides (media, tmdb_id, fields_json) VALUES (?, ?, ?)')
    .bind(o.media, o.tmdb_id, JSON.stringify(o.fields))
    .run();
  return readOverride(db, o.media, o.tmdb_id);
}

/** Replace an override's fields. Returns the stored row, or null if missing. */
export async function updateOverride(db, media, tmdbId, fields) {
  if (!(await readOverride(db, media, tmdbId))) return null;
  await db
    .prepare('UPDATE overrides SET fields_json = ?, updated_at = CURRENT_TIMESTAMP WHERE media = ? AND tmdb_id = ?')
    .bind(JSON.stringify(fields), media, tmdbId)
    .run();
  return readOverride(db, media, tmdbId);
}

/** Delete an override. Returns true when a row was removed. */
export async function deleteOverride(db, media, tmdbId) {
  const out = await db
    .prepare('DELETE FROM overrides WHERE media = ? AND tmdb_id = ?')
    .bind(media, tmdbId)
    .run();
  return changesOf(out) > 0;
}

/* ---------------- custom editorial tags (Part 4.5) ----------------
 *
 * Tags are Greybox-owned content groups: { slug, name, description,
 * visible, badge } + ordered membership [{ media, id }]. Membership holds
 * identity only (media + TMDB ID) — never titles, posters, or TMDB data.
 * Deletion removes members explicitly first (SQLite FK enforcement is not
 * relied upon), then the tag row.
 */

function rowToTagSummary(r, counts) {
  const c = (counts && counts[r.slug]) || { n: 0, movies: 0, tv: 0 };
  return {
    slug: r.slug,
    name: r.name,
    description: r.description || '',
    visible: asBool(r.visible, true),
    badge: asBool(r.badge, false),
    member_count: c.n,
    movie_count: c.movies,
    tv_count: c.tv,
  };
}

async function tagMemberCounts(db) {
  // One grouped query for every tag's counts (no N+1 on list).
  const { results } = await db
    .prepare(
      'SELECT tag_slug AS slug, COUNT(*) AS n, ' +
        "SUM(CASE WHEN media = 'movie' THEN 1 ELSE 0 END) AS movies, " +
        "SUM(CASE WHEN media = 'tv' THEN 1 ELSE 0 END) AS tv " +
        'FROM tag_members GROUP BY tag_slug',
    )
    .all();
  const out = {};
  for (const r of results || []) {
    out[r.slug] = {
      n: asInt(r.n, 0),
      movies: asInt(r.movies, 0),
      tv: asInt(r.tv, 0),
    };
  }
  return out;
}

/** All tags in display order, each with member counts (no member lists). */
export async function readTags(db) {
  const { results } = await db
    .prepare(
      'SELECT slug, name, description, visible, badge ' +
        'FROM tags ORDER BY sort_order ASC, slug ASC',
    )
    .all();
  const counts = await tagMemberCounts(db);
  return (results || []).map((r) => rowToTagSummary(r, counts));
}

/** Ordered members [{ media, id }] for one tag slug (position order). */
export async function readTagMembers(db, slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!s) return [];
  const { results } = await db
    .prepare(
      'SELECT media, tmdb_id AS id FROM tag_members ' +
        'WHERE tag_slug = ? ORDER BY position ASC, media ASC, tmdb_id ASC',
    )
    .bind(s)
    .all();
  return (results || [])
    .filter((r) => (r.media === 'movie' || r.media === 'tv') && Number.isInteger(r.id) && r.id > 0)
    .map((r) => ({ media: r.media, id: r.id }));
}

/** Single tag with ordered members, or null when missing. */
export async function readTag(db, slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!s) return null;
  const row = await db
    .prepare('SELECT slug, name, description, visible, badge FROM tags WHERE slug = ?')
    .bind(s)
    .first();
  if (!row) return null;
  return {
    slug: row.slug,
    name: row.name,
    description: row.description || '',
    visible: asBool(row.visible, true),
    badge: asBool(row.badge, false),
    members: await readTagMembers(db, s),
  };
}

/** Public tag list: visible tags with ordered members, in display order.
 *  Two queries total (tags + all members) regardless of tag count. */
export async function readPublicTags(db) {
  const { results } = await db
    .prepare(
      'SELECT slug, name, description, badge FROM tags ' +
        'WHERE visible = 1 ORDER BY sort_order ASC, slug ASC',
    )
    .all();
  const tags = results || [];
  if (!tags.length) return [];
  const { results: mrows } = await db
    .prepare(
      'SELECT tag_slug, media, tmdb_id AS id FROM tag_members ' +
        'ORDER BY tag_slug ASC, position ASC, media ASC, tmdb_id ASC',
    )
    .all();
  const bySlug = {};
  for (const r of mrows || []) {
    if (r.media !== 'movie' && r.media !== 'tv') continue;
    if (!Number.isInteger(r.id) || r.id < 1) continue;
    (bySlug[r.tag_slug] = bySlug[r.tag_slug] || []).push({ media: r.media, id: r.id });
  }
  return tags.map((t) => ({
    slug: t.slug,
    name: t.name,
    description: t.description || '',
    badge: asBool(t.badge, false),
    members: bySlug[t.slug] || [],
  }));
}

// Write the member list for a tag: explicit positions 0..n-1 (gapless),
// callers pass already-validated [{ media, id }] (dedupe keeps first).
async function writeTagMembers(db, slug, members) {
  await db.prepare('DELETE FROM tag_members WHERE tag_slug = ?').bind(slug).run();
  const list = Array.isArray(members) ? members : [];
  let pos = 0;
  for (const m of list) {
    if (!m || (m.media !== 'movie' && m.media !== 'tv')) continue;
    if (!Number.isInteger(m.id) || m.id < 1) continue;
    await db
      .prepare('INSERT OR IGNORE INTO tag_members (tag_slug, media, tmdb_id, position) VALUES (?, ?, ?, ?)')
      .bind(slug, m.media, m.id, pos)
      .run();
    pos++;
  }
}

/** Insert a validated tag ({ slug, name, description, visible, badge, members?, sort_order? }). Throws { status: 409 } on duplicate slug. */
export async function createTag(db, t) {
  const existing = await readTag(db, t.slug);
  if (existing) throw { status: 409, message: 'Tag already exists: ' + t.slug };
  const order = t.sort_order != null ? t.sort_order : await nextSortOrder(db, 'tags');
  await db
    .prepare(
      'INSERT INTO tags (slug, name, description, visible, badge, sort_order) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(t.slug, t.name, t.description || '', t.visible ? 1 : 0, t.badge ? 1 : 0, order)
    .run();
  await writeTagMembers(db, t.slug, t.members);
  return readTag(db, t.slug);
}

/** Full-update a tag by slug (fields + ordered members replaced). Returns the stored row, or null if missing. */
export async function updateTag(db, slug, t) {
  const existing = await readTag(db, slug);
  if (!existing) return null;
  let order = t.sort_order;
  if (order == null) {
    const cur = await db.prepare('SELECT sort_order AS n FROM tags WHERE slug = ?').bind(slug).first();
    order = (cur && Number.isFinite(cur.n)) ? cur.n : 0;
  }
  await db
    .prepare(
      'UPDATE tags SET name = ?, description = ?, visible = ?, badge = ?, ' +
        'sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE slug = ?',
    )
    .bind(t.name, t.description || '', t.visible ? 1 : 0, t.badge ? 1 : 0, order, slug)
    .run();
  await writeTagMembers(db, slug, t.members);
  return readTag(db, slug);
}

/** Delete a tag and its memberships. Returns true when a tag row was removed. */
export async function deleteTag(db, slug) {
  await db.prepare('DELETE FROM tag_members WHERE tag_slug = ?').bind(slug).run();
  const out = await db.prepare('DELETE FROM tags WHERE slug = ?').bind(slug).run();
  return changesOf(out) > 0;
}

/** Where a tag slug is referenced as a content source: home section ids +
 *  collection slugs whose source_json is {"type":"tag","tag":"<slug>"}.
 *  Used for usage display and delete protection (real references only). */
export async function findTagUsage(db, slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!s) return { sections: [], collections: [] };
  // Slug charset [a-z0-9-] is LIKE-safe (no % or _ possible).
  const typePat = '%"type":"tag"%';
  const tagPat = '%"tag":"' + s + '"%';
  const sec = await db
    .prepare(
      'SELECT id, title FROM home_sections ' +
        'WHERE source_json LIKE ? AND source_json LIKE ? ORDER BY sort_order ASC, id ASC',
    )
    .bind(typePat, tagPat)
    .all();
  const col = await db
    .prepare(
      'SELECT slug, title FROM collections ' +
        'WHERE source_json LIKE ? AND source_json LIKE ? ORDER BY sort_order ASC, slug ASC',
    )
    .bind(typePat, tagPat)
    .all();
  return {
    sections: (sec.results || []).map((r) => ({ id: r.id, title: r.title })),
    collections: (col.results || []).map((r) => ({ slug: r.slug, title: r.title })),
  };
}

/* ---------------- permanent blocklist (Blocked Titles workspace) ----------------
 *
 * A blocked title is globally excluded from public Greybox discovery.
 * Authoritative identity is ALWAYS (media, tmdb_id) — never title text —
 * enforced by the PRIMARY KEY. Snapshots (title/poster/backdrop/year) are
 * Admin-workspace display conveniences only; public filtering compares the
 * identity pair via readPublicBlocked() (identity only, no snapshots).
 */

function rowToBlocked(r) {
  return {
    media: r.media,
    tmdb_id: r.tmdb_id,
    title: r.title || '',
    poster_path: r.poster_path || null,
    backdrop_path: r.backdrop_path || null,
    year: r.year || '',
    created_at: r.created_at || null,
    updated_at: r.updated_at || null,
  };
}

/** All blocked titles (admin view, with snapshots), newest first. */
export async function readBlockedTitles(db) {
  const { results } = await db
    .prepare(
      'SELECT media, tmdb_id, title, poster_path, backdrop_path, year, created_at, updated_at ' +
        'FROM blocked_titles ORDER BY created_at DESC, media ASC, tmdb_id ASC',
    )
    .all();
  return (results || [])
    .filter((r) => (r.media === 'movie' || r.media === 'tv') && Number.isInteger(r.tmdb_id) && r.tmdb_id > 0)
    .map(rowToBlocked);
}

/** Public blocklist: identity only ([{ media, id }]), in stable order.
 *  Two fields, nothing else — no snapshots, no timestamps, no D1 internals. */
export async function readPublicBlocked(db) {
  const { results } = await db
    .prepare('SELECT media, tmdb_id AS id FROM blocked_titles ORDER BY media ASC, tmdb_id ASC')
    .all();
  return (results || [])
    .filter((r) => (r.media === 'movie' || r.media === 'tv') && Number.isInteger(r.id) && r.id > 0)
    .map((r) => ({ media: r.media, id: r.id }));
}

/** Single blocked title by (media, tmdb_id), or null when not blocked. */
export async function readBlocked(db, media, tmdbId) {
  if ((media !== 'movie' && media !== 'tv') || !(tmdbId > 0)) return null;
  const row = await db
    .prepare(
      'SELECT media, tmdb_id, title, poster_path, backdrop_path, year, created_at, updated_at ' +
        'FROM blocked_titles WHERE media = ? AND tmdb_id = ?',
    )
    .bind(media, tmdbId)
    .first();
  return row ? rowToBlocked(row) : null;
}

/** Block a title ({ media, tmdb_id, title?, poster_path?, backdrop_path?, year? }).
 *  Throws { status: 409 } when the same media + TMDB ID is already blocked. */
export async function createBlocked(db, b) {
  if (await readBlocked(db, b.media, b.tmdb_id)) {
    throw { status: 409, message: 'Title already blocked: ' + b.media + ':' + b.tmdb_id };
  }
  await db
    .prepare(
      'INSERT INTO blocked_titles (media, tmdb_id, title, poster_path, backdrop_path, year) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(
      b.media, b.tmdb_id,
      b.title || '', b.poster_path || null, b.backdrop_path || null, b.year || '',
    )
    .run();
  return readBlocked(db, b.media, b.tmdb_id);
}

/** Unblock a title. Returns true when a row was removed. */
export async function deleteBlocked(db, media, tmdbId) {
  const out = await db
    .prepare('DELETE FROM blocked_titles WHERE media = ? AND tmdb_id = ?')
    .bind(media, tmdbId)
    .run();
  return changesOf(out) > 0;
}

/* ---------------- public navigation (Navigation workspace) ----------------
 *
 * The public navbar configuration lives in ONE settings row (key
 * 'navigation'), mirroring 'home_hero' / 'collection_heroes' — no new
 * table for a fixed six-item menu. Stored shape:
 *   { items: [{ key, label, visible }...6 in display order], searchVisible }
 * Stable identity is the item KEY (never the label); array order IS the
 * display order; routes are derived from the key (controlled known routes
 * only — never stored, never arbitrary URLs). Read-side shaping reuses the
 * lenient sanitizeNavigation() from validate.js (unknown keys dropped,
 * missing keys filled from defaults, invalid labels fall back) so a corrupt
 * row renders as the default navbar, never a broken page.
 */

/** Full navigation config (hidden items included with flags, routes attached). */
export async function readNavigation(db) {
  const raw = await readSetting(db, 'navigation');
  try {
    return sanitizeNavigation(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null);
  } catch {
    return sanitizeNavigation(null);
  }
}

/** Raw setting value (parsed JSON) by key, or null when absent/unparseable. */
export async function readSetting(db, key) {
  const row = await db.prepare('SELECT value_json FROM settings WHERE key = ?').bind(key).first();
  if (!row) return null;
  return parseJson(row.value_json, null);
}

/** Upsert a setting value (plain JSON object). Returns the stored value. */
export async function writeSetting(db, key, value) {
  await db
    .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP')
    .bind(key, JSON.stringify(value == null ? {} : value))
    .run();
  return readSetting(db, key);
}
