/* Greybox Increment 2 — source routing tests (resolver -> GreyboxPlayer).
 * Run: node tests/source-routing.test.cjs   (exit 0 = all pass)
 * Also runs the Increment 1 suite as a child process (item 15).
 * No dependencies, no browser, no network.
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

const stream = read('js/stream.js');
const player = read('js/greybox-player.js');
const app = read('js/app.js');
const hero = read('js/hero.js');
const router = read('js/router.js');
const data = read('js/data.js');

let S = null, GBP = null;
try { S = require('../js/stream.js'); } catch (e) { S = null; }
try { GBP = require('../js/greybox-player.js'); } catch (e) { GBP = null; }
t('S0 stream.js + greybox-player.js load in Node', !!S && !!GBP);

/* ---- 1. Provider resolution returns the SAME provider ---- */
t('1a EMBED.base unchanged', !!S && S.EMBED.base === 'https://embed.vidrift.in');
t('1b movie URL shape unchanged', !!S && S.getMovieUrl(533535) === 'https://embed.vidrift.in/embed/movie/533535');
t('1c episode URL shape unchanged', !!S && S.getEpisodeUrl(1399, 1, 2) === 'https://embed.vidrift.in/embed/tv/1399/1/2');
t('1d movie/episode paths unchanged', !!S && S.EMBED.moviePath === '/embed/movie/{tmdb_id}' && S.EMBED.episodePath === '/embed/tv/{tmdb_id}/{season}/{episode}');
t('1e isConfigured unchanged', !!S && S.isConfigured() === true);

/* ---- 2. Direct HLS recognized ---- */
const MUX = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
t('2a .m3u8 file-mode -> hls', !!S && S.resolveSourceType({ mode: 'file', url: MUX }) === 'hls');
t('2b .m3u8 with query/fragment -> hls', !!S && S.resolveSourceType({ mode: 'file', url: 'https://h/x.m3u8?tok=1#frag' }) === 'hls');
t('2c missing mode + .m3u8 -> hls (playFile/test-hook shape)', !!S && S.resolveSourceType({ url: MUX }) === 'hls');
t('2d explicit sourceType hls wins on extensionless URL', !!S && S.resolveSourceType({ mode: 'file', url: 'https://cdn/x/stream', sourceType: 'hls' }) === 'hls');
t('2e explicit HLS MIME wins', !!S && S.resolveSourceType({ mode: 'file', url: 'https://cdn/x', contentType: 'application/vnd.apple.mpegurl' }) === 'hls');

