/* Stream resolver + player engine. 

 *
 * TMDB gives metadata only (titles, posters, seasons, episodes).
 * Actual video bytes must come from a file source YOU own or license
 * (Cloudflare Stream, R2, S3, Mux, or public-domain files).
 *
 *  Change EMBED.base once and every Watch button resolves through it:
 *    movie:   {base}/embed/movie/{tmdb_id}
 *    episode: {base}/embed/tv/{tmdb_id}/{season}/{episode}
 *  TMDB supplies all titles/posters/seasons/episodes; the player loads
 *  the resolved URL (embed page in <iframe>, or direct file in <video>).
 */
(function () {
  'use strict';

  /* ============================================================
   *  PUT YOUR OFFICIAL API STREAMING LINK HERE — CHANGE ONCE
   * ------------------------------------------------------------
   *  Set EMBED.base to your official/legal streaming host below.
   *  Everything else derives from it automatically:
   *    movie:   {base}/embed/movie/{tmdb_id}
   *    episode: {base}/embed/tv/{tmdb_id}/{season}/{episode}
   *  e.g. <iframe src="https://example.com/embed/movie/533535">
   *  While base is still "example.com" (or blank) the app shows
   *  "No stream source configured" instead of playing.
   *  Only use sources you own or license.
   * ========================================================== */
  const EMBED = {
    // PUT YOUR OFFICIAL API STREAMING LINK HERE (change this one line):
    base: 'https://embed.vidrift.in',
    moviePath: '/embed/movie/{tmdb_id}',
    episodePath: '/embed/tv/{tmdb_id}/{season}/{episode}',
  };

  // Treat blank, untouched placeholder, or example.com as "not configured".
  function usable(tpl) {
    return !!tpl && !/PUT YOUR OFFICIAL API STREAMING LINK HERE/i.test(tpl);
  }

  function embedBase() {
    const b = (EMBED.base || '').trim().replace(/\/+$/, '');
    if (!b || /example\.com/i.test(b)) return '';
    return b;
  }

  function fill(tpl, vars) {
    return tpl
      .split('{tmdb_id}').join(encodeURIComponent(vars.tmdbId))
      .split('{season}').join(encodeURIComponent(vars.season || 1))
      .split('{episode}').join(encodeURIComponent(vars.episode || 1));
  }

  // TMDB id in, embed page URL out. null = slot not configured yet.
  function getMovieUrl(tmdbId) {
    const b = embedBase();
    if (!b || !usable(EMBED.moviePath)) return null;
    return b + fill(EMBED.moviePath, { tmdbId });
  }

  function getEpisodeUrl(tmdbId, season, episode) {
    const b = embedBase();
    if (!b || !usable(EMBED.episodePath)) return null;
    return b + fill(EMBED.episodePath, { tmdbId, season, episode });
  }

  function isConfigured() {
    return !!embedBase();
  }

  /* ---- playback mode (Playback V1: Admin-configured resolver strategy) ----
   * Single canonical mode system — there is no second/competitor:
   *   auto   — normal Greybox resolver strategy (catalog titles use the
   *            configured embed source; direct files use the Greybox Player).
   *   direct — catalog titles require a valid direct source and fail cleanly
   *            when none exists. Today the EMBED resolver supplies embed-page
   *            URLs only, so catalog titles have NO direct production source
   *            and direct mode reports "no direct source" instead of iframing.
   *   embed  — catalog titles use the configured embed source.
   * Direct-file intents (user-pasted URLs via playFile, the dev-only
   * ?play-test=1 manifest) always route to the Greybox Player regardless of
   * mode — they are explicit direct sources, not catalog resolution, and no
   * mode ever converts an embed URL into a media URL (no scraping, no
   * extraction, no auth/Referer bypass of any kind).
   * The live value comes from js/data.js getPlaybackConfig() (D1 with local
   * fallback); _playbackMode is the offline override used before D1 loads
   * and in headless tests.
   */
  const PLAYBACK_MODES = ['auto', 'direct', 'embed'];
  const PLAYBACK_DEFAULT_MODE = 'auto';
  let _playbackMode = 'auto';

  const DIRECT_UNAVAILABLE_ERROR = 'Direct mode is active, but no direct production source is currently available for this title. Switch to Auto or Embed, or play a direct file you own.';
  const EMBED_UNCONFIGURED_ERROR = 'No stream source configured yet. Put your official API streaming link here — open js/stream.js (EMBED.base in js/stream.js). Trailers play without it.';

  function normalizePlaybackMode(v) {
    const m = String(v == null ? '' : v).trim().toLowerCase();
    return PLAYBACK_MODES.indexOf(m) >= 0 ? m : '';
  }

  // Strict setter for Admin/headless use: returns true when accepted.
  function setPlaybackMode(m) {
    const clean = normalizePlaybackMode(m);
    if (!clean) return false;
    _playbackMode = clean;
    return true;
  }

  // Effective mode: live D1-backed config when available, else the staged
  // override, else the offline fallback file, else auto. Never throws and
  // never returns an unknown value — malformed config reads as auto.
  function getPlaybackMode() {
    try {
      if (typeof window !== 'undefined' && window.GreyboxData && typeof window.GreyboxData.getPlaybackConfig === 'function') {
        const cfg = window.GreyboxData.getPlaybackConfig();
        const m = normalizePlaybackMode(cfg && cfg.mode);
        if (m) return m;
      }
    } catch { /* fall through to override */ }
    try {
      const fb = (typeof window !== 'undefined' && window.GreyboxPlayback) || null;
      if (fb && normalizePlaybackMode(fb.mode) && _playbackMode === 'auto') {
        // No staged override yet: honor the offline fallback file directly
        // so static previews behave before D1 loads.
        const m = normalizePlaybackMode(fb.mode);
        if (m) return m;
      }
    } catch { /* ignore */ }
    return normalizePlaybackMode(_playbackMode) || PLAYBACK_DEFAULT_MODE;
  }

  // Pull the live config into the staged override (called once D1 preload
  // resolves, and safe to call repeatedly). Keeps Stream in sync without
  // adding a second source of truth.
  function syncPlaybackMode() {
    try {
      if (typeof window !== 'undefined' && window.GreyboxData && typeof window.GreyboxData.getPlaybackConfig === 'function') {
        const cfg = window.GreyboxData.getPlaybackConfig();
        const m = normalizePlaybackMode(cfg && cfg.mode);
        if (m) { _playbackMode = m; return m; }
      }
    } catch { /* keep current */ }
    return _playbackMode;
  }

  // Catalog titles currently have NO legitimate direct production source:
  // the EMBED resolver supplies embed-page URLs only, the dev test manifest
  // is dev-only, and custom files are user-pasted (not catalog). This helper
  // exists so the Admin status panel and tests can state that honestly.
  function isDirectCatalogAvailable() {
    return false;
  }

  function getEmbedHost() {
    try {
      const b = embedBase();
      if (!b) return '';
      return new URL(b).hostname || '';
    } catch {
      return '';
    }
  }

  // Non-sensitive diagnostics for the Admin Source Status panel. Never
  // includes tokens, cookies, headers, URLs with query strings, or D1 data —
  // only the mode, a boolean, a hostname, and static availability flags.
  function getSourceStatus() {
    let testAvailable = false;
    try {
      testAvailable = !!(typeof window !== 'undefined' && window.GreyboxTestSource && typeof window.GreyboxTestSource.getTestUrl === 'function');
    } catch { testAvailable = false; }
    return {
      mode: getPlaybackMode(),
      embedConfigured: isConfigured(),
      embedHost: getEmbedHost(),
      directAvailable: isDirectCatalogAvailable(),
      testAvailable,
    };
  }

  // Catalog movie resolution honoring the configured mode. Pure apart from
  // reading the mode + EMBED slot. Returns { ok, url, mode, error } where
  // mode is the PLAYER bucket ('embed' for iframe, 'direct' for the clean
  // direct failure) — callers must check ok before opening anything.
  function resolveCatalogMovie(tmdbId) {
    const mode = getPlaybackMode();
    if (mode === 'direct') {
      return { ok: false, url: null, mode: 'direct', error: DIRECT_UNAVAILABLE_ERROR };
    }
    const url = getMovieUrl(tmdbId);
    if (!url) return { ok: false, url: null, mode: 'embed', error: EMBED_UNCONFIGURED_ERROR };
    return { ok: true, url, mode: 'embed', error: null };
  }

  function resolveCatalogEpisode(tmdbId, season, episode) {
    const mode = getPlaybackMode();
    if (mode === 'direct') {
      return { ok: false, url: null, mode: 'direct', error: DIRECT_UNAVAILABLE_ERROR };
    }
    const url = getEpisodeUrl(tmdbId, season, episode);
    if (!url) return { ok: false, url: null, mode: 'embed', error: EMBED_UNCONFIGURED_ERROR };
    return { ok: true, url, mode: 'embed', error: null };
  }

  // Generic catalog entry point used by app.js/hero.js and tests:
  //   resolvePlayback({ kind: 'movie', tmdbId })
  //   resolvePlayback({ kind: 'episode', tmdbId, season, episode })
  // Blocked/detail filtering stays upstream (js/data.js + js/detail-pages.js):
  // this function only decides embed-vs-clean-failure for allowed titles.
  function resolvePlayback(opts) {
    const o = (opts && typeof opts === 'object') ? opts : {};
    const kind = String(o.kind || o.type || 'movie').trim().toLowerCase();
    if (kind === 'episode' || kind === 'tv') {
      return resolveCatalogEpisode(o.tmdbId != null ? o.tmdbId : o.id, o.season, o.episode);
    }
    return resolveCatalogMovie(o.tmdbId != null ? o.tmdbId : o.id);
  }

  /* ---- source-type resolution (Increment 2: connect direct sources) ----
   * Decides, AFTER a source is resolved, whether it is directly playable
   * (Greybox Player) or embed-only (legacy compatibility iframe).
   *
   * Buckets: 'hls' = direct HLS manifest, 'file' = direct media file,
   *          'embed' = provider/embed page (iframe only).
   * 'hls' and 'file' both route to GreyboxPlayer; only 'embed' uses the
   * legacy iframe. This is routing only — HLS/Plyr internals stay in
   * js/greybox-player.js, and provider resolution above stays untouched.
   *
   * Precedence (never guess when the provider is explicit; never convert an
   * embed URL into a media URL):
   *   1. Explicit provider-supplied type (additive `sourceType`, or
   *      `contentType`/`mime`) wins, whatever the URL looks like.
   *   2. Explicit `mode: 'embed'` stays on the legacy path, whatever the
   *      URL looks like (all current movie/episode/hero callers).
   *   3. Otherwise (file/direct mode or missing mode): sniff the URL for
   *      .m3u8 → 'hls'; anything else stays 'file' and the player decides
   *      playability (clean 'unsupported' error for non-media URLs —
   *      Increment 1 behavior, preserved).
   */
  const SOURCE_TYPES = { HLS: 'hls', FILE: 'file', EMBED: 'embed' };

  function explicitSourceType(v) {
    const s = String(v || '').toLowerCase().trim();
    if (!s) return '';
    if (s === 'hls' || s === 'm3u8' || s.indexOf('mpegurl') >= 0 || s.indexOf('x-mpegurl') >= 0) return SOURCE_TYPES.HLS;
    if (s === 'embed' || s === 'iframe' || s === 'page' || s === 'html') return SOURCE_TYPES.EMBED;
    if (s === 'file' || s === 'video' || s === 'progressive' || s === 'audio' ||
        s.indexOf('video/') === 0 || s.indexOf('audio/') === 0 ||
        /\b(mp4|webm|ogv|ogg|mov|m4v|mp3|wav|m4a)\b/.test(s)) return SOURCE_TYPES.FILE;
    return '';
  }

  // URL sniffing defers to the player's own helpers (single source of truth)
  // with local fallbacks so resolution never depends on the player layer.
  function looksLikeHls(url) {
    try {
      if (window.GreyboxPlayer && typeof window.GreyboxPlayer.isHlsUrl === 'function') {
        return !!window.GreyboxPlayer.isHlsUrl(url);
      }
    } catch { /* fallback below */ }
    return /\.m3u8(\?|#|$)/i.test(String(url || ''));
  }

  // Normalized source in, routing bucket out. Accepts the existing contract
  // ({ url, mode, ... }) plus the additive `sourceType` field. Pure: safe to
  // unit-test, no DOM, no network, no provider logic.
  function resolveSourceType(c) {
    const src = (typeof c === 'string') ? { url: c } : (c || {});
    const explicit = explicitSourceType(src.sourceType || src.contentType || src.mime);
    if (explicit) return explicit;
    if (src.mode === 'embed') return SOURCE_TYPES.EMBED;
    const url = String(src.url || src.src || src.file || '');
    if (looksLikeHls(url)) return SOURCE_TYPES.HLS;
    return SOURCE_TYPES.FILE;
  }

  /* ---- watch progress (resume) ---- */
  const Progress = {
    key(k) { return 'sb_progress:' + k; },
    load(k) {
      try {
        const v = JSON.parse(localStorage.getItem(this.key(k)) || 'null');
        return v && typeof v.t === 'number' ? v : null;
      } catch { return null; }
    },
    save(k, t, d) {
      try {
        if (!isFinite(t) || t < 5) return;
        if (d && isFinite(d) && d - t < 15) { localStorage.removeItem(this.key(k)); return; } // finished
        localStorage.setItem(this.key(k), JSON.stringify({ t: Math.floor(t), d: Math.floor(d || 0), at: Date.now() }));
      } catch { /* storage full/blocked */ }
    },
    clear(k) { try { localStorage.removeItem(this.key(k)); } catch { /* noop */ } },
  };

  function fmt(s) {
    if (!isFinite(s) || s < 0) return '0:00';
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  }

  /* ---- player ----
   * Modes: 'file'  = direct HLS/MP4 in <video>, owned by the Greybox Player
   *                  (js/greybox-player.js: HLS.js or native HLS + Plyr UI).
   *                  This file only passes the normalized source through and
   *                  keeps resume / progress / auto-next / modal chrome.
   *          'embed' = legacy provider page in <iframe> (kept for backward
   *                  compatibility with configured EMBED hosts; the Greybox
   *                  Player itself never touches the iframe).
   * Routing between the two goes through resolveSourceType() below, so an
   * explicit provider-supplied `sourceType` is honored without guessing.
   */
  let ctx = null;          // { title, sub, url, mode, progressKey, onEnded, showPrevNext, subtitles|tracks|captions }
  let saveTimer = 0;
  let listenersBound = false;
  let playerGen = 0;       // bumped on every open/close: stale-attach guard
  let resumeHandler = null;

  function el(id) { return document.getElementById(id); }

  function showLoading(on) {
    const n = el('player-loading');
    if (n) n.classList.toggle('hidden', !on);
  }

  function showError(msg) {
    const box = el('player-error'), msgEl = el('player-error-msg');
    if (!box) { if (msg) alert(msg); return; }
    if (!msg) { box.classList.add('hidden'); return; }
    if (msgEl) msgEl.textContent = msg;
    box.classList.remove('hidden');
    showLoading(false);
  }

  function teardown() {
    playerGen++; // invalidate any in-flight file-mode open()
    const v = el('video'), f = el('embed-frame');
    if (saveTimer) { clearInterval(saveTimer); saveTimer = 0; }
    if (v && resumeHandler) { try { v.removeEventListener('loadedmetadata', resumeHandler); } catch { /* noop */ } }
    resumeHandler = null;
    // The Greybox Player owns HLS.js/Plyr teardown (destroys previous HLS
    // instance, Plyr instance, injected tracks, and its own listeners).
    try { if (window.GreyboxPlayer) window.GreyboxPlayer.destroy(); } catch { /* noop */ }
    if (v) { try { v.pause(); } catch { /* noop */ } try { v.removeAttribute('src'); } catch { /* noop */ } try { v.load(); } catch { /* noop */ } }
    if (f) { try { f.removeAttribute('src'); } catch { /* noop */ } }
  }

  function bindOnce() {
    if (listenersBound) return;
    listenersBound = true;
    const v = el('video');
    if (!v) return;
    v.addEventListener('canplay', () => showLoading(false));
    v.addEventListener('waiting', () => showLoading(true));
    v.addEventListener('playing', () => { showLoading(false); showError(null); });
    v.addEventListener('error', () => {
      if (!ctx) return;
      if (ctx.mode === 'file') return; // file mode: Greybox Player reports errors (cleaner, source-specific)
      showError('This file could not be played. Check the source URL / CORS, or try another title.');
    });
    v.addEventListener('ended', () => {
      if (ctx && ctx.progressKey) Progress.clear(ctx.progressKey);
      if (ctx && typeof ctx.onEnded === 'function') { const fn = ctx.onEnded; fn(); }
    });
    const retry = el('player-retry');
    if (retry) retry.addEventListener('click', () => { if (ctx) open(ctx); });
    const frame = el('embed-frame');
    if (frame) frame.addEventListener('load', () => showLoading(false));
    const closeBtn = el('player-close');
    if (closeBtn) closeBtn.addEventListener('click', close);
  }

  function attach(url) {
    // Embed bucket: provider page in the legacy compatibility iframe (only
    // reached when the resolver supplied an embed source — the resolver never
    // converts an embed URL into a media URL, and neither do we).
    if (ctx && resolveSourceType(ctx) === SOURCE_TYPES.EMBED) {
      const v = el('video'), f = el('embed-frame');
      teardown();
      showError(null);
      showLoading(true);
      const gxStage = document.querySelector('.gx-player-stage');
      if (gxStage) gxStage.classList.add('hidden');
      if (v) v.classList.add('hidden');
      if (f) {
        f.classList.remove('hidden');
        f.src = url;
      }
      return;
    }
    // File/HLS bucket: direct media in <video> via the Greybox Player
    // (native HLS or HLS.js + Plyr UI). Only a caller-supplied explicit type
    // (`sourceType`/`contentType`/`mime`) is forwarded — the player keeps its
    // own Increment 1 URL detection otherwise. Subtitle tracks ride along
    // when the caller supplied them (c.subtitles | c.tracks | c.captions);
    // when absent the player simply runs without a caption menu.
    const v = el('video'), f = el('embed-frame');
    if (!v) throw new Error('Missing <video id="video"> element.');
    teardown();
    const myGen = playerGen;
    if (f) f.classList.add('hidden');
    const stage = document.querySelector('.gx-player-stage');
    if (stage) stage.classList.remove('hidden');
    v.classList.remove('hidden');
    showError(null);
    showLoading(true);
    // resume position (same keys as before)
    let startAt = 0;
    if (ctx && ctx.progressKey) {
      const p = Progress.load(ctx.progressKey);
      if (p && p.t > 10) startAt = p.t;
    }
    if (startAt) {
      resumeHandler = () => {
        if (myGen !== playerGen) return;
        try { v.currentTime = startAt; } catch { /* noop */ }
      };
      try {
        if (v.readyState >= 1) resumeHandler();
        else v.addEventListener('loadedmetadata', resumeHandler, { once: true });
      } catch { /* noop */ }
    }
    const GBP = window.GreyboxPlayer;
    if (!GBP || typeof GBP.open !== 'function') {
      // Local player layer failed to load: minimal native fallback so a
      // direct file can still play (no HLS engine, no Plyr skin).
      try { v.setAttribute('controls', ''); } catch { /* noop */ }
      v.src = url;
      const pr = v.play();
      if (pr && pr.catch) pr.catch(() => showLoading(false));
    } else {
      try {
        GBP.open(v, {
          url,
          title: ctx && ctx.title,
          // Additive Increment 2 field (documented in README §6.2): an
          // explicit provider-supplied type. Absent = Increment 1 behavior.
          sourceType: (ctx && (ctx.sourceType || ctx.contentType || ctx.mime)) || undefined,
          subtitles: (ctx && (ctx.subtitles || ctx.tracks || ctx.captions)) || [],
        }, {
          autoplay: true,
          onError: (err) => {
            if (myGen !== playerGen) return; // stale source: never paint over the current one
            showError((err && err.message) || 'Playback failed. Try another title.');
          },
        }).then((res) => {
          if (myGen !== playerGen || !res || res.stale) return;
          if (res.error) { showLoading(false); return; }
          // Success: the 'playing' event hides the spinner; when autoplay was
          // blocked the video stays paused — don't leave it spinning.
          try { if (v.paused) showLoading(false); } catch { /* noop */ }
        }).catch(() => {
          if (myGen !== playerGen) return;
          showLoading(false);
        });
      } catch (e) {
        if (myGen === playerGen) showError('Playback failed to start. Reload and try again.');
      }
    }
    // progress autosave
    saveTimer = setInterval(() => {
      if (ctx && ctx.progressKey && !v.paused && isFinite(v.currentTime)) {
        Progress.save(ctx.progressKey, v.currentTime, v.duration);
      }
    }, 5000);
    v.onpause = () => { if (ctx && ctx.progressKey) Progress.save(ctx.progressKey, v.currentTime, v.duration); };
  }

  function open(c) {
    // c: { title, sub, url, mode: 'file'|'embed', progressKey, onEnded,
    //      showPrevNext, subtitles|tracks|captions,
    //      sourceType|contentType|mime (additive, optional — explicit
    //      provider-supplied type, see resolveSourceType / README §6.2) }
    if (!c || !c.url) throw new Error('No stream URL resolved.');
    if (!c.mode) c.mode = 'file';
    ctx = c;
    bindOnce();
    const p = el('player');
    if (!p) throw new Error('Missing #player element.');
    p.classList.remove('hidden');
    try { document.body.style.overflow = 'hidden'; } catch { /* noop */ }
    el('player-title').textContent = '▶ ' + (c.title || 'Now Playing');
    const sub = el('player-sub');
    if (sub) sub.textContent = c.sub || '';
    const bar = el('player-epbar');
    if (bar) bar.classList.toggle('hidden', !c.showPrevNext);
    attach(c.url);
    return true;
  }

  function playResumeLabel(progressKey) {
    const pr = progressKey ? Progress.load(progressKey) : null;
    return pr ? 'Resume ' + fmt(pr.t) : null;
  }

  function close() {
    teardown();
    ctx = null;
    const p = el('player');
    if (p) p.classList.add('hidden');
    try { document.body.style.overflow = ''; } catch { /* noop */ }
  }

  function current() { return ctx; }

  const StreamAPI = {
    EMBED, getMovieUrl, getEpisodeUrl, isConfigured,
    resolveSourceType, SOURCE_TYPES,
    PLAYBACK_MODES, PLAYBACK_DEFAULT_MODE,
    getPlaybackMode, setPlaybackMode, syncPlaybackMode,
    isDirectCatalogAvailable, getEmbedHost, getSourceStatus,
    resolveCatalogMovie, resolveCatalogEpisode, resolvePlayback,
    DIRECT_UNAVAILABLE_ERROR, EMBED_UNCONFIGURED_ERROR,
    Progress, Player: { open, close, current, retry: () => ctx && open(ctx) },
    fmtTime: fmt, resumeLabel: playResumeLabel,
  };

  if (typeof window !== 'undefined') window.Stream = StreamAPI;
  // Headless/test hook (pure resolver surface only — same pattern as
  // js/router.js and js/greybox-player.js). Browser behavior unchanged.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      EMBED, getMovieUrl, getEpisodeUrl, isConfigured,
      resolveSourceType, SOURCE_TYPES,
      PLAYBACK_MODES, PLAYBACK_DEFAULT_MODE,
      getPlaybackMode, setPlaybackMode, syncPlaybackMode,
      isDirectCatalogAvailable, getEmbedHost, getSourceStatus,
      resolveCatalogMovie, resolveCatalogEpisode, resolvePlayback,
      DIRECT_UNAVAILABLE_ERROR, EMBED_UNCONFIGURED_ERROR,
      fmtTime: fmt, Progress,
    };
  }
})();
