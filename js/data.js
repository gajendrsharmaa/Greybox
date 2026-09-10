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

  /* ---------------- genre collections (via existing /api/tmdb proxy) ---------------- */

  // No dedicated Greybox /api/discover endpoint exists, so genre shelves use
  // the same allowlisted proxy transport as getPerson() above
  // (/api/tmdb/discover/*, secret stays server-side). Shaping mirrors the
  // gbItem fields in js/api.js so cards render identically.
  function shapeRawItem(r, fallbackType) {
    const mt = r.media_type === 'tv' || r.media_type === 'movie' ? r.media_type : (fallbackType || (r.title ? 'movie' : 'tv'));
    const title = r.title || r.name || 'Untitled';
    return {
      id: r.id, media_type: mt, title, name: title,
      overview: r.overview || '',
      poster_path: r.poster_path || null,
      backdrop_path: r.backdrop_path || null,
      vote_average: typeof r.vote_average === 'number' ? r.vote_average : Number(r.vote_average || 0),
      release_date: r.release_date || '',
      first_air_date: r.first_air_date || '',
    };
  }

  function getByGenre(media, genreId, page, sort) {
    const type = media === 'tv' ? 'tv' : 'movie';
    const gid = parseId(genreId);
    if (!gid) return Promise.reject(new Error('Invalid genre id'));
    const mt = type === 'tv' ? 'tv' : 'movie';
    return api().tmdb('discover/' + type, {
      language: 'en-US',
      page: parsePage(page),
      with_genres: String(gid),
      sort_by: String(sort || 'popularity.desc'),
    }).then((d) => {
      const results = Array.isArray(d && d.results) ? d.results : [];
      return {
        page: d.page || 1,
        total_pages: d.total_pages || 1,
        total_results: d.total_results || 0,
        results: results
          .filter((x) => x.poster_path || x.backdrop_path)
          .map((x) => shapeRawItem(x, mt)),
      };
    });
  }

  /* ---------------- homepage configuration (local file, no database) ---------------- */

  const HOME_MOVIE_CATS = ['popular', 'top-rated', 'upcoming', 'now-playing'];
  const HOME_TV_CATS = ['popular', 'top-rated', 'on-the-air', 'airing-today'];

  // Fallback when js/homepage.config.js is missing/blocked: today's homepage.
  function defaultHomeConfig() {
    return { hero: { mode: 'follow-grid' }, sections: [] };
  }

  function normalizeLimit(v) {
    const n = parseInt(String(v == null ? '12' : v), 10);
    if (!isFinite(n) || n < 1) return 12;
    return Math.min(n, 24);
  }

  // Returns a clean section or null (malformed → console.warn, homepage survives).
  function normalizeHomeSection(raw) {
    if (!raw || typeof raw !== 'object') { console.warn('[home] dropping malformed section:', raw); return null; }
    const id = String(raw.id || '').trim();
    const title = String(raw.title || '').trim();
    if (!id || !title) { console.warn('[home] section needs id + title:', raw); return null; }
    const src = raw.source && typeof raw.source === 'object' ? raw.source : null;
    if (!src || typeof src.type !== 'string') { console.warn('[home] section needs source.type:', id); return null; }
    const type = src.type;
    const clean = {
      id, title,
      description: typeof raw.description === 'string' ? raw.description : '',
      visible: raw.visible !== false,
      limit: normalizeLimit(raw.limit),
      source: { type },
    };
    if (type === 'movies') {
      const cat = String(src.category || 'popular').toLowerCase();
      if (HOME_MOVIE_CATS.indexOf(cat) < 0) { console.warn('[home] unknown movies category:', cat); return null; }
      clean.source.category = cat;
    } else if (type === 'tv') {
      const cat = String(src.category || 'popular').toLowerCase();
      if (HOME_TV_CATS.indexOf(cat) < 0) { console.warn('[home] unknown tv category:', cat); return null; }
      clean.source.category = cat;
    } else if (type === 'anime') {
      clean.source.kind = src.kind === 'movies' ? 'movies' : 'series';
    } else if (type === 'trending') {
      // nothing more needed
    } else if (type === 'search') {
      const q = String(src.query || '').trim();
      if (!q) { console.warn('[home] search source needs query:', id); return null; }
      clean.source.query = q;
    } else if (type === 'ids') {
      const items = (Array.isArray(src.items) ? src.items : [])
        .map((it) => {
          if (!it || typeof it !== 'object') return null;
          const mid = parseId(it.id);
          const media = it.media === 'tv' ? 'tv' : (it.media === 'movie' ? 'movie' : null);
          return (mid && media) ? { media, id: mid } : null;
        })
        .filter(Boolean);
      if (!items.length) { console.warn('[home] ids source needs at least one valid { media, id }:', id); return null; }
      clean.source.items = items;
    } else if (type === 'genre') {
      const gid = parseId(src.genreId);
      if (!gid) { console.warn('[home] genre source needs genreId:', id); return null; }
      clean.source.media = src.media === 'tv' ? 'tv' : 'movie';
      clean.source.genreId = gid;
      clean.source.sort = String(src.sort || 'popularity.desc');
    } else {
      console.warn('[home] unknown source type:', type);
      return null;
    }
    return clean;
  }

  function getHomeConfig() {
    const raw = (typeof window.GreyboxHome === 'object' && window.GreyboxHome) || null;
    const hero = (raw && raw.hero && typeof raw.hero === 'object') ? raw.hero : { mode: 'follow-grid' };
    const sections = raw && Array.isArray(raw.sections)
      ? raw.sections.map(normalizeHomeSection).filter(Boolean)
      : [];
    return {
      hero: {
        mode: hero.mode === 'custom' ? 'custom' : 'follow-grid',
        badge: typeof hero.badge === 'string' ? hero.badge : '',
        pick: Math.max(0, parseInt(hero.pick, 10) || 0),
        source: hero.source,
      },
      sections,
    };
  }

  // Resolve ONE normalized section through the Greybox API.
  // Returns Promise<{ section, items }> with limit applied; rejects on
  // unknown source or fetch failure (caller isolates failures per section).
  function resolveHomeSection(section) {
    if (!section || !section.source) return Promise.reject(new Error('Invalid home section'));
    const src = section.source;
    const limit = normalizeLimit(section.limit);
    let p;
    if (src.type === 'trending') p = getTrending(1);
    else if (src.type === 'movies') p = getMovies(src.category, 1);
    else if (src.type === 'tv') p = getTVList(src.category, 1);
    else if (src.type === 'anime') p = getAnime(src.kind, 1);
    else if (src.type === 'search') p = getSearchResults(src.query, 1);
    else if (src.type === 'genre') p = getByGenre(src.media, src.genreId, 1, src.sort);
    else if (src.type === 'ids') {
      p = Promise.allSettled(src.items.map((it) =>
        (it.media === 'tv' ? getTVDetails(it.id) : getMovie(it.id)).then((d) => ({ ...d, media_type: it.media }))
      )).then((settled) => ({
        results: settled.filter((s) => s.status === 'fulfilled').map((s) => s.value)
          .filter((x) => x.poster_path || x.backdrop_path),
      }));
    } else {
      return Promise.reject(new Error('Unknown home source type: ' + src.type));
    }
    return p.then((d) => ({ section, items: (d.results || []).slice(0, limit) }));
  }

  // Resolve every visible section independently: one bad shelf (bad id,
  // backend hiccup) is skipped with a warning and never breaks the page.
  function getHomeSections(sections) {
    const list = (Array.isArray(sections) ? sections : []).filter((s) => s && s.visible !== false);
    return Promise.all(list.map((s) =>
      resolveHomeSection(s).then(
        (r) => (r.items.length ? r : null),
        (err) => { console.warn('[home] skipping section "' + (s.id || '?') + '":', (err && err.message) || err); return null; }
      )
    )).then((resolved) => resolved.filter(Boolean));
  }

  // Custom hero item, or null to keep the grid hero. Never rejects.
  function getHeroItem(heroCfg) {
    if (!heroCfg || heroCfg.mode !== 'custom' || !heroCfg.source) return Promise.resolve(null);
    const pick = Math.max(0, parseInt(heroCfg.pick, 10) || 0);
    const probe = normalizeHomeSection({ id: '__hero__', title: '__hero__', limit: pick + 1, source: heroCfg.source });
    if (!probe) return Promise.resolve(null);
    return resolveHomeSection(probe).then(
      (r) => r.items[pick] || r.items[0] || null,
      () => null
    );
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
    getByGenre,
    defaultHomeConfig,
    normalizeHomeSection,
    getHomeConfig,
    resolveHomeSection,
    getHomeSections,
    getHeroItem,
    getMyList,
    saveMyList,
    toggleMyListItem,
    isInMyList,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = window.GreyboxData;
})();
