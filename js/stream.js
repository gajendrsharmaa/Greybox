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

  /* ---- player (modes: 'file' = <video> HLS/MP4, 'embed' = <iframe>) ---- */
  let hls = null;
  let ctx = null;          // { title, sub, url, mode, progressKey, onEnded, showPrevNext }
  let saveTimer = 0;
  let listenersBound = false;

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
    const v = el('video'), f = el('embed-frame');
    if (saveTimer) { clearInterval(saveTimer); saveTimer = 0; }
    if (hls) { try { hls.destroy(); } catch { /* noop */ } hls = null; }
    if (v) { try { v.pause(); } catch { /* noop */ } v.removeAttribute('src'); v.load(); }
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
    // Embed mode: provider page in an iframe (only reached when EMBED.base
    // is configured to your official host — placeholder never loads).
    if (ctx && ctx.mode === 'embed') {
      const v = el('video'), f = el('embed-frame');
      teardown();
      showError(null);
      showLoading(true);
      if (v) v.classList.add('hidden');
      if (f) {
        f.classList.remove('hidden');
        f.src = url;
      }
      return;
    }
    // File mode: direct HLS/MP4 in <video> (archive.org, custom URL).
    const v = el('video'), f = el('embed-frame');
    if (!v) throw new Error('Missing <video id="video"> element.');
    teardown();
    if (f) f.classList.add('hidden');
    v.classList.remove('hidden');
    showError(null);
    showLoading(true);
    const isHls = /\.m3u8(\?|#|$)/i.test(url);
    if (isHls && window.Hls && Hls.isSupported()) {
      hls = new Hls({ maxBufferLength: 30 });
      hls.on(Hls.Events.ERROR, (_ev, data) => {
        if (!data || !data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) { try { hls.startLoad(); } catch { /* noop */ } return; }
        showError('Stream error (' + (data.details || 'fatal') + '). The source may be offline or blocking hotlink/CORS.');
      });
      hls.loadSource(url);
      hls.attachMedia(v);
    } else {
      v.src = url; // native MP4, or Safari native HLS
    }
    // resume
    let startAt = 0;
    if (ctx && ctx.progressKey) {
      const p = Progress.load(ctx.progressKey);
      if (p && p.t > 10) startAt = p.t;
    }
    const begin = () => {
      try { if (startAt) v.currentTime = startAt; } catch { /* noop */ }
      const pr = v.play();
      if (pr && pr.catch) pr.catch(() => showLoading(false)); // autoplay blocked: user presses play
    };
    if (v.readyState >= 1) begin();
    else v.addEventListener('loadedmetadata', begin, { once: true });
    // progress autosave
    saveTimer = setInterval(() => {
      if (ctx && ctx.progressKey && !v.paused && isFinite(v.currentTime)) {
        Progress.save(ctx.progressKey, v.currentTime, v.duration);
      }
    }, 5000);
    v.onpause = () => { if (ctx && ctx.progressKey) Progress.save(ctx.progressKey, v.currentTime, v.duration); };
  }

  function open(c) {
    // c: { title, sub, url, mode: 'file'|'embed', progressKey, onEnded, showPrevNext }
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

  window.Stream = {
    EMBED, getMovieUrl, getEpisodeUrl, isConfigured,
    Progress, Player: { open, close, current, retry: () => ctx && open(ctx) },
    fmtTime: fmt, resumeLabel: playResumeLabel,
  };
})();