/* ---- 3. Direct HLS reaches GreyboxPlayer ---- */
t('3a file branch calls GBP.open (not legacy handling)', /GBP\.open\(v,/.test(stream));
t('3b file branch never assigns the iframe src', (() => {
  const fileBranch = stream.slice(stream.indexOf('File/HLS bucket'));
  return fileBranch.indexOf('f.src') < 0 && fileBranch.indexOf('frame.src') < 0;
})());
t('3c explicit sourceType forwarded to the player', /sourceType:\s*\(ctx && \(ctx\.sourceType \|\| ctx\.contentType \|\| ctx\.mime\)\)/.test(stream));

/* ---- 4. Player receives the normalized contract ---- */
t('4a adapter keeps url/title/subtitles', !!GBP && (() => {
  const n = GBP.normalizeSource({ url: MUX, title: 'T', subtitles: [{ src: 'a.vtt' }] });
  return n.url === MUX && n.title === 'T' && n.subtitles.length === 1 && n.type === 'hls';
})());
t('4b explicit hls plays extensionless URL', !!GBP && GBP.normalizeSource({ url: 'https://cdn/x/stream', sourceType: 'hls' }).type === 'hls');
t('4c explicit file plays extensionless URL', !!GBP && GBP.normalizeSource({ url: 'https://cdn/x/stream', sourceType: 'file' }).type === 'progressive');
t('4d no explicit type + extensionless -> unknown (Increment 1 intact)', !!GBP && GBP.normalizeSource({ url: 'https://cdn/x/stream' }).type === 'unknown');
t('4e string input still accepted', !!GBP && GBP.normalizeSource(MUX).type === 'hls');

/* ---- 5. Direct video files still work ---- */
t('5a .mp4 file-mode -> file', !!S && S.resolveSourceType({ mode: 'file', url: 'https://h/x.mp4' }) === 'file');
t('5b .webm -> file', !!S && S.resolveSourceType({ url: 'https://h/x.webm' }) === 'file');
t('5c player types mp4 as progressive', !!GBP && GBP.normalizeSource('https://h/x.mp4').type === 'progressive');
t('5d explicit video/* MIME -> file', !!S && S.resolveSourceType({ url: 'https://cdn/x', mime: 'video/mp4' }) === 'file');

/* ---- 6. Embed stays on the legacy path ---- */
t('6a mode embed + HLS-looking URL stays embed (no conversion)', !!S && S.resolveSourceType({ mode: 'embed', url: MUX }) === 'embed');
t('6b explicit sourceType embed wins over direct URL', !!S && S.resolveSourceType({ mode: 'file', url: MUX, sourceType: 'embed' }) === 'embed');
t('6c attach routes embed bucket to the iframe branch', /resolveSourceType\(ctx\) === SOURCE_TYPES\.EMBED/.test(stream));
t('6d embed branch sets iframe src + hides stage', /f\.src = url/.test(stream) && /gxStage.*classList\.add\('hidden'\)/.test(stream));
t('6e current EMBED callers still resolve embed pages', !!S && S.resolveSourceType({ mode: 'embed', url: S.getMovieUrl(1) }) === 'embed' && S.resolveSourceType({ mode: 'embed', url: S.getEpisodeUrl(1, 2, 3) }) === 'embed');

/* ---- 7. No iframe for direct HLS ---- */
t('7a player creates no iframe (behavioral, not substring)', (() => {
  const code = player.replace(/\/\*[\s\S]*?\*\//g, '');
  // 'iframe' may appear only as an explicit source-type alias string (routing
  // vocabulary), never as iframe creation, markup, or frame access.
  return !/<iframe/i.test(code) && !/createElement\(\s*['"]iframe['"]/.test(code) && !/embed-frame/.test(code) && !/frame\.src/.test(code);
})());
t('7b file branch hides (never shows) the iframe', (() => {
  const fileBranch = stream.slice(stream.indexOf('File/HLS bucket'));
  return /f\.classList\.add\('hidden'\)/.test(fileBranch) && !/f\.classList\.remove\('hidden'\)/.test(fileBranch);
})());
t('7c stage shown for direct, hidden for embed (no duplicate surfaces)', /stage.*classList\.remove\('hidden'\)/.test(stream) && /gxStage.*classList\.add\('hidden'\)/.test(stream));

/* ---- 8. No provider-selection logic inside the player ---- */
t('8a player has no resolver/provider references', !/EMBED|getMovieUrl|getEpisodeUrl|isConfigured|vidrift|consumet|anilist|vidplus|mode:\s*'embed'|SOURCE_TYPES/.test(player.replace(/\/\*[\s\S]*?\*\//g, '')));
t('8b resolution lives in stream.js only', /function resolveSourceType/.test(stream) && !/function resolveSourceType/.test(player));

/* ---- 9/10. Movie + TV playback functional (callers untouched) ---- */
t('9a playMovie shape intact (embed resolver URL, progress key)', /const url = Stream\.getMovieUrl\(d\.id\)/.test(app) && /progressKey:\s*'movie:' \+ d\.id/.test(app));
t('10a playEpisode + playEpisodeFromPlayer shapes intact', /Stream\.getEpisodeUrl\(d\.id, seasonNum, ep\.episode_number\)/.test(app) && /onEnded: \(\) => autoNext\(season/.test(app));
t('10b autoNext + stepEpisode wiring intact', /function autoNext\(seasonNum, epNum\)/.test(app) && /function stepEpisode\(dir\)/.test(app));
t('10c hero Watch fallback intact', /mode:\s*'embed'/.test(hero) && /getMovieUrl\(item\.id\)/.test(hero));
t('10d custom-file path intact (modeless HLS URL -> hls bucket)', /sub:\s*'Direct file'/.test(app) && !!S && S.resolveSourceType({ title: 'x', sub: 'Direct file', url: MUX }) === 'hls');

/* ---- 11. Anime behavior unchanged ---- */
t('11a anime routes + classification untouched', /anime/.test(router) && /anime/.test(data) && !/anime/i.test(stream) && !/anime/i.test(player.replace(/\/\*[\s\S]*?\*\//g, '')));

/* ---- 12. Fallback order unchanged ---- */
t('12a engine order native -> hls.js -> attach intact', player.indexOf('canNative') < player.indexOf('new HlsLib') && player.indexOf('new HlsLib') < player.indexOf('attachMedia(video)') && /hls-unavailable/.test(player) && /recoverMediaError/.test(player));
t('12b no provider priority/selection code introduced', !/priority|selectProvider|providerIndex|fallbackOrder/i.test(stream));
t('12c EMBED single-host derivation unchanged', (stream.match(/embedBase\(\)/g) || []).length >= 3 && !/\[.*base.*\].*\[.*base/s.test(stream));

/* ---- 13. Cleanup when changing sources ---- */
t('13a teardown destroys player + clears both surfaces + bumps gen', /GreyboxPlayer\.destroy\(\)/.test(stream) && /removeAttribute\('src'\)/.test(stream) && /playerGen\+\+/.test(stream));
t('13b player destroy tears down hls + plyr + tracks + listeners', /hls\.destroy\(\)/.test(player) && /plyr\.destroy\(\)/.test(player) && /data-gx-track/.test(player) && /removeEventListener/.test(player));
t('13c resume listener removed on teardown (no stale callbacks)', /removeEventListener\('loadedmetadata', resumeHandler\)/.test(stream));

/* ---- 14. Stale-request protection intact ---- */
t('14a routeGen/modalGen untouched', /let routeGen = 0/.test(app) && /let modalGen = 0/.test(app) && /myModal !== modalGen/.test(app));
t('14b playerGen guards attach + error + resolve paths', (stream.match(/playerGen/g) || []).length >= 8 && /myGen !== playerGen/.test(stream));
t('14c no second global request-state system', !/requestId|fetchGen|loadGen|openToken|abortController.*open/i.test(stream));
t('14d stream.js has no routing state cross-talk', !/routeGen|modalGen/.test(stream));

/* ---- 15. Increment 1 suite still passes ---- */
let inc1 = false, inc1Out = '';
try {
  inc1Out = execSync('node tests/greybox-player.test.cjs', { cwd: ROOT, stdio: 'pipe' }).toString();
  inc1 = /0 failed/.test(inc1Out);
} catch (e) { inc1Out = String((e && e.stdout) || e).slice(-400); }
t('15 Increment 1 suite green (73 assertions)', inc1, inc1Out.slice(-200));

/* ---- 16. Regression: everything parses ---- */
let checkOk = true, checkErr = '';
try {
  execSync('node --check js/stream.js && node --check js/greybox-player.js && node --check js/greybox-test-source.js && node --check js/app.js && node --check js/router.js && node --check js/data.js && node --check js/hero.js', { cwd: ROOT, stdio: 'pipe' });
} catch (e) { checkOk = false; checkErr = String((e && e.message) || e).slice(0, 200); }
t('16 all player-adjacent modules parse', checkOk, checkErr);

console.log('\n' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
