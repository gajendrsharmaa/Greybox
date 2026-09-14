/* Greybox Player — focused contract/lifecycle tests (Increment 1).
 * Run: node tests/greybox-player.test.cjs   (exit 0 = all pass)
 * No dependencies, no browser, no network. Browser-only behaviors
 * (actual playback, fullscreen, PiP) are covered by the manual checklist in
 * README §6.1; everything automatable is asserted here.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  — ' + extra : '')); }
}

const player = read('js/greybox-player.js');
const stream = read('js/stream.js');
const app = read('js/app.js');
const router = read('js/router.js');
const index = read('index.html');
const css = read('css/player.css');
const testSrc = read('js/greybox-test-source.js');

/* ---- 1. Player initializes (module surface) ---- */
let GBP = null;
try { GBP = require('../js/greybox-player.js'); } catch (e) { GBP = null; }
t('1a greybox-player.js loads in Node', !!GBP);
t('1b exposes open/destroy/state', !!GBP && ['open', 'destroy', 'state'].every((k) => typeof GBP.GreyboxPlayer[k] === 'function'));
t('1c exposes pure helpers', !!GBP && ['isHlsUrl', 'normalizeSource', 'pickQualityOptions', 'supportsNativeHls', 'redactUrl'].every((k) => typeof GBP[k] === 'function'));

