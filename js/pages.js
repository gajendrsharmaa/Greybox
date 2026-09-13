/* Greybox page renderers — data in, HTML out. No fetching, no Router.
 *
 * Each function takes already-fetched data (from js/data.js, passed by the
 * controller in js/app.js) and renders it with shared helpers from
 * js/components.js. Visual output is identical to the pre-refactor app:
 * same headings, same cards, same modal fields, same copy.
 *
 * Behaviour callbacks (tab select, episode play, known-for select) are
 * injected by the controller so renderers never navigate or play directly.
 */
(function () {
  'use strict';

  function C() {
    if (!window.GreyboxComponents) throw new Error('GreyboxComponents not loaded (components.js before pages.js).');
    return window.GreyboxComponents;
  }

  function $(id) { return document.getElementById(id); }

  /* ---------------- headings + tabs (exact pre-refactor copy) ---------------- */

  const TITLES = {
    home: { trending: 'Trending Now', 'popular-movie': 'Popular Movies', 'popular-tv': 'Popular TV', top: 'Top Rated Movies' },
    movie: { popular: 'Popular Movies', top_rated: 'Top Rated Movies', upcoming: 'Upcoming Movies', now_playing: 'Now Playing' },
    tv: { popular: 'Popular TV', top_rated: 'Top Rated TV', on_the_air: 'On The Air', airing_today: 'Airing Today' },
    anime: { 'tv-anime': 'Anime Series', 'movie-anime': 'Anime Movies' },
  };

  const TABS = {
    home: [['trending', 'Trending'], ['popular-movie', 'Movies'], ['popular-tv', 'TV'], ['top', 'Top Rated']],
    movie: [['popular', 'Popular'], ['top_rated', 'Top Rated'], ['upcoming', 'Upcoming'], ['now_playing', 'Now Playing']],
    tv: [['popular', 'Popular'], ['top_rated', 'Top Rated'], ['on_the_air', 'On Air'], ['airing_today', 'Airing Today']],
    anime: [['tv-anime', 'Anime Series'], ['movie-anime', 'Anime Movies']],
  };

  function headingFor(mode, subTab) {
    if (mode === 'home') return TITLES.home[subTab] || TITLES.home.top;
    if (mode === 'movie') return TITLES.movie[subTab];
    if (mode === 'tv') return TITLES.tv[subTab];
    if (mode === 'anime') return subTab === 'tv-anime' ? TITLES.anime['tv-anime'] : TITLES.anime['movie-anime'];
    return '';
  }

  /* ---------------- generic list page ---------------- */

  // Renders heading + tabs + grid + pager + hero. Returns the hero item
  // (first result on page 1) so the controller can wire hero-play/list.
  // ctx: { mode, subTab, page, items, isInList(id, mt), onTab(subTab) }
  function renderList(ctx) {
    const c = C();
    setCollectionChrome(false);
    c.setSectionTitle(headingFor(ctx.mode, ctx.subTab));
    c.setPageLabel(ctx.page);
    c.renderTabs(TABS[ctx.mode] || [], ctx.subTab, ctx.onTab);
    const items = Array.isArray(ctx.items) ? ctx.items : [];
    $('grid').innerHTML = c.cardsHTML(items, ctx.isInList) || '<div class="gx-empty">No results.</div>';
    if (ctx.page === 1 && items[0]) {
      c.setHero(items[0]);
      return items[0];
    }
    c.clearHeroLoading();
    return null;
  }

  function renderListLoading(page) {
    const c = C();
    c.setNotice('');
    c.showGridLoading(12);
    c.setHeroLoading(page === 1);
  }

  // Instant heading + tabs before the fetch resolves (pre-refactor load()
  // painted tabs synchronously, then filled the grid when data arrived).
  function renderListChrome(mode, subTab, onTab) {
    const c = C();
    setCollectionChrome(false);
    c.setSectionTitle(headingFor(mode, subTab));
    c.renderTabs(TABS[mode] || [], subTab, onTab);
  }

  function renderListError(err, page) {
    const c = C();
    $('grid').innerHTML = '';
    c.clearHeroLoading();
    if (page === 1) c.showHeroError(err && err.message ? err.message : String(err));
    c.showErrorNotice(err);
  }

  /* ---------------- search page ---------------- */

  // ctx: { query, page, items, isInList }
  function renderSearch(ctx) {
    const c = C();
    setCollectionChrome(false);
    c.setSectionTitle(ctx.query ? `Results for “${ctx.query}”` : 'Search');
    c.clearTabs();
    c.setPageLabel(ctx.page);
    c.clearHeroLoading();
    if (!ctx.query) {
      $('grid').innerHTML = '<div class="text-zinc-500 col-span-full">Type in the search box above, or open a URL like <code>/search?q=dune</code>.</div>';
      return;
    }
    const items = Array.isArray(ctx.items) ? ctx.items : [];
    $('grid').innerHTML = c.cardsHTML(items, ctx.isInList) || '<div class="gx-empty">No matches.</div>';
  }

  function renderSearchLoading(query) {
    const c = C();
    setCollectionChrome(false);
    c.setNotice('');
    c.setSectionTitle(query ? `Results for “${query}”` : 'Search');
    c.clearTabs();
    c.showGridLoading(12);
    c.setHeroLoading(false);
    c.clearHeroLoading();
  }

  function renderSearchError(err) {
    const c = C();
    $('grid').innerHTML = '';
    c.showErrorNotice(err);
  }

  /* ---------------- my list page ---------------- */

  function renderMyList(items, isInList) {
    const c = C();
    setCollectionChrome(false);
    c.setSectionTitle('My List');
    c.clearTabs();
    $('grid').innerHTML = '';
    const list = Array.isArray(items) ? items : [];
    $('grid').innerHTML = list.length
      ? c.cardsHTML(list, isInList)
      : '<div class="gx-empty col-span-full">Empty. Hover a poster and hit ☆, or open details → + My List. Stored locally in your browser.</div>';
    c.clearHeroLoading();
  }

  /* ---------------- homepage shelves (config-driven carousel shelves) ---------------- */

  // Renders resolved config sections as horizontal shelves (see css/shelves.css
  // + js/shelves.js for the carousel behavior). Same card markup as the main
  // grid — only the shelf shell differs.
  // resolved: [{ section: {id,title,description}, items, collection? }] in
  // config order. Empty shelves render nothing (a bad query shouldn't leave
  // holes).
  //
  // Phase 5.5 unified discovery: EVERY homepage section — Trending, Movies,
  // TV, Top Rated, Kids, Horror, Science Fiction, … — renders through THIS
  // renderer. No legacy grid/tabs presentation on the homepage; the D1
  // home-section configuration (order, visibility, limits) is the source of
  // truth, and each section's existing collection association decides its
  // Explore all link (see homeSectionHref). No hardcoded slugs or URLs.
  function homeSectionHref(r) {
    const s = (r && r.section) || {};
    const src = (s.source && typeof s.source === 'object') ? s.source : null;
    let slug = '';
    if (r && r.collection && typeof r.collection.slug === 'string' && r.collection.slug) {
      // Authoritative: the resolver only returns a collection for a valid,
      // visible slug (unknown/hidden slugs reject and the shelf is skipped).
      if (r.collection.visible === false) return '';
      slug = r.collection.slug;
    } else if (src && src.type === 'collection' && typeof src.slug === 'string') {
      slug = src.slug;
    } else {
      return '';
    }
    slug = String(slug).trim().toLowerCase();
    if (!slug || slug.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return '';
    // Render-time guard against broken links: the associated collection must
    // currently resolve (exists + visible). Uses the existing collection
    // registry — never a hardcoded list. Skipped when the data layer is
    // unavailable (headless use keeps the slug-validated href).
    try {
      const gd = window.GreyboxData;
      if (gd && typeof gd.getCollection === 'function' && !gd.getCollection(slug)) return '';
    } catch { /* registry optional */ }
    try {
      if (window.Router && window.Router.url && typeof window.Router.url.collection === 'function') {
        return window.Router.url.collection(slug);
      }
    } catch { /* fall through to plain path */ }
    return '/collection/' + slug;
  }

  // Phase 5.5: the ONE consistent section-header pattern. Title first,
  // optional description (already-available metadata), optional Explore all
  // link (secondary, right-aligned on desktop, wraps on mobile via CSS).
  // All section types share it — no duplicated header markup.
  function homeSectionHeader(s, href, c) {
    const safeTitle = c.escapeHtml(s.title);
    const link = href ? c.exploreAllHTML(href, s.title) : '';
    return `<div class="gx-shelf-head"><div class="gx-shelf-titles"><h2 class="gx-shelf-title">${safeTitle}</h2>` +
      (s.description ? `<p class="gx-shelf-desc">${c.escapeHtml(s.description)}</p>` : '') +
      `</div>${link}</div>`;
  }

  function renderHomeSections(resolved, isInList) {
    const c = C();
    const host = $('home-sections');
    if (!host) return;
    const list = Array.isArray(resolved) ? resolved : [];
    host.innerHTML = list
      .filter((r) => r && r.section && (r.items || []).length)
      .map((r) => {
        const s = r.section;
        const domId = 'home-section-' + String(s.id).replace(/[^a-z0-9-_]/gi, '-');
        const href = homeSectionHref(r);
        const safeTitle = c.escapeHtml(s.title);
        return `<section class="gx-shelf" id="${c.escapeHtml(domId)}" aria-label="${safeTitle}">` +
          homeSectionHeader(s, href, c) +
          `<div class="gx-shelf-viewport" data-overflow="false" data-at-start="true" data-at-end="true">` +
          `<div class="gx-shelf-track" role="region" aria-label="${safeTitle} titles">${c.cardsHTML(r.items, isInList)}</div>` +
          `<button class="gx-shelf-btn" data-dir="prev" aria-label="Scroll ${safeTitle} back"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3 5 8l5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` +
          `<button class="gx-shelf-btn" data-dir="next" aria-label="Scroll ${safeTitle} forward"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` +
          `</div></section>`;
      }).join('');
  }

  function clearHomeSections() {
    const host = $('home-sections');
    if (host) host.innerHTML = '';
  }

  // Phase 5.5 unified homepage discovery surface. On the homepage (page 1)
  // ALL content renders as config-driven shelves through renderHomeSections —
  // the legacy grid/tabs/pager presentation for Trending/Movies/TV/Top Rated
  // is hidden, not redesigned: list/collection/search pages keep using it
  // (setCollectionChrome restores the grid whenever they render).
  function setHomeDiscoverMode(on) {
    try {
      const ids = ['list-head', 'grid', 'pager'];
      for (const id of ids) {
        const el = $(id);
        if (el) el.classList.toggle('hidden', !!on);
      }
      if (on) clearCollectionMore();
    } catch (e) { /* chrome optional in headless use */ }
  }

  /* ---------------- footer navigation (config-driven collections) ---------------- */

  // Renders footer collection links from [{ href, label }]. Labels use
  // textContent (never innerHTML), so config titles cannot inject markup.
  // Empty/invalid lists hide the whole Collections column instead of leaving
  // a dead heading. Styling matches the static footer links in index.html.
  function renderFooterCollections(links) {
    const host = $('footer-collections');
    const section = $('footer-collections-section');
    if (!host || !section) return;
    host.innerHTML = '';
    const list = (Array.isArray(links) ? links : []).filter((l) => l && typeof l.href === 'string' && l.href);
    if (!list.length) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    for (const l of list) {
      const a = document.createElement('a');
      a.href = l.href;
      a.textContent = typeof l.label === 'string' && l.label ? l.label : l.href;
      a.className = 'block mt-2 hover:text-white';
      host.appendChild(a);
    }
  }

  /* ---------------- Greybox collection page (cinematic destination) ---------------- */

  // The list shell (#list-head row + #pager) and the collection header
  // (#collection-head) are mutually exclusive. Every renderer declares its
  // mode up front so navigation never leaves a stale header behind.
  // The shared grid (#grid) belongs to list/collection pages, so leaving
  // collection chrome always restores it (the homepage discover surface hides
  // it again via setHomeDiscoverMode when needed).
  function setCollectionChrome(on) {
    try {
      const head = $('collection-head');
      if (head) {
        head.classList.toggle('hidden', !on);
        if (!on) head.innerHTML = '';
      }
      const row = $('list-head');
      if (row) row.classList.toggle('hidden', !!on);
      const grid = $('grid');
      if (grid) grid.classList.remove('hidden');
      const pager = $('pager');
      if (pager) pager.classList.toggle('hidden', !!on);
      // Phase 5.4 pagination mount lives after the grid; other pages must
      // never inherit its skeletons/retry UI.
      clearCollectionMore();
    } catch (e) { /* chrome optional in headless use */ }
  }

  const COLLECTION_KINDS = {
    trending: 'Trending', popular: 'Popular', 'top-rated': 'Top Rated',
    'now-playing': 'Now Playing', discover: 'Discover', genre: 'Genre',
    year: 'Year', search: 'Search', custom: 'Curated',
  };

  // Generic source/media labels derived from the data model — never hardcoded
  // collection names, so a new D1 collection works automatically.
  function collectionEyebrow(col) {
    const src = (col && col.source && typeof col.source === 'object') ? col.source : null;
    const kind = src && COLLECTION_KINDS[src.type] ? COLLECTION_KINDS[src.type] : '';
    const media = src ? src.media : '';
    const scope = media === 'movie' ? 'Movies' : (media === 'tv' ? 'TV Shows' : 'Movies & TV');
    return kind ? kind + ' · ' + scope : scope;
  }

  function collectionMetaLine(col, count) {
    const bits = [(count === 1 ? '1 title' : count + ' titles')];
    try {
      if (col && col.meta && typeof col.meta === 'object') {
        if (col.meta.curator) bits.push('Curated by ' + col.meta.curator);
        if (col.meta.updated) bits.push('Updated ' + col.meta.updated);
      }
    } catch (e) { /* meta optional */ }
    return bits.join(' · ');
  }

  // Subtle atmosphere from the collection's own resolved artwork (paths only,
  // no new fetches): first backdrop wins, else first poster, else nothing.
  function collectionAtmo(items, c) {
    const list = Array.isArray(items) ? items : [];
    let path = '';
    for (let i = 0; i < list.length && i < 8 && !path; i++) {
      if (list[i] && list[i].backdrop_path) path = list[i].backdrop_path;
    }
    if (!path) {
      for (let i = 0; i < list.length && i < 8 && !path; i++) {
        if (list[i] && list[i].poster_path) path = list[i].poster_path;
      }
    }
    if (!path) return '';
    return `<div class="gx-col-atmo" aria-hidden="true"><img src="${c.escapeHtml(c.IMG + path)}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none'"/></div>` +
      `<div class="gx-col-shade" aria-hidden="true"></div>`;
  }

  // Media scope derived from the already-resolved items (never hardcoded
  // slugs): exact media_type only — never invent a type for unknown items.
  // The resolver always sets media_type, so unknowns mean "cannot be
  // determined reliably" and the filter UI is skipped (existing behavior).
  function collectionMediaOf(item) {
    const mt = item && item.media_type;
    return (mt === 'movie' || mt === 'tv') ? mt : '';
  }

  // Returns the applicable filter options for the resolved set:
  // ['all','movie','tv'] when both are present, a single scope when only one
  // is, or [] when nothing can be determined (empty/unknown) — in which case
  // no filter UI renders and behavior is unchanged.
  function collectionFilterOptions(items) {
    const list = Array.isArray(items) ? items : [];
    let movies = false, tv = false;
    for (let i = 0; i < list.length; i++) {
      const mt = collectionMediaOf(list[i]);
      if (mt === 'movie') movies = true;
      else if (mt === 'tv') tv = true;
      if (movies && tv) break;
    }
    if (movies && tv) return ['all', 'movie', 'tv'];
    if (movies) return ['movie'];
    if (tv) return ['tv'];
    return [];
  }

  const COLLECTION_FILTER_LABELS = { all: 'All', movie: 'Movies', tv: 'TV' };
  const COLLECTION_FILTER_EMPTY = {
    movie: 'No films found in this collection.',
    tv: 'No television found in this collection.',
  };

  function collectionFilterHTML(options, active, c) {
    return `<div class="gx-col-filter" role="group" aria-label="Filter by media type">` +
      options.map((f) =>
        `<button type="button" class="gx-tab${f === active ? ' active' : ''}" data-media="${f}"` +
        ` aria-pressed="${f === active ? 'true' : 'false'}"` +
        `${f === active ? ' aria-current="true"' : ''}>${c.escapeHtml(COLLECTION_FILTER_LABELS[f])}</button>`
      ).join('') + `</div>`;
  }

  // Wire the filter buttons to the controller callback (same delegation-free
  // pattern as the episode/known-for buttons below). No-op in headless use.
  function wireCollectionFilter(onFilter) {
    if (typeof onFilter !== 'function') return;
    try {
      const head = $('collection-head');
      if (!head || !head.querySelectorAll) return;
      head.querySelectorAll('[data-media]').forEach((b) => {
        b.onclick = () => onFilter(b.getAttribute ? b.getAttribute('data-media') : (b.dataset && b.dataset.media));
      });
    } catch (e) { /* filter stays inert without DOM */ }
  }

  // Renders a resolved collection as its own destination: compact cinematic
  // header (title, concise description, quiet meta) + the shared Phase-4 card
  // catalog in Greybox config order. Returns the hero item (first shown on a
  // non-empty set) so the controller can keep hero actions bound to the
  // displayed hero — mirroring renderList. Same object paints hero text and
  // hero artwork, so title/poster/backdrop/metadata always share one identity.
  // ctx: { collection: {title, description, cover, source, meta}, items,
  //        filter: 'all'|'movie'|'tv' (default 'all'),
  //        onFilter(f): 'all'|'movie'|'tv', isInList(id, mt) }
  // Filtering is in-memory on the already-resolved set: no refetch, no fake
  // loader, cards/hero/meta follow the shown set, media_type is preserved so
  // movie cards still route to /movie/:id and TV cards to /tv/:id.
  function renderCollection(ctx) {
    const c = C();
    const col = (ctx && ctx.collection) || {};
    setCollectionChrome(true);
    c.setNotice('');
    c.setPageLabel(1);
    c.clearHeroLoading();
    const items = Array.isArray(ctx.items) ? ctx.items : [];
    const options = collectionFilterOptions(items);
    // Never fall back to All automatically: a valid requested filter with no
    // results (e.g. ?media=tv on a movie-only collection) renders the quiet
    // per-media empty state below. (app.js already normalizes garbage to All.)
    const filter = (ctx && ctx.filter) || 'all';
    const active = options.indexOf(filter) >= 0 ? filter : '';
    const shown = filter === 'all' ? items : items.filter((x) => collectionMediaOf(x) === filter);
    const cover = (typeof col.cover === 'string' && col.cover.trim()) ? col.cover.trim() : '';
    $('collection-head').innerHTML =
      `<div class="gx-col">${collectionAtmo(shown, c)}<div class="gx-col-body">` +
      (cover ? `<img class="gx-col-cover" src="${c.escapeHtml(cover)}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none'"/>` : '') +
      `<div class="gx-col-main">` +
      `<p class="gx-col-eyebrow">${c.escapeHtml(collectionEyebrow(col))}</p>` +
      `<h1 class="gx-col-title">${c.escapeHtml(col.title || 'Collection')}</h1>` +
      (col.description ? `<p class="gx-col-desc">${c.escapeHtml(col.description)}</p>` : '') +
      `<p class="gx-col-meta">${c.escapeHtml(collectionMetaLine(col, shown.length))}</p>` +
      (options.length ? collectionFilterHTML(options, active, c) : '') +
      `</div></div></div>`;
    wireCollectionFilter(ctx && ctx.onFilter);
    $('grid').innerHTML = c.cardsHTML(shown, ctx.isInList) ||
      `<div class="gx-empty col-span-full">${c.escapeHtml(COLLECTION_FILTER_EMPTY[filter] || 'No titles available in this collection right now.')}</div>`;
    clearCollectionMore();
    // Hero text + artwork come from this same object (single identity). A
    // configured collection hero override (ctx.heroItem, resolved by the
    // controller to ONE item) replaces the default first-item hero; an
    // empty filtered set leaves the previous hero untouched (no split
    // state); the return value lets the controller bind hero actions to it.
    if (ctx.heroItem) { c.setHero(ctx.heroItem); return ctx.heroItem; }
    if (shown[0]) { c.setHero(shown[0]); return shown[0]; }
    return null;
  }

  /* ---------------- Phase 5.4: progressive collection pagination ----------------
   * The controller (js/app.js) owns paging state; these helpers only paint
   * the mount `#collection-more` (static, after #grid in index.html) and the
   * grid tail. Cards reuse cardsHTML, skeletons reuse gridSkeleton — no new
   * visual system. Appends never touch the header, hero, or existing cards,
   * so focus and scroll position are preserved. */

  function collectionMoreEl() {
    try { return $('collection-more'); } catch (e) { return null; }
  }

  function clearCollectionMore() {
    try {
      const m = collectionMoreEl();
      if (m) { m.innerHTML = ''; m.classList.add('hidden'); }
    } catch (e) { /* mount optional in headless use */ }
  }

  // Continuation skeletons: a small quiet row, grid never replaced.
  function showCollectionMoreLoading(count) {
    const c = C();
    const m = collectionMoreEl();
    if (!m) return;
    m.innerHTML = c.gridSkeleton(count || 6);
    m.classList.remove('hidden');
  }

  // Quiet retry for a failed page only — existing cards stay put, raw errors
  // stay in the console. Native button: keyboard accessible by default.
  function showCollectionMoreError(onRetry) {
    const m = collectionMoreEl();
    if (!m) return;
    m.innerHTML =
      `<div class="col-span-full gx-more-note"><span>Couldn${"'"}t load more titles.</span> ` +
      `<button type="button" class="gx-tab" id="gx-more-retry">Retry</button></div>`;
    m.classList.remove('hidden');
    if (typeof onRetry === 'function') {
      try {
        const b = (m.querySelector && m.querySelector('#gx-more-retry')) || $('gx-more-retry');
        if (b) b.onclick = () => onRetry();
      } catch (e) { /* retry stays inert without DOM */ }
    }
  }

  // Clean end of results: stop observing (controller-side), leave no banner.
  function showCollectionMoreEnd() {
    clearCollectionMore();
  }

  // Appends already-shaped items to the grid tail in DOM order. Returns the
  // appended count. Never replaces, never reorders, never touches the hero.
  function appendCollectionItems(items, isInList) {
    const c = C();
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return 0;
    try {
      $('grid').insertAdjacentHTML('beforeend', c.cardsHTML(list, isInList));
    } catch (e) { return 0; }
    return list.length;
  }

  // Refreshes the header result count after appends (meta = currently
  // displayed results, matching the initial render).
  function updateCollectionMeta(col, count) {
    try {
      const head = $('collection-head');
      if (!head || !head.querySelector) return;
      const meta = head.querySelector('.gx-col-meta');
      if (meta) meta.textContent = collectionMetaLine(col, count);
    } catch (e) { /* header optional in headless use */ }
  }

  function renderCollectionLoading(title) {
    const c = C();
    setCollectionChrome(true);
    c.setNotice('');
    c.setPageLabel(1);
    c.showGridLoading(12);
    c.setHeroLoading(false);
    c.clearHeroLoading();
    $('collection-head').innerHTML =
      `<div class="gx-col"><div class="gx-col-body"><div class="gx-col-main">` +
      `<h1 class="gx-col-title">${c.escapeHtml(title || 'Collection')}</h1>` +
      `<div class="gx-col-loading-meta" aria-hidden="true"></div>` +
      `</div></div></div>`;
  }

  // Graceful failure: quiet empty state, never raw API errors in the UI
  // (diagnostics go to the console). Signature is (collection, err).
  function renderCollectionError(col, err) {
    const c = C();
    setCollectionChrome(true);
    try { console.warn('[collection] failed:', (err && err.message) || err); } catch (e) { /* noop */ }
    const title = (col && col.title) || 'Collection';
    $('collection-head').innerHTML =
      `<div class="gx-col"><div class="gx-col-body"><div class="gx-col-main">` +
      `<h1 class="gx-col-title">${c.escapeHtml(title)}</h1>` +
      `</div></div></div>`;
    $('grid').innerHTML = '<div class="gx-empty col-span-full">This collection could not be loaded right now. Please try again later.</div>';
  }

  /* ---------------- not found ---------------- */

  function renderNotFound(path) {
    const c = C();
    c.hideModal();
    setCollectionChrome(false);
    try { if (window.GreyboxHero && typeof window.GreyboxHero.reset === 'function') window.GreyboxHero.reset(); } catch (e) { /* hero optional */ }
    c.setSectionTitle('Not found');
    c.clearTabs();
    $('grid').innerHTML = `<div class="text-zinc-400 col-span-full">No page at <code>${c.escapeHtml(path || '')}</code>. <a class="text-red-400 underline" href="/" data-route>Back to home</a></div>`;
    c.clearHeroLoading();
    $('hero-badge').textContent = '404';
    $('hero-title').textContent = 'That URL does not exist';
    // Non-media state: drop any previous item's artwork so the 404 text can
    // never appear over another title's backdrop (identity split). The dark
    // placeholder underneath remains a valid state.
    try {
      const hi = $('hero-img');
      if (hi) { try { hi.removeAttribute('src'); } catch (e) { /* noop */ } }
      const ha = $('hero-ambient');
      if (ha) { try { ha.removeAttribute('src'); } catch (e) { /* noop */ } }
    } catch (e) { /* hero optional in headless use */ }
    c.setPageLabel(1);
  }

  /* ---------------- title detail (movie + tv share one shell) ---------------- */

  // Compact title-area line: year · Movie/TV · rating · genres. Blank parts
  // are dropped so the line never shows dangling separators or "undefined".
  function detailMeta(d, mediaType) {
    const bits = [];
    const year = (d.release_date || d.first_air_date || '').slice(0, 4);
    if (/^\d{4}$/.test(year)) bits.push(year);
    bits.push(mediaType === 'tv' ? 'TV Show' : 'Movie');
    const v = Number(d.vote_average || 0);
    if (isFinite(v) && v > 0) bits.push(`⭐ ${v.toFixed(1)}`);
    const genres = (d.genres || []).filter(Boolean).join(', ');
    if (genres) bits.push(genres);
    return bits.join(' · ');
  }

  function setDetailArtwork(imgId, url, alt) {
    const img = $(imgId);
    if (!img) return;
    if (url) {
      img.style.display = '';
      img.src = url;
      if (alt != null) img.alt = alt;
    } else {
      // No artwork: hide the element so no broken icon can flash. The dark
      // cinematic header + shade behind it remain a valid state.
      img.removeAttribute('src');
      img.style.display = 'none';
    }
  }

  // Fills the modal shell from an already-fetched Greybox detail bundle.
  // Returns nothing — the controller wires trailer/watch/list afterwards.
  // ctx: { detail, mediaType: 'movie'|'tv', inList: bool }
  function renderTitleDetail(ctx) {
    const c = C();
    const d = ctx.detail;
    const mt = ctx.mediaType === 'tv' ? 'tv' : 'movie';
    c.setModalActionsVisible(true);
    c.showModal();
    c.showDetailLoading();
    const title = d.title || d.name || 'Untitled';
    $('m-title').textContent = title;
    $('m-meta').textContent = detailMeta(d, mt);
    // Greybox Pick / custom badge rides its own pill (overrides stay
    // authoritative — this only changes where the value paints).
    const badge = $('m-badge');
    if (badge) {
      if (d.custom_badge) { badge.textContent = d.custom_badge; badge.classList.remove('hidden'); }
      else { badge.textContent = ''; badge.classList.add('hidden'); }
    }
    // Custom-tag badges: one pill per badged tag containing this identity,
    // alongside (never replacing) the override badge above. Created +
    // removed here so stale pills can never leak across titles.
    try {
      const head = badge && badge.parentElement ? badge.parentElement : null;
      if (head) head.querySelectorAll('.gx-detail-tagbadge').forEach((n) => n.remove());
      const tags = Array.isArray(d.tag_badges) ? d.tag_badges.filter((n) => typeof n === 'string' && n.trim()) : [];
      if (head && tags.length) {
        // Escape via textContent (never innerHTML) — badge text is operator input.
        tags.slice(0, 6).forEach((n) => {
          const s = document.createElement('span');
          s.className = 'gx-detail-badge gx-detail-tagbadge';
          s.textContent = n.trim().slice(0, 40);
          if (badge.nextSibling) head.insertBefore(s, badge.nextSibling);
          else head.appendChild(s);
        });
      }
    } catch { /* badges are decorative — a title never breaks on them */ }
    // Full overview belongs on a detail page; absent overview omits the
    // section cleanly instead of printing a placeholder sentence.
    const ov = $('m-overview');
    if (ov) {
      if (d.overview) { ov.style.display = ''; ov.textContent = d.overview; }
      else { ov.textContent = ''; ov.style.display = 'none'; }
    }
    setDetailArtwork('m-backdrop', d.backdrop_path ? c.IMG_BIG + d.backdrop_path : (d.poster_path ? c.IMG + d.poster_path : ''), '');
    setDetailArtwork('m-poster', d.poster_path ? c.IMG + d.poster_path : (d.backdrop_path ? c.IMG_BIG + d.backdrop_path : ''), title);
    const listBtn = $('m-list');
    if (listBtn) {
      listBtn.textContent = ctx.inList ? '★ In My List' : '+ My List';
      listBtn.classList.toggle('is-in-list', !!ctx.inList);
    }
    renderCast(d.cast || []);
    renderProviders(d.providers, ctx.region);
  }

  function renderCast(castList) {
    const c = C();
    try {
      $('m-cast').innerHTML = castList.slice(0, 12).map((cast) =>
        `<div class="min-w-[90px] text-center"><img class="w-[90px] h-[120px] object-cover rounded-lg" loading="lazy" src="${cast.profile_path ? c.IMG + cast.profile_path : 'https://via.placeholder.com/90x120?text=?'}"/><div class="mt-1 font-semibold truncate">${c.escapeHtml(cast.name)}</div><div class="text-zinc-500 truncate">${c.escapeHtml(cast.character || '')}</div></div>`).join('') || '—';
    } catch (err) {
      console.warn('[detail] cast failed', err);
      $('m-cast').textContent = '—';
    }
  }

  function renderProviders(p, region) {
    const c = C();
    try {
      const hasOffer = p && (p.flatrate.length || p.rent.length || p.buy.length || p.link);
      $('m-providers').innerHTML = hasOffer
        ? `${p.flatrate?.length ? '<b>Stream:</b> ' + p.flatrate.map(c.escapeHtml).join(', ') + '<br/>' : ''}${p.rent?.length ? '<b>Rent:</b> ' + p.rent.map(c.escapeHtml).join(', ') + '<br/>' : ''}${p.buy?.length ? '<b>Buy:</b> ' + p.buy.map(c.escapeHtml).join(', ') : ''}${p.link ? `<br/><a class="text-amber-300 underline" target="_blank" href="${p.link}">Open JustWatch/TMDB guide ↗</a>` : ''}`
        : `No legal offer found for region ${region}. Change region in Settings ⚙️.`;
    } catch (err) {
      console.warn('[detail] providers failed', err);
      $('m-providers').textContent = 'Provider lookup failed.';
    }
  }

  /* ---------------- seasons + episodes ---------------- */

  // Fills the season <select>; returns the resolved season number (prefers 1).
  function renderSeasons(seasons) {
    const c = C();
    const list = (Array.isArray(seasons) ? seasons : []).filter((s) => s.season_number >= 0);
    if (!list.length) return null;
    $('m-tv-wrap').classList.remove('hidden');
    $('m-season').innerHTML = list.map((s) => `<option value="${s.season_number}">${c.escapeHtml(s.name)} (${s.episode_count} eps)</option>`).join('');
    const current = (list.find((s) => s.season_number === 1) || list[0]).season_number;
    $('m-season').value = String(current);
    return current;
  }

  function renderEpisodesLoading() {
    $('m-episodes').innerHTML = window.GreyboxComponents.inlineLoader('Loading episodes…');
  }

  function renderEpisodesError() {
    $('m-episodes').innerHTML = '<div class="text-sm text-red-300">Could not load episodes.</div>';
  }

  // ctx: { tmdbId, seasonNum, episodes, configured: bool, resumeLabel(key): string|null, onPlay(ep) }
  function renderEpisodes(ctx) {
    const c = C();
    const eps = Array.isArray(ctx.episodes) ? ctx.episodes : [];
    $('m-episodes').innerHTML = eps.map((ep) => {
      const resume = typeof ctx.resumeLabel === 'function'
        ? ctx.resumeLabel(`tv:${ctx.tmdbId}:${ctx.seasonNum}:${ep.episode_number}`)
        : null;
      return `<div class="flex gap-3 bg-white/5 border border-white/10 rounded-xl p-3">
        <img class="w-32 h-[72px] object-cover rounded-lg shrink-0" loading="lazy"
          src="${ep.still_path ? c.IMG + ep.still_path : 'https://via.placeholder.com/128x72?text=No+Still'}" alt=""/>
        <div class="min-w-0 flex-1">
          <div class="text-sm font-bold truncate">E${ep.episode_number} · ${c.escapeHtml(ep.name || 'Episode')}</div>
          <div class="text-xs text-zinc-400 line-clamp-3 mt-0.5">${c.escapeHtml(ep.overview || '')}</div>
          <div class="text-xs text-zinc-500 mt-1">${ep.runtime ? ep.runtime + ' min · ' : ''}${ep.air_date || ''}${resume ? ' · <span class="text-emerald-300">' + resume + '</span>' : ''}</div>
        </div>
        <button class="self-center shrink-0 px-4 py-2 rounded-lg font-bold text-sm ${ctx.configured ? 'bg-amber-500 hover:bg-amber-400 text-black' : 'bg-white/10 text-zinc-400'}"
          data-season="${ctx.seasonNum}" data-ep="${ep.episode_number}">▶</button>
      </div>`;
    }).join('') || '<div class="text-sm text-zinc-500">No episodes listed.</div>';
    $('m-episodes').querySelectorAll('button[data-ep]').forEach((b) => {
      b.onclick = () => {
        const ep = eps.find((x) => x.episode_number === +b.dataset.ep);
        if (ep && typeof ctx.onPlay === 'function') ctx.onPlay(ep);
      };
    });
  }

  /* ---------------- person ---------------- */

  // ctx: { person, knownFor, onSelect(id, mediaType) }
  function renderPerson(ctx) {
    const c = C();
    const person = ctx.person || {};
    const id = person.id;
    c.setModalActionsVisible(false);
    c.showModal();
    c.showPersonLoading();
    // Person reuses the title shell: clear title-only furniture (badge,
    // poster, error route-back) so nothing stale carries over.
    if ($('m-badge')) { $('m-badge').textContent = ''; $('m-badge').classList.add('hidden'); }
    try {
      const head = $('m-badge') && $('m-badge').parentElement;
      if (head) head.querySelectorAll('.gx-detail-tagbadge').forEach((n) => n.remove());
    } catch { /* decorative only */ }
    setDetailArtwork('m-poster', '', '');
    if ($('m-back')) $('m-back').classList.add('hidden');
    $('m-title').textContent = person.name || 'Untitled';
    const facts = [person.known_for_department || '', person.birthday || '', person.place_of_birth || ''].filter(Boolean).join(' · ');
    $('m-meta').textContent = facts || 'Person';
    $('m-overview').textContent = person.biography || 'No biography on TMDB.';
    if ($('m-overview')) $('m-overview').style.display = '';
    setDetailArtwork('m-backdrop', person.profile_path ? c.IMG_BIG + person.profile_path : '', '');
    $('m-providers').innerHTML =
      `${person.birthday ? '<b>Born:</b> ' + c.escapeHtml(person.birthday) + (person.place_of_birth ? ' in ' + c.escapeHtml(person.place_of_birth) : '') + '<br/>' : ''}` +
      `${person.known_for_department ? '<b>Known for:</b> ' + c.escapeHtml(person.known_for_department) + '<br/>' : ''}` +
      `<a class="text-amber-300 underline" target="_blank" href="https://www.themoviedb.org/person/${id}">Open on TMDB ↗</a>`;
    const known = Array.isArray(ctx.knownFor) ? ctx.knownFor : [];
    $('m-cast').innerHTML = known.map((x) => {
      const mt = x.media_type;
      const title = x.title || x.name || 'Untitled';
      return `<div class="min-w-[90px] text-center cursor-pointer known-for" data-id="${x.id}" data-type="${mt}"><img class="w-[90px] h-[120px] object-cover rounded-lg" loading="lazy" src="${x.poster_path ? c.IMG + x.poster_path : 'https://via.placeholder.com/90x120?text=?'}"/><div class="mt-1 font-semibold truncate">${c.escapeHtml(title)}</div><div class="text-zinc-500 truncate">${mt === 'movie' ? 'Movie' : 'TV'}</div></div>`;
    }).join('') || '—';
    $('m-cast').querySelectorAll('.known-for').forEach((el) => {
      el.onclick = () => { if (typeof ctx.onSelect === 'function') ctx.onSelect(+el.dataset.id, el.dataset.type); };
    });
  }

  window.GreyboxPages = {
    headingFor,
    renderList,
    renderListLoading,
    renderListChrome,
    renderListError,
    renderSearch,
    renderSearchLoading,
    renderSearchError,
    renderMyList,
    renderNotFound,
    renderCollection,
    renderCollectionLoading,
    renderCollectionError,
    clearCollectionMore,
    showCollectionMoreLoading,
    showCollectionMoreError,
    showCollectionMoreEnd,
    appendCollectionItems,
    updateCollectionMeta,
    renderHomeSections,
    clearHomeSections,
    setHomeDiscoverMode,
    homeSectionHref,
    homeSectionHeader,
    renderFooterCollections,
    renderTitleDetail,
    renderCast,
    renderProviders,
    renderSeasons,
    renderEpisodesLoading,
    renderEpisodesError,
    renderEpisodes,
    renderPerson,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = window.GreyboxPages;
})();
