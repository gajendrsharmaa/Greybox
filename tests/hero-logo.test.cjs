/* Greybox Hero title artwork — focused tests (TMDB logo increment).
 * Run: node tests/hero-logo.test.cjs   (exit 0 = all pass)
 * No dependencies, no browser, no network.
 *
 * Covers: automatic TMDB-logo default (missing/older/unknown config tries
 * artwork, explicit text stays text-only, custom URL honored), ranked logo
 * selection (en > language-neutral > other, highest-rated wins, hostile
 * paths rejected), item-carried logo reuse (no duplicate fetch), per-identity
 * caching, stale guards (slow/previous-hero responses can never paint over
 * the current hero; hero change/loading/error/reset clear synchronously),
 * text fallback (never both, never a broken icon), en+null language request,
 * proxy forwarding of include_image_language (Cloudflare + Vercel),
 * server/admin sanitizer parity, cinematic CSS rules (aspect preserved, caps,
 * mobile tuning), markup presence, 4-second trailer timing, and
 * stream.js / playback logic untouched.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  — ' + extra : '')); }
}

const heroSrc = read('js/hero.js');
const heroCss = read('css/hero.css');
const indexHtml = read('index.html');
const cfProxy = read('functions/api/tmdb/[[path]].js');
const vercelProxy = read('api/tmdb/[...path].js');
const validateSrc = read('functions/lib/validate.js');
const adminSrc = read('js/admin.js');
const streamSrc = read('js/stream.js');
const readme = read('README.md');

/* ---- 1. source-shape: automatic default + explicit opt-outs ---- */
t('H1 default presentation tries the TMDB logo automatically',
  /artwork:\s*\{\s*backdrop:\s*'auto',\s*backdropUrl:\s*'',\s*logo:\s*'tmdb'/.test(heroSrc));
t('H2 sanitize keeps explicit text-only and custom, defaults the rest to tmdb',
  /a\.logo === 'custom' \? 'custom' : \(a\.logo === 'text' \? 'text' : 'tmdb'\)/.test(heroSrc));
t('H3 custom without a valid URL still falls back to text (never broken)',
  /if \(out\.artwork\.logo === 'custom' && !out\.artwork\.logoUrl\) out\.artwork\.logo = 'text'/.test(heroSrc));
t('H4 explicit text short-circuits: no logo, no fetch',
  /\/\/ Explicit text-only title: never a logo, never a fetch\.\s*\n\s*if \(art\.logo === 'text'\) \{ clearLogo\(\); return; \}/.test(heroSrc));

/* ---- 2. source-shape: selection + data flow ---- */
t('H5 ranked selection prefers en, then language-neutral, then others',
  /lang === 'en'\) \? 0 : \(lang === '' \? 1 : 2\)/.test(heroSrc));
t('H6 selection breaks rank ties by community rating (vote_average, vote_count)',
  /vote > bestVote \|\| \(vote === bestVote && count > bestCount\)/.test(heroSrc));
t('H7 hostile logo paths are rejected (no .. escape, strict charset)',
  heroSrc.indexOf("fp.indexOf('..') >= 0") >= 0 &&
  /\/\^\\\/\[A-Za-z0-9\/_\\-\.\]\+\$\//.test(heroSrc));
t('H8 item-carried logo data is reused before any fetch (no duplicate request)',
  (() => {
    const m = /function paintLogo[\s\S]*?\r?\n  \}\r?\n/.exec(heroSrc);
    if (!m) return false;
    const body = m[0];
    const carried = body.indexOf('itemLogoUrl(item)');
    const fetched = body.indexOf('/api/tmdb/');
    return carried >= 0 && fetched >= 0 && carried < fetched;
  })());
t('H9 previous hero logo is cleared synchronously before resolving the new one',
  (() => {
    const m = /function paintLogo[\s\S]*?\r?\n  \}\r?\n/.exec(heroSrc);
    if (!m) return false;
    const body = m[0];
    const carried = body.indexOf('var carried = itemLogoUrl(item);');
    const fetched = body.indexOf('/api/tmdb/');
    const cleared = body.indexOf('clearLogo();');
    return cleared >= 0 && carried >= 0 && fetched >= 0 && cleared < carried && carried < fetched;
  })());