/* ---- 2/10. Isolated legitimate test source ---- */
t('2a test manifest isolated in js/greybox-test-source.js', /test-streams\.mux\.dev\/x36xhzz\/x36xhzz\.m3u8/.test(testSrc));
t('2b test URL replaceable via single const', /TEST_HLS_URL/.test(testSrc) && !/vidrift|vidsrc|consumet|anilist/i.test(testSrc));
t('2c test only activates with ?play-test=1 (dev only)', /play-test/.test(testSrc) && /wantsTestPlayback/.test(testSrc));
t('2d test opens through public Stream.Player.open file contract', /Stream\.Player\.open\(\{[\s\S]*mode:\s*'file'/.test(testSrc));

/* ---- 3. Native HLS path ---- */
t('3a native detection via canPlayType apple MIME', /canPlayType\('application\/vnd\.apple\.mpegurl'\)/.test(player));
t('3b native branch sets video.src directly (no engine)', /hls-native/.test(player) && /video\.src = norm\.url/.test(player));

/* ---- 4. HLS.js path ---- */
t('4a Hls.isSupported() gate', /HlsLib\.isSupported\(\)|Hls\.isSupported\(\)/.test(player));
t('4b loadSource + attachMedia on same <video>', /loadSource\(norm\.url\)/.test(player) && /attachMedia\(video\)/.test(player));
t('4c manifest/network/media errors mapped, no stack traces to UI', /MANIFEST_PARSED/.test(player) && /recoverMediaError/.test(player) && !/\.stack/.test(player));

/* ---- 5. Plyr init ---- */
t('5a Plyr constructed around the same video element', /new PlyrLib\(video,/.test(player));
t('5b graceful fallback when Plyr CDN absent', /typeof PlyrLib !== 'function'/.test(player) && /setAttribute\('controls', ''\)/.test(player));

/* ---- 6-10. Controls offered (Plyr config) ---- */
for (const c of ['play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'captions', 'settings', 'pip', 'fullscreen', 'play-large', 'rewind', 'fast-forward', 'restart']) {
  t('6+ control "' + c + '" configured', player.includes("'" + c + "'"));
}
t('10a playback speed options', /speed:\s*\{\s*selected:\s*1,\s*options:\s*\[0\.5/.test(player));
t('10b keyboard controls scoped (global:false)', /keyboard:\s*\{\s*focused:\s*true,\s*global:\s*false/.test(player));
t('10c captions active/update', /captions:\s*\{\s*active:\s*true/.test(player));

/* ---- 11. Quality: only when multiple levels, incl. Auto ---- */
t('11a <2 levels -> null (no useless menu)', !!GBP && GBP.pickQualityOptions([]) === null && GBP.pickQualityOptions([{ height: 720 }]) === null);
t('11b multiple levels -> options incl. Auto(0)', !!GBP && JSON.stringify(GBP.pickQualityOptions([{ height: 720 }, { height: 1080 }, { height: 1080 }])) === JSON.stringify({ options: [0, 1080, 720], def: 0 }));
t('11c level switch uses currentLevel, 0 -> ABR auto', /currentLevel = -1/.test(player) && /currentLevel = i/.test(player));
t('11d no fixed resolutions assumed (from manifest levels)', /hls\.levels/.test(player) && !/720p.*1080p.*2160p|__HEIGHTS__/.test(player));

/* ---- 12. Subtitles preserved, never invented ---- */
t('12a adapter accepts subtitles|tracks|captions', !!GBP && GBP.normalizeSource({ url: 'x.mp4', tracks: [{ src: 'a.vtt', label: 'EN' }] }).subtitles.length === 1);
t('12b no tracks supplied -> no menu data', !!GBP && GBP.normalizeSource({ url: 'x.mp4' }).subtitles.length === 0);
t('12c track URLs only from caller (no invention)', !/src:\s*['"]https?:\/\//.test(player) && !/\.vtt\?/.test(player));
t('12d injected tracks marked + removed on destroy', /data-gx-track/.test(player) && /querySelectorAll\('track\[data-gx-track="1"\]'\)/.test(player));

/* ---- pure-adapter unit checks ---- */
t('U1 isHlsUrl', !!GBP && GBP.isHlsUrl('https://h/x.m3u8?tok=1') && !GBP.isHlsUrl('https://h/x.mp4'));
t('U2 isProgressiveUrl', !!GBP && GBP.isProgressiveUrl('https://h/x.mp4') && !GBP.isProgressiveUrl('https://h/x.m3u8'));
t('U3 normalizeSource type detection', !!GBP && GBP.normalizeSource('a.m3u8').type === 'hls' && GBP.normalizeSource('a.mp4').type === 'progressive' && GBP.normalizeSource({}).type === 'none' && GBP.normalizeSource('https://embed/x').type === 'unknown');
t('U4 redactUrl strips tokens/paths', !!GBP && GBP.redactUrl('https://cdn/x/master.m3u8?token=secret') === 'cdn/.../master.m3u8' && !GBP.redactUrl('https://cdn/x/master.m3u8?token=secret').includes('secret'));
t('U5 dedupe + single default subtitles', !!GBP && (() => {
  const n = GBP.normalizeSource({ url: 'a.mp4', subtitles: [{ src: 'a.vtt', default: true }, { src: 'a.vtt' }, { src: 'b.vtt', default: true }] });
  return n.subtitles.length === 2 && n.subtitles.filter((s) => s.isDefault).length === 1;
})());

/* ---- 13/14/15. Lifecycle: cleanup, source change, reopen ---- */
t('13a destroy() tears down hls + plyr + listeners + tracks', /function destroy\(\)/.test(player) && /hls\.destroy\(\)/.test(player) && /plyr\.destroy\(\)/.test(player) && /removeEventListener/.test(player));
t('14a open() fully cleans previous instance first', /Fully clean the previous instance BEFORE attaching/.test(player) && /teardown\(current\)/.test(player));
t('14b stale opens resolve {stale:true}, never overwrite', /stale:\s*true/.test(player) && /current !== rec/.test(player));
t('15a sequence invalidated on destroy', /openSeq\+\+/.test(player));
t('15b stream.js teardown destroys GreyboxPlayer + resume listener', /GreyboxPlayer\.destroy\(\)/.test(stream) && /resumeHandler/.test(stream));
t('15c modal chrome listeners still bound once', /listenersBound/.test(stream) && /bindOnce\(\)/.test(stream));

/* ---- 16. Player.open() contract preserved ---- */
t('16a Stream.Player exports open/close/current/retry', /Player:\s*\{\s*open,\s*close,\s*current,\s*retry/.test(stream));
t('16b open contract fields intact', /title, sub, url, mode/.test(stream) && /progressKey/.test(stream) && /onEnded/.test(stream) && /showPrevNext/.test(stream));
t('16c app.js callers unchanged (embed movie/episode/file shapes)', /mode:\s*'embed'/.test(app) && /progressKey:\s*`tv:/.test(app) && /progressKey:\s*'movie:'/.test(app) && /Stream\.Player\.open\(\{\s*title,\s*sub:\s*'Direct file'/.test(app));
t('16d hero Watch path unchanged', /Stream\.Player\.open\(\{/.test(read('js/hero.js')));

/* ---- 17. Provider resolution UNCHANGED ---- */
t('17a EMBED.base untouched', /base:\s*'https:\/\/embed\.vidrift\.in'/.test(stream));
t('17b movie/episode paths untouched', /moviePath:\s*'\/embed\/movie\/\{tmdb_id\}'/.test(stream) && /episodePath:\s*'\/embed\/tv\/\{tmdb_id\}\/\{season\}\/\{episode\}'/.test(stream));
t('17c getMovieUrl/getEpisodeUrl/isConfigured intact', /function getMovieUrl\(tmdbId\)/.test(stream) && /function getEpisodeUrl\(tmdbId, season, episode\)/.test(stream) && /function isConfigured\(\)/.test(stream));

/* ---- 18/19. Routing + stale protections intact ---- */
t('18a router still owns all canonical routes', /movie-detail/.test(router) && /tv-detail/.test(router) && /collection/.test(router) && /anime/.test(router) && /mylist/.test(router));
t('19a routeGen/modalGen guards intact', /let routeGen = 0/.test(app) && /let modalGen = 0/.test(app) && /myModal !== modalGen \|\| myRoute !== routeGen/.test(app));
t('19b playerGen stale guard added (no global routing state)', /playerGen/.test(stream) && !/routeGen/.test(stream));

/* ---- 20/21. No iframe / no provider logic in new player ---- */
t('20a greybox-player.js uses no iframe (code, not comments)', (() => {
  const code = player.replace(/\/\*[\s\S]*?\*\//g, '');
  // 'iframe' may appear only as an explicit source-type alias string (routing
  // vocabulary), never as iframe creation, markup, or frame access.
  return !/<iframe/i.test(code) && !/createElement\(\s*['"]iframe['"]/.test(code) && !/embed-frame/.test(code) && !/frame\.src/.test(code);
})());
t('20b index iframes unchanged (hero trailer + detail trailer + legacy embed)', (index.match(/<iframe/g) || []).length === 3 && /id="hero-trailer"/.test(index) && /id="m-video"/.test(index) && /id="embed-frame"/.test(index));
t('21a no provider logic in player', !/vidrift|vidsrc|consumet|anilist|vidplus|tmdb/i.test(player));
t('21b no provider logic in test source', !/vidrift|vidsrc|consumet|anilist|vidplus/i.test(testSrc));

/* ---- 22. No secrets ---- */
t('22a no tokens in new/changed files', !/eyJ[A-Za-z0-9_-]{10,}/.test(player + testSrc + css) && !/api[_-]?key\s*=\s*['"][^'"]+['"]/i.test(player + testSrc));
t('22b errors redact URLs (no signed-URL logging)', /redactUrl\(/.test(player) && !/console\.log\(.*url/i.test(player));

/* ---- wiring ---- */
t('W1 Plyr CDN pinned (official distribution)', /cdn\.plyr\.io\/3\.7\.8\/plyr\.polyfilled\.js/.test(index) && /cdn\.plyr\.io\/3\.7\.8\/plyr\.css/.test(index));
t('W2 player.css + greybox-player.js wired before stream.js', index.indexOf('greybox-player.js') > 0 && index.indexOf('greybox-player.js') < index.indexOf('js/stream.js') && /css\/player\.css/.test(index));
t('W3 video inside .gx-player-stage, no controls attr (Plyr owns UI)', /gx-player-stage/.test(index) && /<video id="video"[^>]*playsinline/.test(index) && !/<video id="video"[^>]*controls/.test(index));
t('W4 stage styled with Greybox tokens only', /var\(--gx-accent/.test(css) && /var\(--gx-text/.test(css) && !/#ff0000|neon/i.test(css));

/* ---- 23. Regression: repo still parses, unintended files untouched ---- */
let checkOk = true, checkErr = '';
try {
  execSync('node --check js/greybox-player.js && node --check js/stream.js && node --check js/greybox-test-source.js && node --check js/app.js && node --check js/router.js && node --check js/data.js && node --check js/hero.js', { cwd: ROOT, stdio: 'pipe' });
} catch (e) { checkOk = false; checkErr = String((e && e.message) || e).slice(0, 200); }
t('23a all touched + adjacent modules parse', checkOk, checkErr);
let diff = '';
try { diff = execSync('git status --short', { cwd: ROOT }).toString(); } catch (e) { diff = 'GIT-UNAVAILABLE'; }
const changed = diff.split('\n').map((l) => l.trim()).filter(Boolean);
// Intended-file allowlist, extended per increment (Blocked Titles increment
// adds the blocklist's own files; the Navigation V1 increment adds the
// navbar-config files; the Detail Pages V1 increment adds the detail-flags
// files below; the guard still fails on any UNintended change, e.g.
// playback/provider/hero/router/renderer edits).
const allowed = ['M index.html', 'M admin.html', 'M css/admin.css', 'M functions/lib/db.js', 'M functions/lib/validate.js', 'M js/stream.js', 'M js/greybox-player.js', 'M js/admin.js', 'M js/data.js', 'M tests/greybox-player.test.cjs', 'M tests/source-routing.test.cjs', 'M tests/blocked.test.cjs', 'M README.md', '?? css/player.css', '?? js/greybox-player.js', '?? js/greybox-test-source.js', '?? functions/api/admin/blocked.js', '?? functions/api/admin/blocked/', '?? functions/api/config/blocked.js', '?? js/blocked.config.js', '?? migrations/0004_blocked.sql', '?? functions/api/admin/navigation.js', '?? functions/api/config/navigation.js', '?? js/navigation.config.js', '?? js/navigation.js', '?? migrations/0005_navigation.sql', '?? functions/api/admin/settings/detail-pages.js', '?? functions/api/config/detail-pages.js', '?? js/detail-pages.config.js', '?? js/detail-pages.js', '?? migrations/0006_detail_pages.sql', 'M tests/navigation.test.cjs', '?? tests/'];
const unexpected = changed.filter((l) => !allowed.some((a) => l === a || (a.endsWith('/') && l.startsWith(a))));
t('23b only intended files changed', diff === 'GIT-UNAVAILABLE' || unexpected.length === 0, unexpected.join(', '));
// The Blocked Titles increment filters centrally in js/data.js by design
// (spec: global filtering with minimal duplicated code), so data.js is an
// intended change; router/app/hero/api/pages/components stay untouched.
t('23c router/app/hero untouched by diff', !changed.some((l) => /js\/(router|app|hero|api|pages|components)\.js/.test(l)), changed.join(', '));

console.log('\n' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
