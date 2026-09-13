/* Greybox dev-only HLS test source (Increment 1).
 *
 * ISOLATED TEST MECHANISM — safe to delete: remove this file plus its single
 * <script> tag in index.html and nothing else changes.
 *
 * Uses a well-known legitimate public test manifest (Mux's HLS test stream,
 * published for player testing — NOT a third-party streaming site's hidden
 * stream, no auth/DRM/referer bypass of any kind). It exists only to prove
 * the Greybox Player can consume a legitimately available HLS manifest.
 *
 * Usage (local dev only): open the site with ?play-test=1
 *   e.g. http://localhost:8788/?play-test=1
 * The player opens in direct-file mode through the normal Stream.Player.open
 * contract — no special code path inside the player.
 *
 * To point the test at a different legitimate manifest you own or that is
 * published for testing, change TEST_HLS_URL below. Nothing else reads it.
 */
(function () {
  'use strict';

  // Replaceable test manifest. Keep it a legitimately available HLS URL.
  var TEST_HLS_URL = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

  function getTestUrl() {
    return TEST_HLS_URL;
  }

  function wantsTestPlayback() {
    try {
      var q = new URLSearchParams(window.location.search || '');
      return q.get('play-test') === '1' || window.location.hash === '#play-test';
    } catch (e) {
      return false;
    }
  }

  window.GreyboxTestSource = {
    TEST_HLS_URL: TEST_HLS_URL,
    getTestUrl: getTestUrl,
    wantsTestPlayback: wantsTestPlayback,
  };

  // Dev-only auto-open: same public contract as every other caller.
  try {
    if (wantsTestPlayback() && window.Stream && window.Stream.Player) {
      var openTest = function () {
        try {
          window.Stream.Player.open({
            title: 'Greybox Player Test',
            sub: 'Legitimate HLS test manifest (dev only)',
            url: getTestUrl(),
            mode: 'file',
            progressKey: 'greybox:test-hls',
          });
        } catch (e) { /* test hook only */ }
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(openTest, 600); }, { once: true });
      } else {
        setTimeout(openTest, 600);
      }
    }
  } catch (e) { /* test hook never breaks the app */ }
})();
