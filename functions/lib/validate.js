/**
 * Greybox management-API input validation (server side).
 *
 * Mirrors the frontend normalizers in js/data.js (normalizeHomeSection,
 * normalizeCollection/Source, normalizeMetadataOverride) so anything the
 * admin API accepts is also renderable — but strict: malformed input is a
 * 400, never silently repaired. All helpers are pure (no I/O) and throw
 * ValidationError (with .status = 400) on bad input.
 */

// Same allowlist as OVERRIDABLE_FIELDS in js/data.js — only these keys are
// ever stored in overrides.fields_json. Anything else is rejected, so a
// pasted TMDB response can never land in D1.
export const OVERRIDABLE_FIELDS = [
  'title', 'name', 'overview', 'description',
  'poster_path', 'backdrop_path', 'vote_average',
  'release_date', 'first_air_date', 'featured', 'custom_badge',
];

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HOME_MOVIE_CATS = ['popular', 'top-rated', 'upcoming', 'now-playing'];
const HOME_TV_CATS = ['popular', 'top-rated', 'on-the-air', 'airing-today'];
const SORT_LEN = 64;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

function fail(msg) {
  throw new ValidationError(msg);
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function reqStr(v, field, { min = 1, max = 120 } = {}) {
  if (typeof v !== 'string') fail(`${field} must be a string`);
  const s = v.trim();
  if (s.length < min) fail(`${field} must not be empty`);
  if (s.length > max) fail(`${field} must be at most ${max} characters`);
  return s;
}

function optStr(v, field, max = 500) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') fail(`${field} must be a string`);
  if (v.length > max) fail(`${field} must be at most ${max} characters`);
  return v.trim();
}

function reqBool(v, field) {
  if (typeof v !== 'boolean') fail(`${field} must be true or false`);
  return v;
}

