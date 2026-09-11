/* Greybox router — Vanilla JS History API + Cloudflare Pages SPA fallback.
 *
 * Architecture:
 *   - Single static entry: /index.html (no framework, no build step).
 *   - Client router (this file): parses location -> route, pushState/replaceState
 *     for in-app navigation, popstate for back/forward, click interception for
 *     same-origin app links. No UI, no fetching here — js/app.js subscribes
 *     via Router.onChange() and renders.
 *   - Server fallback: _redirects rewrites app paths to /index.html (200) so
 *     refresh + direct-URL + new-tab loads boot this same file, which then
 *     renders the route. /api/* is never rewritten (Functions take precedence
 *     + _redirects rules below deliberately avoid /api/*).
 *
 * Canonical routes:
 *   /                          home (trending)
 *   /movies                    movies, default cat popular
 *   /movies/popular|top-rated|upcoming|now-playing[?page=N]
 *   /tv                        tv, default cat popular
 *   /tv/popular|top-rated|on-the-air|airing-today[?page=N]
 *   /movie/:id                 movie detail (TMDB numeric id)
 *   /tv/:id                    tv detail (numeric id; non-numeric = category)
 *   /search?q=...[&page=N]     search results page (grid)
 *   /person/:id                person detail (via existing /api/tmdb proxy)
+ *   /collection/:slug          Greybox collection (local config, Greybox order)
 *   /anime[/series|/movies]    preserved existing mode
 *   /mylist                    preserved existing mode (localStorage)
 *
 * Anything else (/api/*, /css/*, /js/*, *.html, /favicon.svg, …) is NOT an
 * app route — the router ignores it and lets the browser handle it natively.
 */
