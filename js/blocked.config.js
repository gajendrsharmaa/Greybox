/* Greybox permanent blocklist — offline fallback (identity only).
 *
 * D1 (`blocked_titles` table, managed through /api/admin/blocked and the
 * Admin Blocked Titles workspace) is the live source of truth. THIS FILE is
 * the offline fallback: it is used only when D1 is unreachable (static
 * preview, Vercel without D1, binding missing) — see js/data.js
 * preloadGreyboxConfig + getBlockedConfig.
 *
 * The blocklist starts empty and stays empty here: blocking is an explicit
 * Admin action in a live environment, never a committed default. Identity is
 * ALWAYS media + TMDB ID (never title text — titles change, and
 * "movie:123" vs "tv:123" are different identities):
 *
 *   window.GreyboxBlocked = [
 *     { media: 'movie', id: 12345 },
 *     { media: 'tv', id: 67890 },
 *   ];
 */
(function () {
  'use strict';

  window.GreyboxBlocked = [];
})();
