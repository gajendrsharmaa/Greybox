/* Greybox route persistence — stay on the same page after reload.
 *
 * Problem: History-API routes (/anime, /movies, /tv, /mylist, /search,
 * /collection/:slug, /movie/:id, /tv/:id, …) only survive a browser reload
 * when the host serves /index.html for those paths (see _redirects +
 * vercel.json). Some static hosts / local previews instead drop the reload
 * back to "/" — so the user is yanked to Home even though the SPA router
 * (js/router.js, URL is source of truth) would have rendered the right page.
 *
 * Fix (additive, no router/app changes):
 *   - Remember the last valid app URL per tab (sessionStorage survives a
 *     reload in the same tab, but a fresh tab starts clean — so an
 *     intentional visit to "/" is never hijacked by an old page).
 *   - On boot, if this load is a RELOAD and the server handed us the bare
 *     Home fallback ("/" or "/index.html" with no meaningful query) while
 *     the tab remembers a different valid app URL, replaceState back to the
 *     remembered URL BEFORE app.js reads Router.current(). When the server
 *     fallback works (reload already at /anime), nothing changes.
 *   - Saving hooks the History API itself (pushState/replaceState/popstate/
 *     pagehide), so it also catches overlay detail opens that bypass
 *     Router.navigate (app.js openOverlay uses history.pushState directly).
 *
 * No fetching, no rendering, no route changes beyond the single reload
 * restore. Never throws. Router.js / app.js untouched.
 */