(function () {
  'use strict';

  var MOVIE_CATS = ['popular', 'top-rated', 'upcoming', 'now-playing'];
  var TV_CATS = ['popular', 'top-rated', 'on-the-air', 'airing-today'];
  var ANIME_KINDS = ['series', 'movies'];

  function parsePage(v) {
    var n = parseInt(String(v == null ? '1' : v), 10);
    if (!isFinite(n) || n < 1) return 1;
    return Math.min(n, 500);
  }

  function parseId(v) {
    // Strict: digits only (no "550abc", no negatives, no decimals).
    var s = String(v == null ? '' : v).trim();
    if (!/^\d+$/.test(s)) return 0;
    var n = parseInt(s, 10);
    return n > 0 ? n : 0;
  }

  function stripTrailingSlash(p) {
    if (p.length > 1 && p.charAt(p.length - 1) === '/') return p.slice(0, -1);
    return p;
  }

  // True only for paths this SPA owns. Everything else passes through.
  function isAppPath(pathname) {
    var p = stripTrailingSlash(String(pathname || '/'));
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
  }

  // pathname + search -> route object. Never throws.
  function parseRoute(pathname, search) {
    var p = stripTrailingSlash(String(pathname || '/') || '/');
    var q = {};
    try {
      var sp = new URLSearchParams(String(search || ''));
      sp.forEach(function (v, k) { q[k] = v; });
    } catch (e) { q = {}; }
    var segs = p.split('/').filter(Boolean).map(function (s) {
      try { return decodeURIComponent(s); } catch (e) { return s; }
    });

    if (segs.length === 0) {
      var HOME_TABS = ['trending', 'popular-movie', 'popular-tv', 'top'];
      var htab = String(q.tab || 'trending').toLowerCase();
      if (HOME_TABS.indexOf(htab) < 0) htab = 'trending';
      return { name: 'home', tab: htab, path: p, page: parsePage(q.page) };
    }

    var head = (segs[0] || '').toLowerCase();

    if (head === 'movies') {
      if (segs.length === 1) return { name: 'movies', cat: 'popular', path: p, page: parsePage(q.page) };
      if (segs.length === 2) {
        var cat = segs[1].toLowerCase();
        if (MOVIE_CATS.indexOf(cat) >= 0) return { name: 'movies', cat: cat, path: p, page: parsePage(q.page) };
        return { name: 'not-found', path: p };
      }
      return { name: 'not-found', path: p };
    }

    if (head === 'tv') {
      if (segs.length === 1) return { name: 'tv', cat: 'popular', path: p, page: parsePage(q.page) };
      if (segs.length === 2) {
        var seg = segs[1];
        if (/^\d+$/.test(seg)) {
          var id = parseId(seg);
          if (id) return { name: 'tv-detail', id: id, path: p };
          return { name: 'not-found', path: p };
        }
        var tcat = seg.toLowerCase();
        if (TV_CATS.indexOf(tcat) >= 0) return { name: 'tv', cat: tcat, path: p, page: parsePage(q.page) };
        return { name: 'not-found', path: p };
      }
      return { name: 'not-found', path: p };
    }

    if (head === 'movie') {
      if (segs.length === 2) {
        var mid = parseId(segs[1]);
        if (mid) return { name: 'movie-detail', id: mid, path: p };
      }
      return { name: 'not-found', path: p };
    }

    if (head === 'search') {
      return { name: 'search', q: String(q.q || '').trim(), page: parsePage(q.page), path: p };
    }

    if (head === 'person') {
      if (segs.length === 2) {
        var pid = parseId(segs[1]);
        if (pid) return { name: 'person', id: pid, path: p };
      }
      return { name: 'not-found', path: p };
    }

    if (head === 'collection') {
      // Greybox-controlled slug (local config): lowercase letters/numbers/hyphens.
      if (segs.length === 2) {
        var slug = String(segs[1] || '').trim().toLowerCase();
        if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 64) {
          return { name: 'collection', slug: slug, path: p };
        }
      }
      return { name: 'not-found', path: p };
    }

    if (head === 'anime') {
      if (segs.length === 1) return { name: 'anime', kind: 'series', path: p, page: parsePage(q.page) };
      if (segs.length === 2) {
        var kind = segs[1].toLowerCase();
        if (ANIME_KINDS.indexOf(kind) >= 0) return { name: 'anime', kind: kind, path: p, page: parsePage(q.page) };
        return { name: 'not-found', path: p };
      }
      return { name: 'not-found', path: p };
    }

    if (head === 'mylist' && segs.length === 1) {
      return { name: 'mylist', path: p };
    }

    return { name: 'not-found', path: p };
  }

  function current() {
    return parseRoute(window.location.pathname, window.location.search);
  }

  function titleFor(route) {
    var base = 'Greybox';
    if (!route) return base;
    switch (route.name) {
      case 'home': return 'Greybox — Browse Movies & TV';
      case 'movies': return 'Movies (' + route.cat + ') — Greybox';
      case 'tv': return 'TV Shows (' + route.cat + ') — Greybox';
      case 'movie-detail': return 'Movie ' + route.id + ' — Greybox';
      case 'tv-detail': return 'TV Show ' + route.id + ' — Greybox';
      case 'search': return (route.q ? 'Search: ' + route.q : 'Search') + ' — Greybox';
      case 'person': return 'Person ' + route.id + ' — Greybox';
      case 'collection': return 'Collection — Greybox'; // app.js sets the real title after config load
      case 'anime': return 'Anime (' + route.kind + ') — Greybox';
      case 'mylist': return 'My List — Greybox';
      case 'not-found': return 'Not found — Greybox';
      default: return base;
    }
  }

  /* ---------------- URL builders (single place that forms app URLs) ---------------- */
  function withPage(url, page) {
    if (page && page > 1) return url + '?page=' + page;
    return url;
  }

  var url = {
    home: function (tab, page) {
      tab = String(tab || 'trending').toLowerCase();
      page = parsePage(page);
      var qs = [];
      if (tab && tab !== 'trending') qs.push('tab=' + encodeURIComponent(tab));
      if (page > 1) qs.push('page=' + page);
      return '/' + (qs.length ? '?' + qs.join('&') : '');
    },
    movies: function (cat, page) {
      cat = (cat || 'popular').toLowerCase();
      if (MOVIE_CATS.indexOf(cat) < 0) cat = 'popular';
      // Short form for the default so /movies stays canonical.
      if (cat === 'popular' && (!page || page <= 1)) return '/movies';
      return withPage('/movies/' + cat, page);
    },
    tv: function (cat, page) {
      cat = (cat || 'popular').toLowerCase();
      if (TV_CATS.indexOf(cat) < 0) cat = 'popular';
      if (cat === 'popular' && (!page || page <= 1)) return '/tv';
      return withPage('/tv/' + cat, page);
    },
    movie: function (id) { return '/movie/' + parseId(id); },
    show: function (id) { return '/tv/' + parseId(id); },
    search: function (q, page) {
      var s = '/search?q=' + encodeURIComponent(String(q || ''));
      if (page && page > 1) s += '&page=' + parsePage(page);
      return s;
    },
    person: function (id) { return '/person/' + parseId(id); },
    collection: function (slug) {
      var s = String(slug || '').trim().toLowerCase();
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) || s.length > 64) return '/';
      return '/collection/' + s;
    },
    anime: function (kind, page) {
      kind = (kind || 'series').toLowerCase();
      if (ANIME_KINDS.indexOf(kind) < 0) kind = 'series';
      if (kind === 'series' && (!page || page <= 1)) return '/anime';
      return withPage('/anime/' + kind, page);
    },
    mylist: function () { return '/mylist'; },
  };

  /* ---------------- navigation core ---------------- */
  var listeners = [];
  var inAppNavigations = 0; // counts push/replace done by this router (for modal-close UX)

  function emit(route) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](route); } catch (e) { setTimeout(function () { throw e; }, 0); }
    }
  }

  function onChange(cb) {
    if (typeof cb !== 'function') return function () {};
    listeners.push(cb);
    return function () {
      var i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function navigate(to, opts) {
    opts = opts || {};
    var target = String(to || '/');
    // Absolute URLs on the same origin are fine; anything else is a no-op.
    var u;
    try { u = new URL(target, window.location.origin); } catch (e) { return; }
    if (u.origin !== window.location.origin) { window.location.href = target; return; }
    var next = u.pathname + u.search + u.hash;
    var cur = window.location.pathname + window.location.search + window.location.hash;
    if (!opts.replace && next === cur) return; // no-op, avoids duplicate entries
    inAppNavigations++;
    if (opts.replace) window.history.replaceState({ greybox: true }, '', next);
    else window.history.pushState({ greybox: true }, '', next);
    emit(current());
  }

  function replace(to) { navigate(to, { replace: true }); }

  function hasInAppHistory() { return inAppNavigations > 0; }

  function bindLinkInterception() {
    document.addEventListener('click', function (e) {
      // Let modified clicks / non-left buttons behave natively.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      var href = a.getAttribute('href');
      if (!href || href.charAt(0) === '#' || href.indexOf('mailto:') === 0 || href.indexOf('tel:') === 0) return;
      if (a.target === '_blank' || a.hasAttribute('download')) return;
      var u;
      try { u = new URL(href, window.location.origin); } catch (err) { return; }
      if (u.origin !== window.location.origin) return; // external: native
      if (!isAppPath(u.pathname)) return; // static/API/asset: native load
      e.preventDefault();
      navigate(u.pathname + u.search + u.hash);
    });
  }

  function init() {
    if (init.done) return current();
    init.done = true;
    bindLinkInterception();
    window.addEventListener('popstate', function () { emit(current()); });
    return current();
  }

  window.Router = {
    parseRoute: parseRoute,
    isAppPath: isAppPath,
    current: current,
    titleFor: titleFor,
    url: url,
    navigate: navigate,
    replace: replace,
    onChange: onChange,
    hasInAppHistory: hasInAppHistory,
    init: init,
    MOVIE_CATS: MOVIE_CATS,
    TV_CATS: TV_CATS,
  };

  // Node export for headless route tests (classic script still works in browser).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = window.Router;
  }
})();
