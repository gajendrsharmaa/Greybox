/* Greybox Blocked Titles — focused tests (blocklist increment).
 * Run: node tests/blocked.test.cjs   (exit 0 = all pass)
 * No dependencies, no browser, no network.
 *
 * Covers: movie/tv block identity, cross-type independence, duplicate
 * prevention, unblock, malformed media/id rejection, admin auth gating,
 * public filtering (lists/search/discover/suggestions/id-lists/hero),
 * direct-detail blocking, unblocked titles untouched, admin search still
 * finding blocked titles, already-blocked state, API error handling,
 * migration safety, no token leaks, no unrelated playback/hero changes.
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
const dbSrc = read('functions/lib/db.js');
const validateSrc = read('functions/lib/validate.js');
const blockedRoute = read('functions/api/admin/blocked.js');
const blockedItemRoute = read('functions/api/admin/blocked/[media]/[id].js');
const publicBlockedRoute = read('functions/api/config/blocked.js');
const migration = read('migrations/0004_blocked.sql');

/* ---- 1. migration safety: next number, no overwrite, uniqueness ---- */
t('1a migration 0004_blocked.sql exists', fs.existsSync(path.join(ROOT, 'migrations/0004_blocked.sql')));
t('1b no older migration overwritten (0001/0002/0003 intact)',
  read('migrations/0001_schema.sql').includes('home_sections') &&
  read('migrations/0002_seed.sql').includes('home_hero') &&
  read('migrations/0003_tags.sql').includes('tag_members'));
t('1c blocked_titles table with (media, tmdb_id) primary key',
  /CREATE TABLE IF NOT EXISTS blocked_titles/.test(migration) && /PRIMARY KEY\s*\(\s*media\s*,\s*tmdb_id\s*\)/.test(migration));
t('1d media + id checks mirror overrides/tags conventions',
  /media IN \('movie', 'tv'\)/.test(migration) && /tmdb_id > 0/.test(migration));
t('1e migration stores snapshots only, no secrets',
  !/GREYBOX_ADMIN_TOKEN|TMDB_READ_TOKEN|TMDB_API_KEY|eyJ/i.test(migration));

/* ---- 2. admin API: protected, validated, conventional ---- */
for (const [label, src] of [['2a list/block route', blockedRoute], ['2b item route', blockedItemRoute]]) {
  t(label + ' gates requireAdmin() before touching D1',
    src.indexOf('requireAdmin(request, env)') >= 0 &&
    src.indexOf('requireAdmin(request, env)') < src.indexOf('getDb(env)'));
  t(label + ' never leaks stacks/SQL/secrets (adminError envelope)',
    /adminError\(e,/.test(src) && !/\.stack|GREYBOX_ADMIN_TOKEN/.test(src));
}
t('2c list route: GET list + POST block (201) + 409/400 via db/validate',
  /request\.method === 'GET'/.test(blockedRoute) && /request\.method === 'POST'/.test(blockedRoute) &&
  /readBlockedTitles/.test(blockedRoute) && /validateBlockedBody/.test(blockedRoute) && /, 201\)/.test(blockedRoute));
t('2d POST parses body only after auth (no unauthenticated body work)',
  blockedRoute.indexOf('readJsonBody(request)') > blockedRoute.indexOf('requireAdmin(request, env)'));
t('2e item route: GET read + DELETE unblock (204), 404 when missing, 400 on bad URL',
  /request\.method === 'GET'/.test(blockedItemRoute) && /request\.method === 'DELETE'/.test(blockedItemRoute) &&
  /status:\s*204/.test(blockedItemRoute) && /Blocked title not found/.test(blockedItemRoute) &&
  /URL must be \/api\/admin\/blocked\/movie\|tv\/:tmdb_id/.test(blockedItemRoute));
t('2f no new auth system (shared requireAdmin only)',
  !/jsonwebtoken|bcrypt|session|cookie|password/i.test(blockedRoute + blockedItemRoute));

/* ---- 3. public endpoint: minimal, safe ---- */
t('3a public /api/config/blocked route exists', fs.existsSync(path.join(ROOT, 'functions/api/config/blocked.js')));
t('3b public route serves identity-only rows (no snapshots/internals)',
  /readPublicBlocked/.test(publicBlockedRoute) &&
  !/poster_path|backdrop_path|created_at|updated_at|\.title/.test(publicBlockedRoute));
