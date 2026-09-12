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
  } else if (type === 'collection') {
    // Expandable shelf: references an existing collection slug. Preview and
    // /collection/:slug share the SAME rule (resolveCollection) — no second
    // list system. Existence is render-time (unknown/hidden skips the shelf),
    // so validation only checks slug shape to keep create order flexible.
    clean.slug = validateSlug(src.slug);
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
    // Single-media stays exactly as before. Combined Movies + TV uses
    // media 'both' + genre { name, movie_id, tv_id } because TMDB keeps
    // separate movie and TV genre lists with different IDs.
    if (src.media === 'both') {
      if (!isObj(src.genre)) fail('source.genre must be { name, movie_id, tv_id } for media both');
      const name = typeof src.genre.name === 'string' ? src.genre.name.trim() : '';
      if (!name) fail('source.genre.name is required for media both');
      if (name.length > 64) fail('source.genre.name must be at most 64 characters');
      const movieId = validateGenreId(src.genre.movie_id, 'source.genre.movie_id');
      const tvId = validateGenreId(src.genre.tv_id, 'source.genre.tv_id');
      clean.media = 'both';
      clean.genre = { name, movie_id: movieId, tv_id: tvId };
      clean.sort = validateSort(src.sort, 'source');
    } else {
      clean.media = mediaOr('movie');
      clean.genreId = validateGenreId(src.genreId, 'source');
      clean.sort = validateSort(src.sort, 'source');
    }
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
 * Validate the home hero setting.
 *
 * Shape (all newer keys optional — a Part 0/1 era
 * { mode, badge, pick, source } validates identically):
 *   {
 *     mode: 'follow-grid' | 'custom' | 'spotlight',
 *     badge, pick, source,                       // existing (custom-mode) keys
 *     heroItem: { media, id } | null,            // explicit title (spotlight)
 *     artwork: { backdrop, backdropUrl, logo, logoUrl },
 *     trailer: { source, key, activation, delaySec, muted, loop },
 *   }
 */
export function validateHero(raw) {
  if (!isObj(raw)) fail('hero must be a JSON object');
  const mode = raw.mode === 'custom' ? 'custom' : (raw.mode === 'spotlight' ? 'spotlight' : 'follow-grid');
  const out = {
    mode,
    badge: typeof raw.badge === 'string' ? raw.badge.trim().slice(0, 120) : '',
    pick: Math.max(0, parseInt(raw.pick, 10) || 0),
    source: undefined,
    heroItem: null,
    artwork: validateArtwork(raw.artwork),
    trailer: validateTrailer(raw.trailer),
  };
  if (out.pick > 100) fail('pick must be at most 100');
  if (mode === 'custom') {
    if (!isObj(raw.source)) fail('custom hero needs a source object');
    out.source = validateHomeSource(raw.source);
  }
  if (raw.heroItem !== undefined && raw.heroItem !== null) {
    out.heroItem = validateHeroItem(raw.heroItem);
  }
  if (mode === 'spotlight' && !out.heroItem) {
    fail('spotlight hero needs heroItem { media, id }');
  }
  return out;
}

/* ---------------- hero control center (Part 2) ---------------- */

const YT_KEY_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Accept a bare 11-char YouTube key or a full YouTube watch / youtu.be /
 * embed / shorts / live URL and return the normalized key. Returns '' for
 * empty input (caller decides whether empty is allowed); throws on
 * non-YouTube or unparseable values. Pure — mirrored in js/admin.js.
 */
export function parseYoutubeKey(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (YT_KEY_RE.test(s)) return s;
  let u = null;
  try {
    u = new URL(s);
  } catch {
    fail('trailer must be a YouTube key or YouTube URL');
  }
  const host = String(u.hostname || '').toLowerCase().replace(/^www\./, '');
  let key = '';
  if (host === 'youtu.be') {
    key = String(u.pathname || '').split('/').filter(Boolean)[0] || '';
  } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const path = String(u.pathname || '');
    if (path === '/watch') key = u.searchParams.get('v') || '';
    else {
      const m = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(path);
      if (m) key = m[1];
    }
  }
  if (key && YT_KEY_RE.test(key)) return key;
  fail('trailer must be a YouTube key or YouTube URL (other hosts are not supported)');
}

