/* Greybox Playback V1 — focused tests (Admin playback configuration).
 * Run: node tests/playback.test.cjs   (exit 0 = all pass)
 * No dependencies, no browser, no network.
 *
 * Covers the increment checklist:
 *  1. default playback configuration
 *  2. supported playback modes
 *  3. invalid mode rejection
 *  4. Admin GET
 *  5. Admin PUT
 *  6. authentication
 *  7. public configuration
 *  8. public fallback
 *  9. resolver receives configured mode
 * 10. direct mode fails cleanly when no direct source exists
 * 11. embed mode remains functional
 * 12. auto mode preserves resolver behavior
 * 13. player settings that are actually implemented
 * 14. test source remains functional
 * 15. no secret leakage
 * 16. no provider extraction logic
 * 17. Blocked Titles interaction remains intact
 * 18. Detail Pages interaction remains intact
 * 19. Hero behavior remains unchanged
 * plus: migration safety, no duplicate config, no token leaks, and no
 * regressions in Navigation / Blocked Titles / Detail Pages / router.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  — ' + extra : '')); }
}

const dataSrc = read('js/data.js');
const streamSrc = read('js/stream.js');
const adminSrc = read('js/admin.js');
const adminHtml = read('admin.html');
const indexHtml = read('index.html');
const appSrc = read('js/app.js');
const heroSrc = read('js/hero.js');
const playerSrc = read('js/greybox-player.js');
const testSrc = read('js/greybox-test-source.js');
const fallbackSrc = read('js/playback.config.js');
const dbSrc = read('functions/lib/db.js');
const validateSrc = read('functions/lib/validate.js');
const adminRoute = read('functions/api/admin/settings/playback.js');
const publicRoute = read('functions/api/config/playback.js');
const migration = read('migrations/0007_playback.sql');

const MODES = ['auto', 'direct', 'embed'];

/* ---- 1. default playback configuration ---- */
t('1a migration 0007_playback.sql exists (next number, no collision)',
  fs.existsSync(path.join(ROOT, 'migrations/0007_playback.sql')) &&
  !fs.existsSync(path.join(ROOT, 'migrations/0008_playback.sql')) &&
  read('migrations/0001_schema.sql').includes('home_sections') &&
  read('migrations/0002_seed.sql').includes('home_hero') &&
  read('migrations/0003_tags.sql').includes('tag_members') &&
  read('migrations/0004_blocked.sql').includes('blocked_titles') &&
  read('migrations/0005_navigation.sql').includes("'navigation'") &&
  read('migrations/0006_detail_pages.sql').includes("'detail_pages'"));
t('1b migration seeds one settings row with mode auto',
  /INSERT OR REPLACE INTO settings/.test(migration) && migration.includes("'playback'") &&
  migration.includes('"mode":"auto"') &&
  !/"mode":"direct"/.test(migration) && !/"mode":"embed"/.test(migration));
