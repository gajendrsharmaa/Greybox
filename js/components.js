/* Greybox shared UI components + loading/error states. No fetching, no Router.
 *
 * Every HTML string here is byte-identical to what the pre-refactor app.js
 * produced — same classes, same copy, same visual appearance. Pages
 * (js/pages.js) compose these; the controller (js/app.js) only wires events.
 */
(function () {
  'use strict';

  const IMG = 'https://image.tmdb.org/t/p/w500';
  const IMG_BIG = 'https://image.tmdb.org/t/p/original';

  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------------- cards + grid ---------------- */

  // Pure: `inList` flag comes from the caller (GreyboxData.isInMyList),
  // so this helper never touches storage itself.
  function card(item, inList) {
    const mt = item.media_type || (item.title ? 'movie' : 'tv');
    const title = item.title || item.name || 'Untitled';
    const date = item.release_date || item.first_air_date || '';
    const poster = item.poster_path ? IMG + item.poster_path : 'https://via.placeholder.com/500x750?text=No+Image';
    const star = inList ? '★' : '☆';
    return `<div class="card bg-white/5 rounded-xl overflow-hidden border border-white/10" data-id="${item.id}" data-type="${mt}">
      <div class="relative"><img loading="lazy" src="${poster}" alt="${escapeHtml(title)}"/>
      <button class="absolute top-2 right-2 bg-black/70 rounded-full w-8 h-8 list-btn" data-id="${item.id}" data-type="${mt}" title="My List">${star}</button>
      ${item.vote_average ? `<span class="absolute bottom-2 left-2 text-xs bg-black/75 px-2 py-0.5 rounded">⭐ ${Number(item.vote_average).toFixed(1)}</span>` : ''}</div>
      <div class="p-2.5"><div class="text-sm font-semibold truncate">${escapeHtml(title)}</div>
      <div class="text-xs text-zinc-500">${date ? date.slice(0, 4) : ''} · ${mt === 'movie' ? 'Movie' : 'TV'}</div></div></div>`;
  }

  function cardsHTML(items, isInList) {
    const list = Array.isArray(items) ? items : [];
    const fn = typeof isInList === 'function' ? isInList : () => false;
    return list.map((item) => card(item, !!fn(item.id, item.media_type || (item.title ? 'movie' : 'tv')))).join('');
  }

  function gridSkeleton(n) {
    let h = '';
    const count = n > 0 ? n : 12;
    for (let i = 0; i < count; i++) {
      h += `<div class="rounded-xl overflow-hidden border border-white/10 bg-white/5">
        <div class="skeleton aspect-[2/3]"></div>
        <div class="p-2.5"><div class="skeleton h-3 rounded w-3/4"></div>
        <div class="skeleton h-2.5 rounded w-1/3 mt-2"></div></div></div>`;
    }
    return h;
  }

  function showGridLoading(count) {
    $('grid').innerHTML = gridSkeleton(count || 12);
  }

  function showGridEmpty(text) {
    $('grid').innerHTML = `<div class="text-zinc-500">${text || 'No results.'}</div>`;
  }

  function inlineLoader(text) {
    return `<div class="inline-loader"><span class="spinner"></span> ${escapeHtml(text || 'Loading…')}</div>`;
  }

  /* ---------------- notice / titles / pager ---------------- */

  function setNotice(msg) {
    const n = $('notice');
    if (!n) return;
    if (!msg) { n.classList.add('hidden'); return; }
    n.textContent = msg;
    n.classList.remove('hidden');
  }

  function showErrorNotice(err) {
    setNotice('⚠️ ' + ((err && err.message) ? err.message : String(err)));
  }

  function setSectionTitle(text) { $('section-title').textContent = text; }
  function setPageLabel(page) { $('page').textContent = 'Page ' + page; }

  function renderTabs(tabs, active, onSelect) {
    const t = $('tabs');
    t.innerHTML = '';
    for (const [k, label] of (tabs || [])) {
      const b = document.createElement('button');
      b.className = 'px-3 py-1.5 rounded-lg ' + (active === k ? 'bg-red-600 font-bold' : 'bg-white/10');
      b.textContent = label;
      b.onclick = () => { if (typeof onSelect === 'function') onSelect(k); };
      t.appendChild(b);
    }
  }

  function clearTabs() { $('tabs').innerHTML = ''; }

  /* ---------------- hero ---------------- */

  function setHeroLoading(on) {
    const hero = $('hero');
    if (hero) hero.classList.toggle('hero-loading', !!on);
    if (on) {
      $('hero-badge').textContent = 'Loading…';
      $('hero-title').innerHTML = '<span class="hero-spinner"></span> Fetching trending…';
      $('hero-overview').innerHTML = '<span class="skeleton skeleton-line"></span><span class="skeleton skeleton-line short"></span>';
      $('hero-img').removeAttribute('src');
    }
  }

  function clearHeroLoading() {
    const hero = $('hero');
    if (hero) hero.classList.remove('hero-loading');
  }

  function setHero(item) {
    clearHeroLoading();
    if ($('hero-badge')) $('hero-badge').textContent = '#1 Trending';
    $('hero-title').textContent = item.title || item.name;
    $('hero-overview').textContent = item.overview || '';
    $('hero-img').src = item.backdrop_path ? IMG_BIG + item.backdrop_path : (item.poster_path ? IMG + item.poster_path : '');
  }

  function showHeroError(message) {
    clearHeroLoading();
    $('hero-badge').textContent = 'Offline';
    $('hero-title').textContent = 'Could not load';
    $('hero-overview').textContent = message;
  }

  /* ---------------- modal shell ---------------- */

  function isModalOpen() {
    const m = $('modal');
    return !!m && !m.classList.contains('hidden');
  }

  function showModal() {
    $('modal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function hideModal() {
    if (!isModalOpen()) return;
    $('modal').classList.add('hidden');
    $('m-video').src = '';
    document.body.style.overflow = '';
  }

  function setModalActionsVisible(visible) {
    // Person view reuses the modal shell but has no Watch/Trailer/List/custom-source.
    for (const id of ['m-watch', 'm-trailer', 'm-list']) {
      const el = $(id);
      if (el) el.style.display = visible ? '' : 'none';
    }
    const custom = $('custom-url');
    if (custom && custom.parentElement) custom.parentElement.style.display = visible ? '' : 'none';
    if (!visible) $('m-tv-wrap').classList.add('hidden');
  }

  function resetModalMedia() {
    $('m-video-wrap').classList.add('hidden');
    $('m-video').src = '';
    $('m-tv-wrap').classList.add('hidden');
    $('m-episodes').innerHTML = '';
    $('m-season').innerHTML = '';
  }

  function showDetailLoading() {
    resetModalMedia();
    setStreamMessage('');
    $('m-title').textContent = 'Loading...';
    $('m-overview').textContent = '';
    $('m-meta').textContent = '';
    $('m-cast').innerHTML = inlineLoader('Loading cast…');
    $('m-providers').innerHTML = inlineLoader('Finding where to watch…');
    $('m-backdrop').src = '';
    $('m-watch').textContent = '▶ Watch Now';
  }

  function showPersonLoading() {
    resetModalMedia();
    setStreamMessage('');
    $('m-title').textContent = 'Loading person…';
    $('m-overview').textContent = '';
    $('m-meta').textContent = '';
    $('m-cast').innerHTML = inlineLoader('Loading…');
    $('m-providers').innerHTML = inlineLoader('Loading…');
    $('m-backdrop').src = '';
  }

  function showDetailError(message) {
    $('m-title').textContent = 'Error';
    $('m-overview').textContent = message + ' — press F12 → Console for details, then hard-refresh (Ctrl+Shift+R).';
    $('m-providers').textContent = '—';
  }

  function showPersonError(message) {
    $('m-title').textContent = 'Error';
    $('m-overview').textContent = message;
    $('m-providers').textContent = '—';
    $('m-cast').textContent = '—';
  }

  function setStreamMessage(msg, ok) {
    const n = $('m-stream-msg');
    if (!msg) { n.classList.add('hidden'); n.textContent = ''; return; }
    n.textContent = msg;
    n.classList.remove('hidden');
    n.className = 'mt-3 text-sm rounded-xl p-3 ' + (ok
      ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-200'
      : 'bg-amber-500/10 border border-amber-500/30 text-amber-200');
  }

  /* ---------------- search suggestions (header dropdown) ---------------- */

  function suggestionHTML(x) {
    return `<div class="flex gap-3 p-2.5 hover:bg-white/10 cursor-pointer sr" data-id="${x.id}" data-type="${x.media_type}">
      <img class="w-10 h-14 object-cover rounded" src="${x.poster_path ? IMG + x.poster_path : 'https://via.placeholder.com/40x56?text=?'}"/>
      <div><div class="text-sm font-semibold">${escapeHtml(x.title || x.name)}</div><div class="text-xs text-zinc-500">${x.media_type} · ${(x.release_date || x.first_air_date || '').slice(0, 4)}</div></div></div>`;
  }

  function suggestionsHTML(items) {
    const list = Array.isArray(items) ? items : [];
    return list.map(suggestionHTML).join('') || '<div class="p-3 text-sm text-zinc-500">No matches.</div>';
  }

  function suggestionErrorHTML(err) {
    return `<div class="p-3 text-sm text-red-300">${escapeHtml((err && err.message) ? err.message : String(err))}</div>`;
  }

  window.GreyboxComponents = {
    IMG,
    IMG_BIG,
    escapeHtml,
    card,
    cardsHTML,
    gridSkeleton,
    showGridLoading,
    showGridEmpty,
    inlineLoader,
    setNotice,
    showErrorNotice,
    setSectionTitle,
    setPageLabel,
    renderTabs,
    clearTabs,
    setHeroLoading,
    clearHeroLoading,
    setHero,
    showHeroError,
    isModalOpen,
    showModal,
    hideModal,
    setModalActionsVisible,
    resetModalMedia,
    showDetailLoading,
    showPersonLoading,
    showDetailError,
    showPersonError,
    setStreamMessage,
    suggestionHTML,
    suggestionsHTML,
    suggestionErrorHTML,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = window.GreyboxComponents;
})();