t('H10 logo results are cached per media identity (no refetch per rotation)',
  /logoCache\[identity\] = (carried|picked)/.test(heroSrc) &&
  /hasOwnProperty\.call\(logoCache, identity\)/.test(heroSrc));
t('H11 logo request uses the existing proxy + en/null language preference',
  heroSrc.indexOf("'/api/tmdb/' + mt + '/' + id + '/images?language=en-US&include_image_language=en,null'") >= 0);
t('H12 async completions are generation- + identity-guarded (no stale paint)',
  /if \(myGen !== gen\) return;/.test(heroSrc) &&
  /currentIdentity !== expectedIdentity\) return;/.test(heroSrc));
t('H13 loading, error and reset states clear the logo (text stays visible)',
  /clearLogo\(\); \/\/ loading copy must be visible/.test(heroSrc) &&
  /clearLogo\(\); \/\/ error copy must be visible/.test(heroSrc) &&
  /function reset\(\) \{ stopTrailer\(\); clearLogo\(\); \}/.test(heroSrc));
t('H14 broken logo URLs fall back to text (onerror clears, never an icon)',
  /broken logo URL → text title/.test(heroSrc));

/* ---- 3. transport + sanitizer parity ---- */
t('H15 Cloudflare proxy forwards include_image_language',
  cfProxy.indexOf("'include_image_language'") >= 0 && cfProxy.indexOf('const fwd =') >= 0);
t('H16 Vercel proxy forwards include_image_language',
  vercelProxy.indexOf("'include_image_language'") >= 0 && vercelProxy.indexOf('FWD_PARAMS') >= 0);
t('H17 server validateArtwork matches the frontend default (custom/text/tmdb)',
  /const logo = v\.logo === 'custom' \? 'custom' : \(v\.logo === 'text' \? 'text' : 'tmdb'\);/.test(validateSrc));
t('H18 admin editor matches the frontend default (presentation + select)',
  (adminSrc.match(/a\.logo === 'custom' \? 'custom' : \(a\.logo === 'text' \? 'text' : 'tmdb'\)/g) || []).length >= 2);

/* ---- 4. markup + CSS ---- */
t('H19 hero markup carries both the logo img and the text h1',
  /<img id="hero-logo" class="gx-hero-logo hidden"/.test(indexHtml) &&
  /<h1 id="hero-title" class="gx-hero-title">/.test(indexHtml));
t('H20 logo CSS preserves aspect ratio (contain, auto dims — never boxed/cropped)',
  /\.gx-hero-logo\s*\{[^}]*width:\s*auto[^}]*height:\s*auto[^}]*object-fit:\s*contain/s.test(heroCss));
t('H21 logo CSS caps size sensibly on desktop',
  /\.gx-hero-logo\s*\{[^}]*max-width:\s*min\(26rem[^}]*max-height:\s*7\.5rem/s.test(heroCss));
t('H22 logo CSS tunes caps for mobile without changing aspect handling',
  /@media \(max-width: 640px\)[\s\S]*?\.gx-hero-logo\s*\{[^}]*max-height:\s*5\.5rem/s.test(heroCss));
t('H23 logo hidden state + text screen-reader state exist (never both visible)',
  /\.gx-hero-logo\.hidden\s*\{\s*display:\s*none;\s*\}/.test(heroCss) &&
  /\.gx-hero-title\.has-logo\s*\{[^}]*clip:\s*rect\(0 0 0 0\)/s.test(heroCss));

/* ---- 5. untouched systems ---- */
t('H24 4-second poster trailer timing',
  /var TRAILER_DELAY_MS = 4000;/.test(heroSrc) && /delaySec: 4/.test(heroSrc));
t('H25 stream.js carries no logo logic (playback/provider code untouched)',
  !/logo/i.test(streamSrc));
t('H26 README documents the hero title-logo behavior',
  /official TMDB logo artwork whenever a usable one exists/.test(readme) &&
  /normal text title otherwise/.test(readme));

