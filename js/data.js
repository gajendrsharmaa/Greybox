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
      load('/api/config/tags'),
      load('/api/config/blocked'),
      load('/api/config/navigation'),
      load('/api/config/detail-pages'),
      load('/api/config/playback'),
    ]).then(([home, collections, overrides, tags, blocked, navigation, detailPages, playback]) => {
      _remoteConfig = {
        home: (home && typeof home === 'object' && !Array.isArray(home)) ? home : null,
        collections: Array.isArray(collections) ? collections : null,
        overrides: Array.isArray(overrides) ? overrides : null,
        tags: Array.isArray(tags) ? tags : null,
        blocked: Array.isArray(blocked) ? blocked : null,
        navigation: (navigation && typeof navigation === 'object' && !Array.isArray(navigation)) ? navigation : null,
        detailPages: (detailPages && typeof detailPages === 'object' && !Array.isArray(detailPages)) ? detailPages : null,
        playback: (playback && typeof playback === 'object' && !Array.isArray(playback)) ? playback : null,
      };
      return _remoteConfig;
    });
    return _remotePromise;
  }

  // Backend already shapes lists; keep the single UI filter in ONE place
  // (previously tripled across home/movie/tv + search + suggestions).
  // Blocked titles drop out here too (central filter — see isBlockedContent),
  // so every list surface (home, movies, TV, anime, collections, search,
  // suggestions) enforces the blocklist without per-page checks.
  function withImages(list, fallbackType) {
    const results = Array.isArray(list && list.results) ? list.results : [];
    // Overrides first so a Greybox poster_path can rescue an imageless item.
    const items = results
      .map((x) => applyOverrides(x, fallbackType))
      .filter((x) => x && !isBlockedItem(x, fallbackType))
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
    // Blocked titles refuse normal rendering even by direct TMDB ID: the
    // pre-check skips the fetch entirely, the post-check covers a blocklist
    // that arrived mid-flight. The existing detail-error UI handles the rest.
    if (isBlockedContent('movie', clean)) return Promise.reject(blockedError('movie', clean));
    return api().gb.movie(clean, region || getRegion()).then((d) => {
      if (isBlockedContent('movie', clean)) throw blockedError('movie', clean);
      return applyOverrides(assertDetail(d, 'movie', clean), 'movie');
    });
  }

  function getTVDetails(id, region) {
    const clean = parseId(id);
    if (!clean) return Promise.reject(new Error('Invalid tv id'));
    if (isBlockedContent('tv', clean)) return Promise.reject(blockedError('tv', clean));
    return api().gb.show(clean, region || getRegion()).then((d) => {
      if (isBlockedContent('tv', clean)) throw blockedError('tv', clean);
      return applyOverrides(assertDetail(d, 'tv', clean), 'tv');
    });
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
        .filter((x) => !isBlockedContent(x.media_type, parseId(x.id)))
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
      // Public search never surfaces blocked titles (central filter). Admin
      // TMDB search uses the raw /api/tmdb proxy directly, so it still finds
      // them (marked BLOCKED in the Blocked Titles workspace).
      results: ((d.results || [])
        .filter((x) => x.media_type === 'movie' || x.media_type === 'tv')
        .map((x) => applyOverrides(x))
        .filter((x) => x && !isBlockedItem(x))),
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
          .filter((x) => x && !isBlockedItem(x, mt))
          .filter((x) => x && (x.poster_path || x.backdrop_path)),
      };
    });
  }

  function getByGenre(media, genreId, page, sort) {
    return getDiscover({ media, genre: genreId, page, sort });
  }

  /* ---------------- homepage configuration (D1 first, local file fallback) ---------------- */

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
    } else if (type === 'tag') {
      // Editorial shelf: references an existing custom tag slug. The tag's
      // ordered membership resolves through the SAME rule collections use
      // (resolveTagItems) — no second content system, no View All page.
      // Unknown/hidden tags skip the shelf at render time (see
      // resolveHomeSection), so only the slug shape is checked here.
      const tag = normalizeSlug(src.tag);
      if (!tag) { console.warn('[home] tag source needs tag slug:', id); return null; }
      clean.source.tag = tag;
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
    // New hero keys pass through structurally (renderer + server own
    // strictness); older rows simply lack them and defaults apply.
    const heroItemRaw = hero.heroItem;
    const heroItem = (heroItemRaw && typeof heroItemRaw === 'object' && !Array.isArray(heroItemRaw) &&
      (heroItemRaw.media === 'movie' || heroItemRaw.media === 'tv') &&
      parseId(heroItemRaw.id))
      ? { media: heroItemRaw.media, id: parseId(heroItemRaw.id) }
      : null;
    return {
      hero: {
        mode: hero.mode === 'custom' ? 'custom' : (hero.mode === 'spotlight' ? 'spotlight' : 'follow-grid'),
        badge: typeof hero.badge === 'string' ? hero.badge : '',
        pick: Math.max(0, parseInt(hero.pick, 10) || 0),
        source: hero.source,
        heroItem,
        artwork: (hero.artwork && typeof hero.artwork === 'object' && !Array.isArray(hero.artwork)) ? hero.artwork : null,
        trailer: (hero.trailer && typeof hero.trailer === 'object' && !Array.isArray(hero.trailer)) ? hero.trailer : null,
      },
      sections,
    };
  }

  // Ordered hand-picked IDs through the Greybox API. Config order is
  // preserved exactly (TMDB never re-sorts); failed IDs are dropped.
  // Shared by homepage `ids` shelves and Greybox collections.
  // Blocked IDs drop out twice: the detail getters reject them (so they
  // never resolve here) and the final filter covers a block that landed
  // mid-flight — pins, custom lists and tag memberships included.
  function resolveIdItems(items) {
    const list = Array.isArray(items) ? items : [];
    return Promise.allSettled(list.map((it) =>
      (it.media === 'tv' ? getTVDetails(it.id) : getMovie(it.id)).then((d) => ({ ...d, media_type: it.media }))
    )).then((settled) => settled.filter((s) => s.status === 'fulfilled').map((s) => s.value)
      .filter((x) => x && !isBlockedItem(x))
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
    if (src.type === 'tag') {
      const tag = normalizeSlug(src.tag);
      if (!tag) return Promise.reject(new Error('Invalid tag slug'));
      // Unknown/hidden tags reject so the shelf is skipped instead of
      // rendering an empty or broken row (same rule as collections).
      return resolveTagItems(tag).then((items) => ({
        section, items: (items || []).slice(0, limit), tag: getTag(tag, { includeHidden: true }),
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
    if (!heroCfg || (heroCfg.mode !== 'custom' && heroCfg.mode !== 'spotlight')) return Promise.resolve(null);
    // Spotlight: one explicit title by media identity (admin-picked). The
    // detail bundle carries trailer_key, so no extra lookup is needed later.
    if (heroCfg.mode === 'spotlight') {
      const hi = heroCfg.heroItem;
      if (!hi || (hi.media !== 'movie' && hi.media !== 'tv') || !parseId(hi.id)) return Promise.resolve(null);
      const get = hi.media === 'tv' ? getTVDetails(hi.id) : getMovie(hi.id);
      return get.then(
        (d) => (d && (d.poster_path || d.backdrop_path)) ? { ...d, media_type: hi.media } : null,
        () => null
      );
    }
    if (!heroCfg.source) return Promise.resolve(null);
    const pick = Math.max(0, parseInt(heroCfg.pick, 10) || 0);
    const probe = normalizeHomeSection({ id: '__hero__', title: '__hero__', limit: pick + 1, source: heroCfg.source });
    if (!probe) return Promise.resolve(null);
    return resolveHomeSection(probe).then(
      (r) => r.items[pick] || r.items[0] || null,
      () => null
    );
  }

  /* ---------------- hero presentation helpers (Part 2) ---------------- */

  const collectionHeroCache = {}; // slug -> hero override|null (page lifetime)

  // Collection hero override from the public single-collection config
  // (server re-sanitizes on every read). Null = default hero behavior.
  // Never rejects; a page never breaks on hero-config trouble.
  function getCollectionHeroConfig(slug) {
    const s = normalizeSlug(slug);
    if (!s) return Promise.resolve(null);
    if (Object.prototype.hasOwnProperty.call(collectionHeroCache, s)) {
      return Promise.resolve(collectionHeroCache[s]);
    }
    return fetchJsonTimeout('/api/config/collections/' + encodeURIComponent(s), 8000).then(
      (d) => {
        const h = d && d.hero && typeof d.hero === 'object' && !Array.isArray(d.hero) ? d.hero : null;
        const out = (h && h.mode === 'custom' && h.heroItem && typeof h.heroItem === 'object') ? h : null;
        collectionHeroCache[s] = out;
        return out;
      },
      () => { collectionHeroCache[s] = null; return null; }
    );
  }

  // Resolve a collection hero override to a renderable item (single media
  // identity, detail bundle with trailer_key) or null to keep the default
  // first-item hero. Never rejects.
  function getCollectionHeroItem(heroCfg) {
    if (!heroCfg || heroCfg.mode !== 'custom') return Promise.resolve(null);
    const hi = heroCfg.heroItem;
    if (!hi || (hi.media !== 'movie' && hi.media !== 'tv') || !parseId(hi.id)) return Promise.resolve(null);
    const get = hi.media === 'tv' ? getTVDetails(hi.id) : getMovie(hi.id);
    return get.then(
      (d) => (d && (d.poster_path || d.backdrop_path)) ? { ...d, media_type: hi.media } : null,
      () => null
    );
  }

  /* ---------------- Greybox collections (D1 first, local file fallback) ---------------- */

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
    } else if (type === 'tag') {
      // Reusable editorial group: references a custom tag slug. Membership
      // order IS the content order (pins still lead, excludes still drop —
      // same collection rules as every other source). Unknown/hidden tags
      // fail resolution at render time; only the slug shape is checked here.
      const tag = normalizeSlug(src.tag);
      if (!tag) { console.warn('[collections] tag source needs tag slug:', slug); return null; }
      clean.tag = tag;
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
          : (d.results || []).filter((x) => (x.media_type || ((x.title && !x.first_air_date) ? 'movie' : 'tv')) === media),
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
    if (src.type === 'tag') {
      // Finite editorial list like `custom`: tag membership order, dead IDs
      // dropped by the shared resolver (see resolveTagItems).
      return resolveTagItems(src.tag).then((results) => ({ results }));
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
          : (d.results || []).filter((x) => (x.media_type || ((x.title && !x.first_air_date) ? 'movie' : 'tv')) === media),
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
  // Custom (hand-picked ID) and tag (editorial membership) collections are
  // finite: page 1 carries everything.
  // Accepts a slug or a normalized collection. Rejects when not found.
  // Resolves { collection, items, page, totalPages }.
  function resolveCollectionPage(slugOrCollection, page) {
    const c = (slugOrCollection && typeof slugOrCollection === 'object')
      ? slugOrCollection
      : getCollection(slugOrCollection);
    if (!c || !c.source) return Promise.reject(new Error('Collection not found'));
    const p = parsePage(page);
    if (c.source.type === 'custom' || c.source.type === 'tag') {
      if (p > 1) return Promise.resolve({ collection: c, items: [], page: p, totalPages: 1 });
      const base = c.source.type === 'tag'
        ? resolveTagItems(c.source.tag)
        : resolveIdItems(c.source.items);
      return base.then((results) => ({ collection: c, items: results, page: 1, totalPages: 1 }));
    }
    const pins = (p === 1 && c.pin && c.pin.length)
      ? resolveIdItems(c.pin)
      : Promise.resolve([]);
    return Promise.all([pins, fetchCollectionBasePage(c.source, p)]).then(([pinned, d]) => {
      const seen = new Set(pinned.map((x) => itemKey(x.media_type || ((x.title && !x.first_air_date) ? 'movie' : 'tv'), x.id)));
      const items = [...pinned];
      for (const x of (d.results || [])) {
        const mt = x.media_type || ((x.title && !x.first_air_date) ? 'movie' : 'tv');
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
    // then cap — a dead ID never eats a display slot. Tag memberships work
    // the same way (ordered editorial lists). Dynamic sources page
    // only until the cap is filled.
    const base = c.source.type === 'custom'
      ? resolveIdItems(c.source.items).then((results) => ({ results }))
      : (c.source.type === 'tag'
        ? resolveTagItems(c.source.tag).then((results) => ({ results }))
        : resolveCollectionSource(c.source, limit));
    const pins = (c.pin && c.pin.length)
      ? resolveIdItems(c.pin)
      : Promise.resolve([]);
    return Promise.all([pins, base]).then(([pinned, d]) => {
      const seen = new Set(pinned.map((x) => itemKey(x.media_type || ((x.title && !x.first_air_date) ? 'movie' : 'tv'), x.id)));
      const items = [...pinned];
      for (const x of (d.results || [])) {
        const mt = x.media_type || ((x.title && !x.first_air_date) ? 'movie' : 'tv');
        if (seen.has(itemKey(mt, x.id))) continue;
        if (isExcluded({ media: mt, id: x.id }, c.exclude || [])) continue;
        seen.add(itemKey(mt, x.id));
        items.push({ ...x, media_type: mt });
        if (items.length >= limit) break;
      }
      return { collection: c, items: items.slice(0, limit) };
    });
  }

  /* ---------------- Greybox custom tags (D1 first, local file fallback) ---------------- */

  // A tag: { slug, name, description, visible, badge, members } where members
  // is the ordered [{ media, id }] membership list (identity only — TMDB
  // supplies titles/posters at render time, exactly like `custom` sources).
  // Tags are content groups first: `badge` only controls the extra card /
  // detail badge, never membership. Hidden tags resolve to nothing anywhere.

  function getTagConfig() {
    if (_remoteConfig && _remoteConfig.tags) return _remoteConfig.tags;
    const raw = window.GreyboxTags;
    return Array.isArray(raw) ? raw : [];
  }

  // Returns a clean tag or null (malformed → console.warn, page survives).
  function normalizeTag(raw) {
    if (!raw || typeof raw !== 'object') { console.warn('[tags] dropping malformed tag:', raw); return null; }
    const slug = normalizeSlug(raw.slug);
    const name = String(raw.name || '').trim();
    if (!slug || !name) { console.warn('[tags] tag needs slug + name:', raw); return null; }
    const members = (Array.isArray(raw.members) ? raw.members : [])
      .map((it) => {
        if (!it || typeof it !== 'object') return null;
        const mid = parseId(it.id);
        const media = it.media === 'tv' ? 'tv' : (it.media === 'movie' ? 'movie' : null);
        return (mid && media) ? { media, id: mid } : null;
      })
      .filter(Boolean);
    // Membership dedupe (first wins) so a double-added title can never
    // render twice — mirrors the server-side PUT dedupe.
    const seen = new Set();
    const deduped = members.filter((m) => {
      const k = m.media + ':' + m.id;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return {
      slug,
      name: name.slice(0, 120),
      description: typeof raw.description === 'string' ? raw.description : '',
      visible: raw.visible !== false,
      badge: raw.badge === true,
      members: deduped,
    };
  }

  // All valid tags in config order; duplicate slugs keep the first.
  // Source: D1 once preloaded, else the local js/tags.config.js.
  function getTags() {
    const raw = getTagConfig();
    const list = Array.isArray(raw) ? raw : [];
    const seen = new Set();
    const out = [];
    for (const r of list) {
      const t = normalizeTag(r);
      if (!t) continue;
      if (seen.has(t.slug)) { console.warn('[tags] duplicate slug ignored:', t.slug); continue; }
      seen.add(t.slug);
      out.push(t);
    }
    return out;
  }

  // Visible tag by slug, or null (unknown, malformed, or hidden — hidden
  // tags produce no public content anywhere, URL included).
  function getTag(slug, opts) {
    const s = normalizeSlug(slug);
    if (!s) return null;
    const found = getTags().find((t) => t.slug === s) || null;
    if (found && found.visible === false && !(opts && opts.includeHidden)) return null;
    return found;
  }

  // Resolve a tag's ordered membership to renderable items through the
  // Greybox API (the SAME resolveIdItems every hand-picked source uses —
  // config order preserved, failed IDs dropped, overrides applied).
  // Rejects when the tag is unknown or hidden.
  function resolveTagItems(slugOrTag) {
    const t = (slugOrTag && typeof slugOrTag === 'object')
      ? slugOrTag
      : getTag(slugOrTag);
    if (!t || !Array.isArray(t.members)) return Promise.reject(new Error('Tag not found'));
    return resolveIdItems(t.members);
  }

  // Badge lookup, memoized on the config array identity (same pattern as
  // the override map): media:id -> [tag names] for visible tags with
  // badge enabled. A title in several badged tags collects every name —
  // no cross-tag contamination, and membership alone never shows a badge.
  let _tagBadgeCacheRef = null;
  let _tagBadgeCacheMap = null;

  function tagBadgeMap() {
    const raw = getTagConfig();
    if (raw !== _tagBadgeCacheRef) {
      const map = new Map();
      for (const entry of (Array.isArray(raw) ? raw : [])) {
        const t = normalizeTag(entry);
        if (!t || t.visible === false || t.badge !== true) continue;
        for (const m of t.members) {
          const key = m.media + ':' + m.id;
          const arr = map.get(key) || [];
          if (arr.indexOf(t.name) < 0) arr.push(t.name);
          map.set(key, arr);
        }
      }
      _tagBadgeCacheRef = raw;
      _tagBadgeCacheMap = map;
    }
    return _tagBadgeCacheMap;
  }

  // Badge names for one identity, or [] (never null — renderers map it).
  function getTagBadges(media, id) {
    const mt = media === 'tv' ? 'tv' : (media === 'movie' ? 'movie' : null);
    const clean = parseId(id);
    if (!mt || !clean) return [];
    return tagBadgeMap().get(mt + ':' + clean) || [];
  }

  /* ---------------- Greybox metadata overrides (D1 first, local file fallback) ---------------- */

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
  // are replaced; everything else passes through untouched. Tag badges
  // (visible, badge-enabled tags containing this identity) ride along as
  // `tag_badges: [names]` — additive, alongside (never replacing)
  // `custom_badge`. Returns the ORIGINAL object when neither an override
  // nor badges match (no copy, no mutation).
  function applyOverrides(item, fallbackMedia) {
    if (!item || typeof item !== 'object') return item;
    // Identity fallback: shaped items alias title/name on both media types,
    // so title alone cannot distinguish them — a TV-shaped object missing
    // media_type must not be miskeyed as movie:id (wrong override artwork
    // grafted onto another identity). first_air_date disambiguates.
    const media = item.media_type === 'tv' || item.media_type === 'movie' ? item.media_type
      : (fallbackMedia === 'tv' || fallbackMedia === 'movie' ? fallbackMedia
      : ((item.title && !item.first_air_date) ? 'movie' : 'tv'));
    const o = getOverride(media, item.id);
    const badges = getTagBadges(media, item.id);
    if (!o && !badges.length) return item;
    const out = o ? { ...item, media_type: media } : { ...item };
    if (o) {
      for (const k of Object.keys(o.fields)) {
        if (k === 'description') out.overview = o.fields[k];
        else out[k] = o.fields[k];
      }
      // The codebase treats title/name as aliases (gbItem sets both) — keep them in sync.
      if (out.title != null) out.name = out.title;
      else if (out.name != null) out.title = out.name;
    }
    if (badges.length) out.tag_badges = badges.slice();
    return out;
  }

  /* ---------------- permanent blocklist (Blocked Titles workspace) ----------------
   *
   * D1 (`blocked_titles`, managed through /api/admin/blocked) is the live
   * source of truth; the public site reads identity-only rows via
   * GET /api/config/blocked (preloaded once at boot above, offline fallback
   * `js/blocked.config.js`). Enforcement lives HERE, centrally:
   *
   *   TMDB/content data
   *           ↓  applyOverrides (existing) + blocklist filter (below)
   *   Greybox content pipeline (withImages / search / discover / resolveIdItems)
   *           ↓  detail guards (getMovie / getTVDetails refuse blocked IDs)
   *   Home / Movies / TV / Collections / Search / etc.
   *
   * No page, renderer, or collection/section resolver carries its own
   * `if (blocked)` check — they all flow through these helpers.
   *
   * Identity is ALWAYS media_type + TMDB ID (never title/poster/slug):
   * "movie:123" and "tv:123" are different identities and can never
   * cross-block. Media resolution mirrors applyOverrides so a TV-shaped
   * object missing media_type is never miskeyed as a movie (or vice versa).
   */

  function getBlockedConfig() {
    if (_remoteConfig && Array.isArray(_remoteConfig.blocked)) return _remoteConfig.blocked;
    const raw = (typeof window !== 'undefined' && window.GreyboxBlocked) || null;
    return Array.isArray(raw) ? raw : [];
  }

  // One normalized identity { media, id }, or null. Accepts the public
  // { media, id } shape (and { media, tmdb_id } defensively); anything else
  // — titles, posters, slugs — is ignored, never identity.
  function normalizeBlockedEntry(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const media = raw.media === 'tv' ? 'tv' : (raw.media === 'movie' ? 'movie' : null);
    const id = parseId(raw.id != null ? raw.id : raw.tmdb_id);
    if (!media || !id) return null;
    return { media, id };
  }

  // Normalized blocklist (for tests/inspection): [{ media, id }].
  function getBlockedList() {
    const out = [];
    const seen = new Set();
    for (const entry of getBlockedConfig()) {
      const n = normalizeBlockedEntry(entry);
      if (!n) continue;
      const key = n.media + ':' + n.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(n);
    }
    return out;
  }

  // Membership set, memoized on the config array identity (same pattern as
  // the override/tag caches) so list rendering (dozens of lookups) never
  // re-normalizes per item.
  let _blockedCacheRef = null;
  let _blockedCacheSet = null;

  function blockedSet() {
    const raw = getBlockedConfig();
    if (raw !== _blockedCacheRef) {
      const set = new Set();
      for (const entry of (Array.isArray(raw) ? raw : [])) {
        const n = normalizeBlockedEntry(entry);
        if (n) set.add(n.media + ':' + n.id);
      }
      _blockedCacheRef = raw;
      _blockedCacheSet = set;
    }
    return _blockedCacheSet;
  }

  // THE seam: is this identity blocked? Strict (media, id) pair only.
  // Never throws; unknown media or bad ids are simply "not blocked".
  function isBlockedContent(media, id) {
    const mt = media === 'tv' ? 'tv' : (media === 'movie' ? 'movie' : null);
    const clean = parseId(id);
    if (!mt || !clean) return false;
    return blockedSet().has(mt + ':' + clean);
  }

  // Item-shaped variant: resolves media exactly like applyOverrides (explicit
  // media_type wins, caller fallback next, title/first_air_date heuristic
  // last) so cross-type miskeying is impossible.
  function isBlockedItem(item, fallbackMedia) {
    if (!item || typeof item !== 'object') return false;
    const media = item.media_type === 'tv' || item.media_type === 'movie' ? item.media_type
      : (fallbackMedia === 'tv' || fallbackMedia === 'movie' ? fallbackMedia
      : ((item.title && !item.first_air_date) ? 'movie' : 'tv'));
    return isBlockedContent(media, item.id);
  }

  // Non-mutating list filter: everything not blocked passes through untouched
  // (same object references — no copies, no reordering, totals preserved by
  // callers that need them).
  function filterBlocked(items, fallbackMedia) {
    const list = Array.isArray(items) ? items : [];
    return list.filter((x) => !isBlockedItem(x, fallbackMedia));
  }

  // Refusal for direct-detail access to a blocked identity. Generic copy only
  // (no blocklist internals); the existing detail-error UI renders it as the
  // standard "Not available" state. `blocked: true` lets tests and future
  // callers distinguish it from a network/TMDB failure without parsing text.
  function blockedError(media, id) {
    const e = new Error('This title is not available in Greybox.');
    e.blocked = true;
    e.status = 404;
    e.media = media;
    e.tmdb_id = id;
    return e;
  }

  /* ---------------- public navigation (D1 first, local file fallback) ----------------
   *
   * D1 (`settings` row `navigation`, managed through /api/admin/navigation
   * and the Admin Navigation workspace) is the live source of truth; the
   * public site reads it via GET /api/config/navigation (preloaded once at
   * boot above, offline fallback `js/navigation.config.js`).
   *
   * The menu is a fixed six-item set with stable keys — identity is ALWAYS
   * the key (home, movies, tv, anime, collections, my-list), never the
   * display label. Array order IS the display order. Routes are derived
   * from the key (controlled known routes only — a label edit can never
   * break routing, and no arbitrary URL is ever accepted). Hiding
   * (visible = false) removes the entry from the navbar but keeps it
   * server-side, so re-showing restores it. Header search visibility is a
   * separate clearly named flag OUTSIDE the item list — search itself and
   * My List storage/behavior are untouched (only their navbar entries hide).
   *
   * Failure fallback: any fetch problem leaves _remoteConfig.navigation
   * null and the getters below use the local fallback file, which
   * reproduces the current hardcoded navbar — a config failure never makes
   * the site unusable.
   */

  const NAV_KEYS = ['home', 'movies', 'tv', 'anime', 'collections', 'my-list'];

  // Controlled known routes per stable key (single place that maps keys to
  // the existing public routes — mirrors js/router.js + js/app.js data-nav
  // wiring; no second router, no custom destinations in V1).
  const NAV_ROUTES = {
    home: '/',
    movies: '/movies',
    tv: '/tv',
    anime: '/anime',
    collections: null, // the existing collections dropdown menu (no single URL)
    'my-list': '/mylist',
  };

  // Existing data-nav values in index.html/js/app.js per stable key.
  // The applier (js/navigation.js) never changes these — labels reorder
  // around them, so highlight + click behavior survives relabeling.
  const NAV_DATA_NAV = {
    home: 'home',
    movies: 'movie',
    tv: 'tv',
    anime: 'anime',
    collections: null, // dropdown button (no data-nav)
    'my-list': 'mylist',
  };

  const NAV_DEFAULT_LABELS = {
    home: 'Home',
    movies: 'Movies',
    tv: 'TV Shows',
    anime: 'Anime',
    collections: 'Collections',
    'my-list': 'My List',
  };

  const NAV_LABEL_MAX = 32;

  function getNavigationSource() {
    if (_remoteConfig && _remoteConfig.navigation && typeof _remoteConfig.navigation === 'object' && !Array.isArray(_remoteConfig.navigation)) {
      return _remoteConfig.navigation;
    }
    const raw = (typeof window !== 'undefined' && window.GreyboxNavigation) || null;
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null;
  }

  // Lenient normalizer (mirrors sanitizeNavigation server-side): unknown
  // keys dropped, missing keys filled from defaults in canonical order,
  // invalid labels fall back to defaults, non-boolean flags read as
  // visible. Never throws — malformed config renders as the default navbar.
  function normalizeNavigation(raw) {
    const items = [];
    const seen = new Set();
    const list = raw && Array.isArray(raw.items) ? raw.items : [];
    for (const it of list) {
      if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
      const key = String(it.key == null ? '' : it.key).trim().toLowerCase();
      if (NAV_KEYS.indexOf(key) < 0 || seen.has(key)) continue;
      seen.add(key);
      let label = NAV_DEFAULT_LABELS[key];
      if (typeof it.label === 'string' && it.label.trim() && it.label.trim().length <= NAV_LABEL_MAX) {
        label = it.label.trim();
      }
      items.push({ key, label, visible: it.visible === false ? false : true, route: NAV_ROUTES[key], dataNav: NAV_DATA_NAV[key] });
    }
    for (const k of NAV_KEYS) {
      if (!seen.has(k)) items.push({ key: k, label: NAV_DEFAULT_LABELS[k], visible: true, route: NAV_ROUTES[k], dataNav: NAV_DATA_NAV[k] });
    }
    let searchVisible = true;
    try {
      if (raw && typeof raw.searchVisible === 'boolean') searchVisible = raw.searchVisible;
    } catch { searchVisible = true; }
    return { items, searchVisible };
  }

  // Full normalized config (hidden items included with flags, display
  // order, routes + data-nav attached) — for the navbar applier and tests.
  function getNavigationConfig() {
    try { return normalizeNavigation(getNavigationSource()); }
    catch { return normalizeNavigation(null); }
  }

  // Visible entries only, in display order — what the navbar renders.
  function getVisibleNavigation() {
    const full = getNavigationConfig();
    return {
      items: full.items.filter((it) => it && it.visible !== false),
      searchVisible: full.searchVisible !== false,
    };
  }

  /* ---------------- detail page presentation (D1 first, local file fallback) ----------------
   *
   * D1 (`settings` row `detail_pages`, managed through
   * /api/admin/settings/detail-pages and the Admin Detail Pages workspace)
   * is the live source of truth; the public detail modal reads it via
   * GET /api/config/detail-pages (preloaded once at boot above, offline
   * fallback `js/detail-pages.config.js`).
   *
   * Site-wide visibility flags in four groups — identity is ALWAYS the
   * group.key path (header.backdrop, tv.episodes, ...), never a display
   * label. Every flag defaults to shown, so a missing/corrupt row renders
   * exactly the current detail page. Only elements that actually exist in
   * js/pages.js renderTitleDetail are listed (no recommendations setting:
   * the detail page renders no recommendations). TV-only flags safely
   * no-op for movies, and these flags never override Blocked Titles:
   * blocking is enforced in getMovie/getTVDetails above, before any
   * rendering happens — js/detail-pages.js only ever sees resolved,
   * allowed titles.
   *
   * Failure fallback: any fetch problem leaves
   * _remoteConfig.detailPages null and the getter below uses the local
   * fallback file — a config failure never makes detail pages unusable.
   */

  const DETAIL_GROUPS = {
    header: ['backdrop', 'poster', 'badge', 'title', 'meta', 'rating', 'genres', 'overview'],
    actions: ['watch', 'trailer', 'myList'],
    content: ['providers', 'cast'],
    tv: ['episodes', 'episodeOverview', 'episodeMeta'],
  };

  function getDetailPagesSource() {
    if (_remoteConfig && _remoteConfig.detailPages && typeof _remoteConfig.detailPages === 'object' && !Array.isArray(_remoteConfig.detailPages)) {
      return _remoteConfig.detailPages;
    }
    const raw = (typeof window !== 'undefined' && window.GreyboxDetailPages) || null;
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null;
  }

  // Lenient normalizer (mirrors sanitizeDetailPages server-side): unknown
  // groups/keys dropped, missing flags read as shown, non-boolean values
  // fall back to shown. Never throws — malformed config renders the
  // default detail page.
  function normalizeDetailPages(raw) {
    const out = {};
    try {
      const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      for (const g of Object.keys(DETAIL_GROUPS)) {
        const node = src[g] && typeof src[g] === 'object' && !Array.isArray(src[g]) ? src[g] : {};
        const clean = {};
        for (const k of DETAIL_GROUPS[g]) {
          clean[k] = node[k] === false ? false : true;
        }
        out[g] = clean;
      }
    } catch {
      for (const g of Object.keys(DETAIL_GROUPS)) {
        out[g] = {};
        for (const k of DETAIL_GROUPS[g]) out[g][k] = true;
      }
    }
    return out;
  }

  // Full normalized config (all groups with boolean flags) — for the
  // detail presentation layer (js/detail-pages.js) and tests.
  function getDetailPagesConfig() {
    try { return normalizeDetailPages(getDetailPagesSource()); }
    catch { return normalizeDetailPages(null); }
  }

  /* ---------------- playback mode (D1 first, local file fallback) ----------------
   *
   * D1 (`settings` row `playback`, managed through
   * /api/admin/settings/playback and the Admin Playback workspace) is the
   * live source of truth; the public resolver reads it via
   * GET /api/config/playback (preloaded once at boot above, offline
   * fallback `js/playback.config.js`).
   *
   * V1 exposes exactly ONE setting: `mode` (auto/direct/embed). Identity is
   * ALWAYS the mode key — never a display label. No provider URLs, tokens,
   * or secrets live here: the embed host stays in js/stream.js EMBED.base
   * and the test manifest stays in js/greybox-test-source.js.
   *
   * Semantics (implemented in js/stream.js resolvePlayback):
   *   auto   — normal Greybox resolver strategy (catalog titles use the
   *            configured embed source; direct files use the Greybox Player).
   *   direct — catalog titles require a valid direct source and fail cleanly
   *            when none exists (today: no direct production source, so
   *            catalog Watch reports "no direct source" instead of iframing).
   *   embed  — catalog titles use the configured embed source.
   * Direct-file intents (user-pasted URLs, ?play-test=1) always route to the
   * Greybox Player regardless of mode — they are explicit direct sources,
   * not catalog resolution.
   *
   * Failure fallback: any fetch problem leaves _remoteConfig.playback null
   * and the getter below uses the local fallback file (auto) — a config
   * failure never makes playback unusable.
   */

  const PLAYBACK_MODES = ['auto', 'direct', 'embed'];
  const PLAYBACK_DEFAULT = { mode: 'auto' };

  function getPlaybackSource() {
    if (_remoteConfig && _remoteConfig.playback && typeof _remoteConfig.playback === 'object' && !Array.isArray(_remoteConfig.playback)) {
      return _remoteConfig.playback;
    }
    const raw = (typeof window !== 'undefined' && window.GreyboxPlayback) || null;
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null;
  }

  // Lenient normalizer (mirrors sanitizePlayback server-side): unknown modes
  // fall back to auto, non-object input falls back to auto. Never throws —
  // malformed config renders as the default auto resolver.
  function normalizePlayback(raw) {
    try {
      const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      const m = String(src.mode == null ? '' : src.mode).trim().toLowerCase();
      if (PLAYBACK_MODES.indexOf(m) >= 0) return { mode: m };
      return { mode: 'auto' };
    } catch {
      return { mode: 'auto' };
    }
  }

  // Full normalized config ({ mode }) — for the resolver (js/stream.js),
  // the Admin workspace, and tests.
  function getPlaybackConfig() {
    try { return normalizePlayback(getPlaybackSource()); }
    catch { return normalizePlayback(null); }
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
    getCollectionHeroConfig,
    getCollectionHeroItem,
    resolveIdItems,
    normalizeSlug,
    normalizeCollection,
    getCollections,
    getCollection,
    resolveCollection,
    resolveCollectionPage,
    normalizeTag,
    getTags,
    getTag,
    resolveTagItems,
    getTagBadges,
    OVERRIDABLE_FIELDS,
    getOverrides,
    getOverride,
    applyOverrides,
    normalizeBlockedEntry,
    getBlockedList,
    isBlockedContent,
    filterBlocked,
    NAV_KEYS,
    NAV_ROUTES,
    NAV_LABEL_MAX,
    normalizeNavigation,
    getNavigationConfig,
    getVisibleNavigation,
    DETAIL_GROUPS,
    normalizeDetailPages,
    getDetailPagesConfig,
    PLAYBACK_MODES,
    PLAYBACK_DEFAULT,
    normalizePlayback,
    getPlaybackConfig,
    getMyList,
    saveMyList,
    toggleMyListItem,
    isInMyList,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = window.GreyboxData;
})();