(function () {
  'use strict';

  var KEY = 'greybox:last-route:v1';

  function currentURL() {
    try {
      return window.location.pathname + window.location.search + window.location.hash;
    } catch (e) { return ''; }
  }

  function splitURL(url) {
    try {
      var u = new URL(String(url || ''), window.location.origin);
      return { pathname: u.pathname || '/', search: u.search || '', hash: u.hash || '' };
    } catch (e) {
      return { pathname: '/', search: '', hash: '' };
    }
  }

  // True for URLs the SPA owns (mirrors Router.isAppPath when available).
  function isAppURL(url) {
    try {
      var parts = splitURL(url);
      if (window.Router && typeof window.Router.isAppPath === 'function') {
        return !!window.Router.isAppPath(parts.pathname);
      }
    } catch (e) { /* fall through to regex */ }
    try {
      var p = splitURL(url).pathname;
      if (p.length > 1 && p.charAt(p.length - 1) === '/') p = p.slice(0, -1);
      if (p === '/') return true;
      if (p === '/movies' || p.indexOf('/movies/') === 0) return true;
      if (p === '/tv' || p.indexOf('/tv/') === 0) return true;
      if (p === '/movie' || p.indexOf('/movie/') === 0) return true;
      if (p === '/search') return true;
      if (p === '/person' || p.indexOf('/person/') === 0) return true;
      if (p === '/collection' || p.indexOf('/collection/') === 0) return true;
      if (p === '/anime' || p.indexOf('/anime/') === 0) return true;
      if (p === '/mylist') return true;
      return false;
    } catch (e) { return false; }
  }

  // Valid = owned by the SPA AND parses to a real route (not not-found).
  function isValidSavedURL(url) {
    if (!url || typeof url !== 'string') return false;
    if (!isAppURL(url)) return false;
    try {
      if (window.Router && typeof window.Router.parseRoute === 'function') {
        var parts = splitURL(url);
        var route = window.Router.parseRoute(parts.pathname, parts.search);
        return !!route && route.name !== 'not-found';
      }
    } catch (e) { /* regex check already passed */ }
    return true;
  }

  // Bare-Home fallback candidate: the server dropped the reload to Home.
  // Only the DEFAULT home (no tab/page/q that proves the user meant Home).
  function isBareHome(url) {
    var parts = splitURL(url);
    var p = parts.pathname;
    if (p === '/index.html' || p === '/index.htm') p = '/';
    if (p !== '/') return false;
    var search = parts.search || '';
    if (!search || search === '?') return true;
    try {
      var sp = new URLSearchParams(search);
      var keys = [];
      sp.forEach(function (v, k) { keys.push(k); });
      if (!keys.length) return true;
      // Any meaningful home/search state means the user (or router) put it
      // there deliberately — never treat it as a dropped reload.
      return false;
    } catch (e) { return false; }
  }

  function isReloadNavigation() {
    try {
      if (window.performance && typeof window.performance.getEntriesByType === 'function') {
        var entries = window.performance.getEntriesByType('navigation');
        if (entries && entries.length && entries[0]) {
          if (entries[0].type === 'reload') return true;
          // Not a reload (navigate / back_forward / prerender) → no restore.
          if (entries[0].type) return false;
        }
      }
    } catch (e) { /* fall through */ }
    try {
      if (window.performance && window.performance.navigation &&
        typeof window.performance.navigation.type !== 'undefined') {
        return window.performance.navigation.type === 1; // TYPE_RELOAD (legacy)
      }
    } catch (e) { /* unknown → no restore */ }
    return false;
  }

  function loadSaved() {
    try {
      var v = window.sessionStorage ? window.sessionStorage.getItem(KEY) : null;
      return typeof v === 'string' && v ? v : '';
    } catch (e) { return ''; }
  }

  function save(url) {
    try {
      if (!url || !isValidSavedURL(url)) return;
      if (window.sessionStorage) window.sessionStorage.setItem(KEY, url);
    } catch (e) { /* storage blocked/private → reload just uses the URL */ }
  }

  function saveCurrent() {
    try { save(currentURL()); } catch (e) { /* noop */ }
  }

  // Synchronous boot restore — must run BEFORE app.js reads Router.current().
  function maybeRestore() {
    var cur = '';
    try { cur = currentURL(); } catch (e) { return false; }
    if (!isBareHome(cur)) return false;
    if (!isReloadNavigation()) return false;
    var saved = loadSaved();
    if (!saved || saved === cur) return false;
    if (!isValidSavedURL(saved)) return false;
    // Don't "restore" to bare Home — we're already there.
    if (isBareHome(saved)) return false;
    try {
      window.history.replaceState({ greybox: true }, '', saved);
      return true;
    } catch (e) { return false; }
  }

  // Observe every URL change (Router.navigate + overlay pushState + back/fw).
  function hookHistory() {
    try {
      var origPush = window.history.pushState;
      if (origPush && !origPush.__greyboxPersistWrapped) {
        var wrappedPush = function () {
          try { return origPush.apply(this, arguments); }
          finally { try { saveCurrent(); } catch (e) { /* noop */ } }
        };
        wrappedPush.__greyboxPersistWrapped = true;
        window.history.pushState = wrappedPush;
      }
    } catch (e) { /* noop */ }
    try {
      var origReplace = window.history.replaceState;
      if (origReplace && !origReplace.__greyboxPersistWrapped) {
        var wrappedReplace = function () {
          try { return origReplace.apply(this, arguments); }
          finally { try { saveCurrent(); } catch (e) { /* noop */ } }
        };
        wrappedReplace.__greyboxPersistWrapped = true;
        window.history.replaceState = wrappedReplace;
      }
    } catch (e) { /* noop */ }
    try {
      window.addEventListener('popstate', function () {
        try { saveCurrent(); } catch (e) { /* noop */ }
      });
    } catch (e) { /* noop */ }
    try {
      window.addEventListener('pagehide', function () {
        try { saveCurrent(); } catch (e) { /* noop */ }
      });
    } catch (e) { /* noop */ }
    try {
      document.addEventListener('visibilitychange', function () {
        try { if (document.hidden) saveCurrent(); } catch (e) { /* noop */ }
      });
    } catch (e) { /* noop */ }
  }

  var restored = false;
  try { restored = maybeRestore(); } catch (e) { restored = false; }
  try { hookHistory(); } catch (e) { /* noop */ }
  // Remember the (possibly restored) URL so the NEXT reload has it — but
  // never let a bare-Home boot clobber a good saved route before app.js runs:
  // only overwrite when the current URL is meaningful, or when there is
  // nothing saved yet.
  try {
    var now = currentURL();
    var prev = loadSaved();
    if (now && isValidSavedURL(now) && (!isBareHome(now) || !prev || !isValidSavedURL(prev))) {
      save(now);
    }
  } catch (e) { /* noop */ }

  try {
    window.GreyboxRoutePersist = {
      KEY: KEY,
      currentURL: currentURL,
      isAppURL: isAppURL,
      isValidSavedURL: isValidSavedURL,
      isBareHome: isBareHome,
      isReloadNavigation: isReloadNavigation,
      loadSaved: loadSaved,
      save: save,
      saveCurrent: saveCurrent,
      restored: !!restored,
    };
  } catch (e) { /* test hook optional */ }
})();
