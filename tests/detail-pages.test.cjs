/* Greybox Detail Pages V1 — focused tests (configurable detail presentation).
 * Run: node tests/detail-pages.test.cjs   (exit 0 = all pass)
 * No dependencies, no browser, no network.
 *
 * Covers the increment checklist:
 *  1. default detail configuration
 *  2. GET admin configuration
 *  3. PUT admin configuration
 *  4. Admin authentication
 *  5. invalid configuration rejection
 *  6. public configuration shape
 *  7. public fallback behavior
 *  8. movie detail integration
 *  9. TV detail integration
 * 10. episode visibility
 * 11. cast visibility
 * 12. recommendation visibility (none exists — must stay uninvented)
 * 13. action visibility
 * 14. blocked title still rejected
 * 15. unblocked detail unaffected
 * 16. reset/default behavior
 * 17. stale save/load protection where applicable
 * plus: migration safety, no duplicate renderer, no token leaks, and no
 * regressions in Navigation / Blocked Titles / playback / hero / router.
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
const adminSrc = read('js/admin.js');
const adminHtml = read('admin.html');
const indexHtml = read('index.html');
const pagesSrc = read('js/pages.js');
const appSrc = read('js/app.js');
const componentsSrc = read('js/components.js');
const dpSrc = read('js/detail-pages.js');
const dpFallbackSrc = read('js/detail-pages.config.js');
const dbSrc = read('functions/lib/db.js');
const validateSrc = read('functions/lib/validate.js');
const adminRoute = read('functions/api/admin/settings/detail-pages.js');
const publicRoute = read('functions/api/config/detail-pages.js');
const migration = read('migrations/0006_detail_pages.sql');

const GROUPS = ['header', 'actions', 'content', 'tv'];
const HEADER_KEYS = ['backdrop', 'poster', 'badge', 'title', 'meta', 'rating', 'genres', 'overview'];
const ACTIONS_KEYS = ['watch', 'trailer', 'myList'];
const CONTENT_KEYS = ['providers', 'cast'];
const TV_KEYS = ['episodes', 'episodeOverview', 'episodeMeta'];

function allTrue() {
  return {
    header: Object.fromEntries(HEADER_KEYS.map((k) => [k, true])),
    actions: Object.fromEntries(ACTIONS_KEYS.map((k) => [k, true])),
    content: Object.fromEntries(CONTENT_KEYS.map((k) => [k, true])),
    tv: Object.fromEntries(TV_KEYS.map((k) => [k, true])),
  };
}

/* ---- 1. default detail configuration ---- */
t('1a migration 0006_detail_pages.sql exists (next number, no overwrite)',
  fs.existsSync(path.join(ROOT, 'migrations/0006_detail_pages.sql')) &&
  !fs.existsSync(path.join(ROOT, 'migrations/0007_detail_pages.sql')) &&
  read('migrations/0001_schema.sql').includes('home_sections') &&
  read('migrations/0002_seed.sql').includes('home_hero') &&
  read('migrations/0003_tags.sql').includes('tag_members') &&
  read('migrations/0004_blocked.sql').includes('blocked_titles') &&
  read('migrations/0005_navigation.sql').includes("'navigation'"));
