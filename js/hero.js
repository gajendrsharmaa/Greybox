/* Greybox Phase 2 — cinematic hero module (+ Phase 3 seamless trailer,
 * + Part 2 Hero Control Center presentation layer).
 *
 * The trailer plays as a BACKGROUND video, never as a visible YouTube
 * player: the embed requests a chromeless player (controls=0, fs=0,
 * disablekb=1, modest branding, no annotations), the iframe is overscan-
 * cropped in css/hero.css so residual YouTube edge chrome renders outside
 * the visible hero, pointer events never reach YouTube, and a naturally
 * ending non-loop trailer falls back to the still instead of lingering on
 * the endscreen. The only trailer control is Greybox's own circular
 * mute/unmute button (visible exclusively while playing); Watch Now, More
 * Info and In My List are untouched hero actions.
 *
 * Owns ONLY the homepage/public hero: state, text, backdrop, trailer, audio.
 * No countdown ring, no loading indicator — the poster is authoritative until
 * the trailer proves it can actually play. Data comes from the existing flow
 * (list items via components.setHero, detail bundles via GreyboxData for
 * trailer_key). No hardcoding, no new backend, no token handling
 * (trailer_key arrives server-shaped through /api/*).
 *
  * Presentation (artwork/trailer/logo) arrives per hero via setHero(item,
  * presentation) or configureHero(presentation) — both sanitized here, so a
  * hand-edited or older config can never break rendering. The title layer is
  * automatic by default: the hero shows the title's official TMDB logo
  * artwork when a usable one exists and falls back to the normal text title
  * otherwise (explicit `text` keeps text-only, `custom` uses a custom URL).
  * Unknown values fall back to the automatic behavior. Admin writes the
  * config through /api/admin/*; the public page only ever reads it.
 *
 * Lifecycle: poster → (valid key + visible + tab visible) → iframe buffers
 * invisibly while the delay runs → YouTube API confirms PLAYING →
 * crossfade above the poster. Any failure, scroll-away, tab-hide, or route
 * change tears down to the still; returning starts a completely fresh
 * sequence. One attempt per sequence, no repeated retries, no stale
 * callbacks (generation-guarded), one iframe element reused throughout.
 *
 * Wait-once activation is the deliberate exception to "fresh sequence":
 * the delay is skipped on return for an identity whose wait already started
 * (page-lifetime, per media identity — see waitStarted/waitDone). Timers and
 * iframes are still torn down on leave (no background playback); only the
 * logical "wait already began" survives, so the timer is never restarted.
 */
