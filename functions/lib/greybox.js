/**
 * Greybox API — shared pure logic (no runtime APIs except global fetch).
 *
 * Single source of truth for BOTH backends (keep all imports INSIDE functions/ —
 * Cloudflare Pages only bundles function code and its in-functions imports):
 *   - Cloudflare Pages: functions/api routes (static `import` from here)
 *   - Vercel:           api routes          (dynamic `await import()` from here)
 *
 * The backend calls TMDB internally (secret stays server-side) and returns
 * only the fields the Greybox frontend actually needs. The frontend must
 * never construct TMDB paths itself — it talks to /api/* only.
 *
 * Contract (all JSON, GET only):
 *   GET /api/trending?page=1
 *   GET /api/movies/popular|top-rated|upcoming|now-playing?page=1
 *   GET /api/tv/popular|top-rated|on-the-air|airing-today?page=1
 *   GET /api/anime/series|movies?page=1
 *   GET /api/movie/:id?region=US            (detail bundle)
 *   GET /api/tv/:id?region=US               (detail bundle + seasons)
 *   GET /api/tv/:id/season/:n               (episodes)
 *   GET /api/search?q=...&page=1
 */

// Greybox kebab-case -> TMDB snake_case (allowlist doubles as validation).
export const MOVIE_CATS = {
  popular: 'popular',
  'top-rated': 'top_rated',
  upcoming: 'upcoming',
  'now-playing': 'now_playing',
};

export const TV_CATS = {
  popular: 'popular',
  'top-rated': 'top_rated',
  'on-the-air': 'on_the_air',
  'airing-today': 'airing_today',
};

// Greybox kind -> TMDB discover endpoint type.
export const ANIME_KINDS = {
  series: 'tv',
  movies: 'movie',
};

export function parsePage(v) {
  const n = parseInt(String(v ?? '1'), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 500); // TMDB caps paging at 500
}

export function parseRegion(v, fallback = 'US') {
  const r = String(v ?? fallback ?? 'US').toUpperCase();
  return /^[A-Z]{2}$/.test(r) ? r : 'US';
}

export function parseId(v) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function getCreds(env) {
  const token = (env && env.TMDB_READ_TOKEN ? String(env.TMDB_READ_TOKEN) : '').trim();
  const apiKey = (env && env.TMDB_API_KEY ? String(env.TMDB_API_KEY) : '').trim();
  if (!token && !apiKey) return null;
  return { token, apiKey };
}

/**
 * Server-side TMDB GET. Throws Error with .status (502 unreachable,
 * or TMDB's own status incl. 404 unknown id / success:false payloads).
 */
export async function tmdbGet(creds, path, params = {}) {
  const url = new URL('https://api.themoviedb.org/3/' + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  const headers = { accept: 'application/json' };
  if (creds.token) headers.Authorization = 'Bearer ' + creds.token;
  else if (creds.apiKey) url.searchParams.set('api_key', creds.apiKey);

  let res;
  try {
    res = await fetch(url.toString(), { headers });
  } catch (e) {
    const err = new Error('Could not reach TMDB: ' + (e && e.message ? e.message : String(e)));
    err.status = 502;
    throw err;
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.success === false)) {
    const err = new Error(
      data && data.status_message ? 'TMDB: ' + data.status_message : 'TMDB error ' + res.status,
    );
    err.status = res.status === 404 ? 404 : res.status;
    throw err;
  }
  return data || {};
}

/* ---------------- shaping: TMDB -> Greybox (only needed fields) ---------------- */

export function pickListItem(r, fallbackType) {
  const mt =
    r.media_type === 'tv' || r.media_type === 'movie'
      ? r.media_type
      : fallbackType || (r.title ? 'movie' : 'tv');
  const title = r.title || r.name || 'Untitled';
  const vote =
    typeof r.vote_average === 'number' ? r.vote_average : Number(r.vote_average || 0);
  return {
    id: r.id,
    media_type: mt,
    // Both aliases populated so existing `x.title || x.name` UI code keeps working.
    title,
    name: title,
    overview: r.overview || '',
    poster_path: r.poster_path || null,
    backdrop_path: r.backdrop_path || null,
    vote_average: Number.isFinite(vote) ? vote : 0,
    release_date: r.release_date || '',
    first_air_date: r.first_air_date || '',
  };
}