t('1c migration stores mode only (no TMDB data, no secrets, no URLs)',
  !/GREYBOX_ADMIN_TOKEN|TMDB_READ_TOKEN|TMDB_API_KEY|eyJ/i.test(migration) &&
  !/poster_path|backdrop_path/.test(migration) &&
  !/https?:\/\//.test(migration));
t('1d offline fallback reproduces historical behavior (auto, mode only)',
  fs.existsSync(path.join(ROOT, 'js/playback.config.js')) &&
  /window\.GreyboxPlayback/.test(fallbackSrc) &&
  /mode:\s*'auto'/.test(fallbackSrc) &&
  !/https?:\/\//.test(fallbackSrc) &&
  !/GREYBOX_ADMIN_TOKEN|TMDB_READ_TOKEN|eyJ|document\.cookie|localStorage|sessionStorage/i.test(fallbackSrc));
t('1e index.html wires fallback before data.js',
  indexHtml.indexOf('playback.config.js') >= 0 &&
  indexHtml.indexOf('playback.config.js') < indexHtml.indexOf('js/data.js'));
t('1f data.js default is auto (PLAYBACK_DEFAULT)',
  /PLAYBACK_DEFAULT\s*=\s*\{\s*mode:\s*'auto'\s*\}/.test(dataSrc));

/* ---- 2/3. model + validation (static) ---- */
t('2a data.js preloads /api/config/playback with the other config (one boot)',
  /load\('\/api\/config\/playback'\)/.test(dataSrc));
t('2b data.js exposes the playback model (modes, normalizer, getter)',
  /const PLAYBACK_MODES = \['auto', 'direct', 'embed'\]/.test(dataSrc) &&
  /function normalizePlayback\(raw\)/.test(dataSrc) &&
  /function getPlaybackConfig\(\)/.test(dataSrc) &&
  /PLAYBACK_MODES,\s*\n?\s*PLAYBACK_DEFAULT,\s*\n?\s*normalizePlayback,\s*\n?\s*getPlaybackConfig,/.test(dataSrc));
t('2c stable mode-key identity with auto default (never throws)',
  /PLAYBACK_MODES\.indexOf\(m\) >= 0/.test(dataSrc) &&
  /malformed config renders as the default auto resolver/.test(dataSrc));
t('2d exactly three supported modes (no competing system)',
  MODES.every((m) => validateSrc.includes("'" + m + "'")) &&
  /PLAYBACK_MODES = \['auto', 'direct', 'embed'\]/.test(validateSrc) &&
  /PLAYBACK_MODES = \['auto', 'direct', 'embed'\]/.test(streamSrc));
t('3a unknown modes rejected, missing rejected, non-object rejected',
  /mode must be one of/.test(validateSrc) && /missing playback setting/.test(validateSrc) &&
  /body must be a JSON object/.test(validateSrc));
t('3b unknown keys rejected (strict full-replace, no silent repair)',
  /unknown playback setting/.test(validateSrc));
t('3c non-string/invalid types rejected',
  /String\(body\.mode/.test(validateSrc));
t('3d admin route validates the full body on PUT (400 on bad input)',
  /validatePlaybackBody\(body\)/.test(adminRoute) && /writeSetting\(db, KEY/.test(adminRoute));

/* ---- 6. admin authentication (static) ---- */
t('6a admin route gates requireAdmin() before touching D1',
  adminRoute.indexOf('requireAdmin(request, env)') >= 0 &&
  adminRoute.indexOf('requireAdmin(request, env)') < adminRoute.indexOf('getDb(env)'));
t('6b admin route never leaks stacks/SQL/secrets (adminError envelope)',
  /adminError\(e,/.test(adminRoute) && !/\.stack|GREYBOX_ADMIN_TOKEN/.test(adminRoute));
t('6c PUT parses body only after auth (no unauthenticated body work)',
  adminRoute.indexOf('readJsonBody(request)') > adminRoute.indexOf('requireAdmin(request, env)'));
t('6d no new auth system (shared requireAdmin only)',
  !/jsonwebtoken|bcrypt|session|cookie|password/i.test(adminRoute));
t('6e admin token still memory-only (no persistence added)',
  !/localStorage\.(setItem|getItem)|sessionStorage\.(setItem|getItem)|document\.cookie\s*=/.test(adminSrc));

/* ---- 7/8. public shape + fallback (static) ---- */
t('7a public /api/config/playback route exists', fs.existsSync(path.join(ROOT, 'functions/api/config/playback.js')));
t('7b public route serves shaped mode via readPlayback',
  /readPlayback\(db\)/.test(publicRoute) && /readPlayback\(db\)/.test(dbSrc));
t('7c public route is open GET with short cache (~60s propagation)',
  !/requireAdmin/.test(publicRoute) && /request\.method !== 'GET'/.test(publicRoute) && /max-age=60/.test(publicRoute));
t('7d db reads one settings row (no new table, no duplicate config)',
  /readSetting\(db, 'playback'\)/.test(dbSrc) &&
  !/CREATE TABLE.*playback|playback_items|playback_sections/.test(dbSrc));
t('8a public route 503s without D1 (frontend keeps the local fallback)',
  /is not configured/.test(publicRoute));
t('8b fallback path: data.js uses window.GreyboxPlayback when D1 null',
  /window\.GreyboxPlayback/.test(dataSrc));

/* ---- 9-12. resolver behavior (static) ---- */
t('9a stream.js has the single canonical mode system (no competitor)',
  /PLAYBACK_MODES/.test(streamSrc) && /getPlaybackMode/.test(streamSrc) &&
  /setPlaybackMode/.test(streamSrc) && /syncPlaybackMode/.test(streamSrc) &&
  !/playbackMode2|altMode|playback_mode_v2/i.test(streamSrc));
t('9b resolver entry points honor the mode (catalog movie/episode + generic)',
  /function resolveCatalogMovie\(/.test(streamSrc) &&
  /function resolveCatalogEpisode\(/.test(streamSrc) &&
  /function resolvePlayback\(opts\)/.test(streamSrc));
t('9c callers route catalog through the mode-aware resolver (not raw URLs)',
  /resolveCatalogMovie/.test(appSrc) && /resolveCatalogEpisode/.test(appSrc));
t('10a direct mode fails cleanly with no iframe (clean error, no URL)',
  /DIRECT_UNAVAILABLE_ERROR/.test(streamSrc) &&
  /mode === 'direct'/.test(streamSrc) &&
  /ok: false, url: null, mode: 'direct'/.test(streamSrc));
t('10b direct catalog availability is honestly false (no fabricated source)',
  /function isDirectCatalogAvailable\(\)/.test(streamSrc) &&
  /return false/.test(streamSrc.split('function isDirectCatalogAvailable')[1].slice(0, 400)));
t('11a embed mode remains functional (configured URL → iframe bucket)',
  /getMovieUrl\(tmdbId\)/.test(streamSrc) && /getEpisodeUrl\(tmdbId/.test(streamSrc) &&
  /mode: 'embed'/.test(streamSrc));
t('12a auto mode preserves resolver behavior (same embed URLs, same priority)',
  /resolveCatalogMovie/.test(streamSrc) && /getMovieUrl/.test(streamSrc) &&
  /EMBED\.base/.test(streamSrc) && !/auto.*scrap|auto.*extract/i.test(streamSrc));
t('12b auto is the default everywhere (fallback, sanitizer, stream)',
  /mode:\s*'auto'/.test(fallbackSrc) && /return \{ mode: 'auto' \}/.test(dataSrc) &&
  /PLAYBACK_DEFAULT_MODE = 'auto'/.test(streamSrc));

/* ---- 13. player settings actually implemented ---- */
t('13a V1 exposes mode only (no wall of switches)',
  !/autoplay.*playback|playback.*autoplay/i.test(validateSrc) &&
  !/validatePlaybackBody[\s\S]{0,600}autoplay/.test(validateSrc) &&
  /V1 exposes exactly ONE setting/.test(validateSrc));
t('13b player internals untouched (HLS/Plyr/cleanup/stale guards preserved)',
  /MANIFEST_PARSED/.test(playerSrc) && /pickQualityOptions/.test(playerSrc) &&
  /openSeq\+\+/.test(playerSrc) && /teardown\(/.test(playerSrc) &&
  /playerGen\+\+/.test(streamSrc));
t('13c no invented quality/caption/resume settings in the playback model',
  !/quality|subtitle|caption|resume|autoplay/i.test(migration) &&
  !/quality|resume/i.test(fallbackSrc));

/* ---- 14. test source ---- */
t('14a ?play-test=1 mechanism preserved (same file, same contract)',
  /wantsTestPlayback/.test(testSrc) && /play-test/.test(testSrc) &&
  /TEST_HLS_URL/.test(testSrc) && /Stream\.Player\.open/.test(testSrc));
t('14b test manifest is still the legitimate public HLS stream (no swap)',
  /test-streams\.mux\.dev\/x36xhzz\/x36xhzz\.m3u8/.test(testSrc));
t('14c test file not used for normal playback (dev-only auto-open only)',
  /wantsTestPlayback\(\) && window\.Stream/.test(testSrc) &&
  !/getMovieUrl|getEpisodeUrl/.test(testSrc));
t('14d Admin exposes a clearly marked Playback Test action (new tab)',
  /\?play-test=1/.test(adminSrc) && /Open playback test/.test(adminSrc));

/* ---- 15/16. security ---- */
t('15a no secret leakage in new surfaces',
  !/GREYBOX_ADMIN_TOKEN|TMDB_READ_TOKEN|TMDB_API_KEY|eyJ/i.test(migration) &&
  !/GREYBOX_ADMIN_TOKEN/.test(fallbackSrc) &&
  !/GREYBOX_ADMIN_TOKEN/.test(adminRoute) &&
  !/GREYBOX_ADMIN_TOKEN|TMDB_READ_TOKEN/.test(publicRoute) &&
  !/Bearer\s+[A-Za-z0-9]|document\.cookie|localStorage|sessionStorage/i.test(publicRoute) &&
  !/localStorage|sessionStorage/.test(adminRoute));
t('15b status diagnostics are non-sensitive (hostname only, no full URLs)',
  /embedHost/.test(streamSrc) && /\.hostname/.test(streamSrc) &&
  !/getSourceStatus[\s\S]{0,800}Authorization|getSourceStatus[\s\S]{0,800}cookie/i.test(streamSrc));
t('16a no provider extraction logic added anywhere',
  !/extract hidden|hidden HLS|consumet/i.test(streamSrc) &&
  !/fetch\s*\(\s*['"`][^'"`]*embed|XMLHttpRequest.*embed|loadSource\s*\(\s*embed/i.test(streamSrc) &&
  !/scrape\s*\(|extractUrl|extractStream|resolveStreamUrl/i.test(streamSrc) &&
  !/scrape|consumet/i.test(validateSrc) &&
  !/scrape|consumet|extract hidden/i.test(adminSrc));
t('16b resolver never converts embed URLs into media URLs',
  /never converts an[\s\S]{0,40}embed URL into a media URL/.test(streamSrc) ||
  /never convert/i.test(streamSrc));

/* ---- admin workspace shell (static) ---- */
t('A1 sidebar Playback is a live view (Soon removed only here)',
  /data-view="playback"/.test(adminHtml) && !/data-soon="Playback"/.test(adminHtml));
t('A2 Playback promoted; unrelated Soon entries untouched',
  /data-view="playback"/.test(adminHtml) && !/data-soon="Playback"/.test(adminHtml) &&
  /data-soon="Activity"/.test(adminHtml) &&
  /data-soon="Branding"/.test(adminHtml) && /data-soon="Theme"/.test(adminHtml) &&
  /data-soon="SEO \/ Metadata"/.test(adminHtml));
t('A3 workspace section: header copy + mode/status/player/test/notes hosts',
  /id="view-playback"/.test(adminHtml) && /id="pb-save"/.test(adminHtml) &&
  /id="pb-discard"/.test(adminHtml) && /id="pb-reset"/.test(adminHtml) &&
  /id="pb-refresh"/.test(adminHtml) && /id="pb-mode"/.test(adminHtml) &&
  /id="pb-status"/.test(adminHtml) && /id="pb-dirty"/.test(adminHtml) &&
  /Unsaved changes/.test(adminHtml) &&
  /Control how Greybox resolves and presents supported playback sources/.test(adminHtml));
t('A4 admin logic: staged draft (load/render/save/discard/reset + validation)',
  /function loadPlayback\(\)/.test(adminSrc) && /function renderPlayback\(\)/.test(adminSrc) &&
  /function savePlayback\(\)/.test(adminSrc) && /function discardPlayback\(\)/.test(adminSrc) &&
  /function resetPlayback\(\)/.test(adminSrc) && /function pbValidateDraft\(draft\)/.test(adminSrc) &&
  /playback: \{ title: 'Playback'/.test(adminSrc) && /playback: '\/api\/admin\/settings\/playback'/.test(adminSrc));
t('A5 mode cards explain each real mode concisely (no invented promises)',
  /PB_MODES/.test(adminSrc) && /normal Greybox resolver strategy/.test(adminSrc) &&
  /no direct production source is configured/.test(adminSrc) &&
  /configured embed source/.test(adminSrc));
t('A6 source status states direct honestly (not configured)',
  /Direct source: Not configured/.test(adminSrc));
t('A7 reset is confirm-guarded (destructive to draft until saved)',
  /title: 'Reset playback\?/.test(adminSrc));
t('A8 stale-request guards + read-back verification + retry states',
  /pbGen\+\+/.test(adminSrc) && /myGen !== pbGen/.test(adminSrc) &&
  /read-back differs/.test(adminSrc) && /Playback failed to load/.test(adminSrc) &&
  /stateBox\(host, '(loading|error)'/.test(adminSrc));

/* ---- 17/18/19. interactions ---- */
t('17a blocked filtering still upstream (data.js guards untouched)',
  /isBlockedContent\('movie', clean\)/.test(dataSrc) && /isBlockedContent\('tv', clean\)/.test(dataSrc) &&
  /blockedError/.test(dataSrc));
t('17b playback never bypasses blocked (no block logic duplicated in resolver)',
  !/isBlockedContent|isBlockedItem|blocked_titles/.test(streamSrc) &&
  /Blocked\/detail filtering stays upstream/.test(streamSrc));
t('18a Detail Pages still independent (flags + applier untouched)',
  /function getDetailPagesConfig\(\)/.test(dataSrc) && /getDetailPagesConfig/.test(read('js/detail-pages.js')));
t('18b playback order documented (blocked -> detail -> playback)',
  /blocked filtering/i.test(adminSrc) && /detail presentation/i.test(adminSrc) &&
  /then playback/i.test(adminSrc));
t('19a hero trailer untouched (4s activation, layers, ambient, fade)',
  /TRAILER_DELAY_MS = 4000/.test(heroSrc) && /delaySec: 4/.test(heroSrc) &&
  /hero-ambient/.test(heroSrc) && /page-ambient/.test(heroSrc) &&
  /is-visible/.test(heroSrc));
t('19b hero Watch follows mode; trailer path has no mode branch',
  /resolveCatalogMovie/.test(heroSrc) && /defaultWatch/.test(heroSrc) &&
  !/getPlaybackConfig|PLAYBACK_MODES/.test(heroSrc.split('function resolveTrailerKey')[1] || ''));

/* ---- no duplicate system, no regressions ---- */
t('R1 no duplicate playback system (one row, one reader, one workspace)',
  (validateSrc.match(/PLAYBACK_MODES/g) || []).length <= 4 &&
  (dataSrc.match(/PLAYBACK_MODES/g) || []).length <= 4 &&
  !fs.existsSync(path.join(ROOT, 'functions/api/admin/settings/playbacks.js')) &&
  !fs.existsSync(path.join(ROOT, 'functions/api/config/playbacks.js')) &&
  !fs.existsSync(path.join(ROOT, 'js/playback.js')));
t('R2 router + TMDB + stream-provider surface untouched',
  (() => {
    try {
      const out = execSync('git diff --name-only && git ls-files --others --exclude-standard', { cwd: ROOT, stdio: 'pipe' }).toString();
      return !/js\/router\.js/.test(out) &&
        !/lib\/greybox\.js|functions\/api\/movie|functions\/api\/tv/.test(out) &&
        !/0001_schema|0002_seed|0003_tags|0004_blocked|0005_navigation|0006_detail/.test(out);
    } catch { return false; }
  })());
t('R3 playback-scoped diff only (no Blocked/Nav/Detail/Dashboard/collection/tag/override edits)',
  (() => {
    try {
      const out = execSync('git diff --name-only && git ls-files --others --exclude-standard', { cwd: ROOT, stdio: 'pipe' }).toString();
      const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const banned = [/blocked/i, /navigation\.js/, /navigation\.config\.js/, /detail-pages\.js/, /detail-pages\.config\.js/, /collections-nav/, /tags\.config/, /overrides\.config/, /homepage\.config/, /collections\.config/];
      return !lines.some((l) => banned.some((re) => re.test(l)));
    } catch { return false; }
  })());
t('R4 changed JS parses (node --check)',
  (() => {
    try {
      for (const f of ['js/data.js', 'js/stream.js', 'js/playback.config.js', 'js/admin.js', 'js/app.js', 'js/hero.js',
        'functions/lib/validate.js', 'functions/lib/db.js',
        'functions/api/config/playback.js', 'functions/api/admin/settings/playback.js']) {
        execSync('node --check ' + JSON.stringify(f), { cwd: ROOT, stdio: 'pipe' });
      }
      return true;
    } catch (e) { return false; }
  })());
t('R5 token never in responses/D1/URLs (new routes)',
  !/GREYBOX_ADMIN_TOKEN/.test(dbSrc.replace(/GREYBOX_ADMIN_TOKEN.*secret.*/i, '')) &&
  !/GREYBOX_ADMIN_TOKEN/.test(validateSrc) &&
  !/GREYBOX_ADMIN_TOKEN/.test(fallbackSrc + migration));

/* ---- live behavioral checks: validate.js + db.js (real ESM imports) ---- */
async function esmTests() {
  let V = null, DB = null;
  try { V = await import('../functions/lib/validate.js'); } catch (e) { V = null; }
  try { DB = await import('../functions/lib/db.js'); } catch (e) { DB = null; }
  t('E1 validate.js loads as ESM', !!V);
  t('E2 db.js loads as ESM', !!DB);

  if (V) {
    const ok = (fn) => { try { fn(); return true; } catch { return false; } };
    let clean = null;
    try { clean = V.validatePlaybackBody({ mode: 'direct' }); } catch { clean = null; }
    t('E3 (2,5) each supported mode validates with exact shape',
      !!clean && clean.mode === 'direct' && Object.keys(clean).join(',') === 'mode' &&
      V.validatePlaybackBody({ mode: 'auto' }).mode === 'auto' &&
      V.validatePlaybackBody({ mode: 'embed' }).mode === 'embed' &&
      V.validatePlaybackBody({ mode: 'DIRECT' }).mode === 'direct');
    t('E4 (3) unknown modes rejected',
      !ok(() => V.validatePlaybackBody({ mode: 'hls' })) &&
      !ok(() => V.validatePlaybackBody({ mode: 'youtube' })) &&
      !ok(() => V.validatePlaybackBody({ mode: '' })) &&
      !ok(() => V.validatePlaybackBody({ mode: null })) &&
      !ok(() => V.validatePlaybackBody({ mode: 1 })));
    t('E5 (3) malformed structure rejected (missing, extra keys, non-object)',
      !ok(() => V.validatePlaybackBody({})) &&
      !ok(() => V.validatePlaybackBody({ mode: 'auto', extra: 1 })) &&
      !ok(() => V.validatePlaybackBody(null)) &&
      !ok(() => V.validatePlaybackBody([])) &&
      !ok(() => V.validatePlaybackBody('auto')) &&
      !ok(() => V.validatePlaybackBody({ mode: 'auto', Mode: 'auto' })));
    let s1 = null, threw = false;
    try { s1 = V.sanitizePlayback({ mode: 'DIRECT' }); } catch { threw = true; }
    t('E6 sanitizer is lenient (case-insensitive, unknown dropped to auto)',
      !threw && !!s1 && s1.mode === 'direct' &&
      V.sanitizePlayback({ mode: 'bogus' }).mode === 'auto' &&
      V.sanitizePlayback(null).mode === 'auto' &&
      V.sanitizePlayback({}).mode === 'auto' &&
      Object.keys(V.sanitizePlayback({ mode: 'embed', extra: 1 })).join(',') === 'mode');
    let s2 = null;
    try { s2 = V.sanitizePlayback(undefined); } catch { s2 = null; }
    t('E7 sanitizer falls back to auto on garbage (never throws)',
      !!s2 && s2.mode === 'auto');
  }

  /* ---- fake-D1 behavioral checks (settings-row model) ---- */
  function fakeDb(seed) {
    const settings = new Map(Object.entries(seed || {}));
    return {
      prepare(sql) {
        const norm = String(sql).replace(/\s+/g, ' ').trim();
        const st = {
          _p: [],
          bind(...p) { st._p = p; return st; },
          async first() {
            if (/FROM settings WHERE key = \?/.test(norm)) {
              const v = settings.get(st._p[0]);
              return v === undefined ? null : { value_json: v };
            }
            return null;
          },
          async all() { return { results: [] }; },
          async run() {
            if (/INSERT INTO settings/.test(norm)) {
              settings.set(st._p[0], st._p[1]);
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
        };
        return st;
      },
    };
  }

  if (DB) {
    const db = fakeDb();
    const dflt = await DB.readPlayback(db);
    t('E8 (1) empty settings row reads as auto default',
      !!dflt && dflt.mode === 'auto' && Object.keys(dflt).join(',') === 'mode');
    const { writeSetting } = DB;
    await writeSetting(db, 'playback', { mode: 'embed' });
    const back = await DB.readPlayback(db);
    t('E9 (5) saved mode round-trips (staged value kept server-side)',
      back.mode === 'embed');
    const db2 = fakeDb({ playback: '{"mode":"bogus"}' });
    const corrupt = await DB.readPlayback(db2);
    t('E10 corrupt row sanitizes to auto (public never breaks)',
      !!corrupt && corrupt.mode === 'auto');
  }

  /* ---- route-level checks (real handlers, fake D1, real Request/Response) ---- */
  let adminMod = null, publicMod = null;
  try { adminMod = await import('../functions/api/admin/settings/playback.js'); } catch (e) { adminMod = null; }
  try { publicMod = await import('../functions/api/config/playback.js'); } catch (e) { publicMod = null; }
  t('E11 route modules load', !!adminMod && !!publicMod);

  if (adminMod && publicMod) {
    const db = fakeDb({ playback: JSON.stringify({ mode: 'auto' }) });
    const goodEnv = { DB: db, GREYBOX_ADMIN_TOKEN: 'test-token' };
    const req = (url, init) => new Request(url, init);
    const auth = { Authorization: 'Bearer test-token' };

    let r = await adminMod.onRequest({ request: req('http://x/api/admin/settings/playback', { headers: auth }), env: goodEnv });
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    t('E12 (4) Admin GET returns the stored mode', r.status === 200 && !!j && j.mode === 'auto');

    r = await adminMod.onRequest({ request: req('http://x/api/admin/settings/playback', { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'embed' }) }), env: goodEnv });
    try { j = await r.json(); } catch { j = null; }
    t('E13 (5) Admin PUT persists + returns shaped mode', r.status === 200 && !!j && j.mode === 'embed');
    r = await adminMod.onRequest({ request: req('http://x/api/admin/settings/playback', { headers: auth }), env: goodEnv });
    try { j = await r.json(); } catch { j = null; }
    t('E14 (5) Admin GET after PUT reads back the saved mode', r.status === 200 && !!j && j.mode === 'embed');

    r = await adminMod.onRequest({ request: req('http://x/api/admin/settings/playback', { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'hls' }) }), env: goodEnv });
    t('E15 (3) Admin PUT rejects unknown modes (400, stored value untouched)',
      r.status === 400 && (await DB.readPlayback(db)).mode === 'embed');
    r = await adminMod.onRequest({ request: req('http://x/api/admin/settings/playback', { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'auto', extra: true }) }), env: goodEnv });
    t('E16 (3) Admin PUT rejects unexpected keys (400)', r.status === 400);

    r = await adminMod.onRequest({ request: req('http://x/api/admin/settings/playback'), env: goodEnv });
    t('E17 (6) Admin GET without credentials is 401 (fail-closed)', r.status === 401);
    r = await adminMod.onRequest({ request: req('http://x/api/admin/settings/playback', { headers: { Authorization: 'Bearer wrong' } }), env: goodEnv });
    t('E18 (6) Admin GET with wrong token is 403', r.status === 403);
    r = await adminMod.onRequest({ request: req('http://x/api/admin/settings/playback', { headers: auth }), env: { DB: db } });
    t('E19 (6) Admin GET with unconfigured server is 401 (fail-closed)', r.status === 401);

    r = await publicMod.onRequest({ request: req('http://x/api/config/playback'), env: goodEnv });
    try { j = await r.json(); } catch { j = null; }
    t('E20 (7) Public GET returns the stored mode with short cache',
      r.status === 200 && !!j && j.mode === 'embed' &&
      String(r.headers.get('Cache-Control') || '').includes('max-age=60'));
    r = await publicMod.onRequest({ request: req('http://x/api/config/playback'), env: { DB: null } });
    t('E21 (8) Public GET without D1 is 503 (frontend uses fallback, stays usable)', r.status === 503);
    const dbBad = fakeDb({ playback: '{"mode":"bogus"}' });
    r = await publicMod.onRequest({ request: req('http://x/api/config/playback'), env: { DB: dbBad, GREYBOX_ADMIN_TOKEN: 'test-token' } });
    try { j = await r.json(); } catch { j = null; }
    t('E22 (8) Public corrupt row sanitizes to auto', r.status === 200 && !!j && j.mode === 'auto');
    const dbNoAuth = fakeDb({ playback: JSON.stringify({ mode: 'direct' }) });
    r = await publicMod.onRequest({ request: req('http://x/api/config/playback'), env: { DB: dbNoAuth } });
    try { j = await r.json(); } catch { j = null; }
    t('E23 (7,15) Public GET needs no auth and leaks no secrets',
      r.status === 200 && !!j && j.mode === 'direct' &&
      !JSON.stringify(j).includes('test-token') && !/token|secret|cookie|auth/i.test(JSON.stringify(j)));
  }

  /* ---- resolver behavioral checks (real stream.js + data.js in vm) ---- */
  try {
    const sandbox = { window: {}, module: {}, console };
    sandbox.window = {};
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(streamSrc + '\nthis.__Stream = (typeof Stream !== "undefined" ? Stream : (typeof window !== "undefined" && window.Stream));', sandbox);
    const Stream = sandbox.__Stream || sandbox.window.Stream;
    t('E24 stream.js loads with the playback surface', !!Stream && typeof Stream.resolvePlayback === 'function');

    if (Stream) {
      Stream.setPlaybackMode('auto');
      const m1 = Stream.resolveCatalogMovie(550);
      t('E25 (12) auto preserves resolver behavior (embed URL, ok)',
        !!m1 && m1.ok === true && typeof m1.url === 'string' && m1.url.includes('/embed/movie/550') && m1.mode === 'embed');
      const e1 = Stream.resolveCatalogEpisode(1399, 1, 1);
      t('E26 (11) embed-equivalent auto path for episodes',
        !!e1 && e1.ok === true && typeof e1.url === 'string' && e1.url.includes('/embed/tv/1399/1/1'));

      Stream.setPlaybackMode('embed');
      const m2 = Stream.resolveCatalogMovie(550);
      t('E27 (11) embed mode remains functional (same embed URL)',
        !!m2 && m2.ok === true && typeof m2.url === 'string' && m2.url.includes('/embed/movie/550'));

      Stream.setPlaybackMode('direct');
      const m3 = Stream.resolveCatalogMovie(550);
      t('E28 (10) direct mode fails cleanly with no URL and no iframe target',
        !!m3 && m3.ok === false && m3.url === null && typeof m3.error === 'string' && m3.error.length > 10);
      const e3 = Stream.resolveCatalogEpisode(1399, 2, 3);
      t('E29 (10) direct episode fails cleanly too',
        !!e3 && e3.ok === false && e3.url === null);
      t('E30 direct failure states no direct source (honest, no fabrication)',
        /no direct/i.test(m3.error || ''));
      t('E31 (9) generic resolvePlayback dispatches by kind',
        Stream.resolvePlayback({ kind: 'movie', tmdbId: 550 }).ok === false &&
        Stream.resolvePlayback({ kind: 'episode', tmdbId: 1399, season: 1, episode: 1 }).ok === false);

      Stream.setPlaybackMode('auto');
      t('E32 (9) resolver receives configured mode (setter round-trips)',
        Stream.getPlaybackMode() === 'auto' && (Stream.setPlaybackMode('embed'), Stream.getPlaybackMode() === 'embed') &&
        (Stream.setPlaybackMode('auto'), true));
      t('E33 setter rejects unknown modes (returns false, keeps current)',
        Stream.setPlaybackMode('hls') === false && Stream.getPlaybackMode() === 'auto');
      const st = Stream.getSourceStatus();
      t('E34 status is non-sensitive (mode + booleans + hostname only)',
        !!st && st.mode === 'auto' && typeof st.embedConfigured === 'boolean' &&
        typeof st.directAvailable === 'boolean' && st.directAvailable === false &&
        !JSON.stringify(st).includes('token') && !/Bearer|cookie/i.test(JSON.stringify(st)));
      t('E35 legacy getters untouched (same hosts, same URL shapes)',
        typeof Stream.getMovieUrl(550) === 'string' && Stream.getMovieUrl(550).includes('/embed/movie/550') &&
        typeof Stream.getEpisodeUrl(1399, 1, 1) === 'string');
    }
  } catch (e) {
    t('E24 stream.js loads with the playback surface', false, String((e && e.message) || e));
  }

  /* ---- data.js behavioral checks (normalize + fallback) ---- */
  try {
    const dsandbox = { window: {}, module: { exports: {} }, localStorage: { getItem: () => null, setItem: () => {} }, fetch: () => Promise.reject(new Error('offline')), AbortController: function () { this.signal = {}; this.abort = () => {}; }, setTimeout, clearTimeout, console };
    dsandbox.window = {};
    // Minimal API stub so data.js IIFE does not throw at load.
    dsandbox.window.API = { gb: {}, getRegion: () => 'US' };
    vm.createContext(dsandbox);
    // data.js expects window.API at call time, not load time — load it, then drive pure helpers.
    vm.runInContext(dataSrc + '\nthis.__Data = (typeof GreyboxData !== "undefined" ? GreyboxData : (typeof window !== "undefined" && window.GreyboxData));', dsandbox);
    const Data = dsandbox.__Data || (dsandbox.window && dsandbox.window.GreyboxData);
    t('E36 data.js loads with the playback getters', !!Data && typeof Data.getPlaybackConfig === 'function');
    if (Data) {
      t('E37 (1,8) fallback reads auto when nothing configured',
        Data.normalizePlayback(null).mode === 'auto' && Data.normalizePlayback({}).mode === 'auto' &&
        Data.normalizePlayback({ mode: 'bogus' }).mode === 'auto');
      t('E38 modes normalize case-insensitively',
        Data.normalizePlayback({ mode: 'DIRECT' }).mode === 'direct' &&
        Data.normalizePlayback({ mode: ' Embed ' }).mode === 'embed');
      t('E39 (17,18) blocked + detail getters still present (interactions intact)',
        typeof Data.isBlockedContent === 'function' && typeof Data.getDetailPagesConfig === 'function' &&
        typeof Data.getNavigationConfig === 'function');
    }
  } catch (e) {
    t('E36 data.js loads with the playback getters', false, String((e && e.message) || e));
  }
}

esmTests().then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('Harness error:', (e && e.stack) || e);
  process.exit(1);
});