t('3c db readPublicBlocked selects media+id only',
  (() => {
    const m = /export async function readPublicBlocked[\s\S]*?\n\}/.exec(dbSrc);
    return !!m && /SELECT media, tmdb_id AS id/.test(m[0]) &&
      !/poster_path|backdrop_path|created_at|updated_at|\.title/.test(m[0]);
  })());
t('3d public route short-caches like other config routes', /max-age=60/.test(publicBlockedRoute));

/* ---- 4. central filter seam in js/data.js ---- */
t('4a isBlockedContent() seam exists and is exported',
  /function isBlockedContent\(media, id\)/.test(dataSrc) && /isBlockedContent,/.test(dataSrc));
t('4b identity is media:id pair only (cross-type safe, never title/poster)',
  /media \+ ':' \+ (clean|n\.id|id)/.test(dataSrc) && /function normalizeBlockedEntry/.test(dataSrc));
t('4c lists filter centrally (withImages)', /isBlockedItem\(x, fallbackType\)/.test(dataSrc));
t('4d public search filters centrally', /Public search never surfaces blocked titles/.test(dataSrc));
t('4e discover/genre filters centrally', /isBlockedItem\(x, mt\)/.test(dataSrc));
t('4f id-lists (custom/tag/pins) filter centrally', /pins, custom lists and tag memberships included/.test(dataSrc));
t('4g detail getters refuse blocked IDs (pre + post fetch guards)',
  (dataSrc.match(/blockedError\('movie', clean\)/g) || []).length >= 2 &&
  (dataSrc.match(/blockedError\('tv', clean\)/g) || []).length >= 2);
t('4h blocked detail error is generic (no internals leak)',
  /This title is not available in Greybox/.test(dataSrc) && /e\.blocked = true/.test(dataSrc));
t('4i blocklist preloads once with other config (no per-movie D1 request)',
  /load\('\/api\/config\/blocked'\)/.test(dataSrc));
