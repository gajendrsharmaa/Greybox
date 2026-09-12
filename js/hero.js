/* Greybox Phase 2 — cinematic hero module (+ Phase 3 seamless trailer).
 *
 * Owns ONLY the homepage/public hero: state, text, backdrop, trailer, audio.
 * No countdown ring, no loading indicator — the poster is authoritative until
 * the trailer proves it can actually play. Data comes from the existing flow
 * (list items via components.setHero, detail bundles via GreyboxData for
 * trailer_key). No hardcoding, no new backend, no token handling
 * (trailer_key arrives server-shaped through /api/*).
 *
 * Lifecycle: poster → (valid key + visible + tab visible) → iframe buffers
 * invisibly while the 7s delay runs → YouTube API confirms PLAYING →
 * crossfade above the poster. Any failure, scroll-away, tab-hide, or route
 * change tears down to the still; returning starts a completely fresh
 * sequence. One attempt per sequence, no repeated retries, no stale
 * callbacks (generation-guarded), one iframe element reused throughout.
 */
(function () {
  'use strict';

  /* The 7-second delay stays exactly 7000ms (single configurable value). */
  var TRAILER_DELAY_MS = 7000;
  /* Outer bound from buffering start: no usable playback by then → poster. */
  var TRAILER_READY_TIMEOUT_MS = 15000;

  /* "Meaningfully visible" = at least this much of the hero in viewport. */
  var VISIBLE_RATIO = 0.35;

  var YT_KEY = /^[A-Za-z0-9_-]{11}$/;
  var YT_ORIGIN = 'https://www.youtube.com';

  var cache = {}; // "mt:id" -> trailer key or null (session memo, avoids refetch)
  var gen = 0;    // invalidates timers/iframes/callbacks across lifecycles
  var readyTimer = 0;
  var delayRaf = 0;
  var fadeTimer = 0;
  var listenTimer = 0;
  var current = null;
  var trailerKey = '';
  var phase = 'idle'; // idle | resolving | delay | awaiting | playing | failed
  var delayElapsed = false;
  var hasPlayed = false;
  var apiReady = false;
  var playerGen = -1; // generation that owns the current iframe content
  var muted = true;
  var heroOnScreen = true; // corrected by IntersectionObserver as soon as it fires
  var routeAllowsHero = true; // corrected on every route change (see bind)
  var observerBound = false;
  var visBound = false;
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

  function cancelDelay() {
    if (delayRaf) {
      try {
        if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(delayRaf);
      } catch (e) { /* noop */ }
      delayRaf = 0;
    }
  }

  function cancelReady() {
    if (readyTimer) { try { clearTimeout(readyTimer); } catch (e) { /* noop */ } readyTimer = 0; }
    if (listenTimer) { try { clearTimeout(listenTimer); } catch (e) { /* noop */ } listenTimer = 0; }
  }

  function cancelFade() {
    if (fadeTimer) { try { clearTimeout(fadeTimer); } catch (e) { /* noop */ } fadeTimer = 0; }
  }

  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  }

  /* The mute/unmute button is the only circular media control. It is visible
   * exclusively while a trailer is playing — never during buffering. */
  function paintControl() {
    var b = $('hero-trailer-btn');
    if (!b) return;
    b.classList.remove('is-muted', 'is-unmuted');
    if (phase === 'playing') {
      b.classList.remove('hidden');
      b.classList.add(muted ? 'is-muted' : 'is-unmuted');
      b.setAttribute('aria-label', muted ? 'Unmute trailer' : 'Mute trailer');
      b.setAttribute('aria-pressed', muted ? 'false' : 'true');
    } else {
      b.classList.add('hidden');
    }
  }

  function hideControl() {
    var b = $('hero-trailer-btn');
    if (b) b.classList.add('hidden');
  }

  /* Backdrop image is never cleared — hiding the trailer reveals the still
   * underneath (no frozen frame, no black flash). Re-trigger Ken Burns so the
   * still feels alive again when we return to it. */
  function restoreBackdrop() {
    try {
      var hero = heroEl();
      if (!hero) return;
      if (hero.classList.contains('is-ready')) {
        hero.classList.remove('is-ready');
        void hero.offsetWidth;
        hero.classList.add('is-ready');
      }
    } catch (e) { /* noop */ }
  }

  /* Detach the player completely: handlers off, source gone, layer hidden.
   * The poster underneath was never removed, so nothing blank can show. */
  function detachTrailer() {
    cancelFade();
    cancelReady();
    try {
      var f = $('hero-trailer');
      if (f) { f.onload = null; f.onerror = null; try { f.removeAttribute('src'); } catch (e) { /* noop */ } }
      var w = $('hero-trailer-wrap');
      if (w) { w.classList.add('hidden'); w.classList.remove('is-visible'); w.classList.remove('is-buffering'); }
    } catch (e) { /* noop */ }
  }

  /* Conceal a visible trailer: stop playback now, then fade the still back in.
   * Failures detach instantly (an error surface must never linger or fade). */
  function concealTrailer(graceful) {
    cancelFade();
    var wrap = $('hero-trailer-wrap');
    var frame = $('hero-trailer');
    try {
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }), '*');
        frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'mute', args: [] }), '*');
      }
    } catch (e) { /* player already gone */ }
    muted = true;
    var showing = !!(wrap && !wrap.classList.contains('hidden') && wrap.classList.contains('is-visible'));
    if (wrap) wrap.classList.remove('is-visible');
    if (!graceful || !showing || reducedMotion()) { detachTrailer(); return; }
    var myGen = gen;
    fadeTimer = setTimeout(function () { if (myGen === gen) detachTrailer(); }, 1400);
  }

  /* Full stop of anything trailer-related. Text/backdrop art untouched. */
  function stopTrailer() {
    gen++;
    cancelDelay();
    phase = 'idle';
    trailerKey = '';
    delayElapsed = false;
    hasPlayed = false;
    apiReady = false;
    muted = true;
    hideControl();
    detachTrailer();
    restoreBackdrop();
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

  /* Fresh sequence gate: only when this hero is current, meaningfully visible,
   * tab visible, no overlay cover, and the user has not opted out while
   * staying on this hero. */
  function overlayOpen() {
    try {
      if (window.GreyboxComponents && typeof window.GreyboxComponents.isModalOpen === 'function' &&
        window.GreyboxComponents.isModalOpen()) return true;
    } catch (e) { /* noop */ }
    try {
      if (window.Stream && window.Stream.Player && typeof window.Stream.Player.current === 'function' &&
        window.Stream.Player.current()) return true;
    } catch (e) { /* noop */ }
    return false;
  }

  function beginSequence() {
    if (!current) return;
    if (phase === 'delay' || phase === 'awaiting' || phase === 'playing' || phase === 'resolving') return;
    if (!routeAllowsHero) return; // stale hero behind search/modals/etc never self-starts
    if (overlayOpen()) return; // detail modal / player covers the hero
    if (document.hidden || !heroOnScreen) return;
    phase = 'resolving';
    var myGen = gen;
    resolveTrailerKey(current).then(function (k) {
      if (myGen !== gen) return;
      if (!k) { phase = 'failed'; hideControl(); return; } // no trailer → still, no indicator
      if (document.hidden || !heroOnScreen || overlayOpen()) { phase = 'idle'; hideControl(); return; }
      trailerKey = k;
      bufferTrailer(k, myGen); // iframe loads invisibly right away…
      startDelay(myGen); // …while the exact 7s delay runs concurrently
    });
  }

  /* Silent 7s delay (no ring, no spinner, no label — pure timing). Doubles as
   * a visibility watchdog so leaving mid-delay tears down immediately. */
  function startDelay(myGen) {
    phase = 'delay';
    var t0 = 0;
    try { t0 = performance.now(); } catch (e) { try { t0 = Date.now(); } catch (ignored) { t0 = 0; } }
    function frame(now) {
      if (myGen !== gen || phase !== 'delay') return;
      // Rect check backs up the observer on browsers without IntersectionObserver.
      if (document.hidden || !heroOnScreen || !isHeroVisible()) { onHeroHidden(); return; }
      if (now - t0 >= TRAILER_DELAY_MS) {
        delayElapsed = true;
        maybeReveal(myGen);
        return;
      }
      try { delayRaf = window.requestAnimationFrame(frame); }
      catch (e) { stopTrailer(); }
    }
    cancelDelay();
    try { delayRaf = window.requestAnimationFrame(frame); }
    catch (e) { stopTrailer(); }
  }

  /* Reveal only when the delay has elapsed AND playback is confirmed. */
  function maybeReveal(myGen) {
    if (myGen !== gen) return;
    if (!delayElapsed || !hasPlayed) { if (phase === 'delay') phase = 'awaiting'; return; }
    if (phase !== 'delay' && phase !== 'awaiting') return;
    if (document.hidden || !heroOnScreen || overlayOpen()) { phase = 'idle'; hideControl(); return; }
    revealTrailer(myGen);
  }

  function revealTrailer(myGen) {
    if (myGen !== gen) return;
    var wrap = $('hero-trailer-wrap');
    if (!wrap) { failTrailer(); return; }
    cancelReady();
    try {
      wrap.classList.remove('is-buffering');
      void wrap.offsetWidth;
      wrap.classList.add('is-visible');
      phase = 'playing';
      muted = true;
      paintControl(); // mute control appears only now
    } catch (e) { failTrailer(); }
  }

  /* Any failure lands here: still image, no control, no message, no retry. */
  function failTrailer() {
    phase = 'failed';
    hideControl();
    detachTrailer();
  }

  /* Buffer invisibly from t=0: the wrapper stays in layout but paints nothing
   * (visibility:hidden beats any internal YouTube UI flash). Readiness comes
   * from the player API below - iframe `load` alone proves nothing. */
  function bufferTrailer(key, myGen) {
    var wrap = $('hero-trailer-wrap');
    var frame = $('hero-trailer');
    if (!wrap || !frame || !key) { failTrailer(); return; }
    playerGen = myGen;
    delayElapsed = false;
    hasPlayed = false;
    apiReady = false;
    try {
      wrap.classList.remove('hidden');
      wrap.classList.remove('is-visible');
      wrap.classList.add('is-buffering');
    } catch (e) { failTrailer(); return; }
    frame.onload = function () {
      if (myGen !== gen) return;
      sendListening();
      // One bounded handshake re-send: if the player missed the first one,
      // this still cannot loop (single timer, generation-guarded).
      cancelListenRetry();
      listenTimer = setTimeout(function () {
        if (myGen !== gen || playerGen !== gen) return;
        if (!apiReady && (phase === 'delay' || phase === 'awaiting')) sendListening();
      }, 2500);
    };
    frame.onerror = function () { if (myGen === gen) failTrailer(); };
    try { frame.src = embedUrl(key); } catch (e) { failTrailer(); return; }
    cancelReadyTimer();
    readyTimer = setTimeout(function () {
      if (myGen !== gen || playerGen !== gen) return;
      if (phase !== 'playing') failTrailer(); // never usable - poster, no retry
    }, TRAILER_READY_TIMEOUT_MS);
  }

  function cancelReadyTimer() {
    if (readyTimer) { try { clearTimeout(readyTimer); } catch (e) { /* noop */ } readyTimer = 0; }
  }

  function cancelListenRetry() {
    if (listenTimer) { try { clearTimeout(listenTimer); } catch (e) { /* noop */ } listenTimer = 0; }
  }

  function sendListening() {
    try {
      var frame = $('hero-trailer');
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1 }), '*');
      }
    } catch (e) { /* player not reachable - readiness timeout covers us */ }
  }

  /* YouTube player events (enablejsapi=1). Strictly validated: correct origin,
   * our own iframe window, current generation - a stale iframe can never
   * drive a newer hero. No URLs extracted, nothing proxied, nothing cached. */
  function onPlayerMessage(ev) {
    try {
      if (!ev || ev.origin !== YT_ORIGIN) return;
      var frame = $('hero-trailer');
      if (!frame || !frame.contentWindow || ev.source !== frame.contentWindow) return;
      var d = ev.data;
      if (typeof d === 'string') {
        try { d = JSON.parse(d); } catch (e) { return; }
      }
      if (!d || typeof d !== 'object' || playerGen !== gen) return;
      if (d.event === 'onReady') {
        apiReady = true;
        cancelListenRetry();
      } else if (d.event === 'onStateChange') {
        onPlayerState(Number(d.info));
      } else if (d.event === 'onError') {
        if (phase === 'delay' || phase === 'awaiting' || phase === 'playing') failTrailer();
      }
    } catch (e) { /* ignore malformed player chatter */ }
  }

  function onPlayerState(info) {
    if (playerGen !== gen) return;
    if (info === 1) { // actually playing - the only proof we accept
      hasPlayed = true;
      if (phase === 'awaiting' || phase === 'delay') maybeReveal(gen);
    }
    // Every other state (unstarted cued buffering paused ended) means "not
    // demonstrably playing" - the readiness timeout bounds the wait.
  }

  /* ---------------- public state ---------------- */

  function setHero(item) {
    if (!item) return null;
    stopTrailer();
    current = item;
    setText(item);
    loadBackdrop(item, gen);
    beginSequence();
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
      hideControl();
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
    if (phase !== 'playing') return;
    var frame = $('hero-trailer');
    var btn = $('hero-trailer-btn');
    if (!frame || !frame.src || !btn || btn.classList.contains('hidden')) return;
    try {
      var func = muted ? 'unMute' : 'mute';
      frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func: func, args: [] }), '*');
      // Audio is never remembered: a fresh trailer always starts muted.
      muted = !muted;
      paintControl();
    } catch (e) { /* keep current audio state on failure */ }
  }

  /* The button exists only while playing (no countdown control anymore). */
  function controlActivate() {
    if (phase === 'playing') toggleMute();
  }

  /* Graceful leave (scroll-away): playback stops now, the still fades back.
   * Everything else (tab-hide, route, hero change, failure) is immediate. */
  function onHeroHidden() {
    heroOnScreen = false;
    gen++;
    cancelDelay();
    phase = 'idle';
    trailerKey = '';
    delayElapsed = false;
    hasPlayed = false;
    apiReady = false;
    muted = true;
    hideControl();
    concealTrailer(true);
    restoreBackdrop();
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
    on($('hero-trailer-btn'), controlActivate);
    // Single global player-message listener (source-validated per event).
    try { window.addEventListener('message', onPlayerMessage); } catch (e) { /* noop */ }
    // Navigation invalidates any pending trailer — never play across routes.
    // Auto-restart on return is limited to hero-owning routes so a stale hero
    // behind search/modals never self-starts a trailer.
    try {
      if (window.Router && typeof window.Router.onChange === 'function') {
        window.Router.onChange(function (route) {
          stopTrailer();
          try {
            routeAllowsHero = !!route && (route.name === 'home' || route.name === 'movies' ||
              route.name === 'tv' || route.name === 'anime' || route.name === 'collection');
          } catch (e) { routeAllowsHero = true; }
        });
      }
    } catch (e) { /* router optional */ }
    ensureObserver();
    ensureTabHandler();
  }

  /* Single IntersectionObserver (not a scroll listener): leaving the hero
   * tears down to the still immediately; returning starts a fresh sequence. */
  function ensureObserver() {
    if (observerBound) return;
    observerBound = true;
    try {
      if (typeof IntersectionObserver === 'undefined') return; // rect gates still apply
      var ob = new IntersectionObserver(function (entries) {
        var vis = false;
        try {
          for (var i = 0; i < entries.length; i++) {
            var en = entries[i];
            if (en.isIntersecting && en.intersectionRatio >= VISIBLE_RATIO) { vis = true; break; }
          }
        } catch (e) { vis = false; }
        heroOnScreen = vis;
        if (!vis) { onHeroHidden(); return; }
        if (current && phase === 'idle' && !document.hidden) beginSequence();
      }, { threshold: [0, VISIBLE_RATIO, 1] });
      var h = heroEl();
      if (h) ob.observe(h);
    } catch (e) { /* rect gates still apply */ }
  }

  /* Hidden tabs never keep a countdown or playback alive; returning starts
   * fresh (muted) rather than resuming. */
  function ensureTabHandler() {
    if (visBound) return;
    visBound = true;
    try {
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) { stopTrailer(); return; }
        if (current && phase === 'idle' && heroOnScreen) beginSequence();
      });
    } catch (e) { /* noop */ }
  }

  // Bind lazily if app.js never calls bind (legacy callers still render text).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bind(actions); });
  } else {
    bind(actions);
  }

  window.GreyboxHero = {
    TRAILER_DELAY_MS: TRAILER_DELAY_MS,
    TRAILER_READY_TIMEOUT_MS: TRAILER_READY_TIMEOUT_MS,
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
    getPhase: function () { return phase; },
    isMuted: function () { return muted; },
    toggleMute: toggleMute,
    embedUrl: embedUrl,
    metaHTML: metaHTML,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = window.GreyboxHero;
})();
