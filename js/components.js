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
  // Preserved hooks (js/app.js depends on them): .card, data-id, data-type,
  // img, .font-semibold (title lookup), .list-btn + its data attrs (the star
  // character stays the button's sole content so the toggle keeps working).
  function card(item, inList) {
    const mt = item.media_type || (item.title ? 'movie' : 'tv');
    const title = item.title || item.name || 'Untitled';
    const date = item.release_date || item.first_air_date || '';
    const year = date ? date.slice(0, 4) : '';
    const poster = item.poster_path ? IMG + item.poster_path : 'https://via.placeholder.com/500x750?text=No+Image';
    const star = inList ? '★' : '☆';
    const label = `${title}${year ? ' (' + year + ')' : ''}`;
    return `<div class="card gx-card" data-id="${item.id}" data-type="${mt}" tabindex="0" role="button" aria-label="${escapeHtml(label)}">` +
      `<div class="gx-card-media"><img loading="lazy" decoding="async" src="${poster}" alt="${escapeHtml(title)}"/>` +
      `<div class="gx-card-shade" aria-hidden="true"></div>` +
      (item.custom_badge ? `<span class="gx-card-badge">${escapeHtml(item.custom_badge)}</span>` : '') +
      `<button class="list-btn gx-card-list${inList ? ' is-in-list' : ''}" data-id="${item.id}" data-type="${mt}" title="My List" aria-label="Toggle My List">${star}</button>` +
      (item.vote_average ? `<span class="gx-card-rating"><span class="gx-star" aria-hidden="true">★</span> ${Number(item.vote_average).toFixed(1)}</span>` : '') +
      `</div><div class="gx-card-body"><div class="font-semibold gx-card-title">${escapeHtml(title)}</div>` +
      `<div class="gx-card-sub">${year ? year + ' · ' : ''}${mt === 'movie' ? 'Movie' : 'TV'}</div></div></div>`;
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
      h += `<div class="gx-sk" aria-hidden="true"><div class="gx-sk-media"></div>` +
        `<div class="gx-sk-bar"></div><div class="gx-sk-bar short"></div></div>`;
    }
    return h;
  }

  function showGridLoading(count) {
    $('grid').innerHTML = gridSkeleton(count || 12);
  }

  function showGridEmpty(text) {
    $('grid').innerHTML = `<div class="gx-empty">${escapeHtml(text || 'No results.')}</div>`;
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
      const isActive = active === k;
      b.className = 'gx-tab' + (isActive ? ' active' : '');
      if (isActive) b.setAttribute('aria-current', 'true');
      b.textContent = label;
      b.onclick = () => { if (typeof onSelect === 'function') onSelect(k); };
      t.appendChild(b);
    }
  }

  function clearTabs() { $('tabs').innerHTML = ''; }

  /* ---------------- hero (Phase 2 cinematic module owns rendering) ---------------- */

  function hero() {
    try {
      if (window.GreyboxHero) return window.GreyboxHero;
    } catch (e) { /* fall through to legacy */ }
    return null;
  }

  function setHeroLoading(on) {
    const H = hero();
    if (H && typeof H.setLoading === 'function') { H.setLoading(!!on); return; }
    const heroEl = $('hero');
    if (heroEl) heroEl.classList.toggle('hero-loading', !!on);
    if (on) {
      $('hero-badge').textContent = 'Loading…';
      $('hero-title').innerHTML = '<span class="hero-spinner"></span> Fetching trending…';
      $('hero-overview').innerHTML = '<span class="skeleton skeleton-line"></span><span class="skeleton skeleton-line short"></span>';
      $('hero-img').removeAttribute('src');
    }
  }

  function clearHeroLoading() {
    const H = hero();
    if (H && typeof H.clearLoading === 'function') { H.clearLoading(); return; }
    const heroEl = $('hero');
    if (heroEl) heroEl.classList.remove('hero-loading');
  }

  function setHero(item) {
    const H = hero();
    if (H && typeof H.setHero === 'function') return H.setHero(item);
    clearHeroLoading();
    if ($('hero-badge')) $('hero-badge').textContent = '#1 Trending';
    $('hero-title').textContent = item.title || item.name;
    $('hero-overview').textContent = item.overview || '';
    $('hero-img').src = item.backdrop_path ? IMG_BIG + item.backdrop_path : (item.poster_path ? IMG + item.poster_path : '');
  }

  function showHeroError(message) {
    const H = hero();
    if (H && typeof H.showError === 'function') { H.showError(message); return; }
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
