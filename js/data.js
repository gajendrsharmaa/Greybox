/* Greybox data layer — page-level fetching + transformation. No DOM, no Router.
 *
 * Pipeline position: Page controller (js/app.js) -> THIS FILE -> Greybox API
 * (js/api.js, same-origin /api/*) -> transformation below -> Page renderer
 * (js/pages.js) -> HTML.
 *
 * A page requests e.g. getMovie(id) and renders the result without knowing
 * whether the bytes came from the Cloudflare/Vercel Functions backend or the
 * static-preview fallback inside js/api.js — that decision stays in api.js.
 *
 * My List (localStorage, no database) also lives here so renderers stay pure:
 * components take an `isInList` flag instead of touching storage.
 */
(function () {
  'use strict';

  function api() {
    if (!window.API || !window.API.gb) {
      throw new Error('Greybox API not loaded. Check script order in index.html (api.js before data.js).');
    }
    return window.API;
  }

  function parsePage(v) {
    const n = parseInt(String(v == null ? '1' : v), 10);
    if (!isFinite(n) || n < 1) return 1;
    return Math.min(n, 500);
  }

  function parseId(v) {
    const s = String(v == null ? '' : v).trim();
    if (!/^\d+$/.test(s)) return 0;
    const n = parseInt(s, 10);
    return n > 0 ? n : 0;
  }

  function getRegion() { return api().getRegion(); }

  // Backend already shapes lists; keep the single UI filter in ONE place
  // (previously tripled across home/movie/tv + search + suggestions).
  function withImages(list, fallbackType) {
    const results = Array.isArray(list && list.results) ? list.results : [];
    const items = results.filter((x) => x.poster_path || x.backdrop_path);
    return { page: (list && list.page) || 1, total_pages: (list && list.total_pages) || 1, total_results: (list && list.total_results) || 0, results: items, _fallbackType: fallbackType };
  }

  /* ---------------- list fetchers (Greybox kebab-case categories) ---------------- */

  function getTrending(page) {
    return api().gb.trending(parsePage(page)).then((d) => withImages(d));
  }

  function getMovies(category, page) {
    return api().gb.movies(category, parsePage(page)).then((d) => withImages(d, 'movie'));
  }

  function getPopularMovies(page) { return getMovies('popular', page); }
  function getTopRatedMovies(page) { return getMovies('top-rated', page); }
  function getUpcomingMovies(page) { return getMovies('upcoming', page); }
  function getNowPlayingMovies(page) { return getMovies('now-playing', page); }

  function getTVList(category, page) {
    return api().gb.tvList(category, parsePage(page)).then((d) => withImages(d, 'tv'));
  }

  function getPopularTV(page) { return getTVList('popular', page); }
  function getTopRatedTV(page) { return getTVList('top-rated', page); }

  function getAnime(kind, page) {
    const k = kind === 'movies' ? 'movies' : 'series';
    return api().gb.anime(k, parsePage(page)).then((d) => withImages(d, k === 'movies' ? 'movie' : 'tv'));
  }

  function getAnimeSeries(page) { return getAnime('series', page); }
  function getAnimeMovies(page) { return getAnime('movies', page); }

  // Home's four tabs in ONE place (previously an if/else chain in load()).
  function getHomeTab(tab, page) {
    const p = parsePage(page);
    if (tab === 'popular-movie') return getPopularMovies(p);
    if (tab === 'popular-tv') return getPopularTV(p);
    if (tab === 'top') return getTopRatedMovies(p);
    return getTrending(p);
  }

  // Single dispatcher for every list route — controller passes its
  // (mode, subTab, page) triple; internal snake_case tabs convert here so
  // renderers never think about kebab vs snake.
  function getList(mode, subTab, page) {
    const p = parsePage(page);
    if (mode === 'home') return getHomeTab(subTab, p);
    if (mode === 'movie') return getMovies(String(subTab || 'popular').split('_').join('-'), p);
    if (mode === 'tv') return getTVList(String(subTab || 'popular').split('_').join('-'), p);
    if (mode === 'anime') {
      return subTab === 'movie-anime' ? getAnimeMovies(p) : getAnimeSeries(p);
    }
    return Promise.reject(new Error('Unknown list: ' + mode));
  }

  /* ---------------- detail fetchers ---------------- */

  function assertDetail(d, mt, id) {
    if (!d || !d.id) throw new Error('Greybox API returned an error for ' + mt + '/' + id);
    return d;
  }

  function getMovie(id, region) {
    const clean = parseId(id);
    if (!clean) return Promise.reject(new Error('Invalid movie id'));
    return api().gb.movie(clean, region || getRegion()).then((d) => assertDetail(d, 'movie', clean));
  }

  function getTVDetails(id, region) {
    const clean = parseId(id);
    if (!clean) return Promise.reject(new Error('Invalid tv id'));
    return api().gb.show(clean, region || getRegion()).then((d) => assertDetail(d, 'tv', clean));
  }

  // Alias — some callers think "show", some think "tv details".
  function getShow(id, region) { return getTVDetails(id, region); }

  function getSeason(tmdbId, seasonNum) {
    const id = parseId(tmdbId);
    const n = parseId(seasonNum);
    if (!id || !n) return Promise.reject(new Error('Invalid tv id or season number'));
    return api().gb.season(id, n);
  }

  // Person via the EXISTING /api/tmdb proxy transport (no new backend).
  // Transformation (movie+tv only, popularity-sorted, top 12) lives here so
  // the person renderer receives ready-to-render data.
  function getPerson(id) {
    const clean = parseId(id);
    if (!clean) return Promise.reject(new Error('Invalid person id'));
    return Promise.all([
      api().tmdb('person/' + clean, { language: 'en-US' }),
      api().tmdb('person/' + clean + '/combined_credits', { language: 'en-US' }).catch(() => ({ cast: [] })),
    ]).then(([person, credits]) => {
      if (!person || !person.id) throw new Error('Greybox API returned an error for person/' + clean);
      const knownFor = ((credits && credits.cast) || [])
        .filter((x) => x && (x.media_type === 'movie' || x.media_type === 'tv'))
        .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
        .slice(0, 12);
      return { person, knownFor };
    });
  }

  /* ---------------- search ---------------- */

  function getSearchResults(query, page) {
    const q = String(query || '').trim();
    if (!q) return Promise.resolve({ query: '', page: 1, total_pages: 1, total_results: 0, results: [] });
    return api().gb.search(q, parsePage(page)).then((d) => ({
      query: d.query != null ? d.query : q,
      page: d.page || 1,
      total_pages: d.total_pages || 1,
      total_results: d.total_results || 0,
      results: ((d.results || []).filter((x) => x.media_type === 'movie' || x.media_type === 'tv')),
    }));
  }

  // Header dropdown reuses the page query (no second filter implementation).
  function getSuggestions(query, limit) {
    const n = limit > 0 ? limit : 8;
    return getSearchResults(query, 1).then((d) => ({
      query: d.query,
      results: (d.results || [])
        .filter((x) => (x.media_type === 'movie' || x.media_type === 'tv') && (x.poster_path || x.profile_path))
        .slice(0, n),
    }));
  }

  /* ---------------- My List (localStorage, no database) ---------------- */

  const LS_KEY = 'sb_mylist';

  function getMyList() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); }
    catch { return []; }
  }

  function saveMyList(v) {
    localStorage.setItem(LS_KEY, JSON.stringify(v));
    try { window.dispatchEvent(new CustomEvent('greybox:mylist', { detail: { count: v.length } })); } catch { /* noop */ }
  }

  function toggleMyListItem(item) {
    const l = getMyList();
    const i = l.findIndex((x) => x.id === item.id && x.media_type === item.media_type);
    if (i >= 0) l.splice(i, 1); else l.push(item);
    saveMyList(l);
    return i < 0;
  }

  function isInMyList(id, mt) {
    return getMyList().some((x) => x.id === id && x.media_type === mt);
  }

  window.GreyboxData = {
    parsePage,
    parseId,
    getRegion,
    getTrending,
    getMovies,
    getPopularMovies,
    getTopRatedMovies,
    getUpcomingMovies,
    getNowPlayingMovies,
    getTVList,
    getPopularTV,
    getTopRatedTV,
    getAnime,
    getAnimeSeries,
    getAnimeMovies,
    getHomeTab,
    getList,
    getMovie,
    getTVDetails,
    getShow,
    getSeason,
    getPerson,
    getSearchResults,
    getSuggestions,
    getMyList,
    saveMyList,
    toggleMyListItem,
    isInMyList,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = window.GreyboxData;
})();
