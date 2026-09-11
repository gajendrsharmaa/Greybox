/**
 * Greybox D1 access layer — the ONLY place that contains raw SQL.
 *
 * Reads Greybox-OWNED configuration (homepage structure, collections,
 * explicit metadata overrides). Never touches TMDB data or secrets; those
 * keep flowing through functions/lib/greybox.js + TMDB credentials.
 *
 * Every helper returns plain config-shaped JSON (the same shape as the
 * local js/*.config.js files) so the frontend's existing normalizers
 * validate D1 rows exactly like file config. Callers, not this file,
 * decide what to do when the DB binding is missing (see getDb).
 */

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
  return {
    hero: {
      mode: heroRaw.mode === 'custom' ? 'custom' : 'follow-grid',
      badge: typeof heroRaw.badge === 'string' ? heroRaw.badge : '',
      pick: Math.max(0, parseInt(heroRaw.pick, 10) || 0),
      source: heroRaw.source && typeof heroRaw.source === 'object' ? heroRaw.source : undefined,
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
