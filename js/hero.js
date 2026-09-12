/* Greybox Phase 2 — cinematic hero module.
 *
 * Owns ONLY the homepage/public hero: state, text, backdrop, trailer, audio.
 * Data comes from the existing flow (list items via components.setHero, detail
 * bundles via GreyboxData for trailer_key). No hardcoding, no new backend,
 * no token handling (trailer_key arrives server-shaped through /api/*).
 *
 * Trailer: official YouTube embed, muted autoplay after TRAILER_DELAY_MS,
 * crossfaded over the still inside #hero. Any failure (no key, fetch error,
 * load timeout, hidden tab, scrolled past, navigation) keeps the animated
 * backdrop — never a broken iframe, black box, or stuck loader. One attempt
 * per hero item, no aggressive retries.
 */
(function () {
  'use strict';

  /* Single configurable delay (ms) before the trailer attempt. */
  var TRAILER_DELAY_MS = 7000;
  var TRAILER_LOAD_TIMEOUT_MS = 10000;

  var YT_KEY = /^[A-Za-z0-9_-]{11}$/;

  var cache = {}; // "mt:id" -> trailer key or null (session memo, avoids refetch)
  var gen = 0;    // invalidates timers/fetches/iframes across hero changes + routes
  var timer = 0;
  var loadTimer = 0;
  var current = null;
  var muted = true;
  var actions = {};

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    try {
      if (window.GreyboxComponents && typeof window.GreyboxComponents.escapeHtml === 'function') {
        return window.GreyboxComponents.escapeHtml(s);
      }
    } catch (e) { /* fall through */ }
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function heroEl() { return $('hero'); }

  function mediaOf(item) {
    if (!item) return 'movie';
    if (item.media_type === 'tv' || item.media_type === 'movie') return item.media_type;
    return item.title ? 'movie' : 'tv';
  }

  function validKey(k) {
    var s = String(k == null ? '' : k).trim();
    return YT_KEY.test(s) ? s : '';
  }

  function embedUrl(key) {
    return 'https://www.youtube.com/embed/' + key +
      '?autoplay=1&mute=1&controls=0&rel=0&playsinline=1' +
      '&loop=1&playlist=' + key +
      '&modestbranding=1&iv_load_policy=3&disablekb=1&enablejsapi=1';
  }

  function cancelTimers() {
    if (timer) { try { clearTimeout(timer); } catch (e) { /* noop */ } timer = 0; }
    if (loadTimer) { try { clearTimeout(loadTimer); } catch (e) { /* noop */ } loadTimer = 0; }
  }

  /* Full stop of anything trailer-related. Text/backdrop untouched. */
  function stopTrailer() {
    gen++;
    cancelTimers();
    try {
      var f = $('hero-trailer');
      if (f) { f.onload = null; f.onerror = null; try { f.removeAttribute('src'); } catch (e) { /* noop */ } }
      var w = $('hero-trailer-wrap');
      if (w) { w.classList.add('hidden'); w.classList.remove('is-visible'); }
      var m = $('hero-mute');
      if (m) m.classList.add('hidden');
    } catch (e) { /* noop */ }
    muted = true;
  }

  function reset() { stopTrailer(); }

  function isHeroVisible() {
    try {
      if (document.hidden) return false;
      var h = heroEl();
      if (!h) return false;
      var r = h.getBoundingClientRect();
      // Hero is at page top: visible while any of it is in the viewport.
      return r.bottom > 0 && r.top < window.innerHeight;
    } catch (e) { return true; }
  }

  function metaHTML(item) {
    var mt = mediaOf(item);
    var date = item.release_date || item.first_air_date || '';
    var year = String(date || '').slice(0, 4);
    if (year && !/^\d{4}$/.test(year)) year = '';
    var bits = [];
    if (year) bits.push(esc(year));
    bits.push(mt === 'tv' ? 'TV Show' : 'Movie');
    var v = Number(item.vote_average || 0);
    if (isFinite(v) && v > 0) bits.push('<span class="gx-star">★ ' + v.toFixed(1) + '</span>');
    return bits.join(' · ');
  }

  function listLabel() {
    try {
      if (current) {
        var mt = mediaOf(current);
        if (actions.isInList) return actions.isInList(current.id, mt) ? '★ In My List' : '+ My List';
        if (window.GreyboxData && typeof window.GreyboxData.isInMyList === 'function') {
          return window.GreyboxData.isInMyList(current.id, mt) ? '★ In My List' : '+ My List';
        }
      }
    } catch (e) { /* fall through */ }
    return '+ My List';
  }

  function refreshListLabel() {
    try {
      var b = $('hero-list');
      if (b) {
        b.textContent = listLabel();
        b.classList.toggle('is-in-list', String(b.textContent).indexOf('★') === 0);
      }
    } catch (e) { /* noop */ }
  }

  function setText(item) {
    var title = $('hero-title');
    var overview = $('hero-overview');
    var meta = $('hero-meta');
    var badge = $('hero-badge');
    if (badge) badge.textContent = ''; // clean hero: no badge in normal state
    if (title) title.textContent = item.title || item.name || 'Untitled';
    if (meta) meta.innerHTML = metaHTML(item);
    if (overview) {
      overview.textContent = item.overview || '';
      overview.style.display = item.overview ? '' : 'none';
    }
    refreshListLabel();
  }

  function loadBackdrop(item, myGen) {
    var hero = heroEl();
    var img = $('hero-img');
    var ambient = $('hero-ambient');
    var url = '';
    try {
      var IMG_BIG = (window.GreyboxComponents && window.GreyboxComponents.IMG_BIG) || 'https://image.tmdb.org/t/p/original';
      var IMG = (window.GreyboxComponents && window.GreyboxComponents.IMG) || 'https://image.tmdb.org/t/p/w500';
      if (item.backdrop_path) url = IMG_BIG + item.backdrop_path;
      else if (item.poster_path) url = IMG + item.poster_path;
    } catch (e) { url = ''; }
    if (!url || !img) {
      if (hero) hero.classList.remove('hero-loading');
      return;
    }
    // Preload off-DOM: fade in only when ready, never a broken icon.
    var pre = new Image();
    pre.decoding = 'async';
    pre.onload = function () {
      if (myGen !== gen) return;
      try {
        img.src = url;
        img.alt = '';
        if (ambient) { ambient.src = url; ambient.alt = ''; }
        if (hero) {
          // Restart the Ken Burns run for the new artwork.
          hero.classList.remove('is-ready');
          void hero.offsetWidth;
          hero.classList.remove('hero-loading');
          hero.classList.add('is-ready');
        }
      } catch (e) { /* noop */ }
    };
    pre.onerror = function () {
      if (myGen !== gen) return;
      try { if (hero) hero.classList.remove('hero-loading'); } catch (e) { /* noop */ }
      // Stay on the dark placeholder — still a valid cinematic state.
    };
    try { pre.src = url; } catch (e) { /* noop */ }
  }

  function cacheKey(item) { return mediaOf(item) + ':' + (item && item.id); }

  function resolveTrailerKey(item) {
    var ck = cacheKey(item);
    if (Object.prototype.hasOwnProperty.call(cache, ck)) {
      return Promise.resolve(cache[ck] || '');
    }
    var direct = validKey(item && item.trailer_key);
    if (direct) { cache[ck] = direct; return Promise.resolve(direct); }
    // List items carry no trailer_key — one detail fetch through the existing
    // Greybox API (server-shaped, secret stays server-side).
    var id = 0;
    try { id = parseInt(String(item && item.id), 10) || 0; } catch (e) { id = 0; }
    if (!id || !window.GreyboxData) { cache[ck] = ''; return Promise.resolve(''); }
    var mt = mediaOf(item);
    var p = mt === 'tv'
      ? window.GreyboxData.getTVDetails(id)
      : window.GreyboxData.getMovie(id);
    return p.then(
      function (d) {
        var k = validKey(d && d.trailer_key);
        cache[ck] = k;
        return k;
      },
      function () { cache[ck] = ''; return ''; }
    );
  }

  function showMute() {
    var m = $('hero-mute');
    if (!m) return;
    muted = true;
    m.textContent = '🔇';
    m.setAttribute('aria-label', 'Unmute trailer');
    m.setAttribute('aria-pressed', 'false');
    m.classList.remove('hidden');
  }

  function attachTrailer(key, myGen) {
    var wrap = $('hero-trailer-wrap');
    var frame = $('hero-trailer');
    if (!wrap || !frame || !key) return;
    cancelLoadTimer();
    var done = false;
    function cleanup() {
      if (done) return;
      done = true;
      cancelLoadTimer();
      if (myGen !== gen) return;
      try { frame.onload = null; frame.onerror = null; frame.removeAttribute('src'); } catch (e) { /* noop */ }
      wrap.classList.add('hidden');
      wrap.classList.remove('is-visible');
      var m = $('hero-mute');
      if (m) m.classList.add('hidden');
    }
    function onFail() { cleanup(); }
    loadTimer = setTimeout(onFail, TRAILER_LOAD_TIMEOUT_MS);
    frame.onload = function () {
      if (myGen !== gen) { cleanup(); return; }
      if (done) return;
      done = true;
      cancelLoadTimer();
      try {
        wrap.classList.remove('hidden');
        void wrap.offsetWidth;
        wrap.classList.add('is-visible');
        showMute(); // control appears exactly when the trailer starts playing
      } catch (e) { /* noop */ }
    };
    frame.onerror = onFail;
    try { frame.src = embedUrl(key); } catch (e) { cleanup(); }
  }

  function cancelLoadTimer() {
    if (loadTimer) { try { clearTimeout(loadTimer); } catch (e) { /* noop */ } loadTimer = 0; }
  }

  function fireTrailer(item, myGen) {
    timer = 0;
    if (myGen !== gen) return;
    if (!isHeroVisible()) return; // hero not on screen — stay on the still
    var key = '';
    try {
      resolveTrailerKey(item).then(function (k) {
        if (myGen !== gen) return;
        key = k || '';
        if (!key) return; // no trailer — beautiful still, no retry
        if (!isHeroVisible()) return;
        attachTrailer(key, myGen);
      });
    } catch (e) { /* stay on backdrop */ }
  }

  function scheduleTrailer(item, myGen) {
    cancelTimers();
    timer = setTimeout(function () { fireTrailer(item, myGen); }, TRAILER_DELAY_MS);
  }

  /* ---------------- public state ---------------- */

  function setHero(item) {
    if (!item) return null;
    stopTrailer();
    current = item;
    var myGen = gen;
    setText(item);
    loadBackdrop(item, myGen);
    scheduleTrailer(item, myGen);
    try { window.dispatchEvent(new CustomEvent('greybox:hero', { detail: { id: item.id } })); } catch (e) { /* noop */ }
    return item;
  }

  function setLoading(on) {
    var hero = heroEl();
    if (on) {
      stopTrailer();
      current = null;
      if (hero) { hero.classList.add('hero-loading'); hero.classList.remove('is-ready'); }
      var badge = $('hero-badge');
      var title = $('hero-title');
      var overview = $('hero-overview');
      var meta = $('hero-meta');
      if (badge) badge.textContent = 'Loading…';
      if (title) title.innerHTML = '<span class="hero-spinner"></span> Fetching trending…';
      if (meta) meta.innerHTML = '';
      if (overview) { overview.style.display = ''; overview.innerHTML = '<span class="skeleton skeleton-line"></span><span class="skeleton skeleton-line short"></span>'; }
      var m = $('hero-mute');
      if (m) m.classList.add('hidden');
      return;
    }
    if (hero) hero.classList.remove('hero-loading');
  }

  function clearLoading() {
    stopTrailer();
    var hero = heroEl();
    if (hero) hero.classList.remove('hero-loading');
  }

  function showError(message) {
    stopTrailer();
    current = null;
    var hero = heroEl();
    if (hero) { hero.classList.remove('hero-loading'); hero.classList.remove('is-ready'); }
    var badge = $('hero-badge');
    var title = $('hero-title');
    var overview = $('hero-overview');
    var meta = $('hero-meta');
    if (badge) badge.textContent = 'Offline';
    if (title) title.textContent = 'Could not load';
    if (meta) meta.innerHTML = '';
    if (overview) { overview.style.display = ''; overview.textContent = message || ''; }
  }

  function toggleMute() {
    var frame = $('hero-trailer');
    var btn = $('hero-mute');
    if (!frame || !frame.src || !btn || btn.classList.contains('hidden')) return;
    try {
      var func = muted ? 'unMute' : 'mute';
      frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func: func, args: [] }), '*');
      muted = !muted;
      btn.textContent = muted ? '🔇' : '🔊';
      btn.setAttribute('aria-label', muted ? 'Unmute trailer' : 'Mute trailer');
      btn.setAttribute('aria-pressed', muted ? 'false' : 'true');
    } catch (e) { /* keep current audio state on failure */ }
  }

  function defaultInfo(item) {
    try {
      if (window.Router && window.Router.url) {
        var mt = mediaOf(item);
        var url = mt === 'tv' ? window.Router.url.show(item.id) : window.Router.url.movie(item.id);
        window.Router.navigate(url);
        return;
      }
    } catch (e) { /* noop */ }
    try { window.location.href = '/'; } catch (ignored) { /* noop */ }
  }

  function defaultWatch(item) {
    // Existing Greybox behavior: movies play straight through Stream when a
    // source is configured; TV goes to detail (episode selection lives there).
    // Anything unplayable falls back to the detail route.
    try {
      var mt = mediaOf(item);
      if (mt === 'movie' && window.Stream && typeof window.Stream.getMovieUrl === 'function') {
        var url = window.Stream.getMovieUrl(item.id);
        if (url && window.Stream.Player && typeof window.Stream.Player.open === 'function') {
          window.Stream.Player.open({
            title: item.title || item.name || 'Movie',
            sub: 'Movie',
            url: url,
            mode: 'embed',
            progressKey: 'movie:' + item.id,
          });
          return;
        }
      }
    } catch (e) { /* fall through to detail */ }
    defaultInfo(item);
  }

  var bound = false;

  function bind(next) {
    if (next && typeof next === 'object') actions = next;
    if (bound) return; // idempotent: app.js re-binds with real actions, one listener set only
    bound = true;
    function on(el, fn) {
      try { if (el) el.addEventListener('click', fn); } catch (e) { /* noop */ }
    }
    on($('hero-play'), function () { if (current) { (actions.onWatch || defaultWatch)(current); } });
    on($('hero-info'), function () { if (current) { (actions.onInfo || defaultInfo)(current); } });
    on($('hero-list'), function () {
      if (!current) return;
      var added = false;
      try {
        if (typeof actions.onToggleList === 'function') added = !!actions.onToggleList(current);
        else if (window.GreyboxData && typeof window.GreyboxData.toggleMyListItem === 'function') {
          added = !!window.GreyboxData.toggleMyListItem(
            Object.assign({}, current, { media_type: mediaOf(current) })
          );
        }
      } catch (e) { added = false; }
      refreshListLabel();
      void added;
    });
    on($('hero-mute'), toggleMute);
    // Navigation invalidates any pending trailer — never play across routes.
    try {
      if (window.Router && typeof window.Router.onChange === 'function') {
        window.Router.onChange(function () { stopTrailer(); });
      }
    } catch (e) { /* router optional */ }
  }

  // Bind lazily if app.js never calls bind (legacy callers still render text).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bind(actions); });
  } else {
    bind(actions);
  }

  window.GreyboxHero = {
    TRAILER_DELAY_MS: TRAILER_DELAY_MS,
    TRAILER_LOAD_TIMEOUT_MS: TRAILER_LOAD_TIMEOUT_MS,
    configure: function (opts) {
      try {
        var d = opts && opts.delayMs != null ? parseInt(opts.delayMs, 10) : NaN;
        if (isFinite(d) && d >= 0 && d <= 60000) {
          TRAILER_DELAY_MS = d;
          window.GreyboxHero.TRAILER_DELAY_MS = d;
        }
      } catch (e) { /* noop */ }
    },
    bind: bind,
    setHero: setHero,
    setLoading: setLoading,
    clearLoading: clearLoading,
    showError: showError,
    reset: reset,
    getCurrent: function () { return current; },
    isMuted: function () { return muted; },
    toggleMute: toggleMute,
    embedUrl: embedUrl,
    metaHTML: metaHTML,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = window.GreyboxHero;
})();
