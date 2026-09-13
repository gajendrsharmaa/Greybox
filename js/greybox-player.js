/* Greybox-owned HTML5 player layer (Increment 1: custom player;
 * Increment 2: honors the additive explicit `sourceType` from the resolver).
 *
 * Architecture:
 *   Existing normalized playback result ({ title, sub, url, mode, ... })
 *     -> small adapter (normalizeSource, isolated below)
 *     -> Greybox Player (this file: HLS init, Plyr init, cleanup, events)
 *     -> HTML5 <video>
 *     -> native HLS  OR  HLS.js
 *     -> Plyr UI
 *
 * Provider resolution (js/stream.js EMBED / getMovieUrl / getEpisodeUrl) stays
 * OUTSIDE this file. This player is provider-agnostic: it only consumes direct
 * file URLs (.m3u8 / .mp4 / .webm) plus optional subtitle tracks supplied by
 * the caller. It never invents subtitle URLs, never loads embed pages, never
 * uses an <iframe>, and never logs full URLs (see redactUrl).
 *
 * Lifecycle: every open() bumps an internal sequence. Async continuations
 * (manifest parse, metadata, timeouts) bail out when stale, so rapidly
 * switching episodes can never let an old source overwrite the current one.
 * destroy() tears down the previous HLS.js instance, the previous Plyr
 * instance, injected <track> nodes, and all listeners this file added.
 */
