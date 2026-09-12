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

  /* ---------------- Greybox-owned config: D1 first, local files as fallback ---------------- */

  // Boot preload of Greybox-owned config from D1 (via GET /api/config/*,
  // served server-side by functions/api/config/* — the browser never talks
  // to D1 directly). Never rejects: any failure (static preview, Vercel
  // without D1, DB not yet bound) leaves that source null and the getters
  // below fall back to the local js/*.config.js files.
  let _remoteConfig = null;
  let _remotePromise = null;

  function fetchJsonTimeout(url, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } })
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .finally(() => clearTimeout(t));
  }

  function preloadGreyboxConfig() {
    if (_remotePromise) return _remotePromise;
    const load = (url) => fetchJsonTimeout(url, 8000).catch(() => null);
    _remotePromise = Promise.all([
      load('/api/config/home'),
      load('/api/config/collections'),
      load('/api/config/overrides'),
    ]).then(([home, collections, overrides]) => {
      _remoteConfig = {
        home: (home && typeof home === 'object' && !Array.isArray(home)) ? home : null,
        collections: Array.isArray(collections) ? collections : null,
        overrides: Array.isArray(overrides) ? overrides : null,
      };
      return _remoteConfig;
    });
    return _remotePromise;
  }

  // Backend already shapes lists; keep the single UI filter in ONE place
  // (previously tripled across home/movie/tv + search + suggestions).
  function withImages(list, fallbackType) {
    const results = Array.isArray(list && list.results) ? list.results : [];
    // Overrides first so a Greybox poster_path can rescue an imageless item.
    const items = results
      .map((x) => applyOverrides(x, fallbackType))
      .filter((x) => x && (x.poster_path || x.backdrop_path));
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
    return api().gb.movie(clean, region || getRegion()).then((d) => applyOverrides(assertDetail(d, 'movie', clean), 'movie'));
  }

  function getTVDetails(id, region) {
    const clean = parseId(id);
    if (!clean) return Promise.reject(new Error('Invalid tv id'));
    return api().gb.show(clean, region || getRegion()).then((d) => applyOverrides(assertDetail(d, 'tv', clean), 'tv'));
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
      results: ((d.results || [])
        .filter((x) => x.media_type === 'movie' || x.media_type === 'tv')
        .map((x) => applyOverrides(x))),
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

  // General TMDB discover through the allowlisted proxy transport
  // (/api/tmdb/discover/*, secret stays server-side). opts:
  // { media: 'movie'|'tv', genre: <id>, year: <yyyy>, sort: <sort_by>, page }.
  // Every filter is optional. Shaping mirrors gbItem so cards render identically.
  function getDiscover(opts) {
    const o = (opts && typeof opts === 'object') ? opts : {};
    const type = o.media === 'tv' ? 'tv' : 'movie';
    const params = { language: 'en-US', page: parsePage(o.page), sort_by: String(o.sort || 'popularity.desc') };
    if (o.genre != null && String(o.genre).trim() !== '') {
      const gid = parseId(o.genre);
      if (!gid) return Promise.reject(new Error('Invalid genre id'));
      params.with_genres = String(gid);
    }
    if (o.year != null && String(o.year).trim() !== '') {
      if (!/^\d{4}$/.test(String(o.year).trim())) return Promise.reject(new Error('Invalid year'));
      const y = parseInt(String(o.year).trim(), 10);
      if (y < 1900 || y > 2100) return Promise.reject(new Error('Invalid year'));
      params[type === 'tv' ? 'first_air_date_year' : 'primary_release_year'] = String(y);
    }
    const mt = type === 'tv' ? 'tv' : 'movie';
    return api().tmdb('discover/' + type, params).then((d) => {
      const results = Array.isArray(d && d.results) ? d.results : [];
      return {
        page: d.page || 1,
        total_pages: d.total_pages || 1,
        total_results: d.total_results || 0,
        results: results
          .map((x) => applyOverrides(shapeRawItem(x, mt), mt))
          .filter((x) => x && (x.poster_path || x.backdrop_path)),
      };
    });
  }

  function getByGenre(media, genreId, page, sort) {
    return getDiscover({ media, genre: genreId, page, sort });
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
    } else if (type === 'collection') {
      // Expandable shelf: references an existing collection slug. Preview and
      // /collection/:slug share the SAME rule via resolveCollection — no
      // second content system. Slug only; limit stays on the section.
      const slug = normalizeSlug(src.slug);
      if (!slug) { console.warn('[home] collection source needs slug:', id); return null; }
      clean.source.slug = slug;
    } else {
      console.warn('[home] unknown source type:', type);
      return null;
    }
    return clean;
  }

  function getHomeConfig() {
    const raw = (_remoteConfig && _remoteConfig.home)
      || ((typeof window.GreyboxHome === 'object' && window.GreyboxHome) || null);
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

  // Ordered hand-picked IDs through the Greybox API. Config order is
  // preserved exactly (TMDB never re-sorts); failed IDs are dropped.
  // Shared by homepage `ids` shelves and Greybox collections.
  function resolveIdItems(items) {
    const list = Array.isArray(items) ? items : [];
    return Promise.allSettled(list.map((it) =>
      (it.media === 'tv' ? getTVDetails(it.id) : getMovie(it.id)).then((d) => ({ ...d, media_type: it.media }))
    )).then((settled) => settled.filter((s) => s.status === 'fulfilled').map((s) => s.value)
      .filter((x) => x.poster_path || x.backdrop_path));
  }

  // Resolve ONE normalized section through the Greybox API.
  // Returns Promise<{ section, items, collection? }> with limit applied;
  // rejects on unknown source or fetch failure (caller isolates failures
  // per section). `collection` sources delegate to resolveCollection — the
  // SAME rule the /collection/:slug page uses — then slice to the section
  // limit for the preview. Unknown/hidden slugs reject so the shelf is
  // skipped instead of rendering a broken View All link.
  function resolveHomeSection(section) {
    if (!section || !section.source) return Promise.reject(new Error('Invalid home section'));
    const src = section.source;
    const limit = normalizeLimit(section.limit);
    if (src.type === 'collection') {
      const slug = normalizeSlug(src.slug);
      if (!slug) return Promise.reject(new Error('Invalid collection slug'));
      return resolveCollection(slug).then(({ collection, items }) => ({
        section, items: (items || []).slice(0, limit), collection,
      }));
    }
    let p;
    if (src.type === 'trending') p = getTrending(1);
    else if (src.type === 'movies') p = getMovies(src.category, 1);
    else if (src.type === 'tv') p = getTVList(src.category, 1);
    else if (src.type === 'anime') p = getAnime(src.kind, 1);
    else if (src.type === 'search') p = getSearchResults(src.query, 1);
    else if (src.type === 'genre') p = getByGenre(src.media, src.genreId, 1, src.sort);
    else if (src.type === 'ids') {
      p = resolveIdItems(src.items).then((results) => ({ results }));
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

  /* ---------------- Greybox collections (local config, no database) ---------------- */

  const COLLECTION_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  function normalizeSlug(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s || s.length > 64 || !COLLECTION_SLUG.test(s)) return '';
    return s;
  }

  // One collection entry: { media, id }. Bare numbers (and { id } without
  // media) default to movie so `items: [550, 157336]` just works.
  function normalizeCollectionItem(it) {
    if (it == null) return null;
    if (typeof it === 'number' || typeof it === 'string') {
      const bare = parseId(it);
      return bare ? { media: 'movie', id: bare } : null;
    }
    if (typeof it !== 'object') return null;
    const mid = parseId(it.id);
    if (!mid) return null;
    return { media: it.media === 'tv' ? 'tv' : 'movie', id: mid };
  }

  // Returns a clean collection source or null (malformed → console.warn).
  // Dynamic types fetch current TMDB matches at render time; only `custom`
  // carries hand-picked IDs. Greybox owns title/filters/sort/limit/visibility;
  // TMDB only supplies the matching titles, posters and metadata.
  function normalizeCollectionSource(src, slug) {
    if (!src || typeof src !== 'object' || typeof src.type !== 'string') {
      console.warn('[collections] collection needs source.type:', slug);
      return null;
    }
    const type = src.type;
    const clean = { type };
    const mediaOr = (def) => (src.media === 'tv' ? 'tv' : (src.media === 'movie' ? 'movie' : def));
    if (type === 'trending') {
      clean.media = src.media === 'movie' ? 'movie' : (src.media === 'tv' ? 'tv' : 'all');
    } else if (type === 'popular' || type === 'top-rated') {
      clean.media = src.media === 'tv' ? 'tv' : 'movie';
    } else if (type === 'now-playing') {
      if (src.media != null && src.media !== 'movie') { console.warn('[collections] now-playing is movies only:', slug); return null; }
      clean.media = 'movie';
    } else if (type === 'discover') {
      clean.media = mediaOr('movie');
      if (src.genre != null && String(src.genre).trim() !== '') {
        if (!parseId(src.genre)) { console.warn('[collections] discover needs a valid genre id:', slug); return null; }
        clean.genre = parseId(src.genre);
      }
      if (src.year != null && String(src.year).trim() !== '') {
        if (!/^\d{4}$/.test(String(src.year).trim())) { console.warn('[collections] discover needs a valid year:', slug); return null; }
        const y = parseInt(String(src.year).trim(), 10);
        if (y < 1900 || y > 2100) { console.warn('[collections] discover needs a valid year:', slug); return null; }
        clean.year = y;
      }
      clean.sort = (typeof src.sort === 'string' && src.sort.trim()) ? src.sort.trim() : 'popularity.desc';
    } else if (type === 'genre') {
      // Genre shelves: single-media (movie/tv + genreId) or combined
      // Movies + TV (media 'both' + genre { name, movie_id, tv_id }).
      // TMDB keeps separate movie and TV genre lists with different IDs,
      // so each side carries its own ID — never reuse one ID for both.
      // Single-media shape stays exactly as before for backwards compat.
      if (src.media === 'both') {
        const g = (src.genre && typeof src.genre === 'object' && !Array.isArray(src.genre)) ? src.genre : null;
        if (!g) { console.warn('[collections] genre both needs genre { name, movie_id, tv_id }:', slug); return null; }
        const mid = parseId(g.movie_id);
        const tid = parseId(g.tv_id);
        if (!mid || !tid) { console.warn('[collections] genre both needs valid movie_id + tv_id:', slug); return null; }
        const gname = (typeof g.name === 'string' && g.name.trim()) ? g.name.trim().slice(0, 64) : '';
        clean.media = 'both';
        clean.genre = { name: gname || 'Genre', movie_id: mid, tv_id: tid };
        clean.sort = (typeof src.sort === 'string' && src.sort.trim()) ? src.sort.trim() : 'popularity.desc';
      } else {
        if (!parseId(src.genreId)) { console.warn('[collections] genre source needs genreId:', slug); return null; }
        clean.media = mediaOr('movie');
        clean.genreId = parseId(src.genreId);
        clean.sort = (typeof src.sort === 'string' && src.sort.trim()) ? src.sort.trim() : 'popularity.desc';
      }
    } else if (type === 'year') {
      if (!/^\d{4}$/.test(String(src.year == null ? '' : src.year).trim())) { console.warn('[collections] year source needs year:', slug); return null; }
      const y = parseInt(String(src.year).trim(), 10);
      if (y < 1900 || y > 2100) { console.warn('[collections] year source needs year:', slug); return null; }
      clean.media = mediaOr('movie');
      clean.year = y;
      clean.sort = (typeof src.sort === 'string' && src.sort.trim()) ? src.sort.trim() : 'popularity.desc';
    } else if (type === 'search') {
      const q = String(src.query || '').trim();
      if (!q) { console.warn('[collections] search source needs query:', slug); return null; }
      clean.query = q;
    } else if (type === 'custom') {
      const items = (Array.isArray(src.items) ? src.items : []).map(normalizeCollectionItem).filter(Boolean);
      if (!items.length) { console.warn('[collections] custom source needs at least one valid item:', slug); return null; }
      clean.items = items;
    } else {
      console.warn('[collections] unknown source type:', type);
      return null;
    }
    return clean;
  }

  function normalizeCollectionLimit(v) {
    const n = parseInt(String(v == null ? '20' : v), 10);
    if (!isFinite(n) || n < 1) return 20;
    return Math.min(n, 60);
  }

  // Manual-override entries: { media, id } objects, bare numbers (= movie),
  // or bare ids for exclude (match any media).
  function normalizeOverride(it, forExclude) {
    if (it == null) return null;
    if (typeof it === 'number' || typeof it === 'string') {
      const id = parseId(it);
      if (!id) return null;
      return forExclude ? { id } : { media: 'movie', id };
    }
    if (typeof it !== 'object') return null;
    const id = parseId(it.id);
    if (!id) return null;
    if (forExclude && it.media !== 'tv' && it.media !== 'movie') return { id };
    return { media: it.media === 'tv' ? 'tv' : 'movie', id };
  }

  // Returns a clean collection or null (malformed → console.warn, page survives).
  function normalizeCollection(raw) {
    if (!raw || typeof raw !== 'object') { console.warn('[collections] dropping malformed collection:', raw); return null; }
    const slug = normalizeSlug(raw.slug);
    const title = String(raw.title || '').trim();
    if (!slug || !title) { console.warn('[collections] collection needs slug + title:', raw); return null; }
    const source = normalizeCollectionSource(raw.source, slug);
    if (!source) return null;
    const pin = (Array.isArray(raw.pin) ? raw.pin : []).map((it) => normalizeOverride(it, false)).filter(Boolean);
    const exclude = (Array.isArray(raw.exclude) ? raw.exclude : []).map((it) => normalizeOverride(it, true)).filter(Boolean);
    const cover = (typeof raw.cover === 'string' && raw.cover.trim())
      ? raw.cover.trim()
      : ((typeof raw.hero === 'string' && raw.hero.trim()) ? raw.hero.trim() : '');
    const meta = (raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta)) ? raw.meta : null;
    return {
      slug, title,
      description: typeof raw.description === 'string' ? raw.description : '',
      cover,
      visible: raw.visible !== false,
      limit: normalizeCollectionLimit(raw.limit),
      source, pin, exclude,
      meta,
    };
  }

  // All valid collections in config order; duplicate slugs keep the first.
  // Source: D1 once preloaded, else the local js/collections.config.js.
  function getCollections() {
    const raw = (_remoteConfig && _remoteConfig.collections) || window.GreyboxCollections;
    const list = Array.isArray(raw) ? raw : [];
    const seen = new Set();
    const out = [];
    for (const r of list) {
      const c = normalizeCollection(r);
      if (!c) continue;
      if (seen.has(c.slug)) { console.warn('[collections] duplicate slug ignored:', c.slug); continue; }
      seen.add(c.slug);
      out.push(c);
    }
    return out;
  }

  // Visible collection by slug, or null (unknown, malformed, or hidden —
  // hidden collections render as Not found everywhere, URL included).
  function getCollection(slug, opts) {
    const s = normalizeSlug(slug);
    if (!s) return null;
    const found = getCollections().find((c) => c.slug === s) || null;
    if (found && found.visible === false && !(opts && opts.includeHidden)) return null;
    return found;
  }

  // Fetch list pages until `limit` items are gathered, results run out, or
  // the page cap is hit. Dynamic collections with limit > 20 (one TMDB page)
  // transparently read further pages through the same Greybox fetchers.
  function fetchPaged(fetchPage, limit) {
    const out = [];
    let page = 1, total = 1;
    const next = () => {
      if (out.length >= limit || page > total || page > 5) return Promise.resolve(out.slice(0, limit));
      return fetchPage(page).then((d) => {
        total = (d && d.total_pages) || 1;
        out.push(...((d && d.results) || []));
        page++;
        return next();
      });
    };
    return next();
  }

  function itemKey(media, id) { return media + ':' + id; }

  function isExcluded(it, exclude) {
    return exclude.some((x) => (x.media ? (x.media === it.media && x.id === it.id) : (x.id === it.id)));
  }

  // Resolve ONE dynamic source through the Greybox API. Returns the raw
  // ordered item list capped at `limit` (extra pages are fetched only while
  // the cap is unfilled, so limit: 24 reads pages 1+2 and stops).
  function resolveCollectionSource(src, limit) {
    if (!src || !src.type) return Promise.reject(new Error('Invalid collection source'));
    const cap = normalizeCollectionLimit(limit == null ? 60 : limit);
    if (src.type === 'trending') {
      const media = src.media || 'all';
      return fetchPaged((p) => getTrending(p).then((d) => ({
        page: d.page, total_pages: d.total_pages,
        results: media === 'all'
          ? (d.results || [])
          : (d.results || []).filter((x) => (x.media_type || (x.title ? 'movie' : 'tv')) === media),
      })), cap).then((results) => ({ results }));
    }
    if (src.type === 'popular') {
      return fetchPaged((p) => (src.media === 'tv' ? getTVList('popular', p) : getMovies('popular', p)), cap)
        .then((results) => ({ results }));
    }
    if (src.type === 'top-rated') {
      return fetchPaged((p) => (src.media === 'tv' ? getTVList('top-rated', p) : getMovies('top-rated', p)), cap)
        .then((results) => ({ results }));
    }
    if (src.type === 'now-playing') {
      return fetchPaged((p) => getMovies('now-playing', p), cap).then((results) => ({ results }));
    }
    if (src.type === 'discover') {
      const o = { media: src.media, page: 1, sort: src.sort };
      if (src.genre != null) o.genre = src.genre;
      if (src.year != null) o.year = src.year;
      return fetchPaged((p) => getDiscover({ ...o, page: p }), cap).then((results) => ({ results }));
    }
    if (src.type === 'genre') {
      // Movies + TV: fetch /discover/movie (movie genre) and /discover/tv
      // (TV genre) separately through the same Greybox fetchers, then
      // interleave round-robin while preserving each item's media_type so
      // movie cards still link to /movie/:id and TV cards to /tv/:id.
      if (src.media === 'both' && src.genre && typeof src.genre === 'object') {
        const mid = parseId(src.genre.movie_id);
        const tid = parseId(src.genre.tv_id);
        if (!mid || !tid) return Promise.reject(new Error('Invalid genre both source'));
        const sort = src.sort || 'popularity.desc';
        return Promise.all([
          fetchPaged((p) => getByGenre('movie', mid, p, sort), cap),
          fetchPaged((p) => getByGenre('tv', tid, p, sort), cap),
        ]).then(([movies, shows]) => {
          const a = Array.isArray(movies) ? movies : [];
          const b = Array.isArray(shows) ? shows : [];
          const out = [];
          const n = Math.max(a.length, b.length);
          for (let i = 0; i < n; i++) {
            if (a[i]) out.push({ ...a[i], media_type: 'movie' });
            if (b[i]) out.push({ ...b[i], media_type: 'tv' });
            if (out.length >= cap) break;
          }
          return { results: out.slice(0, cap) };
        });
      }
      return fetchPaged((p) => getByGenre(src.media, src.genreId, p, src.sort), cap)
        .then((results) => ({ results }));
    }
    if (src.type === 'year') {
      return fetchPaged((p) => getDiscover({ media: src.media, year: src.year, sort: src.sort, page: p }), cap)
        .then((results) => ({ results }));
    }
    if (src.type === 'search') {
      return fetchPaged((p) => getSearchResults(src.query, p), cap).then((results) => ({ results }));
    }
    if (src.type === 'custom') {
      return resolveIdItems(src.items).then((results) => ({ results }));
    }
    return Promise.reject(new Error('Unknown collection source type: ' + src.type));
  }

  // Fetch ONE page of a dynamic collection source through the same Greybox
  // fetchers as resolveCollectionSource above — same endpoints, same shaping,
  // same media handling (including genre-both round-robin interleave), just
  // without the fetchPaged multi-page loop. Returns { results, page,
  // total_pages } straight from the (single) TMDB page.
  function fetchCollectionBasePage(src, page) {
    const p = parsePage(page);
    if (!src || !src.type) return Promise.reject(new Error('Invalid collection source'));
    if (src.type === 'trending') {
      const media = src.media || 'all';
      return getTrending(p).then((d) => ({
        page: d.page, total_pages: d.total_pages,
        results: media === 'all'
          ? (d.results || [])
          : (d.results || []).filter((x) => (x.media_type || (x.title ? 'movie' : 'tv')) === media),
      }));
    }
    if (src.type === 'popular') {
      return src.media === 'tv' ? getTVList('popular', p) : getMovies('popular', p);
    }
    if (src.type === 'top-rated') {
      return src.media === 'tv' ? getTVList('top-rated', p) : getMovies('top-rated', p);
    }
    if (src.type === 'now-playing') {
      return getMovies('now-playing', p);
    }
    if (src.type === 'discover') {
      const o = { media: src.media, page: p, sort: src.sort };
      if (src.genre != null) o.genre = src.genre;
      if (src.year != null) o.year = src.year;
      return getDiscover(o);
    }
    if (src.type === 'genre') {
      if (src.media === 'both' && src.genre && typeof src.genre === 'object') {
        const mid = parseId(src.genre.movie_id);
        const tid = parseId(src.genre.tv_id);
        if (!mid || !tid) return Promise.reject(new Error('Invalid genre both source'));
        const sort = src.sort || 'popularity.desc';
        return Promise.all([
          getByGenre('movie', mid, p, sort),
          getByGenre('tv', tid, p, sort),
        ]).then(([movies, shows]) => {
          const a = (movies && movies.results) || [];
          const b = (shows && shows.results) || [];
          const out = [];
          const n = Math.max(a.length, b.length);
          for (let i = 0; i < n; i++) {
            if (a[i]) out.push({ ...a[i], media_type: 'movie' });
            if (b[i]) out.push({ ...b[i], media_type: 'tv' });
          }
          return {
            page: p,
            total_pages: Math.max((movies && movies.total_pages) || 1, (shows && shows.total_pages) || 1),
            results: out,
          };
        });
      }
      return getByGenre(src.media, src.genreId, p, src.sort);
    }
    if (src.type === 'year') {
      return getDiscover({ media: src.media, year: src.year, sort: src.sort, page: p });
    }
    if (src.type === 'search') {
      return getSearchResults(src.query, p);
    }
    return Promise.reject(new Error('Unknown collection source type: ' + src.type));
  }

  // Resolve ONE page of a collection (Phase 5.4 progressive loading).
  // Same Greybox rules as resolveCollection (pins lead on page 1 only,
  // excludes drop out, media_type preserved) but exactly one TMDB page per
  // call — the controller appends and dedupes across pages itself.
  // Custom (hand-picked ID) collections are finite: page 1 carries everything.
  // Accepts a slug or a normalized collection. Rejects when not found.
  // Resolves { collection, items, page, totalPages }.
  function resolveCollectionPage(slugOrCollection, page) {
    const c = (slugOrCollection && typeof slugOrCollection === 'object')
      ? slugOrCollection
      : getCollection(slugOrCollection);
    if (!c || !c.source) return Promise.reject(new Error('Collection not found'));
    const p = parsePage(page);
    if (c.source.type === 'custom') {
      if (p > 1) return Promise.resolve({ collection: c, items: [], page: p, totalPages: 1 });
      return resolveIdItems(c.source.items).then((results) => ({ collection: c, items: results, page: 1, totalPages: 1 }));
    }
    const pins = (p === 1 && c.pin && c.pin.length)
      ? resolveIdItems(c.pin)
      : Promise.resolve([]);
    return Promise.all([pins, fetchCollectionBasePage(c.source, p)]).then(([pinned, d]) => {
      const seen = new Set(pinned.map((x) => itemKey(x.media_type || (x.title ? 'movie' : 'tv'), x.id)));
      const items = [...pinned];
      for (const x of (d.results || [])) {
        const mt = x.media_type || (x.title ? 'movie' : 'tv');
        if (seen.has(itemKey(mt, x.id))) continue;
        if (isExcluded({ media: mt, id: x.id }, c.exclude || [])) continue;
        seen.add(itemKey(mt, x.id));
        items.push({ ...x, media_type: mt });
      }
      return { collection: c, items, page: (d && d.page) || p, totalPages: (d && d.total_pages) || 1 };
    });
  }

  // Resolve a collection: Greybox rules in, current TMDB matches out.
  // Pins resolve via details and lead; dynamic/custom base follows in source
  // order; excludes drop out; the total is capped at the collection limit.
  // Accepts a slug or a normalized collection. Rejects when not found.
  // (Unchanged by Phase 5.4 — homepage shelves/previews still use this
  // capped multi-page resolve; collection pages use resolveCollectionPage.)
  function resolveCollection(slugOrCollection) {
    const c = (slugOrCollection && typeof slugOrCollection === 'object')
      ? slugOrCollection
      : getCollection(slugOrCollection);
    if (!c || !c.source) return Promise.reject(new Error('Collection not found'));
    const limit = normalizeCollectionLimit(c.limit);
    // Custom lists are hand-sized: resolve every listed ID (failures drop),
    // then cap — a dead ID never eats a display slot. Dynamic sources page
    // only until the cap is filled.
    const base = c.source.type === 'custom'
      ? resolveIdItems(c.source.items).then((results) => ({ results }))
      : resolveCollectionSource(c.source, limit);
    const pins = (c.pin && c.pin.length)
      ? resolveIdItems(c.pin)
      : Promise.resolve([]);
    return Promise.all([pins, base]).then(([pinned, d]) => {
      const seen = new Set(pinned.map((x) => itemKey(x.media_type || (x.title ? 'movie' : 'tv'), x.id)));
      const items = [...pinned];
      for (const x of (d.results || [])) {
        const mt = x.media_type || (x.title ? 'movie' : 'tv');
        if (seen.has(itemKey(mt, x.id))) continue;
        if (isExcluded({ media: mt, id: x.id }, c.exclude || [])) continue;
        seen.add(itemKey(mt, x.id));
        items.push({ ...x, media_type: mt });
        if (items.length >= limit) break;
      }
      return { collection: c, items: items.slice(0, limit) };
    });
  }

  /* ---------------- Greybox metadata overrides (local config, no database) ---------------- */

  // Only these keys are ever read from js/overrides.config.js — a complete
  // TMDB response pasted there would be ignored except for these fields.
  // `description` is Greybox's name for TMDB `overview`.
  const OVERRIDABLE_FIELDS = ['title', 'name', 'overview', 'description', 'poster_path', 'backdrop_path', 'vote_average', 'release_date', 'first_air_date', 'featured', 'custom_badge'];

  // Normalized override map, memoized on the config array identity so list
  // rendering (dozens of lookups) doesn't re-normalize or re-warn per item.
  let _overrideCacheRef = null;
  let _overrideCacheMap = null;

  function getOverrideConfig() {
    if (_remoteConfig && _remoteConfig.overrides) return _remoteConfig.overrides;
    const raw = window.GreyboxOverrides;
    return Array.isArray(raw) ? raw : [];
  }

  function normalizeMetadataOverride(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const id = parseId(raw.tmdb_id != null ? raw.tmdb_id : raw.id);
    const media = raw.media === 'tv' ? 'tv' : (raw.media === 'movie' ? 'movie' : null);
    if (!id || !media) { console.warn('[overrides] dropping entry without valid tmdb_id + media:', raw); return null; }
    const fields = {};
    for (const k of OVERRIDABLE_FIELDS) {
      let v = raw[k];
      if (v === undefined || v === null) continue;
      if (typeof v === 'string') {
        v = v.trim();
        if (!v) continue;
      }
      if (k === 'vote_average') {
        v = Number(v);
        if (!isFinite(v)) continue;
      }
      fields[k] = v;
    }
    if (Object.keys(fields).length === 0) { console.warn('[overrides] entry has no overridable fields:', media + ':' + id); return null; }
    return { media, id, fields };
  }

  function overrideMap() {
    const raw = getOverrideConfig();
    if (raw !== _overrideCacheRef) {
      const map = new Map();
      for (const entry of raw) {
        const o = normalizeMetadataOverride(entry);
        if (!o) continue;
        const key = o.media + ':' + o.id;
        if (map.has(key)) { console.warn('[overrides] duplicate entry ignored:', key); continue; }
        map.set(key, o);
      }
      _overrideCacheRef = raw;
      _overrideCacheMap = map;
    }
    return _overrideCacheMap;
  }

  // Normalized override list (for tests/inspection).
  function getOverrides() { return [...overrideMap().values()]; }

  // Single override by media + id, or null.
  function getOverride(media, id) {
    const mt = media === 'tv' ? 'tv' : (media === 'movie' ? 'movie' : null);
    const clean = parseId(id);
    if (!mt || !clean) return null;
    return overrideMap().get(mt + ':' + clean) || null;
  }

  // TMDB data in, final resolved object out. Only explicitly overridden fields
  // are replaced; everything else passes through untouched. Returns the
  // ORIGINAL object when nothing matches (no copy, no mutation), so renderers
  // receive the final object without knowing any value's source.
  function applyOverrides(item, fallbackMedia) {
    if (!item || typeof item !== 'object') return item;
    const media = item.media_type === 'tv' || item.media_type === 'movie' ? item.media_type
      : (fallbackMedia === 'tv' || fallbackMedia === 'movie' ? fallbackMedia
      : (item.title ? 'movie' : 'tv'));
    const o = getOverride(media, item.id);
    if (!o) return item;
    const out = { ...item, media_type: media };
    for (const k of Object.keys(o.fields)) {
      if (k === 'description') out.overview = o.fields[k];
      else out[k] = o.fields[k];
    }
    // The codebase treats title/name as aliases (gbItem sets both) — keep them in sync.
    if (out.title != null) out.name = out.title;
    else if (out.name != null) out.title = out.name;
    return out;
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
    preloadGreyboxConfig,
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
    getDiscover,
    normalizeCollectionSource,
    defaultHomeConfig,
    normalizeHomeSection,
    getHomeConfig,
    resolveHomeSection,
    getHomeSections,
    getHeroItem,
    normalizeSlug,
    normalizeCollection,
    getCollections,
    getCollection,
    resolveCollection,
    resolveCollectionPage,
    OVERRIDABLE_FIELDS,
    getOverrides,
    getOverride,
    applyOverrides,
    getMyList,
    saveMyList,
    toggleMyListItem,
    isInMyList,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = window.GreyboxData;
})();
