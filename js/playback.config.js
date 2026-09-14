/* Greybox playback configuration — offline fallback (playback mode).
 *
 * D1 (`settings` row `playback`, managed through
 * /api/admin/settings/playback and the Admin Playback workspace) is the
 * live source of truth. THIS FILE is the offline fallback: it is used only
 * when D1 is unreachable (static preview, Vercel without D1, binding
 * missing) — see js/data.js preloadGreyboxConfig + getPlaybackConfig.
 *
 * This fallback reproduces the historical Greybox behavior exactly: automatic
 * resolver strategy (catalog titles use the configured embed source, direct
 * files use the Greybox Player). Identity is ALWAYS the mode key
 * (auto/direct/embed) — never a display label. No provider URLs, tokens, or
 * secrets live here: the embed host stays in js/stream.js EMBED.base and the
 * test manifest stays in js/greybox-test-source.js.
 */
(function () {
  'use strict';

  window.GreyboxPlayback = {
    mode: 'auto',
  };
})();