/* ---- 6. behavioral checks (real hero.js in a stubbed DOM) ---- */
function makeElem() {
  const cls = new Set();
  const el = {
    textContent: '', innerHTML: '',
    src: '', alt: '', decoding: '',
    classList: {
      add(...c) { c.forEach((x) => cls.add(x)); },
      remove(...c) { c.forEach((x) => cls.delete(x)); },
      toggle(c, f) {
        if (f === undefined) { if (cls.has(c)) cls.delete(c); else cls.add(c); }
        else if (f) cls.add(c); else cls.delete(c);
      },
      contains(c) { return cls.has(c); },
    },
    setAttribute() {}, getAttribute() { return null; },
    removeAttribute(n) { if (n === 'src') el.src = ''; },
    addEventListener() {}, removeEventListener() {},
    offsetWidth: 0,
    style: {},
    contentWindow: null,
    onload: null, onerror: null,
  };
  el._has = (c) => cls.has(c);
  return el;
}

const IDS = ['hero', 'hero-title', 'hero-logo', 'hero-meta', 'hero-badge', 'hero-img',
  'hero-ambient', 'hero-trailer-wrap', 'hero-trailer', 'hero-trailer-btn',
  'hero-play', 'hero-info', 'hero-list', 'page-ambient', 'page-ambient-img'];

