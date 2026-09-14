/* Greybox detail page presentation — offline fallback (visibility flags).
 *
 * D1 (`settings` row `detail_pages`, managed through
 * /api/admin/settings/detail-pages and the Admin Detail Pages workspace)
 * is the live source of truth. THIS FILE is the offline fallback: it is
 * used only when D1 is unreachable (static preview, Vercel without D1,
 * binding missing) — see js/data.js preloadGreyboxConfig +
 * getDetailPagesConfig.
 *
 * This fallback reproduces the current detail page exactly (everything
 * shown). Identity is ALWAYS the group.key path (header.backdrop,
 * tv.episodes, ...) — never a display label. Only elements that actually
 * exist in js/pages.js renderTitleDetail are listed here; there is no
 * recommendations/original-title/logo flag because the detail page
 * renders none of those. TV-only flags safely no-op for movies, and these
 * flags never override Blocked Titles (enforced upstream in js/data.js
 * before any rendering).
 */
(function () {
  'use strict';

  window.GreyboxDetailPages = {
    header: {
      backdrop: true,
      poster: true,
      badge: true,
      title: true,
      meta: true,
      rating: true,
      genres: true,
      overview: true,
    },
    actions: {
      watch: true,
      trailer: true,
      myList: true,
    },
    content: {
      providers: true,
      cast: true,
    },
    tv: {
      episodes: true,
      episodeOverview: true,
      episodeMeta: true,
    },
  };
})();