(function () {
  'use strict';

  var VERSION = '1.1.0';
  var MANIFEST_TIMEOUT_MS = 8000;
  var MAX_NETWORK_RETRIES = 3;

  /* ---------------- pure helpers (also exported for headless tests) ---------------- */

  function isHlsUrl(url) {
    return /\.m3u8(\?|#|$)/i.test(String(url || ''));
  }

  function isProgressiveUrl(url) {
    return /\.(mp4|webm|ogv|ogg|mov|m4v)(\?|#|$)/i.test(String(url || ''));
  }

  // True only when THIS browser can play HLS natively (Safari and
  // Safari-based browsers). canPlayType returns 'probably' / 'maybe' / ''.
  function supportsNativeHls(video) {
    try {
      var v = video || document.createElement('video');
      var r = v.canPlayType('application/vnd.apple.mpegurl');
      if (r === 'probably' || r === 'maybe') return true;
      // Legacy Apple MIME alias, checked for completeness.
      r = v.canPlayType('application/x-mpegURL');
      return r === 'probably' || r === 'maybe';
    } catch (e) {
      return false;
    }
  }

  // Never expose full URLs (which may carry signed tokens) in logs or errors.
  function redactUrl(url) {
    try {
      var u = new URL(String(url || ''), 'http://localhost');
      var path = String(u.pathname || '');
      var tail = path.split('/').pop() || '';
      if (/\.(m3u8|mp4|webm|ogv|ogg|mov|m4v)$/i.test(tail)) return u.host + '/.../' + tail;
      return u.host + (path && path !== '/' ? '/...' : '');
    } catch (e) {
      return '(unparseable-url)';
    }
  }

  /* Adapter: existing normalized playback result -> player source.
   * Accepts the project's existing contract ({ url, ... }) plus optional
   * subtitle lists under any of the accepted keys. Never invents tracks:
   * when the caller supplies none, subtitles is [] and no caption menu shows.
   *
   * Increment 2: honors an explicit provider-supplied type (`sourceType`,
   * or `contentType`/`mime`) — explicit wins over URL sniffing, so a
   * legitimately provided direct URL without a recognizable extension still
   * plays. Absent = Increment 1 URL detection, unchanged.
   */
  function explicitSourceKind(src) {
    var v = String(src.sourceType || src.contentType || src.mime || '').toLowerCase().trim();
    if (!v) return '';
    if (v === 'hls' || v === 'm3u8' || v.indexOf('mpegurl') >= 0 || v.indexOf('x-mpegurl') >= 0) return 'hls';
    if (v === 'embed' || v === 'iframe' || v === 'page' || v === 'html') return 'embed';
    if (v === 'file' || v === 'video' || v === 'progressive' || v === 'audio' ||
        v.indexOf('video/') >= 0 || v.indexOf('audio/') >= 0 ||
        /\b(mp4|webm|ogv|ogg|mov|m4v|mp3|wav|m4a)\b/.test(v)) return 'progressive';
    return '';
  }

  function normalizeSource(input) {
    var src = typeof input === 'string' ? { url: input } : (input || {});
    var url = String(src.url || src.src || src.file || '').trim();
    var raw = src.subtitles || src.tracks || src.captions || src.subs || [];
    var list = Array.isArray(raw) ? raw : [];
    var subtitles = [];
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t || typeof t !== 'object') continue;
      var file = String(t.src || t.url || t.file || '').trim();
      if (!file || seen[file]) continue;
      seen[file] = true;
      subtitles.push({
        label: String(t.label || t.name || t.srclang || t.lang || 'Subtitles'),
        src: file,
        srclang: String(t.srclang || t.srclang || t.lang || 'en').toLowerCase().slice(0, 5) || 'en',
        kind: t.kind === 'captions' ? 'captions' : 'subtitles',
        isDefault: !!t.default,
      });
    }
    // Only the first default wins; extras become opt-in tracks.
    var gotDefault = false;
    for (var j = 0; j < subtitles.length; j++) {
      if (subtitles[j].isDefault) {
        if (gotDefault) subtitles[j].isDefault = false;
        else gotDefault = true;
      }
    }
    var type = explicitSourceKind(src);
    if (!type) {
      type = !url ? 'none' : isHlsUrl(url) ? 'hls' : isProgressiveUrl(url) ? 'progressive' : 'unknown';
    }
    return { url: url, type: type, title: String(src.title || ''), subtitles: subtitles };
  }

  /* Quality options from HLS.js levels. Returns null when there is nothing
   * worth offering (0-1 distinct heights) so the caller shows no menu.
   * Otherwise: [0, ...heightsDesc] where 0 means Auto (HLS.js ABR).
   */
  function pickQualityOptions(levels) {
    var heights = [];
    var seenH = {};
    for (var i = 0; i < (levels || []).length; i++) {
      var h = parseInt(levels[i] && levels[i].height, 10);
      if (isFinite(h) && h > 0 && !seenH[h]) {
        seenH[h] = true;
        heights.push(h);
      }
    }
    if (heights.length < 2) return null;
    heights.sort(function (a, b) { return b - a; });
    return { options: [0].concat(heights), def: 0 };
  }

  /* ---------------- state ---------------- */

  var openSeq = 0;      // bumped on every open()/destroy(): stale guard
  var current = null;   // { seq, video, hls, plyr, listeners:[], observer, timers:[] }
  var lastError = null;

  function addListener(rec, target, type, fn, opts) {
    try {
      target.addEventListener(type, fn, opts);
      rec.listeners.push({ target: target, type: type, fn: fn, opts: opts });
    } catch (e) { /* noop */ }
  }

  function later(rec, ms, fn) {
    var id = setTimeout(function () {
      if (rec && current === rec) {
        try { fn(); } catch (e) { /* noop */ }
      }
    }, ms);
    if (rec) rec.timers.push(id);
    return id;
  }

  // Relabel Plyr's numeric "0p" quality entry as "Auto" (only when option 0
  // is offered). Defensive: if a future Plyr already labels it, there is
  // nothing to rewrite. Observed so late menu renders are covered too.
  function fixAutoLabel(rec, stage) {
    var sweep = function () {
      try {
        var nodes = stage.querySelectorAll('[data-plyr="quality"] button[value="0"], [data-plyr="quality"] [value="0"]');
        for (var i = 0; i < nodes.length; i++) {
          var label = nodes[i].querySelector('span:last-child') || nodes[i];
          if (/^\s*0p?\s*$/i.test(label.textContent || '')) label.textContent = 'Auto';
        }
        var badges = stage.querySelectorAll('[data-plyr="settings"] .plyr__menu__value, .plyr__menu__value');
        for (var j = 0; j < badges.length; j++) {
          if (/^\s*0p?\s*$/i.test(badges[j].textContent || '')) badges[j].textContent = 'Auto';
        }
      } catch (e) { /* DOM optional */ }
    };
    sweep();
    try {
      if (typeof MutationObserver === 'undefined') return;
      if (rec.observer) { try { rec.observer.disconnect(); } catch (e) { /* noop */ } }
      var ob = new MutationObserver(function () { sweep(); });
      ob.observe(stage, { childList: true, subtree: true, characterData: true });
      rec.observer = ob;
    } catch (e) { /* observer optional */ }
  }

  function teardown(rec) {
    if (!rec) return;
    try {
      if (rec.observer) rec.observer.disconnect();
    } catch (e) { /* noop */ }
    rec.observer = null;
    for (var i = 0; i < rec.timers.length; i++) {
      try { clearTimeout(rec.timers[i]); } catch (e) { /* noop */ }
    }
    rec.timers = [];
    for (var j = 0; j < rec.listeners.length; j++) {
      var l = rec.listeners[j];
      try { l.target.removeEventListener(l.type, l.fn, l.opts); } catch (e) { /* noop */ }
    }
    rec.listeners = [];
    if (rec.hls) {
      try { rec.hls.destroy(); } catch (e) { /* noop */ }
      rec.hls = null;
    }
    if (rec.plyr) {
      try { rec.plyr.destroy(); } catch (e) { /* noop */ }
      rec.plyr = null;
    }
    // Remove only the tracks THIS player injected (marked), never others'.
    try {
      if (rec.video) {
        var tracks = rec.video.querySelectorAll('track[data-gx-track="1"]');
        for (var k = 0; k < tracks.length; k++) {
          try { tracks[k].remove(); } catch (e) { /* noop */ }
        }
      }
    } catch (e) { /* noop */ }
  }

  function resetVideo(video) {
    try { video.pause(); } catch (e) { /* noop */ }
    try { video.removeAttribute('src'); } catch (e) { /* noop */ }
    try { video.load(); } catch (e) { /* noop */ }
    // Fall back to the element's own controls flag only when Plyr is absent;
    // otherwise Plyr owns the UI and native controls stay off.
    try {
      if (!video.hasAttribute('data-gx-plyr')) video.setAttribute('controls', '');
    } catch (e) { /* noop */ }
  }

  function injectTracks(video, subtitles) {
    for (var i = 0; i < subtitles.length; i++) {
      var s = subtitles[i];
      try {
        var track = document.createElement('track');
        track.setAttribute('kind', s.kind === 'captions' ? 'captions' : 'subtitles');
        track.setAttribute('label', s.label);
        track.setAttribute('srclang', s.srclang);
        track.setAttribute('src', s.src);
        track.setAttribute('data-gx-track', '1');
        if (s.isDefault) track.setAttribute('default', '');
        video.appendChild(track);
      } catch (e) { /* one bad track never breaks playback */ }
    }
  }

  function plyrOptions(hasQuality, quality) {
    var opts = {
      controls: [
        'play-large', 'restart', 'rewind', 'play', 'fast-forward',
        'progress', 'current-time', 'duration',
        'mute', 'volume', 'captions', 'settings',
        'pip', 'airplay', 'fullscreen',
      ],
      // Plyr hides rows that have no data (no tracks -> no captions row,
      // no quality config -> no quality row), so nothing unavailable shows.
      settings: ['captions', 'quality', 'speed'],
      speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] },
      captions: { active: true, language: 'auto', update: true },
      fullscreen: { enabled: true, fallback: true, iosNative: true },
      keyboard: { focused: true, global: false },
      tooltips: { controls: true, seek: true },
      disableContextMenu: true,
    };
    if (hasQuality && quality) {
      opts.quality = {
        default: quality.def,
        options: quality.options,
        forced: true,
        onChange: quality.onChange,
      };
    }
    return opts;
  }

  function createPlyr(rec, video, norm, quality, hooks) {
    var PlyrLib = null;
    try { PlyrLib = window.Plyr; } catch (e) { PlyrLib = null; }
    if (typeof PlyrLib !== 'function') {
      // CDN blocked/absent: native controls keep every required capability
      // except the Greybox skin and the unified quality menu.
      try { video.setAttribute('controls', ''); } catch (e) { /* noop */ }
      if (hooks && typeof hooks.onReady === 'function') hooks.onReady({ plyr: null, fallback: true });
      return null;
    }
    var player = null;
    try {
      player = new PlyrLib(video, plyrOptions(!!quality, quality));
    } catch (e) {
      try { video.setAttribute('controls', ''); } catch (ignored) { /* noop */ }
      if (hooks && typeof hooks.onReady === 'function') hooks.onReady({ plyr: null, fallback: true });
      return null;
    }
    rec.plyr = player;
    try { video.setAttribute('data-gx-plyr', '1'); } catch (e) { /* noop */ }
    try {
      player.on('ready', function () {
        if (current !== rec) return;
        try {
          var stage = video.closest('.gx-player-stage') || video.parentElement || document;
          if (quality) fixAutoLabel(rec, stage);
        } catch (e) { /* label fix optional */ }
        if (hooks && typeof hooks.onReady === 'function') hooks.onReady({ plyr: player, fallback: false });
      });
    } catch (e) { /* ready hook optional */ }
    return player;
  }

  function fail(hooks, code, message, detail) {
    lastError = { code: code, message: message };
    try {
      if (detail !== undefined && hooks && hooks.debug) {
        console.warn('[greybox-player] ' + code + ':', message, redactUrl(detail));
      }
    } catch (e) { /* logging never breaks playback */ }
    if (hooks && typeof hooks.onError === 'function') {
      try { hooks.onError({ code: code, message: message }); } catch (e) { /* noop */ }
    }
    var err = new Error(message);
    err.code = code;
    return err;
  }

  /* ---------------- open ----------------
   * video: HTMLVideoElement. rawSource: URL string or normalized object.
   * hooks: { autoplay, onReady(info), onError({code,message}),
   *          onLevels(levels), onLoading(bool), debug }.
   * Resolves { type, native, levels, stale } — stale:true when superseded.
   */
  function open(video, rawSource, hooks) {
    hooks = hooks || {};
    var mySeq = ++openSeq;
    // Fully clean the previous instance BEFORE attaching the new source:
    // no old HLS requests/events survive a source change.
    if (current) {
      teardown(current);
      current = null;
    }
    var norm = normalizeSource(rawSource);
    var rec = { seq: mySeq, video: video, hls: null, plyr: null, listeners: [], observer: null, timers: [] };
    current = rec;
    lastError = null;

    return new Promise(function (resolve) {
      var done = function (value) {
        if (current !== rec) {
          resolve({ stale: true });
          return;
        }
        resolve(value);
      };
      var failed = function (code, message, detail) {
        if (current !== rec) {
          resolve({ stale: true });
          return;
        }
        resolve({ error: fail(hooks, code, message, detail) });
      };

      if (!video || typeof video.play !== 'function') {
        failed('unsupported', 'Player element is missing. Please reload and try again.');
        return;
      }
      if (!norm.url) {
        failed('unsupported', 'No playable source was provided for this title.');
        return;
      }

      try { video.removeAttribute('controls'); } catch (e) { /* Plyr owns UI */ }
      try { video.removeAttribute('data-gx-plyr'); } catch (e) { /* noop */ }
      try { video.crossOrigin = 'anonymous'; } catch (e) { /* CORS optional */ }
      injectTracks(video, norm.subtitles);
      if (norm.subtitles.length && hooks && typeof hooks.onLevels === 'function') {
        // Surface track availability without inventing anything.
        try { hooks.onLevels({ subtitles: norm.subtitles.length }); } catch (e) { /* noop */ }
      }

      var autoplay = hooks.autoplay !== false;
      var tryPlay = function () {
        if (current !== rec || !autoplay) return;
        try {
          var pr = video.play();
          if (pr && typeof pr.catch === 'function') pr.catch(function () { /* autoplay blocked: user presses play */ });
        } catch (e) { /* noop */ }
      };

      if (norm.type === 'progressive') {
        try { video.src = norm.url; } catch (e) { failed('media', 'This file could not be played. Check the source URL / CORS, or try another title.', norm.url); return; }
        addListener(rec, video, 'error', function () {
          if (current !== rec) return;
          failed('media', 'This file could not be played. Check the source URL / CORS, or try another title.', norm.url);
        });
        createPlyr(rec, video, norm, null, {
          onReady: function () {
            if (current !== rec) return;
            tryPlay();
            done({ type: 'progressive', native: true, levels: [], title: norm.title });
          },
        });
        // If Plyr never reports ready (fallback path already called onReady),
        // still attempt playback once metadata lands.
        addListener(rec, video, 'loadedmetadata', function () {
          if (current !== rec) return;
          tryPlay();
        }, { once: true });
        later(rec, MANIFEST_TIMEOUT_MS, function () {
          done({ type: 'progressive', native: true, levels: [], title: norm.title });
        });
        return;
      }

      if (norm.type !== 'hls') {
        failed('unsupported', 'This source type is not supported by the Greybox player. Only direct .m3u8 / .mp4 streams from sources you own or license can play here.');
        return;
      }

      // ---- HLS path: native first, HLS.js otherwise ----
      var HlsLib = null;
      try { HlsLib = window.Hls; } catch (e) { HlsLib = null; }
      var canNative = supportsNativeHls(video);
      var canHlsJs = !!(HlsLib && typeof HlsLib.isSupported === 'function' && HlsLib.isSupported());

      if (canNative && (!canHlsJs || (hooks.preferNative !== false && !norm.subtitles.length))) {
        // Native HLS (Safari): single element, no engine. Quality levels are
        // platform-managed, so no custom quality menu is offered.
        try { video.src = norm.url; } catch (e) { failed('media', 'This stream could not be played on this device.', norm.url); return; }
        addListener(rec, video, 'error', function () {
          if (current !== rec) return;
          failed('media', 'This stream could not be played. The source may be offline or blocking playback (CORS / hotlink protection).', norm.url);
        });
        createPlyr(rec, video, norm, null, {
          onReady: function () {
            if (current !== rec) return;
            tryPlay();
            done({ type: 'hls-native', native: true, levels: [], title: norm.title });
          },
        });
        addListener(rec, video, 'loadedmetadata', function () {
          if (current !== rec) return;
          tryPlay();
        }, { once: true });
        later(rec, MANIFEST_TIMEOUT_MS, function () {
          done({ type: 'hls-native', native: true, levels: [], title: norm.title });
        });
        return;
      }

      if (!canHlsJs) {
        failed('hls-unavailable', 'HLS playback is not available in this browser yet. Try a browser with native HLS support (e.g. Safari) or check your connection and reload.');
        return;
      }

      // ---- HLS.js path ----
      var hls = null;
      try {
        hls = new HlsLib({ maxBufferLength: 30, enableWorker: true });
      } catch (e) {
        failed('hls-unavailable', 'The playback engine failed to start. Reload and try again.');
        return;
      }
      rec.hls = hls;
      var retries = 0;
      var finished = false;
      var finishOk = function (info) {
        if (finished || current !== rec) return;
        finished = true;
        done(info);
      };
      var finishErr = function (code, message) {
        if (finished || current !== rec) return;
        finished = true;
        failed(code, message, norm.url);
      };

      try {
        hls.on(HlsLib.Events.ERROR, function (_ev, data) {
          if (current !== rec || !data) return;
          if (!data.fatal) return;
          var D = (HlsLib.ErrorDetails || {});
          var T = (HlsLib.ErrorTypes || {});
          if (data.type === T.NETWORK_ERROR) {
            if ((data.details === D.MANIFEST_LOAD_ERROR || data.details === D.LEVEL_LOAD_ERROR) && retries < 1) {
              finishErr('manifest', 'The stream manifest could not be loaded. The source may be offline or blocking playback (CORS / hotlink protection).');
              return;
            }
            if (retries < MAX_NETWORK_RETRIES) {
              retries++;
              try { hls.startLoad(); } catch (e) { /* noop */ }
              return;
            }
            finishErr('network', 'Network error while loading the stream. Check your connection and try again.');
            return;
          }
          if (data.type === T.MEDIA_ERROR) {
            try {
              hls.recoverMediaError();
              return;
            } catch (e) { /* fall through */ }
            finishErr('media', 'This stream could not be decoded on this device. Try another title.');
            return;
          }
          finishErr('manifest', 'The stream manifest could not be loaded. The source may be offline or blocking playback (CORS / hotlink protection).');
        });
      } catch (e) { /* error tap optional */ }

      var plyrCreated = false;
      var makePlyr = function (quality) {
        if (plyrCreated || current !== rec) return;
        plyrCreated = true;
        createPlyr(rec, video, norm, quality, {
          onReady: function () {
            if (current !== rec) return;
            tryPlay();
          },
        });
        tryPlay();
      };

      try {
        hls.on(HlsLib.Events.MANIFEST_PARSED, function (_ev, data) {
          if (current !== rec) return;
          var levels = [];
          try {
            if (data && Array.isArray(data.levels)) levels = data.levels;
            else if (Array.isArray(hls.levels)) levels = hls.levels;
          } catch (e) { levels = []; }
          if (hooks && typeof hooks.onLevels === 'function') {
            try { hooks.onLevels({ levels: levels }); } catch (e) { /* noop */ }
          }
          var q = pickQualityOptions(levels);
          if (q) {
            q.onChange = function (val) {
              if (current !== rec || !rec.hls) return;
              var v = parseInt(val, 10);
              if (!isFinite(v)) return;
              if (v === 0) {
                try { rec.hls.currentLevel = -1; } catch (e) { /* noop */ } // Auto (ABR)
                return;
              }
              try {
                var lvls = rec.hls.levels || [];
                for (var i = 0; i < lvls.length; i++) {
                  if (parseInt(lvls[i] && lvls[i].height, 10) === v) {
                    rec.hls.currentLevel = i;
                    return;
                  }
                }
              } catch (e) { /* noop */ }
            };
          }
          // Quality menu only when the manifest exposed multiple levels;
          // otherwise Plyr is built without it (no useless menu).
          makePlyr(q);
          finishOk({ type: 'hls-hlsjs', native: false, levels: levels, title: norm.title });
        });
      } catch (e) { /* manifest tap optional */ }

      try {
        hls.loadSource(norm.url);
        hls.attachMedia(video);
      } catch (e) {
        finishErr('manifest', 'The stream manifest could not be loaded. The source may be offline or blocking playback (CORS / hotlink protection).');
        return;
      }

      // Manifest-parse watchdog: never leave the player stuck without UI.
      // If levels arrived, Plyr already exists; otherwise build it bare and
      // let playback (or the video error path) decide the outcome.
      later(rec, MANIFEST_TIMEOUT_MS, function () {
        if (current !== rec || finished) return;
        makePlyr(null);
        finishOk({ type: 'hls-hlsjs', native: false, levels: [], title: norm.title, manifestSlow: true });
      });
    });
  }

  function destroy() {
    openSeq++; // invalidate any in-flight open()
    if (current) {
      var rec = current;
      current = null;
      teardown(rec);
      try { if (rec.video) resetVideo(rec.video); } catch (e) { /* noop */ }
    }
    lastError = null;
  }

  function state() {
    if (!current) return { active: false, openSeq: openSeq, lastError: lastError };
    return {
      active: true,
      openSeq: openSeq,
      seq: current.seq,
      hasHls: !!current.hls,
      hasPlyr: !!current.plyr,
      lastError: lastError,
    };
  }

  var GreyboxPlayer = {
    version: VERSION,
    open: open,
    destroy: destroy,
    state: state,
    isHlsUrl: isHlsUrl,
    isProgressiveUrl: isProgressiveUrl,
    supportsNativeHls: supportsNativeHls,
    normalizeSource: normalizeSource,
    pickQualityOptions: pickQualityOptions,
    redactUrl: redactUrl,
  };

  if (typeof window !== 'undefined') window.GreyboxPlayer = window.GreyboxPlayer || GreyboxPlayer;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      VERSION: VERSION,
      isHlsUrl: isHlsUrl,
      isProgressiveUrl: isProgressiveUrl,
      supportsNativeHls: supportsNativeHls,
      normalizeSource: normalizeSource,
      pickQualityOptions: pickQualityOptions,
      redactUrl: redactUrl,
      GreyboxPlayer: GreyboxPlayer,
    };
  }
})();