(function () {
  'use strict';

  /* The 7-second delay stays exactly 7000ms (single configurable value). */
  var TRAILER_DELAY_MS = 7000;
  /* Outer bound from buffering start: no usable playback by then → poster. */
  var TRAILER_READY_TIMEOUT_MS = 15000;

  /* ---------------- Part 2 presentation (sanitized, additive) ---------------- */

  function defaultPresentation() {
    return {
      // Title artwork is automatic: try the official TMDB logo for the hero
      // item, fall back to the text title when none is usable. Explicit
      // `text` keeps text-only; `custom` uses `logoUrl`.
      artwork: { backdrop: 'auto', backdropUrl: '', logo: 'tmdb', logoUrl: '' },
      trailer: { source: 'auto', key: '', activation: 'delayed', delaySec: 7, muted: true, loop: true },
    };
  }

  // Sanitize anything the config layer hands over (admin-saved, hand-edited,
  // or older rows). The logo default is automatic (`tmdb`): only an explicit
  // `text` keeps the text-only title and only a `custom` with a valid URL
  // uses a custom logo — a missing/older/unknown value tries TMDB artwork
  // with the text title as the fallback, never a broken state.
  function sanitizePresentation(p) {
    var out = defaultPresentation();
    try {
      var raw = (p && typeof p === 'object' && !Array.isArray(p)) ? p : {};
      var a = (raw.artwork && typeof raw.artwork === 'object' && !Array.isArray(raw.artwork)) ? raw.artwork : {};
      var t = (raw.trailer && typeof raw.trailer === 'object' && !Array.isArray(raw.trailer)) ? raw.trailer : {};
      out.artwork.backdrop = a.backdrop === 'custom' ? 'custom' : 'auto';
      out.artwork.backdropUrl = (typeof a.backdropUrl === 'string' && /^https?:\/\//i.test(a.backdropUrl.trim())) ? a.backdropUrl.trim().slice(0, 500) : '';
      if (out.artwork.backdrop === 'custom' && !out.artwork.backdropUrl) out.artwork.backdrop = 'auto';
      out.artwork.logo = a.logo === 'custom' ? 'custom' : (a.logo === 'text' ? 'text' : 'tmdb');
      out.artwork.logoUrl = (typeof a.logoUrl === 'string' && /^https?:\/\//i.test(a.logoUrl.trim())) ? a.logoUrl.trim().slice(0, 500) : '';
      if (out.artwork.logo === 'custom' && !out.artwork.logoUrl) out.artwork.logo = 'text';
      out.trailer.source = t.source === 'custom' ? 'custom' : (t.source === 'off' ? 'off' : 'auto');
      out.trailer.key = validKey(t.key);
      if (out.trailer.source === 'custom' && !out.trailer.key) out.trailer.source = 'auto';
      out.trailer.activation = t.activation === 'immediate' ? 'immediate' : (t.activation === 'wait-once' ? 'wait-once' : 'delayed');
      var ds = parseInt(t.delaySec, 10);
      out.trailer.delaySec = (isFinite(ds) && ds >= 0 && ds <= 120) ? ds : 7;
      out.trailer.muted = t.muted !== false;
      out.trailer.loop = t.loop !== false;
    } catch (e) { /* fall back to defaults on anything unexpected */ }
    return out;
  }

  // Active presentation for the current hero. Set per setHero(item,
  // presentation) so routes/collections can never leak config into each
  // other; configureHero() only changes the default for bare setHero calls.
  var presentation = defaultPresentation();

  function configureHero(p) {
    presentation = sanitizePresentation(p);
    return presentation;
  }

  // Wait-once progress: page-lifetime, keyed by media identity ("mt:id").
  // Scope rationale: the module already memos trailer keys per identity for
  // the page lifetime (`cache`); identity+page matches the "established
  // state" requirement without localStorage (no cross-load persistence is
  // needed — a reload is a genuinely new visit and browsers block
  // autoplay-before-interaction anyway). Timers/iframes are still torn down
  // on leave; only "the wait already began / the trailer already played"
  // survives, so the delay is skipped — never restarted — on return.
  var waitStarted = {}; // identity -> true once its wait-once delay has begun
  var waitDone = {}; // identity -> true once its trailer has revealed

  function trailerDelayMs(pres, identity) {
    var t = (pres && pres.trailer) || {};
    if (t.source === 'off') return -1; // no trailer at all
    if (t.activation === 'immediate') return 0;
    if (t.activation === 'wait-once' && identity && (waitStarted[identity] || waitDone[identity])) return 0;
    var ds = parseInt(t.delaySec, 10);
    if (!isFinite(ds) || ds < 0) ds = 7;
    if (ds > 120) ds = 120;
    return ds * 1000;
  }

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
  // Media identity ("mt:id", e.g. "tv:1399") of the item whose text/backdrop
  // is currently displayed. Backdrop/trailer async completions must match
  // BOTH this identity and the generation — so a slow Moana response can
  // never paint over Game of Thrones text (Title A + Backdrop B impossible).
  var currentIdentity = null;
  var trailerKey = '';
  var phase = 'idle'; // idle | resolving | delay | playing | failed
  var delayElapsed = false;
  var hasPlayed = false;
  var apiReady = false;
  var playerGen = -1; // generation that owns the current iframe content
  var muted = true;
  var heroOnScreen = true; // corrected by IntersectionObserver as soon as it fires
  var routeAllowsHero = true; // corrected on every route change (see bind)
  var observerBound = false;
  var visBound = false;
  var asks = 0; // `listening` handshakes sent this lifecycle (diagnostics)
  var loads = 0; // iframe load events this lifecycle (diagnostics)
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

  /* Dev-only diagnostics: silent unless explicitly enabled in this browser via
   * localStorage `greybox:hero-debug = 1` (plus `GreyboxHero.debug()` below).
   * Never logs in production by default. */
  function dbg() {
    try {
      if (window.localStorage && window.localStorage.getItem('greybox:hero-debug') === '1' &&
        window.console && typeof window.console.debug === 'function') {
        window.console.debug.apply(window.console, ['[hero]'].concat(Array.prototype.slice.call(arguments)));
      }
    } catch (e) { /* diagnostics never break playback */ }
  }

  function mediaOf(item) {
    if (!item) return 'movie';
    if (item.media_type === 'tv' || item.media_type === 'movie') return item.media_type;
    // Shaped items alias title/name on both media types: title alone would
    // misclassify TV as movie (wrong trailer fetch/cache key/route). Well-
    // formed items (media_type present) never reach this fallback.
    return (item.title && !item.first_air_date) ? 'movie' : 'tv';
  }

  function validKey(k) {
    var s = String(k == null ? '' : k).trim();
    return YT_KEY.test(s) ? s : '';
  }

  function embedUrl(key) {
    var mutedParam = !(presentation.trailer && presentation.trailer.muted === false);
    var loopParam = !(presentation.trailer && presentation.trailer.loop === false);
    // Unmuted autoplay is offered but never guaranteed: if the browser
    // blocks it, the failure path below keeps the still (honest fallback).
    //
    // Background-video player configuration: the trailer must play as
    // cinematic scenery, never as a visible YouTube player. controls=0
    // suppresses the control bar by request, but YouTube still paints
    // residual chrome that controls=0 does NOT suppress (top title bar on
    // start, playlist prev/next affordances — loop mode below makes this a
    // single-item playlist player — center pause flashes on state changes,
    // endscreen when a non-looping trailer ends). So this is only half the
    // fix: css/hero.css additionally overscans the iframe (scale crop inside
    // overflow:hidden) so all edge chrome renders outside the visible hero,
    // and onPlayerState() conceals the endscreen on natural end. fs=0 keeps
    // the fullscreen affordance out; disablekb=1 (+ tabindex -1 in markup)
    // keeps keyboard focus from ever driving the player.
    var url = 'https://www.youtube.com/embed/' + key +
      '?autoplay=1&controls=0&fs=0&rel=0&playsinline=1' +
      (mutedParam ? '&mute=1' : '') +
      (loopParam ? '&loop=1&playlist=' + key : '') +
      '&modestbranding=1&iv_load_policy=3&disablekb=1&enablejsapi=1';
    return url;
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
    cancelListenPoll();
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

  function reset() { stopTrailer(); clearLogo(); }

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
    var meta = $('hero-meta');
    var badge = $('hero-badge');
    if (badge) badge.textContent = ''; // clean hero: no badge in normal state
    if (title) title.textContent = item.title || item.name || 'Untitled';
    if (meta) meta.innerHTML = metaHTML(item);
    refreshListLabel();
    paintLogo(item, gen, currentIdentity);
  }

  /* Title/logo layer: text is always set (screen readers, no-logo fallback).
   * A resolved logo image replaces it visually; any logo failure falls back
   * to the text — never a broken icon, never another title's asset. */
  var logoCache = {}; // identity -> logo URL ('' = none known)

  function clearLogo() {
    try {
      var title = $('hero-title');
      var logo = $('hero-logo');
      if (logo) { try { logo.onerror = null; } catch (e) { /* noop */ } try { logo.removeAttribute('src'); } catch (e2) { /* noop */ } logo.classList.add('hidden'); }
      if (title) title.classList.remove('has-logo');
    } catch (e) { /* noop */ }
  }

  function applyLogo(url, myGen, expectedIdentity) {
    if (myGen !== gen) return;
    if (expectedIdentity == null || currentIdentity !== expectedIdentity) return;
    var title = $('hero-title');
    var logo = $('hero-logo');
    if (!logo || !url) { clearLogo(); return; }
    try {
      logo.onerror = function () {
        if (myGen !== gen) return;
        if (expectedIdentity == null || currentIdentity !== expectedIdentity) return;
        clearLogo(); // broken logo URL → text title, never a broken icon
      };
      logo.alt = '';
      logo.src = url;
      logo.classList.remove('hidden');
      if (title) title.classList.add('has-logo');
    } catch (e) { clearLogo(); }
  }

  // Best-logo selection over a TMDB `/images` payload (`{ logos: [...] }`)
  // or a bare logos array. Pure: '' when nothing is usable, otherwise the
  // full image URL. Ranking: English logos first, then language-neutral
  // (`iso_639_1: null` — usually textless/official art), then every other
  // language; within a rank the community's highest-rated logo wins
  // (`vote_average`, ties broken by `vote_count`, first-seen keeps the rest
  // stable). Paths are validated so a hostile payload can never escape the
  // TMDB image host.
  function pickLogoUrl(data) {
    try {
      var logos = (data && Array.isArray(data.logos)) ? data.logos : (Array.isArray(data) ? data : []);
      if (!logos.length) return '';
      var best = '', bestRank = 99, bestVote = -1, bestCount = -1;
      for (var i = 0; i < logos.length; i++) {
        var l = logos[i];
        if (!l || typeof l.file_path !== 'string' || !l.file_path) continue;
        var fp = l.file_path;
        if (fp.indexOf('..') >= 0 || !/^\/[A-Za-z0-9/_\-.]+$/.test(fp)) continue;
        var lang = (l.iso_639_1 == null) ? '' : String(l.iso_639_1);
        var rank = (lang === 'en') ? 0 : (lang === '' ? 1 : 2);
        var vote = Number(l.vote_average);
        if (!isFinite(vote) || vote < 0) vote = 0;
        var count = Number(l.vote_count);
        if (!isFinite(count) || count < 0) count = 0;
        if (rank < bestRank || (rank === bestRank && (vote > bestVote || (vote === bestVote && count > bestCount)))) {
          best = fp; bestRank = rank; bestVote = vote; bestCount = count;
        }
      }
      if (!best) return '';
      return 'https://image.tmdb.org/t/p/w500' + best;
    } catch (e) { return ''; }
  }

  // Logo data already carried by the hero item (detail bundles) — reuse it
  // instead of fetching `/images` again. Accepts the shapes the Greybox
  // pipeline may attach over time: a full `logo_url`/`logoUrl`, a TMDB
  // `logo_path`/`logoPath`, or a `logos` / `images.logos` array (ranked via
  // pickLogoUrl). Pure: '' when the item carries nothing usable.
  function itemLogoUrl(item) {
    try {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
      var u = item.logo_url != null ? item.logo_url : item.logoUrl;
      if (typeof u === 'string' && u.trim() && /^https?:\/\//i.test(u.trim())) return u.trim().slice(0, 500);
      var p = item.logo_path != null ? item.logo_path : item.logoPath;
      if (typeof p === 'string' && p) {
        var t = p.trim();
        if (/^https?:\/\//i.test(t)) return t.slice(0, 500);
        if (t.indexOf('..') < 0 && /^\/[A-Za-z0-9/_\-.]+$/.test(t)) return 'https://image.tmdb.org/t/p/w500' + t;
      }
      if (Array.isArray(item.logos)) return pickLogoUrl(item.logos);
      if (item.images && typeof item.images === 'object' && Array.isArray(item.images.logos)) {
        return pickLogoUrl(item.images.logos);
      }
    } catch (e) { /* fall through to '' */ }
    return '';
  }

  function paintLogo(item, myGen, expectedIdentity) {
    var art = (presentation.artwork) || {};
    if (art.logo === 'custom' && typeof art.logoUrl === 'string' && /^https?:\/\//i.test(art.logoUrl.trim())) {
      clearLogo();
      applyLogo(art.logoUrl.trim(), myGen, expectedIdentity);
      return;
    }
    // Explicit text-only title: never a logo, never a fetch.
    if (art.logo === 'text') { clearLogo(); return; }
    // Automatic (default): official TMDB logo artwork when a usable one
    // exists, the existing text title otherwise. Fetches through the
    // existing server-side proxy (secret stays server-side); anything the
    // item already carries is reused so the same data is never requested
    // twice. Cached per media identity; guarded like all hero async work.
    var mt = mediaOf(item);
    var id = 0;
    try { id = parseInt(String(item && item.id), 10) || 0; } catch (e) { id = 0; }
    var identity = mt + ':' + id;
    if (!id) { clearLogo(); return; }
    // Drop any previous hero's logo synchronously: the text title (always in
    // the DOM) covers the gap, so a slow response can never leave stale
    // artwork over the new title.
    clearLogo();
    var carried = itemLogoUrl(item);
    if (carried) {
      logoCache[identity] = carried;
      applyLogo(carried, myGen, expectedIdentity);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(logoCache, identity)) {
      if (logoCache[identity]) applyLogo(logoCache[identity], myGen, expectedIdentity);
      // else: known to have no usable logo — text title already showing.
      return;
    }
    var url = '/api/tmdb/' + mt + '/' + id + '/images?language=en-US&include_image_language=en,null';
    var p;
    try { p = fetch(url, { headers: { accept: 'application/json' } }); }
    catch (e) { logoCache[identity] = ''; return; }
    p.then(function (r) {
      if (!r.ok) throw new Error('logo fetch failed');
      return r.json();
    }).then(function (d) {
      var picked = pickLogoUrl(d);
      logoCache[identity] = picked;
      if (picked) applyLogo(picked, myGen, expectedIdentity);
      // else: no usable logo — text title already showing, nothing to do.
    }, function () {
      logoCache[identity] = '';
      // Text title already showing; the guards inside applyLogo/clearLogo
      // still protect the current hero, so nothing else is needed here.
    });
  }

  /* Poster-derived page ambient (increment: hero ambient background).
   * Reuses the exact poster URL already resolved for the hero still — no
   * hardcoded color, no per-movie palette, no canvas, no video-frame
   * processing. The blurred CSS layer (#page-ambient-img, css/hero.css)
   * sits behind hero/main/footer and only contributes color/light, never a
   * recognizable poster. Updated only here (hero ready) + showError/
   * setLoading/pages renderNotFound clear paths, so it always follows the
   * current hero identity via the same gen+identity guards as the still. */
  function setPageAmbient(url) {
    try {
      var host = $('page-ambient');
      var el = $('page-ambient-img');
      if (!host || !el || !url) return;
      el.alt = '';
      // Assigning the same URL the hero just preloaded is cache-hot: no
      // extra network cost beyond the blurred CSS presentation.
      if (el.getAttribute('src') !== url) el.src = url;
      host.classList.add('is-visible');
    } catch (e) { /* ambient never breaks hero */ }
  }

  function hidePageAmbient() {
    try {
      var host = $('page-ambient');
      if (host) host.classList.remove('is-visible');
    } catch (e) { /* noop */ }
  }

  function clearPageAmbient() {
    try {
      var el = $('page-ambient-img');
      if (el) { try { el.removeAttribute('src'); } catch (e) { /* noop */ } }
    } catch (e) { /* noop */ }
    hidePageAmbient();
  }

  function loadBackdrop(item, myGen, expectedIdentity) {
    var hero = heroEl();
    var img = $('hero-img');
    var ambient = $('hero-ambient');
    var url = '';
    try {
      // Custom artwork (admin-configured) wins over TMDB when set; the same
      // identity+generation guards below keep it bound to this title.
      var art = (presentation.artwork) || {};
      if (art.backdrop === 'custom' && typeof art.backdropUrl === 'string' && /^https?:\/\//i.test(art.backdropUrl.trim())) {
        url = art.backdropUrl.trim();
      } else {
        var IMG_BIG = (window.GreyboxComponents && window.GreyboxComponents.IMG_BIG) || 'https://image.tmdb.org/t/p/original';
        var IMG = (window.GreyboxComponents && window.GreyboxComponents.IMG) || 'https://image.tmdb.org/t/p/w500';
        if (item.backdrop_path) url = IMG_BIG + item.backdrop_path;
        else if (item.poster_path) url = IMG + item.poster_path;
      }
    } catch (e) { url = ''; }
    if (!url || !img) {
      if (hero) hero.classList.remove('hero-loading');
      return;
    }
    // Preload off-DOM: fade in only when ready, never a broken icon. The
    // completion must still belong to the displayed media identity AND the
    // generation — a stale/slow response for another item is dropped even if
    // the generation somehow matches, so title and artwork can never split.
    var pre = new Image();
    pre.decoding = 'async';
    pre.onload = function () {
      if (myGen !== gen) return;
      if (expectedIdentity == null || currentIdentity !== expectedIdentity) return;
      try {
        img.src = url;
        img.alt = '';
        if (ambient) { ambient.src = url; ambient.alt = ''; }
        setPageAmbient(url);
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
      if (expectedIdentity == null || currentIdentity !== expectedIdentity) return;
      try { if (hero) hero.classList.remove('hero-loading'); } catch (e) { /* noop */ }
      // Stay on the dark placeholder — still a valid cinematic state. Never
      // fall back to another media item's artwork.
    };
    try { pre.src = url; } catch (e) { /* noop */ }
  }

  function cacheKey(item) { return mediaOf(item) + ':' + (item && item.id); }

  function resolveTrailerKey(item) {
    var ck = cacheKey(item);
    if (Object.prototype.hasOwnProperty.call(cache, ck)) {
      return Promise.resolve(cache[ck] || '');
    }
    var tsrc = ((presentation.trailer) || {}).source || 'auto';
    if (tsrc === 'off') { cache[ck] = ''; return Promise.resolve(''); }
    if (tsrc === 'custom') {
      // Admin-configured key (validated at save, re-validated at use): no
      // detail fetch needed, and the key stays bound to this identity via
      // the same cache key as automatic resolution.
      var custom = validKey(presentation.trailer && presentation.trailer.key);
      cache[ck] = custom;
      return Promise.resolve(custom);
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
    if (phase === 'delay' || phase === 'playing' || phase === 'resolving') return;
    if (!routeAllowsHero) return; // stale hero behind search/modals/etc never self-starts
    if (overlayOpen()) return; // detail modal / player covers the hero
    if (document.hidden || !heroOnScreen) return;
    if (((presentation.trailer) || {}).source === 'off') { phase = 'idle'; hideControl(); return; } // trailer disabled → still
    phase = 'resolving';
    var myGen = gen;
    var expectedIdentity = currentIdentity;
    resolveTrailerKey(current).then(function (k) {
      if (myGen !== gen) return;
      if (expectedIdentity == null || currentIdentity !== expectedIdentity) return;
      if (!k) { phase = 'failed'; hideControl(); return; } // no trailer → still, no indicator
      if (document.hidden || !heroOnScreen || overlayOpen()) { phase = 'idle'; hideControl(); return; }
      trailerKey = k;
      bufferTrailer(k, myGen); // iframe loads invisibly right away…
      startDelay(myGen, expectedIdentity); // …while the configured delay runs concurrently
    });
  }

  /* Configured delay (silent — no ring, no spinner, no label; pure timing).
   * Doubles as a visibility watchdog so leaving mid-delay tears down
   * immediately. Wait-once skips the wait for identities that already began
   * it (see waitStarted/waitDone): the timer is never restarted on return. */
  function startDelay(myGen, expectedIdentity) {
    phase = 'delay';
    var ms = trailerDelayMs(presentation, expectedIdentity);
    var act = ((presentation.trailer) || {}).activation || 'delayed';
    if (act === 'wait-once' && expectedIdentity && !waitStarted[expectedIdentity]) {
      waitStarted[expectedIdentity] = true;
    }
    var t0 = 0;
    try { t0 = performance.now(); } catch (e) { try { t0 = Date.now(); } catch (ignored) { t0 = 0; } }
    function frame(now) {
      if (myGen !== gen || phase !== 'delay') return;
      // Rect check backs up the observer on browsers without IntersectionObserver.
      if (document.hidden || !heroOnScreen || !isHeroVisible()) { onHeroHidden(); return; }
      if (now - t0 >= ms) {
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

  /* Reveal only when the delay has elapsed AND playback is confirmed.
   * The delay loop keeps running to expiry even if PLAYING arrives early;
   * a late PLAYING completes via the player event itself. */
  function maybeReveal(myGen) {
    if (myGen !== gen) return;
    if (!delayElapsed || !hasPlayed) return;
    if (phase !== 'delay') return;
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
      if (currentIdentity) waitDone[currentIdentity] = true;
      paintControl(); // mute control appears only now
      dbg('trailer revealed');
    } catch (e) { failTrailer(); }
  }

  /* Any failure lands here: still image, no control, no message, no retry. */
  function failTrailer(why) {
    dbg('trailer failed:', why || 'unknown');
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
    asks = 0;
    loads = 0;
    dbg('buffering new trailer');
    try {
      wrap.classList.remove('hidden');
      wrap.classList.remove('is-visible');
      wrap.classList.add('is-buffering');
    } catch (e) { failTrailer(); return; }
    frame.onload = function () {
      if (myGen !== gen) return;
      loads++;
      dbg('iframe load, polling for player');
      sendListening();
      // Keep asking until the player answers: the embed drops `listening`
      // sent before its own script runs (YouTube's own widget polls uncapped).
      // Bounded by apiReady + the single readiness deadline - never infinite.
      startListenPoll(myGen);
    };
    frame.onerror = function () { if (myGen === gen) failTrailer(); };
    try { frame.src = embedUrl(key); } catch (e) { failTrailer(); return; }
    cancelReadyTimer();
    readyTimer = setTimeout(function () {
      if (myGen !== gen || playerGen !== gen) return;
      if (phase !== 'playing') failTrailer('ready-timeout'); // never usable - poster, no retry
    }, TRAILER_READY_TIMEOUT_MS);
  }

  function cancelReadyTimer() {
    if (readyTimer) { try { clearTimeout(readyTimer); } catch (e) { /* noop */ } readyTimer = 0; }
  }

  function cancelListenPoll() {
    if (listenTimer) { try { clearInterval(listenTimer); } catch (e) { /* noop */ } listenTimer = 0; }
  }

  function startListenPoll(myGen) {
    cancelListenPoll();
    listenTimer = setInterval(function () {
      if (myGen !== gen || playerGen !== gen) { cancelListenPoll(); return; }
      if (apiReady || phase !== 'delay') { cancelListenPoll(); return; }
      sendListening();
    }, 500);
  }

  function sendListening() {
    try {
      var frame = $('hero-trailer');
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage(JSON.stringify({
          event: 'listening', id: frame.id || 'hero-trailer', channel: 'widget',
        }), '*');
        asks++;
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
      // Any accepted message proves the bridge is up - stop asking.
      apiReady = true;
      cancelListenPoll();
      if (d.event === 'onReady') {
        dbg('player ready');
      } else if (d.event === 'onStateChange') {
        onPlayerState(Number(d.info));
      } else if (d.event === 'infoDelivery' || d.event === 'info') {
        // Full/patch state push: catches "already playing" with no later change.
        var pst = d.info && typeof d.info === 'object' ? Number(d.info.playerState) : NaN;
        if (pst === 1) onPlayerState(1);
      } else if (d.event === 'onError') {
        if (phase === 'delay' || phase === 'playing') failTrailer('yt-error');
      }
    } catch (e) { /* ignore malformed player chatter */ }
  }

  function onPlayerState(info) {
    if (playerGen !== gen) return;
    if (info === 1) { // actually playing - the only proof we accept
      hasPlayed = true;
      if (phase === 'delay') maybeReveal(gen);
      return;
    }
    if (info === 0) { // natural end: never leave the endscreen ("More
      // videos") over the hero — fall back to the still (loop mode wraps
      // by itself and is deliberately untouched here).
      onTrailerEnded();
      return;
    }
    // Every other state (unstarted cued buffering paused) means "not
    // demonstrably playing" - the readiness timeout bounds the wait.
  }

  // Natural end of a NON-looping trailer: the YouTube endscreen is player UI
  // that must never sit over the cinematic hero. Same fallback philosophy as
  // failTrailer (still image, no control, no message), but restartable: the
  // generation and identity are kept, so leaving/returning may start a fresh
  // sequence via beginSequence exactly like any other idle hero.
  function onTrailerEnded() {
    if (((presentation.trailer) || {}).loop !== false) return; // loop wraps by itself
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

  /* ---------------- public state ---------------- */

  function setHero(item, pres) {
    if (!item) return null;
    stopTrailer();
    // Per-hero presentation travels with the item (routes/collections can
    // never leak config into each other). Bare calls keep the configured
    // default. Sanitized: unknown logo values → automatic TMDB artwork.
    if (pres !== undefined) presentation = sanitizePresentation(pres);
    current = item;
    // Capture this item's identity synchronously with its text: every async
    // artwork/trailer completion below must still match it before painting.
    currentIdentity = cacheKey(item);
    setText(item);
    loadBackdrop(item, gen, currentIdentity);
    beginSequence();
    try { window.dispatchEvent(new CustomEvent('greybox:hero', { detail: { id: item.id } })); } catch (e) { /* noop */ }
    return item;
  }

  function setLoading(on) {
    var hero = heroEl();
    if (on) {
      stopTrailer();
      current = null;
      currentIdentity = null;
      clearLogo(); // loading copy must be visible, never hidden behind a stale logo
      if (hero) { hero.classList.add('hero-loading'); hero.classList.remove('is-ready'); }
      hidePageAmbient();
      var badge = $('hero-badge');
      var title = $('hero-title');
      var meta = $('hero-meta');
      if (badge) badge.textContent = 'Loading…';
      if (title) title.innerHTML = '<span class="hero-spinner"></span> Fetching trending…';
      if (meta) meta.innerHTML = '';
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
    currentIdentity = null;
    clearLogo(); // error copy must be visible, never hidden behind a stale logo
    // Error text must never sit over another item's artwork: drop the still
    // back to the dark placeholder (existing valid cinematic state).
    try {
      var staleImg = $('hero-img');
      if (staleImg) { try { staleImg.removeAttribute('src'); } catch (e) { /* noop */ } }
      var staleAmbient = $('hero-ambient');
      if (staleAmbient) { try { staleAmbient.removeAttribute('src'); } catch (e) { /* noop */ } }
      clearPageAmbient();
    } catch (e) { /* noop */ }
    var hero = heroEl();
    if (hero) { hero.classList.remove('hero-loading'); hero.classList.remove('is-ready'); }
    var badge = $('hero-badge');
    var title = $('hero-title');
    var meta = $('hero-meta');
    if (badge) badge.textContent = 'Offline';
    if (title) title.textContent = 'Could not load';
    if (meta) meta.innerHTML = '';
    void message; // detail surfaces through the page notice; hero stays clean
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
    // Playback V1: hero Watch follows the configured mode (trailer visuals,
    // 7-second activation, layers, ambient, fade untouched — only this movie
    // Watch action resolves through the mode-aware catalog resolver).
    try {
      var mt = mediaOf(item);
      if (mt === 'movie' && window.Stream && window.Stream.Player && typeof window.Stream.Player.open === 'function') {
        if (typeof window.Stream.resolveCatalogMovie === 'function') {
          var res = window.Stream.resolveCatalogMovie(item.id);
          if (res && res.ok && res.url) {
            window.Stream.Player.open({
              title: item.title || item.name || 'Movie',
              sub: 'Movie',
              url: res.url,
              mode: 'embed',
              progressKey: 'movie:' + item.id,
            });
            return;
          }
          // Direct-mode clean failure (or unconfigured embed): detail route
          // shows the message with trailer/actions (never an iframe here).
          defaultInfo(item);
          return;
        }
        if (typeof window.Stream.getMovieUrl === 'function') {
          var url = window.Stream.getMovieUrl(item.id);
          if (url) {
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
   * fresh (muted) rather than resuming. heroOnScreen is restored optimistically
   * here - nothing can scroll while hidden, and the delay watchdog plus the
   * observer correct it within a frame if it ever went stale. */
  function ensureTabHandler() {
    if (visBound) return;
    visBound = true;
    try {
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) { stopTrailer(); return; }
        heroOnScreen = true;
        if (current && phase === 'idle') beginSequence();
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
        // Legacy entry: delay-only. Maps onto the presentation layer so old
        // and new configuration share one code path.
        var d = opts && opts.delayMs != null ? parseInt(opts.delayMs, 10) : NaN;
        if (isFinite(d) && d >= 0 && d <= 60000) {
          TRAILER_DELAY_MS = d;
          window.GreyboxHero.TRAILER_DELAY_MS = d;
          presentation.trailer.activation = 'delayed';
          presentation.trailer.delaySec = Math.min(120, Math.max(0, Math.round(d / 1000)));
        }
        if (opts && opts.presentation !== undefined) configureHero(opts.presentation);
      } catch (e) { /* noop */ }
    },
    configureHero: configureHero,
    getPresentation: function () { return sanitizePresentation(presentation); },
    bind: bind,
    setHero: setHero,
    setLoading: setLoading,
    clearLoading: clearLoading,
    showError: showError,
    reset: reset,
    getCurrent: function () { return current; },
    getPhase: function () { return phase; },
    debug: function () {
      return { phase: phase, apiReady: apiReady, hasPlayed: hasPlayed,
        delayElapsed: delayElapsed, asks: asks, loads: loads,
        muted: muted, hasCurrent: !!current, identity: currentIdentity,
        trailerSource: (presentation.trailer || {}).source || 'auto',
        activation: (presentation.trailer || {}).activation || 'delayed',
        delaySec: (presentation.trailer || {}).delaySec,
        waitStarted: !!currentIdentity && !!waitStarted[currentIdentity],
        waitDone: !!currentIdentity && !!waitDone[currentIdentity] };
    },
    getIdentity: function () { return currentIdentity; },
    isMuted: function () { return muted; },
    toggleMute: toggleMute,
    embedUrl: embedUrl,
    metaHTML: metaHTML,
    pickLogoUrl: pickLogoUrl,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = window.GreyboxHero;
})();