function reqInt(v, field, { min = 0, max = 100000 } = {}) {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${field} must be an integer ${min}..${max}`);
  return n;
}

function reqTmdbId(v) {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) fail('tmdb_id must be a positive integer');
  return n;
}

function reqMedia(v) {
  if (v !== 'movie' && v !== 'tv') fail("media must be 'movie' or 'tv'");
  return v;
}

/** TMDB id: positive 32-bit integer. */
export function validateMedia(v) {
  return reqMedia(v);
}

export function validateTmdbId(v) {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) fail('tmdb_id must be a positive integer');
  return n;
}

/** Lowercase slug; mirrors normalizeSlug in js/data.js. */
export function validateSlug(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s || s.length > 64 || !SLUG_RE.test(s)) fail('slug must match [a-z0-9-] (lowercase, max 64 chars)');
  return s;
}

/** Homepage section id: non-empty like the frontend, but URL-safe (no slashes). */
export function validateSectionId(v) {
  const s = reqStr(v, 'id', { min: 1, max: 64 });
  if (/[\/\0-\x1F\x7F]/.test(s)) fail('id must not contain slashes or control characters');
  return s;
}

function validateSort(v, owner) {
  const s = (typeof v === 'string' && v.trim()) ? v.trim() : 'popularity.desc';
  if (s.length > SORT_LEN) fail(`${owner}: sort must be at most ${SORT_LEN} characters`);
  return s;
}

function validateGenreId(v, owner) {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  if (!Number.isInteger(n) || n < 1 || n > 100000) fail(`${owner}: genreId must be a positive integer`);
  return n;
}

function validateYear(v, owner) {
  if (!/^\d{4}$/.test(String(v == null ? '' : v).trim())) fail(`${owner}: year must be YYYY`);
  const y = parseInt(String(v).trim(), 10);
  if (y < 1900 || y > 2100) fail(`${owner}: year must be 1900..2100`);
  return y;
}

// { media, id } with the same leniency as the frontend item normalizers:
// bare numbers default to movie.
function validateIdItem(it, owner) {
  if (it == null) fail(`${owner}: invalid item`);
  if (typeof it === 'number' || typeof it === 'string') {
    return { media: 'movie', id: reqTmdbId(it) };
  }
  if (!isObj(it)) fail(`${owner}: invalid item`);
  return { media: it.media === 'tv' ? 'tv' : 'movie', id: reqTmdbId(it.id) };
}

function validateIdList(v, owner, { min = 1, max = 200 } = {}) {
  if (!Array.isArray(v)) fail(`${owner}: items must be an array`);
  if (v.length < min) fail(`${owner}: at least one item is required`);
  if (v.length > max) fail(`${owner}: at most ${max} items allowed`);
  return v.map((it) => validateIdItem(it, owner));
}

function validateMediaOr(def) {
  return (m) => (m === 'tv' ? 'tv' : (m === 'movie' ? 'movie' : def));
}

/** Full mirror of the homepage source rules in js/data.js normalizeHomeSection. */
export function validateHomeSource(src) {
  if (!isObj(src) || typeof src.type !== 'string') fail('source.type is required');
  const type = src.type;
  const clean = { type };
  if (type === 'trending') {
    clean.media = src.media === 'movie' ? 'movie' : (src.media === 'tv' ? 'tv' : 'all');
  } else if (type === 'movies') {
    const cat = String(src.category || 'popular').toLowerCase();
    if (HOME_MOVIE_CATS.indexOf(cat) < 0) fail('unknown movies category: ' + cat);
    clean.category = cat;
  } else if (type === 'tv') {
    const cat = String(src.category || 'popular').toLowerCase();
    if (HOME_TV_CATS.indexOf(cat) < 0) fail('unknown tv category: ' + cat);
    clean.category = cat;
  } else if (type === 'anime') {
    clean.kind = src.kind === 'movies' ? 'movies' : 'series';
  } else if (type === 'search') {
    clean.query = reqStr(src.query, 'source.query', { min: 1, max: 120 });
  } else if (type === 'ids') {
    // Homepage ids entries require explicit { media, id } objects
    // (mirrors js/data.js — bare numbers are dropped there, rejected here).
    if (!Array.isArray(src.items) || !src.items.length) fail('source.items needs at least one valid { media, id }');
    clean.items = src.items.map((it) => {
      if (!isObj(it) || (it.media !== 'tv' && it.media !== 'movie')) fail('source.items entries need { media, id }');
      return { media: it.media, id: reqTmdbId(it.id) };
    });
  } else if (type === 'genre') {
    clean.media = validateMediaOr('movie')(src.media);
    clean.genreId = validateGenreId(src.genreId, 'source');
    clean.sort = validateSort(src.sort, 'source');
  } else {
    fail('unknown home source type: ' + type);
  }
  return clean;
}

/** Full mirror of the collection source rules in js/data.js normalizeCollectionSource. */
export function validateCollectionSource(src) {
  if (!isObj(src) || typeof src.type !== 'string') fail('source.type is required');
  const type = src.type;
  const clean = { type };
  const mediaOr = (def) => (src.media === 'tv' ? 'tv' : (src.media === 'movie' ? 'movie' : def));
  if (type === 'trending') {
    clean.media = src.media === 'movie' ? 'movie' : (src.media === 'tv' ? 'tv' : 'all');
  } else if (type === 'popular' || type === 'top-rated') {
    clean.media = src.media === 'tv' ? 'tv' : 'movie';
  } else if (type === 'now-playing') {
    if (src.media != null && src.media !== 'movie') fail('now-playing is movies only');
    clean.media = 'movie';
  } else if (type === 'discover') {
    clean.media = mediaOr('movie');
    if (src.genre != null && String(src.genre).trim() !== '') {
      clean.genre = validateGenreId(src.genre, 'source');
    }
    if (src.year != null && String(src.year).trim() !== '') {
      clean.year = validateYear(src.year, 'source');
    }
    clean.sort = validateSort(src.sort, 'source');
  } else if (type === 'genre') {
    clean.media = mediaOr('movie');
    clean.genreId = validateGenreId(src.genreId, 'source');
    clean.sort = validateSort(src.sort, 'source');
  } else if (type === 'year') {
    clean.media = mediaOr('movie');
    clean.year = validateYear(src.year, 'source');
    clean.sort = validateSort(src.sort, 'source');
  } else if (type === 'search') {
    clean.query = reqStr(src.query, 'source.query', { min: 1, max: 120 });
  } else if (type === 'custom') {
    clean.items = validateIdList(src.items, 'source.items');
    if (!clean.items.length) fail('source.items needs at least one valid item');
  } else {
    fail('unknown collection source type: ' + type);
  }
  return clean;
}

function validateMeta(v) {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) fail('meta must be an object');
  const keys = Object.keys(v);
  if (keys.length > 10) fail('meta must have at most 10 keys');
  const out = {};
  for (const k of keys) {
    if (k.length > 64) fail('meta keys must be at most 64 characters');
    const val = v[k];
    if (typeof val === 'string') {
      if (val.length > 200) fail(`meta.${k} must be at most 200 characters`);
      out[k] = val;
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      if (typeof val === 'number' && !isFinite(val)) fail(`meta.${k} must be finite`);
      out[k] = val;
    } else {
      fail(`meta.${k} must be a string, number or boolean`);
    }
  }
  return out;
}

function validateCover(v) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') fail('cover must be a string');
  const s = v.trim();
  if (!s) return '';
  if (s.length > 500) fail('cover must be at most 500 characters');
  if (!/^https?:\/\//i.test(s)) fail('cover must be an http(s) URL');
  return s;
}

// Manual pin entries: { media, id } objects (bare numbers default to movie).
function validatePinList(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail('pin must be an array');
  if (v.length > 200) fail('pin must have at most 200 entries');
  return v.map((it) => {
    if (it == null) fail('pin: invalid entry');
    if (typeof it === 'number' || typeof it === 'string') return { media: 'movie', id: reqTmdbId(it) };
    if (!isObj(it)) fail('pin: invalid entry');
    return { media: it.media === 'tv' ? 'tv' : 'movie', id: reqTmdbId(it.id) };
  });
}

// Exclude entries: bare ids (any media) or exact { media, id } objects.
function validateExcludeList(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail('exclude must be an array');
  if (v.length > 200) fail('exclude must have at most 200 entries');
  return v.map((it) => {
    if (it == null) fail('exclude: invalid entry');
    if (typeof it === 'number' || typeof it === 'string') return { id: reqTmdbId(it) };
    if (!isObj(it)) fail('exclude: invalid entry');
    const id = reqTmdbId(it.id);
    if (it.media !== 'tv' && it.media !== 'movie') return { id };
    return { media: it.media, id };
  });
}

/**
 * Validate a full collection body (POST create, PUT full update).
 * Returns the normalized object ready for storage.
 */
export function validateCollectionBody(body) {
  if (!isObj(body)) fail('body must be a JSON object');
  const slug = validateSlug(body.slug);
  const title = reqStr(body.title, 'title', { min: 1, max: 120 });
  const source = validateCollectionSource(body.source);
  return {
    slug,
    title,
    description: (body.description === undefined || body.description === null) ? '' : reqStr(body.description, 'description', { min: 0, max: 500 }),
    cover: validateCover(body.cover !== undefined ? body.cover : body.hero),
    visible: body.visible === undefined ? true : reqBool(body.visible, 'visible'),
    limit: body.limit === undefined || body.limit === null ? 20 : reqInt(body.limit, 'limit', { min: 1, max: 60 }),
    source,
    pin: validatePinList(body.pin),
    exclude: validateExcludeList(body.exclude),
    meta: validateMeta(body.meta),
    sort_order: body.sort_order === undefined || body.sort_order === null ? undefined : reqInt(body.sort_order, 'sort_order', { min: 0, max: 100000 }),
  };
}

/**
 * Validate a full home-section body (POST create, PUT full update).
 */
export function validateHomeSectionBody(body) {
  if (!isObj(body)) fail('body must be a JSON object');
  return {
    id: validateSectionId(body.id),
    title: reqStr(body.title, 'title', { min: 1, max: 120 }),
    description: (body.description === undefined || body.description === null) ? '' : reqStr(body.description, 'description', { min: 0, max: 500 }),
    visible: body.visible === undefined ? true : reqBool(body.visible, 'visible'),
    limit: body.limit === undefined || body.limit === null ? 12 : reqInt(body.limit, 'limit', { min: 1, max: 24 }),
    source: validateHomeSource(body.source),
    sort_order: body.sort_order === undefined || body.sort_order === null ? undefined : reqInt(body.sort_order, 'sort_order', { min: 0, max: 100000 }),
  };
}

/**
 * Validate override fields for POST/PUT. Returns ONLY allowlisted,
 * cleaned fields (unknown keys dropped — a TMDB dump can never land in D1).
 * Mirrors normalizeMetadataOverride in js/data.js.
 */
export function validateOverrideFields(raw) {
  if (!isObj(raw)) fail('fields must be a JSON object');
  const fields = {};
  for (const k of OVERRIDABLE_FIELDS) {
    let v = raw[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') {
      v = v.trim();
      if (!v) continue;
      if (v.length > 2000) fail(`${k} must be at most 2000 characters`);
    }
    if (k === 'vote_average') {
      v = Number(v);
      if (!isFinite(v)) continue;
    }
    if (k === 'featured' && typeof v !== 'boolean') fail('featured must be true or false');
    fields[k] = v;
  }
  if (Object.keys(fields).length === 0) fail('at least one overridable field is required');
  return fields;
}

/**
 * Validate the home hero setting: { mode, badge, pick, source|null }.
 */
export function validateHero(raw) {
  if (!isObj(raw)) fail('hero must be a JSON object');
  const mode = raw.mode === 'custom' ? 'custom' : 'follow-grid';
  const out = {
    mode,
    badge: typeof raw.badge === 'string' ? raw.badge.trim().slice(0, 120) : '',
    pick: Math.max(0, parseInt(raw.pick, 10) || 0),
    source: undefined,
  };
  if (out.pick > 100) fail('pick must be at most 100');
  if (mode === 'custom') {
    if (!isObj(raw.source)) fail('custom hero needs a source object');
    out.source = validateHomeSource(raw.source);
  }
  return out;
}
