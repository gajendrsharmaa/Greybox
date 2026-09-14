/* Greybox Navigation V1 — focused tests (configurable public navbar).
 * Run: node tests/navigation.test.cjs   (exit 0 = all pass)
 * No dependencies, no browser, no network.
 *
 * Covers the increment checklist:
 *  1. default navigation configuration
 *  2. visibility
 *  3. label changes
 *  4. ordering
 *  5. stable key preservation
 *  6. invalid key rejection
 *  7. invalid label rejection
 *  8. invalid ordering rejection
 *  9. Admin authentication
 * 10. public configuration shape
 * 11. configuration failure fallback
 * 12. saved configuration reaching public navbar
 * 13. hidden item absent from navbar
 * 14. reordered items rendered in correct order
 * 15. custom label rendered correctly
 * 16. My List behavior preserved
 * 17. Search behavior preserved
 * plus: migration safety, no duplicate system, no token leaks, and no
 * regressions in Blocked Titles / Dashboard / playback / hero.
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
const adminCss = read('css/admin.css');
const indexHtml = read('index.html');
const navSrc = read('js/navigation.js');
const navFallbackSrc = read('js/navigation.config.js');
const dbSrc = read('functions/lib/db.js');
const validateSrc = read('functions/lib/validate.js');
const adminRoute = read('functions/api/admin/navigation.js');
const publicRoute = read('functions/api/config/navigation.js');
const migration = read('migrations/0005_navigation.sql');
const appSrc = read('js/app.js');
const routerSrc = read('js/router.js');

const EXPECTED_KEYS = ['home', 'movies', 'tv', 'anime', 'collections', 'my-list'];
const EXPECTED_LABELS = ['Home', 'Movies', 'TV Shows', 'Anime', 'Collections', 'My List'];

/* ---- 1. default navigation configuration ---- */
t('1a migration 0005_navigation.sql exists (next number, no overwrite)',
  fs.existsSync(path.join(ROOT, 'migrations/0005_navigation.sql')) &&
  !fs.existsSync(path.join(ROOT, 'migrations/0006_navigation.sql')) &&
  read('migrations/0001_schema.sql').includes('home_sections') &&
  read('migrations/0002_seed.sql').includes('home_hero') &&
  read('migrations/0003_tags.sql').includes('tag_members') &&
  read('migrations/0004_blocked.sql').includes('blocked_titles'));
t('1b migration seeds the exact current navbar (6 keys, labels, order, search)',
  EXPECTED_KEYS.every((k) => migration.includes('"key":"' + k + '"')) &&
  EXPECTED_LABELS.every((l) => migration.includes('"label":"' + l + '"')) &&
  migration.indexOf('"key":"home"') < migration.indexOf('"key":"movies"') &&
  migration.indexOf('"key":"movies"') < migration.indexOf('"key":"tv"') &&
  migration.indexOf('"key":"tv"') < migration.indexOf('"key":"anime"') &&
  migration.indexOf('"key":"anime"') < migration.indexOf('"key":"collections"') &&
  migration.indexOf('"key":"collections"') < migration.indexOf('"key":"my-list"') &&
  migration.includes('"searchVisible":true') &&
  /INSERT OR REPLACE INTO settings/.test(migration) && migration.includes("'navigation'"));
t('1c migration stores no routes/secrets (routes derived per key)',
  !/GREYBOX_ADMIN_TOKEN|TMDB_READ_TOKEN|TMDB_API_KEY|eyJ/i.test(migration) &&
  !/"route"\s*:|http/i.test(migration));
t('1d offline fallback reproduces the current navbar',
  fs.existsSync(path.join(ROOT, 'js/navigation.config.js')) &&
  /window\.GreyboxNavigation/.test(navFallbackSrc) &&
  EXPECTED_KEYS.every((k) => navFallbackSrc.includes("key: '" + k + "'")) &&
  EXPECTED_LABELS.every((l) => navFallbackSrc.includes("label: '" + l + "'")) &&
  /searchVisible: true/.test(navFallbackSrc));
