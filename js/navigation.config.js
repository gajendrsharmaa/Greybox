/* Greybox public navigation — offline fallback (labels, order, visibility).
 *
 * D1 (`settings` row `navigation`, managed through /api/admin/navigation
 * and the Admin Navigation workspace) is the live source of truth. THIS
 * FILE is the offline fallback: it is used only when D1 is unreachable
 * (static preview, Vercel without D1, binding missing) — see js/data.js
 * preloadGreyboxConfig + getNavigationConfig.
 *
 * This fallback reproduces the current hardcoded navbar exactly: Home,
 * Movies, TV Shows, Anime, Collections, My List (in that order, all
 * visible) plus the header search box. Identity is ALWAYS the stable key
 * (home, movies, tv, anime, collections, my-list) — never the label.
 * Routes are NOT stored here: each key maps to its existing controlled
 * public route (see js/data.js NAV_ROUTES), so relabeling can never break
 * routing. To change the fallback, edit labels/visible/order below —
 * never add arbitrary URLs.
 */
(function () {
  'use strict';

  window.GreyboxNavigation = {
    items: [
      { key: 'home', label: 'Home', visible: true },
      { key: 'movies', label: 'Movies', visible: true },
      { key: 'tv', label: 'TV Shows', visible: true },
      { key: 'anime', label: 'Anime', visible: true },
      { key: 'collections', label: 'Collections', visible: true },
      { key: 'my-list', label: 'My List', visible: true },
    ],
    searchVisible: true,
  };
})();
