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
  let heroItem = null;
  let currentDetail = null; // {...} + media_type, or {kind:'person', id}
  let currentSeasons = [];
  let currentEpisodes = [];
  let currentSeasonNum = 1;
  let hasLoadedList = false;
  let lastRouteName = '';
  let homeGen = 0; // guards async shelf/hero fills against fast navigation

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
    Pages.renderListLoading(pageNum);
    Pages.renderListChrome(mode, subTab, tabNavigator());
    C.setPageLabel(pageNum);
    highlightNav();
    try {
      const data = await Data.getList(mode, subTab, pageNum);
      heroItem = Pages.renderList({
        mode, subTab, page: pageNum,
        items: data.results || [],
        isInList: (id, mt) => Data.isInMyList(id, mt),
        onTab: tabNavigator(),
      });
      C.setPageLabel(pageNum);
      hasLoadedList = true;
    } catch (e) {
      Pages.renderListError(e, pageNum);
    }
  }

  async function loadSearchPage() {
    Pages.renderSearchLoading(searchQuery);
    highlightNav();
    try {
      const d = await Data.getSearchResults(searchQuery, pageNum);
      Pages.renderSearch({ query: searchQuery, page: pageNum, items: d.results || [], isInList: (id, mt) => Data.isInMyList(id, mt) });
      C.setPageLabel(pageNum);
      hasLoadedList = true;
    } catch (e) {
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
  async function loadCollectionPage() {
    const col = Data.getCollection(collectionSlug);
    if (!col) {
      Pages.renderNotFound('/collection/' + (collectionSlug || ''));
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
      return;
    }
    Pages.renderCollectionLoading(col.title);
    highlightNav();
    try {
      const { items } = await Data.resolveCollection(col);
      Pages.renderCollection({ collection: col, items, isInList: (id, mt) => Data.isInMyList(id, mt) });
      if (R) document.title = `${col.title} — Greybox`;
      hasLoadedList = true;
    } catch (e) {
      Pages.renderCollectionError(col, e);
    }
  }

  // Settings-save refresh: reload the background list in place (modal untouched),
  // exactly like the pre-refactor load() did.
  function reloadBackground() {
    if (mode === 'mylist') return loadMyList();
    if (mode === 'search') return loadSearchPage();
    if (mode === 'collection') return loadCollectionPage();
    return loadList();
  }

  /* ---------------- homepage extras: config -> Greybox API -> shelves + hero ---------------- */

  // Runs after the main home grid. Shelves/hero come from js/homepage.config.js
  // (structure) with items from the Greybox API (data); TMDB never decides
  // what the homepage contains. Any failure leaves the main grid intact.
  async function loadHomeExtras() {
    const gen = homeGen;
    let cfg;
    try { cfg = Data.getHomeConfig(); }
    catch { Pages.clearHomeSections(); return; }
    // Custom hero (optional spotlight); failure keeps the grid hero.
    if (cfg.hero && cfg.hero.mode === 'custom') {
      try {
        const item = await Data.getHeroItem(cfg.hero);
        if (gen !== homeGen) return;
        if (item) {
          heroItem = item;
          C.setHero(item);
          if (cfg.hero.badge) $('hero-badge').textContent = cfg.hero.badge;
        }
      } catch { /* keep grid hero */ }
    }
    if (gen !== homeGen) return;
    try {
      const resolved = await Data.getHomeSections(cfg.sections);
      if (gen !== homeGen) return;
      Pages.renderHomeSections(resolved, (id, mt) => Data.isInMyList(id, mt));
    } catch { /* shelves stay empty, main grid already rendered */ }
  }

  /* ---------------- detail pages: fetch (data.js) -> render (pages.js) ---------------- */
  // NOTE: these never push history — callers navigate first, the router calls back.

  async function openDetail(id, mt) {
    mt = mt === 'tv' ? 'tv' : 'movie';
    C.setModalActionsVisible(true);
    C.showModal();
    C.showDetailLoading();
    currentSeasons = []; currentEpisodes = [];
    let d = null;
    try {
      d = mt === 'tv' ? await Data.getTVDetails(id) : await Data.getMovie(id);
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
      console.error('[detail] failed for', mt + '/' + id, e);
      C.showDetailError((e && e.message ? e.message : String(e)));
    }
  }

  async function openPerson(id) {
    C.setModalActionsVisible(false);
    C.showModal();
    C.showPersonLoading();
    currentSeasons = []; currentEpisodes = [];
    try {
      const { person, knownFor } = await Data.getPerson(id);
      currentDetail = { kind: 'person', id, media_type: 'person' };
      highlightNav();
      if (R) document.title = `${person.name || 'Person'} (${id}) — Greybox`;
      Pages.renderPerson({ person, knownFor, onSelect: (pid, mt) => navTo(detailURL(pid, mt)) });
    } catch (e) {
      console.error('[person] failed for person/' + id, e);
      C.showPersonError((e && e.message ? e.message : String(e)));
    }
  }

  function hideModal() { C.hideModal(); }
  function closeDetail() { hideModal(); }

  function userCloseDetail() {
    // User pressed X / backdrop / Escape on a detail/person URL:
    // go back when this detail was reached in-app, else land on a list URL
    // so a direct-URL load still has somewhere sensible to go.
    const route = R ? R.current() : null;
    const isDetail = route && (route.name === 'movie-detail' || route.name === 'tv-detail' || route.name === 'person');
    if (!isDetail) { hideModal(); return; }
    const fallback = route.name === 'movie-detail' ? '/movies'
      : route.name === 'tv-detail' ? '/tv' : '/';
    if (R && R.hasInAppHistory()) { try { window.history.back(); return; } catch { /* fall through */ } }
    hideModal();
    navTo(fallback);
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
    currentSeasons = (detail.seasons || []).filter((s) => s.season_number >= 0);
    if (!currentSeasons.length) return;
    currentSeasonNum = Pages.renderSeasons(currentSeasons);
    $('m-season').onchange = () => { currentSeasonNum = +$('m-season').value; loadEpisodes(tmdbId, currentSeasonNum); };
    loadEpisodes(tmdbId, currentSeasonNum);
    if (!Stream.isConfigured('tv')) C.setStreamMessage('Episode list loaded from TMDB. Playback needs you to put your official API streaming link here — open js/stream.js (EMBED.base in js/stream.js) — links left blank until then.');
  }

  async function loadEpisodes(tmdbId, seasonNum) {
    Pages.renderEpisodesLoading();
    try {
      const s = await Data.getSeason(tmdbId, seasonNum);
      currentEpisodes = s.episodes || [];
      Pages.renderEpisodes({
        tmdbId, seasonNum,
        episodes: currentEpisodes,
        configured: Stream.isConfigured('tv'),
        resumeLabel: (key) => Stream.resumeLabel(key),
        onPlay: (ep) => playEpisode(ep),
      });
    } catch { Pages.renderEpisodesError(); }
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
    lastRouteName = route.name;
    if (R) document.title = R.titleFor(route);
    // Keep the header search box in sync with /search?q=... (but never clobber typing elsewhere).
    try {
      if (route.name === 'search' && document.activeElement !== $('search')) $('search').value = route.q || '';
    } catch { /* noop */ }

    if (route.name === 'home') {
      hideModal(); currentDetail = null;
      mode = 'home'; subTab = route.tab || 'trending'; pageNum = route.page || 1;
      homeGen++;
      window.scrollTo({ top: 0 });
      Pages.clearHomeSections();
      await loadList();
      // Config shelves + custom hero live on page 1 only; deeper pages keep
      // the classic single-grid browser.
      if (pageNum === 1) await loadHomeExtras();
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
      mode = 'collection'; collectionSlug = route.slug || ''; pageNum = 1;
      window.scrollTo({ top: 0 });
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
      }
      await openDetail(route.id, mt);
      return;
    }
    if (route.name === 'person') {
      if (!hasLoadedList) {
        mode = 'home'; subTab = 'trending'; pageNum = 1;
        await loadList();
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
    const card = e.target.closest('.card[data-id]');
    // Cards are navigation — the URL becomes /movie/:id or /tv/:id.
    if (card) { navTo(detailURL(+card.dataset.id, card.dataset.type)); return; }
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

  $('modal-close').addEventListener('click', (e) => { e.stopPropagation(); userCloseDetail(); });
  $('modal-bg').addEventListener('click', userCloseDetail);
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
  $('m-list').onclick = () => { if (currentDetail) { const added = Data.toggleMyListItem(currentDetail); $('m-list').textContent = added ? '★ In My List' : '+ My List'; updateCount(); } };
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

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { userCloseDetail(); closePlayer(); $('settings').classList.add('hidden'); } });

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
  // route->state mapping without a browser.
  try { window.GreyboxApp = window.GreyboxApp || {}; window.GreyboxApp.renderRoute = renderRoute; } catch { /* noop */ }
})();