t('4j no scattered per-page if(blocked) checks (single seam, renderers untouched)',
  (dataSrc.match(/isBlockedContent|isBlockedItem/g) || []).length <= 20 &&
  !/if\s*\(\s*blocked\s*\)/.test(dataSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')) &&
  ['js/app.js', 'js/pages.js', 'js/components.js', 'js/shelves.js', 'js/hero.js'].every((f) =>
    !/isBlockedContent|isBlockedItem|filterBlocked/.test(read(f))));
t('4k admin search path untouched (raw /api/tmdb proxy, never filtered)',
  !/isBlocked/i.test(read('js/admin.js').split('BLOCKED TITLES')[0].split('tmdbSearchFetch')[0] || ''));

/* ---- 5. admin workspace shell ---- */
t('5a sidebar Blocked Titles is a live view (no Soon)',
  /data-view="blocked"/.test(adminHtml) && !/data-soon="Blocked Titles"/.test(adminHtml));
t('5b workspace section with header, actions, filters, count, list',
  /id="view-blocked"/.test(adminHtml) && /id="blocked-new"/.test(adminHtml) &&
  /id="blocked-refresh"/.test(adminHtml) && /id="blocked-search"/.test(adminHtml) &&
  /id="blocked-media"/.test(adminHtml) && /id="blocked-count"/.test(adminHtml) &&
  /id="blocked-list"/.test(adminHtml));
t('5c header copy states permanence + media:id identity',
  /Permanently exclude specific movies/.test(adminHtml) && /media:TMDB ID/.test(adminHtml));
// Navigation V1 promotes Navigation to a live workspace (its Soon badge is
// intentionally gone) — the guard below still pins every REMAINING Soon
// entry so no unrelated module is silently scaffolded or un-scaffolded.
t('5d other Soon items untouched (still scaffolded)',
  /data-soon="Activity"/.test(adminHtml) && !/data-soon="Navigation"/.test(adminHtml) &&
  /data-view="navigation"/.test(adminHtml) && /data-soon="Branding"/.test(adminHtml));
t('5e admin logic: full block/unblock workspace (list/search/confirm/unblock)',
  /function loadBlocked\(\)/.test(adminSrc) && /function renderBlocked\(\)/.test(adminSrc) &&
  /function openBlockPicker\(\)/.test(adminSrc) && /function openBlockConfirm\(/.test(adminSrc) &&
  /function confirmBlockTitle\(/.test(adminSrc) && /function unblockTitle\(/.test(adminSrc) &&
  /VIEWS\.blocked|blocked: \{ title: 'Blocked Titles'/.test(adminSrc));
t('5f unblock uses the shared confirmation dialog (not one-click)',
  /confirmDialog\(\{\s*\n?\s*title: 'Unblock title\?/.test(adminSrc));
t('5g picker + TMDB search mark already-blocked (no duplicate Block)',
  /Already-blocked results show BLOCKED/.test(adminSrc) && /badge-blocked', 'Blocked'/.test(adminSrc));
t('5h admin TMDB search still finds blocked titles (marks them)',
  /Admin search never hides blocked titles/.test(adminSrc) && /blockedKeys/.test(adminSrc));
t('5i stale-request guards on picker searches (blockedSearchGen)',
  /blockedSearchGen\+\+/.test(adminSrc) && /myGen !== blockedSearchGen/.test(adminSrc));
t('5j mutations verify with read-back (never trust status alone)',
  /readBlockedRow\(r\.media, r\.id\)/.test(adminSrc) && /read-back differs/.test(adminSrc) &&
  /read back 404|read back as blocked/.test(adminSrc));
t('5k loading/error/retry/empty states via existing primitives',
  /Loading blocked titles/.test(adminSrc) && /Blocked titles failed to load/.test(adminSrc) &&
  /No titles are currently blocked/.test(adminSrc) && /stateBox\(host, '(loading|error|empty)'/.test(adminSrc));
t('5l blocked styles in admin visual language (no giant CRUD table)',
  /\.blocked-workspace/.test(adminCss) && /\.badge-blocked/.test(adminCss) &&
  /\.blocked-card/.test(adminCss) && /\.blocked-confirm/.test(adminCss));

/* ---- 6. no token leaks, no unrelated changes ---- */
t('6a admin token never persisted (memory-only session intact)',
  !/localStorage\.(setItem|getItem)|sessionStorage\.(setItem|getItem)|document\.cookie\s*=/.test(adminSrc));
t('6b token never in responses/D1/URLs (routes)',
  !/GREYBOX_ADMIN_TOKEN/.test(dbSrc) && !/GREYBOX_ADMIN_TOKEN/.test(validateSrc) &&
  !/localStorage|sessionStorage/.test(blockedRoute + blockedItemRoute));
t('6c blocklist diff touches no playback/hero/provider files',
  (() => {
    try {
      const out = execSync('git diff --name-only && git ls-files --others --exclude-standard', { cwd: ROOT, stdio: 'pipe' }).toString();
      return !/stream\.js|greybox-player\.js|hero\.js|player\.css|plyr|hls/i.test(out);
    } catch { return false; }
  })());
t('6d blocklist adds no duplicate system (one table, one seam, one workspace)',
  (dbSrc.match(/blocked_titles/g) || []).length <= 8 &&
  (dataSrc.match(/function isBlockedContent|function blockedSet|function filterBlocked/g) || []).length === 3);

/* ---- 7. live behavioral checks: validate.js (real ESM import) ---- */
async function esmTests() {
  let V = null, DB = null;
  try { V = await import('../functions/lib/validate.js'); } catch (e) { V = null; }
  try { DB = await import('../functions/lib/db.js'); } catch (e) { DB = null; }
  t('7a validate.js loads as ESM', !!V);
  t('7b db.js loads as ESM', !!DB);

  if (V) {
    const ok = (fn) => { try { fn(); return true; } catch { return false; } };
    t('7c movie block identity validates', !!V.validateBlockedBody({ media: 'movie', tmdb_id: 12345 }));
    t('7d TV block identity validates', !!V.validateBlockedBody({ media: 'tv', tmdb_id: 67890 }));
    const a = V.validateBlockedBody({ media: 'movie', tmdb_id: 1, title: 'A' });
    const b = V.validateBlockedBody({ media: 'movie', tmdb_id: 1, title: 'Totally Different' });
    t('7e title text never participates in identity', a.media === b.media && a.tmdb_id === b.tmdb_id);
    t('7f malformed media_type rejected', !ok(() => V.validateBlockedBody({ media: 'music', tmdb_id: 1 })) &&
      !ok(() => V.validateBlockedBody({ media: 'MOVIE', tmdb_id: 1 })) &&
      !ok(() => V.validateBlockedBody({ tmdb_id: 1 })));
    t('7g malformed TMDB IDs rejected', !ok(() => V.validateBlockedBody({ media: 'movie', tmdb_id: 0 })) &&
      !ok(() => V.validateBlockedBody({ media: 'movie', tmdb_id: -5 })) &&
      !ok(() => V.validateBlockedBody({ media: 'movie', tmdb_id: 'abc' })) &&
      !ok(() => V.validateBlockedBody({ media: 'movie' })));
    t('7h non-object bodies rejected', !ok(() => V.validateBlockedBody(null)) &&
      !ok(() => V.validateBlockedBody([])) && !ok(() => V.validateBlockedBody('movie:1')));
    t('7i snapshot fields bounded (poster must be TMDB path)',
      !ok(() => V.validateBlockedBody({ media: 'movie', tmdb_id: 1, poster_path: 'https://evil/x.jpg' })) &&
        !!V.validateBlockedBody({ media: 'movie', tmdb_id: 1, poster_path: '/abc.jpg', year: '1999' }));
  }

  /* ---- 8. live behavioral checks: db.js with fake D1 ---- */
  if (DB) {
    function fakeDb() {
      const rows = new Map(); // key media:id -> row
      const order = []; // insertion order (created_at DESC = reverse)
      return {
        prepare(sql) {
          const norm = String(sql).replace(/\s+/g, ' ').trim();
          const st = {
            _p: [],
            bind(...p) { st._p = p; return st; },
            async first() {
              if (/WHERE media = \? AND tmdb_id = \?/.test(norm)) {
                return rows.get(st._p[0] + ':' + st._p[1]) || null;
              }
              return null;
            },
            async all() {
              if (/FROM blocked_titles ORDER BY created_at DESC/.test(norm)) {
                return { results: order.slice().reverse().map((k) => rows.get(k)) };
              }
              if (/FROM blocked_titles ORDER BY media ASC/.test(norm)) {
                return { results: order.slice().sort().map((k) => {
                  const r = rows.get(k);
                  return { media: r.media, id: r.tmdb_id };
                }) };
              }
              return { results: [] };
            },
            async run() {
              if (/INSERT INTO blocked_titles/.test(norm)) {
                const [media, tmdb_id, title, poster_path, backdrop_path, year] = st._p;
                const now = new Date().toISOString();
                rows.set(media + ':' + tmdb_id, { media, tmdb_id, title, poster_path, backdrop_path, year, created_at: now, updated_at: now });
                order.push(media + ':' + tmdb_id);
                return { meta: { changes: 1 } };
              }
              if (/DELETE FROM blocked_titles/.test(norm)) {
                const k = st._p[0] + ':' + st._p[1];
                const had = rows.delete(k);
                const i = order.indexOf(k);
                if (i >= 0) order.splice(i, 1);
                return { meta: { changes: had ? 1 : 0 } };
              }
              return { meta: { changes: 0 } };
            },
          };
          return st;
        },
      };
    }
    const db = fakeDb();
    const created = await DB.createBlocked(db, { media: 'movie', tmdb_id: 550, title: 'Fight Club', poster_path: '/p.jpg', backdrop_path: null, year: '1999' });
    t('8a block a movie (identity + snapshot round-trip)',
      !!created && created.media === 'movie' && created.tmdb_id === 550 && created.title === 'Fight Club');
    let dup = null;
    try { await DB.createBlocked(db, { media: 'movie', tmdb_id: 550, title: 'Fight Club' }); } catch (e) { dup = e; }
    t('8b duplicate block prevented (409)', !!dup && dup.status === 409);
    const cross = await DB.createBlocked(db, { media: 'tv', tmdb_id: 550, title: 'Same ID TV' });
    t('8c same TMDB ID across movie/tv stays independent', !!cross && cross.media === 'tv');
    const pub = await DB.readPublicBlocked(db);
    t('8d public read is identity-only (no snapshots/internals)',
      Array.isArray(pub) && pub.length === 2 &&
      pub.every((r) => Object.keys(r).sort().join(',') === 'id,media') &&
      pub.some((r) => r.media === 'movie' && r.id === 550) &&
      pub.some((r) => r.media === 'tv' && r.id === 550));
    t('8e unblock removes exactly one identity',
      (await DB.deleteBlocked(db, 'movie', 550)) === true &&
      (await DB.readBlocked(db, 'movie', 550)) === null &&
      (await DB.readBlocked(db, 'tv', 550)) !== null);
    t('8f unblock of missing row reports false (not silent success)',
      (await DB.deleteBlocked(db, 'movie', 550)) === false);
    t('8g malformed identity reads return null (never throw)',
      (await DB.readBlocked(db, 'music', 1)) === null && (await DB.readBlocked(db, 'movie', 0)) === null);
  }

  /* ---- 9. live behavioral checks: data.js central filter (vm sandbox) ---- */
  function loadData(blocked, apiStubs) {
    const windowStub = { GreyboxBlocked: blocked };
    if (apiStubs) windowStub.API = apiStubs;
    const sandbox = {
      window: windowStub,
      console,
      setTimeout, clearTimeout,
      AbortController: globalThis.AbortController,
      fetch: async () => { throw new Error('no network in tests'); },
      localStorage: { getItem: () => null, setItem: () => {} },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(dataSrc, sandbox, { filename: 'data.js' });
    return sandbox.window.GreyboxData;
  }

  const blocked = [{ media: 'movie', id: 1 }, { media: 'tv', id: 2 }];
  const D = loadData(blocked, null);
  t('9a data.js loads headless with blocklist fallback', !!D && typeof D.isBlockedContent === 'function');
  if (D) {
    t('9b movie block identity', D.isBlockedContent('movie', 1) === true);
    t('9c TV block identity', D.isBlockedContent('tv', 2) === true);
    t('9d same TMDB ID across movie/tv stays independent',
      D.isBlockedContent('tv', 1) === false && D.isBlockedContent('movie', 2) === false);
    t('9e unblocked titles remain visible', D.isBlockedContent('movie', 999) === false && D.isBlockedContent('tv', 999) === false);
    t('9f malformed inputs are simply not blocked (never throw)',
      D.isBlockedContent('music', 1) === false && D.isBlockedContent('movie', 0) === false &&
      D.isBlockedContent(null, 1) === false);
    const items = [
      { id: 1, media_type: 'movie', title: 'Blocked Movie', poster_path: '/a.jpg' },
      { id: 1, media_type: 'tv', title: 'Same ID TV (allowed)', poster_path: '/b.jpg' },
      { id: 2, media_type: 'tv', title: 'Blocked Show', poster_path: '/c.jpg' },
      { id: 3, media_type: 'movie', title: 'Fine Film', poster_path: '/d.jpg' },
    ];
    const before = items.length;
    const kept = D.filterBlocked(items);
    t('9g filterBlocked drops exact identities only (order kept, input untouched)',
      kept.length === 2 && kept[0].id === 1 && kept[0].media_type === 'tv' && kept[1].id === 3 && items.length === before);
    t('9h title text never filters (renamed blocked movie still caught by id; same title unblocked passes)',
      D.filterBlocked([{ id: 1, media_type: 'movie', title: 'Completely Different Name', poster_path: '/x.jpg' }]).length === 0 &&
      D.filterBlocked([{ id: 77, media_type: 'movie', title: 'Blocked Movie', poster_path: '/x.jpg' }]).length === 1);
  }

  // Pipeline behavior with stubbed Greybox API.
  const item = (id, mt) => ({
    id, media_type: mt, title: 'T' + id, name: 'T' + id, overview: '',
    poster_path: '/p' + id + '.jpg', backdrop_path: null,
    vote_average: 7, release_date: mt === 'movie' ? '2000-01-01' : '', first_air_date: mt === 'tv' ? '2000-01-01' : '',
  });
  const apiStubs = {
    getRegion: () => 'US',
    gb: {
      trending: async () => ({ page: 1, total_pages: 1, total_results: 3, results: [item(1, 'movie'), item(2, 'tv'), item(3, 'movie')] }),
      movies: async () => ({ page: 1, total_pages: 1, total_results: 2, results: [item(1, 'movie'), item(3, 'movie')] }),
      tvList: async () => ({ page: 1, total_pages: 1, total_results: 2, results: [item(2, 'tv'), item(4, 'tv')] }),
      anime: async () => ({ page: 1, total_pages: 1, total_results: 1, results: [item(5, 'tv')] }),
      search: async (q) => ({ query: q, page: 1, total_pages: 1, total_results: 3, results: [item(1, 'movie'), item(2, 'tv'), item(3, 'movie')] }),
      movie: async (id) => item(id, 'movie'),
      show: async (id) => item(id, 'tv'),
      season: async (id, n) => ({ id, season_number: n, name: 'S' + n, episodes: [] }),
    },
    tmdb: async (p) => {
      if (String(p).indexOf('discover/') === 0) {
        return { page: 1, total_pages: 1, total_results: 3, results: [item(1, 'movie'), item(3, 'movie'), item(6, 'movie')] };
      }
      if (String(p).indexOf('person/') === 0) {
        return { id: 9, name: 'Someone', cast: [{ media_type: 'movie', id: 1, popularity: 9 }, { media_type: 'movie', id: 3, popularity: 8 }] };
      }
      throw new Error('unexpected tmdb path ' + p);
    },
  };
  const P = loadData(blocked, apiStubs);
  if (P) {
    const tr = await P.getTrending(1);
    t('9i trending filters blocked (home/hero source)', tr.results.length === 1 && tr.results[0].id === 3);
    const mo = await P.getPopularMovies(1);
    t('9j movies list filters blocked', mo.results.length === 1 && mo.results[0].id === 3);
    const tv = await P.getPopularTV(1);
    t('9k TV list filters blocked', tv.results.length === 1 && tv.results[0].id === 4);
    const se = await P.getSearchResults('t', 1);
    t('9l public search filters blocked titles', se.results.length === 1 && se.results[0].id === 3);
    const su = await P.getSuggestions('t', 8);
    t('9m suggestions (header dropdown) filter blocked', su.results.length === 1 && su.results[0].id === 3);
    const di = await P.getDiscover({ media: 'movie' });
    t('9n discover/genre filters blocked', di.results.length === 2 && di.results.every((x) => x.id !== 1));
    const ids = await P.resolveIdItems([{ media: 'movie', id: 1 }, { media: 'movie', id: 3 }]);
    t('9o hand-picked id lists drop blocked (custom/tag/pins)', ids.length === 1 && ids[0].id === 3);
    let blockedErr = null;
    try { await P.getMovie(1); } catch (e) { blockedErr = e; }
    t('9p direct movie detail for blocked ID refuses rendering', !!blockedErr && blockedErr.blocked === true);
    let blockedTvErr = null;
    try { await P.getTVDetails(2); } catch (e) { blockedTvErr = e; }
    t('9q direct TV detail for blocked ID refuses rendering', !!blockedTvErr && blockedTvErr.blocked === true);
    const okMovie = await P.getMovie(3);
    const okTv = await P.getTVDetails(4);
    t('9r unblocked details render normally', !!okMovie && okMovie.id === 3 && !!okTv && okTv.id === 4);
    const heroBlocked = await P.getHeroItem({ mode: 'spotlight', heroItem: { media: 'movie', id: 1 } });
    const heroOk = await P.getHeroItem({ mode: 'spotlight', heroItem: { media: 'movie', id: 3 } });
    t('9s blocked hero selection falls back (null), unblocked resolves',
      heroBlocked === null && !!heroOk && heroOk.id === 3);
  } else {
    t('9i–9s pipeline behavior (skipped: sandbox failed)', false);
  }
}

esmTests().then(() => {
  /* ---- 10. existing suites stay green ---- */
  let inc1 = false, inc1Out = '';
  try {
    inc1Out = execSync('node tests/greybox-player.test.cjs', { cwd: ROOT, stdio: 'pipe' }).toString();
    inc1 = /0 failed/.test(inc1Out);
  } catch (e) { inc1Out = String((e && e.stdout) || e).slice(-400); }
  t('10a Increment 1 suite green', inc1, inc1Out.slice(-200));
  let src = false, srcOut = '';
  try {
    srcOut = execSync('node tests/source-routing.test.cjs', { cwd: ROOT, stdio: 'pipe' }).toString();
    src = /0 failed/.test(srcOut);
  } catch (e) { srcOut = String((e && e.stdout) || e).slice(-400); }
  t('10b Increment 2 suite green', src, srcOut.slice(-200));

  console.log('\n' + pass + ' passed, ' + fail + ' failed.');
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.log('FAIL  harness error  — ' + ((e && e.message) || e));
  console.log('\n' + pass + ' passed, ' + (fail + 1) + ' failed.');
  process.exit(1);
});
