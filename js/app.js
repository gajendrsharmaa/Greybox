/* Greybox page controller — Route → data → pages. No HTML building here.
 *
 * Pipeline (vanilla JS, no framework, no database):
 *   Route (js/router.js, URL is source of truth)
 *     ↓  this file maps route -> fetcher + renderer
 *   Greybox API (js/api.js) via page-level fetchers (js/data.js):
 *     getMovie(id) / getTVDetails(id) / getPopularMovies() /
 *     getSearchResults(query) / getSeason() / getPerson() / …
 *     ↓  data transformation lives in data.js (filter/sort/shape)
 *   Page renderer (js/pages.js, pure data-in/HTML-out)
 *     ↓  shared UI + loading/error states (js/components.js)
 *   HTML (index.html, unchanged)
 *
 * Player (js/stream.js) is untouched — this file only calls Stream.* exactly
 * as before. URL structure is untouched — js/router.js is unchanged.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const R = window.Router || null;
  const Data = window.GreyboxData;
  const C = window.GreyboxComponents;
  const Pages = window.GreyboxPages;
  if (!Data || !C || !Pages) {
    throw new Error('Greybox modules missing. Check script order in index.html: api → router → stream → data → components → pages → app.');
  }

  // ---- page state (derived from the route on every navigation) ----
  let mode = 'home';       // home | movie | tv | anime | mylist | search | collection
  let subTab = 'trending'; // per-mode tab
  let pageNum = 1;
  let searchQuery = '';
  let collectionSlug = '';
  let collectionMedia = null; // Phase 5.3: 'movie' | 'tv' | null (null = All)
  // Phase 5.4: live pagination state for the current collection page. items
  // and seen accumulate raw (unfiltered) results across TMDB pages; the
  // Phase 5.3 filter applies at paint time so filter switches never refetch.
  // Exactly one view lives at a time; navigation disconnects its observer
  // (accumulated data may persist for an instant same-collection resume).
  // view: { slug, configKey, col, filter, items, seen:Set, page, totalPages,
  //         loadingPage:0, done:false, observer:null }
  let colView = null;
  let heroItem = null;
  let currentDetail = null; // {...} + media_type, or {kind:'person', id}
  let currentSeasons = [];
  let currentEpisodes = [];
  let currentSeasonNum = 1;
  let hasLoadedList = false;
  let lastRouteName = '';
  // Per-navigation generation: renderRoute() bumps it on EVERY route, and
  // every async continuation below bails out when its captured generation is
  // stale — so a late resolve can never overwrite the hero, grid, header, or
  // modal owned by a newer route. (Previously only home extras were guarded,
  // and only against home->home navigation.)
  let routeGen = 0;
  // Overlay-modal generation: bumped on every modal open AND every modal
  // close (hide-only). Card clicks open the modal as an OVERLAY with NO
  // history entry and NO routeGen bump, so the underlying page instance
  // (DOM, scroll, shelves, filter) survives untouched. Dual-check
  // (routeGen + modalGen) guarantees: a real navigation aborts in-flight
  // overlay work via routeGen, and opening another card aborts the previous
  // card's fetch via modalGen — no stale detail data. NEVER weakened:
  // routeGen protection stays exactly as before.
  let modalGen = 0;

  /* ---------------- route helpers (state <-> URL, no fetching) ---------------- */
  const kebabToSnake = (s) => String(s || '').split('-').join('_');
  const snakeToKebab = (s) => String(s || '').split('_').join('-');
  const animeKindToSub = (k) => (k === 'movies' ? 'movie-anime' : 'tv-anime');
  const animeSubToKind = (s) => (s === 'movie-anime' ? 'movies' : 'series');

  function navTo(to) {
    if (R) R.navigate(to);
    else { try { window.location.href = to; } catch { /* noop */ } }
  }

  // Canonical list URL for the current state (tabs + pager navigate here).
  function currentListURL(page) {
    const p = page || pageNum;
    if (!R) return '/';
    if (mode === 'home') return R.url.home(subTab, p);
    if (mode === 'movie') return R.url.movies(snakeToKebab(subTab), p);
    if (mode === 'tv') return R.url.tv(snakeToKebab(subTab), p);
    if (mode === 'anime') return R.url.anime(animeSubToKind(subTab), p);
    if (mode === 'mylist') return R.url.mylist();
    if (mode === 'search') return R.url.search(searchQuery, p);
    if (mode === 'collection') return R ? R.url.collection(collectionSlug) : '/';
    return '/';
  }

  function detailURL(id, mt) {
    if (!R) return '/';
    return mt === 'tv' ? R.url.show(id) : R.url.movie(id);
  }

  function highlightNav() {
    // Detail routes highlight their parent section so the nav never looks dead.
    let key = mode;
    if (currentDetail && (lastRouteName === 'movie-detail')) key = 'movie';
    if (currentDetail && (lastRouteName === 'tv-detail')) key = 'tv';
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.nav === key));
  }

  function updateCount() {
    const c = $('mylist-count');
    if (!c) return;
    const n = Data.getMyList().length;
    c.textContent = n || '';
    c.classList.toggle('hidden', !n);
  }

  // Footer discoverability: visible collections from js/collections.config.js
  // become footer links via the real route URLs (R.url.collection), so adding
  // a collection to the config automatically adds its footer link. Runs once
  // at boot — the config is static for the lifetime of the page.
  function renderFooter() {
    let cols = [];
    try { cols = (Data.getCollections() || []).filter((c) => c && c.visible !== false); } catch { cols = []; }
    Pages.renderFooterCollections(cols.map((c) => ({
      href: R ? R.url.collection(c.slug) : '/collection/' + c.slug,
      label: c.title,
    })));
  }

  function tabNavigator() {
    // Tabs are navigation: the URL updates so refresh/back/deep-links work.
    return (k) => {
      if (mode === 'home') navTo(R ? R.url.home(k, 1) : '/');
      else if (mode === 'movie') navTo(R ? R.url.movies(snakeToKebab(k), 1) : '/movies');
      else if (mode === 'tv') navTo(R ? R.url.tv(snakeToKebab(k), 1) : '/tv');
      else if (mode === 'anime') navTo(R ? R.url.anime(animeSubToKind(k), 1) : '/anime');
    };
  }

  /* ---------------- list pages: fetch (data.js) -> render (pages.js) ---------------- */

  async function loadList() {
    const myGen = routeGen;
    Pages.setHomeDiscoverMode(false);
    Pages.renderListLoading(pageNum);
    Pages.renderListChrome(mode, subTab, tabNavigator());
    C.setPageLabel(pageNum);
    highlightNav();
    try {
      const data = await Data.getList(mode, subTab, pageNum);
      if (myGen !== routeGen) return; // navigated away: a newer route owns the page
      heroItem = Pages.renderList({
        mode, subTab, page: pageNum,
        items: data.results || [],
        isInList: (id, mt) => Data.isInMyList(id, mt),
        onTab: tabNavigator(),
      });
      C.setPageLabel(pageNum);
      hasLoadedList = true;
    } catch (e) {
      if (myGen !== routeGen) return;
      Pages.renderListError(e, pageNum);
    }
  }

  async function loadSearchPage() {
    const myGen = routeGen;
    Pages.setHomeDiscoverMode(false);
    Pages.renderSearchLoading(searchQuery);
    highlightNav();
    try {
      const d = await Data.getSearchResults(searchQuery, pageNum);
      if (myGen !== routeGen) return; // navigated away: a newer route owns the page
      Pages.renderSearch({ query: searchQuery, page: pageNum, items: d.results || [], isInList: (id, mt) => Data.isInMyList(id, mt) });
      C.setPageLabel(pageNum);
      hasLoadedList = true;
    } catch (e) {
      if (myGen !== routeGen) return;
      Pages.renderSearchError(e);
    }
  }

  function loadMyList() {
    highlightNav();
    C.setNotice('');
    C.setPageLabel(1);
    Pages.renderMyList(Data.getMyList(), (id, mt) => Data.isInMyList(id, mt));
    hasLoadedList = true;
  }

  // Greybox collection page: config (structure + order) + Greybox API (data).
  // Unknown or hidden slugs render Not found, like any bad route.
  // Phase 5.3: the resolved set is cached per slug+config so ?media= filter
  // switches re-render instantly with no refetch; filtering itself is
  // in-memory inside renderCollection.
  function collectionConfigKey(col) {
    try { return JSON.stringify(col); } catch { return ''; }
  }

  // Filter control callback: filter state lives in the URL (?media=movie|tv,
  // absent = All) so back/forward/refresh preserve it. Same-filter clicks
  // no-op inside Router.navigate (identical URL), so no fetch loop is possible.
  function collectionFilterNav(f) {
    const slug = collectionSlug;
    const want = f === 'tv' ? 'tv' : (f === 'movie' ? 'movie' : 'all');
    const to = (R && R.url && typeof R.url.collection === 'function')
      ? R.url.collection(slug, want === 'all' ? null : want)
      : ('/collection/' + slug + (want === 'all' ? '' : '?media=' + want));
    navTo(to);
  }

  async function loadCollectionPage() {
    const myGen = routeGen;
    const col = Data.getCollection(collectionSlug);
    if (!col) {
      colView = null;
      Pages.renderNotFound('/collection/' + (collectionSlug || ''));
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
      return;
    }
    const filter = collectionMedia === 'tv' ? 'tv' : (collectionMedia === 'movie' ? 'movie' : 'all');
    const key = collectionConfigKey(col);
    // Same collection + config: re-render from accumulated results (filter
    // switches, back/forward) — no refetch, observer rebuilt below.
    if (colView && colView.slug === col.slug && colView.configKey === key && Array.isArray(colView.items)) {
      colView.filter = filter;
      renderCollectionView(colView);
      setupCollectionPaging(colView);
      return;
    }
    Pages.renderCollectionLoading(col.title);
    highlightNav();
    try {
      const res = await Data.resolveCollectionPage(col, 1);
      if (myGen !== routeGen) return; // navigated away: a newer route owns the page
      colView = newCollectionView(col, key, filter, res);
      renderCollectionView(colView);
      setupCollectionPaging(colView);
    } catch (e) {
      if (myGen !== routeGen) return;
      colView = null;
      Pages.renderCollectionError(col, e);
    }
  }

  // Dedupe key: media_type + TMDB id (a movie and a TV item stay distinct).
  // Mirrors the card fallback (title-bearing items read as movies) so the
  // accumulated set matches what cards would route to.
  function collectionItemKey(item) {
    const mt = (item && (item.media_type === 'movie' || item.media_type === 'tv'))
      ? item.media_type : ((item && item.title) ? 'movie' : 'tv');
    return mt + ':' + (item && item.id);
  }

  function shapeCollectionItem(item) {
    const mt = (item && (item.media_type === 'movie' || item.media_type === 'tv'))
      ? item.media_type : ((item && item.title) ? 'movie' : 'tv');
    return { ...item, media_type: mt };
  }

  function newCollectionView(col, key, filter, res) {
    const seen = new Set();
    const items = [];
    for (const x of ((res && res.items) || [])) {
      const k = collectionItemKey(x);
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(shapeCollectionItem(x));
    }
    const totalPages = Math.max(1, parseInt((res && res.totalPages) || 1, 10) || 1);
    const page = Math.max(1, parseInt((res && res.page) || 1, 10) || 1);
    return {
      slug: col.slug, configKey: key, col, filter, items, seen,
      page, totalPages, loadingPage: 0, done: page >= totalPages, observer: null,
    };
  }

  function renderCollectionView(view) {
    Pages.renderCollection({
      collection: view.col, items: view.items, filter: view.filter,
      onFilter: collectionFilterNav,
      isInList: (id, mt) => Data.isInMyList(id, mt),
    });
    if (R) document.title = `${view.col.title} — Greybox`;
    hasLoadedList = true;
  }

  function collectionShownCount(view) {
    if (!view || !Array.isArray(view.items)) return 0;
    if (view.filter === 'all') return view.items.length;
    return view.items.filter((x) => x && x.media_type === view.filter).length;
  }

  // One collection-level observer (never per-card, never a scroll handler).
  // rootMargin starts the next page early so users rarely see a wait.
  function setupCollectionPaging(view) {
    teardownCollectionPaging();
    if (!view || view.done) return;
    let target = null;
    try { target = document.getElementById('collection-more'); } catch (e) { target = null; }
    if (!target) return;
    if (typeof IntersectionObserver === 'undefined') return; // page 1 still renders
    const gen = routeGen;
    let ob = null;
    try {
      ob = new IntersectionObserver((entries) => {
        for (const en of (entries || [])) {
          if (!en || !en.isIntersecting) continue;
          if (gen !== routeGen) return; // navigation happened: this view is stale
          if (colView !== view) return; // view replaced
          loadNextCollectionPage();
        }
      }, { rootMargin: '1200px 0px' });
    } catch (e) { return; }
    view.observer = ob;
    try { ob.observe(target); } catch (e) { view.observer = null; }
  }

  function teardownCollectionPaging() {
    try {
      if (colView && colView.observer) colView.observer.disconnect();
    } catch (e) { /* observer optional */ }
    if (colView) { colView.observer = null; colView.loadingPage = 0; }
  }

  async function loadNextCollectionPage() {
    const view = colView;
    // One flight at a time: a page already loading (or finished) ignores
    // duplicate observer callbacks and rapid re-triggers.
    if (!view || view.done || view.loadingPage) return;
    if (view.page >= view.totalPages) {
      view.done = true;
      teardownCollectionPaging();
      try { Pages.showCollectionMoreEnd(); } catch (e) { /* noop */ }
      return;
    }
    const next = view.page + 1;
    const myGen = routeGen;
    view.loadingPage = next;
    Pages.showCollectionMoreLoading(6);
    try {
      const col = Data.getCollection(view.slug) || view.col;
      const res = await Data.resolveCollectionPage(col, next);
      // Stale (route changed or view replaced): never paint into a newer page.
      if (myGen !== routeGen || colView !== view) return;
      view.loadingPage = 0;
      const fresh = [];
      for (const x of ((res && res.items) || [])) {
        const k = collectionItemKey(x);
        if (view.seen.has(k)) continue;
        view.seen.add(k);
        const shaped = shapeCollectionItem(x);
        view.items.push(shaped);
        if (view.filter === 'all' || shaped.media_type === view.filter) fresh.push(shaped);
      }
      view.page = Math.max(1, parseInt((res && res.page) || next, 10) || next);
      view.totalPages = Math.max(1, parseInt((res && res.totalPages) || view.totalPages, 10) || view.totalPages);
      if (fresh.length) {
        Pages.appendCollectionItems(fresh, (id, mt) => Data.isInMyList(id, mt));
        Pages.updateCollectionMeta(view.col, collectionShownCount(view));
      }
      if (view.page >= view.totalPages) {
        view.done = true;
        teardownCollectionPaging();
        Pages.showCollectionMoreEnd();
      } else {
        Pages.clearCollectionMore();
      }
    } catch (e) {
      if (myGen !== routeGen || colView !== view) return;
      view.loadingPage = 0; // retry requests only this failed page
      try { console.warn('[collection] page failed:', (e && e.message) || e); } catch (ignored) { /* noop */ }
      Pages.showCollectionMoreError(() => loadNextCollectionPage());
    }
  }

  // Settings-save refresh: reload the background list in place (modal untouched),
  // exactly like the pre-refactor load() did.
  function reloadBackground() {
    if (mode === 'mylist') return loadMyList();
    if (mode === 'search') return loadSearchPage();
    if (mode === 'collection') { colView = null; return loadCollectionPage(); }
    return loadList();
  }

  /* ---------------- homepage extras: config -> Greybox API -> shelves + hero ---------------- */

  // Phase 5.5 unified discovery surface (homepage page 1): hero + the
  // config-driven shelves ONLY — the legacy grid/tabs/pager presentation is
  // hidden via setHomeDiscoverMode, not redesigned. Hero behavior is
  // unchanged: it follows the same source the grid showed (home tab, page 1,
  // first item), then the custom-hero override below may replace it, exactly
  // as when the grid was visible. Shelves resolve independently — one bad
  // shelf is skipped and never breaks the page (see getHomeSections).
  async function loadHomeDiscover() {
    const gen = routeGen;
    Pages.setHomeDiscoverMode(true);
    Pages.clearHomeSections();
    C.setNotice('');
    C.setHeroLoading(true);
    highlightNav();
    try {
      const data = await Data.getList('home', subTab, 1);
      if (gen !== routeGen) return; // navigated away: a newer route owns the page
      const items = (data && data.results) || [];
      heroItem = items[0] || null;
      if (heroItem) C.setHero(heroItem);
      else C.clearHeroLoading();
      hasLoadedList = true;
    } catch (e) {
      if (gen !== routeGen) return;
      heroItem = null;
      C.showHeroError(e && e.message ? e.message : String(e));
    }
    if (gen !== routeGen) return;
    await loadHomeExtras();
  }

  // Custom hero (optional spotlight) + config shelves for the discover
  // surface. Shelves/hero come from js/homepage.config.js (structure) with
  // items from the Greybox API (data); TMDB never decides what the homepage
  // contains. Any failure leaves the hero intact and shelves empty.
  async function loadHomeExtras() {
    const gen = routeGen;
    let cfg;
    try { cfg = Data.getHomeConfig(); }
    catch { Pages.clearHomeSections(); return; }
    // Custom hero (optional spotlight); failure keeps the grid hero.
    if (cfg.hero && cfg.hero.mode === 'custom') {
      try {
        const item = await Data.getHeroItem(cfg.hero);
        if (gen !== routeGen) return;
        if (item) {
          heroItem = item;
          C.setHero(item);
          if (cfg.hero.badge) $('hero-badge').textContent = cfg.hero.badge;
        }
      } catch { /* keep grid hero */ }
    }
    if (gen !== routeGen) return;
    try {
      const resolved = await Data.getHomeSections(cfg.sections);
      if (gen !== routeGen) return;
      Pages.renderHomeSections(resolved, (id, mt) => Data.isInMyList(id, mt));
    } catch { /* shelves stay empty, main grid already rendered */ }
  }

  /* ---------------- detail modal (OVERLAY, never a navigation) ----------------
   * Architecture (restored):
   *   CURRENT PAGE + MODAL ABOVE IT, not CURRENT -> DETAIL ROUTE -> BACK.
   * - Card click -> openDetailModal(id, mt): NO pushState/replaceState, NO
   *   navigate(), NO renderRoute(), NO window.location, NO scroll reset, NO
   *   grid/home-sections touch. Underlying DOM/page instance survives.
   * - Close (X/backdrop/Escape/m-back) -> closeDetailModal(): hide only,
   *   NEVER navigate/render/refetch/reconstruct. Scroll + shelf + filter stay.
   * - Standalone detail URLs (/movie/:id, /tv/:id, /person/:id) still exist
   *   as real router navigation (small "Details" link, deep links, hero,
   *   suggestions). renderRoute() for those boots a background list if needed
   *   then calls the SAME openDetail() below — the modal DOM is identical,
   *   only the URL differs because a real navigation happened first.
   * - No history entry is created for overlay opens (cleanest, per spec), so
   *   Back/Forward keep working for real routes only and never rebuild on
   *   modal close. popstate -> renderRoute stays untouched in router.js.
   */

  // Overlay open: card -> modal above the SAME page. No history, no routeGen
  // bump, no scroll/DOM touch outside the modal shell.
  async function openDetailModal(id, mt) {
    mt = mt === 'tv' ? 'tv' : 'movie';
    const myModal = ++modalGen;
    const myRoute = routeGen;
    C.setModalActionsVisible(true);
    C.showModal();
    C.showDetailLoading();
    currentSeasons = []; currentEpisodes = [];
    let d = null;
    try {
      d = mt === 'tv' ? await Data.getTVDetails(id) : await Data.getMovie(id);
      // Stale if a real navigation happened (routeGen) OR another card/modal
      // opened or closed (modalGen). Prevents stale detail paint (test 11)
      // and prevents a late fetch from reopening a user-closed modal.
      if (myModal !== modalGen || myRoute !== routeGen) return;
      currentDetail = { ...d, id, media_type: mt, kind: 'title' };
      highlightNav();
      if (R) document.title = `${d.title || d.name || (mt === 'tv' ? 'TV Show' : 'Movie')} (${id}) — Greybox`;
      Pages.renderTitleDetail({ detail: d, mediaType: mt, inList: Data.isInMyList(id, mt), region: Data.getRegion() });
      const trailerKey = d.trailer_key;
      $('m-trailer').onclick = () => {
        if (!trailerKey) return alert('No trailer on TMDB for this title.');
        $('m-video-wrap').classList.remove('hidden');
        $('m-video').src = `https://www.youtube.com/embed/${trailerKey}?autoplay=1`;
        $('m-video-wrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
      wireWatchButton();
      if (mt === 'tv') loadTvSeasons(id, d);
      else {
        const resume = Stream.resumeLabel('movie:' + id);
        if (resume && Stream.isConfigured('movie')) C.setStreamMessage(resume + ' — press Watch Now to continue.', true);
        else if (!Stream.isConfigured('movie')) C.setStreamMessage('No stream source configured yet. Put your official API streaming link here — open js/stream.js (EMBED.base in js/stream.js), or play the trailer below.');
      }
    } catch (e) {
      if (myModal !== modalGen || myRoute !== routeGen) return;
      console.error('[detail] failed for', mt + '/' + id, e);
      C.showDetailError((e && e.message ? e.message : String(e)));
    }
  }

  // Route-backed entry: called ONLY by renderRoute() after the background
  // list is ensured. Shares the overlay implementation — the modal is still
  // an overlay above the background, never a page replacement.
  async function openDetail(id, mt) {
    return openDetailModal(id, mt);
  }

  async function openPersonModal(id) {
    const myModal = ++modalGen;
    const myRoute = routeGen;
    C.setModalActionsVisible(false);
    C.showModal();
    C.showPersonLoading();
    currentSeasons = []; currentEpisodes = [];
    try {
      const { person, knownFor } = await Data.getPerson(id);
      if (myModal !== modalGen || myRoute !== routeGen) return;
      currentDetail = { kind: 'person', id, media_type: 'person' };
      highlightNav();
      if (R) document.title = `${person.name || 'Person'} (${id}) — Greybox`;
      Pages.renderPerson({ person, knownFor, onSelect: (pid, mt) => navTo(detailURL(pid, mt)) });
    } catch (e) {
      if (myModal !== modalGen || myRoute !== routeGen) return;
      console.error('[person] failed for person/' + id, e);
      C.showPersonError((e && e.message ? e.message : String(e)));
    }
  }

  async function openPerson(id) {
    return openPersonModal(id);
  }

  function hideModal() { C.hideModal(); }
  // Player paths hide the modal to open the player engine (unchanged); they
  // keep currentDetail/currentEpisodes for Prev/Next and never navigate.
  function closeDetail() { hideModal(); }

  // User-facing close: X / backdrop / Escape / m-back. Hide ONLY — never
  // navigate(), never renderRoute(), never history.back(), never
  // window.location, never reload, never refetch/reconstruct the parent.
  // Bumps modalGen so a late in-flight fetch cannot repaint/reopen the modal
  // after the user dismissed it. Restores the title for the CURRENT route
  // (overlay: parent title; standalone URL: detail title stays, URL untouched).
  function closeDetailModal() {
    modalGen++;
    hideModal();
    try {
      if (R) document.title = R.titleFor(R.current());
    } catch { /* title restore optional */ }
  }

  // Legacy name kept as a pure alias (no navigation) for any existing wiring.
  function userCloseDetail() {
    closeDetailModal();
  }

  /* ---------------- watch / episodes (player engine untouched) ---------------- */

  function wireWatchButton() {
    $('m-watch').onclick = () => {
      if (!currentDetail) return;
      if (currentDetail.media_type === 'movie') playMovie();
      else {
        // TV: scroll to episodes; play first episode if source configured
        $('m-tv-wrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (currentEpisodes.length && Stream.isConfigured('tv')) playEpisode(currentEpisodes[0]);
        else if (!Stream.isConfigured('tv')) C.setStreamMessage('Pick an episode below. To enable playback, put your official API streaming link here — open js/stream.js (EMBED.base in js/stream.js).');
      }
    };
  }

  function playMovie() {
    const d = currentDetail;
    const url = Stream.getMovieUrl(d.id);
    if (!url) { C.setStreamMessage('No stream source configured yet. Put your official API streaming link here — open js/stream.js (EMBED.base in js/stream.js). Trailers play without it.'); return; }
    C.setStreamMessage('');
    closeDetail();
    Stream.Player.open({
      title: d.title || d.name || 'Movie',
      sub: 'Movie',
      url,
      mode: 'embed',
      progressKey: 'movie:' + d.id,
    });
  }

  async function loadTvSeasons(tmdbId, detail) {
    // Route+modal-safe: seasons/episodes resolve through the same dual
    // generation mechanism as the detail fetch — a late resolve for a
    // previous title must never paint into the modal owned by a newer
    // overlay (modalGen) or a newer route (routeGen). routeGen preserved.
    const myGen = routeGen;
    const myModal = modalGen;
    const owner = currentDetail;
    currentSeasons = (detail.seasons || []).filter((s) => s.season_number >= 0);
    if (!currentSeasons.length) return;
    if (myGen !== routeGen || myModal !== modalGen || currentDetail !== owner) return;
    currentSeasonNum = Pages.renderSeasons(currentSeasons);
    $('m-season').onchange = () => { currentSeasonNum = +$('m-season').value; loadEpisodes(tmdbId, currentSeasonNum); };
    loadEpisodes(tmdbId, currentSeasonNum);
    if (!Stream.isConfigured('tv')) C.setStreamMessage('Episode list loaded from TMDB. Playback needs you to put your official API streaming link here — open js/stream.js (EMBED.base in js/stream.js) — links left blank until then.');
  }

  async function loadEpisodes(tmdbId, seasonNum) {
    const myGen = routeGen;
    const myModal = modalGen;
    const owner = currentDetail;
    Pages.renderEpisodesLoading();
    try {
      const s = await Data.getSeason(tmdbId, seasonNum);
      // Stale (route changed, newer overlay/close, or newer title): never paint.
      if (myGen !== routeGen || myModal !== modalGen || currentDetail !== owner) return;
      currentEpisodes = s.episodes || [];
      Pages.renderEpisodes({
        tmdbId, seasonNum,
        episodes: currentEpisodes,
        configured: Stream.isConfigured('tv'),
        resumeLabel: (key) => Stream.resumeLabel(key),
        onPlay: (ep) => playEpisode(ep),
      });
    } catch {
      if (myGen !== routeGen || myModal !== modalGen || currentDetail !== owner) return;
      Pages.renderEpisodesError();
    }
  }

  function playEpisode(ep) {
    const d = currentDetail;
    const seasonNum = +($('m-season').value || currentSeasonNum || 1);
    const url = Stream.getEpisodeUrl(d.id, seasonNum, ep.episode_number);
    if (!url) { C.setStreamMessage('No stream source configured yet. Put your official API streaming link here — open js/stream.js (EMBED.base in js/stream.js).'); return; }
    C.setStreamMessage('');
    const title = d.name || d.title || 'Show';
    closeDetail();
    Stream.Player.open({
      title,
      sub: `S${seasonNum} E${ep.episode_number} · ${ep.name || ''}`,
      url,
      mode: 'embed',
      progressKey: `tv:${d.id}:${seasonNum}:${ep.episode_number}`,
      showPrevNext: true,
      onEnded: () => autoNext(seasonNum, ep.episode_number),
    });
  }

  function stepEpisode(dir) {
    const cur = Stream.Player.current();
    if (!cur || !currentDetail || !currentEpisodes.length) return;
    const m = /S(\d+)\s*E(\d+)/.exec(cur.sub || '');
    const epNum = m ? +m[2] : null;
    const idx = currentEpisodes.findIndex((x) => x.episode_number === epNum);
    const next = currentEpisodes[idx + dir];
    if (!next) { C.setStreamMessage(dir > 0 ? 'That was the last listed episode of this season.' : 'Already at the first episode.'); return; }
    playEpisodeFromPlayer(next);
  }

  function playEpisodeFromPlayer(ep) {
    const d = currentDetail;
    const seasonNum = currentSeasonNum;
    const url = Stream.getEpisodeUrl(d.id, seasonNum, ep.episode_number);
    if (!url) return;
    Stream.Player.open({
      title: d.name || d.title || 'Show',
      sub: `S${seasonNum} E${ep.episode_number} · ${ep.name || ''}`,
      url,
      mode: 'embed',
      progressKey: `tv:${d.id}:${seasonNum}:${ep.episode_number}`,
      showPrevNext: true,
      onEnded: () => autoNext(seasonNum, ep.episode_number),
    });
  }

  function autoNext(seasonNum, epNum) {
    const idx = currentEpisodes.findIndex((x) => x.episode_number === epNum);
    const next = currentEpisodes[idx + 1];
    if (!next) return; // season finished — leave player open at ended state
    if (!Stream.getEpisodeUrl(currentDetail.id, seasonNum, next.episode_number)) return;
    playEpisodeFromPlayer(next);
  }

  // ---- player: custom files route through the same engine ----
  function playFile(url, title) {
    closeDetail();
    Stream.Player.open({ title, sub: 'Direct file', url, progressKey: 'file:' + url.length + ':' + [...url].reduce((a, c) => a + c.charCodeAt(0), 0) % 100000 });
  }
  function closePlayer() { Stream.Player.close(); }

  /* ---------------- route renderer (single entry for ALL navigation) ---------------- */
  async function renderRoute(route) {
    if (!route) route = R ? R.current() : { name: 'home', tab: 'trending', page: 1, path: '/' };
    const myGen = ++routeGen; // this navigation invalidates all older async page work
    teardownCollectionPaging(); // disconnect the previous collection observer, if any
    lastRouteName = route.name;
    if (R) document.title = R.titleFor(route);
    // Keep the header search box in sync with /search?q=... (but never clobber typing elsewhere).
    try {
      if (route.name === 'search' && document.activeElement !== $('search')) $('search').value = route.q || '';
    } catch { /* noop */ }

    if (route.name === 'home') {
      hideModal(); currentDetail = null;
      mode = 'home'; subTab = route.tab || 'trending'; pageNum = route.page || 1;
      window.scrollTo({ top: 0 });
      Pages.clearHomeSections();
      // Phase 5.5: page 1 is the unified discovery surface (config-driven
      // shelves through the common section renderer — no legacy grid). Deeper
      // pages keep the classic single-grid browser so ?page= links resolve.
      if (pageNum === 1) { await loadHomeDiscover(); return; }
      await loadList();
      return;
    }
    if (route.name === 'movies') {
      hideModal(); currentDetail = null;
      mode = 'movie'; subTab = kebabToSnake(route.cat || 'popular'); pageNum = route.page || 1;
      window.scrollTo({ top: 0 });
      Pages.clearHomeSections();
      await loadList();
      return;
    }
    if (route.name === 'tv') {
      hideModal(); currentDetail = null;
      mode = 'tv'; subTab = kebabToSnake(route.cat || 'popular'); pageNum = route.page || 1;
      window.scrollTo({ top: 0 });
      Pages.clearHomeSections();
      await loadList();
      return;
    }
    if (route.name === 'anime') {
      hideModal(); currentDetail = null;
      mode = 'anime'; subTab = animeKindToSub(route.kind || 'series'); pageNum = route.page || 1;
      window.scrollTo({ top: 0 });
      Pages.clearHomeSections();
      await loadList();
      return;
    }
    if (route.name === 'mylist') {
      hideModal(); currentDetail = null;
      mode = 'mylist'; pageNum = 1;
      window.scrollTo({ top: 0 });
      Pages.clearHomeSections();
      loadMyList();
      return;
    }
    if (route.name === 'search') {
      hideModal(); currentDetail = null;
      mode = 'search'; searchQuery = route.q || ''; pageNum = route.page || 1;
      window.scrollTo({ top: 0 });
      Pages.clearHomeSections();
      await loadSearchPage();
      return;
    }
    if (route.name === 'collection') {
      hideModal(); currentDetail = null;
      // Same-slug filter switches (?media=) must not yank scroll: the user is
      // already looking at this collection's catalog.
      const sameCollection = mode === 'collection' && collectionSlug === (route.slug || '');
      mode = 'collection'; collectionSlug = route.slug || ''; pageNum = 1;
      collectionMedia = route.media === 'tv' ? 'tv' : (route.media === 'movie' ? 'movie' : null);
      if (!sameCollection) window.scrollTo({ top: 0 });
      Pages.clearHomeSections();
      await loadCollectionPage();
      return;
    }
    if (route.name === 'movie-detail' || route.name === 'tv-detail') {
      const mt = route.name === 'tv-detail' ? 'tv' : 'movie';
      // Background list: keep the current grid for in-app navigation so Back
      // returns to exactly where the user was. On direct load / refresh (no
      // list yet), boot a sensible background first without touching the URL.
      if (!hasLoadedList) {
        mode = 'home'; subTab = 'trending'; pageNum = 1;
        await loadList();
        if (myGen !== routeGen) return; // navigated away while booting
      }
      await openDetail(route.id, mt);
      return;
    }
    if (route.name === 'person') {
      if (!hasLoadedList) {
        mode = 'home'; subTab = 'trending'; pageNum = 1;
        await loadList();
        if (myGen !== routeGen) return; // navigated away while booting
      }
      await openPerson(route.id);
      return;
    }
    hideModal(); currentDetail = null;
    Pages.clearHomeSections();
    Pages.renderNotFound(route.path);
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
  }

  // ---- events ----
  // NAVIGATION SEPARATION (overlay architecture):
  // - Card (anywhere except the small link/list-btn) -> openDetailModal():
  //   overlay above the SAME page. NO navigate(), NO history, NO renderRoute.
  // - Small explicit link <a data-detail-link href="/movie/:id|/tv/:id"> ->
  //   real standalone detail URL via normal router navigation (untouched here;
  //   Router's link interception handles it). Must NOT open the overlay and
  //   must NOT be preventDefaulted here, or Back/new-tab/deep-link breaks.
  document.addEventListener('click', (e) => {
    const lb = e.target.closest('.list-btn');
    if (lb) {
      e.stopPropagation();
      const id = +lb.dataset.id, mt = lb.dataset.type;
      // need minimal item: find in DOM? store title from card
      const card = lb.closest('.card');
      const title = card ? card.querySelector('.font-semibold').textContent : 'Title';
      const img = card ? card.querySelector('img').src : '';
      const added = Data.toggleMyListItem({ id, media_type: mt, title, name: title, poster_path: img.includes('image.tmdb') ? img.split('/w500')[1] : null });
      lb.textContent = added ? '★' : '☆';
      updateCount(); return;
    }
    // Small detail link: let the router perform real URL navigation.
    // Do NOT open the modal, do NOT preventDefault, do NOT stopPropagation —
    // Router's click interception owns this path (incl. new-tab/modifier keys).
    if (e.target.closest && e.target.closest('a[data-detail-link]')) return;
    const card = e.target.closest('.card[data-id]');
    // Card itself is overlay-only: modal above current page, URL untouched.
    if (card) { openDetailModal(+card.dataset.id, card.dataset.type); return; }
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      const key = nav.dataset.nav;
      if (key === 'home') navTo(R ? R.url.home('trending', 1) : '/');
      else if (key === 'movie') navTo(R ? R.url.movies('popular', 1) : '/movies');
      else if (key === 'tv') navTo(R ? R.url.tv('popular', 1) : '/tv');
      else if (key === 'anime') navTo(R ? R.url.anime('series', 1) : '/anime');
      else if (key === 'mylist') navTo(R ? R.url.mylist() : '/mylist');
      else navTo('/');
      return;
    }
  });

  // Modal close is hide-only (closeDetailModal): never navigate/render/refetch.
  $('modal-close').addEventListener('click', (e) => { e.stopPropagation(); closeDetailModal(); });
  $('modal-bg').addEventListener('click', closeDetailModal);
  // Phase 6.1 quiet-error back button: same hide-only close path as ✕/backdrop.
  try { const mb = $('m-back'); if (mb) mb.onclick = () => closeDetailModal(); } catch { /* back button optional */ }
  $('player-close').onclick = closePlayer;
  $('ep-prev').onclick = () => stepEpisode(-1);
  $('ep-next').onclick = () => stepEpisode(1);
  // Pager is navigation: ?page=N stays in the URL so refresh/deep-links keep it.
  $('prev').onclick = () => { if (pageNum > 1) navTo(currentListURL(pageNum - 1)); };
  $('next').onclick = () => { navTo(currentListURL(pageNum + 1)); };
  // Hero actions (Phase 2): Watch uses the existing Stream behavior for movies
  // (direct embed when configured) and falls back to the detail route;
  // More Info always uses the existing movie/TV detail route. No route changes.
  function heroMedia(item) { return item.media_type || (item.title ? 'movie' : 'tv'); }
  function watchHeroItem(item) {
    const mt = heroMedia(item);
    try {
      if (mt === 'movie' && window.Stream && typeof window.Stream.getMovieUrl === 'function') {
        const url = window.Stream.getMovieUrl(item.id);
        if (url && window.Stream.Player && typeof window.Stream.Player.open === 'function') {
          window.Stream.Player.open({
            title: item.title || item.name || 'Movie',
            sub: 'Movie',
            url,
            mode: 'embed',
            progressKey: 'movie:' + item.id,
          });
          return;
        }
      }
    } catch (e) { /* fall through to detail route */ }
    navTo(detailURL(item.id, mt));
  }
  try {
    if (window.GreyboxHero && typeof window.GreyboxHero.bind === 'function') {
      window.GreyboxHero.bind({
        onWatch: (item) => watchHeroItem(item),
        onInfo: (item) => navTo(detailURL(item.id, heroMedia(item))),
        onToggleList: (item) => {
          const added = Data.toggleMyListItem({ ...item, media_type: heroMedia(item) });
          updateCount();
          return added;
        },
        isInList: (id, mt) => Data.isInMyList(id, mt),
      });
    } else {
      $('hero-play').onclick = () => heroItem && navTo(detailURL(heroItem.id, heroMedia(heroItem)));
      if ($('hero-info')) $('hero-info').onclick = () => heroItem && navTo(detailURL(heroItem.id, heroMedia(heroItem)));
      $('hero-list').onclick = () => {
        if (!heroItem) return;
        Data.toggleMyListItem({ ...heroItem, media_type: heroMedia(heroItem) }); updateCount();
      };
    }
  } catch (e) {
    try {
      $('hero-play').onclick = () => heroItem && navTo(detailURL(heroItem.id, heroMedia(heroItem)));
      $('hero-list').onclick = () => {
        if (!heroItem) return;
        Data.toggleMyListItem({ ...heroItem, media_type: heroMedia(heroItem) }); updateCount();
      };
    } catch (ignored) { /* hero optional */ }
  }
  $('m-list').onclick = () => { if (currentDetail) { const added = Data.toggleMyListItem(currentDetail); $('m-list').textContent = added ? '★ In My List' : '+ My List'; $('m-list').classList.toggle('is-in-list', added); updateCount(); } };
  $('custom-play').onclick = () => {
    const u = $('custom-url').value.trim();
    if (!u) return alert('Paste an .m3u8 or .mp4 URL you own.');
    playFile(u, ($('m-title').textContent || 'Custom') + ' (custom file)');
  };

  // search: dropdown suggestions fetch via data.js, render via components —
  // every destination is still a route.
  let deb = null;
  $('search').addEventListener('input', (e) => {
    clearTimeout(deb);
    const q = e.target.value.trim();
    const box = $('search-results');
    if (!q) { box.classList.add('hidden'); return; }
    deb = setTimeout(async () => {
      try {
        const d = await Data.getSuggestions(q, 8);
        box.innerHTML = C.suggestionsHTML(d.results);
        box.classList.remove('hidden');
        box.querySelectorAll('.sr').forEach((el) => { el.onclick = () => { box.classList.add('hidden'); $('search').value = ''; navTo(detailURL(+el.dataset.id, el.dataset.type)); }; });
      } catch (err) { box.innerHTML = C.suggestionErrorHTML(err); box.classList.remove('hidden'); }
    }, 350);
  });
  // Enter commits the query as a real URL: /search?q=... (refreshable, shareable).
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = e.target.value.trim();
      if (!q) return;
      $('search-results').classList.add('hidden');
      navTo(R ? R.url.search(q, 1) : ('/search?q=' + encodeURIComponent(q)));
    }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#search') && !e.target.closest('#search-results')) $('search-results').classList.add('hidden'); });

  // settings
  $('settings-btn').onclick = () => { $('settings').classList.remove('hidden'); $('tmdb-token').value = API.getToken(); $('region').value = API.getRegion(); };
  document.querySelectorAll('[data-close-settings]').forEach((b) => { b.onclick = () => $('settings').classList.add('hidden'); });
  $('save-settings').onclick = () => {
    localStorage.setItem(API.LS_TOKEN, $('tmdb-token').value.trim());
    localStorage.setItem(API.LS_REGION, ($('region').value.trim() || 'US').toUpperCase());
    $('settings').classList.add('hidden'); reloadBackground();
  };

  // Escape closes the overlay without touching the parent page: no
  // navigate/render/refetch — just hide. Player/settings close alongside.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDetailModal(); closePlayer(); $('settings').classList.add('hidden'); } });

  // ---- interaction protection (lightweight): no right-click menu, text
  // selection, copy, cut, paste, drag-out, or long-press menus on the page
  // and player container. Exceptions: paste/cut stay allowed in the search
  // box (#search). Scrolling, video playback, and player controls are left
  // alone (no key, touch-action, or pointer-events interference). The player
  // iframe may be cross-origin, so this only guards our own page/container —
  // it never touches the iframe's internal document. ----
  (function protect() {
    const inSearch = (el) => !!(el && el.closest && el.closest('#search, #collections-search'));
    const inField = (el) => !!(el && el.closest && el.closest('input,textarea,select,[contenteditable="true"]'));
    // right-click / long-press menu: blocked everywhere except search (so mouse-paste works there)
    document.addEventListener('contextmenu', (e) => {
      if (!inSearch(e.target)) e.preventDefault();
    });
    // text selection: blocked page-wide except inside editable fields
    document.addEventListener('selectstart', (e) => {
      if (!inField(e.target)) e.preventDefault();
    });
    // copy: blocked everywhere (covers Ctrl+C / Cmd+C / long-press copy)
    document.addEventListener('copy', (e) => e.preventDefault());
    // cut: blocked everywhere except search (keeps search editable)
    document.addEventListener('cut', (e) => {
      if (!inSearch(e.target)) e.preventDefault();
    });
    // paste: allowed ONLY in search, blocked in all other inputs
    document.addEventListener('paste', (e) => {
      if (!inSearch(e.target)) e.preventDefault();
    });
    // drag-out (images/text): blocked except from search
    document.addEventListener('dragstart', (e) => {
      if (!inSearch(e.target)) e.preventDefault();
    });
  })();

  /* ---- boot: router owns the initial render so refresh/direct-URL work ---- */
  updateCount();
  try { window.addEventListener('greybox:mylist', updateCount); } catch { /* noop */ }
  try { if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual'; } catch { /* noop */ }
  // Greybox-owned config (D1) loads first so homepage, collections, footer
  // links and overrides reflect the database. Local config files cover any
  // failure — and preloadGreyboxConfig itself never rejects, so the first
  // render always happens.
  Data.preloadGreyboxConfig().then(() => {
    renderFooter();
    if (R) {
      R.init();
      R.onChange((route) => { renderRoute(route); });
      renderRoute(R.current());
    } else {
      renderRoute({ name: 'home', tab: 'trending', page: 1, path: '/' });
    }
  });

  // Headless/test hook (no UI effect): lets node-based checks drive the
  // route->state mapping without a browser. Overlay hooks exposed for the
  // modal regression tests (open hides nothing, close renders nothing).
  try { window.GreyboxApp = window.GreyboxApp || {}; window.GreyboxApp.renderRoute = renderRoute; window.GreyboxApp.openDetailModal = openDetailModal; window.GreyboxApp.closeDetailModal = closeDetailModal; window.GreyboxApp.openPersonModal = openPersonModal; } catch { /* noop */ }
})();