function loadHero(fetchImpl) {
  const els = {};
  for (const id of IDS) els[id] = makeElem();
  const calls = [];
  const sandbox = {
    window: {},
    module: { exports: {} },
    console,
    setTimeout, clearTimeout,
    document: {
      readyState: 'complete',
      hidden: false,
      addEventListener() {},
      getElementById(id) { return els[id] || null; },
    },
    fetch(url, opts) { calls.push(String(url)); return fetchImpl(String(url), opts); },
    Image() { return makeElem(); }, // stills never resolve headlessly; logo paths do not use Image
  };
  sandbox.window = { addEventListener() {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(heroSrc + '\nthis.__Hero = window.GreyboxHero;', sandbox, { filename: 'hero.js' });
  const Hero = sandbox.__Hero || (sandbox.window && sandbox.window.GreyboxHero);
  return { Hero, els, calls };
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 20));
const okJson = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
const MOVIE = { id: 550, media_type: 'movie', title: 'Fight Club', vote_average: 8.4, release_date: '1999-10-15' };
const TV = { id: 1399, media_type: 'tv', name: 'Game of Thrones', vote_average: 8.4, first_air_date: '2011-04-17' };

async function behavioral() {
  // B1: module surface.
  try {
    const { Hero } = loadHero(() => Promise.reject(new Error('offline')));
    t('H27 hero module loads with the logo surface',
      !!Hero && typeof Hero.setHero === 'function' && typeof Hero.pickLogoUrl === 'function' &&
      Hero.TRAILER_DELAY_MS === 4000);
  } catch (e) {
    t('H27 hero module loads with the logo surface', false, String((e && e.message) || e));
  }

  // B2/B3: defaults + explicit text.
  try {
    const { Hero } = loadHero(() => Promise.reject(new Error('offline')));
    t('H28 default presentation is automatic TMDB logo',
      Hero.getPresentation().artwork.logo === 'tmdb');
    Hero.configureHero({ artwork: { logo: 'text' } });
    t('H29 explicit text stays text-only',
      Hero.getPresentation().artwork.logo === 'text');
    Hero.configureHero(undefined);
    t('H30 missing config returns to automatic',
      Hero.getPresentation().artwork.logo === 'tmdb');
  } catch (e) {
    t('H28 default presentation is automatic TMDB logo', false, String((e && e.message) || e));
  }

  // B4: logo available (movie) — en preferred over other languages.
  try {
    const { Hero, els } = loadHero(() => okJson({ logos: [
      { file_path: '/fr.png', iso_639_1: 'fr', vote_average: 9.9, vote_count: 99 },
      { file_path: '/en.png', iso_639_1: 'en', vote_average: 5.0, vote_count: 5 },
    ] }));
    Hero.setHero({ ...MOVIE });
    await tick();
    t('H31 movie hero with a logo shows artwork (en preferred), text kept for readers',
      els['hero-logo'].src === 'https://image.tmdb.org/t/p/w500/en.png' &&
      !els['hero-logo']._has('hidden') &&
      els['hero-title']._has('has-logo') &&
      els['hero-title'].textContent === 'Fight Club');
  } catch (e) {
    t('H31 movie hero with a logo shows artwork (en preferred), text kept for readers', false, String((e && e.message) || e));
  }

  // B5/B6: no logo + fetch failure fall back to text.
  try {
    const a = loadHero(() => okJson({ logos: [] }));
    a.Hero.setHero({ ...MOVIE });
    await tick();
    const b = loadHero(() => Promise.reject(new Error('offline')));
    b.Hero.setHero({ ...MOVIE });
    await tick();
    t('H32 hero without a logo falls back to the normal title (no logo shown)',
      a.els['hero-logo']._has('hidden') && !a.els['hero-title']._has('has-logo') &&
      a.els['hero-title'].textContent === 'Fight Club' &&
      b.els['hero-logo']._has('hidden') && b.els['hero-title'].textContent === 'Fight Club');
  } catch (e) {
    t('H32 hero without a logo falls back to the normal title (no logo shown)', false, String((e && e.message) || e));
  }

  // B7: TV identity + language query.
  try {
    const { Hero, calls } = loadHero(() => okJson({ logos: [] }));
    Hero.setHero({ ...TV });
    await tick();
    t('H33 TV hero requests its own identity with the en/null language preference',
      calls.length === 1 && calls[0] === '/api/tmdb/tv/1399/images?language=en-US&include_image_language=en,null');
  } catch (e) {
    t('H33 TV hero requests its own identity with the en/null language preference', false, String((e && e.message) || e));
  }

  // B8/B9: rotation — synchronous clear + stale drop.
  try {
    const resolvers = [];
    const { Hero, els } = loadHero((url) => new Promise((res) => resolvers.push(() => res({
      ok: true, json: () => Promise.resolve({ logos: [{ file_path: '/' + (/\/api\/tmdb\/(?:movie|tv)\/(\d+)\/images/.exec(url) || [])[1] + '.png', iso_639_1: 'en' }] }),
    }))));
    Hero.setHero({ id: 1, media_type: 'movie', title: 'Alpha' });
    Hero.setHero({ id: 2, media_type: 'movie', title: 'Beta' });
    const clearedSync = els['hero-logo']._has('hidden') && !els['hero-title']._has('has-logo') &&
      els['hero-title'].textContent === 'Beta';
    resolvers[0](); // slow Alpha response lands after Beta took over
    await tick();
    const noStale = els['hero-logo'].src.indexOf('/movie.png') < 0;
    resolvers[1](); // Beta response lands
    await tick();
    t('H34 rotation clears synchronously and a stale logo never paints over the new hero',
      clearedSync && noStale &&
      els['hero-logo'].src === 'https://image.tmdb.org/t/p/w500/2.png' &&
      els['hero-title']._has('has-logo'));
  } catch (e) {
    t('H34 rotation clears synchronously and a stale logo never paints over the new hero', false, String((e && e.message) || e));
  }

  // B10: loading/error/reset clear.
  try {
    const { Hero, els } = loadHero(() => okJson({ logos: [{ file_path: '/x.png', iso_639_1: 'en' }] }));
    Hero.setHero({ ...MOVIE });
    await tick();
    const shown = !els['hero-logo']._has('hidden');
    Hero.setLoading(true);
    const loadingClear = els['hero-logo']._has('hidden') && !els['hero-title']._has('has-logo');
    Hero.setHero({ ...MOVIE });
    await tick();
    Hero.showError('nope');
    const errorClear = els['hero-logo']._has('hidden') && els['hero-title'].textContent === 'Could not load';
    Hero.setHero({ ...MOVIE });
    await tick();
    Hero.reset();
    const resetClear = els['hero-logo']._has('hidden') && !els['hero-title']._has('has-logo');
    t('H35 loading/error/reset clear a previously shown logo', shown && loadingClear && errorClear && resetClear);
  } catch (e) {
    t('H35 loading/error/reset clear a previously shown logo', false, String((e && e.message) || e));
  }

  // B11/B12: explicit text + custom skip the fetch; custom applies directly.
  try {
    const a = loadHero(() => okJson({ logos: [{ file_path: '/x.png', iso_639_1: 'en' }] }));
    a.Hero.configureHero({ artwork: { logo: 'text' } });
    a.Hero.setHero({ ...MOVIE });
    await tick();
    const b = loadHero(() => { throw new Error('must not fetch'); });
    b.Hero.configureHero({ artwork: { logo: 'custom', logoUrl: 'https://example.com/logo.png' } });
    b.Hero.setHero({ ...MOVIE });
    t('H36 explicit text never fetches; custom logo applies with zero TMDB requests',
      a.calls.length === 0 && a.els['hero-logo']._has('hidden') &&
      b.els['hero-logo'].src === 'https://example.com/logo.png' &&
      !b.els['hero-logo']._has('hidden'));
  } catch (e) {
    t('H36 explicit text never fetches; custom logo applies with zero TMDB requests', false, String((e && e.message) || e));
  }

  // B13: carried item data reused (no fetch).
  try {
    const { Hero, els, calls } = loadHero(() => { throw new Error('must not fetch'); });
    Hero.setHero({ ...MOVIE, logo_path: '/carried.png' });
    t('H37 logo data already on the item is reused (no duplicate request)',
      calls.length === 0 && els['hero-logo'].src === 'https://image.tmdb.org/t/p/w500/carried.png' &&
      els['hero-title']._has('has-logo'));
  } catch (e) {
    t('H37 logo data already on the item is reused (no duplicate request)', false, String((e && e.message) || e));
  }

  // B14: pure selection units.
  try {
    const { Hero } = loadHero(() => Promise.reject(new Error('offline')));
    const pick = Hero.pickLogoUrl;
    const W = 'https://image.tmdb.org/t/p/w500';
    t('H38 pickLogoUrl ranks en > neutral > other and vote_average within rank',
      pick({ logos: [
        { file_path: '/fr.png', iso_639_1: 'fr', vote_average: 9.9, vote_count: 500 },
        { file_path: '/null.png', iso_639_1: null, vote_average: 1.0 },
        { file_path: '/en-low.png', iso_639_1: 'en', vote_average: 2.0 },
        { file_path: '/en-high.png', iso_639_1: 'en', vote_average: 8.0, vote_count: 3 },
      ] }) === W + '/en-high.png' &&
      pick({ logos: [
        { file_path: '/fr.png', iso_639_1: 'fr', vote_average: 9.9 },
        { file_path: '/null.png', iso_639_1: null, vote_average: 1.0 },
      ] }) === W + '/null.png' &&
      pick({ logos: [] }) === '' && pick(null) === '' && pick({}) === '' &&
      pick({ logos: [{ file_path: '/../evil.png', iso_639_1: 'en' }, { file_path: '/ok.png', iso_639_1: 'en' }] }) === W + '/ok.png');
  } catch (e) {
    t('H38 pickLogoUrl ranks en > neutral > other and vote_average within rank', false, String((e && e.message) || e));
  }

  // B15: broken image falls back to text.
  try {
    const { Hero, els } = loadHero(() => okJson({ logos: [{ file_path: '/x.png', iso_639_1: 'en' }] }));
    Hero.setHero({ ...MOVIE });
    await tick();
    els['hero-logo'].onerror();
    t('H39 a broken logo image falls back to the text title',
      els['hero-logo']._has('hidden') && !els['hero-title']._has('has-logo') &&
      els['hero-title'].textContent === 'Fight Club');
  } catch (e) {
    t('H39 a broken logo image falls back to the text title', false, String((e && e.message) || e));
  }
}

behavioral().then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('Harness error:', (e && e.stack) || e);
  process.exit(1);
});