t('1e fallback carries no routes/URLs (relabling can never break routing)',
  !/route\s*:|http|\/mylist|\/movies/.test(navFallbackSrc.replace(/\/\*[\s\S]*?\*\//g, '')));
t('1f index.html wires fallback before data.js and applier after collections-nav',
  indexHtml.indexOf('navigation.config.js') >= 0 &&
  indexHtml.indexOf('navigation.config.js') < indexHtml.indexOf('js/data.js') &&
  indexHtml.indexOf('js/navigation.js') > indexHtml.indexOf('collections-nav.js'));

/* ---- 2-5. model: visibility, labels, order, stable keys (data.js) ---- */
t('2a data.js preloads /api/config/navigation with the other config (one boot)',
  /load\('\/api\/config\/navigation'\)/.test(dataSrc));
t('2b data.js exposes the navigation model (keys, routes, getters)',
  /const NAV_KEYS = \['home', 'movies', 'tv', 'anime', 'collections', 'my-list'\]/.test(dataSrc) &&
  /function getNavigationConfig\(\)/.test(dataSrc) && /function getVisibleNavigation\(\)/.test(dataSrc) &&
  /function normalizeNavigation\(raw\)/.test(dataSrc) &&
  /getNavigationConfig,\s*\n?\s*getVisibleNavigation,/.test(dataSrc));
t('2c controlled known routes per key (existing routes only, no custom URLs)',
  /home: '\/'/.test(dataSrc) && /movies: '\/movies'/.test(dataSrc) &&
  /tv: '\/tv'/.test(dataSrc) && /anime: '\/anime'/.test(dataSrc) &&
  /collections: null/.test(dataSrc) && /'my-list': '\/mylist'/.test(dataSrc));
t('2d visibility is a flag (hidden kept, never deleted)',
  /visible: it\.visible === false \? false : true/.test(dataSrc) &&
  /items: full\.items\.filter\(\(it\) => it && it\.visible !== false\)/.test(dataSrc));
t('3a labels editable independently (normalizer keeps key, trims label)',
  /label = it\.label\.trim\(\)/.test(dataSrc));
t('4a array order IS the display order (no sort column, no re-sort)',
  /Array order IS the display order/.test(dataSrc));
t('5a stable key identity (data-nav mapping preserved per key, never rewritten)',
  /movies: 'movie'/.test(dataSrc) && /'my-list': 'mylist'/.test(dataSrc) &&
  /The applier.*never changes these|never changes these/.test(dataSrc));

/* ---- 6-8. server validation shape (static) ---- */
t('6a unknown keys rejected (allowlist of six)',
  /NAV_KEYS\.indexOf\(s\) < 0/.test(validateSrc) && /must be one of/.test(validateSrc));
t('7a empty/oversize/non-string labels rejected',
  /must not be empty/.test(validateSrc) && /NAV_LABEL_MAX/.test(validateSrc) &&
  /must be a string/.test(validateSrc));
t('8a wrong count / duplicates / omission rejected (hide via flag, never removal)',
  /exactly \$\{NAV_KEYS\.length\} navigation items/.test(validateSrc) &&
  /duplicate navigation key/.test(validateSrc) && /missing navigation key/.test(validateSrc));
t('8b admin route validates the full body on PUT (strict, 400 on bad input)',
  /validateNavigationBody\(body\)/.test(adminRoute) && /writeSetting\(db, KEY/.test(adminRoute));
t('8c routes derived server-side (no client-supplied destinations)',
  /route: NAV_ROUTES\[key\]/.test(validateSrc) && !/body\.route|it\.route/.test(validateSrc));

/* ---- 9. admin authentication ---- */
t('9a admin route gates requireAdmin() before touching D1',
  adminRoute.indexOf('requireAdmin(request, env)') >= 0 &&
  adminRoute.indexOf('requireAdmin(request, env)') < adminRoute.indexOf('getDb(env)'));
t('9b admin route never leaks stacks/SQL/secrets (adminError envelope)',
  /adminError\(e,/.test(adminRoute) && !/\.stack|GREYBOX_ADMIN_TOKEN/.test(adminRoute));
t('9c PUT parses body only after auth (no unauthenticated body work)',
  adminRoute.indexOf('readJsonBody(request)') > adminRoute.indexOf('requireAdmin(request, env)'));
t('9d no new auth system (shared requireAdmin only)',
  !/jsonwebtoken|bcrypt|session|cookie|password/i.test(adminRoute));
t('9e admin token still memory-only (no persistence added)',
  !/localStorage\.(setItem|getItem)|sessionStorage\.(setItem|getItem)|document\.cookie\s*=/.test(adminSrc));

/* ---- 10. public configuration shape ---- */
t('10a public /api/config/navigation route exists', fs.existsSync(path.join(ROOT, 'functions/api/config/navigation.js')));
t('10b public route serves shaped config with items + searchVisible + routes',
  /readNavigation\(db\)/.test(publicRoute));
t('10c public route is open GET with short cache (no auth, ~60s propagation)',
  !/requireAdmin/.test(publicRoute) && /request\.method !== 'GET'/.test(publicRoute) && /max-age=60/.test(publicRoute));
t('10d db exposes readNavigation through the settings row (no new table)',
  /export async function readNavigation\(db\)/.test(dbSrc) &&
  /readSetting\(db, 'navigation'\)/.test(dbSrc) &&
  !/CREATE TABLE|navigation_items|nav_items/.test(dbSrc) &&
  (dbSrc.match(/navigation/g) || []).length <= 14);

/* ---- 11. configuration failure fallback ---- */
t('11a applier leaves the static navbar untouched when config is missing',
  /if \(!cfg\) return false; \/\/ no config yet: leave the static navbar as-is/.test(navSrc));
t('11b normalizer never throws (corrupt rows render as default navbar)',
  /Never throws/.test(dataSrc) && /catch \{ return normalizeNavigation\(null\); \}/.test(dataSrc));
t('11c public route 503s without D1 (frontend falls back to local file)',
  /is not configured/.test(publicRoute));

/* ---- 12-15. saved configuration reaching the navbar (applier contract) ---- */
t('12a applier reads the public config (never admin endpoints, no token)',
  /getNavigationConfig/.test(navSrc) && !/api\/admin|Authorization|Bearer/.test(navSrc));
t('12b applier moves existing nodes (listeners survive — no rebuild)',
  /appendChild\(d\)/.test(navSrc) && /appendChild\(m\)/.test(navSrc) &&
  !/innerHTML\s*=\s*['"`]?<button/.test(navSrc));
t('13a hidden entries hidden, nodes kept (recoverable, absent visually)',
  /showEl\(d, visible\)/.test(navSrc) && /showEl\(m, visible\)/.test(navSrc) &&
  /elm\.hidden = true/.test(navSrc));
t('14a config order applied to desktop + mobile nav (reorder renders)',
  /cfg\.items\.forEach/.test(navSrc) && /\.gx-nav/.test(navSrc) && /\.gx-mobile-nav/.test(navSrc));
t('15a labels update text only (badges/counts/chevrons/data-nav preserved)',
  /setButtonLabel/.test(navSrc) && /nodeType === 3/.test(navSrc) &&
  !/setAttribute\(['"]data-nav/.test(navSrc) && !/dataset\.nav\s*=/.test(navSrc));
t('15b collections entry maps to the existing dropdown (no invented route)',
  /collections-wrap/.test(navSrc) && /collections-btn-mobile/.test(navSrc) &&
  !/Router\.navigate|pushState/.test(navSrc));
t('15c collections label targets the buttons via single-id lookups (no compound selector)',
  /querySelector\('#collections-btn'\)/.test(navSrc) &&
  /querySelector\('#collections-btn-mobile'\)/.test(navSrc) &&
  !/querySelector\('[^']*,/.test(navSrc));
t('12c applier re-applies after collections menu re-renders (no clobber)',
  /__greyboxNavWrapped/.test(navSrc) && /wrapCollectionsRefresh/.test(navSrc));

/* ---- 16. My List behavior preserved ---- */
t('16a My List storage/count logic untouched (only the entry hides)',
  /function getMyList\(\)/.test(dataSrc) && /function toggleMyListItem\(item\)/.test(dataSrc) &&
  /function isInMyList\(id, mt\)/.test(dataSrc));
t('16b applier never touches storage or counts',
  !/localStorage|getMyList|toggleMyListItem|mylist-count/.test(navSrc));
t('16c app.js list/count wiring unchanged (data-nav mylist still handled)',
  /key === 'mylist'/.test(appSrc) && /\$\('mylist-count'\)/.test(appSrc) &&
  !/GreyboxNavigation|getNavigationConfig/.test(appSrc));

/* ---- 17. Search behavior preserved ---- */
t('17a search fetchers untouched (suggestions + page + route all intact)',
  /function getSearchResults\(query, page\)/.test(dataSrc) &&
  /function getSuggestions\(query, limit\)/.test(dataSrc) &&
  /case 'search'|name: 'search'/.test(routerSrc));
t('17b applier never fetches/searches (only toggles the box)',
  !/getSuggestions|getSearchResults|fetch\(/.test(navSrc) && /\.gx-search/.test(navSrc));
t('17c search visibility is a separate flag (not a fake nav item)',
  /searchVisible/.test(dataSrc) && /searchVisible/.test(navSrc) &&
  /OUTSIDE the item list|outside the item list/i.test(dataSrc));

/* ---- admin workspace shell ---- */
t('A1 sidebar Navigation is a live view (Soon removed only here)',
  /data-view="navigation"/.test(adminHtml) && !/data-soon="Navigation"/.test(adminHtml));
// Detail Pages V1 promotes Detail Pages to a live workspace (its Soon badge
// is intentionally gone) — the guard below still pins every REMAINING Soon
// entry so no unrelated module is silently scaffolded or un-scaffolded.
t('A2 unrelated Soon entries untouched',
  /data-soon="Activity"/.test(adminHtml) && !/data-soon="Detail Pages"/.test(adminHtml) &&
  /data-view="detail"/.test(adminHtml) && /data-soon="Playback"/.test(adminHtml) &&
  /data-soon="Branding"/.test(adminHtml) &&
  /data-soon="Theme"/.test(adminHtml) && /data-soon="SEO \/ Metadata"/.test(adminHtml));
t('A3 workspace section: actions, list, search panel, preview, dirty flag',
  /id="view-navigation"/.test(adminHtml) && /id="nav-save"/.test(adminHtml) &&
  /id="nav-discard"/.test(adminHtml) && /id="nav-reset"/.test(adminHtml) &&
  /id="nav-refresh"/.test(adminHtml) && /id="nav-list"/.test(adminHtml) &&
  /id="nav-search-panel"/.test(adminHtml) && /id="nav-preview"/.test(adminHtml) &&
  /id="nav-dirty"/.test(adminHtml) && /Unsaved changes/.test(adminHtml));
t('A4 header copy states control + ordering (no scaffold claims left)',
  /Control the public Greybox navigation and its ordering/.test(adminHtml) &&
  !/Navigation — coming soon/.test(adminHtml));
t('A5 admin logic: staged draft (load/render/save/discard/reset + validation)',
  /function loadNavigation\(\)/.test(adminSrc) && /function renderNavigation\(\)/.test(adminSrc) &&
  /function saveNavigation\(\)/.test(adminSrc) && /function discardNavigation\(\)/.test(adminSrc) &&
  /function resetNavigation\(\)/.test(adminSrc) && /function navValidateDraft\(draft\)/.test(adminSrc) &&
  /VIEWS\.navigation|navigation: \{ title: 'Navigation'/.test(adminSrc));
t('A6 rows show key + label + visibility + order + route (no label-as-identity)',
  /function navRow\(it, idx\)/.test(adminSrc) && /nav-key/.test(adminSrc) &&
  /navRouteLabel\(it\.key\)/.test(adminSrc) && /statusBadge\(it\)/.test(adminSrc) &&
  /Move up/.test(adminSrc) && /Move down/.test(adminSrc));
t('A7 ordering without new dependencies (up/down swaps, staged until save)',
  !/sortable|dragula|drag-and-drop/i.test(adminSrc) && /navMove\(idx, -1\)/.test(adminSrc));
t('A8 preview reflects the draft (order + visibility + labels, marked preview)',
  /function renderNavPreview\(\)/.test(adminSrc) && /nav-preview-item/.test(adminSrc) &&
  /display only, not the real navbar/.test(adminHtml));
t('A9 stale-request guards + read-back verification + retry states',
  /navGen\+\+/.test(adminSrc) && /myGen !== navGen/.test(adminSrc) &&
  /read-back differs/.test(adminSrc) && /Navigation failed to load/.test(adminSrc) &&
  /stateBox\(host, '(loading|error)'/.test(adminSrc));
t('A10 admin styles in project language + responsive (no page overflow)',
  /\.nav-workspace/.test(adminCss) && /\.nav-row/.test(adminCss) &&
  /\.nav-preview-bar/.test(adminCss) && /\.badge-dirty/.test(adminCss) &&
  /\.nav-row-side \{ width: 100%; \}/.test(adminCss));

/* ---- no duplicate system, no leaks, no regressions ---- */
t('R1 no duplicate migration/API/config (one row, one seam, one workspace)',
  (validateSrc.match(/NAV_KEYS/g) || []).length <= 12 &&
  (dataSrc.match(/NAV_KEYS/g) || []).length <= 6 &&
  !fs.existsSync(path.join(ROOT, 'functions/api/admin/nav.js')) &&
  !fs.existsSync(path.join(ROOT, 'functions/api/config/nav.js')));
t('R2 router untouched (no second router, no route changes)',
  (() => {
    try {
      const out = execSync('git diff --name-only && git ls-files --others --exclude-standard', { cwd: ROOT, stdio: 'pipe' }).toString();
      return !/js\/router\.js/.test(out);
    } catch { return false; }
  })());
// Detail Pages V1 adds js/detail-pages.js + js/detail-pages.config.js —
// new files whose names contain the substring "pages.js". The guard below
// matches on "/pages.js" so it still fails on any real edit to the
// js/pages.js renderer itself (same for components).
t('R3 no playback/hero/detail/blocked/dashboard regressions in the diff',
  (() => {
    try {
      const out = execSync('git diff --name-only && git ls-files --others --exclude-standard', { cwd: ROOT, stdio: 'pipe' }).toString();
      return !/\/stream\.js|\/greybox-player\.js|\/hero\.js|player\.css|\/pages\.js|\/components\.js|shelves\.js|collections-nav\.js|navbar\.css/.test(out) &&
        !/0001_schema|0002_seed|0003_tags|0004_blocked/.test(out);
    } catch { return false; }
  })());
t('R4 blocked + dashboard logic intact (workspace + seam + roadmap)',
  /function loadBlocked\(\)/.test(adminSrc) && /function renderBlocked\(\)/.test(adminSrc) &&
  /function loadDashboard\(\)/.test(adminSrc) && /function isBlockedContent\(media, id\)/.test(dataSrc));
t('R5 changed JS parses (node --check)',
  (() => {
    try {
      for (const f of ['js/data.js', 'js/navigation.js', 'js/navigation.config.js', 'js/admin.js',
        'functions/lib/validate.js', 'functions/lib/db.js',
        'functions/api/config/navigation.js', 'functions/api/admin/navigation.js']) {
        execSync('node --check ' + JSON.stringify(f), { cwd: ROOT, stdio: 'pipe' });
      }
      return true;
    } catch (e) { return false; }
  })());

/* ---- live behavioral checks: validate.js + db.js (real ESM imports) ---- */
async function esmTests() {
  let V = null, DB = null;
  try { V = await import('../functions/lib/validate.js'); } catch (e) { V = null; }
  try { DB = await import('../functions/lib/db.js'); } catch (e) { DB = null; }
  t('E1 validate.js loads as ESM', !!V);
  t('E2 db.js loads as ESM', !!DB);

  const full = {
    items: [
      { key: 'home', label: 'Home', visible: true },
      { key: 'movies', label: 'Films', visible: true },
      { key: 'tv', label: 'Series', visible: false },
      { key: 'anime', label: 'Anime', visible: true },
      { key: 'collections', label: 'Browse', visible: true },
      { key: 'my-list', label: 'My List', visible: true },
    ],
    searchVisible: false,
  };

  if (V) {
    const ok = (fn) => { try { fn(); return true; } catch { return false; } };
    let clean = null;
    try { clean = V.validateNavigationBody(JSON.parse(JSON.stringify(full))); } catch { clean = null; }
    t('E3 (3,4,5) label + order + visibility validate; keys preserved, routes derived server-side',
      !!clean && clean.items[1].key === 'movies' && clean.items[1].label === 'Films' &&
      clean.items[2].visible === false && clean.items.map((i) => i.key).join(',') === EXPECTED_KEYS.join(',') &&
      clean.searchVisible === false && !('route' in clean.items[0]));
    t('E4 (6) invalid keys rejected',
      !ok(() => V.validateNavigationBody({ items: [{ key: 'music', label: 'Music', visible: true }], searchVisible: true })) &&
      !ok(() => V.validateNavigationBody({ items: [
        { key: 'home', label: 'Home', visible: true }, { key: 'movies', label: 'M', visible: true },
        { key: 'tv', label: 'T', visible: true }, { key: 'anime', label: 'A', visible: true },
        { key: 'collections', label: 'C', visible: true }, { key: 'BOGUS', label: 'B', visible: true },
      ] })));
    t('E5 (7) invalid labels rejected (empty, blank, oversize, non-string)',
      !ok(() => V.validateNavigationBody({ items: [
        { key: 'home', label: '', visible: true }, { key: 'movies', label: 'M', visible: true },
        { key: 'tv', label: 'T', visible: true }, { key: 'anime', label: 'A', visible: true },
        { key: 'collections', label: 'C', visible: true }, { key: 'my-list', label: 'M', visible: true },
      ] })) &&
      !ok(() => V.validateNavigationBody({ items: [
        { key: 'home', label: '   ', visible: true }, { key: 'movies', label: 'M', visible: true },
        { key: 'tv', label: 'T', visible: true }, { key: 'anime', label: 'A', visible: true },
        { key: 'collections', label: 'C', visible: true }, { key: 'my-list', label: 'M', visible: true },
      ] })) &&
      !ok(() => V.validateNavigationBody({ items: [
        { key: 'home', label: 'x'.repeat(33), visible: true }, { key: 'movies', label: 'M', visible: true },
        { key: 'tv', label: 'T', visible: true }, { key: 'anime', label: 'A', visible: true },
        { key: 'collections', label: 'C', visible: true }, { key: 'my-list', label: 'M', visible: true },
      ] })) &&
      !ok(() => V.validateNavigationBody({ items: [
        { key: 'home', label: 42, visible: true }, { key: 'movies', label: 'M', visible: true },
        { key: 'tv', label: 'T', visible: true }, { key: 'anime', label: 'A', visible: true },
        { key: 'collections', label: 'C', visible: true }, { key: 'my-list', label: 'M', visible: true },
      ] })) &&
      !!V.validateNavigationBody({ items: [
        { key: 'home', label: 'x'.repeat(32), visible: true }, { key: 'movies', label: 'M', visible: true },
        { key: 'tv', label: 'T', visible: true }, { key: 'anime', label: 'A', visible: true },
        { key: 'collections', label: 'C', visible: true }, { key: 'my-list', label: 'M', visible: true },
      ] }));
    const dup = JSON.parse(JSON.stringify(full));
    dup.items[1].key = 'home';
    t('E6 (8) invalid ordering rejected (duplicates, omission, wrong count)',
      !ok(() => V.validateNavigationBody(dup)) &&
      !ok(() => V.validateNavigationBody({ items: full.items.slice(0, 5) })) &&
      !ok(() => V.validateNavigationBody({ items: full.items.concat([{ key: 'home', label: 'H2', visible: true }]) })) &&
      !ok(() => V.validateNavigationBody({ items: 'home,movies' })) &&
      !ok(() => V.validateNavigationBody(null)) && !ok(() => V.validateNavigationBody([])));
    t('E7 malformed flags rejected (visible/searchVisible must be boolean)',
      !ok(() => V.validateNavigationBody({ items: full.items.map((i) => ({ ...i, visible: 'yes' })) })) &&
      !ok(() => V.validateNavigationBody({ items: full.items, searchVisible: 'yes' })) &&
      !!V.validateNavigationBody({ items: full.items }));
    // Lenient read-side sanitizer: repairs, never throws.
    let s1 = null, threw = false;
    try {
      s1 = V.sanitizeNavigation({ items: [{ key: 'movies', label: '  Films  ', visible: true }, { key: 'nope', label: 'X' }], searchVisible: 'bad' });
    } catch { threw = true; }
    t('E8 sanitizer is lenient (unknown dropped, missing filled visible, label trimmed, flag defaults)',
      !threw && !!s1 && s1.items.length === 6 &&
      s1.items[0].key === 'movies' && s1.items[0].label === 'Films' && s1.items[0].route === '/movies' &&
      s1.items.every((i) => EXPECTED_KEYS.includes(i.key)) &&
      s1.items.filter((i) => i.key !== 'movies').every((i) => i.visible === true) &&
      s1.searchVisible === true);
    let s2 = null;
    try { s2 = V.sanitizeNavigation(null); } catch { s2 = null; }
    t('E9 sanitizer falls back to the default navbar on garbage (never throws)',
      !!s2 && s2.items.map((i) => i.label).join('|') === EXPECTED_LABELS.join('|') && s2.searchVisible === true);
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
    const dflt = await DB.readNavigation(db);
    t('E10 (1) empty settings row reads as the default navbar',
      dflt.items.map((i) => i.key).join(',') === EXPECTED_KEYS.join(',') &&
      dflt.items.map((i) => i.label).join('|') === EXPECTED_LABELS.join('|') &&
      dflt.items.every((i) => i.visible === true) && dflt.searchVisible === true);
    t('E11 (10) routes attached per key (collections menu has no URL)',
      dflt.items.find((i) => i.key === 'home').route === '/' &&
      dflt.items.find((i) => i.key === 'movies').route === '/movies' &&
      dflt.items.find((i) => i.key === 'my-list').route === '/mylist' &&
      dflt.items.find((i) => i.key === 'collections').route === null);
    // Saved configuration round-trips (12) with order/labels/visibility (2,3,4).
    const { writeSetting } = DB;
    const saved = {
      items: [
        { key: 'anime', label: 'Anime Planet', visible: true },
        { key: 'home', label: 'Home', visible: true },
        { key: 'movies', label: 'Movies', visible: false },
        { key: 'tv', label: 'TV Shows', visible: true },
        { key: 'collections', label: 'Collections', visible: true },
        { key: 'my-list', label: 'My List', visible: true },
      ],
      searchVisible: false,
    };
    await writeSetting(db, 'navigation', saved);
    const back = await DB.readNavigation(db);
    t('E12 (12,14,15) saved order + custom labels round-trip; hidden kept server-side (2,3,4,13)',
      back.items.map((i) => i.key).join(',') === 'anime,home,movies,tv,collections,my-list' &&
      back.items[0].label === 'Anime Planet' &&
      back.items.find((i) => i.key === 'movies').visible === false &&
      back.items.find((i) => i.key === 'movies').label === 'Movies' &&
      back.searchVisible === false &&
      back.items.find((i) => i.key === 'anime').route === '/anime');
  }

  /* ---- route-level checks (real handlers, fake D1, real Request/Response) ---- */
  let adminMod = null, publicMod = null;
  try { adminMod = await import('../functions/api/admin/navigation.js'); } catch (e) { adminMod = null; }
  try { publicMod = await import('../functions/api/config/navigation.js'); } catch (e) { publicMod = null; }
  t('E13 route modules load', !!adminMod && !!publicMod);

  if (adminMod && publicMod) {
    const seedRow = JSON.stringify({
      items: EXPECTED_KEYS.map((k, i) => ({ key: k, label: EXPECTED_LABELS[i], visible: true })),
      searchVisible: true,
    });
    const db = fakeDb({ navigation: seedRow });
    const goodEnv = { DB: db, GREYBOX_ADMIN_TOKEN: 'test-token' };
    const req = (url, init) => new Request(url, init);
    const auth = { Authorization: 'Bearer test-token' };

    let r = await adminMod.onRequest({ request: req('http://x/api/admin/navigation'), env: { DB: db } });
    t('E14 (9) missing credentials / unconfigured server fail closed (401)', r.status === 401);
    r = await adminMod.onRequest({ request: req('http://x/api/admin/navigation'), env: goodEnv });
    t('E15 (9) anonymous GET fails closed (401, never touches D1)', r.status === 401);
    r = await adminMod.onRequest({ request: req('http://x/api/admin/navigation', { headers: { Authorization: 'Bearer wrong' } }), env: goodEnv });
    t('E16 (9) wrong token rejected (403)', r.status === 403);
    r = await adminMod.onRequest({ request: req('http://x/api/admin/navigation', { headers: auth }), env: goodEnv });
    const got = r.status === 200 ? await r.json() : null;
    t('E17 (10) authed GET returns the full six-item config + search flag',
      r.status === 200 && !!got && got.items.length === 6 && got.searchVisible === true &&
      got.items.every((i) => typeof i.key === 'string' && typeof i.label === 'string' && typeof i.visible === 'boolean' && 'route' in i));
    r = await adminMod.onRequest({
      request: req('http://x/api/admin/navigation', { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{"oops"' }),
      env: goodEnv,
    });
    t('E18 malformed JSON rejected (400, no leak)', r.status === 400);
    r = await adminMod.onRequest({
      request: req('http://x/api/admin/navigation', {
        method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ key: 'home', label: 'H', visible: true }] }),
      }),
      env: goodEnv,
    });
    t('E19 (6,7,8) invalid PUT rejected (400)', r.status === 400);

    // Hide + relabel + reorder + hide search, then verify persistence.
    const payload = {
      items: [
        { key: 'my-list', label: 'Watchlist', visible: true },
        { key: 'home', label: 'Home', visible: true },
        { key: 'movies', label: 'Movies', visible: false },
        { key: 'tv', label: 'Series', visible: true },
        { key: 'anime', label: 'Anime', visible: true },
        { key: 'collections', label: 'Collections', visible: true },
      ],
      searchVisible: false,
    };
    r = await adminMod.onRequest({
      request: req('http://x/api/admin/navigation', {
        method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }),
      env: goodEnv,
    });
    const stored = r.status === 200 ? await r.json() : null;
    t('E20 save persists order + labels + visibility + search flag',
      r.status === 200 && !!stored && stored.items[0].key === 'my-list' && stored.items[0].label === 'Watchlist' &&
      stored.items.find((i) => i.key === 'movies').visible === false &&
      stored.items.find((i) => i.key === 'tv').label === 'Series' && stored.searchVisible === false);
    r = await adminMod.onRequest({ request: req('http://x/api/admin/navigation', { headers: auth }), env: goodEnv });
    const reread = r.status === 200 ? await r.json() : null;
    t('E21 saved config reads back identically (persistence across requests)',
      !!reread && JSON.stringify(reread.items.map((i) => [i.key, i.label, i.visible])) ===
        JSON.stringify(payload.items.map((i) => [i.key, i.label, i.visible])) &&
      reread.searchVisible === false);

    // Public endpoint reflects the save (12); frontend hides/filters from flags (13,14,15).
    r = await publicMod.onRequest({ request: req('http://x/api/config/navigation'), env: { DB: db } });
    const pub = r.status === 200 ? await r.json() : null;
    const cache = r.headers ? r.headers.get('Cache-Control') : '';
    t('E22 (10,12) public config reflects the save (open, short cache)',
      r.status === 200 && !!pub && pub.items[0].key === 'my-list' && pub.items[0].label === 'Watchlist' &&
      /max-age=60/.test(cache || ''));
    t('E23 (13) hidden item still present server-side with visible:false (frontend hides it)',
      !!pub && pub.items.find((i) => i.key === 'movies').visible === false);
    t('E24 (14) public order follows the saved order',
      !!pub && pub.items.map((i) => i.key).join(',') === 'my-list,home,movies,tv,anime,collections');
    r = await publicMod.onRequest({ request: req('http://x/api/config/navigation'), env: {} });
    t('E25 (11) public 503 without D1 (frontend keeps the local fallback)', r.status === 503);
  }

  /* ---- data.js fallback behavior in a VM (no network, no DOM) ---- */
  try {
    const sandbox = { window: {}, console };
    vm.createContext(sandbox);
    vm.runInContext(navFallbackSrc, sandbox, { filename: 'navigation.config.js' });
    vm.runInContext(dataSrc, sandbox, { filename: 'data.js' });
    const D = sandbox.window.GreyboxData;
    const cfg = D.getNavigationConfig();
    t('E26 (1,11) data.js falls back to the local file (default navbar, no fetch)',
      !!cfg && cfg.items.length === 6 && cfg.items[0].key === 'home' && cfg.items[0].label === 'Home' &&
      cfg.searchVisible === true);
    sandbox.window.GreyboxNavigation = {
      items: [
        { key: 'tv', label: 'Series', visible: true },
        { key: 'home', label: 'Home', visible: false },
      ],
      searchVisible: false,
    };
    const cfg2 = D.getNavigationConfig();
    const vis = D.getVisibleNavigation();
    t('E27 (2,3,4,5) fallback honors order + labels + visibility by key (missing filled)',
      cfg2.items[0].key === 'tv' && cfg2.items[0].label === 'Series' &&
      cfg2.items.find((i) => i.key === 'home').visible === false &&
      cfg2.items.length === 6 && cfg2.searchVisible === false &&
      vis.items.every((i) => i.visible !== false) && vis.items[0].key === 'tv' &&
      !vis.items.some((i) => i.key === 'home'));
    sandbox.window.GreyboxNavigation = { items: [{ key: 'bogus', label: 'X' }], searchVisible: true };
    const cfg3 = D.getNavigationConfig();
    t('E28 unknown keys dropped, defaults fill in (never a broken navbar)',
      cfg3.items.length === 6 && !cfg3.items.some((i) => i.key === 'bogus'));
  } catch (e) {
    t('E26-28 data.js VM fallback checks', false, (e && e.message) || String(e));
  }
}

esmTests().then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed.');
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('Harness error:', (e && e.message) || e);
  process.exit(1);
});
