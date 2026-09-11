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