export function shapeList(tmdbData, fallbackType, { requireImage = true } = {}) {
  const results = Array.isArray(tmdbData.results) ? tmdbData.results : [];
  const items = results
    .filter((x) => (requireImage ? x.poster_path || x.backdrop_path : true))
    .map((x) => pickListItem(x, fallbackType));
  return {
    page: tmdbData.page || 1,
    total_pages: tmdbData.total_pages || 1,
    total_results: tmdbData.total_results || items.length,
    results: items,
  };
}

export function shapeSearch(tmdbData, query) {
  const results = Array.isArray(tmdbData.results) ? tmdbData.results : [];
  return {
    query: query || '',
    page: tmdbData.page || 1,
    total_pages: tmdbData.total_pages || 1,
    total_results: tmdbData.total_results || 0,
    results: results
      .filter(
        (x) =>
          (x.media_type === 'movie' || x.media_type === 'tv') &&
          (x.poster_path || x.profile_path),
      )
      .map((x) => pickListItem(x)),
  };
}

export function pickTrailerKey(videos) {
  const list = (videos && videos.results) || [];
  const t =
    list.find((v) => v.site === 'YouTube' && v.type === 'Trailer') ||
    list.find((v) => v.site === 'YouTube');
  return t && t.key ? t.key : null;
}

export function pickCast(credits) {
  return ((credits && credits.cast) || []).slice(0, 12).map((c) => ({
    name: c.name || '',
    character: c.character || '',
    profile_path: c.profile_path || null,
  }));
}

export function pickProviders(providersRaw, region) {
  const r = providersRaw && providersRaw.results ? providersRaw.results[region] : null;
  if (!r) return null;
  const names = (arr) => (arr || []).map((x) => x.provider_name).filter(Boolean);
  return {
    region,
    link: r.link || null,
    flatrate: names(r.flatrate),
    rent: names(r.rent),
    buy: names(r.buy),
  };
}

export function shapeDetail(detail, credits, videos, providersRaw, region, mt) {
  const title = detail.title || detail.name || 'Untitled';
  const vote =
    typeof detail.vote_average === 'number'
      ? detail.vote_average
      : Number(detail.vote_average || 0);
  const out = {
    id: detail.id,
    media_type: mt,
    title,
    name: title,
    overview: detail.overview || '',
    poster_path: detail.poster_path || null,
    backdrop_path: detail.backdrop_path || null,
    vote_average: Number.isFinite(vote) ? vote : 0,
    release_date: detail.release_date || '',
    first_air_date: detail.first_air_date || '',
    genres: ((detail.genres || []).map((g) => g && g.name).filter(Boolean)),
    trailer_key: pickTrailerKey(videos),
    cast: pickCast(credits),
    providers: pickProviders(providersRaw, region),
  };
  if (mt === 'tv') {
    out.seasons = ((detail.seasons || [])
      .filter((s) => s && typeof s.season_number === 'number' && s.season_number >= 0)
      .map((s) => ({
        season_number: s.season_number,
        name: s.name || 'Season ' + s.season_number,
        episode_count: s.episode_count || 0,
      })));
  }
  return out;
}

export function shapeSeason(seasonData, tmdbId, seasonNum) {
  return {
    id: tmdbId,
    season_number: seasonNum,
    name: seasonData.name || 'Season ' + seasonNum,
    episodes: ((seasonData.episodes || []).map((e) => ({
      episode_number: e.episode_number,
      name: e.name || 'Episode',
      overview: e.overview || '',
      runtime: e.runtime || null,
      air_date: e.air_date || '',
      still_path: e.still_path || null,
    }))),
  };
}