function validateHttpUrl(v, field, max = 500) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') fail(`${field} must be a string`);
  const s = v.trim();
  if (!s) return '';
  if (s.length > max) fail(`${field} must be at most ${max} characters`);
  if (!/^https?:\/\//i.test(s)) fail(`${field} must be an http(s) URL`);
  return s;
}

/** Explicit hero title identity: strict { media, id } (no bare-number leniency). */
export function validateHeroItem(v) {
  if (!isObj(v)) fail('heroItem must be { media, id }');
  return { media: reqMedia(v.media), id: reqTmdbId(v.id) };
}

function validateArtwork(raw) {
  const v = isObj(raw) ? raw : {};
  const backdrop = v.backdrop === 'custom' ? 'custom' : 'auto';
  const logo = v.logo === 'tmdb' ? 'tmdb' : (v.logo === 'custom' ? 'custom' : 'text');
  const out = {
    backdrop,
    backdropUrl: validateHttpUrl(v.backdropUrl, 'artwork.backdropUrl'),
    logo,
    logoUrl: validateHttpUrl(v.logoUrl, 'artwork.logoUrl'),
  };
  if (backdrop === 'custom' && !out.backdropUrl) fail('artwork.backdropUrl is required for custom backdrops');
  if (logo === 'custom' && !out.logoUrl) fail('artwork.logoUrl is required for custom logos');
  return out;
}

function validateTrailer(raw) {
  const v = isObj(raw) ? raw : {};
  const source = v.source === 'custom' ? 'custom' : (v.source === 'off' ? 'off' : 'auto');
  const activation = v.activation === 'immediate' ? 'immediate' : (v.activation === 'wait-once' ? 'wait-once' : 'delayed');
  const out = {
    source,
    key: '',
    activation,
    delaySec: v.delaySec === undefined || v.delaySec === null ? 7 : reqInt(v.delaySec, 'trailer.delaySec', { min: 0, max: 120 }),
    muted: v.muted === undefined ? true : reqBool(v.muted, 'trailer.muted'),
    loop: v.loop === undefined ? true : reqBool(v.loop, 'trailer.loop'),
  };
  if (source === 'custom') {
    const key = parseYoutubeKey(v.key);
    if (!key) fail('trailer.key is required for custom trailers');
    out.key = key;
  }
  return out;
}

/**
 * Validate the collection_heroes settings map:
 *   { [slug]: { mode: 'default'|'custom', heroItem?, artwork?, trailer? } }
 * Shape-only (existence is render-time, like section collection slugs, so
 * create order stays flexible). Unknown keys inside entries are dropped.
 */
export function validateCollectionHeroes(raw) {
  if (raw === undefined || raw === null) return {};
  if (!isObj(raw)) fail('collection heroes must be an object');
  const entries = Object.entries(raw);
  if (entries.length > 200) fail('at most 200 collection heroes allowed');
  const out = {};
  for (const [slugRaw, entry] of entries) {
    const slug = validateSlug(slugRaw);
    if (!isObj(entry)) fail(`hero for "${slug}" must be an object`);
    const mode = entry.mode === 'custom' ? 'custom' : 'default';
    const clean = {
      mode,
      heroItem: null,
      artwork: validateArtwork(entry.artwork),
      trailer: validateTrailer(entry.trailer),
    };
    if (entry.heroItem !== undefined && entry.heroItem !== null) {
      clean.heroItem = validateHeroItem(entry.heroItem);
    }
    if (mode === 'custom' && !clean.heroItem) {
      fail(`hero for "${slug}": custom mode needs heroItem { media, id }`);
    }
    out[slug] = clean;
  }
  return out;
}

/**
 * Public-safe collection hero for one slug (or null = default behavior).
 * Re-validates stored data so a hand-edited or older row can never break
 * public rendering; malformed entries fall back to null (page survives).
 */
export function sanitizeCollectionHero(map, slug) {
  try {
    const s = String(slug || '').trim().toLowerCase();
    if (!s || !isObj(map)) return null;
    const entry = map[s];
    if (!entry || !isObj(entry)) return null;
    if (entry.mode !== 'custom') return null;
    const clean = validateCollectionHeroes({ [s]: entry });
    return clean[s] || null;
  } catch {
    return null;
  }
}