t('1b migration seeds one settings row with every flag shown',
  /INSERT OR REPLACE INTO settings/.test(migration) && migration.includes("'detail_pages'") &&
  GROUPS.every((g) => migration.includes('"' + g + '"')) &&
  HEADER_KEYS.concat(ACTIONS_KEYS, CONTENT_KEYS, TV_KEYS).every((k) => migration.includes('"' + k + '":true')) &&
  !/":false/.test(migration));
t('1c migration stores flags only (no TMDB data, no secrets, no URLs)',
  !/GREYBOX_ADMIN_TOKEN|TMDB_READ_TOKEN|TMDB_API_KEY|eyJ/i.test(migration) &&
  !/poster_path|backdrop_path|http/i.test(migration));
t('1d offline fallback reproduces the current detail page (all shown)',
  fs.existsSync(path.join(ROOT, 'js/detail-pages.config.js')) &&
  /window\.GreyboxDetailPages/.test(dpFallbackSrc) &&
  GROUPS.every((g) => new RegExp(g + ': \\{').test(dpFallbackSrc)) &&
  (dpFallbackSrc.match(/: true/g) || []).length === 16 &&
  !/: false/.test(dpFallbackSrc.replace(/\/\*[\s\S]*?\*\//g, '')));
t('1e index.html wires fallback before data.js and applier after pages.js',
  indexHtml.indexOf('detail-pages.config.js') >= 0 &&
  indexHtml.indexOf('detail-pages.config.js') < indexHtml.indexOf('js/data.js') &&
  indexHtml.indexOf('js/detail-pages.js') > indexHtml.indexOf('js/pages.js'));
t('1f only elements that exist are configurable (no invented sections)',
  /m-providers-head/.test(indexHtml) && /m-cast-head/.test(indexHtml));

/* ---- 2-5. model + validation (static) ---- */
t('2a data.js preloads /api/config/detail-pages with the other config (one boot)',
  /load\('\/api\/config\/detail-pages'\)/.test(dataSrc));
t('2b data.js exposes the detail model (groups, normalizer, getter)',
  /const DETAIL_GROUPS = \{/.test(dataSrc) &&
  /function normalizeDetailPages\(raw\)/.test(dataSrc) &&
  /function getDetailPagesConfig\(\)/.test(dataSrc) &&
  /DETAIL_GROUPS,\s*\n?\s*normalizeDetailPages,\s*\n?\s*getDetailPagesConfig,/.test(dataSrc));
t('2c stable group.key identity with all-shown defaults (never throws)',
  /clean\[k\] = node\[k\] === false \? false : true/.test(dataSrc) &&
  /malformed config renders the[\s\S]{0,30}default detail page/.test(dataSrc));
t('5a unknown groups/keys rejected, missing rejected, non-boolean rejected',
  /unknown detail group/.test(validateSrc) && /unknown detail setting/.test(validateSrc) &&
  /missing detail setting/.test(validateSrc) && /reqBool\(node\[k\]/.test(validateSrc));
t('5b non-object bodies rejected (strict full-replace)',
  /body must be a JSON object/.test(validateSrc) && /must be an object/.test(validateSrc));
t('5c admin route validates the full body on PUT (400 on bad input)',
  /validateDetailPagesBody\(body\)/.test(adminRoute) && /writeSetting\(db, KEY/.test(adminRoute));

/* ---- 4. admin authentication (static) ---- */
t('4a admin route gates requireAdmin() before touching D1',
  adminRoute.indexOf('requireAdmin(request, env)') >= 0 &&
  adminRoute.indexOf('requireAdmin(request, env)') < adminRoute.indexOf('getDb(env)'));
t('4b admin route never leaks stacks/SQL/secrets (adminError envelope)',
  /adminError\(e,/.test(adminRoute) && !/\.stack|GREYBOX_ADMIN_TOKEN/.test(adminRoute));
t('4c PUT parses body only after auth (no unauthenticated body work)',
  adminRoute.indexOf('readJsonBody(request)') > adminRoute.indexOf('requireAdmin(request, env)'));
t('4d no new auth system (shared requireAdmin only)',
  !/jsonwebtoken|bcrypt|session|cookie|password/i.test(adminRoute));
t('4e admin token still memory-only (no persistence added)',
  !/localStorage\.(setItem|getItem)|sessionStorage\.(setItem|getItem)|document\.cookie\s*=/.test(adminSrc));

/* ---- 6-7. public shape + fallback (static) ---- */
t('6a public /api/config/detail-pages route exists', fs.existsSync(path.join(ROOT, 'functions/api/config/detail-pages.js')));
t('6b public route serves shaped flags via readDetailPages',
  /readDetailPages\(db\)/.test(publicRoute) && /readDetailPages\(db\)/.test(dbSrc));
t('6c public route is open GET with short cache (~60s propagation)',
  !/requireAdmin/.test(publicRoute) && /request\.method !== 'GET'/.test(publicRoute) && /max-age=60/.test(publicRoute));
t('6d db reads one settings row (no new table)',
  /readSetting\(db, 'detail_pages'\)/.test(dbSrc) &&
  !/CREATE TABLE|detail_pages_items|detail_sections/.test(dbSrc));
t('7a public route 503s without D1 (frontend keeps the local fallback)',
  /is not configured/.test(publicRoute));

/* ---- 8-13. public integration layer (static) ---- */
t('8a applier wraps the existing renderers in place (no second renderer)',
  /P\.renderTitleDetail = function/.test(dpSrc) && /orig\.apply\(this, arguments\)/.test(dpSrc) &&
  !/innerHTML\s*=\s*['"`<]|cardsHTML|exploreAllHTML/.test(dpSrc));
t('8b applier reads the public config (never admin endpoints, no token, no fetch)',
  /getDetailPagesConfig/.test(dpSrc) && !/api\/admin|Authorization|Bearer|fetch\(/.test(dpSrc));
t('8c movie shell sections applied (backdrop/poster/badge/title/meta/overview)',
  /m-backdrop/.test(dpSrc) && /m-poster/.test(dpSrc) && /m-badge/.test(dpSrc) &&
  /m-title/.test(dpSrc) && /m-meta/.test(dpSrc) && /m-overview/.test(dpSrc));
t('8d meta segments filtered by shape (rating/genres), whole line hideable',
  /filterMetaText/.test(dpSrc) && /header', 'rating/.test(dpSrc) && /header', 'genres/.test(dpSrc) &&
  /header', 'meta/.test(dpSrc));
t('9a TV section gated (seasons re-hidden, episodes pre-sanitized as copies)',
  /P\.renderSeasons = function/.test(dpSrc) && /P\.renderEpisodes = function/.test(dpSrc) &&
  /episodesCtx/.test(dpSrc) && /m-tv-wrap/.test(dpSrc));
t('10a episode overview/meta stripped, resume + callbacks preserved',
  /episodeOverview/.test(dpSrc) && /episodeMeta/.test(dpSrc) && /o\.overview = ''/.test(dpSrc) &&
  /air_date/.test(dpSrc) && /Object\.assign\(\{\}, ctx/.test(dpSrc));
t('11a cast + providers hide with their headings',
  /m-cast/.test(dpSrc) && /m-cast-head/.test(dpSrc) &&
  /m-providers/.test(dpSrc) && /m-providers-head/.test(dpSrc));
t('12a no recommendations concept anywhere (not invented)',
  !/recomm|similar|related/i.test(dpSrc) && !/recomm/i.test(validateSrc.replace(/recommendation engine|recommendations\/original-title\/logo/i, '')) &&
  !/renderRecommendations|m-recomm/.test(pagesSrc + appSrc + indexHtml));
t('13a action buttons toggled (watch/trailer/myList), wiring untouched',
  /m-watch/.test(dpSrc) && /m-trailer/.test(dpSrc) && /m-list/.test(dpSrc) &&
  !/\.onclick\s*=|playMovie|playEpisode|toggleMyListItem/.test(dpSrc));
t('14a blocked path intact: guards stay in data.js, applier sees allowed titles only',
  /isBlockedContent\('movie', clean\)/.test(dataSrc) && /isBlockedContent\('tv', clean\)/.test(dataSrc) &&
  /blockedError/.test(dataSrc) && /showDetailError/.test(appSrc) &&
  !/showDetailError\(|showPersonError\(/.test(dpSrc) &&
  /only ever sees[\s\S]{0,40}resolved,[\s\S]{0,20}allowed titles/.test(dpSrc));
t('14b person view immune (always full), error state never wrapped',
  /P\.renderPerson = function/.test(dpSrc) && /resetPersonShell/.test(dpSrc));

/* ---- admin workspace shell (static) ---- */
t('A1 sidebar Detail Pages is a live view (Soon removed only here)',
  /data-view="detail"/.test(adminHtml) && !/data-soon="Detail Pages"/.test(adminHtml));
t('A2 Detail Pages promoted; unrelated Soon entries untouched',
  /data-view="detail"/.test(adminHtml) && !/data-soon="Detail Pages"/.test(adminHtml) &&
  /data-soon="Activity"/.test(adminHtml) && /data-soon="Playback"/.test(adminHtml) &&
  /data-soon="Branding"/.test(adminHtml) && /data-soon="Theme"/.test(adminHtml) &&
  /data-soon="SEO \/ Metadata"/.test(adminHtml));
t('A3 workspace section: actions, groups host, dirty flag, header copy',
  /id="view-detail"/.test(adminHtml) && /id="dp-save"/.test(adminHtml) &&
  /id="dp-discard"/.test(adminHtml) && /id="dp-reset"/.test(adminHtml) &&
  /id="dp-refresh"/.test(adminHtml) && /id="dp-groups"/.test(adminHtml) &&
  /id="dp-dirty"/.test(adminHtml) && /Unsaved changes/.test(adminHtml) &&
  /Control the sections and actions displayed on movie and TV detail pages/.test(adminHtml));
t('A4 admin logic: staged draft (load/render/save/discard/reset + validation)',
  /function loadDetailPages\(\)/.test(adminSrc) && /function renderDetailPages\(\)/.test(adminSrc) &&
  /function saveDetailPages\(\)/.test(adminSrc) && /function discardDetailPages\(\)/.test(adminSrc) &&
  /function resetDetailPages\(\)/.test(adminSrc) && /function dpValidateDraft\(draft\)/.test(adminSrc) &&
  /detail: \{ title: 'Detail Pages'/.test(adminSrc) && /detailPages: '\/api\/admin\/settings\/detail-pages'/.test(adminSrc));
t('A5 grouped toggles with labels + descriptions + state (no raw JSON)',
  /DP_GROUPS/.test(adminSrc) && /TV \/ Episodes/.test(adminSrc) &&
  /Episode overviews/.test(adminSrc) && /statusBadge\(\{ visible: on \}\)/.test(adminSrc) &&
  !/JSON\.stringify\(dpDraft\)/.test(adminSrc));
t('A6 reset is confirm-guarded (destructive to draft until saved)',
  /confirmDialog\(\{\s*\n?\s*title: 'Reset detail pages\?/.test(adminSrc));
t('A7 no fake preview renderer (editor is the source of truth)',
  !/dpPreview|renderDpPreview|previewDetail/i.test(adminSrc) && /No live preview/.test(adminSrc));
t('A8 stale-request guards + read-back verification + retry states',
  /dpGen\+\+/.test(adminSrc) && /myGen !== dpGen/.test(adminSrc) &&
  /read-back differs/.test(adminSrc) && /Detail Pages failed to load/.test(adminSrc) &&
  /stateBox\(host, '(loading|error)'/.test(adminSrc));

/* ---- no duplicate system, no leaks, no regressions ---- */
t('R1 no duplicate settings system (one row, one reader, one workspace)',
  (validateSrc.match(/DETAIL_GROUPS/g) || []).length <= 8 &&
  (dataSrc.match(/DETAIL_GROUPS/g) || []).length <= 6 &&
  !fs.existsSync(path.join(ROOT, 'functions/api/admin/settings/details.js')) &&
  !fs.existsSync(path.join(ROOT, 'functions/api/config/details.js')) &&
  !fs.existsSync(path.join(ROOT, 'js/detail.js')));
t('R2 router untouched (no second router, no route changes)',
  (() => {
    try {
      const out = execSync('git diff --name-only && git ls-files --others --exclude-standard', { cwd: ROOT, stdio: 'pipe' }).toString();
      return !/js\/router\.js/.test(out);
    } catch { return false; }
  })());
t('R3 no playback/hero/renderer regressions in the diff',
  (() => {
    try {
      const out = execSync('git diff --name-only && git ls-files --others --exclude-standard', { cwd: ROOT, stdio: 'pipe' }).toString();
      return !/\/stream\.js|\/greybox-player\.js|\/hero\.js|player\.css|\/pages\.js|\/components\.js|\/app\.js|shelves\.js|collections-nav\.js|navbar\.css/.test(out) &&
        !/0001_schema|0002_seed|0003_tags|0004_blocked|0005_navigation/.test(out) &&
        !/lib\/greybox\.js|functions\/api\/movie|functions\/api\/tv/.test(out);
    } catch { return false; }
  })());
t('R4 navigation + blocked + dashboard logic intact',
  /function loadNavigation\(\)/.test(adminSrc) && /function loadBlocked\(\)/.test(adminSrc) &&
  /function loadDashboard\(\)/.test(adminSrc) && /function isBlockedContent\(media, id\)/.test(dataSrc) &&
  /function getVisibleNavigation\(\)/.test(dataSrc));
t('R5 changed JS parses (node --check)',
  (() => {
    try {
      for (const f of ['js/data.js', 'js/detail-pages.js', 'js/detail-pages.config.js', 'js/admin.js',
        'functions/lib/validate.js', 'functions/lib/db.js',
        'functions/api/config/detail-pages.js', 'functions/api/admin/settings/detail-pages.js']) {
        execSync('node --check ' + JSON.stringify(f), { cwd: ROOT, stdio: 'pipe' });
      }
      return true;
    } catch (e) { return false; }
  })());
t('R6 token never in responses/D1/URLs (new routes)',
  !/GREYBOX_ADMIN_TOKEN/.test(dbSrc) && !/GREYBOX_ADMIN_TOKEN/.test(validateSrc) &&
  !/localStorage|sessionStorage/.test(adminRoute + publicRoute) &&
  !/GREYBOX_ADMIN_TOKEN/.test(dpSrc + dpFallbackSrc + migration));

/* ---- live behavioral checks: validate.js + db.js (real ESM imports) ---- */
async function esmTests() {
  let V = null, DB = null;
  try { V = await import('../functions/lib/validate.js'); } catch (e) { V = null; }
  try { DB = await import('../functions/lib/db.js'); } catch (e) { DB = null; }
  t('E1 validate.js loads as ESM', !!V);
  t('E2 db.js loads as ESM', !!DB);

  const full = allTrue();
  full.header.overview = false;
  full.actions.myList = false;
  full.tv.episodes = false;

  if (V) {
    const ok = (fn) => { try { fn(); return true; } catch { return false; } };
    let clean = null;
    try { clean = V.validateDetailPagesBody(JSON.parse(JSON.stringify(full))); } catch { clean = null; }
    t('E3 (2,3) full config validates; false flags preserved with stable paths',
      !!clean && clean.header.overview === false && clean.actions.myList === false &&
      clean.tv.episodes === false && clean.header.title === true &&
      Object.keys(clean).join(',') === 'header,actions,content,tv');
    t('E4 (5) unknown groups/keys rejected',
      !ok(() => V.validateDetailPagesBody({ ...allTrue(), bogus: {} })) &&
      !ok(() => V.validateDetailPagesBody({ ...allTrue(), header: { ...allTrue().header, bogus: true } })) &&
      !ok(() => V.validateDetailPagesBody({ header: allTrue().header })));
    t('E5 (5) missing keys + non-boolean values rejected',
      !ok(() => {
        const c = allTrue(); delete c.tv.episodeMeta;
        return V.validateDetailPagesBody(c);
      }) &&
      !ok(() => {
        const c = allTrue(); c.actions.watch = 'yes';
        return V.validateDetailPagesBody(c);
      }) &&
      !ok(() => {
        const c = allTrue(); c.content.cast = 0;
        return V.validateDetailPagesBody(c);
      }) &&
      !ok(() => V.validateDetailPagesBody(null)) &&
      !ok(() => V.validateDetailPagesBody([])) &&
      !ok(() => V.validateDetailPagesBody('header.backdrop=false')));
    let s1 = null, threw = false;
    try {
      s1 = V.sanitizeDetailPages({ header: { backdrop: 'yes', title: false, bogus: 1 }, tv: null, extra: {} });
    } catch { threw = true; }
    t('E6 sanitizer is lenient (unknown dropped, missing/non-boolean read as shown)',
      !threw && !!s1 && s1.header.backdrop === true && s1.header.title === false &&
      !('bogus' in s1.header) && s1.tv.episodes === true && !('extra' in s1) &&
      Object.keys(s1).join(',') === 'header,actions,content,tv');
    let s2 = null;
    try { s2 = V.sanitizeDetailPages(null); } catch { s2 = null; }
    t('E7 sanitizer falls back to all-shown on garbage (never throws)',
      !!s2 && GROUPS.every((g) => Object.values(s2[g]).every((v) => v === true)));
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
    const dflt = await DB.readDetailPages(db);
    t('E8 (1) empty settings row reads as all-shown defaults',
      !!dflt && GROUPS.every((g) => dflt[g] && Object.values(dflt[g]).every((v) => v === true)));
    const { writeSetting } = DB;
    const saved = allTrue();
    saved.header.overview = false;
    saved.tv.episodes = false;
    saved.tv.episodeMeta = false;
    await writeSetting(db, 'detail_pages', saved);
    const back = await DB.readDetailPages(db);
    t('E9 (3) saved flags round-trip (hidden kept server-side)',
      back.header.overview === false && back.tv.episodes === false &&
      back.tv.episodeMeta === false && back.header.title === true &&
      back.actions.watch === true);
  }

  /* ---- route-level checks (real handlers, fake D1, real Request/Response) ---- */
  let adminMod = null, publicMod = null;
  try { adminMod = await import('../functions/api/admin/settings/detail-pages.js'); } catch (e) { adminMod = null; }
  try { publicMod = await import('../functions/api/config/detail-pages.js'); } catch (e) { publicMod = null; }
  t('E10 route modules load', !!adminMod && !!publicMod);

  if (adminMod && publicMod) {
    const db = fakeDb({ detail_pages: JSON.stringify(allTrue()) });
    const goodEnv = { DB: db, GREYBOX_ADMIN_TOKEN: 'test-token' };
    const req = (url, init) => new Request(url, init);
    const auth = { Authorization: 'Bearer test-token' };

    let r = await adminMod.onRequest({ request: req('http://x/api/admin/settings/detail-pages'), env: { DB: db } });
    t('E11 (4) missing credentials / unconfigured server fail closed (401)', r.status === 401);
    r = await adminMod.onRequest({ request: req('http://x/api/admin/settings/detail-pages'), env: goodEnv });
    t('E12 (4) anonymous GET fails closed (401, never touches D1)', r.status === 401);
    r = await adminMod.onRequest({ request: req('http://x/api/admin/settings/detail-pages', { headers: { Authorization: 'Bearer wrong' } }), env: goodEnv });
    t('E13 (4) wrong token rejected (403)', r.status === 403);
    r = await adminMod.onRequest({ request: req('http://x/api/admin/settings/detail-pages', { headers: auth }), env: goodEnv });
    const got = r.status === 200 ? await r.json() : null;
    t('E14 (2) authed GET returns all four groups, every flag true',
      r.status === 200 && !!got && GROUPS.every((g) => got[g] && Object.values(got[g]).every((v) => v === true)));
    r = await adminMod.onRequest({
      request: req('http://x/api/admin/settings/detail-pages', { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{"oops"' }),
      env: goodEnv,
    });
    t('E15 malformed JSON rejected (400, no leak)', r.status === 400);
    r = await adminMod.onRequest({
      request: req('http://x/api/admin/settings/detail-pages', {
        method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ header: allTrue().header }),
      }),
      env: goodEnv,
    });
    t('E16 (5) partial/unknown config rejected (400)', r.status === 400);
    r = await adminMod.onRequest({
      request: req('http://x/api/admin/settings/detail-pages', {
        method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...allTrue(), bogus: {} }),
      }),
      env: goodEnv,
    });
    t('E17 (5) unknown group rejected (400)', r.status === 400);

    // Hide synopsis + episodes, then verify persistence + public reflection.
    const payload = allTrue();
    payload.header.overview = false;
    payload.tv.episodes = false;
    r = await adminMod.onRequest({
      request: req('http://x/api/admin/settings/detail-pages', {
        method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }),
      env: goodEnv,
    });
    const stored = r.status === 200 ? await r.json() : null;
    t('E18 (3) save persists grouped flags',
      r.status === 200 && !!stored && stored.header.overview === false &&
      stored.tv.episodes === false && stored.header.title === true);
    r = await adminMod.onRequest({ request: req('http://x/api/admin/settings/detail-pages', { headers: auth }), env: goodEnv });
    const reread = r.status === 200 ? await r.json() : null;
    t('E19 (3) saved config reads back identically',
      !!reread && JSON.stringify(reread) === JSON.stringify(payload));

    r = await publicMod.onRequest({ request: req('http://x/api/config/detail-pages'), env: { DB: db } });
    const pub = r.status === 200 ? await r.json() : null;
    const cache = r.headers ? r.headers.get('Cache-Control') : '';
    t('E20 (6) public config reflects the save (open, short cache)',
      r.status === 200 && !!pub && pub.header.overview === false &&
      pub.tv.episodes === false && /max-age=60/.test(cache || ''));
    r = await publicMod.onRequest({ request: req('http://x/api/config/detail-pages'), env: {} });
    t('E21 (7) public 503 without D1 (frontend keeps the local fallback)', r.status === 503);
  }

  /* ---- data.js fallback behavior in a VM (no network, no DOM) ---- */
  try {
    const sandbox = { window: {}, console };
    vm.createContext(sandbox);
    vm.runInContext(dpFallbackSrc, sandbox, { filename: 'detail-pages.config.js' });
    vm.runInContext(dataSrc, sandbox, { filename: 'data.js' });
    const D = sandbox.window.GreyboxData;
    const cfg = D.getDetailPagesConfig();
    t('E22 (1,7) data.js falls back to the local file (all shown, no fetch)',
      !!cfg && GROUPS.every((g) => cfg[g] && Object.values(cfg[g]).every((v) => v === true)));
    sandbox.window.GreyboxDetailPages = { header: { overview: false }, tv: { episodes: false } };
    const cfg2 = D.getDetailPagesConfig();
    t('E23 partial fallback merges over all-shown defaults (missing read as shown)',
      cfg2.header.overview === false && cfg2.header.title === true &&
      cfg2.tv.episodes === false && cfg2.tv.episodeMeta === true &&
      cfg2.actions.watch === true);
    sandbox.window.GreyboxDetailPages = { bogus: {}, header: 'nope' };
    const cfg3 = D.getDetailPagesConfig();
    t('E24 unknown/malformed fallback never breaks (all shown)',
      GROUPS.every((g) => cfg3[g] && Object.values(cfg3[g]).every((v) => v === true)));
  } catch (e) {
    t('E22-24 data.js VM fallback checks', false, (e && e.message) || String(e));
  }

  /* ---- detail-pages.js applier behavior with a stub DOM ---- */
  try {
    const IDS = ['m-backdrop', 'm-poster', 'm-badge', 'm-title', 'm-meta', 'm-overview',
      'm-watch', 'm-trailer', 'm-list', 'm-providers', 'm-providers-head',
      'm-cast', 'm-cast-head', 'm-tv-wrap', 'm-season', 'm-episodes'];
    const els = {};
    for (const id of IDS) {
      els[id] = {
        style: { display: '' }, textContent: '', innerHTML: '',
        parentElement: null,
        classList: { add() {}, remove() {}, toggle() {} },
        querySelectorAll() { return []; },
      };
    }
    els['m-badge'].parentElement = { querySelectorAll() { return []; } };
    const tagPills = [{ style: { display: '' } }, { style: { display: '' } }];
    els['m-badge'].parentElement.querySelectorAll = () => tagPills;
    let currentCfg = allTrue();
    const P = {
      renderTitleDetail() {},
      renderSeasons() { els['m-tv-wrap'].classList.remove('hidden'); return 1; },
      renderEpisodes() {},
      renderPerson() {},
    };
    // Rebind classList.remove on the tv wrap so the stub tracks visibility.
    let tvWrapHidden = true;
    els['m-tv-wrap'].classList.remove = () => { tvWrapHidden = false; };
    els['m-tv-wrap'].classList.add = () => { tvWrapHidden = true; };
    const sandbox = {
      window: {
        GreyboxData: { getDetailPagesConfig: () => currentCfg },
        GreyboxPages: P,
      },
      document: {
        readyState: 'complete',
        addEventListener() {},
        getElementById: (id) => els[id] || null,
      },
      console,
    };
    vm.createContext(sandbox);
    vm.runInContext(dpSrc, sandbox, { filename: 'detail-pages.js' });
    const A = sandbox.window.GreyboxDetailPagesApply;
    t('E25 applier boots and wraps renderers once', !!A && P.__dpWrapped === true);

    // (8) movie: hide synopsis + rating, keep the rest.
    currentCfg = allTrue();
    currentCfg.header.overview = false;
    currentCfg.header.rating = false;
    els['m-meta'].textContent = '2024 · Movie · ⭐ 7.5 · Action, Drama';
    const okTitle = P.renderTitleDetail({ detail: { id: 1 }, mediaType: 'movie' });
    t('E26 (8,15) movie render hides synopsis, filters rating, keeps the rest',
      okTitle !== false &&
      els['m-overview'].style.display === 'none' &&
      els['m-meta'].textContent === '2024 · Movie · Action, Drama' &&
      els['m-title'].style.display === '' && els['m-cast'].style.display === '' &&
      els['m-watch'].style.display === '');
    // (13) actions.
    currentCfg = allTrue();
    currentCfg.actions.watch = false;
    currentCfg.actions.myList = false;
    P.renderTitleDetail({ detail: { id: 1 }, mediaType: 'movie' });
    t('E27 (13) Watch + My List hide, Trailer stays',
      els['m-watch'].style.display === 'none' && els['m-list'].style.display === 'none' &&
      els['m-trailer'].style.display === '');
    // (11) cast + providers with headings.
    currentCfg = allTrue();
    currentCfg.content.cast = false;
    currentCfg.content.providers = false;
    P.renderTitleDetail({ detail: { id: 1 }, mediaType: 'movie' });
    t('E28 (11) cast + providers hide with their headings',
      els['m-cast'].style.display === 'none' && els['m-cast-head'].style.display === 'none' &&
      els['m-providers'].style.display === 'none' && els['m-providers-head'].style.display === 'none');
    // (15) all-shown leaves the render untouched.
    currentCfg = allTrue();
    els['m-meta'].textContent = '2024 · TV Show · ⭐ 8.1 · Comedy';
    Object.values(els).forEach((n) => { n.style.display = ''; });
    P.renderTitleDetail({ detail: { id: 2 }, mediaType: 'tv' });
    t('E29 (15) all-shown config changes nothing (meta text byte-identical)',
      els['m-meta'].textContent === '2024 · TV Show · ⭐ 8.1 · Comedy' &&
      Object.values(els).every((n) => n.style.display === ''));
    // (9,10) TV: episodes off hides the section and empties the list copy.
    currentCfg = allTrue();
    currentCfg.tv.episodes = false;
    tvWrapHidden = false;
    const srcList = [{ episode_number: 1, overview: 'X', runtime: 42, air_date: '2024-01-01' }];
    const emptyCopy = A.episodesCtx({ episodes: srcList, resumeLabel: () => 'resume', onPlay: () => {} }, currentCfg);
    P.renderSeasons([1]);
    P.renderEpisodes({ episodes: srcList, resumeLabel: () => 'resume', onPlay: () => {} });
    t('E30 (9,10) episodes off: section hidden, episode list emptied (copy)',
      tvWrapHidden === true && emptyCopy && Array.isArray(emptyCopy.episodes) && emptyCopy.episodes.length === 0 &&
      typeof emptyCopy.resumeLabel === 'function' && typeof emptyCopy.onPlay === 'function' &&
      srcList.length === 1);
    // (10) episode overview/meta stripped but resume wiring kept.
    currentCfg = allTrue();
    currentCfg.tv.episodeOverview = false;
    currentCfg.tv.episodeMeta = false;
    const srcEp = { episode_number: 2, overview: 'Y', runtime: 50, air_date: '2024-02-02' };
    const stripped = A.episodesCtx({ episodes: [srcEp], resumeLabel: () => 'r', onPlay: () => {} }, currentCfg);
    P.renderEpisodes({ episodes: [srcEp], resumeLabel: () => 'r', onPlay: () => {} });
    t('E31 (10) overview/meta stripped from a copy; source + resume untouched',
      stripped && stripped.episodes[0].overview === '' &&
      stripped.episodes[0].runtime === null && stripped.episodes[0].air_date === '' &&
      srcEp.overview === 'Y' && srcEp.runtime === 50 &&
      typeof stripped.resumeLabel === 'function');
    // Person immunity.
    currentCfg = allTrue();
    currentCfg.content.cast = false;
    currentCfg.header.overview = false;
    P.renderPerson({});
    t('E32 person view always renders full (immune to detail flags)',
      els['m-cast'].style.display === '' && els['m-overview'].style.display === '');
    // Pure meta filter edge cases.
    t('E33 (8) meta filter handles year-less + flag combos',
      A.filterMetaText('Movie · ⭐ 7.5 · Action', { header: { rating: false, genres: true } }) === 'Movie · Action' &&
      A.filterMetaText('2024 · Movie · ⭐ 7.5 · Action', { header: { rating: true, genres: false } }) === '2024 · Movie · ⭐ 7.5' &&
      A.filterMetaText('2024 · Movie', { header: { rating: false, genres: false } }) === '2024 · Movie' &&
      A.filterMetaText('', {}) === '');
  } catch (e) {
    t('E25-33 applier stub-DOM checks', false, (e && e.message) || String(e));
  }
}

esmTests().then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed.');
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('Harness error:', (e && e.message) || e);
  process.exit(1);
});
