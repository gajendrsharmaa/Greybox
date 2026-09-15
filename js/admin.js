/* Greybox Admin Control Center (Part 0) — vanilla JS, no framework, no router.
 *
 * AUTH MODEL (unchanged): the operator pastes the GREYBOX_ADMIN_TOKEN
 * server secret into the connect screen. It lives ONLY in the `ADMIN_TOKEN`
 * variable below — plain page memory for the lifetime of this tab. It is
 * NEVER written to source code, localStorage, sessionStorage, cookies, D1,
 * the URL, or any API response. Reload / Disconnect forgets it immediately.
 * Every /api/admin/* request carries it as an `Authorization: Bearer` header;
 * a 401/403 at any point drops back to the connect screen. No server-side
 * session store exists (and none is needed: adding one would only create
 * CSRF/session-fixation surface for a single-operator tool).
 *
 * The panel talks ONLY to the protected management API and the public read
 * API for verification links. It never touches D1 directly and contains no
 * SQL. After every mutation it re-reads from the API instead of assuming
 * success.
 *
 * PART 1 — Dashboard + Home control: Home workspace (hero strip + sections),
 * scannable dashboard config, source-type filter, grouped section editor,
 * saving states. CRUD/validation/endpoints unchanged.
 *
 * PART 2 — Hero Control Center: Home hero + per-collection heroes (separate
 * scope), shared artwork/trailer editors, read-only previews, read-modify-
 * write saves so scopes never clobber each other.
 *
 * PART 3 — Collections Control Center: workspace cards (count, type/media
 * filters, hero relationship, public links), grouped collection editor
 * (Identity / Content source / Presentation / Hero / Advanced), unsaved
 * preview through the existing public Greybox APIs, save read-back
 * verification, hero-override cleanup on delete. No new backend: same
 * /api/admin/collections + /api/admin/settings/collection-heroes routes,
 * same D1 collections table, same visible/hidden + sort_order semantics.
 *
 * PART 4 — Overrides Control Center: workspace cards (poster thumb from
 * override artwork with zero per-row fetches, media + Pick filters on real
 * row data, live counts), TMDB search-first creation (identity locked to
 * media + TMDB ID, stale-guarded), grouped editor (Identity / Metadata /
 * Artwork / Editorial) over exactly the 11 allowlisted keys, per-field
 * TMDB-vs-override status with true Reset (clear = field removed on save),
 * unsaved TMDB-vs-GREYBOX preview mirroring applyOverrides, Pick ON/OFF
 * switch on the same row (no second Pick system), save read-back
 * verification and delete-then-404 verification. No new backend: same
 * /api/admin/overrides routes, same D1 overrides table.
 *
 * PART 4.5 — Custom Tags (editorial content groups): Tags workspace (cards
 * with live counts, local search + visibility filter), tag editor (Identity
 * / Presentation / Usage, slug-suggest, permanent slugs), Manage Titles
 * (TMDB multi-select add, chunked cached stale-guarded title resolution,
 * reorder, membership-only remove), real usage display + delete blocked
 * while referenced (409). `tag` source type in Home + Collection editors
 * (same resolveTagItems rule public renders use). Backend: new D1
 * tags/tag_members tables (migration 0003) + /api/admin/tags* +
 * /api/config/tags; overrides custom_badge untouched.
 */
(function () {
  'use strict';

  /* ---------------- in-memory session (NOT persisted anywhere) ---------------- */
  let ADMIN_TOKEN = null;

  const $ = (id) => document.getElementById(id);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------------- API client (management API only) ---------------- */
  const API = {
    homeSections: '/api/admin/home-sections',
    collections: '/api/admin/collections',
    tags: '/api/admin/tags',
    overrides: '/api/admin/overrides',
    blocked: '/api/admin/blocked',
    navigation: '/api/admin/navigation',
    hero: '/api/admin/settings/home-hero',
    colHeroes: '/api/admin/settings/collection-heroes',
    detailPages: '/api/admin/settings/detail-pages',
    playback: '/api/admin/settings/playback',
  };

  async function api(path, opts) {
    const o = opts || {};
    const headers = { 'Content-Type': 'application/json' };
    if (ADMIN_TOKEN) headers.Authorization = 'Bearer ' + ADMIN_TOKEN;
    let res;
    try {
      res = await fetch(path, {
        method: o.method || 'GET',
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
      });
    } catch (e) {
      throw { status: 0, message: 'Network error: could not reach the server.' };
    }
    if (res.status === 204) return null;
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.status === 401 || res.status === 403) {
      forceDisconnect(res.status === 403
        ? 'Invalid admin token. Please reconnect.'
        : 'Not connected. Please sign in with the admin token.');
      throw { status: res.status, message: (data && data.error) || 'Not authorized.' };
    }
    if (!res.ok) throw { status: res.status, message: (data && data.error) || ('Request failed (' + res.status + ').') };
    return data;
  }

  /* ---------------- toast + notice primitives ---------------- */
  function toast(kind, text) {
    try {
      const root = $('toast-root');
      if (!root) return;
      const msg = String(text == null ? '' : text);
      const cls = 'toast ' + (kind === 'ok' ? 'ok' : 'err');
      // Deduplicate: an identical toast already on screen (e.g. a retried
      // Block Title that fails the same way twice) must not stack — the
      // screenshot showed two identical "Internal error." toasts for one
      // underlying failure. Refresh the existing toast instead of doubling.
      const kids = root.children;
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        if (k && k.className === cls && k.textContent === msg) {
          // Move the existing toast to the end so its lifetime feels fresh,
          // without creating a visual duplicate.
          try { root.appendChild(k); } catch { /* noop */ }
          return;
        }
      }
      const t = document.createElement('div');
      t.className = cls;
      t.textContent = msg;
      root.appendChild(t);
      while (root.children.length > 4) root.removeChild(root.firstChild);
      setTimeout(() => { try { if (t.isConnected) t.remove(); } catch { /* noop */ } }, kind === 'ok' ? 5000 : 8000);
    } catch { /* toast must never break flows */ }
  }

  let noticeTimer = 0;
  let lastNoticeKey = '';
  let lastNoticeAt = 0;
  function notice(kind, text) {
    const n = $('admin-notice');
    const msg = String(text == null ? '' : text);
    // Deduplicate rapid identical notices (same kind+text within 1.5s):
    // without this, a single failed Block click could surface as a banner
    // plus two stacked toasts. The banner still refreshes; the toast does not double.
    const key = kind + '|' + msg;
    const now = (typeof Date.now === 'function') ? Date.now() : 0;
    const dup = (key === lastNoticeKey) && (now - lastNoticeAt < 1500);
    lastNoticeKey = key;
    lastNoticeAt = now;
    if (!n) { if (!dup) toast(kind, msg); return; }
    n.classList.remove('hidden');
    n.className = 'notice ' + (kind === 'ok' ? 'ok' : 'err');
    n.textContent = msg;
    if (!dup) toast(kind, msg);
    if (noticeTimer) clearTimeout(noticeTimer);
    if (kind === 'ok') noticeTimer = setTimeout(() => n.classList.add('hidden'), 6000);
  }

  /* ---------------- confirmation dialog primitive ---------------- */
  let confirmState = null;
  function confirmDialog(opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      const dlg = $('confirm-dialog');
      const scrim = $('confirm-scrim');
      if (!dlg || !scrim) {
        try { resolve(window.confirm(o.message || 'Are you sure?')); } catch { resolve(false); }
        return;
      }
      if (confirmState) { try { confirmState.resolve(false); } catch { /* noop */ } }
      $('confirm-title').textContent = o.title || 'Are you sure?';
      $('confirm-desc').textContent = o.message || '';
      const okBtn = $('confirm-ok');
      okBtn.textContent = o.okLabel || 'Delete';
      const prevFocus = document.activeElement;
      confirmState = { resolve, prevFocus };
      const close = (val) => {
        dlg.classList.add('hidden');
        scrim.classList.add('hidden');
        dlg.setAttribute('aria-hidden', 'true');
        confirmState = null;
        try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch { /* noop */ }
        resolve(val);
      };
      confirmState.close = close;
      $('confirm-cancel').onclick = () => close(false);
      okBtn.onclick = () => close(true);
      scrim.onclick = () => close(false);
      dlg.classList.remove('hidden');
      scrim.classList.remove('hidden');
      dlg.setAttribute('aria-hidden', 'false');
      try { okBtn.focus(); } catch { /* noop */ }
    });
  }

  /* ---------------- editor drawer primitive ---------------- */
  let drawerPrevFocus = null;
  let drawerDirty = false;
  let drawerForm = null;

  function setDrawerDirty(on) {
    drawerDirty = !!on;
    const bar = $('drawer-dirty');
    if (bar) bar.classList.toggle('hidden', !drawerDirty);
  }

  function openDrawer(opts) {
    const o = opts || {};
    const drawer = $('editor-drawer');
    const scrim = $('drawer-scrim');
    const body = $('drawer-body');
    if (!drawer || !scrim || !body) return null;
    drawerPrevFocus = document.activeElement;
    $('drawer-kicker').textContent = o.kicker || 'Editor';
    $('drawer-title').textContent = o.title || 'Edit item';
    $('drawer-sub').textContent = o.sub || '';
    body.innerHTML = '';
    if (o.node) body.appendChild(o.node);
    drawerForm = o.form || body.querySelector('form') || null;
    setDrawerDirty(false);
    if (drawerForm) {
      drawerForm.addEventListener('input', () => setDrawerDirty(true));
      drawerForm.addEventListener('change', () => setDrawerDirty(true));
    }
    drawer.classList.remove('hidden');
    scrim.classList.remove('hidden');
    drawer.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    try {
      const first = body.querySelector('input:not([disabled]), select, textarea, button');
      if (first && first.focus) first.focus();
    } catch { /* noop */ }
    return body;
  }

  function closeDrawer() {
    const drawer = $('editor-drawer');
    const scrim = $('drawer-scrim');
    if (!drawer) return;
    drawer.classList.add('hidden');
    if (scrim) scrim.classList.add('hidden');
    drawer.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    setDrawerDirty(false);
    drawerForm = null;
    previewReader = null;
    colPreviewGen++;
    ovGen++;
    ovSearchGen++;
    tagDetailGen++;
    tagAddGen++;
    blockedSearchGen++;
    navGen++;
    dpGen++;
    pbGen++;
    try { if (drawerPrevFocus && drawerPrevFocus.focus) drawerPrevFocus.focus(); } catch { /* noop */ }
    drawerPrevFocus = null;
  }

  function isDrawerOpen() {
    const d = $('editor-drawer');
    return !!(d && !d.classList.contains('hidden'));
  }

  /* ---------------- navigation / views ---------------- */
  const VIEWS = {
    dashboard: { title: 'Dashboard', sub: 'Control Center' },
    sections: { title: 'Home', sub: 'Content' },
    heroes: { title: 'Heroes', sub: 'Content' },
    collections: { title: 'Collections', sub: 'Content' },
    tags: { title: 'Tags', sub: 'Content' },
    overrides: { title: 'Overrides', sub: 'Content' },
    blocked: { title: 'Blocked Titles', sub: 'Content' },
    navigation: { title: 'Navigation', sub: 'Experience' },
    detail: { title: 'Detail Pages', sub: 'Experience' },
    playback: { title: 'Playback', sub: 'Experience' },
    picks: { title: 'Greybox Picks', sub: 'Content' },
    search: { title: 'TMDB Search', sub: 'Content' },
    settings: { title: 'General Settings', sub: 'Site' },
    soon: { title: 'Coming soon', sub: 'Roadmap' },
  };
  let currentView = 'dashboard';
  // Active roadmap item when the Soon panel is shown ({ label, group }).
  let currentSoon = null;

  // opts is display-only ({ label, group } for the Soon panel); omitting it
  // keeps every existing showView(name)/showTab(name) call working as before.
  function showView(name, opts) {
    const key = VIEWS[name] ? name : 'dashboard';
    currentView = key;
    if (key === 'soon') {
      const o = (opts && typeof opts === 'object') ? opts : {};
      const label = String((o.label != null ? o.label : '')).trim() || 'Coming soon';
      const group = String((o.group != null ? o.group : '')).trim() || 'Roadmap';
      currentSoon = { label, group };
    } else {
      currentSoon = null;
    }
    document.querySelectorAll('#admin-nav .nav-item[data-view]').forEach((b) => {
      const on = b.dataset.view === key && (key !== 'soon' || b.dataset.soon === (currentSoon && currentSoon.label));
      b.classList.toggle('is-active', on);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    document.querySelectorAll('.admin-view').forEach((p) => p.classList.add('hidden'));
    const panel = $('view-' + key);
    if (panel) panel.classList.remove('hidden');
    // Breadcrumb reads [section] / [workspace], e.g. Content / Heroes.
    const meta = VIEWS[key];
    const section = key === 'soon' && currentSoon ? currentSoon.group : (meta.sub || meta.title);
    const workspace = key === 'soon' && currentSoon ? currentSoon.label : meta.title;
    if ($('crumb-section')) $('crumb-section').textContent = section;
    if ($('crumb-sub')) $('crumb-sub').textContent = (section === workspace) ? '' : workspace;
    if (key === 'soon' && currentSoon) {
      if ($('soon-title')) $('soon-title').textContent = currentSoon.label;
      if ($('soon-desc')) $('soon-desc').textContent = currentSoon.label + ' is on the Control Center roadmap and has no editor yet. Dashboard, Home, Heroes, Collections, Tags, Overrides, Blocked Titles, Navigation, Detail Pages, Playback, Greybox Picks, TMDB Search and General Settings are live.';
    }
    closeMobileNav();
    if (!ADMIN_TOKEN) return;
    if (key === 'dashboard') loadDashboard();
    if (key === 'sections') { loadHomeHero(); loadSections(); }
    if (key === 'heroes') loadHeroes();
    if (key === 'collections') loadCollections();
    if (key === 'tags') loadTags();
    if (key === 'overrides') loadOverrides();
    if (key === 'blocked') loadBlocked();
    if (key === 'navigation') loadNavigation();
    if (key === 'detail') loadDetailPages();
    if (key === 'playback') loadPlayback();
    if (key === 'picks') loadPicks();
    if (key === 'settings') loadHero();
  }

  // Back-compat alias (previous tab system + headless tests).
  function showTab(name) {
    const map = { sections: 'sections', collections: 'collections', overrides: 'overrides', search: 'search', settings: 'settings' };
    showView(map[name] || 'dashboard');
  }

  function setAuthed(on, msg) {
    $('admin-connect-wrap').classList.toggle('hidden', on);
    $('admin-app').classList.toggle('hidden', !on);
    const pill = $('conn-pill');
    if (pill) {
      pill.classList.toggle('is-live', !!on);
      const t = $('conn-text');
      if (t) t.textContent = on ? 'Connected — token in memory' : 'Disconnected';
    }
    if (!on) {
      const e = $('admin-connect-error');
      if (msg && e) { e.textContent = msg; e.classList.remove('hidden'); }
      const pw = $('admin-token');
      if (pw) pw.value = '';
      closeDrawer();
    }
  }

  function forceDisconnect(msg) {
    ADMIN_TOKEN = null;
    setAuthed(false, msg);
  }

  function openMobileNav() {
    const s = $('admin-sidebar');
    const scrim = $('nav-scrim');
    if (!s) return;
    s.classList.add('open');
    if (scrim) scrim.classList.remove('hidden');
    const t = $('nav-toggle');
    if (t) t.setAttribute('aria-expanded', 'true');
  }
  function closeMobileNav() {
    const s = $('admin-sidebar');
    const scrim = $('nav-scrim');
    if (s) s.classList.remove('open');
    if (scrim) scrim.classList.add('hidden');
    const t = $('nav-toggle');
    if (t) t.setAttribute('aria-expanded', 'false');
  }

  /* ---------------- client-side validation (mirrors functions/lib/validate.js) ---------------- */
  const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const HOME_MOVIE_CATS = ['popular', 'top-rated', 'upcoming', 'now-playing'];
  const HOME_TV_CATS = ['popular', 'top-rated', 'on-the-air', 'airing-today'];
  const HOME_SOURCE_TYPES = ['trending', 'movies', 'tv', 'anime', 'search', 'ids', 'genre', 'collection', 'tag'];
  const COL_SOURCE_TYPES = ['trending', 'popular', 'top-rated', 'now-playing', 'discover', 'genre', 'year', 'search', 'custom', 'tag'];
  const OVERRIDE_FIELDS = ['title', 'name', 'overview', 'description', 'poster_path', 'backdrop_path', 'vote_average', 'release_date', 'first_air_date', 'featured', 'custom_badge'];

  function vSlug(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s || s.length > 64 || !SLUG_RE.test(s)) return 'slug must match [a-z0-9-] (lowercase, max 64 chars)';
    return null;
  }
  function vReqStr(v, label, min, max) {
    if (typeof v !== 'string' || !v.trim()) return min > 0 ? (label + ' is required') : null;
    if (v.trim().length > max) return label + ' must be at most ' + max + ' characters';
    return null;
  }
  function vOptStr(v, label, max) {
    if (v == null || v === '') return null;
    if (typeof v !== 'string') return label + ' must be a string';
    if (v.length > max) return label + ' must be at most ' + max + ' characters';
    return null;
  }
  function vInt(v, label, min, max, optional) {
    if ((v === '' || v == null) && optional) return null;
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    if (!Number.isInteger(n) || n < min || n > max) return label + ' must be an integer ' + min + '..' + max;
    return null;
  }
  function vTmdbId(v) {
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    if (!Number.isInteger(n) || n < 1 || n > 2147483647) return 'TMDB id must be a positive integer';
    return null;
  }
  function vSource(src, allowed) {
    if (!src || typeof src !== 'object' || typeof src.type !== 'string') return 'source.type is required';
    if (allowed.indexOf(src.type) < 0) return 'unknown source type: ' + src.type;
    const t = src.type;
    if (t === 'search' && !String(src.query || '').trim()) return 'search needs a query';
    if (t === 'genre') {
      const isCollection = allowed.indexOf('discover') >= 0;
      if (isCollection && src.media === 'both') {
        if (!src.genre || typeof src.genre !== 'object') return 'genre needs a movie + TV genre selection';
        if (!(parseInt(src.genre.movie_id, 10) > 0) || !(parseInt(src.genre.tv_id, 10) > 0)) return 'genre needs both a movie genre and a TV genre';
        if (!String(src.genre.name || '').trim()) return 'genre needs a name';
        return null;
      }
      if (src.media != null && src.media !== 'movie' && src.media !== 'tv') return "media must be 'movie' or 'tv'";
      if (!(parseInt(src.genreId, 10) > 0)) return 'genre needs a genreId';
    }
    if (t === 'collection') {
      const s = String(src.slug || '').trim().toLowerCase();
      if (!s) return 'collection needs a slug';
      if (s.length > 64 || !SLUG_RE.test(s)) return 'collection slug must match [a-z0-9-] (lowercase, max 64 chars)';
      return null;
    }
    if (t === 'tag') {
      const s = String(src.tag || '').trim().toLowerCase();
      if (!s) return 'tag source needs a tag';
      if (s.length > 64 || !SLUG_RE.test(s)) return 'tag slug must match [a-z0-9-] (lowercase, max 64 chars)';
      return null;
    }
    if (t === 'year' && !/^\d{4}$/.test(String(src.year || '').trim())) return 'year must be YYYY';
    if ((t === 'ids' || t === 'custom') && (!Array.isArray(src.items) || !src.items.length)) return 'source needs at least one item';
    if (t === 'movies' && HOME_MOVIE_CATS.indexOf(String(src.category || 'popular').toLowerCase()) < 0 && allowed === HOME_SOURCE_TYPES) return 'unknown movies category';
    if (t === 'tv' && HOME_TV_CATS.indexOf(String(src.category || 'popular').toLowerCase()) < 0 && allowed === HOME_SOURCE_TYPES) return 'unknown tv category';
    if (t === 'now-playing' && src.media != null && src.media !== 'movie') return 'now-playing is movies only';
    return null;
  }

  // Lines like `movie:550` or bare `550` (movie). Returns {ok, items, error}.
  function parseEntryLines(text) {
    const items = [];
    const lines = String(text || '').split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line[0] === '#') continue;
      const m = /^(movie|tv)\s*:\s*(\d+)$/i.exec(line);
      if (m) { items.push({ media: m[1].toLowerCase(), id: parseInt(m[2], 10) }); continue; }
      if (/^\d+$/.test(line)) { items.push({ media: 'movie', id: parseInt(line, 10) }); continue; }
      return { ok: false, items: [], error: 'Bad entry line (use media:id or bare id): ' + line.slice(0, 40) };
    }
    return { ok: true, items, error: null };
  }

  function parseMetaText(text) {
    const t = String(text || '').trim();
    if (!t) return { ok: true, value: null, error: null };
    try {
      const v = JSON.parse(t);
      if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, value: null, error: 'meta must be a JSON object' };
      return { ok: true, value: v, error: null };
    } catch {
      return { ok: false, value: null, error: 'meta must be valid JSON' };
    }
  }

  function summarizeSource(src) {
    if (!src || typeof src.type !== 'string') return '—';
    const bits = [src.type];
    if (src.slug) bits.push('/collection/' + src.slug);
    if (src.tag) bits.push('tag ' + src.tag);
    if (src.category) bits.push(src.category);
    if (src.kind) bits.push(src.kind);
    if (src.media) bits.push(src.media);
    if (src.query) bits.push('“' + src.query + '”');
    if (src.genreId != null) bits.push('genre ' + src.genreId);
    if (src.genre != null) {
      if (typeof src.genre === 'object' && src.genre !== null) {
        const nm = src.genre.name ? src.genre.name + ' ' : '';
        bits.push('genre ' + nm + '(' + src.genre.movie_id + '/' + src.genre.tv_id + ')');
      } else {
        bits.push('genre ' + src.genre);
      }
    }
    if (src.year != null) bits.push(String(src.year));
    if (Array.isArray(src.items)) bits.push(src.items.length + ' ids');
    if (src.sort && src.sort !== 'popularity.desc') bits.push(src.sort);
    return bits.join(' · ');
  }

  /* ---------------- shared DOM builders (admin primitives) ---------------- */
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fieldRow(labelText, input) {
    const wrap = el('label', 'block');
    wrap.appendChild(el('span', 'flabel', labelText));
    wrap.appendChild(input);
    return wrap;
  }

  function textInput(id, value, placeholder) {
    const i = document.createElement('input');
    i.id = id; i.type = 'text';
    i.value = value == null ? '' : String(value);
    if (placeholder) i.placeholder = placeholder;
    i.className = 'input';
    return i;
  }

  function numInput(id, value, placeholder) {
    const i = textInput(id, value, placeholder);
    i.type = 'number'; i.min = '0';
    return i;
  }

  function areaInput(id, value, placeholder, rows) {
    const t = document.createElement('textarea');
    t.id = id; t.rows = rows || 3;
    t.value = value == null ? '' : String(value);
    if (placeholder) t.placeholder = placeholder;
    t.className = 'input';
    return t;
  }

  function selectInput(id, options, value) {
    const s = document.createElement('select');
    s.id = id;
    s.className = 'input input-select';
    for (const [v, label] of options) {
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      if (v === value) o.selected = true;
      s.appendChild(o);
    }
    return s;
  }

  function checkInput(id, checked, labelText) {
    const wrap = el('label', 'flex items-center gap-2 text-sm cursor-pointer');
    wrap.style.cssText = 'display:flex;align-items:center;gap:.5rem;font-size:.83rem;color:var(--gx-text-dim);cursor:pointer';
    const c = document.createElement('input');
    c.id = id; c.type = 'checkbox'; c.checked = !!checked;
    c.className = 'w-4 h-4';
    wrap.appendChild(c);
    wrap.appendChild(el('span', '', labelText));
    return wrap;
  }

  function statusBadge(item) {
    const hidden = item && item.visible === false;
    const b = el('span', 'badge ' + (hidden ? 'badge-hidden' : 'badge-live'), hidden ? 'Hidden' : 'Visible');
    return b;
  }

  function rowButtons(defs) {
    const wrap = el('div', 'row-actions');
    for (const [label, kind, fn, title, disabled] of defs) {
      const b = el('button', 'rowbtn ' + (kind || ''), label);
      b.type = 'button';
      if (title) b.title = title;
      if (disabled) { b.disabled = true; b.setAttribute('aria-disabled', 'true'); }
      else b.addEventListener('click', fn);
      wrap.appendChild(b);
    }
    return wrap;
  }

  // Visual grouping inside editor drawers (presentation only — all fields preserved).
  function groupBox(title, nodes) {
    const g = el('div', 'editor-group');
    g.appendChild(el('span', 'editor-group-title', title));
    (nodes || []).forEach((n) => { if (n) g.appendChild(n); });
    return g;
  }

  // Saving state: disables every button in the editor form (+ drawer savebar),
  // relabels submit controls to "Saving…", restores everything in `finally`.
  // Validation errors thrown before the API call still restore via finally.
  function setFormSaving(form, on) {
    const btns = [];
    try {
      if (form && form.querySelectorAll) Array.prototype.push.apply(btns, form.querySelectorAll('button'));
    } catch { /* noop */ }
    const ds = $('drawer-save');
    if (ds) btns.push(ds);
    btns.forEach((b) => {
      if (on) {
        if (b.dataset._label === undefined) b.dataset._label = b.textContent;
        b.disabled = true;
        if (b.type === 'submit' || b.id === 'drawer-save') b.textContent = 'Saving…';
      } else {
        b.disabled = false;
        if (b.dataset._label !== undefined) { b.textContent = b.dataset._label; delete b.dataset._label; }
      }
    });
  }

  function stateBox(host, kind, title, desc) {
    host.innerHTML = '';
    const box = el('div', kind === 'error' ? 'error-box' : kind === 'loading' ? 'loading-box' : 'empty');
    if (kind === 'loading') {
      box.appendChild(el('p', '', title || 'Loading…'));
      const sk = el('div', 'skel');
      sk.style.width = '100%';
      box.appendChild(sk);
    } else {
      box.appendChild(el('p', 'empty-title', title || 'Nothing here'));
      if (desc) box.appendChild(el('p', 'empty-desc', desc));
    }
    host.appendChild(box);
    return box;
  }

  /* ---------------- TMDB genre lists (via existing server-side proxy) ---------------- */
  const GENRE_CACHE = { movie: null, tv: null };
  const GENRE_PENDING = { movie: null, tv: null };

  function fetchGenres(media) {
    const mt = media === 'tv' ? 'tv' : 'movie';
    if (GENRE_CACHE[mt]) return Promise.resolve(GENRE_CACHE[mt]);
    if (GENRE_PENDING[mt]) return GENRE_PENDING[mt];
    const p = fetch('/api/tmdb/genre/' + mt + '/list?language=en-US', { headers: { accept: 'application/json' } })
      .then((r) => {
        if (!r.ok) throw new Error('Genre list failed (' + r.status + ')');
        return r.json();
      })
      .then((d) => {
        const list = Array.isArray(d && d.genres) ? d.genres : [];
        const clean = list
          .filter((g) => g && Number.isInteger(g.id) && g.id > 0 && typeof g.name === 'string' && g.name.trim())
          .map((g) => ({ id: g.id, name: g.name.trim() }))
          .sort((a, b) => a.name.localeCompare(b.name));
        if (!clean.length) throw new Error('Genre list empty');
        GENRE_CACHE[mt] = clean;
        GENRE_PENDING[mt] = null;
        return clean;
      })
      .catch((e) => {
        GENRE_PENDING[mt] = null;
        throw e;
      });
    GENRE_PENDING[mt] = p;
    return p;
  }

  function genreName(media, id) {
    const mt = media === 'tv' ? 'tv' : 'movie';
    const list = GENRE_CACHE[mt];
    if (!list) return '';
    const n = parseInt(id, 10);
    const found = list.find((g) => g.id === n);
    return found ? found.name : '';
  }

  /* ---------------- source sub-form (shared by sections, collections, hero) ---------------- */
  function renderSourceFields(host, prefix, allowed, src) {
    host.innerHTML = '';
    const s = src && typeof src === 'object' ? src : {};
    const typeSel = selectInput(prefix + '-type', allowed.map((t) => [t, t]), s.type || allowed[0]);
    host.appendChild(fieldRow('Source type', typeSel));
    const sub = el('div', 'grid');
    sub.style.cssText = 'display:grid;gap:.7rem';
    host.appendChild(sub);
    const paint = () => {
      sub.innerHTML = '';
      const t = typeSel.value;
      const val = (k, d) => (s[k] == null ? (d == null ? '' : d) : s[k]);
      if (t === 'trending' || t === 'popular' || t === 'top-rated') {
        sub.appendChild(fieldRow('Media', selectInput(prefix + '-media', [['movie', 'movie'], ['tv', 'tv']].concat(t === 'trending' ? [['all', 'all']] : []), val('media', t === 'trending' ? 'all' : 'movie'))));
      } else if (t === 'movies') {
        sub.appendChild(fieldRow('Category', selectInput(prefix + '-category', HOME_MOVIE_CATS.map((c) => [c, c]), val('category', 'popular'))));
      } else if (t === 'tv') {
        sub.appendChild(fieldRow('Category', selectInput(prefix + '-category', HOME_TV_CATS.map((c) => [c, c]), val('category', 'popular'))));
      } else if (t === 'now-playing') {
        const p = el('p', 'muted text-sm', 'Movies only — no extra options.');
        sub.appendChild(p);
      } else if (t === 'anime') {
        sub.appendChild(fieldRow('Kind', selectInput(prefix + '-kind', [['series', 'series'], ['movies', 'movies']], val('kind', 'series'))));
      } else if (t === 'search') {
        sub.appendChild(fieldRow('Query', textInput(prefix + '-query', val('query', ''), 'dune')));
      } else if (t === 'ids' || t === 'custom') {
        const lines = Array.isArray(s.items) ? s.items.map((it) => (it && typeof it === 'object' ? it.media + ':' + it.id : it)).join('\n') : '';
        sub.appendChild(fieldRow(t === 'custom' ? 'Items (one per line: media:id or bare movie id)' : 'Items (one per line: media:id)', areaInput(prefix + '-items', lines, 'movie:550\ntv:1399', 4)));
      } else if (t === 'genre') {
        const isCollection = allowed.indexOf('discover') >= 0;
        const mediaOpts = isCollection
          ? [['movie', 'Movies'], ['tv', 'TV Shows'], ['both', 'Movies + TV Shows']]
          : [['movie', 'Movies'], ['tv', 'TV Shows']];
        let curMedia = val('media', 'movie');
        if (curMedia !== 'movie' && curMedia !== 'tv' && curMedia !== 'both') curMedia = 'movie';
        if (!isCollection && curMedia === 'both') curMedia = 'movie';
        const mediaSel = selectInput(prefix + '-media', mediaOpts, curMedia);
        sub.appendChild(fieldRow('Media', mediaSel));
        const genreHost = el('div', '');
        genreHost.style.cssText = 'display:grid;gap:.7rem';
        sub.appendChild(genreHost);
        sub.appendChild(fieldRow('Sort', textInput(prefix + '-sort', val('sort', 'popularity.desc'), 'popularity.desc')));
        let genreGen = 0;
        const paintGenres = () => {
          const myGen = ++genreGen;
          const m = mediaSel.value;
          genreHost.innerHTML = '';
          if (m === 'both' && isCollection) {
            let bothMovieId = (s.genre && typeof s.genre === 'object' && s.genre.movie_id) ? String(s.genre.movie_id) : '';
            let bothTvId = (s.genre && typeof s.genre === 'object' && s.genre.tv_id) ? String(s.genre.tv_id) : '';
            if (!bothMovieId && s.genreId) bothMovieId = String(s.genreId);
            if (!bothTvId && s.genreId && s.media === 'tv') bothTvId = String(s.genreId);
            const movieWrap = el('div', '');
            const tvWrap = el('div', '');
            movieWrap.appendChild(el('span', 'flabel', 'Movie genre (TMDB movie list)'));
            tvWrap.appendChild(el('span', 'flabel', 'TV genre (TMDB TV list — IDs differ)'));
            const mLoad = el('p', 'muted text-sm', 'Loading movie genres…');
            const tLoad = el('p', 'muted text-sm', 'Loading TV genres…');
            movieWrap.appendChild(mLoad);
            tvWrap.appendChild(tLoad);
            genreHost.appendChild(movieWrap);
            genreHost.appendChild(tvWrap);
            genreHost.appendChild(el('p', 'muted text-sm', 'Movies fetch /discover/movie, TV fetch /discover/tv, then combine. Movies link to /movie/:id, TV to /tv/:id.'));
            Promise.all([fetchGenres('movie'), fetchGenres('tv')]).then(
              ([movieList, tvList]) => {
                if (myGen !== genreGen) return;
                movieWrap.innerHTML = '';
                tvWrap.innerHTML = '';
                movieWrap.appendChild(el('span', 'flabel', 'Movie genre (TMDB movie list)'));
                tvWrap.appendChild(el('span', 'flabel', 'TV genre (TMDB TV list — IDs differ)'));
                const mSel = selectInput(prefix + '-genreMovie', movieList.map((g) => [String(g.id), g.name]), bothMovieId || String((movieList[0] && movieList[0].id) || ''));
                const tSel = selectInput(prefix + '-genreTv', tvList.map((g) => [String(g.id), g.name]), bothTvId || String((tvList[0] && tvList[0].id) || ''));
                movieWrap.appendChild(mSel);
                tvWrap.appendChild(tSel);
              },
              () => {
                if (myGen !== genreGen) return;
                movieWrap.innerHTML = '';
                tvWrap.innerHTML = '';
                movieWrap.appendChild(el('span', 'flabel', 'Movie genre ID (list unavailable — check backend TMDB setup)'));
                tvWrap.appendChild(el('span', 'flabel', 'TV genre ID'));
                movieWrap.appendChild(numInput(prefix + '-genreMovie', bothMovieId, '27'));
                tvWrap.appendChild(numInput(prefix + '-genreTv', bothTvId, '9648'));
              }
            );
          } else {
            const mt = m === 'tv' ? 'tv' : 'movie';
            let existingId = val('genreId', '');
            if ((existingId === '' || existingId == null) && s.media === 'both' && s.genre && typeof s.genre === 'object') {
              existingId = mt === 'tv' ? s.genre.tv_id : s.genre.movie_id;
            }
            genreHost.appendChild(el('p', 'muted text-sm', 'Loading genres from TMDB…'));
            fetchGenres(mt).then(
              (list) => {
                if (myGen !== genreGen) return;
                genreHost.innerHTML = '';
                const sel = selectInput(prefix + '-genreId', list.map((g) => [String(g.id), g.name]), String(existingId || (list[0] && list[0].id) || ''));
                genreHost.appendChild(fieldRow('Genre (TMDB ' + mt + ' list)', sel));
              },
              () => {
                if (myGen !== genreGen) return;
                genreHost.innerHTML = '';
                genreHost.appendChild(fieldRow('Genre ID (list unavailable — check backend TMDB setup)', numInput(prefix + '-genreId', existingId, '27')));
              }
            );
          }
        };
        mediaSel.onchange = paintGenres;
        paintGenres();
      } else if (t === 'discover') {
        sub.appendChild(fieldRow('Media', selectInput(prefix + '-media', [['movie', 'movie'], ['tv', 'tv']], val('media', 'movie'))));
        sub.appendChild(fieldRow('Genre ID (optional)', numInput(prefix + '-genre', val('genre', ''), '878')));
        sub.appendChild(fieldRow('Year (optional)', numInput(prefix + '-year', val('year', ''), '2024')));
        sub.appendChild(fieldRow('Sort', textInput(prefix + '-sort', val('sort', 'popularity.desc'), 'popularity.desc')));
      } else if (t === 'year') {
        sub.appendChild(fieldRow('Media', selectInput(prefix + '-media', [['movie', 'movie'], ['tv', 'tv']], val('media', 'movie'))));
        sub.appendChild(fieldRow('Year', numInput(prefix + '-year', val('year', ''), '1999')));
        sub.appendChild(fieldRow('Sort', textInput(prefix + '-sort', val('sort', 'popularity.desc'), 'popularity.desc')));
      } else if (t === 'collection') {
        const cur = String(val('slug', '') || '').trim().toLowerCase();
        const slugHost = el('div', '');
        slugHost.style.cssText = 'display:grid;gap:.7rem';
        sub.appendChild(slugHost);
        slugHost.appendChild(el('p', 'muted text-sm', 'Loading collections…'));
        const stillCurrent = () => {
          try {
            if (!slugHost.isConnected) return false;
            if (typeSel.value !== 'collection') return false;
          } catch { /* noop */ }
          return true;
        };
        const fillSelect = (list) => {
          if (!stillCurrent()) return;
          slugHost.innerHTML = '';
          const arr = Array.isArray(list) ? list.filter((c) => c && typeof c.slug === 'string' && c.slug) : [];
          if (arr.length) {
            const opts = arr.map((c) => [c.slug, c.title ? c.slug + ' — ' + c.title : c.slug]);
            if (cur && !opts.some(([v]) => v === cur)) opts.unshift([cur, cur + ' (current)']);
            slugHost.appendChild(fieldRow('Collection (existing slug)', selectInput(prefix + '-collection', opts, cur || opts[0][0])));
          } else {
            slugHost.appendChild(fieldRow('Collection slug', textInput(prefix + '-collection', cur, 'kids')));
          }
          slugHost.appendChild(el('p', 'muted text-sm', 'Preview shows the first N of this collection; View All → opens /collection/<slug>. Same rule, no second list.'));
        };
        const fillText = () => {
          if (!stillCurrent()) return;
          slugHost.innerHTML = '';
          slugHost.appendChild(fieldRow('Collection slug', textInput(prefix + '-collection', cur, 'kids')));
          slugHost.appendChild(el('p', 'muted text-sm', 'Type an existing collection slug (e.g. kids). Preview + View All use that collection’s rule.'));
        };
        fetch('/api/config/collections', { headers: { accept: 'application/json' } }).then((r) => {
          if (!r.ok) throw new Error('no public list');
          return r.json();
        }).then(fillSelect, () => {
          api(API.collections).then(fillSelect, fillText);
        });
      } else if (t === 'tag') {
        const cur = String(val('tag', '') || '').trim().toLowerCase();
        const tagHost = el('div', '');
        tagHost.style.cssText = 'display:grid;gap:.7rem';
        sub.appendChild(tagHost);
        tagHost.appendChild(el('p', 'muted text-sm', 'Loading tags…'));
        const stillCurrent = () => {
          try {
            if (!tagHost.isConnected) return false;
            if (typeSel.value !== 'tag') return false;
          } catch { /* noop */ }
          return true;
        };
        const labelOf = (g) => (g && typeof g.slug === 'string' && g.slug)
          ? (g.name ? g.slug + ' — ' + g.name : g.slug)
          : '';
        const fillTagSelect = (list) => {
          if (!stillCurrent()) return;
          tagHost.innerHTML = '';
          const arr = Array.isArray(list) ? list.filter((g) => g && typeof g.slug === 'string' && g.slug) : [];
          if (arr.length) {
            const opts = arr.map((g) => [g.slug, labelOf(g)]);
            if (cur && !opts.some(([v]) => v === cur)) opts.unshift([cur, cur + ' (current)']);
            tagHost.appendChild(fieldRow('Tag (existing)', selectInput(prefix + '-tag', opts, cur || opts[0][0])));
          } else {
            tagHost.appendChild(fieldRow('Tag slug', textInput(prefix + '-tag', cur, 'kids-fav')));
          }
          tagHost.appendChild(el('p', 'muted text-sm', 'Membership order is the content order (tag order). The section/collection limit still applies; pins still lead and excludes still drop in collections. Manage titles in Content → Tags.'));
        };
        const fillTagText = () => {
          if (!stillCurrent()) return;
          tagHost.innerHTML = '';
          tagHost.appendChild(fieldRow('Tag slug', textInput(prefix + '-tag', cur, 'kids-fav')));
          tagHost.appendChild(el('p', 'muted text-sm', 'Type an existing tag slug (e.g. kids-fav). Unknown or hidden tags skip the shelf instead of rendering a broken row.'));
        };
        // Public list needs no auth and shows what the site can actually
        // resolve; fall back to the authed list (hidden tags included).
        fetch('/api/config/tags', { headers: { accept: 'application/json' } }).then((r) => {
          if (!r.ok) throw new Error('no public list');
          return r.json();
        }).then(fillTagSelect, () => {
          api(API.tags).then(fillTagSelect, fillTagText);
        });
      }
    };
    typeSel.onchange = paint;
    paint();
  }

  function readSource(prefix) {
    const v = (id) => { const n = document.getElementById(id); return n ? n.value : ''; };
    const type = v(prefix + '-type');
    const src = { type };
    const numOrEmpty = (raw) => (String(raw || '').trim() === '' ? '' : parseInt(raw, 10));
    if (document.getElementById(prefix + '-media')) {
      const m = v(prefix + '-media');
      if (m) src.media = m;
    }
    if (document.getElementById(prefix + '-category')) src.category = v(prefix + '-category');
    if (document.getElementById(prefix + '-kind')) src.kind = v(prefix + '-kind');
    if (document.getElementById(prefix + '-query')) src.query = v(prefix + '-query');
    if (document.getElementById(prefix + '-sort')) { const s = v(prefix + '-sort'); if (s.trim()) src.sort = s.trim(); }
    if (document.getElementById(prefix + '-genreMovie') && document.getElementById(prefix + '-genreTv')) {
      const mid = parseInt(String(v(prefix + '-genreMovie') || '').trim(), 10);
      const tid = parseInt(String(v(prefix + '-genreTv') || '').trim(), 10);
      const mName = genreName('movie', mid) || genreName('tv', tid) || '';
      src.genre = { name: (mName || 'Genre').slice(0, 64), movie_id: mid, tv_id: tid };
    } else if (document.getElementById(prefix + '-genreId')) { const n = numOrEmpty(v(prefix + '-genreId')); if (n !== '') src.genreId = n; }
    if (document.getElementById(prefix + '-genre') && !src.genre) { const n = numOrEmpty(v(prefix + '-genre')); if (n !== '') src.genre = n; }
    if (document.getElementById(prefix + '-year')) { const n = numOrEmpty(v(prefix + '-year')); if (n !== '') src.year = n; }
    if (document.getElementById(prefix + '-collection')) { const s = String(v(prefix + '-collection') || '').trim().toLowerCase(); if (s) src.slug = s; }
    if (document.getElementById(prefix + '-tag')) { const s = String(v(prefix + '-tag') || '').trim().toLowerCase(); if (s) src.tag = s; }
    if (document.getElementById(prefix + '-items')) {
      const parsed = parseEntryLines(v(prefix + '-items'));
      if (!parsed.ok) throw { message: parsed.error };
      src.items = parsed.items;
    }
    return src;
  }

  /* ================= HOME HERO strip (summary — full editing lives in Heroes) ================= */
  // Single shared interpretation of the Home Hero (mirrors the public
  // resolver in js/data.js getHeroItem, without fetching): exactly ONE
  // field is authoritative per mode — spotlight honors heroItem, custom
  // honors source+pick, follow-grid honors the grid. Anything else stored
  // on the row is a preserved-but-inactive candidate. Returns the resolved
  // { media, id } or null when it resolves at runtime (grid / rule source).
  function heroResolvedIdentity(hero) {
    try {
      if (!hero || typeof hero !== 'object') return null;
      const validItem = (it) => (it && (it.media === 'movie' || it.media === 'tv') &&
        Number.isInteger(it.id) && it.id > 0 && it.id <= 2147483647)
        ? { media: it.media, id: it.id } : null;
      if (hero.mode === 'spotlight') return validItem(hero.heroItem);
      if (hero.mode === 'custom' && hero.source && typeof hero.source === 'object') {
        if (hero.source.type === 'ids' && Array.isArray(hero.source.items) && hero.source.items.length) {
          const valid = hero.source.items.map(validItem).filter(Boolean);
          if (!valid.length) return null;
          const pick = Math.max(0, parseInt(hero.pick, 10) || 0);
          return valid[pick] || valid[0];
        }
      }
    } catch { /* no resolved identity on anything unexpected */ }
    return null;
  }

  function heroSummaryText(hero) {
    if (!hero || typeof hero !== 'object') return 'Hero settings unavailable.';
    const mode = hero.mode === 'custom' ? 'Custom spotlight' : (hero.mode === 'spotlight' ? 'Spotlight title' : 'Follow-grid');
    const bits = [mode];
    if (hero.mode === 'spotlight') {
      if (hero.heroItem) bits.push(hero.heroItem.media + ':' + hero.heroItem.id);
    } else if (hero.mode === 'custom') {
      if (hero.badge) bits.push('“' + hero.badge + '”');
      bits.push('pick ' + (hero.pick != null ? hero.pick : 0));
      if (hero.source) bits.push(summarizeSource(hero.source));
      // heroItem is spotlight-only: preserved on the row but ignored by the
      // public renderer in custom mode — label it inactive, never as the hero.
      if (hero.heroItem) bits.push('spotlight candidate ' + hero.heroItem.media + ':' + hero.heroItem.id + ' (inactive in custom mode)');
    } else {
      bits.push('banner follows the grid');
      if (hero.heroItem) bits.push('spotlight candidate ' + hero.heroItem.media + ':' + hero.heroItem.id + ' (inactive in follow-grid mode)');
    }
    // Configured items vs currently resolved hero — never imply one movie
    // while the public renderer uses another (same source of truth: D1
    // settings.home_hero, resolved per heroResolvedIdentity).
    const resolved = heroResolvedIdentity(hero);
    if (resolved) bits.push('resolved ' + resolved.media + ':' + resolved.id);
    else if (hero.mode === 'custom') bits.push('resolved at runtime: item #' + Math.max(0, parseInt(hero.pick, 10) || 0) + ' of the rule source');
    else if (hero.mode !== 'spotlight') bits.push('resolved at runtime: first grid item');
    const pres = heroPresentationOf(hero);
    if (pres.trailer.source === 'off') bits.push('trailer off');
    else if (pres.trailer.source === 'custom') bits.push('trailer ' + (pres.trailer.key || 'custom'));
    else if (pres.trailer.activation !== 'delayed' || pres.trailer.delaySec !== 4) {
      bits.push('trailer ' + pres.trailer.activation + ' ' + pres.trailer.delaySec + 's');
    }
    if (pres.artwork.backdrop === 'custom') bits.push('custom backdrop');
    if (pres.artwork.logo !== 'text') bits.push('logo ' + pres.artwork.logo);
    return bits.join(' · ');
  }

  async function loadHomeHero() {
    const target = $('home-hero-summary');
    if (!target) return;
    target.textContent = 'Loading hero configuration…';
    try {
      const hero = await api(API.hero);
      target.textContent = heroSummaryText(hero);
    } catch (e) {
      target.textContent = 'Hero settings unavailable — ' + (e.message || e);
    }
  }

  /* ================= HOME SECTIONS ================= */
  let secEditing = null; // id being edited, or null for create
  let secCache = [];

  function sectionEditorNode(item) {
    const f = document.createElement('form');
    f.id = 'sec-form';
    f.autocomplete = 'off';
    f.style.cssText = 'display:grid;gap:.8rem';
    f.appendChild(groupBox('Identity', [
      fieldRow('ID (lowercase letters/numbers/hyphens; set once)', textInput('s-id', item ? item.id : '', 'editors-picks')),
      fieldRow('Title', textInput('s-title', item ? item.title || '' : '', 'Editor’s Picks')),
      fieldRow('Description (optional)', textInput('s-desc', item ? item.description || '' : '', '')),
    ]));
    const srcHost = el('div', '');
    srcHost.style.cssText = 'display:grid;gap:.7rem';
    srcHost.id = 's-source';
    const srcLabel = el('div', '');
    srcLabel.appendChild(el('span', 'flabel', 'Rule source'));
    srcLabel.appendChild(srcHost);
    f.appendChild(groupBox('Content source', [srcLabel]));
    renderSourceFields(srcHost, 's-src', HOME_SOURCE_TYPES, item ? item.source : null);
    f.appendChild(groupBox('Display', [
      checkInput('s-visible', item ? item.visible !== false : true, 'Visible on homepage'),
      fieldRow('Limit (1–24)', numInput('s-limit', item && item.limit != null ? item.limit : 12, '12')),
      fieldRow('Sort order (optional, blank = keep/append)', numInput('s-sort', '', '')),
    ]));
    const row = el('div', '');
    row.style.cssText = 'display:flex;gap:.5rem;flex-wrap:wrap';
    const save = el('button', 'btn btn-primary btn-sm', item ? 'Save Changes' : 'Create section');
    save.type = 'submit';
    const cancel = el('button', 'btn btn-ghost btn-sm', 'Discard');
    cancel.type = 'button';
    cancel.addEventListener('click', closeDrawer);
    row.appendChild(save);
    row.appendChild(cancel);
    f.appendChild(row);
    f.addEventListener('submit', (e) => { e.preventDefault(); saveSection(); });
    return f;
  }

  function openSectionEditor(item) {
    secEditing = item ? item.id : null;
    const node = sectionEditorNode(item);
    openDrawer({
      kicker: 'Home',
      title: item ? 'Edit section' : 'New section',
      sub: item ? String(item.id) : 'Shelves render on the homepage in display order.',
      node,
      form: node,
    });
    const idEl = $('s-id');
    if (idEl && item) idEl.disabled = true;
    const cancelOld = $('s-cancel');
    if (cancelOld) cancelOld.remove();
  }

  // Back-compat: previous inline form API now opens the drawer.
  function buildSectionForm() { /* forms are built on demand inside the drawer */ }
  function fillSectionForm(item) {
    if (!ADMIN_TOKEN || !$('admin-app') || $('admin-app').classList.contains('hidden')) {
      // Headless/test context: build a detached form so read* helpers work.
      secEditing = item ? item.id : null;
      let host = $('sec-form-host-test');
      if (!host) { host = document.createElement('div'); host.id = 'sec-form-host-test'; host.style.display = 'none'; document.body.appendChild(host); }
      host.innerHTML = '';
      host.appendChild(sectionEditorNode(item));
      const idEl = $('s-id');
      if (idEl && item) idEl.disabled = true;
      return;
    }
    openSectionEditor(item);
  }

  function readSectionForm() {
    const id = $('s-id').value.trim().toLowerCase();
    const idErr = SLUG_RE.test(id) && id.length <= 64 ? null : 'id must match [a-z0-9-] (lowercase, max 64 chars)';
    if (!secEditing && idErr) throw { message: idErr };
    const title = $('s-title').value.trim();
    if (!title) throw { message: 'Title is required.' };
    if (title.length > 120) throw { message: 'Title must be at most 120 characters.' };
    const desc = $('s-desc').value;
    if (desc.length > 500) throw { message: 'Description must be at most 500 characters.' };
    const limit = parseInt($('s-limit').value, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 24) throw { message: 'Limit must be 1–24.' };
    const sortRaw = $('s-sort').value.trim();
    let sort_order;
    if (sortRaw !== '') {
      sort_order = parseInt(sortRaw, 10);
      if (!Number.isInteger(sort_order) || sort_order < 0 || sort_order > 100000) throw { message: 'Sort order must be 0–100000.' };
    }
    const source = readSource('s-src');
    const srcErr = vSource(source, HOME_SOURCE_TYPES);
    if (srcErr) throw { message: srcErr };
    const body = {
      id: secEditing || id,
      title, description: desc.trim(),
      visible: $('s-visible').checked,
      limit, source,
    };
    if (sort_order !== undefined) body.sort_order = sort_order;
    return body;
  }

  function filteredSections() {
    const q = String(($('sec-search') && $('sec-search').value) || '').trim().toLowerCase();
    const f = ($('sec-filter') && $('sec-filter').value) || 'all';
    const src = ($('sec-source') && $('sec-source').value) || 'all';
    return secCache.filter((s) => {
      if (f === 'visible' && s.visible === false) return false;
      if (f === 'hidden' && s.visible !== false) return false;
      if (src !== 'all' && (!s.source || s.source.type !== src)) return false;
      if (!q) return true;
      const hay = (s.id + ' ' + (s.title || '') + ' ' + (s.description || '') + ' ' + summarizeSource(s.source)).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  async function loadSections() {
    const host = $('sec-list');
    if (!host) return;
    stateBox(host, 'loading', 'Loading sections…');
    try {
      const list = await api(API.homeSections);
      secCache = Array.isArray(list) ? list : [];
      renderSections();
    } catch (e) {
      host.innerHTML = '';
      notice('err', 'Sections failed to load: ' + (e.message || e));
    }
  }

  function renderSections() {
    const host = $('sec-list');
    if (!host) return;
    const list = filteredSections();
    host.innerHTML = '';
    if (!secCache.length) {
      const box = stateBox(host, 'empty', 'No sections yet', 'Create the first homepage shelf — it appears immediately, no scrolling needed.');
      const b = el('button', 'btn btn-primary btn-sm', '+ New Section');
      b.type = 'button';
      b.addEventListener('click', () => openSectionEditor(null));
      box.appendChild(b);
      return;
    }
    if (!list.length) {
      stateBox(host, 'empty', 'No matches', 'Try a different search or filter.');
      return;
    }
    const lastIdx = secCache.length - 1;
    list.forEach((s) => {
      const idx = secCache.indexOf(s);
      const card = el('div', 'data-row');
      const head = el('div', 'row-top');
      head.appendChild(el('span', 'row-mono muted', String(idx + 1) + '.'));
      head.appendChild(el('span', 'row-title', s.title || s.id));
      head.appendChild(statusBadge(s));
      head.appendChild(el('span', 'row-mono muted', s.id + ' · limit ' + (s.limit != null ? s.limit : '?')));
      card.appendChild(head);
      card.appendChild(el('p', 'row-meta', summarizeSource(s.source) + (s.description ? ' — ' + s.description : '')));
      card.appendChild(rowButtons([
        ['Edit', 'go', () => openSectionEditor(s)],
        [s.visible === false ? 'Show' : 'Hide', '', () => toggleSection(s), s.visible === false ? 'Make visible on homepage' : 'Hide from homepage'],
        ['↑ Up', '', () => moveSection(secCache, idx, -1), idx === 0 ? 'Already first' : 'Move up', idx === 0],
        ['↓ Down', '', () => moveSection(secCache, idx, 1), idx === lastIdx ? 'Already last' : 'Move down', idx === lastIdx],
        ['Delete', 'danger', () => deleteSection(s), 'Delete section'],
      ]));
      host.appendChild(card);
    });
  }

  async function saveSection() {
    const form = $('sec-form');
    setFormSaving(form, true);
    try {
      const body = readSectionForm();
      if (secEditing) {
        await api(API.homeSections + '/' + encodeURIComponent(secEditing), { method: 'PUT', body });
        notice('ok', 'Section updated.');
      } else {
        await api(API.homeSections, { method: 'POST', body });
        notice('ok', 'Section created.');
      }
      secEditing = null;
      closeDrawer();
      await loadSections();
      if (currentView === 'dashboard') loadDashboard();
    } catch (e) {
      notice('err', (e.message || e));
    } finally {
      setFormSaving(form, false);
    }
  }

  async function toggleSection(s) {
    try {
      await api(API.homeSections + '/' + encodeURIComponent(s.id), {
        method: 'PUT',
        body: { ...s, id: s.id, visible: !(s.visible !== false) },
      });
      notice('ok', (s.visible === false ? 'Section shown.' : 'Section hidden.'));
      await loadSections();
    } catch (e) {
      notice('err', e.message || e);
    }
  }

  async function moveSection(list, i, dir) {
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    try {
      const n = $('admin-notice');
      if (n) n.classList.add('hidden');
      document.querySelectorAll('#sec-list button').forEach((b) => { b.disabled = true; });
      const a = list[i], b = list[j];
      await api(API.homeSections + '/' + encodeURIComponent(a.id), { method: 'PUT', body: { ...a, id: a.id, sort_order: j } });
      await api(API.homeSections + '/' + encodeURIComponent(b.id), { method: 'PUT', body: { ...b, id: b.id, sort_order: i } });
      notice('ok', 'Order updated.');
      await loadSections();
    } catch (e) {
      notice('err', e.message || e);
      await loadSections();
    }
  }

  async function deleteSection(s) {
    const ok = await confirmDialog({ title: 'Delete section?', message: 'Delete home section "' + s.id + '"? This cannot be undone.', okLabel: 'Delete' });
    if (!ok) return;
    try {
      await api(API.homeSections + '/' + encodeURIComponent(s.id), { method: 'DELETE' });
      if (secEditing === s.id) secEditing = null;
      notice('ok', 'Section deleted.');
      await loadSections();
      if (currentView === 'dashboard') loadDashboard();
    } catch (e) {
      notice('err', e.message || e);
    }
  }

  /* ---------------- Greybox Picks (override-based, no new database) ---------------- */
  const PICK_BADGE = 'Greybox Pick';
  let ovCache = null; // last GET /api/admin/overrides list (shared)

  function isGreyboxPick(entry) {
    return !!entry && entry.custom_badge === PICK_BADGE;
  }

  function findCachedOverride(media, id) {
    if (!Array.isArray(ovCache)) return null;
    const n = parseInt(id, 10);
    return ovCache.find((o) => o && o.media === media && o.tmdb_id === n) || null;
  }

  function validPickTarget(media, id) {
    if (media !== 'movie' && media !== 'tv') throw { message: "Media must be 'movie' or 'tv'." };
    const n = typeof id === 'number' ? id : parseInt(String(id), 10);
    if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw { message: 'TMDB ID must be a positive integer.' };
    return { media, id: n };
  }

  async function readOverrideRow(media, id) {
    try {
      return await api(API.overrides + '/' + encodeURIComponent(media) + '/' + encodeURIComponent(id));
    } catch (e) {
      if (e && (e.status === 404)) return null;
      throw e;
    }
  }

  async function markGreyboxPick(media, id) {
    const t = validPickTarget(media, id);
    const existing = await readOverrideRow(t.media, t.id);
    if (existing) {
      const { media: _m, tmdb_id: _i, ...rest } = existing;
      const updated = await api(API.overrides + '/' + t.media + '/' + t.id, {
        method: 'PUT',
        body: { media: t.media, tmdb_id: t.id, ...rest, featured: true, custom_badge: PICK_BADGE },
      });
      ovCache = null;
      return updated;
    }
    const created = await api(API.overrides, {
      method: 'POST',
      body: { media: t.media, tmdb_id: t.id, featured: true, custom_badge: PICK_BADGE },
    });
    ovCache = null;
    return created;
  }

  async function unmarkGreyboxPick(media, id, known) {
    const t = validPickTarget(media, id);
    const existing = (known && typeof known === 'object') ? known : await readOverrideRow(t.media, t.id);
    if (!existing) throw { message: 'Not marked as Greybox Pick.' };
    const { media: _m, tmdb_id: _i, featured: _f, custom_badge: _b, ...remaining } = existing;
    let done;
    if (Object.keys(remaining).length === 0) {
      await api(API.overrides + '/' + t.media + '/' + t.id, { method: 'DELETE' });
      done = null;
    } else {
      done = await api(API.overrides + '/' + t.media + '/' + t.id, {
        method: 'PUT',
        body: { media: t.media, tmdb_id: t.id, ...remaining },
      });
    }
    ovCache = null;
    return done;
  }

  async function toggleGreyboxPick(media, id, known) {
    const t = validPickTarget(media, id);
    const existing = (known && typeof known === 'object') ? known : (findCachedOverride(t.media, t.id) || await readOverrideRow(t.media, t.id));
    if (isGreyboxPick(existing)) return unmarkGreyboxPick(t.media, t.id, existing);
    return markGreyboxPick(t.media, t.id);
  }

  /* ================= COLLECTIONS ================= */
  let colEditing = null;
  let colCache = [];
  let colHeroesCache = {}; // slug -> { mode:'default'|'custom', heroItem } (fresh GET, never trusted blindly)

  // Human scope for a collection source — derived from the data model only,
  // never hardcoded collection names (mirrors renderCollection eyebrow).
  function collectionScopeLabel(src) {
    if (!src || typeof src.type !== 'string') return '—';
    const kind = src.type;
    const m = src.media;
    const scope = m === 'movie' ? 'Movies' : (m === 'tv' ? 'TV Shows' : (m === 'both' || m === 'all' ? 'Movies + TV' : ''));
    return scope ? kind + ' · ' + scope : kind;
  }

  // Media-target test for the workspace media filter. Operates on actual
  // collection data: single-media sources match their media, 'both'/'all'
  // match either side, custom matches when a listed item targets that media.
  function collectionTargetsMedia(c, want) {
    if (want !== 'movie' && want !== 'tv') return true;
    const src = c && c.source && typeof c.source === 'object' ? c.source : null;
    if (!src) return false;
    if (src.type === 'custom') {
      const items = Array.isArray(src.items) ? src.items : [];
      if (!items.length) return true; // malformed custom: don't hide it behind a filter
      return items.some((it) => it && (it.media === want || (want === 'movie' && !it.media)));
    }
    const m = src.media;
    if (m === 'both' || m === 'all') return true;
    if (m === want) return true;
    // Sources without an explicit media (search) serve both catalogs.
    if ((src.type === 'search') && (m == null || m === '')) return true;
    return false;
  }

  // Hero relationship label for a collection slug (Heroes own presentation;
  // Collections own content — this only reports which hero the public page uses).
  function colHeroSummary(slug) {
    const e = colHeroesCache && colHeroesCache[slug] && typeof colHeroesCache[slug] === 'object'
      ? colHeroesCache[slug] : null;
    if (e && e.mode === 'custom' && e.heroItem && (e.heroItem.media === 'movie' || e.heroItem.media === 'tv')) {
      return 'Hero: Custom (' + e.heroItem.media + ':' + e.heroItem.id + ')';
    }
    return 'Hero: Default (first title)';
  }

  function colHeroIsCustom(slug) {
    const e = colHeroesCache && colHeroesCache[slug];
    return !!(e && e.mode === 'custom' && e.heroItem);
  }

  /* ---------- collection preview (unsaved: reads the form, never saves) ---------- */
  // Reuses the existing public Greybox server APIs — the same endpoints the
  // public /collection/:slug page resolves through — shaped minimally for
  // thumbnails. No second collection engine: same routes, first page only,
  // capped at 12 so previews stay cheap. Stale-gated per refresh.
  let colPreviewGen = 0;
  const COL_PREVIEW_IMG = 'https://image.tmdb.org/t/p/w200';

  async function fetchJsonGet(url) {
    let res;
    try {
      res = await fetch(url, { headers: { accept: 'application/json' } });
    } catch (e) {
      throw new Error('Network error: could not reach the server.');
    }
    if (!res.ok) {
      let msg = 'Request failed (' + res.status + ').';
      try {
        const d = await res.json();
        if (d && d.error) msg = d.error;
      } catch { /* keep generic */ }
      throw new Error(msg);
    }
    return res.json();
  }

  function shapePreviewItem(r, fallbackType) {
    if (!r || typeof r !== 'object' || !(parseInt(r.id, 10) > 0)) return null;
    const mt = r.media_type === 'tv' || r.media_type === 'movie'
      ? r.media_type
      : (fallbackType === 'tv' || fallbackType === 'movie' ? fallbackType
        : ((r.title && !r.first_air_date) ? 'movie' : 'tv'));
    return {
      id: parseInt(r.id, 10),
      media_type: mt,
      title: String(r.title || r.name || 'Untitled').slice(0, 200),
      poster_path: typeof r.poster_path === 'string' ? r.poster_path : null,
      backdrop_path: typeof r.backdrop_path === 'string' ? r.backdrop_path : null,
      vote_average: Number(r.vote_average || 0),
    };
  }

  function colDetailFetch(media, id) {
    const mt = media === 'tv' ? 'tv' : 'movie';
    const n = parseInt(id, 10);
    if (!Number.isInteger(n) || n < 1) return Promise.resolve(null);
    const path = mt === 'tv' ? '/api/tv/' + n : '/api/movie/' + n;
    return fetchJsonGet(path).then(
      (d) => shapePreviewItem({ ...d, media_type: mt }, mt),
      () => null
    );
  }

  function resolvePreviewIdItems(items) {
    const list = (Array.isArray(items) ? items : [])
      .map((it) => {
        if (!it || typeof it !== 'object') return null;
        const n = parseInt(it.id, 10);
        if (!Number.isInteger(n) || n < 1) return null;
        return { media: it.media === 'tv' ? 'tv' : 'movie', id: n };
      })
      .filter(Boolean)
      .slice(0, 24);
    return Promise.all(list.map((it) => colDetailFetch(it.media, it.id)))
      .then((rows) => rows.filter((x) => x && (x.poster_path || x.backdrop_path)));
  }

  function discoverPreviewFetch(media, params) {
    const mt = media === 'tv' ? 'tv' : 'movie';
    const qs = new URLSearchParams({ language: 'en-US', page: '1', sort_by: params.sort || 'popularity.desc' });
    if (params.genre) qs.set('with_genres', String(params.genre));
    if (params.year) qs.set(mt === 'tv' ? 'first_air_date_year' : 'primary_release_year', String(params.year));
    return fetchJsonGet('/api/tmdb/discover/' + mt + '?' + qs.toString()).then((d) => {
      const results = Array.isArray(d && d.results) ? d.results : [];
      return results.map((x) => shapePreviewItem(x, mt)).filter((x) => x && (x.poster_path || x.backdrop_path));
    });
  }

  function fetchCollectionPreviewBase(src) {
    const t = src && src.type;
    if (t === 'trending') {
      const media = src.media === 'movie' ? 'movie' : (src.media === 'tv' ? 'tv' : 'all');
      return fetchJsonGet('/api/trending?page=1').then((d) => {
        const results = Array.isArray(d && d.results) ? d.results : [];
        const shaped = results.map((x) => shapePreviewItem(x, null)).filter(Boolean);
        const kept = media === 'all' ? shaped : shaped.filter((x) => x.media_type === media);
        return kept.filter((x) => x.poster_path || x.backdrop_path);
      });
    }
    if (t === 'popular') {
      const mt = src.media === 'tv' ? 'tv' : 'movie';
      const path = mt === 'tv' ? '/api/tv/popular?page=1' : '/api/movies/popular?page=1';
      return fetchJsonGet(path).then((d) => ((d && d.results) || []).map((x) => shapePreviewItem(x, mt)).filter((x) => x && (x.poster_path || x.backdrop_path)));
    }
    if (t === 'top-rated') {
      const mt = src.media === 'tv' ? 'tv' : 'movie';
      const path = mt === 'tv' ? '/api/tv/top-rated?page=1' : '/api/movies/top-rated?page=1';
      return fetchJsonGet(path).then((d) => ((d && d.results) || []).map((x) => shapePreviewItem(x, mt)).filter((x) => x && (x.poster_path || x.backdrop_path)));
    }
    if (t === 'now-playing') {
      return fetchJsonGet('/api/movies/now-playing?page=1').then((d) => ((d && d.results) || []).map((x) => shapePreviewItem(x, 'movie')).filter((x) => x && (x.poster_path || x.backdrop_path)));
    }
    if (t === 'search') {
      const q = String(src.query || '').trim();
      if (!q) return Promise.reject(new Error('Search source needs a query.'));
      return fetchJsonGet('/api/search?q=' + encodeURIComponent(q) + '&page=1').then((d) => {
        const results = Array.isArray(d && d.results) ? d.results : [];
        return results
          .filter((x) => x && (x.media_type === 'movie' || x.media_type === 'tv'))
          .map((x) => shapePreviewItem(x, null))
          .filter((x) => x && (x.poster_path || x.backdrop_path));
      });
    }
    if (t === 'discover') {
      return discoverPreviewFetch(src.media, { genre: src.genre, year: src.year, sort: src.sort });
    }
    if (t === 'genre') {
      if (src.media === 'both' && src.genre && typeof src.genre === 'object') {
        const mid = parseInt(src.genre.movie_id, 10);
        const tid = parseInt(src.genre.tv_id, 10);
        if (!(mid > 0) || !(tid > 0)) return Promise.reject(new Error('Genre needs both a movie genre and a TV genre.'));
        const sort = src.sort || 'popularity.desc';
        return Promise.all([
          discoverPreviewFetch('movie', { genre: mid, sort }),
          discoverPreviewFetch('tv', { genre: tid, sort }),
        ]).then(([a, b]) => {
          const out = [];
          const n = Math.max(a.length, b.length);
          for (let i = 0; i < n && out.length < 24; i++) {
            if (a[i]) out.push({ ...a[i], media_type: 'movie' });
            if (b[i] && out.length < 24) out.push({ ...b[i], media_type: 'tv' });
          }
          return out;
        });
      }
      const gid = parseInt(src.genreId, 10);
      if (!(gid > 0)) return Promise.reject(new Error('Genre needs a genreId.'));
      return discoverPreviewFetch(src.media, { genre: gid, sort: src.sort });
    }
    if (t === 'year') {
      if (!/^\d{4}$/.test(String(src.year == null ? '' : src.year).trim())) return Promise.reject(new Error('Year must be YYYY.'));
      return discoverPreviewFetch(src.media, { year: String(src.year).trim(), sort: src.sort });
    }
    if (t === 'custom') {
      return resolvePreviewIdItems(src.items);
    }
    if (t === 'tag') {
      const slug = String(src.tag || '').trim().toLowerCase();
      if (!slug) return Promise.reject(new Error('Tag source needs a tag.'));
      // Same rule as the public shelf: visible tag's ordered membership,
      // first page only (resolvePreviewIdItems already caps at 24).
      return fetchJsonGet('/api/config/tags').then((list) => {
        const arr = Array.isArray(list) ? list : [];
        const tag = arr.find((g) => g && g.slug === slug) || null;
        if (!tag) throw new Error('Tag not found or hidden: ' + slug);
        return resolvePreviewIdItems(tag.members);
      });
    }
    return Promise.reject(new Error('Unknown source type: ' + t));
  }

  function isPreviewExcluded(it, exclude) {
    return (Array.isArray(exclude) ? exclude : []).some((x) => {
      if (!x || !(parseInt(x.id, 10) > 0)) return false;
      if (x.media) return x.media === it.media_type && parseInt(x.id, 10) === it.id;
      return parseInt(x.id, 10) === it.id;
    });
  }

  // Lenient form read for previews: returns { ok, body } instead of throwing
  // like readCollectionForm, so the preview can show the validation message.
  function readCollectionPreviewBody() {
    try {
      return { ok: true, body: readCollectionForm() };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  function collectionPreviewNode() {
    const wrap = el('div', 'hero-preview col-preview');
    const bar = el('div', 'hero-preview-bar');
    bar.appendChild(el('span', 'badge badge-soon', 'Preview'));
    bar.appendChild(el('span', 'muted text-sm', 'Unsaved — save to make live.'));
    const refresh = el('button', 'btn btn-ghost btn-sm', 'Refresh preview');
    refresh.type = 'button';
    refresh.addEventListener('click', () => refreshCollectionPreview());
    bar.appendChild(refresh);
    wrap.appendChild(bar);
    const body = el('div', 'hero-preview-body');
    body.id = 'col-preview-body';
    body.innerHTML = '<p class="muted text-sm">Edit the form, then Refresh preview. Nothing here is saved.</p>';
    wrap.appendChild(body);
    return wrap;
  }

  async function refreshCollectionPreview() {
    const body = document.getElementById('col-preview-body');
    if (!body) return;
    const myGen = ++colPreviewGen;
    const parsed = readCollectionPreviewBody();
    if (!parsed.ok) {
      body.innerHTML = '';
      body.appendChild(el('p', 'muted text-sm', 'Preview unavailable: ' + parsed.error));
      return;
    }
    const b = parsed.body;
    const cap = Math.max(1, Math.min(parseInt(b.limit, 10) || 20, 12));
    body.innerHTML = '<p class="muted text-sm">Loading preview…</p>';
    const stillCurrent = () => myGen === colPreviewGen && document.getElementById('col-preview-body') === body && body.isConnected;
    try {
      const pins = (b.pin && b.pin.length) ? await resolvePreviewIdItems(b.pin) : [];
      if (!stillCurrent()) return;
      let base = [];
      if (b.source.type === 'custom') {
        base = await resolvePreviewIdItems(b.source.items);
      } else {
        base = await fetchCollectionPreviewBase(b.source);
      }
      if (!stillCurrent()) return;
      // Pins lead (page-1 semantics), deduped by media:id, excludes drop out.
      const seen = new Set(pins.map((x) => x.media_type + ':' + x.id));
      const items = [...pins];
      for (const x of base) {
        if (!x) continue;
        const k = x.media_type + ':' + x.id;
        if (seen.has(k)) continue;
        if (isPreviewExcluded({ media_type: x.media_type, id: x.id }, b.exclude)) continue;
        seen.add(k);
        items.push(x);
        if (items.length >= cap) break;
      }
      if (!stillCurrent()) return;
      body.innerHTML = '';
      const headBits = [
        b.title || '(untitled)',
        collectionScopeLabel(b.source),
        (b.visible === false ? 'Hidden' : 'Visible'),
        colHeroSummary(b.slug || colEditing || ''),
      ];
      body.appendChild(el('p', 'row-title', headBits[0]));
      body.appendChild(el('p', 'muted text-sm', headBits.slice(1).join(' · ')));
      if (b.slug) {
        const live = el('p', 'muted text-sm', 'Live: /collection/' + b.slug + (b.visible === false ? ' (hidden → 404 until visible)' : ''));
        body.appendChild(live);
      }
      if (!items.length) {
        body.appendChild(el('p', 'muted text-sm', 'No titles resolved. Check the source configuration.'));
        return;
      }
      const grid = el('div', 'col-preview-grid');
      items.slice(0, cap).forEach((it) => {
        const cell = el('div', 'col-preview-cell');
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = '';
        const path = it.poster_path || it.backdrop_path;
        img.src = path ? COL_PREVIEW_IMG + path : 'https://via.placeholder.com/100x150?text=?';
        img.onerror = function () { try { img.src = 'https://via.placeholder.com/100x150?text=?'; } catch (e) { /* noop */ } };
        cell.appendChild(img);
        const cap2 = el('p', 'col-preview-cap', (it.media_type === 'tv' ? 'TV' : 'Movie') + ' ' + it.media_type + ':' + it.id);
        cap2.title = it.title;
        cell.appendChild(cap2);
        grid.appendChild(cell);
      });
      body.appendChild(grid);
      body.appendChild(el('p', 'muted text-sm', 'Showing ' + Math.min(items.length, cap) + ' of preview · pins lead · excludes applied · capped at 12 for speed.'));
    } catch (e) {
      if (!stillCurrent()) return;
      body.innerHTML = '';
      body.appendChild(el('p', 'muted text-sm', 'Preview failed: ' + ((e && e.message) || e)));
    }
  }

  function collectionEditorNode(item) {
    const f = document.createElement('form');
    f.id = 'col-form';
    f.autocomplete = 'off';
    f.style.cssText = 'display:grid;gap:.8rem';
    f.appendChild(collectionPreviewNode());
    f.appendChild(groupBox('Identity', [
      fieldRow('Slug (lowercase letters/numbers/hyphens; set once — renames need delete + create)', textInput('c-slug', item ? item.slug : '', 'gothic-horror')),
      fieldRow('Title', textInput('c-title', item ? item.title || '' : '', 'Gothic Horror')),
      fieldRow('Description / subtitle (optional)', textInput('c-desc', item ? item.description || '' : '', '')),
    ]));
    const srcHost = el('div', '');
    srcHost.style.cssText = 'display:grid;gap:.7rem';
    srcHost.id = 'c-source';
    const srcLabel = el('div', '');
    srcLabel.appendChild(el('span', 'flabel', 'Rule source'));
    srcLabel.appendChild(srcHost);
    srcLabel.appendChild(el('p', 'muted text-sm', 'Only the fields for the selected source type apply — other source settings are hidden, never stored.'));
    f.appendChild(groupBox('Content source', [srcLabel]));
    renderSourceFields(srcHost, 'c-src', COL_SOURCE_TYPES, item ? item.source : null);
    const presNodes = [
      checkInput('c-visible', item ? item.visible !== false : true, 'Visible (hidden collections 404 everywhere, including their public URL)'),
      fieldRow('Limit — max titles shown (1–60)', numInput('c-limit', item && item.limit != null ? item.limit : 20, '20')),
      fieldRow('Cover banner URL (optional, https://…)', textInput('c-cover', item ? item.cover || '' : '', 'https://…')),
      fieldRow('Sort order (optional display position; blank = keep/append — ↑/↓ also edits this)', numInput('c-sort', '', '')),
    ];
    if (item && item.slug) {
      const live = el('p', 'muted text-sm', 'Live URL: /collection/' + item.slug + ' — changing the slug is not supported in place (delete + create instead) so existing links never break silently.');
      presNodes.push(live);
      const openBtn = el('button', 'btn btn-secondary btn-sm', 'Open Collection ↗');
      openBtn.type = 'button';
      openBtn.addEventListener('click', () => { try { window.open('/collection/' + item.slug, '_blank', 'noopener'); } catch { /* noop */ } });
      presNodes.push(openBtn);
    } else {
      presNodes.push(el('p', 'muted text-sm', 'The public URL will be /collection/<slug>. Slugs are permanent once created.'));
    }
    f.appendChild(groupBox('Presentation', presNodes));
    // HERO relationship: collections own content, heroes own presentation.
    // This box only reports + links — the full editor stays in Heroes.
    const heroNodes = [];
    if (item && item.slug) {
      heroNodes.push(el('p', 'muted text-sm', colHeroSummary(item.slug) + ' — a custom hero never changes this collection’s titles, only which title the hero presents.'));
      const hb = el('button', 'btn btn-secondary btn-sm', 'Configure Hero');
      hb.type = 'button';
      hb.title = 'Open the Hero editor for /collection/' + item.slug;
      hb.addEventListener('click', () => openCollectionHeroEditorFresh(item));
      heroNodes.push(hb);
    } else {
      heroNodes.push(el('p', 'muted text-sm', 'Default hero (first title) applies. Save this collection first, then configure a custom hero from the collection card or Heroes.'));
    }
    f.appendChild(groupBox('Hero', heroNodes));
    const lines = (arr) => (Array.isArray(arr) ? arr.map((it) => (it && typeof it === 'object' ? (it.media ? it.media + ':' + it.id : it.id) : it)).join('\n') : '');
    const advNodes = [
      fieldRow('Pinned titles (optional, one per line: media:id — always shown FIRST, in this order)', areaInput('c-pin', item ? lines(item.pin) : '', 'movie:550\ntv:1399', 3)),
      fieldRow('Excluded titles (optional, one per line: bare id hides any media, media:id hides exactly)', areaInput('c-exclude', item ? lines(item.exclude) : '', '123\ntv:456', 3)),
      fieldRow('Meta JSON (optional, e.g. {"curator":"Greybox"})', areaInput('c-meta', item && item.meta ? JSON.stringify(item.meta) : '', '{"curator":"Greybox"}', 2)),
    ];
    advNodes.push(el('p', 'muted text-sm', 'Pins resolve via title details and lead the collection; excludes drop matching titles. Identity is always media + TMDB ID, never title text.'));
    f.appendChild(groupBox('Advanced', advNodes));
    const row = el('div', '');
    row.style.cssText = 'display:flex;gap:.5rem;flex-wrap:wrap';
    const save = el('button', 'btn btn-primary btn-sm', item ? 'Save Changes' : 'Create collection');
    save.type = 'submit';
    const cancel = el('button', 'btn btn-ghost btn-sm', 'Discard');
    cancel.type = 'button';
    cancel.addEventListener('click', closeDrawer);
    row.appendChild(save);
    row.appendChild(cancel);
    f.appendChild(row);
    f.addEventListener('submit', (e) => { e.preventDefault(); saveCollection(); });
    return f;
  }

  function openCollectionEditor(item) {
    colEditing = item ? item.slug : null;
    colPreviewGen++; // invalidate any stale preview flight from a previous edit
    const node = collectionEditorNode(item);
    openDrawer({
      kicker: 'Collections',
      title: item ? 'Edit collection' : 'New collection',
      sub: item ? '/collection/' + item.slug : 'Rule-based rows behind /collection/:slug.',
      node,
      form: node,
    });
    const slugEl = $('c-slug');
    if (slugEl && item) slugEl.disabled = true;
  }

  function buildCollectionForm() { /* built on demand in the drawer */ }
  function fillCollectionForm(item) {
    if (!ADMIN_TOKEN || !$('admin-app') || $('admin-app').classList.contains('hidden')) {
      colEditing = item ? item.slug : null;
      let host = $('col-form-host-test');
      if (!host) { host = document.createElement('div'); host.id = 'col-form-host-test'; host.style.display = 'none'; document.body.appendChild(host); }
      host.innerHTML = '';
      host.appendChild(collectionEditorNode(item));
      const slugEl = $('c-slug');
      if (slugEl && item) slugEl.disabled = true;
      return;
    }
    openCollectionEditor(item);
  }

  function readCollectionForm() {
    const slugRaw = $('c-slug').value.trim().toLowerCase();
    if (!colEditing) {
      const err = vSlug(slugRaw);
      if (err) throw { message: err };
    }
    const title = $('c-title').value.trim();
    if (!title) throw { message: 'Title is required.' };
    if (title.length > 120) throw { message: 'Title must be at most 120 characters.' };
    const desc = $('c-desc').value;
    if (desc.length > 500) throw { message: 'Description must be at most 500 characters.' };
    const cover = $('c-cover').value.trim();
    if (cover && !/^https?:\/\//i.test(cover)) throw { message: 'Cover must be an http(s) URL.' };
    if (cover.length > 500) throw { message: 'Cover must be at most 500 characters.' };
    const limit = parseInt($('c-limit').value, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 60) throw { message: 'Limit must be 1–60.' };
    const sortRaw = $('c-sort').value.trim();
    let sort_order;
    if (sortRaw !== '') {
      sort_order = parseInt(sortRaw, 10);
      if (!Number.isInteger(sort_order) || sort_order < 0 || sort_order > 100000) throw { message: 'Sort order must be 0–100000.' };
    }
    const source = readSource('c-src');
    const srcErr = vSource(source, COL_SOURCE_TYPES);
    if (srcErr) throw { message: srcErr };
    const pin = parseEntryLines($('c-pin').value);
    if (!pin.ok) throw { message: 'Pin — ' + pin.error };
    const exclude = parseEntryLines($('c-exclude').value);
    if (!exclude.ok) throw { message: 'Exclude — ' + exclude.error };
    const meta = parseMetaText($('c-meta').value);
    if (!meta.ok) throw { message: meta.error };
    const body = {
      slug: colEditing || slugRaw,
      title, description: desc.trim(), cover,
      visible: $('c-visible').checked,
      limit, source, pin: pin.items,
      exclude: exclude.items.map((it) => it),
      meta: meta.value,
    };
    if (sort_order !== undefined) body.sort_order = sort_order;
    return body;
  }

  function filteredCollections() {
    const q = String(($('col-search') && $('col-search').value) || '').trim().toLowerCase();
    const f = ($('col-filter') && $('col-filter').value) || 'all';
    const t = ($('col-type') && $('col-type').value) || 'all';
    const m = ($('col-media') && $('col-media').value) || 'all';
    return colCache.filter((c) => {
      if (f === 'visible' && c.visible === false) return false;
      if (f === 'hidden' && c.visible !== false) return false;
      if (t !== 'all' && (!c.source || c.source.type !== t)) return false;
      if (!collectionTargetsMedia(c, m)) return false;
      if (!q) return true;
      const hay = (c.slug + ' ' + (c.title || '') + ' ' + (c.description || '') + ' ' + summarizeSource(c.source)).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  // Stable subset comparison for save → read-back verification: the PUT
  // echo and a fresh GET must describe the same stored row (same endpoint,
  // same D1 collections row). Key order + unknown keys ignored.
  function stableCollectionJson(c) {
    try {
      const x = (c && typeof c === 'object') ? c : {};
      return JSON.stringify({
        slug: x.slug || null,
        title: x.title || null,
        description: x.description != null ? x.description : null,
        cover: x.cover != null ? x.cover : null,
        visible: x.visible !== false,
        limit: x.limit != null ? x.limit : null,
        source: x.source !== undefined ? x.source : null,
        pin: x.pin !== undefined ? x.pin : null,
        exclude: x.exclude !== undefined ? x.exclude : null,
        meta: x.meta !== undefined ? x.meta : null,
      });
    } catch { return null; }
  }

  async function loadCollections() {
    const host = $('col-list');
    if (!host) return;
    stateBox(host, 'loading', 'Loading collections…');
    try {
      const list = await api(API.collections);
      colCache = Array.isArray(list) ? list : [];
      // Collection hero map (separate scope, same screen): best-effort so a
      // heroes failure never blocks the content workspace.
      try {
        const heroes = await api(API.colHeroes);
        colHeroesCache = (heroes && typeof heroes === 'object' && !Array.isArray(heroes)) ? heroes : {};
      } catch (heroErr) {
        if (heroErr && (heroErr.status === 401 || heroErr.status === 403)) throw heroErr;
        colHeroesCache = {};
      }
      try {
        ovCache = await api(API.overrides);
      } catch (ovErr) {
        if (ovErr && (ovErr.status === 401 || ovErr.status === 403)) throw ovErr;
        ovCache = null;
      }
      renderCollections();
    } catch (e) {
      host.innerHTML = '';
      notice('err', 'Collections failed to load: ' + (e.message || e));
    }
  }

  function renderCollections() {
    const host = $('col-list');
    if (!host) return;
    const list = filteredCollections();
    // Workspace count: total vs shown (filters are real, against live data).
    const countEl = $('col-count');
    if (countEl) {
      const total = colCache.length;
      countEl.textContent = total
        ? (list.length === total
          ? total + (total === 1 ? ' Collection' : ' Collections')
          : list.length + ' of ' + total + ' collections')
        : '';
    }
    host.innerHTML = '';
    if (!colCache.length) {
      const box = stateBox(host, 'empty', 'No collections yet', 'Create the first rule-based row — the editor opens immediately.');
      const b = el('button', 'btn btn-primary btn-sm', '+ New Collection');
      b.type = 'button';
      b.addEventListener('click', () => openCollectionEditor(null));
      box.appendChild(b);
      return;
    }
    if (!list.length) {
      stateBox(host, 'empty', 'No matches', 'Try a different search or filter.');
      return;
    }
    const lastIdx = colCache.length - 1;
    list.forEach((c) => {
      const idx = colCache.indexOf(c);
      const card = el('div', 'data-row col-card');
      const head = el('div', 'row-top');
      head.appendChild(el('span', 'row-title', c.title || c.slug));
      head.appendChild(statusBadge(c));
      head.appendChild(el('span', 'badge', collectionScopeLabel(c.source)));
      card.appendChild(head);
      card.appendChild(el('p', 'row-mono muted', '/collection/' + c.slug + ' · #' + (idx + 1) + ' · limit ' + (c.limit != null ? c.limit : '?')));
      if (c.description) card.appendChild(el('p', 'row-meta', c.description));
      const facts = [];
      facts.push(summarizeSource(c.source));
      if (Array.isArray(c.pin) && c.pin.length) facts.push(c.pin.length + ' pinned');
      if (Array.isArray(c.exclude) && c.exclude.length) facts.push(c.exclude.length + ' excluded');
      card.appendChild(el('p', 'row-meta', facts.join(' · ')));
      card.appendChild(el('p', 'row-meta', colHeroSummary(c.slug)));
      const links = el('div', 'col-links');
      const a = el('a', 'row-link', 'Open Collection ↗');
      a.href = '/collection/' + c.slug;
      a.target = '_blank';
      a.rel = 'noopener';
      a.title = 'Open the public page for /collection/' + c.slug;
      links.appendChild(a);
      card.appendChild(links);
      if (c.source && c.source.type === 'custom' && Array.isArray(c.source.items) && c.source.items.length) {
        const pickWrap = el('div', 'pick-strip');
        pickWrap.appendChild(el('span', 'pick-hint', 'Greybox Picks:'));
        c.source.items.forEach((it) => {
          const media = it && it.media === 'tv' ? 'tv' : 'movie';
          const id = it && parseInt(it.id, 10);
          if (!Number.isInteger(id) || id < 1) return;
          const known = findCachedOverride(media, id);
          const marked = isGreyboxPick(known);
          const b = el('button', 'rowbtn' + (marked ? ' go' : ''), (marked ? '★ ' : '☆ ') + media + ':' + id);
          b.type = 'button';
          b.title = marked ? 'Unmark Greybox Pick (keeps it in this collection)' : 'Mark as Greybox Pick';
          b.addEventListener('click', async () => {
            b.disabled = true;
            try {
              await toggleGreyboxPick(media, id, findCachedOverride(media, id));
              ovCache = await api(API.overrides);
              notice('ok', marked ? ('Unmarked ' + media + ':' + id + ' (still in collection).') : ('Marked ' + media + ':' + id + ' as Greybox Pick.'));
              renderCollections();
            } catch (e) {
              b.disabled = false;
              notice('err', (e && e.message) || e);
            }
          });
          pickWrap.appendChild(b);
        });
        if (ovCache === null) {
          pickWrap.appendChild(el('span', 'pick-hint', '(pick states unavailable — overrides failed to load)'));
        }
        card.appendChild(pickWrap);
      }
      card.appendChild(rowButtons([
        ['Edit', 'go', () => openCollectionEditor(c)],
        [c.visible === false ? 'Show' : 'Hide', '', () => toggleCollection(c), c.visible === false ? 'Make visible' : 'Hide everywhere'],
        ['Hero', '', () => openCollectionHeroEditorFresh(c), 'Configure hero for /collection/' + c.slug],
        ['↑ Up', '', () => moveCollection(colCache, idx, -1), idx === 0 ? 'Already first' : 'Move up', idx === 0],
        ['↓ Down', '', () => moveCollection(colCache, idx, 1), idx === lastIdx ? 'Already last' : 'Move down', idx === lastIdx],
        ['Delete', 'danger', () => deleteCollection(c), 'Delete collection'],
      ]));
      host.appendChild(card);
    });
  }

  async function saveCollection() {
    const form = $('col-form');
    setFormSaving(form, true);
    try {
      const body = readCollectionForm();
      const slug = colEditing || body.slug;
      let saved;
      if (colEditing) {
        saved = await api(API.collections + '/' + encodeURIComponent(colEditing), { method: 'PUT', body });
      } else {
        saved = await api(API.collections, { method: 'POST', body });
      }
      // Never trust the 200 alone: read the row back and compare against
      // what the server stored before showing success.
      const readBack = await api(API.collections + '/' + encodeURIComponent(saved && saved.slug ? saved.slug : slug));
      if (stableCollectionJson(saved) !== stableCollectionJson(readBack)) {
        notice('err', 'Collection saved, but a fresh read-back differs — not showing success. Refresh and retry.');
      } else {
        notice('ok', colEditing ? 'Collection updated.' : 'Collection created.');
      }
      colEditing = null;
      colPreviewGen++;
      closeDrawer();
      await loadCollections();
      if (currentView === 'dashboard') loadDashboard();
      if (currentView === 'heroes') loadHeroes();
    } catch (e) {
      notice('err', (e.message || e));
    } finally {
      setFormSaving(form, false);
    }
  }

  async function toggleCollection(c) {
    try {
      await api(API.collections + '/' + encodeURIComponent(c.slug), {
        method: 'PUT',
        body: { ...c, slug: c.slug, visible: !(c.visible !== false) },
      });
      notice('ok', (c.visible === false ? 'Collection shown.' : 'Collection hidden.'));
      await loadCollections();
    } catch (e) {
      notice('err', e.message || e);
    }
  }

  async function moveCollection(list, i, dir) {
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    try {
      document.querySelectorAll('#col-list button').forEach((b) => { b.disabled = true; });
      const a = list[i], b = list[j];
      await api(API.collections + '/' + encodeURIComponent(a.slug), { method: 'PUT', body: { ...a, slug: a.slug, sort_order: j } });
      await api(API.collections + '/' + encodeURIComponent(b.slug), { method: 'PUT', body: { ...b, slug: b.slug, sort_order: i } });
      notice('ok', 'Order updated.');
      await loadCollections();
    } catch (e) {
      notice('err', e.message || e);
      await loadCollections();
    }
  }

  async function deleteCollection(c) {
    const title = c.title || c.slug;
    const ok = await confirmDialog({
      title: 'Delete collection?',
      message: 'Delete collection "' + title + '" (/collection/' + c.slug + ')? The public page will 404 and it will leave homepage shelves that reference it empty. This cannot be undone.',
      okLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await api(API.collections + '/' + encodeURIComponent(c.slug), { method: 'DELETE' });
      // Best-effort hero cleanup through the existing collection-heroes API
      // (no new backend): a deleted slug must not leave a stale custom hero
      // behind. Never fails the delete itself.
      try {
        const map = await api(API.colHeroes);
        if (map && typeof map === 'object' && !Array.isArray(map) && map[c.slug]) {
          const next = { ...map };
          delete next[c.slug];
          await api(API.colHeroes, { method: 'PUT', body: next });
          colHeroesCache = next;
        }
      } catch (heroErr) {
        if (heroErr && (heroErr.status === 401 || heroErr.status === 403)) throw heroErr;
        notice('err', 'Collection deleted, but its hero override could not be cleaned: ' + ((heroErr && heroErr.message) || heroErr));
      }
      if (colEditing === c.slug) colEditing = null;
      notice('ok', 'Collection deleted.');
      await loadCollections();
      if (currentView === 'dashboard') loadDashboard();
      if (currentView === 'heroes') loadHeroes();
    } catch (e) {
      notice('err', e.message || e);
    }
  }

  /* ================= TAGS (Part 4.5: custom editorial content groups) ================= */
  // Tags are Greybox-owned content groups: { slug, name, description,
  // visible, badge } + ordered membership [{ media, id }]. Membership is
  // identity only — titles/posters resolve live through the Greybox API and
  // are NEVER stored. One title can belong to many tags; each tag resolves
  // its own list (no cross-tag contamination).
  let tagCache = []; // GET /api/admin/tags summaries (with counts, no members)
  let tagEditing = null; // slug being edited, or null for create
  let tagSlugTouched = false; // true once the operator edits the slug by hand
  let tagDetail = null; // fresh GET /api/admin/tags/:slug for Manage Titles
  let tagDetailGen = 0; // stale guard for detail loads + title resolution
  let tagAddGen = 0; // stale guard for add-titles searches
  const tagTitleCache = {}; // 'media:id' -> { title, year, poster } (session only, never stored)

  // Display name → stable slug suggestion (admin-side only; the server
  // re-validates — an invalid suggestion is a 400, never stored).
  function slugifyTag(name) {
    return String(name == null ? '' : name).trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  }

  function tagCounts(t) {
    const n = t && t.member_count != null ? t.member_count : ((t && Array.isArray(t.members)) ? t.members.length : 0);
    const mv = t && t.movie_count != null ? t.movie_count : 0;
    const tv = t && t.tv_count != null ? t.tv_count : 0;
    return n + (n === 1 ? ' title' : ' titles') + ' · ' + mv + ' movies · ' + tv + ' TV';
  }

  function filteredTags() {
    const q = String(($('tag-search') && $('tag-search').value) || '').trim().toLowerCase();
    const f = ($('tag-filter') && $('tag-filter').value) || 'all';
    return tagCache.filter((t) => {
      if (f === 'visible' && t.visible === false) return false;
      if (f === 'hidden' && t.visible !== false) return false;
      if (!q) return true;
      const hay = (t.slug + ' ' + (t.name || '') + ' ' + (t.description || '')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  // Stable subset comparison for save → read-back verification (same
  // endpoint, same D1 tags row). Key order + unknown keys ignored.
  function stableTagJson(t) {
    try {
      const x = (t && typeof t === 'object') ? t : {};
      return JSON.stringify({
        slug: x.slug || null,
        name: x.name || null,
        description: x.description != null ? x.description : null,
        visible: x.visible !== false,
        badge: x.badge === true,
        members: Array.isArray(x.members) ? x.members : null,
      });
    } catch { return null; }
  }

  async function loadTags() {
    const host = $('tag-list');
    if (!host) return;
    stateBox(host, 'loading', 'Loading tags…');
    try {
      const list = await api(API.tags);
      tagCache = Array.isArray(list) ? list : [];
      renderTags();
    } catch (e) {
      host.innerHTML = '';
      notice('err', 'Tags failed to load: ' + (e.message || e));
    }
  }

  function renderTags() {
    const host = $('tag-list');
    if (!host) return;
    const list = filteredTags();
    const countEl = $('tag-count');
    if (countEl) {
      const total = tagCache.length;
      countEl.textContent = total
        ? (list.length === total
          ? total + (total === 1 ? ' Tag' : ' Tags')
          : list.length + ' of ' + total + ' tags')
        : '';
    }
    host.innerHTML = '';
    if (!tagCache.length) {
      const box = stateBox(host, 'empty', 'No tags yet', 'Create the first editorial content group — then use it as a Custom Tag source in any Home section or Collection.');
      const b = el('button', 'btn btn-primary btn-sm', '+ New Tag');
      b.type = 'button';
      b.addEventListener('click', () => openTagEditor(null));
      box.appendChild(b);
      return;
    }
    if (!list.length) {
      stateBox(host, 'empty', 'No matches', 'Try a different search or filter.');
      return;
    }
    list.forEach((t) => {
      const card = el('div', 'data-row col-card');
      const head = el('div', 'row-top');
      head.appendChild(el('span', 'row-title', t.name || t.slug));
      head.appendChild(statusBadge(t));
      if (t.badge === true) head.appendChild(el('span', 'badge badge-pick', 'Badge on'));
      card.appendChild(head);
      card.appendChild(el('p', 'row-mono muted', t.slug));
      if (t.description) card.appendChild(el('p', 'row-meta', t.description));
      card.appendChild(el('p', 'row-meta', tagCounts(t)));
      card.appendChild(rowButtons([
        ['Edit', 'go', () => openTagEditor(t)],
        ['Manage Titles', '', () => openTagMembers(t.slug), 'Add, remove and reorder titles in this tag'],
        [t.visible === false ? 'Show' : 'Hide', '', () => toggleTag(t), t.visible === false ? 'Make usable by public sources' : 'Remove from all public surfaces'],
        ['Delete', 'danger', () => deleteTag(t), 'Delete tag'],
      ]));
      host.appendChild(card);
    });
  }

  function tagEditorNode(item) {
    const f = document.createElement('form');
    f.id = 'tag-form';
    f.autocomplete = 'off';
    f.style.cssText = 'display:grid;gap:.8rem';
    f.appendChild(groupBox('Identity', [
      fieldRow('Name (display name — safe to rename anytime)', textInput('t-name', item ? item.name || '' : '', 'Kids Fav')),
      fieldRow('Slug (stable identity; set once — rename = delete + create)', textInput('t-slug', item ? item.slug : '', 'kids-fav')),
      fieldRow('Description (optional, operators only)', textInput('t-desc', item ? item.description || '' : '', 'Movies and shows for younger viewers.')),
    ]));
    f.appendChild(groupBox('Presentation', [
      checkInput('t-visible', item ? item.visible !== false : true, 'Visible — usable by public content sources'),
      el('p', 'muted text-sm', 'Hidden tags resolve to nothing everywhere: no shelf content, no badges. Membership is kept, so re-showing restores everything.'),
      checkInput('t-badge', !!(item && item.badge === true), 'Show as card badge — tag name on member titles'),
      el('p', 'muted text-sm', 'Badge display is separate from membership: a tag works as a content group with this off. Never replaces the override badge (custom_badge); both can show.'),
    ]));
    const usageBox = el('div', '');
    usageBox.id = 'tag-usage';
    f.appendChild(groupBox('Usage', [usageBox]));
    const row = el('div', '');
    row.style.cssText = 'display:flex;gap:.5rem;flex-wrap:wrap';
    const save = el('button', 'btn btn-primary btn-sm', item ? 'Save Changes' : 'Create tag');
    save.type = 'submit';
    const cancel = el('button', 'btn btn-ghost btn-sm', 'Discard');
    cancel.type = 'button';
    cancel.addEventListener('click', closeDrawer);
    row.appendChild(save);
    row.appendChild(cancel);
    if (item && item.slug) {
      const manage = el('button', 'btn btn-secondary btn-sm', 'Manage Titles');
      manage.type = 'button';
      manage.addEventListener('click', () => openTagMembers(item.slug));
      row.appendChild(manage);
    }
    f.appendChild(row);
    f.addEventListener('submit', (e) => { e.preventDefault(); saveTag(); });
    // Slug suggestion while pristine: typing the name proposes a slug until
    // the operator touches the slug field by hand (never silently rewrites).
    const nameEl = f.querySelector('#t-name');
    const slugEl = f.querySelector('#t-slug');
    if (nameEl && slugEl && !item) {
      tagSlugTouched = false;
      slugEl.addEventListener('input', () => { tagSlugTouched = true; });
      nameEl.addEventListener('input', () => {
        if (!tagSlugTouched) slugEl.value = slugifyTag(nameEl.value);
      });
    }
    return f;
  }

  function renderTagUsage(box, usedBy) {
    if (!box) return;
    box.innerHTML = '';
    const u = usedBy && typeof usedBy === 'object' ? usedBy : { sections: [], collections: [] };
    const secs = Array.isArray(u.sections) ? u.sections : [];
    const cols = Array.isArray(u.collections) ? u.collections : [];
    if (!secs.length && !cols.length) {
      box.appendChild(el('p', 'muted text-sm', 'Not used as a content source yet. Reference this tag from a Home section or Collection with source “Custom Tag”.'));
      return;
    }
    box.appendChild(el('p', 'muted text-sm', 'Used by (real references — edit those first before deleting):'));
    secs.forEach((s) => {
      const p = el('p', 'row-meta', 'Home: ' + (s.title || s.id) + ' (' + s.id + ')');
      box.appendChild(p);
    });
    cols.forEach((c) => {
      const p = el('p', 'row-meta', 'Collection: ' + (c.title || c.slug) + ' (/collection/' + c.slug + ')');
      box.appendChild(p);
    });
  }

  function openTagEditor(item) {
    tagEditing = item ? item.slug : null;
    tagDetailGen++; // invalidate any stale detail flight
    const node = tagEditorNode(item);
    openDrawer({
      kicker: 'Tags',
      title: item ? 'Edit tag' : 'New tag',
      sub: item ? item.slug + ' — renaming the display name never loses titles.' : 'Editorial content groups reusable as Custom Tag sources.',
      node,
      form: node,
    });
    const slugEl = $('t-slug');
    if (slugEl && item) slugEl.disabled = true;
    // Fresh usage for existing tags (best-effort, stale-guarded).
    if (item && item.slug) {
      const myGen = tagDetailGen;
      const slug = item.slug;
      api(API.tags + '/' + encodeURIComponent(slug)).then(
        (d) => { if (myGen === tagDetailGen && d && d.slug === slug) renderTagUsage($('tag-usage'), d.used_by); },
        () => { if (myGen === tagDetailGen) renderTagUsage($('tag-usage'), null); }
      );
    } else {
      renderTagUsage($('tag-usage'), null);
    }
  }

  function readTagForm() {
    const name = $('t-name').value.trim();
    if (!name) throw { message: 'Name is required.' };
    if (name.length > 120) throw { message: 'Name must be at most 120 characters.' };
    let slug = '';
    if (tagEditing) {
      slug = tagEditing;
    } else {
      const err = vSlug($('t-slug').value.trim().toLowerCase());
      if (err) throw { message: err };
      slug = $('t-slug').value.trim().toLowerCase();
    }
    const desc = $('t-desc').value;
    if (desc.length > 500) throw { message: 'Description must be at most 500 characters.' };
    return {
      slug,
      name,
      description: desc.trim(),
      visible: $('t-visible').checked,
      badge: $('t-badge').checked,
    };
  }

  async function saveTag() {
    const form = $('tag-form');
    setFormSaving(form, true);
    try {
      const body = readTagForm();
      let saved;
      if (tagEditing) {
        // Full update carries the current server membership through so a
        // field-only edit never wipes titles (read-modify-write).
        const cur = await api(API.tags + '/' + encodeURIComponent(tagEditing));
        saved = await api(API.tags + '/' + encodeURIComponent(tagEditing), {
          method: 'PUT',
          body: { ...body, slug: tagEditing, members: Array.isArray(cur.members) ? cur.members : [] },
        });
      } else {
        saved = await api(API.tags, { method: 'POST', body: { ...body, members: [] } });
      }
      // Never trust the 200 alone: read the row back and compare.
      const readBack = await api(API.tags + '/' + encodeURIComponent(saved && saved.slug ? saved.slug : body.slug));
      if (stableTagJson(saved) !== stableTagJson(readBack)) {
        notice('err', 'Tag saved, but a fresh read-back differs — not showing success. Refresh and retry.');
      } else {
        notice('ok', tagEditing ? 'Tag updated.' : 'Tag created.');
      }
      tagEditing = null;
      closeDrawer();
      await loadTags();
      if (currentView === 'dashboard') loadDashboard();
    } catch (e) {
      notice('err', (e.message || e));
    } finally {
      setFormSaving(form, false);
    }
  }

  async function toggleTag(t) {
    try {
      const cur = await api(API.tags + '/' + encodeURIComponent(t.slug));
      await api(API.tags + '/' + encodeURIComponent(t.slug), {
        method: 'PUT',
        body: { ...cur, slug: t.slug, visible: !(cur.visible !== false) },
      });
      notice('ok', (t.visible === false ? 'Tag shown — usable by public sources.' : 'Tag hidden — removed from all public surfaces.'));
      await loadTags();
    } catch (e) {
      notice('err', e.message || e);
    }
  }

  async function deleteTag(t) {
    const label = t.name || t.slug;
    // Fresh detail first so the confirm shows real counts + real usage —
    // and blocks client-side when referenced (server 409s regardless).
    let detail = null;
    try {
      detail = await api(API.tags + '/' + encodeURIComponent(t.slug));
    } catch (e) {
      notice('err', 'Could not load tag details: ' + (e.message || e));
      return;
    }
    const n = detail && Array.isArray(detail.members) ? detail.members.length : 0;
    const u = (detail && detail.used_by) || { sections: [], collections: [] };
    const refs = (u.sections || []).length + (u.collections || []).length;
    if (refs) {
      const where = []
        .concat((u.sections || []).map((s) => 'Home: ' + (s.title || s.id)))
        .concat((u.collections || []).map((c) => 'Collection: ' + (c.title || c.slug)));
      notice('err', 'Tag "' + label + '" is still used as a content source (' + where.join('; ') + '). Remove it from those first — deletion is blocked while referenced.');
      return;
    }
    const ok = await confirmDialog({
      title: 'Delete tag?',
      message: 'Delete tag "' + label + '" (' + t.slug + ', ' + n + (n === 1 ? ' title' : ' titles') + ')? Membership is identity-only — no titles, overrides, picks or TMDB data are touched. This cannot be undone.',
      okLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await api(API.tags + '/' + encodeURIComponent(t.slug), { method: 'DELETE' });
      if (tagEditing === t.slug) tagEditing = null;
      notice('ok', 'Tag deleted.');
      await loadTags();
      if (currentView === 'dashboard') loadDashboard();
    } catch (e) {
      // 409 race (referenced between detail load and DELETE) surfaces the
      // server's real reference list instead of a bare failure.
      if (e && e.status === 409) {
        notice('err', (e.message || 'Tag is still referenced.') + ' Remove it from those sources first.');
        await loadTags();
        return;
      }
      notice('err', e.message || e);
    }
  }

  /* ---------- Manage Titles (per-tag membership workspace) ---------- */

  function tagMemberKey(m) { return (m.media === 'tv' ? 'tv' : 'movie') + ':' + m.id; }

  // Progressive title resolution for member rows: chunked detail fetches
  // (12 at a time, session-cached) so a 200-title tag never fires 200
  // requests at once. Stale-guarded: only the current drawer generation
  // paints. Identity-keyed: a response can only fill its own media:id row.
  async function resolveTagMemberTitles(members, myGen, onChunk) {
    const missing = (members || []).filter((m) => m && m.id > 0 && !tagTitleCache[tagMemberKey(m)]);
    for (let i = 0; i < missing.length; i += 12) {
      if (myGen !== tagDetailGen) return; // drawer moved on — drop the rest
      const chunk = missing.slice(i, i + 12);
      const settled = await Promise.allSettled(chunk.map((m) =>
        colDetailFetch(m.media, m.id).then((d) => ({ key: tagMemberKey(m), d }))
      ));
      if (myGen !== tagDetailGen) return;
      for (const s of settled) {
        if (s.status !== 'fulfilled' || !s.value) continue;
        const { key, d } = s.value;
        if (!d) continue;
        tagTitleCache[key] = {
          title: d.title || 'Untitled',
          poster: d.poster_path || d.backdrop_path || null,
        };
      }
      if (typeof onChunk === 'function') { try { onChunk(); } catch { /* noop */ } }
    }
  }

  function tagMemberRow(m, idx, total, onChange) {
    const key = tagMemberKey(m);
    const known = tagTitleCache[key] || null;
    const card = el('div', 'data-row ov-card');
    const thumb = document.createElement('img');
    thumb.className = 'ov-thumb';
    thumb.loading = 'lazy';
    thumb.alt = '';
    thumb.src = (known && known.poster ? COL_PREVIEW_IMG + known.poster : 'https://via.placeholder.com/48x72?text=?');
    card.appendChild(thumb);
    const main = el('div', 'ov-card-main');
    const head = el('div', 'row-top');
    head.appendChild(el('span', 'row-mono muted', String(idx + 1) + '.'));
    head.appendChild(el('span', 'row-title', (known && known.title) || (key + (known ? '' : ' — loading…'))));
    head.appendChild(el('span', 'badge', m.media === 'tv' ? 'TV' : 'Movie'));
    main.appendChild(head);
    main.appendChild(el('p', 'row-mono muted', key));
    main.appendChild(rowButtons([
      ['↑ Up', '', () => onChange('move', idx, -1), idx === 0 ? 'Already first' : 'Move up', idx === 0],
      ['↓ Down', '', () => onChange('move', idx, 1), idx === total - 1 ? 'Already last' : 'Move down', idx === total - 1],
      ['Remove', 'danger', () => onChange('remove', idx), 'Remove from this tag only'],
    ]));
    card.appendChild(main);
    return card;
  }

  // Single write path for membership mutations (add/remove/reorder):
  // full-replace PUT of the ordered list + read-back verify. Positions are
  // list order (gapless) — the server normalizes the same way.
  async function putTagMembers(slug, members, successMsg) {
    const cur = await api(API.tags + '/' + encodeURIComponent(slug));
    const saved = await api(API.tags + '/' + encodeURIComponent(slug), {
      method: 'PUT',
      body: { slug, name: cur.name, description: cur.description || '', visible: cur.visible !== false, badge: cur.badge === true, members },
    });
    const readBack = await api(API.tags + '/' + encodeURIComponent(slug));
    if (stableTagJson(saved) !== stableTagJson(readBack)) {
      throw { message: 'Saved, but a fresh read-back differs — refresh and retry.' };
    }
    tagDetail = readBack;
    const idx = tagCache.findIndex((t) => t && t.slug === slug);
    if (idx >= 0) {
      tagCache[idx] = {
        ...tagCache[idx],
        member_count: Array.isArray(readBack.members) ? readBack.members.length : 0,
        movie_count: (readBack.members || []).filter((m) => m.media === 'movie').length,
        tv_count: (readBack.members || []).filter((m) => m.media === 'tv').length,
      };
    }
    if (successMsg) notice('ok', successMsg);
    return readBack;
  }

  function renderTagMembers() {
    const host = $('tag-members-list');
    if (!host || !tagDetail) return;
    const members = Array.isArray(tagDetail.members) ? tagDetail.members : [];
    const q = String(($('tag-members-search') && $('tag-members-search').value) || '').trim().toLowerCase();
    host.innerHTML = '';
    const countEl = $('tag-members-count');
    if (countEl) {
      const mv = members.filter((m) => m.media === 'movie').length;
      countEl.textContent = members.length
        ? members.length + (members.length === 1 ? ' title' : ' titles') + ' · ' + mv + ' movies · ' + (members.length - mv) + ' TV'
        : '';
    }
    if (!members.length) {
      const box = stateBox(host, 'empty', 'No titles assigned', 'Search TMDB below and add titles — membership is identity-only, order is editorial.');
      void box;
      return;
    }
    const rows = members
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => {
        if (!q) return true;
        const key = tagMemberKey(m);
        const known = tagTitleCache[key];
        const hay = (key + ' ' + ((known && known.title) || '')).toLowerCase();
        return hay.indexOf(q) >= 0;
      });
    if (!rows.length) {
      stateBox(host, 'empty', 'No matches', 'Try a different search.');
      return;
    }
    const onChange = (op, idx, dir) => mutateTagMembers(op, idx, dir);
    rows.forEach(({ m, i }) => host.appendChild(tagMemberRow(m, i, members.length, onChange)));
  }

  async function mutateTagMembers(op, idx, dir) {
    if (!tagDetail) return;
    const slug = tagDetail.slug;
    const members = Array.isArray(tagDetail.members) ? tagDetail.members.slice() : [];
    if (op === 'remove') {
      const m = members[idx];
      if (!m) return;
      const ok = await confirmDialog({
        title: 'Remove title?',
        message: 'Remove ' + tagMemberKey(m) + ' from tag "' + (tagDetail.name || slug) + '"? Only the membership is removed — nothing else is touched.',
        okLabel: 'Remove',
      });
      if (!ok) return;
      members.splice(idx, 1);
      try {
        await putTagMembers(slug, members, 'Title removed.');
        renderTagMembers();
        renderTags();
      } catch (e) { notice('err', (e.message || e)); }
      return;
    }
    if (op === 'move') {
      const j = idx + dir;
      if (j < 0 || j >= members.length) return;
      const tmp = members[idx];
      members[idx] = members[j];
      members[j] = tmp;
      try {
        document.querySelectorAll('#tag-members-list button').forEach((b) => { b.disabled = true; });
        await putTagMembers(slug, members, 'Order updated.');
        renderTagMembers();
      } catch (e) {
        notice('err', (e.message || e));
        renderTagMembers();
      }
      return;
    }
  }

  async function searchTagTitles() {
    const host = $('tag-add-results');
    const qEl = $('tag-add-q');
    const q = qEl ? String(qEl.value || '').trim() : '';
    if (!q) { if (host) host.innerHTML = '<p class="muted text-sm">Type a title first.</p>'; return; }
    if (q.length > 120) { if (host) host.innerHTML = '<p class="muted text-sm">Query must be at most 120 characters.</p>'; return; }
    const myGen = ++tagAddGen;
    if (host) host.innerHTML = '<p class="muted text-sm">Searching TMDB…</p>';
    try {
      const raw = await tmdbSearchFetch(q);
      if (myGen !== tagAddGen) return; // stale: a newer query owns the list
      const rows = normalizeTmdbSearchResults(raw).slice(0, 8);
      if (!host || myGen !== tagAddGen) return;
      host.innerHTML = '';
      if (!rows.length) { host.innerHTML = '<p class="muted text-sm">No matches. Try another spelling.</p>'; return; }
      const inTag = (media, id) => (tagDetail && Array.isArray(tagDetail.members)
        ? tagDetail.members.some((m) => m.media === media && m.id === id)
        : false);
      const isSel = (media, id) => tagAddSel.some((s) => s.media === media && s.id === id);
      rows.forEach((r) => {
        const row = el('div', 'hero-pick-result');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = isSel(r.media, r.id);
        box.disabled = inTag(r.media, r.id);
        box.setAttribute('aria-label', 'Select ' + r.title + ' (' + r.media + ':' + r.id + ')');
        box.addEventListener('change', () => {
          if (box.checked) {
            if (!isSel(r.media, r.id)) tagAddSel.push({ media: r.media, id: r.id });
          } else {
            tagAddSel = tagAddSel.filter((s) => !(s.media === r.media && s.id === r.id));
          }
          refreshTagAddBar();
          // No dirty flag: selection alone saves nothing (Add N Titles does
          // an immediate verified PUT), so the drawer savebar stays out.
        });
        row.appendChild(box);
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = '';
        img.src = tmdbPosterUrl(r.poster) || 'https://via.placeholder.com/48x72?text=?';
        row.appendChild(img);
        const body = el('div', '');
        body.style.cssText = 'min-width:0;flex:1';
        body.appendChild(el('p', 'row-title', r.title));
        body.appendChild(el('p', 'muted text-sm', (r.media === 'tv' ? 'TV' : 'Movie') + ' · ' + (r.year || '—') + ' · TMDB ' + r.media + ':' + r.id + (inTag(r.media, r.id) ? ' · already in tag' : '')));
        row.appendChild(body);
        host.appendChild(row);
      });
      refreshTagAddBar();
    } catch (e) {
      if (host && myGen === tagAddGen) host.innerHTML = '<p class="muted text-sm">Search failed: ' + esc((e && e.message) || e) + '</p>';
    }
  }

  function refreshTagAddBar() {
    const bar = $('tag-add-bar');
    if (!bar) return;
    bar.innerHTML = '';
    if (!tagAddSel.length) {
      bar.appendChild(el('span', 'muted text-sm', 'Tick titles above to select more than one, then add them together.'));
      return;
    }
    bar.appendChild(el('span', 'muted text-sm', tagAddSel.length + (tagAddSel.length === 1 ? ' title' : ' titles') + ' selected'));
    const add = el('button', 'btn btn-primary btn-sm', 'Add ' + tagAddSel.length + (tagAddSel.length === 1 ? ' Title' : ' Titles'));
    add.type = 'button';
    add.addEventListener('click', addSelectedTagTitles);
    bar.appendChild(add);
    const clear = el('button', 'btn btn-ghost btn-sm', 'Clear');
    clear.type = 'button';
    clear.addEventListener('click', () => { tagAddSel = []; refreshTagAddBar(); });
    bar.appendChild(clear);
  }

  async function addSelectedTagTitles() {
    if (!tagDetail || !tagAddSel.length) return;
    const slug = tagDetail.slug;
    const members = Array.isArray(tagDetail.members) ? tagDetail.members.slice() : [];
    const seen = new Set(members.map(tagMemberKey));
    let added = 0;
    for (const s of tagAddSel) {
      const k = tagMemberKey(s);
      if (seen.has(k)) continue; // duplicate-safe: re-adding never doubles
      seen.add(k);
      members.push({ media: s.media, id: s.id });
      added++;
    }
    if (!added) {
      notice('err', 'Those titles are already in this tag — no duplicates added.');
      tagAddSel = [];
      refreshTagAddBar();
      return;
    }
    try {
      document.querySelectorAll('#tag-members-list button, #tag-add-bar button').forEach((b) => { b.disabled = true; });
      await putTagMembers(slug, members, added + (added === 1 ? ' title added.' : ' titles added.'));
      tagAddSel = [];
      const res = $('tag-add-results');
      if (res) res.innerHTML = '<p class="muted text-sm">Added — search again to add more.</p>';
      refreshTagAddBar();
      renderTagMembers();
      renderTags();
      const myGen = tagDetailGen;
      resolveTagMemberTitles(tagDetail.members, myGen, () => { if (myGen === tagDetailGen) renderTagMembers(); });
    } catch (e) {
      notice('err', (e.message || e));
      renderTagMembers();
    }
  }

  async function openTagMembers(slug) {
    const myGen = ++tagDetailGen;
    tagAddSel = [];
    openDrawer({
      kicker: 'Tags',
      title: 'Manage titles',
      sub: slug + ' — loading…',
      node: (() => {
        const w = el('div', '');
        w.style.cssText = 'display:grid;gap:.8rem';
        w.appendChild(el('div', 'hero-preview-body', ''));
        return w;
      })(),
      form: null,
    });
    // Replace the placeholder with the real workspace once fresh detail lands.
    let detail = null;
    try {
      detail = await api(API.tags + '/' + encodeURIComponent(slug));
    } catch (e) {
      if (myGen !== tagDetailGen) return;
      notice('err', 'Could not load tag: ' + (e.message || e));
      closeDrawer();
      return;
    }
    if (myGen !== tagDetailGen) return; // stale: a newer drawer owns the view
    tagDetail = detail;
    const body = $('drawer-body');
    if (!body) return;
    body.innerHTML = '';
    const wrap = el('div', '');
    wrap.style.cssText = 'display:grid;gap:.8rem';
    const head = el('div', '');
    head.appendChild(el('p', 'row-title', detail.name || detail.slug));
    const mv = (detail.members || []).filter((m) => m.media === 'movie').length;
    const n = (detail.members || []).length;
    head.appendChild(el('p', 'muted text-sm', detail.slug + ' · ' + n + (n === 1 ? ' title' : ' titles') + ' · ' + mv + ' movies · ' + (n - mv) + ' TV'));
    wrap.appendChild(head);
    const usage = el('div', '');
    usage.id = 'tag-members-usage';
    wrap.appendChild(groupBox('Used by', [usage]));
    renderTagUsage(usage, detail.used_by);
    const searchRow = el('div', '');
    searchRow.style.cssText = 'display:flex;gap:.5rem';
    const q = textInput('tag-add-q', '', 'Search TMDB to add…');
    q.setAttribute('aria-label', 'Search TMDB titles to add');
    const go = el('button', 'btn btn-secondary btn-sm', 'Search TMDB');
    go.type = 'button';
    searchRow.appendChild(q);
    searchRow.appendChild(go);
    const res = el('div', 'hero-pick-results');
    res.id = 'tag-add-results';
    const bar = el('div', 'ov-pick-row');
    bar.id = 'tag-add-bar';
    bar.appendChild(el('span', 'muted text-sm', 'Tick titles above to select more than one, then add them together.'));
    const runSearch = () => searchTagTitles();
    go.addEventListener('click', runSearch);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } });
    wrap.appendChild(groupBox('Add Titles', [searchRow, res, bar]));
    const listHead = el('div', '');
    const msq = textInput('tag-members-search', '', 'Filter assigned titles…');
    msq.setAttribute('aria-label', 'Filter assigned titles');
    msq.addEventListener('input', renderTagMembers);
    listHead.appendChild(msq);
    const cnt = el('p', 'muted text-sm', '');
    cnt.id = 'tag-members-count';
    listHead.appendChild(cnt);
    const list = el('div', 'row-list');
    list.id = 'tag-members-list';
    wrap.appendChild(groupBox('Assigned Titles', [listHead, list]));
    const row = el('div', '');
    row.style.cssText = 'display:flex;gap:.5rem;flex-wrap:wrap';
    const editBtn = el('button', 'btn btn-secondary btn-sm', 'Edit Tag');
    editBtn.type = 'button';
    editBtn.addEventListener('click', () => openTagEditor({ slug: detail.slug, name: detail.name, description: detail.description, visible: detail.visible, badge: detail.badge }));
    const done = el('button', 'btn btn-ghost btn-sm', 'Done');
    done.type = 'button';
    done.addEventListener('click', closeDrawer);
    row.appendChild(editBtn);
    row.appendChild(done);
    wrap.appendChild(row);
    body.appendChild(wrap);
    // Titles resolve progressively (chunked, cached, stale-guarded) —
    // rows are usable (media:id + reorder + remove) before titles land.
    renderTagMembers();
    resolveTagMemberTitles(detail.members, myGen, () => { if (myGen === tagDetailGen) renderTagMembers(); });
    try {
      const sub = $('drawer-sub');
      if (sub) sub.textContent = detail.slug + ' — ' + n + (n === 1 ? ' title' : ' titles') + ', tag order is the content order.';
      const title = $('drawer-title');
      if (title) title.textContent = 'Manage titles — ' + (detail.name || detail.slug);
    } catch { /* chrome optional */ }
  }

  /* ================= OVERRIDES ================= */
  let ovEditing = null; // { media, id } being edited, or null
  let ovIsNew = false; // true = POST on save, false = PUT on save
  let ovBaseline = null; // live TMDB detail bundle for the edited identity (preview/status baseline only)
  let ovBaselineFor = ''; // 'media:id' the baseline belongs to — never applied to another identity
  let ovGen = 0; // stale-guard generation for baseline fetches
  let ovSearchGen = 0; // stale-guard generation for in-editor TMDB searches
  const OV_IMG_SM = 'https://image.tmdb.org/t/p/w200';

  // Grouped presentation of the 11 real overridable keys (the allowlist in
  // functions/lib/validate.js — nothing invented, nothing hidden). `base`
  // maps each key to the TMDB detail-bundle field shown as its baseline.
  const OV_FIELD_GROUPS = [
    {
      title: 'Metadata',
      note: 'Title and name are aliases in public rendering (kept in sync); description is Greybox’s name for the synopsis — when both overview and description are set, description wins.',
      fields: [
        { key: 'title', label: 'Title override', kind: 'text', base: 'title' },
        { key: 'name', label: 'Alt. name override', kind: 'text', base: 'name', hint: 'Rarely needed — public rendering syncs title ⇄ name.' },
        { key: 'overview', label: 'Synopsis override (overview)', kind: 'area', base: 'overview' },
        { key: 'description', label: 'Synopsis override (Greybox description)', kind: 'area', base: 'overview', hint: 'Wins over overview when both are set.' },
        { key: 'vote_average', label: 'Rating override', kind: 'number', base: 'vote_average', hint: 'Numeric, e.g. 8.5.' },
        { key: 'release_date', label: 'Release date override', kind: 'text', base: 'release_date', hint: 'Primary for Movies (YYYY-MM-DD).' },
        { key: 'first_air_date', label: 'First-air date override', kind: 'text', base: 'first_air_date', hint: 'Primary for TV Shows (YYYY-MM-DD).' },
      ],
    },
    {
      title: 'Artwork',
      note: 'TMDB-style image paths (e.g. /abc123.jpg). Thumbnails below resolve against the same identity — never mixed across titles.',
      fields: [
        { key: 'poster_path', label: 'Poster override', kind: 'text', base: 'poster_path', art: 'poster' },
        { key: 'backdrop_path', label: 'Backdrop override', kind: 'text', base: 'backdrop_path', art: 'backdrop' },
      ],
    },
    {
      title: 'Editorial',
      note: 'A Greybox Pick is exactly featured + the “Greybox Pick” badge on the stored row. The switch below drives both without touching other fields.',
      fields: [
        { key: 'featured', label: 'Featured flag', kind: 'check' },
        { key: 'custom_badge', label: 'Badge override', kind: 'text', hint: 'Shown on cards and the detail page.' },
      ],
    },
  ];

  function ovFieldDef(key) {
    for (const g of OV_FIELD_GROUPS) {
      for (const f of g.fields) if (f.key === key) return f;
    }
    return null;
  }

  // Display label for a stored row: stored title/name win, otherwise the
  // bare identity (never invent a title from elsewhere).
  function ovDisplayLabel(o) {
    if (!o) return '';
    const t = String(o.title || o.name || '').trim();
    if (t) return t.slice(0, 200);
    return (o.media || '?') + ':' + (o.tmdb_id != null ? o.tmdb_id : '?');
  }

  // Lenient read of the current editor inputs (never throws for preview/
  // status purposes): { media, id, values } with values keyed by field.
  function readOvInputs() {
    const out = { media: null, id: 0, values: {} };
    try {
      const mEl = $('o-media');
      const idEl = $('o-id');
      const m = mEl ? mEl.value : '';
      out.media = (m === 'tv' || m === 'movie') ? m : null;
      out.id = idEl ? parseInt(idEl.value, 10) : NaN;
      for (const g of OV_FIELD_GROUPS) {
        for (const f of g.fields) {
          const n = document.getElementById('o-' + f.key);
          if (!n) continue;
          if (f.kind === 'check') out.values[f.key] = !!n.checked;
          else out.values[f.key] = String(n.value == null ? '' : n.value).trim();
        }
      }
    } catch { /* preview/status must never break editing */ }
    return out;
  }

  function ovInputIsSet(key, values) {
    const v = values[key];
    if (key === 'featured') return v === true;
    return typeof v === 'string' && v !== '';
  }

  // Effective public value for one field (mirrors applyOverrides in
  // js/data.js): form value wins, otherwise the TMDB baseline.
  function ovEffective(key, values, base) {
    const b = base && typeof base === 'object' ? base : {};
    if (key === 'title' || key === 'name') {
      if (values.title) return values.title;
      if (values.name) return values.name;
      return String(b.title || b.name || '');
    }
    if (key === 'overview' || key === 'description') {
      if (values.description) return values.description;
      if (values.overview) return values.overview;
      return String(b.overview || '');
    }
    if (key === 'vote_average') {
      if (values.vote_average !== '') {
        const n = Number(values.vote_average);
        if (Number.isFinite(n)) return String(n);
      }
      return (b.vote_average != null && b.vote_average !== '') ? String(b.vote_average) : '';
    }
    if (key === 'featured') return values.featured === true ? 'On' : 'Off (TMDB default)';
    if (key === 'custom_badge') return values.custom_badge || '';
    return values[key] || String(b[key] != null ? b[key] : '');
  }

  function ovArtUrl(path, size) {
    if (typeof path !== 'string' || !path) return '';
    if (!tmdbPosterUrl(path)) return '';
    return (size === 'sm' ? OV_IMG_SM : TMDB_IMG) + path;
  }

  // Live TMDB baseline for exactly one identity, stale-guarded: a slow
  // response for a previously selected title can never paint into the
  // current one (identity + generation both checked on arrival).
  async function ovLoadBaseline(media, id) {
    const key = media + ':' + id;
    const myGen = ++ovGen;
    ovBaseline = null;
    ovBaselineFor = '';
    refreshOvIdentity();
    refreshOvStatuses();
    refreshOvPreview();
    try {
      const d = await fetchJsonGet('/api/' + media + '/' + id);
      if (myGen !== ovGen) return; // stale: a newer identity owns the editor
      const cur = readOvInputs();
      if ((cur.media + ':' + cur.id) !== key) return; // identity changed mid-flight
      ovBaseline = d && typeof d === 'object' ? d : null;
      ovBaselineFor = key;
    } catch (e) {
      if (myGen !== ovGen) return;
      ovBaseline = { _error: (e && e.message) || String(e) };
      ovBaselineFor = key;
    }
    refreshOvIdentity();
    refreshOvStatuses();
    refreshOvPreview();
  }

  function ovSetIdentity(media, id, opts) {
    const mEl = $('o-media');
    const idEl = $('o-id');
    if (mEl) { mEl.value = media; mEl.disabled = true; }
    if (idEl) { idEl.value = String(id); idEl.disabled = true; }
    const choose = $('ov-choose');
    if (choose) choose.classList.add('hidden');
    const idBox = $('ov-identity');
    if (idBox) idBox.classList.remove('hidden');
    setDrawerDirty(true);
    if (!(opts && opts.skipBaseline)) ovLoadBaseline(media, id);
    else { refreshOvIdentity(); refreshOvStatuses(); refreshOvPreview(); }
  }

  function ovClearIdentity() {
    const mEl = $('o-media');
    const idEl = $('o-id');
    if (mEl) { mEl.disabled = false; }
    if (idEl) { idEl.disabled = false; idEl.value = ''; }
    ovGen++; // invalidate any baseline flight for the previous identity
    ovBaseline = null;
    ovBaselineFor = '';
    const choose = $('ov-choose');
    if (choose) choose.classList.remove('hidden');
    const idBox = $('ov-identity');
    if (idBox) idBox.classList.add('hidden');
    setDrawerDirty(true);
    refreshOvStatuses();
    refreshOvPreview();
  }

  async function ovSearchTitles() {
    const qEl = $('ov-tmdb-q');
    const host = $('ov-tmdb-results');
    const q = qEl ? String(qEl.value || '').trim() : '';
    if (!q) { if (host) host.innerHTML = '<p class="muted text-sm">Type a title first.</p>'; return; }
    if (q.length > 120) { if (host) host.innerHTML = '<p class="muted text-sm">Query must be at most 120 characters.</p>'; return; }
    const myGen = ++ovSearchGen;
    if (host) host.innerHTML = '<p class="muted text-sm">Searching TMDB…</p>';
    try {
      const raw = await tmdbSearchFetch(q);
      if (myGen !== ovSearchGen) return; // stale: a newer query owns the list
      const rows = normalizeTmdbSearchResults(raw).slice(0, 8);
      if (!host || myGen !== ovSearchGen) return;
      host.innerHTML = '';
      if (!rows.length) { host.innerHTML = '<p class="muted text-sm">No matches. Try another spelling.</p>'; return; }
      rows.forEach((r) => {
        const row = el('div', 'hero-pick-result');
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = '';
        img.src = tmdbPosterUrl(r.poster) || 'https://via.placeholder.com/48x72?text=?';
        row.appendChild(img);
        const body = el('div', '');
        body.style.cssText = 'min-width:0;flex:1';
        body.appendChild(el('p', 'row-title', r.title));
        body.appendChild(el('p', 'muted text-sm', (r.media === 'tv' ? 'TV' : 'Movie') + ' · ' + (r.year || '—') + ' · TMDB ' + r.media + ':' + r.id));
        row.appendChild(body);
        const sel = el('button', 'rowbtn go', 'Select');
        sel.type = 'button';
        sel.setAttribute('aria-label', 'Select ' + r.title + ' (' + r.media + ':' + r.id + ')');
        sel.addEventListener('click', () => ovSetIdentity(r.media, r.id));
        row.appendChild(sel);
        host.appendChild(row);
      });
    } catch (e) {
      if (host && myGen === ovSearchGen) host.innerHTML = '<p class="muted text-sm">Search failed: ' + esc((e && e.message) || e) + '</p>';
    }
  }

  function ovChooserNode() {
    const wrap = el('div', '');
    wrap.id = 'ov-choose';
    wrap.style.cssText = 'display:grid;gap:.7rem';
    wrap.appendChild(el('span', 'flabel', 'Find the title on TMDB (no need to know its ID)'));
    const row = el('div', '');
    row.style.cssText = 'display:flex;gap:.5rem';
    const q = textInput('ov-tmdb-q', '', 'Fight Club');
    q.setAttribute('aria-label', 'Search TMDB titles');
    const go = el('button', 'btn btn-secondary btn-sm', 'Search TMDB');
    go.type = 'button';
    row.appendChild(q);
    row.appendChild(go);
    wrap.appendChild(row);
    const res = el('div', 'hero-pick-results');
    res.id = 'ov-tmdb-results';
    wrap.appendChild(res);
    const run = () => ovSearchTitles();
    go.addEventListener('click', run);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
    wrap.appendChild(el('p', 'muted text-sm', 'Selecting a result locks media + TMDB ID as this override’s identity. Search uses the existing server-side proxy — no key in the browser.'));
    return wrap;
  }

  // Identity header: baseline title/artwork for the locked identity, or the
  // loading/error state. Reads only ovBaselineFor — never another title.
  function refreshOvIdentity() {
    const box = $('ov-identity');
    if (!box) return;
    box.innerHTML = '';
    const cur = readOvInputs();
    if (!cur.media || !(cur.id > 0)) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    const key = cur.media + ':' + cur.id;
    const top = el('div', 'ov-id-top');
    const b = (ovBaselineFor === key && ovBaseline && !ovBaseline._error) ? ovBaseline : null;
    const bErr = (ovBaselineFor === key && ovBaseline && ovBaseline._error) ? ovBaseline._error : '';
    const img = document.createElement('img');
    img.className = 'ov-id-thumb';
    img.loading = 'lazy';
    img.alt = '';
    const art = b ? (b.poster_path || b.backdrop_path) : '';
    img.src = ovArtUrl(art, 'sm') || 'https://via.placeholder.com/48x72?text=?';
    top.appendChild(img);
    const body = el('div', '');
    body.style.cssText = 'min-width:0;flex:1';
    const title = b ? String(b.title || b.name || 'Untitled') : 'Loading TMDB data…';
    body.appendChild(el('p', 'row-title', title));
    const year = b ? String(b.release_date || b.first_air_date || '').slice(0, 4) : '';
    body.appendChild(el('p', 'muted text-sm', (cur.media === 'tv' ? 'TV Show' : 'Movie') + (year ? ' · ' + year : '') + ' · ' + key));
    if (bErr) body.appendChild(el('p', 'muted text-sm', 'TMDB baseline unavailable: ' + bErr));
    top.appendChild(body);
    box.appendChild(top);
    const actions = el('div', '');
    actions.style.cssText = 'display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.5rem';
    const open = el('button', 'btn btn-secondary btn-sm', 'Open ↗');
    open.type = 'button';
    open.title = 'Open the public page for ' + key;
    open.addEventListener('click', () => { try { window.open(detailUrlFor(cur.media, cur.id), '_blank', 'noopener'); } catch { /* noop */ } });
    actions.appendChild(open);
    if (ovIsNew) {
      const diff = el('button', 'btn btn-ghost btn-sm', '← Choose different title');
      diff.type = 'button';
      diff.addEventListener('click', ovClearIdentity);
      actions.appendChild(diff);
    }
    box.appendChild(actions);
  }

  // One grouped field row: label + live status pill + Reset + input +
  // baseline line. Reset clears the input (empty = field removed on save —
  // real backend semantics: PUT replaces all fields, empties are dropped).
  function ovFieldRow(f, item) {
    const wrap = el('div', '');
    wrap.dataset.ovField = f.key;
    const head = el('div', 'ov-field-head');
    head.appendChild(el('span', 'flabel', f.label));
    const pill = el('span', 'badge', 'TMDB');
    pill.dataset.ovPill = f.key;
    head.appendChild(pill);
    const reset = el('button', 'rowbtn', 'Reset');
    reset.type = 'button';
    reset.title = 'Clear this field — falls back to TMDB on save';
    reset.dataset.ovReset = f.key;
    reset.addEventListener('click', () => {
      const n = document.getElementById('o-' + f.key);
      if (!n) return;
      if (f.kind === 'check') n.checked = false;
      else n.value = '';
      setDrawerDirty(true);
      refreshOvStatuses();
      refreshOvPreview();
    });
    head.appendChild(reset);
    wrap.appendChild(head);
    let input;
    const cur = item && item[f.key] != null ? item[f.key] : '';
    if (f.kind === 'check') input = checkInput('o-' + f.key, cur === true, f.key);
    else if (f.kind === 'number') input = numInput('o-' + f.key, cur, '8.5');
    else if (f.kind === 'area') input = areaInput('o-' + f.key, cur, '', 2);
    else input = textInput('o-' + f.key, cur, f.art ? '/abc123.jpg' : '');
    wrap.appendChild(input);
    if (f.hint) wrap.appendChild(el('p', 'muted text-sm', f.hint));
    const base = el('p', 'muted text-sm ov-base');
    base.dataset.ovBase = f.key;
    wrap.appendChild(base);
    return wrap;
  }

  function ovBaseLine(f, base) {
    if (!base || base._error) return '';
    if (f.key === 'featured' || f.key === 'custom_badge') return '';
    if (f.art) return base[f.base] ? 'TMDB: ' + base[f.base] : 'TMDB: (no artwork)';
    if (f.key === 'vote_average') return 'TMDB: ' + (base.vote_average != null ? base.vote_average : '—');
    const v = base[f.base];
    if (typeof v === 'string' && v.trim()) return 'TMDB: ' + v.trim().slice(0, 140);
    return 'TMDB: —';
  }

  // Per-field Using-TMDB vs Override-active pills + baseline lines. Baseline
  // applies only when it belongs to the currently entered identity.
  function refreshOvStatuses() {
    const cur = readOvInputs();
    const key = cur.media && cur.id > 0 ? cur.media + ':' + cur.id : '';
    const base = (ovBaselineFor === key && ovBaseline && !ovBaseline._error) ? ovBaseline : null;
    document.querySelectorAll('[data-ov-pill]').forEach((pill) => {
      const k = pill.getAttribute('data-ov-pill');
      const on = ovInputIsSet(k, cur.values);
      pill.textContent = on ? 'Override' : 'TMDB';
      pill.className = 'badge ' + (on ? 'badge-pick' : '');
    });
    document.querySelectorAll('[data-ov-base]').forEach((p) => {
      const k = p.getAttribute('data-ov-base');
      const f = ovFieldDef(k);
      p.textContent = f ? ovBaseLine(f, base) : '';
    });
    const pickState = $('ov-pick-state');
    if (pickState) {
      const on = cur.values.custom_badge === PICK_BADGE;
      pickState.textContent = on ? '★ GREYBOX PICK — ON' : 'Greybox Pick — off';
      pickState.className = 'badge ' + (on ? 'badge-pick' : 'badge-soon');
    }
  }

  // TMDB vs GREYBOX preview (unsaved): effective values mirror
  // applyOverrides exactly (title/name sync, description wins as overview).
  // Artwork thumbs resolve both sides for the SAME identity only.
  function refreshOvPreview() {
    const body = $('ov-preview-body');
    if (!body) return;
    const cur = readOvInputs();
    if (!cur.media || !(cur.id > 0)) {
      body.innerHTML = '<p class="muted text-sm">Select a TMDB title above to preview TMDB vs Greybox.</p>';
      return;
    }
    const key = cur.media + ':' + cur.id;
    const base = (ovBaselineFor === key && ovBaseline && !ovBaseline._error) ? ovBaseline : null;
    if (!base) {
      const err = (ovBaselineFor === key && ovBaseline && ovBaseline._error) ? ovBaseline._error : 'loading…';
      body.innerHTML = '';
      body.appendChild(el('p', 'muted text-sm', 'Loading TMDB baseline (' + err + ') — the Greybox column below is live as you type.'));
      return;
    }
    const rows = [
      { label: 'Title', tmdb: String(base.title || base.name || '—'), grey: ovEffective('title', cur.values, base) || '—', over: ovInputIsSet('title', cur.values) || ovInputIsSet('name', cur.values) },
      { label: 'Synopsis', tmdb: String(base.overview || '—').slice(0, 220), grey: String(ovEffective('overview', cur.values, base) || '—').slice(0, 220), over: ovInputIsSet('overview', cur.values) || ovInputIsSet('description', cur.values) },
      { label: 'Rating', tmdb: String(base.vote_average != null ? base.vote_average : '—'), grey: ovEffective('vote_average', cur.values, base) || '—', over: ovInputIsSet('vote_average', cur.values) },
      { label: 'Release date', tmdb: String(base.release_date || '—'), grey: cur.values.release_date || String(base.release_date || '—'), over: ovInputIsSet('release_date', cur.values) },
      { label: 'First-air date', tmdb: String(base.first_air_date || '—'), grey: cur.values.first_air_date || String(base.first_air_date || '—'), over: ovInputIsSet('first_air_date', cur.values) },
    ];
    body.innerHTML = '';
    for (const r of rows) {
      const row = el('div', 'ov-compare' + (r.over ? ' is-over' : ''));
      row.appendChild(el('span', 'ov-compare-label', r.label));
      const vals = el('div', 'ov-compare-vals');
      vals.appendChild(el('p', 'muted text-sm', 'TMDB: ' + r.tmdb));
      const g = el('p', 'ov-compare-grey', 'GREYBOX: ' + r.grey + (r.over ? ' (override)' : ' (TMDB)'));
      vals.appendChild(g);
      row.appendChild(vals);
      body.appendChild(row);
    }
    // Artwork: both thumbs for this identity, override side live.
    const art = el('div', 'ov-compare');
    art.appendChild(el('span', 'ov-compare-label', 'Artwork'));
    const thumbs = el('div', 'ov-art-compare');
    const posterEff = cur.values.poster_path || base.poster_path || '';
    const backEff = cur.values.backdrop_path || base.backdrop_path || '';
    const mkThumb = (path, cap, overridden) => {
      const cell = el('div', 'col-preview-cell');
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '';
      img.src = ovArtUrl(path, 'sm') || 'https://via.placeholder.com/100x150?text=?';
      img.onerror = function () { try { img.src = 'https://via.placeholder.com/100x150?text=?'; } catch (e) { /* noop */ } };
      cell.appendChild(img);
      cell.appendChild(el('p', 'col-preview-cap', cap + (overridden ? ' (override)' : ' (TMDB)')));
      return cell;
    };
    thumbs.appendChild(mkThumb(posterEff, 'Poster', ovInputIsSet('poster_path', cur.values)));
    thumbs.appendChild(mkThumb(backEff, 'Backdrop', ovInputIsSet('backdrop_path', cur.values)));
    art.appendChild(thumbs);
    body.appendChild(art);
    // Editorial: the exact public Pick state from the badge value.
    const pickOn = cur.values.custom_badge === PICK_BADGE;
    const ed = el('div', 'ov-compare' + (pickOn || cur.values.featured ? ' is-over' : ''));
    ed.appendChild(el('span', 'ov-compare-label', 'Editorial'));
    const edVals = el('div', 'ov-compare-vals');
    edVals.appendChild(el('p', 'ov-compare-grey', pickOn ? 'GREYBOX: ★ Greybox Pick' : 'GREYBOX: not a Pick'));
    const badgeTxt = cur.values.custom_badge ? cur.values.custom_badge : String(base.custom_badge || '—');
    edVals.appendChild(el('p', 'muted text-sm', 'Badge: ' + badgeTxt + ' · Featured: ' + (cur.values.featured ? 'on' : 'off')));
    ed.appendChild(edVals);
    body.appendChild(ed);
  }

  function ovPreviewNode() {
    const wrap = el('div', 'hero-preview');
    const bar = el('div', 'hero-preview-bar');
    bar.appendChild(el('span', 'badge badge-soon', 'Preview'));
    bar.appendChild(el('span', 'muted text-sm', 'TMDB vs Greybox — unsaved.'));
    wrap.appendChild(bar);
    const body = el('div', 'hero-preview-body');
    body.id = 'ov-preview-body';
    wrap.appendChild(body);
    return wrap;
  }

  function ovPickSwitchNode() {
    const wrap = el('div', 'ov-pick-row');
    const state = el('span', 'badge badge-soon', 'Greybox Pick — off');
    state.id = 'ov-pick-state';
    wrap.appendChild(state);
    const on = el('button', 'rowbtn go', '★ Pick ON');
    on.type = 'button';
    on.title = 'Enable Greybox Pick (featured + badge)';
    on.addEventListener('click', () => {
      const feat = document.getElementById('o-featured');
      const badge = document.getElementById('o-custom_badge');
      if (feat) feat.checked = true;
      if (badge) badge.value = PICK_BADGE;
      setDrawerDirty(true);
      refreshOvStatuses();
      refreshOvPreview();
    });
    const off = el('button', 'rowbtn', 'Pick OFF');
    off.type = 'button';
    off.title = 'Disable Greybox Pick (keeps other override fields)';
    off.addEventListener('click', () => {
      const feat = document.getElementById('o-featured');
      const badge = document.getElementById('o-custom_badge');
      if (feat) feat.checked = false;
      // Clear only the Pick badge — a custom non-Pick badge is preserved.
      if (badge && badge.value.trim() === PICK_BADGE) badge.value = '';
      setDrawerDirty(true);
      refreshOvStatuses();
      refreshOvPreview();
    });
    wrap.appendChild(on);
    wrap.appendChild(off);
    wrap.appendChild(el('span', 'muted text-sm', 'Same override row — no second Pick system.'));
    return wrap;
  }

  function overrideEditorNode(item) {
    const isEdit = !!(!ovIsNew && item && item.media && item.tmdb_id);
    const f = document.createElement('form');
    f.id = 'ov-form';
    f.autocomplete = 'off';
    f.style.cssText = 'display:grid;gap:.8rem';
    f.appendChild(ovPreviewNode());
    // IDENTITY — media + TMDB ID inputs keep their stable IDs (headless
    // read/write compat); the chooser writes into them for new overrides.
    const idNodes = [
      fieldRow('Media', selectInput('o-media', [['movie', 'Movie'], ['tv', 'TV show']], item ? item.media : 'movie')),
      fieldRow('TMDB ID', numInput('o-id', item ? item.tmdb_id : '', '550')),
    ];
    if (!isEdit) idNodes.push(ovChooserNode());
    const idBox = el('div', '');
    idBox.id = 'ov-identity';
    idBox.className = 'ov-identity';
    idNodes.push(idBox);
    idNodes.push(el('p', 'muted text-sm', 'Identity is locked once chosen — media + TMDB ID is this override’s primary key (rename = delete + create). Empty inputs below mean “not overridden”: clearing a field removes that override on save and TMDB becomes the fallback again.'));
    f.appendChild(groupBox('Identity', idNodes));
    for (const g of OV_FIELD_GROUPS) {
      const nodes = g.fields.map((fld) => ovFieldRow(fld, item));
      if (g.note) nodes.push(el('p', 'muted text-sm', g.note));
      if (g.title === 'Editorial') nodes.unshift(ovPickSwitchNode());
      f.appendChild(groupBox(g.title, nodes));
    }
    const row = el('div', '');
    row.style.cssText = 'display:flex;gap:.5rem;flex-wrap:wrap';
    const save = el('button', 'btn btn-primary btn-sm', isEdit && !ovIsNew ? 'Save Changes' : 'Create override');
    save.type = 'submit';
    const cancel = el('button', 'btn btn-ghost btn-sm', 'Discard');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      // Never silently discard: confirm when the form is dirty. (Drawer
      // scrim/Escape still close globally — Part 0 infrastructure.)
      if (drawerDirty) {
        confirmDialog({ title: 'Discard changes?', message: 'You have unsaved override changes. Discard them?', okLabel: 'Discard' })
          .then((ok) => { if (ok) closeDrawer(); });
        return;
      }
      closeDrawer();
    });
    row.appendChild(save);
    row.appendChild(cancel);
    f.appendChild(row);
    f.addEventListener('submit', (e) => { e.preventDefault(); saveOverride(); });
    // Live status + preview as the operator types (no network per keystroke —
    // the baseline was fetched once for this identity).
    f.addEventListener('input', () => { refreshOvStatuses(); refreshOvPreview(); });
    f.addEventListener('change', () => { refreshOvStatuses(); refreshOvPreview(); });
    return f;
  }

  // hasFields: does the row carry stored override keys (vs a bare identity)?
  function ovRowHasFields(item) {
    if (!item || typeof item !== 'object') return false;
    return OVERRIDE_FIELDS.some((k) => item[k] !== undefined && item[k] !== null && String(item[k]).trim() !== '');
  }

  function openOverrideEditor(item, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const hasIdentity = !!(item && (item.media === 'movie' || item.media === 'tv') && parseInt(item.tmdb_id, 10) > 0);
    ovEditing = hasIdentity ? { media: item.media, id: parseInt(item.tmdb_id, 10) } : null;
    // Explicit flag wins (the Search flow knows existence); otherwise a row
    // with stored fields is an edit and a bare identity is a create. This
    // fixes the old path where creating via Search issued a PUT that 404’d.
    ovIsNew = (o.isNew !== undefined) ? !!o.isNew : (hasIdentity ? !ovRowHasFields(item) : true);
    ovGen++; // invalidate any baseline flight from a previous edit
    ovBaseline = null;
    ovBaselineFor = '';
    const node = overrideEditorNode(hasIdentity ? item : null);
    openDrawer({
      kicker: 'Overrides',
      title: !ovIsNew && hasIdentity ? 'Edit override' : 'New override',
      sub: hasIdentity ? item.media + ':' + parseInt(item.tmdb_id, 10) + ' — TMDB stays the fallback for everything else.' : 'Search TMDB, pick a title, override only what you need.',
      node,
      form: node,
    });
    const mEl = $('o-media');
    const idEl = $('o-id');
    if (mEl && hasIdentity) mEl.disabled = true;
    if (idEl && hasIdentity) idEl.disabled = true;
    const choose = $('ov-choose');
    if (choose && hasIdentity) choose.classList.add('hidden');
    if (hasIdentity) ovLoadBaseline(item.media, parseInt(item.tmdb_id, 10));
    else { refreshOvIdentity(); refreshOvStatuses(); refreshOvPreview(); }
  }

  function buildOverrideForm() { /* built on demand in the drawer */ }
  function fillOverrideForm(item) {
    if (!ADMIN_TOKEN || !$('admin-app') || $('admin-app').classList.contains('hidden')) {
      const hasIdentity = !!(item && (item.media === 'movie' || item.media === 'tv') && parseInt(item.tmdb_id, 10) > 0);
      ovEditing = hasIdentity ? { media: item.media, id: parseInt(item.tmdb_id, 10) } : null;
      ovIsNew = hasIdentity ? !ovRowHasFields(item) : true;
      let host = $('ov-form-host-test');
      if (!host) { host = document.createElement('div'); host.id = 'ov-form-host-test'; host.style.display = 'none'; document.body.appendChild(host); }
      host.innerHTML = '';
      host.appendChild(overrideEditorNode(item));
      const mEl = $('o-media');
      const idEl = $('o-id');
      if (mEl && item) mEl.disabled = true;
      if (idEl && item) idEl.disabled = true;
      return;
    }
    openOverrideEditor(item);
  }

  function readOverrideForm() {
    const media = $('o-media').value;
    if (media !== 'movie' && media !== 'tv') throw { message: "Media must be 'movie' or 'tv'." };
    const id = parseInt($('o-id').value, 10);
    if (!Number.isInteger(id) || id < 1 || id > 2147483647) throw { message: 'TMDB ID must be a positive integer.' };
    const fields = {};
    for (const k of OVERRIDE_FIELDS) {
      const n = document.getElementById('o-' + k);
      if (!n) continue;
      if (k === 'featured') { if (n.checked) fields[k] = true; continue; }
      const raw = n.value;
      if (raw == null || String(raw).trim() === '') continue;
      if (k === 'vote_average') {
        const num = Number(raw);
        if (!isFinite(num)) throw { message: 'vote_average must be a number.' };
        fields[k] = num;
        continue;
      }
      const s = String(raw).trim();
      if (s.length > 2000) throw { message: k + ' must be at most 2000 characters.' };
      fields[k] = s;
    }
    if (!Object.keys(fields).length) throw { message: 'Fill at least one override field.' };
    return { media, tmdb_id: id, fields };
  }

  // Stable subset comparison for save → read-back verification: the write
  // echo and a fresh GET must describe the same stored row (same endpoint,
  // same D1 overrides row). Key order ignored.
  function stableOverrideJson(row) {
    try {
      const r = (row && typeof row === 'object') ? row : {};
      const fields = {};
      for (const k of OVERRIDE_FIELDS) {
        if (r[k] !== undefined) fields[k] = r[k];
      }
      return JSON.stringify({ media: r.media || null, tmdb_id: r.tmdb_id != null ? r.tmdb_id : null, fields });
    } catch { return null; }
  }

  function filteredOverrides() {
    const list = Array.isArray(ovCache) ? ovCache : [];
    const q = String(($('ov-search') && $('ov-search').value) || '').trim().toLowerCase();
    // Two real filters on actual row data: media identity + Pick state.
    // (The old single combined select is gone — see admin.html.)
    const m = ($('ov-media') && $('ov-media').value) || 'all';
    const p = ($('ov-pick') && $('ov-pick').value) || 'all';
    return list.filter((o) => {
      if ((m === 'movie' || m === 'tv') && o.media !== m) return false;
      if (p === 'picks' && !isGreyboxPick(o)) return false;
      if (p === 'not' && isGreyboxPick(o)) return false;
      if (!q) return true;
      const keys = Object.keys(o).filter((k) => k !== 'media' && k !== 'tmdb_id');
      const hay = (o.media + ':' + o.tmdb_id + ' ' + (o.title || '') + ' ' + (o.name || '') + ' ' + keys.join(' ') + ' ' + keys.map((k) => String(o[k])).join(' ')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  // Poster thumb for a workspace card: the override's own poster/backdrop
  // path renders with zero fetches; rows without override artwork get a
  // neutral identity tile (no per-row TMDB requests, ever).
  function ovCardThumb(o) {
    const path = (o && typeof o.poster_path === 'string' && o.poster_path)
      ? o.poster_path
      : ((o && typeof o.backdrop_path === 'string' && o.backdrop_path) ? o.backdrop_path : '');
    const url = tmdbPosterUrl(path);
    if (url) {
      const img = document.createElement('img');
      img.className = 'ov-thumb';
      img.loading = 'lazy';
      img.alt = '';
      img.src = url;
      img.onerror = function () { try { img.style.display = 'none'; } catch (e) { /* noop */ } };
      return img;
    }
    const tile = el('div', 'ov-thumb ov-thumb-empty', (o && o.media === 'tv' ? 'TV' : 'MV'));
    tile.setAttribute('aria-hidden', 'true');
    return tile;
  }

  async function loadOverrides() {
    const host = $('ov-list');
    if (!host) return;
    stateBox(host, 'loading', 'Loading overrides…');
    try {
      const list = await api(API.overrides);
      ovCache = Array.isArray(list) ? list : [];
      renderOverrides();
    } catch (e) {
      host.innerHTML = '';
      notice('err', 'Overrides failed to load: ' + (e.message || e));
    }
  }

  function renderOverrides() {
    const host = $('ov-list');
    if (!host) return;
    const all = Array.isArray(ovCache) ? ovCache : [];
    const list = filteredOverrides();
    // Workspace count: totals plus the Pick count the Dashboard mirrors
    // (same isGreyboxPick predicate everywhere).
    const countEl = $('ov-count');
    if (countEl) {
      const picks = all.filter(isGreyboxPick).length;
      const base = all.length
        ? all.length + (all.length === 1 ? ' Override' : ' Overrides') + ' · ' + picks + ' ★ Picks'
        : '';
      countEl.textContent = !all.length ? '' : (list.length === all.length ? base : list.length + ' of ' + base);
    }
    host.innerHTML = '';
    if (!all.length) {
      const box = stateBox(host, 'empty', 'No overrides yet', 'Create the first one — search TMDB, pick a title, override only what you need. TMDB stays the fallback for everything else.');
      const b = el('button', 'btn btn-primary btn-sm', '+ New Override');
      b.type = 'button';
      b.addEventListener('click', () => openOverrideEditor(null));
      box.appendChild(b);
      return;
    }
    if (!list.length) {
      stateBox(host, 'empty', 'No matches', 'Try a different search or filter.');
      return;
    }
    for (const o of list) {
      const keys = Object.keys(o).filter((k) => k !== 'media' && k !== 'tmdb_id');
      const card = el('div', 'data-row ov-card');
      card.appendChild(ovCardThumb(o));
      const main = el('div', 'ov-card-main');
      const head = el('div', 'row-top');
      head.appendChild(el('span', 'row-title', ovDisplayLabel(o)));
      if (isGreyboxPick(o)) head.appendChild(el('span', 'badge badge-pick', '★ Greybox Pick'));
      head.appendChild(el('span', 'badge', o.media === 'tv' ? 'TV' : 'Movie'));
      main.appendChild(head);
      main.appendChild(el('p', 'row-mono muted', o.media + ':' + o.tmdb_id));
      main.appendChild(el('p', 'row-meta', keys.length ? keys.length + ' overridden: ' + keys.join(', ') : '(no fields)'));
      const marked = isGreyboxPick(o);
      main.appendChild(rowButtons([
        ['Edit', 'go', () => openOverrideEditor(o, { isNew: false })],
        [marked ? '☆ Unmark Pick' : '★ Mark Pick', '', () => togglePickFromOverrides(o), marked ? 'Remove Greybox Pick badge' : 'Mark as Greybox Pick'],
        ['Open ↗', '', () => { try { window.open(detailUrlFor(o.media, o.tmdb_id), '_blank', 'noopener'); } catch { /* noop */ } }, 'Open public page'],
        ['Delete', 'danger', () => deleteOverride(o), 'Delete override'],
      ]));
      card.appendChild(main);
      host.appendChild(card);
    }
  }

  async function togglePickFromOverrides(o) {
    try {
      await toggleGreyboxPick(o.media, o.tmdb_id, o);
      notice('ok', isGreyboxPick(o)
        ? ('Unmarked ' + o.media + ':' + o.tmdb_id + ' (other override fields kept).')
        : ('Marked ' + o.media + ':' + o.tmdb_id + ' as Greybox Pick.'));
      await loadOverrides();
      if (currentView === 'picks') loadPicks();
    } catch (e) {
      notice('err', (e && e.message) || e);
    }
  }

  async function saveOverride() {
    const form = $('ov-form');
    setFormSaving(form, true);
    try {
      const { media, tmdb_id, fields } = readOverrideForm();
      const isNew = ovIsNew || !ovEditing;
      let saved;
      if (isNew) {
        saved = await api(API.overrides, { method: 'POST', body: { media, tmdb_id, ...fields } });
      } else {
        saved = await api(API.overrides + '/' + media + '/' + tmdb_id, { method: 'PUT', body: { media, tmdb_id, ...fields } });
      }
      // Never trust the 200 alone: read the row back and compare against
      // what the server stored before showing success.
      const readBack = await api(API.overrides + '/' + media + '/' + tmdb_id);
      const want = stableOverrideJson({ media, tmdb_id, ...fields });
      if (stableOverrideJson(saved) !== stableOverrideJson(readBack) || stableOverrideJson(readBack) !== want) {
        notice('err', 'Override saved, but a fresh read-back differs — not showing success. Refresh and retry.');
      } else {
        notice('ok', isNew ? 'Override created.' : 'Override updated.');
      }
      ovEditing = null;
      ovIsNew = false;
      ovGen++;
      closeDrawer();
      await loadOverrides();
      if (currentView === 'dashboard') loadDashboard();
      if (currentView === 'picks') loadPicks();
    } catch (e) {
      notice('err', (e.message || e));
    } finally {
      setFormSaving(form, false);
    }
  }

  async function deleteOverride(o) {
    const label = ovDisplayLabel(o);
    const ok = await confirmDialog({ title: 'Delete override?', message: 'Delete override for "' + label + '" (' + o.media + ':' + o.tmdb_id + ')? The public site falls back to normal TMDB data. This cannot be undone.', okLabel: 'Delete' });
    if (!ok) return;
    try {
      await api(API.overrides + '/' + o.media + '/' + o.tmdb_id, { method: 'DELETE' });
      // Verify removal: the row must read back 404, otherwise local state
      // would lie about the public fallback.
      const gone = await readOverrideRow(o.media, o.tmdb_id);
      if (gone) {
        notice('err', 'Delete reported success, but the override still reads back — not showing success. Refresh and retry.');
      } else {
        notice('ok', 'Override deleted.');
      }
      if (ovEditing && ovEditing.media === o.media && ovEditing.id === o.tmdb_id) { ovEditing = null; ovIsNew = false; }
      await loadOverrides();
      if (currentView === 'picks') loadPicks();
      if (currentView === 'dashboard') loadDashboard();
    } catch (e) {
      notice('err', e.message || e);
    }
  }

  /* ================= BLOCKED TITLES (permanent server-side blocklist) =================
   *
   * Admin workspace over /api/admin/blocked: list (with Admin display
   * snapshots — no per-row TMDB fetches, ever), search-first blocking
   * (TMDB search → select → confirm → Block, identity locked to
   * media + TMDB ID), and guarded unblock (confirm → DELETE → read-back
   * 404 verification → re-render without reload). The public site filters
   * through js/data.js isBlockedContent(); this workspace never touches
   * public rendering and contains no SQL.
   */
  let blockedCache = []; // stored rows [{ media, tmdb_id, title, poster_path, backdrop_path, year, created_at, ... }]
  let blockedSearchGen = 0; // stale-guard generation for picker TMDB searches
  let blockedSearchType = 'all'; // picker media scope: 'all' | 'movie' | 'tv' (drives the real TMDB endpoint)
  let blockedSearchMode = 'title'; // picker input mode: 'title' (search by name) | 'id' (resolve a numeric TMDB ID)

  // Canonical identity key. Title/poster text NEVER participates: matching is
  // media + TMDB ID only, so "movie:123" and "tv:123" stay independent.
  function blockedKey(media, id) {
    const m = media === 'tv' ? 'tv' : (media === 'movie' ? 'movie' : null);
    const n = parseInt(id, 10);
    if (!m || !Number.isInteger(n) || n < 1) return '';
    return m + ':' + n;
  }

  // Is this identity currently blocked (against the last loaded list)?
  function isBlockedCached(media, id) {
    const key = blockedKey(media, id);
    if (!key) return false;
    return (Array.isArray(blockedCache) ? blockedCache : []).some((b) => blockedKey(b.media, b.tmdb_id) === key);
  }

  // Display label for a stored row: snapshot title wins, otherwise the bare
  // identity (never invent a title from elsewhere).
  function blockedDisplayLabel(b) {
    if (!b) return '';
    const t = String(b.title || '').trim();
    if (t) return t.slice(0, 200);
    return (b.media || '?') + ':' + (b.tmdb_id != null ? b.tmdb_id : '?');
  }

  function blockedDate(b) {
    const s = String((b && (b.created_at || b.updated_at)) || '').trim();
    if (!s) return '';
    return s.slice(0, 10);
  }

  function filteredBlocked() {
    const list = Array.isArray(blockedCache) ? blockedCache : [];
    const q = String(($('blocked-search') && $('blocked-search').value) || '').trim().toLowerCase();
    const m = ($('blocked-media') && $('blocked-media').value) || 'all';
    return list.filter((b) => {
      if ((m === 'movie' || m === 'tv') && b.media !== m) return false;
      if (!q) return true;
      const hay = (b.media + ':' + b.tmdb_id + ' ' + (b.title || '') + ' ' + (b.year || '')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  // Poster thumb for a workspace card: the STORED snapshot artwork renders
  // with zero fetches; rows without snapshot artwork get a neutral identity
  // tile (no per-row TMDB requests, ever).
  function blockedCardThumb(b) {
    const path = (b && typeof b.poster_path === 'string' && b.poster_path)
      ? b.poster_path
      : ((b && typeof b.backdrop_path === 'string' && b.backdrop_path) ? b.backdrop_path : '');
    const url = tmdbPosterUrl(path);
    if (url) {
      const img = document.createElement('img');
      img.className = 'blocked-thumb';
      img.loading = 'lazy';
      img.alt = '';
      img.src = url;
      img.onerror = function () { try { img.style.display = 'none'; } catch (e) { /* noop */ } };
      return img;
    }
    const tile = el('div', 'blocked-thumb blocked-thumb-empty', (b && b.media === 'tv' ? 'TV' : 'MV'));
    tile.setAttribute('aria-hidden', 'true');
    return tile;
  }

  // Single blocked row by identity: the stored row, or null on 404.
  // Anything else (network, 401/403) throws — a failed read is never shown
  // as "not blocked".
  async function readBlockedRow(media, id) {
    try {
      return await api(API.blocked + '/' + media + '/' + id);
    } catch (e) {
      if (e && e.status === 404) return null;
      throw e;
    }
  }

  async function loadBlocked() {
    const host = $('blocked-list');
    if (!host) return;
    stateBox(host, 'loading', 'Loading blocked titles…');
    try {
      const list = await api(API.blocked);
      blockedCache = Array.isArray(list) ? list : [];
      renderBlocked();
    } catch (e) {
      host.innerHTML = '';
      const box = stateBox(host, 'error', 'Blocked titles failed to load', (e && e.message) || String(e));
      const retry = el('button', 'btn btn-secondary btn-sm', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', loadBlocked);
      box.appendChild(retry);
      notice('err', 'Blocked titles failed to load: ' + ((e && e.message) || e));
    }
  }

  function renderBlocked() {
    const host = $('blocked-list');
    if (!host) return;
    const all = Array.isArray(blockedCache) ? blockedCache : [];
    const list = filteredBlocked();
    const countEl = $('blocked-count');
    if (countEl) {
      countEl.textContent = !all.length ? '' : (list.length === all.length
        ? (all.length + (all.length === 1 ? ' Blocked Title' : ' Blocked Titles'))
        : (list.length + ' of ' + all.length + ' blocked'));
    }
    host.innerHTML = '';
    if (!all.length) {
      const box = stateBox(host, 'empty', 'No titles are currently blocked',
        'Blocked movies and TV shows will appear here once excluded from Greybox. Blocking is permanent until unblocked — discovery, search and detail pages all refuse blocked titles.');
      const b = el('button', 'btn btn-primary btn-sm', '+ Block Title');
      b.type = 'button';
      b.addEventListener('click', openBlockPicker);
      box.appendChild(b);
      return;
    }
    if (!list.length) {
      stateBox(host, 'empty', 'No matches', 'Try a different search or filter.');
      return;
    }
    for (const b of list) {
      const card = el('div', 'data-row blocked-card');
      card.appendChild(blockedCardThumb(b));
      const main = el('div', 'blocked-card-main');
      const head = el('div', 'row-top');
      head.appendChild(el('span', 'row-title', blockedDisplayLabel(b)));
      head.appendChild(el('span', 'badge badge-blocked', 'Blocked'));
      head.appendChild(el('span', 'badge', b.media === 'tv' ? 'TV' : 'Movie'));
      main.appendChild(head);
      const metaBits = [b.media + ':' + b.tmdb_id];
      if (b.year) metaBits.push(String(b.year));
      if (blockedDate(b)) metaBits.push('blocked ' + blockedDate(b));
      main.appendChild(el('p', 'row-mono muted', metaBits.join(' · ')));
      main.appendChild(rowButtons([
        ['Unblock', 'danger', () => unblockTitle(b), 'Remove this title from the blocklist'],
      ]));
      card.appendChild(main);
      host.appendChild(card);
    }
  }

  async function unblockTitle(b) {
    const label = blockedDisplayLabel(b);
    const ok = await confirmDialog({
      title: 'Unblock title?',
      message: 'Unblock "' + label + '" (' + b.media + ':' + b.tmdb_id + ')? It can return to Greybox discovery, search and detail pages. This cannot be undone.',
      okLabel: 'Unblock',
    });
    if (!ok) return;
    try {
      await api(API.blocked + '/' + b.media + '/' + b.tmdb_id, { method: 'DELETE' });
      // Verify removal: the row must read back 404, otherwise local state
      // would lie about public discovery.
      const gone = await readBlockedRow(b.media, b.tmdb_id);
      if (gone) {
        notice('err', 'Unblock reported success, but the title still reads back as blocked — not showing success. Refresh and retry.');
      } else {
        notice('ok', 'Unblocked ' + b.media + ':' + b.tmdb_id + '.');
      }
      await loadBlocked();
      if (currentView === 'dashboard') loadDashboard();
    } catch (e) {
      notice('err', (e && e.message) || e);
    }
  }

  // + Block Title → TMDB search picker (drawer). Identity comes from the
  // verified result (media + TMDB ID): Title mode searches by name, TMDB ID
  // mode resolves the numeric ID against the real detail endpoints. The
  // media-type selector scopes the actual TMDB request (Movies →
  // /search/movie or /movie/{id}, TV Shows → /search/tv or /tv/{id},
  // All → multi search or both ID endpoints).
  // Already-blocked results show BLOCKED + Unblock instead of a duplicate
  // Block action (the server also enforces uniqueness with 409).
  function openBlockPicker() {
    blockedSearchGen++; // invalidate any picker flight from a previous open
    const wrap = el('div', '');
    wrap.style.cssText = 'display:grid;gap:.8rem';
    wrap.appendChild(el('p', 'muted text-sm', 'Search TMDB through the existing server-side proxy (no key in the browser). Movies + TV only. Select a result to review it before blocking.'));

    const typeBtns = {};
    const modeBtns = {};
    let q = null;
    let hint = null;

    const paintSeg = (btns, active) => {
      Object.keys(btns).forEach((k) => {
        const on = k === active;
        btns[k].classList.toggle('btn-primary', on);
        btns[k].classList.toggle('btn-secondary', !on);
        btns[k].setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    };

    function syncBlockedHint() {
      if (!q || !hint) return;
      if (blockedSearchMode === 'id') {
        q.type = 'text';
        q.placeholder = blockedSearchType === 'tv' ? 'e.g. 1399' : (blockedSearchType === 'movie' ? 'e.g. 550' : 'e.g. 550 or 1399');
        hint.textContent = blockedSearchType === 'all'
          ? 'ID mode: the number is verified against both /movie/{id} and /tv/{id} — pick the right result.'
          : (blockedSearchType === 'movie'
            ? 'ID mode: the number is verified as /movie/{id}.'
            : 'ID mode: the number is verified as /tv/{id}.');
      } else {
        q.type = 'search';
        q.placeholder = blockedSearchType === 'tv' ? 'Breaking Bad' : 'Fight Club';
        hint.textContent = blockedSearchType === 'all'
          ? 'Title mode: multi search across movies and TV.'
          : (blockedSearchType === 'movie' ? 'Title mode: movies only (/search/movie).' : 'Title mode: TV shows only (/search/tv).');
      }
    }

    // Media-type selector: [ All ] [ Movies ] [ TV Shows ].
    const typeRow = el('div', 'seg-row');
    typeRow.setAttribute('role', 'group');
    typeRow.setAttribute('aria-label', 'Media type');
    typeRow.appendChild(el('span', 'seg-label', 'Type:'));
    [['all', 'All'], ['movie', 'Movies'], ['tv', 'TV Shows']].forEach((opt) => {
      const val = opt[0];
      const b = el('button', 'btn btn-sm ' + (blockedSearchType === val ? 'btn-primary' : 'btn-secondary'), opt[1]);
      b.type = 'button';
      b.setAttribute('aria-pressed', blockedSearchType === val ? 'true' : 'false');
      b.addEventListener('click', () => { blockedSearchType = val; paintSeg(typeBtns, val); syncBlockedHint(); });
      typeBtns[val] = b;
      typeRow.appendChild(b);
    });
    wrap.appendChild(typeRow);

    // Search-mode selector: [ Title ] [ TMDB ID ]. A numeric ID is only
    // ever resolved as an ID when ID mode is active — never as a title
    // search (a bare "95897" matches no titles via /search/multi).
    const modeRow = el('div', 'seg-row');
    modeRow.setAttribute('role', 'group');
    modeRow.setAttribute('aria-label', 'Search mode');
    modeRow.appendChild(el('span', 'seg-label', 'Search by:'));
    [['title', 'Title'], ['id', 'TMDB ID']].forEach((opt) => {
      const val = opt[0];
      const b = el('button', 'btn btn-sm ' + (blockedSearchMode === val ? 'btn-primary' : 'btn-secondary'), opt[1]);
      b.type = 'button';
      b.setAttribute('aria-pressed', blockedSearchMode === val ? 'true' : 'false');
      b.addEventListener('click', () => { blockedSearchMode = val; paintSeg(modeBtns, val); syncBlockedHint(); });
      modeBtns[val] = b;
      modeRow.appendChild(b);
    });
    wrap.appendChild(modeRow);

    const qRow = el('div', '');
    qRow.style.cssText = 'display:flex;gap:.5rem';
    q = document.createElement('input');
    q.id = 'blocked-tmdb-q';
    q.type = blockedSearchMode === 'id' ? 'text' : 'search';
    q.placeholder = 'Fight Club';
    q.className = 'input';
    q.autocomplete = 'off';
    q.setAttribute('aria-label', blockedSearchMode === 'id' ? 'TMDB ID' : 'Title to search');
    qRow.appendChild(q);
    const go = el('button', 'btn btn-primary btn-sm', 'Search');
    go.type = 'button';
    go.addEventListener('click', runBlockedSearch);
    qRow.appendChild(go);
    wrap.appendChild(qRow);
    hint = el('p', 'muted text-sm', '');
    hint.id = 'blocked-tmdb-hint';
    wrap.appendChild(hint);
    syncBlockedHint();
    const host = el('div', '');
    host.id = 'blocked-tmdb-results';
    host.style.cssText = 'display:grid;gap:.5rem';
    host.appendChild(el('p', 'muted text-sm', blockedSearchMode === 'id'
      ? 'Enter a numeric TMDB ID above, then Search.'
      : 'Type a movie or TV title above, then Search.'));
    wrap.appendChild(host);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runBlockedSearch(); } });
    openDrawer({
      kicker: 'Blocked Titles',
      title: 'Block a title',
      sub: 'Search TMDB, pick a title, confirm — identity locks to media:TMDB ID.',
      node: wrap,
    });
    try { q.focus(); } catch { /* noop */ }
  }

  async function runBlockedSearch() {
    const host = $('blocked-tmdb-results');
    const qEl = $('blocked-tmdb-q');
    const raw = qEl ? String(qEl.value || '').trim() : '';
    const mode = blockedSearchMode === 'id' ? 'id' : 'title';
    const scope = blockedSearchType === 'tv' ? 'tv' : (blockedSearchType === 'movie' ? 'movie' : 'all');
    if (!raw) {
      if (host) {
        host.innerHTML = '';
        stateBox(host, 'empty', mode === 'id' ? 'Enter a TMDB ID' : 'Type a title first',
          mode === 'id' ? 'ID mode needs a numeric TMDB ID (e.g. 550).' : 'Type a movie or TV title above, then Search.');
      }
      return;
    }
    let nid = 0;
    if (mode === 'id') {
      if (!/^\d+$/.test(raw)) {
        if (host) {
          host.innerHTML = '';
          stateBox(host, 'empty', 'Not a numeric ID', '"' + raw.slice(0, 32) + '" is not a numeric TMDB ID. Switch to Title to search by name.');
        }
        return;
      }
      nid = parseInt(raw, 10);
      if (!Number.isInteger(nid) || nid < 1 || nid > 2147483647) {
        if (host) {
          host.innerHTML = '';
          stateBox(host, 'empty', 'Invalid TMDB ID', 'Enter a positive TMDB ID.');
        }
        return;
      }
    } else if (raw.length > 120) {
      if (host) host.innerHTML = '<p class="muted text-sm">Query must be at most 120 characters.</p>';
      return;
    }
    const myGen = ++blockedSearchGen;
    if (host) {
      host.innerHTML = '';
      stateBox(host, 'loading', mode === 'id' ? 'Resolving TMDB ID…' : 'Searching TMDB…');
    }
    try {
      // The blocked list is re-read with every search so Blocked/Unblock
      // status is current even if another tab changed it.
      const blockedP = api(API.blocked);
      let results;
      if (mode === 'id') {
        const idLabel = (scope === 'all' ? 'TMDB ID ' : scope + ':') + nid;
        const [foundRes, blockedRes] = await Promise.allSettled([resolveBlockedId(nid, scope), blockedP]);
        if (myGen !== blockedSearchGen) return; // stale: a newer query owns the list
        if (!isDrawerOpen()) return;
        if (blockedRes.status === 'fulfilled' && Array.isArray(blockedRes.value)) blockedCache = blockedRes.value;
        if (foundRes.status === 'rejected') {
          const ferr = foundRes.reason;
          if (ferr && ferr.status === 404) {
            if (myGen !== blockedSearchGen || !isDrawerOpen()) return;
            renderBlockedSearchResults(host, [], idLabel);
            return;
          }
          throw ferr;
        }
        results = foundRes.value || [];
        if (myGen !== blockedSearchGen || !isDrawerOpen()) return;
        renderBlockedSearchResults(host, results, idLabel);
      } else {
        const [tmdbRes, blockedRes] = await Promise.allSettled([
          tmdbSearchFetch(raw, scope === 'all' ? null : scope),
          blockedP,
        ]);
        if (myGen !== blockedSearchGen) return; // stale: a newer query owns the list
        if (!isDrawerOpen()) return;
        if (tmdbRes.status === 'rejected') throw tmdbRes.reason;
        if (blockedRes.status === 'fulfilled' && Array.isArray(blockedRes.value)) blockedCache = blockedRes.value;
        results = normalizeTmdbSearchResults(tmdbRes.value, scope === 'all' ? null : scope);
        if (myGen !== blockedSearchGen || !isDrawerOpen()) return;
        renderBlockedSearchResults(host, results, raw);
      }
    } catch (e) {
      if (myGen !== blockedSearchGen || !isDrawerOpen()) return;
      if (host) {
        host.innerHTML = '';
        stateBox(host, 'error', mode === 'id' ? 'Lookup failed' : 'Search failed', (e && e.message) || String(e));
      }
      notice('err', (mode === 'id' ? 'TMDB lookup failed: ' : 'TMDB search failed: ') + ((e && e.message) || e));
    }
  }

  function renderBlockedSearchResults(host, results, query) {
    if (!host) return;
    host.innerHTML = '';
    if (!results.length) {
      stateBox(host, 'empty', 'No matches', 'No matches for "' + query + '". Try another spelling.');
      return;
    }
    results.forEach((r) => {
      const card = el('div', 'data-row blocked-pick-row');
      const row = el('div', '');
      row.style.cssText = 'display:flex;gap:.75rem';
      const img = document.createElement('img');
      img.className = 'search-thumb';
      img.loading = 'lazy';
      img.alt = '';
      img.src = tmdbPosterUrl(r.poster) || 'https://via.placeholder.com/48x72?text=?';
      row.appendChild(img);
      const body = el('div', '');
      body.style.cssText = 'min-width:0;flex:1';
      const head = el('div', 'row-top');
      head.appendChild(el('span', 'row-title', r.title));
      head.appendChild(el('span', 'badge', r.media === 'tv' ? 'TV' : 'Movie'));
      const already = isBlockedCached(r.media, r.id);
      if (already) head.appendChild(el('span', 'badge badge-blocked', 'Blocked'));
      body.appendChild(head);
      const metaBits = [(r.year || '—'), 'TMDB ' + r.media + ':' + r.id];
      body.appendChild(el('p', 'row-meta', metaBits.join(' · ')));
      if (r.overview) body.appendChild(el('p', 'row-meta', r.overview));
      row.appendChild(body);
      card.appendChild(row);
      if (already) {
        card.appendChild(rowButtons([
          ['Unblock', 'danger', () => unblockTitle({ media: r.media, tmdb_id: r.id, title: r.title }), 'Remove this title from the blocklist'],
        ]));
      } else {
        card.appendChild(rowButtons([
          ['Block…', 'go', () => openBlockConfirm(r), 'Review and block this title'],
        ]));
      }
      host.appendChild(card);
    });
    // The workspace list behind the drawer stays in sync with the fresh read.
    if (currentView === 'blocked') renderBlocked();
  }

  // Block confirmation: poster, title, year, media, TMDB ID — then an
  // explicit Block Title action (never a one-click block from search).
  function openBlockConfirm(r) {
    const wrap = el('div', '');
    wrap.style.cssText = 'display:grid;gap:.8rem';
    const top = el('div', 'blocked-confirm');
    const img = document.createElement('img');
    img.className = 'blocked-confirm-art';
    img.alt = '';
    img.src = tmdbPosterUrl(r.poster) || 'https://via.placeholder.com/96x144?text=?';
    top.appendChild(img);
    const body = el('div', '');
    body.style.cssText = 'min-width:0;display:grid;gap:.3rem;align-content:start';
    const head = el('div', 'row-top');
    head.appendChild(el('span', 'row-title', r.title));
    head.appendChild(el('span', 'badge', r.media === 'tv' ? 'TV' : 'Movie'));
    body.appendChild(head);
    body.appendChild(el('p', 'row-mono muted', r.media + ':' + r.id + (r.year ? ' · ' + r.year : '')));
    if (r.overview) body.appendChild(el('p', 'row-meta', r.overview));
    top.appendChild(body);
    wrap.appendChild(top);
    wrap.appendChild(el('p', 'muted text-sm', 'This title will be permanently excluded from Greybox discovery, search and detail pages until unblocked. Identity locks to ' + r.media + ':' + r.id + ' — title text is display only.'));
    const row = el('div', '');
    row.style.cssText = 'display:flex;gap:.5rem;flex-wrap:wrap';
    const back = el('button', 'btn btn-ghost btn-sm', '← Back to results');
    back.type = 'button';
    back.addEventListener('click', openBlockPicker);
    const cancel = el('button', 'btn btn-secondary btn-sm', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', closeDrawer);
    const block = el('button', 'btn btn-primary btn-sm', 'Block Title');
    block.type = 'button';
    block.addEventListener('click', () => confirmBlockTitle(r, block));
    row.appendChild(block);
    row.appendChild(cancel);
    row.appendChild(back);
    wrap.appendChild(row);
    openDrawer({
      kicker: 'Blocked Titles',
      title: 'Block "' + String(r.title || '').slice(0, 60) + '"?',
      sub: r.media + ':' + r.id + ' — review, then confirm.',
      node: wrap,
    });
  }

  async function confirmBlockTitle(r, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Blocking…'; }
    try {
      const payload = {
        media: r.media,
        tmdb_id: r.id,
        title: String(r.title || '').slice(0, 200),
        poster_path: (typeof r.poster === 'string' && r.poster) ? r.poster : null,
        backdrop_path: null,
        year: String(r.year || '').slice(0, 4),
      };
      await api(API.blocked, { method: 'POST', body: payload });
      // Never trust the 201 alone: read the row back before showing success.
      const readBack = await readBlockedRow(r.media, r.id);
      if (!readBack || blockedKey(readBack.media, readBack.tmdb_id) !== blockedKey(r.media, r.id)) {
        notice('err', 'Block reported success, but a fresh read-back differs — not showing success. Refresh and retry.');
      } else {
        notice('ok', 'Blocked ' + r.media + ':' + r.id + ' ("' + String(r.title || '').slice(0, 80) + '").');
      }
      blockedSearchGen++;
      closeDrawer();
      await loadBlocked();
      if (currentView === 'dashboard') loadDashboard();
    } catch (e) {
      if (e && e.status === 409) {
        notice('err', 'That title is already blocked (' + r.media + ':' + r.id + ').');
        try { await loadBlocked(); } catch { /* keep drawer state */ }
      } else {
        notice('err', (e && e.message) || e);
      }
    } finally {
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = 'Block Title'; }
    }
  }

  /* ================= NAVIGATION (public navbar configuration) =================
   *
   * Admin workspace over /api/admin/navigation (GET read, PUT full-replace)
   * for the D1 `settings` row `navigation`. Staged editing: rows edit a
   * local draft (label inputs, visibility toggles, up/down order, search
   * flag); nothing touches the server until Save Changes, which PUTs the
   * complete six-item menu in display order and verifies with a fresh GET
   * (a 200 alone is never shown as success). Stable identity is always the
   * item key — labels are display only and routes are derived per key
   * (controlled known routes, never stored, never arbitrary URLs).
   */
  const NAV_KEYS = ['home', 'movies', 'tv', 'anime', 'collections', 'my-list'];
  const NAV_LABEL_MAX = 32;
  const NAV_DEFAULTS = {
    items: [
      { key: 'home', label: 'Home', visible: true },
      { key: 'movies', label: 'Movies', visible: true },
      { key: 'tv', label: 'TV Shows', visible: true },
      { key: 'anime', label: 'Anime', visible: true },
      { key: 'collections', label: 'Collections', visible: true },
      { key: 'my-list', label: 'My List', visible: true },
    ],
    searchVisible: true,
  };
  const NAV_ROUTE_LABEL = {
    home: '/',
    movies: '/movies',
    tv: '/tv',
    anime: '/anime',
    collections: 'Collections menu',
    'my-list': '/mylist',
  };

  let navServer = null; // last saved config from GET (null until loaded)
  let navDraft = null; // staged edits { items, searchVisible }
  let navGen = 0; // stale-guard generation for loads/saves
  let navSaving = false;

  function navDefaults() {
    return JSON.parse(JSON.stringify(NAV_DEFAULTS));
  }

  function navClone(v) {
    try { return JSON.parse(JSON.stringify(v)); }
    catch { return navDefaults(); }
  }

  function navRouteLabel(key) {
    return NAV_ROUTE_LABEL[key] || '—';
  }

  // Client-side first pass (mirrors validateNavigationBody server-side; the
  // server re-validates everything — a failed save is never shown as ok).
  // Returns an error string, or null when the draft is saveable.
  function navValidateDraft(draft) {
    if (!draft || typeof draft !== 'object') return 'Navigation data is missing.';
    if (!Array.isArray(draft.items) || draft.items.length !== NAV_KEYS.length) {
      return 'Navigation must contain exactly six items.';
    }
    const seen = new Set();
    for (const it of draft.items) {
      if (!it || typeof it !== 'object') return 'Each navigation item must define key, label and visibility.';
      const key = String(it.key == null ? '' : it.key).trim().toLowerCase();
      if (NAV_KEYS.indexOf(key) < 0) return 'Unknown navigation key: ' + String(it.key == null ? '?' : it.key).slice(0, 32);
      if (seen.has(key)) return 'Duplicate navigation item: ' + key;
      seen.add(key);
      const label = typeof it.label === 'string' ? it.label.trim() : '';
      if (!label) return 'Label must not be empty (' + key + ').';
      if (label.length > NAV_LABEL_MAX) return 'Label must be at most ' + NAV_LABEL_MAX + ' characters (' + key + ').';
    }
    for (const k of NAV_KEYS) {
      if (!seen.has(k)) return 'Missing navigation item: ' + k + ' (hide with Hide, never by removal).';
    }
    return null;
  }

  function navStableJson(v) {
    const d = (v && typeof v === 'object') ? v : { items: [], searchVisible: true };
    return JSON.stringify({
      items: (Array.isArray(d.items) ? d.items : []).map((it) => ({
        key: it.key,
        label: String(it.label == null ? '' : it.label).trim(),
        visible: it.visible !== false,
      })),
      searchVisible: d.searchVisible !== false,
    });
  }

  function navIsDirty() {
    if (!navServer || !navDraft) return false;
    return navStableJson(navDraft) !== navStableJson(navServer);
  }

  // Lenient shaping for GET responses (mirrors the server sanitizer):
  // recognized keys keep server order, missing keys append in canonical
  // order, invalid labels fall back to defaults. Never throws.
  function normalizeNavServer(cfg) {
    const out = navDefaults();
    try {
      const list = cfg && Array.isArray(cfg.items) ? cfg.items : [];
      const byKey = {};
      list.forEach((it) => {
        if (!it || typeof it !== 'object') return;
        const k = String(it.key == null ? '' : it.key).trim().toLowerCase();
        if (NAV_KEYS.indexOf(k) < 0 || byKey[k]) return;
        byKey[k] = it;
      });
      const order = [];
      list.forEach((it) => {
        if (!it || typeof it !== 'object') return;
        const k = String(it.key == null ? '' : it.key).trim().toLowerCase();
        if (NAV_KEYS.indexOf(k) >= 0 && order.indexOf(k) < 0) order.push(k);
      });
      NAV_KEYS.forEach((k) => { if (order.indexOf(k) < 0) order.push(k); });
      out.items = order.map((k) => {
        const src = byKey[k];
        let label = NAV_DEFAULTS.items[NAV_KEYS.indexOf(k)].label;
        if (src && typeof src.label === 'string' && src.label.trim() && src.label.trim().length <= NAV_LABEL_MAX) {
          label = src.label.trim();
        }
        return { key: k, label, visible: src ? src.visible !== false : true };
      });
      if (cfg && typeof cfg.searchVisible === 'boolean') out.searchVisible = cfg.searchVisible;
    } catch { /* defaults stand */ }
    return out;
  }

  async function loadNavigation() {
    const host = $('nav-list');
    if (!host) return;
    const myGen = ++navGen;
    stateBox(host, 'loading', 'Loading navigation…');
    const sp = $('nav-search-panel');
    if (sp) sp.innerHTML = '';
    const pv = $('nav-preview');
    if (pv) pv.innerHTML = '';
    navServer = null;
    navDraft = null;
    updateNavChrome();
    try {
      const cfg = await api(API.navigation);
      if (myGen !== navGen) return; // stale: a newer load owns the view
      navServer = normalizeNavServer(cfg);
      navDraft = navClone(navServer);
      if (myGen !== navGen) return;
      renderNavigation();
    } catch (e) {
      if (myGen !== navGen) return;
      host.innerHTML = '';
      const box = stateBox(host, 'error', 'Navigation failed to load', (e && e.message) || String(e));
      const retry = el('button', 'btn btn-secondary btn-sm', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', loadNavigation);
      box.appendChild(retry);
      notice('err', 'Navigation failed to load: ' + ((e && e.message) || e));
    }
  }

  function navMove(idx, dir) {
    if (!navDraft || navSaving) return;
    const j = idx + dir;
    if (idx < 0 || j < 0 || idx >= navDraft.items.length || j >= navDraft.items.length) return;
    const tmp = navDraft.items[idx];
    navDraft.items[idx] = navDraft.items[j];
    navDraft.items[j] = tmp;
    renderNavigation();
  }

  function navToggle(idx) {
    if (!navDraft || navSaving) return;
    const it = navDraft.items[idx];
    if (!it) return;
    it.visible = it.visible === false ? true : false;
    renderNavigation();
  }

  function navRow(it, idx) {
    const card = el('div', 'data-row nav-row');
    const grip = el('span', 'nav-grip', '⋮⋮');
    grip.setAttribute('aria-hidden', 'true');
    grip.title = 'Display position ' + (idx + 1) + ' of ' + navDraft.items.length;
    card.appendChild(grip);
    const main = el('div', 'nav-row-main');
    const head = el('div', 'row-top');
    head.appendChild(el('span', 'row-mono nav-key', it.key));
    const route = el('span', 'badge', navRouteLabel(it.key));
    route.title = it.key === 'collections'
      ? 'Opens the existing collections dropdown menu (no single URL)'
      : 'Public route: ' + navRouteLabel(it.key);
    head.appendChild(route);
    head.appendChild(statusBadge(it));
    main.appendChild(head);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input nav-label-input';
    input.value = typeof it.label === 'string' ? it.label : '';
    input.maxLength = NAV_LABEL_MAX;
    input.setAttribute('aria-label', 'Label for ' + it.key);
    input.autocomplete = 'off';
    input.addEventListener('input', () => {
      it.label = input.value;
      const bad = !String(input.value || '').trim() || String(input.value || '').trim().length > NAV_LABEL_MAX;
      input.classList.toggle('is-invalid', bad);
      renderNavPreview();
      updateNavChrome();
    });
    main.appendChild(fieldRow('Label (display only — key stays "' + it.key + '")', input));
    card.appendChild(main);
    const side = el('div', 'nav-row-side');
    side.appendChild(rowButtons([
      ['↑', '', () => navMove(idx, -1), 'Move up', idx === 0 || navSaving],
      ['↓', '', () => navMove(idx, 1), 'Move down', idx === navDraft.items.length - 1 || navSaving],
      [it.visible === false ? 'Show' : 'Hide', it.visible === false ? 'go' : '', () => navToggle(idx), it.visible === false ? 'Show in the public navbar' : 'Hide from the public navbar'],
    ]));
    card.appendChild(side);
    return card;
  }

  function renderNavSearch() {
    const host = $('nav-search-panel');
    if (!host || !navDraft) return;
    host.innerHTML = '';
    const on = navDraft.searchVisible !== false;
    const card = el('div', 'data-row nav-search-row');
    const main = el('div', 'nav-row-main');
    const head = el('div', 'row-top');
    head.appendChild(el('span', 'row-title', 'Header search box'));
    head.appendChild(el('span', 'badge ' + (on ? 'badge-live' : 'badge-hidden'), on ? 'Visible' : 'Hidden'));
    main.appendChild(head);
    main.appendChild(el('p', 'row-meta', 'The search box in the public header (suggestions + /search page). Search itself is unchanged — this only controls whether the box is shown.'));
    card.appendChild(main);
    const side = el('div', 'nav-row-side');
    side.appendChild(rowButtons([
      [on ? 'Hide search' : 'Show search', on ? '' : 'go', () => { navDraft.searchVisible = !on; renderNavigation(); }, on ? 'Hide the header search box' : 'Show the header search box'],
    ]));
    card.appendChild(side);
    host.appendChild(card);
  }

  function renderNavPreview() {
    const host = $('nav-preview');
    if (!host || !navDraft) return;
    host.innerHTML = '';
    const bar = el('div', 'nav-preview-bar');
    bar.appendChild(el('span', 'nav-preview-logo', 'Greybox'));
    const shown = navDraft.items.filter((it) => it && it.visible !== false);
    shown.forEach((it) => {
      const label = (typeof it.label === 'string' && it.label.trim()) ? it.label.trim() : it.key;
      bar.appendChild(el('span', 'nav-preview-item', label));
    });
    if (navDraft.searchVisible !== false) bar.appendChild(el('span', 'nav-preview-search', 'Search'));
    if (!shown.length) bar.appendChild(el('span', 'muted text-sm', 'All items hidden — the navbar would show only the logo.'));
    host.appendChild(bar);
  }

  function renderNavigation() {
    const host = $('nav-list');
    if (!host || !navDraft) return;
    host.innerHTML = '';
    navDraft.items.forEach((it, idx) => {
      host.appendChild(navRow(it, idx));
    });
    renderNavSearch();
    renderNavPreview();
    updateNavChrome();
  }

  function updateNavChrome() {
    const dirty = navIsDirty();
    const badge = $('nav-dirty');
    if (badge) badge.classList.toggle('hidden', !dirty);
    const save = $('nav-save');
    if (save) save.disabled = !dirty || navSaving || !navDraft;
    const discard = $('nav-discard');
    if (discard) discard.disabled = !dirty || navSaving || !navDraft;
    const reset = $('nav-reset');
    if (reset) reset.disabled = navSaving || !navDraft;
  }

  async function saveNavigation() {
    if (navSaving || !navDraft) return;
    const err = navValidateDraft(navDraft);
    if (err) {
      notice('err', err);
      renderNavigation();
      return;
    }
    const myGen = ++navGen;
    navSaving = true;
    updateNavChrome();
    const saveBtn = $('nav-save');
    const prevLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn) { saveBtn.textContent = 'Saving…'; saveBtn.disabled = true; }
    try {
      const payload = {
        items: navDraft.items.map((it) => ({ key: it.key, label: String(it.label == null ? '' : it.label).trim(), visible: it.visible !== false })),
        searchVisible: navDraft.searchVisible !== false,
      };
      await api(API.navigation, { method: 'PUT', body: payload });
      // Never trust the 200 alone: read the row back before showing success.
      const readBack = await api(API.navigation);
      if (myGen !== navGen) return; // stale: a newer load/save owns the view
      const shaped = normalizeNavServer(readBack);
      if (navStableJson(shaped) !== navStableJson(payload)) {
        notice('err', 'Save reported success, but a fresh read-back differs — not showing success. Refresh and retry.');
      } else {
        notice('ok', 'Navigation saved. The public navbar updates within ~a minute.');
      }
      navServer = shaped;
      navDraft = navClone(shaped);
      renderNavigation();
    } catch (e) {
      if (myGen !== navGen) return;
      notice('err', 'Navigation save failed: ' + ((e && e.message) || e));
    } finally {
      navSaving = false;
      if (myGen === navGen) {
        if (saveBtn && saveBtn.isConnected) saveBtn.textContent = prevLabel || 'Save Changes';
        updateNavChrome();
      }
    }
  }

  function discardNavigation() {
    if (!navServer || navSaving) return;
    if (!navIsDirty()) return;
    navDraft = navClone(navServer);
    renderNavigation();
    notice('ok', 'Unsaved navigation changes discarded.');
  }

  function resetNavigation() {
    if (!navDraft || navSaving) return;
    navDraft = navDefaults();
    renderNavigation();
  }

  /* ================= DETAIL PAGES (movie/TV detail presentation) =================
   *
   * Admin workspace over /api/admin/settings/detail-pages (GET read, PUT
   * full-replace) for the D1 `settings` row `detail_pages`. Staged editing
   * like Navigation: grouped Show/Hide toggles edit a local draft; nothing
   * touches the server until Save Changes, which PUTs the complete grouped
   * object and verifies with a fresh GET (a 200 alone is never shown as
   * success). Identity is always the group.key path — every flag is a
   * plain boolean, all default shown. Reset stages the defaults behind a
   * confirmation (destructive to the draft, not the server, until saved).
   *
   * No live preview: a preview would duplicate the detail renderer
   * (js/pages.js renderTitleDetail). The toggle list below is the source
   * of truth; the public modal applies it via js/detail-pages.js.
   */
  const DP_GROUPS = [
    {
      key: 'header', title: 'Header', settings: [
        { key: 'backdrop', label: 'Backdrop artwork', desc: 'Cinematic backdrop behind the title (falls back to poster art).' },
        { key: 'poster', label: 'Poster image', desc: 'Poster thumbnail beside the synopsis.' },
        { key: 'badge', label: 'Title badge', desc: 'Greybox Pick / custom badge pill plus tag badges.' },
        { key: 'title', label: 'Title', desc: 'Movie or show title heading.' },
        { key: 'meta', label: 'Metadata line', desc: 'Year · type · rating · genres line under the title.' },
        { key: 'rating', label: 'Rating in metadata', desc: 'Star-rating segment inside the metadata line.' },
        { key: 'genres', label: 'Genres in metadata', desc: 'Genre-list segment inside the metadata line.' },
        { key: 'overview', label: 'Synopsis', desc: 'Full overview text below the header.' },
      ],
    },
    {
      key: 'actions', title: 'Actions', settings: [
        { key: 'watch', label: 'Watch Now button', desc: 'Primary playback entry point (playback itself is unchanged).' },
        { key: 'trailer', label: 'Trailer button', desc: 'Inline trailer player trigger.' },
        { key: 'myList', label: 'My List button', desc: 'Save-to-list toggle (list storage is unchanged).' },
      ],
    },
    {
      key: 'content', title: 'Content', settings: [
        { key: 'providers', label: 'Where to watch', desc: 'Legal provider offers plus the JustWatch guide link.' },
        { key: 'cast', label: 'Cast', desc: 'Top-billed cast row with photos and characters.' },
      ],
    },
    {
      key: 'tv', title: 'TV / Episodes', settings: [
        { key: 'episodes', label: 'Episodes section', desc: 'Season picker plus episode list (TV only; ignored for movies).' },
        { key: 'episodeOverview', label: 'Episode overviews', desc: 'Per-episode synopsis lines.' },
        { key: 'episodeMeta', label: 'Episode details', desc: 'Runtime and air-date lines (resume state always stays).' },
      ],
    },
  ];

  let dpServer = null; // last saved config from GET (null until loaded)
  let dpDraft = null; // staged edits { header, actions, content, tv }
  let dpGen = 0; // stale-guard generation for loads/saves
  let dpSaving = false;

  function dpDefaults() {
    const o = {};
    for (const g of DP_GROUPS) {
      o[g.key] = {};
      for (const s of g.settings) o[g.key][s.key] = true;
    }
    return o;
  }

  function dpClone(v) {
    try { return JSON.parse(JSON.stringify(v)); }
    catch { return dpDefaults(); }
  }

  // Client-side first pass (mirrors validateDetailPagesBody server-side;
  // the server re-validates everything — a failed save is never shown as
  // ok). Returns an error string, or null when the draft is saveable.
  function dpValidateDraft(draft) {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return 'Detail Pages data is missing.';
    for (const g of DP_GROUPS) {
      const node = draft[g.key];
      if (!node || typeof node !== 'object' || Array.isArray(node)) return 'Detail Pages group "' + g.key + '" is missing.';
      for (const s of g.settings) {
        if (typeof node[s.key] !== 'boolean') return 'Detail Pages setting "' + g.key + '.' + s.key + '" must be on or off.';
      }
    }
    return null;
  }

  function dpStableJson(v) {
    const d = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    const out = {};
    for (const g of DP_GROUPS) {
      const node = d[g.key] && typeof d[g.key] === 'object' ? d[g.key] : {};
      out[g.key] = {};
      for (const s of g.settings) out[g.key][s.key] = node[s.key] !== false;
    }
    return JSON.stringify(out);
  }

  function dpIsDirty() {
    if (!dpServer || !dpDraft) return false;
    return dpStableJson(dpDraft) !== dpStableJson(dpServer);
  }

  // Lenient shaping for GET responses (mirrors the server sanitizer):
  // unknown groups/keys dropped, missing or non-boolean flags read as
  // shown. Never throws.
  function normalizeDpServer(cfg) {
    const out = dpDefaults();
    try {
      const src = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
      for (const g of DP_GROUPS) {
        const node = src[g.key] && typeof src[g.key] === 'object' && !Array.isArray(src[g.key]) ? src[g.key] : {};
        for (const s of g.settings) {
          out[g.key][s.key] = node[s.key] === false ? false : true;
        }
      }
    } catch { /* defaults stand */ }
    return out;
  }

  async function loadDetailPages() {
    const host = $('dp-groups');
    if (!host) return;
    const myGen = ++dpGen;
    stateBox(host, 'loading', 'Loading detail pages…');
    dpServer = null;
    dpDraft = null;
    updateDpChrome();
    try {
      const cfg = await api(API.detailPages);
      if (myGen !== dpGen) return; // stale: a newer load owns the view
      dpServer = normalizeDpServer(cfg);
      dpDraft = dpClone(dpServer);
      if (myGen !== dpGen) return;
      renderDetailPages();
    } catch (e) {
      if (myGen !== dpGen) return;
      host.innerHTML = '';
      const box = stateBox(host, 'error', 'Detail Pages failed to load', (e && e.message) || String(e));
      const retry = el('button', 'btn btn-secondary btn-sm', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', loadDetailPages);
      box.appendChild(retry);
      notice('err', 'Detail Pages failed to load: ' + ((e && e.message) || e));
    }
  }

  function dpToggle(group, key) {
    if (!dpDraft || dpSaving) return;
    if (!dpDraft[group] || typeof dpDraft[group][key] !== 'boolean') return;
    dpDraft[group][key] = !dpDraft[group][key];
    renderDetailPages();
  }

  function dpRow(group, meta, on) {
    const card = el('div', 'data-row');
    const head = el('div', 'row-top');
    head.appendChild(el('span', 'row-title', meta.label));
    head.appendChild(statusBadge({ visible: on }));
    card.appendChild(head);
    card.appendChild(el('p', 'row-meta', meta.desc));
    card.appendChild(rowButtons([
      [on ? 'Hide' : 'Show', on ? '' : 'go', () => dpToggle(group, meta.key), on ? 'Hide from detail pages' : 'Show on detail pages'],
    ]));
    return card;
  }

  function renderDetailPages() {
    const host = $('dp-groups');
    if (!host || !dpDraft) return;
    host.innerHTML = '';
    for (const g of DP_GROUPS) {
      const head = el('h2', 'section-subhead', g.title);
      if (host.children.length) head.style.marginTop = '1.1rem';
      host.appendChild(head);
      const list = el('div', 'row-list');
      for (const s of g.settings) {
        list.appendChild(dpRow(g.key, s, dpDraft[g.key] ? dpDraft[g.key][s.key] !== false : true));
      }
      host.appendChild(list);
    }
    updateDpChrome();
  }

  function updateDpChrome() {
    const dirty = dpIsDirty();
    const badge = $('dp-dirty');
    if (badge) badge.classList.toggle('hidden', !dirty);
    const save = $('dp-save');
    if (save) save.disabled = !dirty || dpSaving || !dpDraft;
    const discard = $('dp-discard');
    if (discard) discard.disabled = !dirty || dpSaving || !dpDraft;
    const reset = $('dp-reset');
    if (reset) reset.disabled = dpSaving || !dpDraft;
  }

  async function saveDetailPages() {
    if (dpSaving || !dpDraft) return;
    const err = dpValidateDraft(dpDraft);
    if (err) {
      notice('err', err);
      renderDetailPages();
      return;
    }
    const myGen = ++dpGen;
    dpSaving = true;
    updateDpChrome();
    const saveBtn = $('dp-save');
    const prevLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn) { saveBtn.textContent = 'Saving…'; saveBtn.disabled = true; }
    try {
      const payload = JSON.parse(dpStableJson(dpDraft));
      await api(API.detailPages, { method: 'PUT', body: payload });
      // Never trust the 200 alone: read the row back before showing success.
      const readBack = await api(API.detailPages);
      if (myGen !== dpGen) return; // stale: a newer load/save owns the view
      const shaped = normalizeDpServer(readBack);
      if (dpStableJson(shaped) !== dpStableJson(payload)) {
        notice('err', 'Save reported success, but a fresh read-back differs — not showing success. Refresh and retry.');
      } else {
        notice('ok', 'Detail Pages saved. Movie and TV details update within ~a minute.');
      }
      dpServer = shaped;
      dpDraft = dpClone(shaped);
      renderDetailPages();
    } catch (e) {
      if (myGen !== dpGen) return;
      notice('err', 'Detail Pages save failed: ' + ((e && e.message) || e));
    } finally {
      dpSaving = false;
      if (myGen === dpGen) {
        if (saveBtn && saveBtn.isConnected) saveBtn.textContent = prevLabel || 'Save Changes';
        updateDpChrome();
      }
    }
  }

  function discardDetailPages() {
    if (!dpServer || dpSaving) return;
    if (!dpIsDirty()) return;
    dpDraft = dpClone(dpServer);
    renderDetailPages();
    notice('ok', 'Unsaved Detail Pages changes discarded.');
  }

  async function resetDetailPages() {
    if (!dpDraft || dpSaving) return;
    const ok = await confirmDialog({
      title: 'Reset detail pages?',
      message: 'Stage the default detail page (every section shown)? Your unsaved draft edits will be lost; nothing is saved until you press Save Changes.',
      okLabel: 'Reset to defaults',
    });
    if (!ok) return;
    dpDraft = dpDefaults();
    renderDetailPages();
  }

  /* ================= PLAYBACK (catalog resolver strategy) =================
   *
   * Admin workspace over /api/admin/settings/playback (GET read, PUT
   * full-replace) for the D1 `settings` row `playback`. Staged editing like
   * Navigation/Detail Pages: the mode picker edits a local draft; nothing
   * touches the server until Save Changes, which PUTs the complete object
   * and verifies with a fresh GET (a 200 alone is never shown as success).
   * Identity is always the mode key (auto/direct/embed) — never a display
   * label. V1 exposes exactly ONE setting (mode); player behaviors that are
   * not cleanly configurable (autoplay guarantees, resume toggles, global
   * default quality, subtitle fetching) are documented, not added.
   * Direct mode fails cleanly for catalog titles because the EMBED resolver
   * supplies embed-page URLs only — there is no direct production source
   * today, and no scraping/extraction is added to manufacture one.
   */
  const PB_MODES = [
    { key: 'auto', label: 'Auto', desc: 'Uses the normal Greybox resolver strategy: catalog titles use the configured embed source; direct files use the Greybox Player.' },
    { key: 'direct', label: 'Direct', desc: 'Only succeeds when a valid direct source is available. Catalog titles fail cleanly today — no direct production source is configured.' },
    { key: 'embed', label: 'Embed', desc: 'Uses the configured embed source for catalog titles (today: the normal movie/episode path).' },
  ];

  let pbServer = null; // last saved config from GET (null until loaded)
  let pbDraft = null; // staged edits { mode }
  let pbGen = 0; // stale-guard generation for loads/saves
  let pbSaving = false;

  function pbDefaults() {
    return { mode: 'auto' };
  }

  function pbClone(v) {
    try { return JSON.parse(JSON.stringify(v)); }
    catch { return pbDefaults(); }
  }

  function pbModeOf(v) {
    try {
      const m = String(v && v.mode == null ? '' : v.mode).trim().toLowerCase();
      if (m === 'auto' || m === 'direct' || m === 'embed') return m;
    } catch { /* fall through */ }
    return 'auto';
  }

  // Client-side first pass (mirrors validatePlaybackBody server-side; the
  // server re-validates everything — a failed save is never shown as ok).
  function pbValidateDraft(draft) {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return 'Playback data is missing.';
    const keys = Object.keys(draft);
    if (keys.length !== 1 || keys[0] !== 'mode') return 'Playback must contain exactly one setting: mode.';
    if (PB_MODES.map((m) => m.key).indexOf(draft.mode) < 0) return 'Unknown playback mode: ' + String(draft.mode == null ? '?' : draft.mode).slice(0, 32) + ' (use auto, direct or embed).';
    return null;
  }

  function pbStableJson(v) {
    return JSON.stringify({ mode: pbModeOf(v) });
  }

  function pbIsDirty() {
    if (!pbServer || !pbDraft) return false;
    return pbStableJson(pbDraft) !== pbStableJson(pbServer);
  }

  // Lenient shaping for GET responses (mirrors the server sanitizer):
  // unknown/missing modes read as auto. Never throws.
  function normalizePbServer(cfg) {
    return { mode: pbModeOf(cfg) };
  }

  async function loadPlayback() {
    const host = $('pb-mode');
    if (!host) return;
    const myGen = ++pbGen;
    stateBox(host, 'loading', 'Loading playback…');
    renderPbStatus(null);
    renderPbPlayer();
    renderPbTest();
    renderPbNotes();
    pbServer = null;
    pbDraft = null;
    updatePbChrome();
    try {
      const cfg = await api(API.playback);
      if (myGen !== pbGen) return; // stale: a newer load owns the view
      pbServer = normalizePbServer(cfg);
      pbDraft = pbClone(pbServer);
      if (myGen !== pbGen) return;
      renderPlayback();
    } catch (e) {
      if (myGen !== pbGen) return;
      host.innerHTML = '';
      const box = stateBox(host, 'error', 'Playback failed to load', (e && e.message) || String(e));
      const retry = el('button', 'btn btn-secondary btn-sm', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', loadPlayback);
      box.appendChild(retry);
      renderPbStatus(null);
      renderPbPlayer();
      renderPbTest();
      renderPbNotes();
      notice('err', 'Playback failed to load: ' + ((e && e.message) || e));
    }
  }

  function pbPick(mode) {
    if (!pbDraft || pbSaving) return;
    if (PB_MODES.map((m) => m.key).indexOf(mode) < 0) return;
    pbDraft.mode = mode;
    renderPlayback();
  }

  function pbModeCard(meta) {
    const on = pbDraft && pbDraft.mode === meta.key;
    const card = el('div', 'data-row' + (on ? ' is-selected' : ''));
    const head = el('div', 'row-top');
    head.appendChild(el('span', 'row-title', meta.label));
    head.appendChild(el('span', 'badge ' + (on ? 'badge-live' : 'badge-hidden'), on ? 'Active' : meta.key));
    card.appendChild(head);
    card.appendChild(el('p', 'row-meta', meta.desc));
    card.appendChild(rowButtons([
      [on ? 'Selected' : 'Use ' + meta.label, on ? '' : 'go', () => pbPick(meta.key), on ? 'Already the staged mode' : 'Stage ' + meta.label + ' mode (nothing saves until Save Changes)', on],
    ]));
    return card;
  }

  function renderPlayback() {
    const host = $('pb-mode');
    if (!host || !pbDraft) return;
    host.innerHTML = '';
    const head = el('h2', 'section-subhead', 'Playback mode');
    host.appendChild(head);
    const list = el('div', 'row-list');
    for (const m of PB_MODES) list.appendChild(pbModeCard(m));
    host.appendChild(list);
    renderPbStatus(pbDraft);
    renderPbPlayer();
    renderPbTest();
    renderPbNotes();
    updatePbChrome();
  }

  // Source status: useful non-sensitive diagnostics only (mode, booleans,
  // hostname). Never tokens, cookies, headers, full URLs, or D1 internals.
  function renderPbStatus(draft) {
    const host = $('pb-status');
    if (!host) return;
    host.innerHTML = '';
    const card = el('div', 'data-row');
    if (!draft) {
      card.appendChild(el('p', 'row-meta', 'Source status is unavailable until playback configuration loads.'));
      host.appendChild(card);
      return;
    }
    const mode = pbModeOf(draft);
    card.appendChild(el('p', 'row-meta', 'Playback mode: ' + mode));
    // Embed status is derived client-side from the same EMBED slot the
    // resolver uses (hostname only — never the full URL or credentials).
    let embedLine = 'Embed source: unknown (open the public site console for Stream.getSourceStatus()).';
    try {
      if (typeof window !== 'undefined' && window.Stream && typeof window.Stream.getSourceStatus === 'function') {
        const st = window.Stream.getSourceStatus();
        if (st && st.embedConfigured) embedLine = 'Embed source: Configured' + (st.embedHost ? ' (' + st.embedHost + ')' : '');
        else embedLine = 'Embed source: Not configured (Watch buttons report "No stream source configured").';
      } else {
        embedLine = 'Embed source: configured embed page resolver (see js/stream.js EMBED.base). Player status reads live in the public site.';
      }
    } catch { /* static copy stands */ }
    card.appendChild(el('p', 'row-meta', embedLine));
    card.appendChild(el('p', 'row-meta', 'Direct source: Not configured — no direct production source is currently available for normal movies/episodes. Direct mode is validated but fails cleanly until a legitimate direct source exists.'));
    card.appendChild(el('p', 'row-meta', 'Test source: available in local dev via ?play-test=1 (legitimate public HLS test manifest — never used for normal playback).'));
    host.appendChild(card);
  }

  // Player behaviors genuinely in the build (documented, not toggled in V1).
  function renderPbPlayer() {
    const host = $('pb-player');
    if (!host) return;
    host.innerHTML = '';
    const card = el('div', 'data-row');
    card.appendChild(el('p', 'row-meta', 'V1 exposes the resolver mode only — no player switches were added because the current player does not offer clean global toggles for them:'));
    card.appendChild(el('p', 'row-meta', 'Autoplay is attempted for direct files, but browsers may block audible autoplay — playback starts paused and the user presses play.'));
    card.appendChild(el('p', 'row-meta', 'Resume continues from the saved position (localStorage progress keys); quality is Auto with manual heights only when the manifest exposes 2+ levels (Safari native HLS is platform-managed); captions appear only when the caller supplies subtitle tracks (catalog titles supply none). Cleanup destroys the previous HLS/Plyr instance and stale requests can never overwrite the current source.'));
    host.appendChild(card);
  }

  function renderPbTest() {
    const host = $('pb-test');
    if (!host) return;
    host.innerHTML = '';
    const card = el('div', 'data-row');
    card.appendChild(el('p', 'row-meta', 'Verify the Greybox Player with the existing safe test manifest (Mux HLS test stream, dev only — never a production source).'));
    card.appendChild(rowButtons([
      ['Open playback test', 'go', () => { try { window.open('/?play-test=1', '_blank', 'noopener'); } catch { /* noop */ } }, 'Open the public site with ?play-test=1 in a new tab'],
    ]));
    host.appendChild(card);
  }

  function renderPbNotes() {
    const host = $('pb-notes');
    if (!host) return;
    host.innerHTML = '';
    const card = el('div', 'data-row');
    card.appendChild(el('p', 'row-meta', 'Order is always: blocked filtering, then detail presentation, then playback — this workspace can never render blocked titles or override Detail Pages visibility. Hero trailers (YouTube background video, 4-second activation) are unaffected by the mode; only the hero Watch action follows it. Public config is cached ~60s and falls back to auto when unreachable.'));
    host.appendChild(card);
  }

  function updatePbChrome() {
    const dirty = pbIsDirty();
    const badge = $('pb-dirty');
    if (badge) badge.classList.toggle('hidden', !dirty);
    const save = $('pb-save');
    if (save) save.disabled = !dirty || pbSaving || !pbDraft;
    const discard = $('pb-discard');
    if (discard) discard.disabled = !dirty || pbSaving || !pbDraft;
    const reset = $('pb-reset');
    if (reset) reset.disabled = pbSaving || !pbDraft;
  }

  async function savePlayback() {
    if (pbSaving || !pbDraft) return;
    const err = pbValidateDraft(pbDraft);
    if (err) {
      notice('err', err);
      renderPlayback();
      return;
    }
    const myGen = ++pbGen;
    pbSaving = true;
    updatePbChrome();
    const saveBtn = $('pb-save');
    const prevLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn) { saveBtn.textContent = 'Saving…'; saveBtn.disabled = true; }
    try {
      const payload = JSON.parse(pbStableJson(pbDraft));
      await api(API.playback, { method: 'PUT', body: payload });
      // Never trust the 200 alone: read the row back before showing success.
      const readBack = await api(API.playback);
      if (myGen !== pbGen) return; // stale: a newer load/save owns the view
      const shaped = normalizePbServer(readBack);
      if (pbStableJson(shaped) !== pbStableJson(payload)) {
        notice('err', 'Save reported success, but a fresh read-back differs — not showing success. Refresh and retry.');
      } else {
        notice('ok', 'Playback saved. The public resolver updates within ~a minute.');
      }
      pbServer = shaped;
      pbDraft = pbClone(shaped);
      renderPlayback();
    } catch (e) {
      if (myGen !== pbGen) return;
      notice('err', 'Playback save failed: ' + ((e && e.message) || e));
    } finally {
      pbSaving = false;
      if (myGen === pbGen) {
        if (saveBtn && saveBtn.isConnected) saveBtn.textContent = prevLabel || 'Save Changes';
        updatePbChrome();
      }
    }
  }

  function discardPlayback() {
    if (!pbServer || pbSaving) return;
    if (!pbIsDirty()) return;
    pbDraft = pbClone(pbServer);
    renderPlayback();
    notice('ok', 'Unsaved Playback changes discarded.');
  }

  async function resetPlayback() {
    if (!pbDraft || pbSaving) return;
    const ok = await confirmDialog({
      title: 'Reset playback?',
      message: 'Stage the default resolver (Auto)? Your unsaved draft edits will be lost; nothing is saved until you press Save Changes.',
      okLabel: 'Reset to defaults',
    });
    if (!ok) return;
    pbDraft = pbDefaults();
    renderPlayback();
  }

  /* ================= GREYBOX PICKS (read view over existing overrides) ================= */
  async function loadPicks() {
    const host = $('picks-list');
    if (!host) return;
    if (!Array.isArray(ovCache)) {
      stateBox(host, 'loading', 'Loading picks…');
      try {
        ovCache = await api(API.overrides);
      } catch (e) {
        host.innerHTML = '';
        notice('err', 'Picks failed to load: ' + (e.message || e));
        return;
      }
    }
    const picks = (ovCache || []).filter(isGreyboxPick);
    host.innerHTML = '';
    if (!picks.length) {
      const box = stateBox(host, 'empty', 'No Greybox Picks yet', 'Mark any override as a Pick, or use TMDB Search to find titles.');
      const b = el('button', 'btn btn-secondary btn-sm', 'Go to Overrides');
      b.type = 'button';
      b.addEventListener('click', () => showView('overrides'));
      box.appendChild(b);
      return;
    }
    picks.forEach((o) => {
      const keys = Object.keys(o).filter((k) => k !== 'media' && k !== 'tmdb_id' && k !== 'featured' && k !== 'custom_badge');
      const card = el('div', 'data-row');
      const head = el('div', 'row-top');
      head.appendChild(el('span', 'row-title row-mono', o.media + ':' + o.tmdb_id));
      head.appendChild(el('span', 'badge badge-pick', '★ Greybox Pick'));
      card.appendChild(head);
      const label = o.title || o.name || '';
      card.appendChild(el('p', 'row-meta', (label ? label + ' — ' : '') + (keys.join(', ') || 'featured + badge')));
      card.appendChild(rowButtons([
        ['Edit override', 'go', () => openOverrideEditor(o)],
        ['☆ Unmark', '', () => togglePickFromOverrides(o).then(() => loadPicks()), 'Remove Greybox Pick badge'],
        ['Open ↗', '', () => { try { window.open(detailUrlFor(o.media, o.tmdb_id), '_blank', 'noopener'); } catch { /* noop */ } }, 'Open public page'],
      ]));
      host.appendChild(card);
    });
  }

  /* ================= HERO CONTROL CENTER (Part 2) ================= */
  // Pure helpers mirror functions/lib/validate.js (client-side first pass;
  // the server re-validates everything — a failed save is never shown as ok).

  var YT_KEY_RE = /^[A-Za-z0-9_-]{11}$/;

  // Bare YouTube key or full YouTube URL → normalized key. Throws {message}.
  function parseYoutubeKey(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (YT_KEY_RE.test(s)) return s;
    let u = null;
    try { u = new URL(s); }
    catch { throw { message: 'Trailer must be a YouTube key or YouTube URL (other hosts are not supported).' }; }
    const host = String(u.hostname || '').toLowerCase().replace(/^www\./, '');
    let key = '';
    if (host === 'youtu.be') {
      key = String(u.pathname || '').split('/').filter(Boolean)[0] || '';
    } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      const path = String(u.pathname || '');
      if (path === '/watch') { try { key = u.searchParams.get('v') || ''; } catch { key = ''; } }
      else {
        const m = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(path);
        if (m) key = m[1];
      }
    }
    if (key && YT_KEY_RE.test(key)) return key;
    throw { message: 'Trailer must be a YouTube key or YouTube URL (other hosts are not supported).' };
  }

  // Lenient client-side view of a hero presentation (defaults for anything
  // absent; the renderer + server own strictness).
  function heroPresentationOf(hero) {
    const h = (hero && typeof hero === 'object') ? hero : {};
    const a = (h.artwork && typeof h.artwork === 'object') ? h.artwork : {};
    const t = (h.trailer && typeof h.trailer === 'object') ? h.trailer : {};
    let delay = parseInt(t.delaySec, 10);
    if (!Number.isInteger(delay) || delay < 0) delay = 4;
    if (delay > 120) delay = 120;
    return {
      artwork: {
        backdrop: a.backdrop === 'custom' ? 'custom' : 'auto',
        backdropUrl: typeof a.backdropUrl === 'string' ? a.backdropUrl.trim() : '',
        logo: a.logo === 'custom' ? 'custom' : (a.logo === 'text' ? 'text' : 'tmdb'),
        logoUrl: typeof a.logoUrl === 'string' ? a.logoUrl.trim() : '',
      },
      trailer: {
        source: t.source === 'custom' ? 'custom' : (t.source === 'off' ? 'off' : 'auto'),
        key: typeof t.key === 'string' ? t.key.trim() : '',
        activation: t.activation === 'immediate' ? 'immediate' : (t.activation === 'wait-once' ? 'wait-once' : 'delayed'),
        delaySec: delay,
        muted: t.muted !== false,
        loop: t.loop !== false,
      },
    };
  }

  function describeTrailer(pres) {
    const t = (pres && pres.trailer) || {};
    if (t.source === 'off') return 'Trailer disabled';
    const bits = [];
    bits.push(t.source === 'custom' ? ('Custom ' + (t.key || '(unset)')) : 'Automatic (TMDB)');
    if (t.activation === 'immediate') bits.push('starts immediately');
    else if (t.activation === 'wait-once') bits.push('wait-once ' + t.delaySec + 's');
    else bits.push('delayed ' + t.delaySec + 's');
    bits.push(t.muted === false ? 'unmuted' : 'muted');
    if (t.loop === false) bits.push('no loop');
    return bits.join(' · ');
  }

  function describeArtwork(pres) {
    const a = (pres && pres.artwork) || {};
    const bits = [];
    bits.push(a.backdrop === 'custom' ? 'Custom backdrop' : 'TMDB backdrop');
    bits.push(a.logo === 'tmdb' ? 'TMDB logo' : (a.logo === 'custom' ? 'Custom logo' : 'Text title'));
    return bits.join(' · ');
  }

  let previewReader = null; // () => { target, pres, note } for the open hero editor

  async function loadHeroes() {
    const homeHost = $('heroes-home');
    const colHost = $('heroes-collections');
    if (homeHost) stateBox(homeHost, 'loading', 'Loading home hero…');
    if (colHost) stateBox(colHost, 'loading', 'Loading collections…');
    try {
      const [heroRes, colRes, mapRes] = await Promise.allSettled([
        api(API.hero), api(API.collections), api(API.colHeroes),
      ]);
      if (heroRes.status === 'rejected') throw heroRes.reason;
      if (colRes.status === 'rejected') throw colRes.reason;
      const hero = heroRes.value || { mode: 'follow-grid' };
      const cols = Array.isArray(colRes.value) ? colRes.value : [];
      const map = (mapRes.status === 'fulfilled' && mapRes.value && typeof mapRes.value === 'object' && !Array.isArray(mapRes.value))
        ? mapRes.value : {};
      colCache = cols;
      renderHeroesHome(hero);
      renderHeroesCollections(cols, map);
    } catch (e) {
      if (homeHost) { homeHost.innerHTML = ''; stateBox(homeHost, 'error', 'Home hero unavailable', (e && e.message) || String(e)); }
      if (colHost) { colHost.innerHTML = ''; stateBox(colHost, 'error', 'Collections unavailable', (e && e.message) || String(e)); }
      notice('err', 'Heroes failed to load: ' + ((e && e.message) || e));
    }
  }

  function renderHeroesHome(hero) {
    const host = $('heroes-home');
    if (!host) return;
    host.innerHTML = '';
    const pres = heroPresentationOf(hero);
    const card = el('div', 'data-row');
    const head = el('div', 'row-top');
    head.appendChild(el('span', 'row-title', 'Home Hero'));
    head.appendChild(el('span', 'badge badge-live', 'Live'));
    head.appendChild(el('span', 'row-mono muted', hero.mode || 'follow-grid'));
    card.appendChild(head);
    const lines = [];
    if (hero.mode === 'spotlight' && hero.heroItem) lines.push('Configured: ' + hero.heroItem.media + ':' + hero.heroItem.id);
    else if (hero.mode === 'custom') {
      lines.push('Configured: ' + summarizeSource(hero.source) + ' · pick ' + (hero.pick != null ? hero.pick : 0));
      if (hero.heroItem) lines.push('Inactive candidate (spotlight-only, ignored in custom mode): ' + hero.heroItem.media + ':' + hero.heroItem.id);
    } else {
      lines.push('Configured: follows the homepage grid');
      if (hero.heroItem) lines.push('Inactive candidate (spotlight-only, ignored in follow-grid mode): ' + hero.heroItem.media + ':' + hero.heroItem.id);
    }
    // Currently resolved hero — the same title the public homepage renders
    // from this configuration (media identity, never title strings).
    const resolved = heroResolvedIdentity(hero);
    if (resolved) lines.push('Resolved now: ' + resolved.media + ':' + resolved.id);
    else if (hero.mode === 'custom') lines.push('Resolved now: runtime item #' + Math.max(0, parseInt(hero.pick, 10) || 0) + ' of the rule source');
    else if (hero.mode !== 'spotlight') lines.push('Resolved now: current first grid item');
    else lines.push('Resolved now: (unresolvable — spotlight needs a valid heroItem)');
    if (hero.badge) lines.push('Badge: ' + hero.badge);
    lines.push(describeArtwork(pres));
    lines.push(describeTrailer(pres));
    lines.forEach((ln) => card.appendChild(el('p', 'row-meta', ln)));
    card.appendChild(rowButtons([
      ['Edit home hero', 'go', () => openHomeHeroEditorFresh(), 'Edit home hero content, artwork and trailer'],
      ['Open homepage ↗', '', () => { try { window.open('/', '_blank', 'noopener'); } catch { /* noop */ } }, 'Verify on the public site'],
    ]));
    host.appendChild(card);
  }

  // The editor always initializes from the CURRENT server configuration —
  // never from the load-time snapshot behind the card above — so a hero
  // changed elsewhere (General Settings, another tab) is reflected on open.
  async function openHomeHeroEditorFresh() {
    try {
      const fresh = await api(API.hero);
      openHomeHeroEditor(fresh && typeof fresh === 'object' ? fresh : { mode: 'follow-grid' });
    } catch (e) {
      notice('err', 'Could not load the current home hero: ' + ((e && e.message) || e));
    }
  }

  function renderHeroesCollections(cols, map) {
    const host = $('heroes-collections');
    if (!host) return;
    host.innerHTML = '';
    if (!cols.length) {
      stateBox(host, 'empty', 'No collections', 'Create a collection first — heroes attach to real collections only.');
      return;
    }
    cols.forEach((c) => {
      const entry = (map && map[c.slug] && typeof map[c.slug] === 'object') ? map[c.slug] : null;
      const custom = !!(entry && entry.mode === 'custom' && entry.heroItem);
      const card = el('div', 'data-row');
      const head = el('div', 'row-top');
      head.appendChild(el('span', 'row-title', c.title || c.slug));
      head.appendChild(el('span', 'badge ' + (custom ? 'badge-pick' : ''), custom ? 'Custom hero' : 'Default hero'));
      head.appendChild(el('span', 'row-mono muted', '/collection/' + c.slug));
      card.appendChild(head);
      if (custom) {
        const pres = heroPresentationOf(entry);
        card.appendChild(el('p', 'row-meta', 'Title: ' + entry.heroItem.media + ':' + entry.heroItem.id));
        card.appendChild(el('p', 'row-meta', describeArtwork(pres) + ' · ' + describeTrailer(pres)));
      } else {
        card.appendChild(el('p', 'row-meta', 'First title drives the hero. Configure a custom hero to pin a different title.'));
      }
      card.appendChild(rowButtons([
        ['Configure', custom ? 'go' : '', () => openCollectionHeroEditorFresh(c), 'Configure hero for /collection/' + c.slug],
        ['Open ↗', '', () => { try { window.open('/collection/' + c.slug, '_blank', 'noopener'); } catch { /* noop */ } }, 'Verify on the public site'],
      ]));
      host.appendChild(card);
    });
  }

  // Same fresh-init guarantee as the home hero editor: initialize from the
  // current collection_heroes map, never from the load-time snapshot above.
  async function openCollectionHeroEditorFresh(col) {
    try {
      const map = await api(API.colHeroes);
      const entry = (map && map[col.slug] && typeof map[col.slug] === 'object') ? map[col.slug] : null;
      openCollectionHeroEditor(col, entry);
    } catch (e) {
      notice('err', 'Could not load the current hero for /collection/' + col.slug + ': ' + ((e && e.message) || e));
    }
  }

  /* ---------- shared hero editor pieces (home + collection reuse them) ---------- */

  // Title picker: explicit media + TMDB id with TMDB search assistance.
  // The search uses the existing server-side proxy — no key in the browser.
  // Selecting a result populates media + id (one identity, never mixed).
  function heroItemPickerNode(prefix, item) {
    const wrap = el('div', '');
    wrap.style.cssText = 'display:grid;gap:.7rem';
    wrap.appendChild(fieldRow('Media', selectInput(prefix + '-media', [['movie', 'Movie'], ['tv', 'TV show']], item ? item.media : 'movie')));
    wrap.appendChild(fieldRow('TMDB ID', numInput(prefix + '-id', item ? item.id : '', '550')));
    const searchRow = el('div', '');
    searchRow.style.cssText = 'display:flex;gap:.5rem';
    const q = textInput(prefix + '-q', '', 'Fight Club');
    q.setAttribute('aria-label', 'Search TMDB titles');
    const go = el('button', 'btn btn-secondary btn-sm', 'Search TMDB');
    go.type = 'button';
    searchRow.appendChild(q);
    searchRow.appendChild(go);
    wrap.appendChild(searchRow);
    const res = el('div', 'hero-pick-results');
    res.id = prefix + '-results';
    wrap.appendChild(res);
    const run = () => heroItemSearch(prefix);
    go.addEventListener('click', run);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
    return wrap;
  }

  async function heroItemSearch(prefix) {
    const host = document.getElementById(prefix + '-results');
    const qEl = document.getElementById(prefix + '-q');
    const q = qEl ? String(qEl.value || '').trim() : '';
    if (!q) { if (host) host.innerHTML = '<p class="muted text-sm">Type a title first.</p>'; return; }
    if (q.length > 120) { if (host) host.innerHTML = '<p class="muted text-sm">Query must be at most 120 characters.</p>'; return; }
    if (host) host.innerHTML = '<p class="muted text-sm">Searching TMDB…</p>';
    try {
      const raw = await tmdbSearchFetch(q);
      const rows = normalizeTmdbSearchResults(raw).slice(0, 8);
      if (!host) return;
      host.innerHTML = '';
      if (!rows.length) { host.innerHTML = '<p class="muted text-sm">No matches. Try another spelling.</p>'; return; }
      rows.forEach((r) => {
        const row = el('div', 'hero-pick-result');
        const img = document.createElement('img');
        const posterUrl = tmdbPosterUrl(r.poster);
        img.loading = 'lazy';
        img.alt = '';
        img.src = posterUrl || 'https://via.placeholder.com/48x72?text=?';
        row.appendChild(img);
        const body = el('div', '');
        body.style.cssText = 'min-width:0;flex:1';
        body.appendChild(el('p', 'row-title', r.title));
        body.appendChild(el('p', 'muted text-sm', (r.media === 'tv' ? 'TV' : 'Movie') + ' · ' + (r.year || '—') + ' · TMDB ' + r.media + ':' + r.id));
        row.appendChild(body);
        const sel = el('button', 'rowbtn go', 'Select');
        sel.type = 'button';
        sel.setAttribute('aria-label', 'Select ' + r.title + ' (' + r.media + ':' + r.id + ')');
        sel.addEventListener('click', () => {
          const mEl = document.getElementById(prefix + '-media');
          const idEl = document.getElementById(prefix + '-id');
          if (mEl) mEl.value = r.media;
          if (idEl) idEl.value = String(r.id);
          setDrawerDirty(true);
          host.innerHTML = '<p class="muted text-sm">Selected ' + r.media + ':' + r.id + ' — refresh the preview below.</p>';
          refreshHeroPreview();
        });
        row.appendChild(sel);
        host.appendChild(row);
      });
    } catch (e) {
      if (host) host.innerHTML = '<p class="muted text-sm">Search failed: ' + esc((e && e.message) || e) + '</p>';
    }
  }

  function readHeroItem(prefix) {
    const mEl = document.getElementById(prefix + '-media');
    const idEl = document.getElementById(prefix + '-id');
    const media = mEl ? mEl.value : 'movie';
    if (media !== 'movie' && media !== 'tv') throw { message: "Media must be 'movie' or 'tv'." };
    const id = idEl ? parseInt(idEl.value, 10) : NaN;
    if (!Number.isInteger(id) || id < 1 || id > 2147483647) throw { message: 'TMDB ID must be a positive integer.' };
    return { media, id };
  }

  function artworkFieldsNode(prefix, art) {
    const a = (art && typeof art === 'object') ? art : {};
    const wrap = el('div', '');
    wrap.style.cssText = 'display:grid;gap:.7rem';
    wrap.appendChild(fieldRow('Backdrop', selectInput(prefix + '-backdrop', [['auto', 'Automatic (TMDB)'], ['custom', 'Custom URL']], a.backdrop === 'custom' ? 'custom' : 'auto')));
    wrap.appendChild(fieldRow('Custom backdrop URL (https://…)', textInput(prefix + '-backdropUrl', a.backdropUrl || '', 'https://…')));
    wrap.appendChild(fieldRow('Title / logo', selectInput(prefix + '-logo', [['text', 'Text title (fallback)'], ['tmdb', 'TMDB logo (automatic)'], ['custom', 'Custom logo URL']], a.logo === 'custom' ? 'custom' : (a.logo === 'text' ? 'text' : 'tmdb'))));
    wrap.appendChild(fieldRow('Custom logo URL (https://…)', textInput(prefix + '-logoUrl', a.logoUrl || '', 'https://…')));
    return wrap;
  }

  function readArtwork(prefix) {
    const v = (id) => { const n = document.getElementById(id); return n ? n.value : ''; };
    const backdrop = v(prefix + '-backdrop') === 'custom' ? 'custom' : 'auto';
    const backdropUrl = String(v(prefix + '-backdropUrl') || '').trim();
    const logoRaw = v(prefix + '-logo');
    const logo = logoRaw === 'custom' ? 'custom' : (logoRaw === 'text' ? 'text' : 'tmdb');
    const logoUrl = String(v(prefix + '-logoUrl') || '').trim();
    if (backdrop === 'custom') {
      if (!backdropUrl) throw { message: 'Custom backdrop URL is required.' };
      if (!/^https?:\/\//i.test(backdropUrl)) throw { message: 'Custom backdrop must be an http(s) URL.' };
      if (backdropUrl.length > 500) throw { message: 'Custom backdrop URL must be at most 500 characters.' };
    }
    if (logo === 'custom') {
      if (!logoUrl) throw { message: 'Custom logo URL is required.' };
      if (!/^https?:\/\//i.test(logoUrl)) throw { message: 'Custom logo must be an http(s) URL.' };
      if (logoUrl.length > 500) throw { message: 'Custom logo URL must be at most 500 characters.' };
    }
    return { backdrop, backdropUrl, logo, logoUrl };
  }

  function trailerFieldsNode(prefix, tr) {
    const t = (tr && typeof tr === 'object') ? tr : {};
    const wrap = el('div', '');
    wrap.style.cssText = 'display:grid;gap:.7rem';
    wrap.appendChild(fieldRow('Source', selectInput(prefix + '-source',
      [['auto', 'Automatic (TMDB)'], ['custom', 'Custom YouTube trailer'], ['off', 'Disabled (still image only)']],
      t.source === 'custom' ? 'custom' : (t.source === 'off' ? 'off' : 'auto'))));
    wrap.appendChild(fieldRow('Custom trailer (YouTube key or URL)', textInput(prefix + '-key', t.key || '', 'dQw4w9WgXcQ or https://youtu.be/…')));
    wrap.appendChild(fieldRow('Activation', selectInput(prefix + '-activation',
      [['delayed', 'Delayed — wait N seconds every time'], ['immediate', 'Immediate — start at once'], ['wait-once', 'Wait once — delay only the first time']],
      t.activation === 'immediate' ? 'immediate' : (t.activation === 'wait-once' ? 'wait-once' : 'delayed'))));
    wrap.appendChild(fieldRow('Delay (seconds, 0–120)', numInput(prefix + '-delay', (t.delaySec != null ? t.delaySec : 4), '4')));
    wrap.appendChild(checkInput(prefix + '-muted', t.muted !== false, 'Muted autoplay (required by most browsers)'));
    wrap.appendChild(checkInput(prefix + '-loop', t.loop !== false, 'Loop trailer'));
    wrap.appendChild(el('p', 'muted text-sm', 'Autoplay is never guaranteed: browsers may block it, in which case the hero keeps its still image. Only YouTube sources are supported.'));
    return wrap;
  }

  function readTrailer(prefix) {
    const v = (id) => { const n = document.getElementById(id); return n ? n.value : ''; };
    const srcRaw = v(prefix + '-source');
    const source = srcRaw === 'custom' ? 'custom' : (srcRaw === 'off' ? 'off' : 'auto');
    let key = '';
    if (source === 'custom') {
      key = parseYoutubeKey(v(prefix + '-key'));
      if (!key) throw { message: 'Custom trailer needs a YouTube key or URL.' };
    }
    const actRaw = v(prefix + '-activation');
    const activation = actRaw === 'immediate' ? 'immediate' : (actRaw === 'wait-once' ? 'wait-once' : 'delayed');
    const delaySec = parseInt(v(prefix + '-delay'), 10);
    if (!Number.isInteger(delaySec) || delaySec < 0 || delaySec > 120) throw { message: 'Delay must be 0–120 seconds.' };
    const mutedEl = document.getElementById(prefix + '-muted');
    const loopEl = document.getElementById(prefix + '-loop');
    return { source, key, activation, delaySec, muted: mutedEl ? !!mutedEl.checked : true, loop: loopEl ? !!loopEl.checked : true };
  }

  /* ---------- hero preview (read-only: never saves, never mutates state) ---------- */

  function heroPreviewNode() {
    const wrap = el('div', 'hero-preview');
    const bar = el('div', 'hero-preview-bar');
    bar.appendChild(el('span', 'badge badge-soon', 'Preview'));
    bar.appendChild(el('span', 'muted text-sm', 'Unsaved — save to make live.'));
    const refresh = el('button', 'btn btn-ghost btn-sm', 'Refresh preview');
    refresh.type = 'button';
    refresh.addEventListener('click', () => refreshHeroPreview());
    bar.appendChild(refresh);
    wrap.appendChild(bar);
    const body = el('div', 'hero-preview-body');
    body.id = 'hero-preview-body';
    body.innerHTML = '<p class="muted text-sm">Select a title, then Refresh preview.</p>';
    wrap.appendChild(body);
    return wrap;
  }

  function previewTargetFromReader() {
    try {
      if (typeof previewReader !== 'function') return { target: null, pres: heroPresentationOf(null), note: '' };
      const r = previewReader() || {};
      return { target: r.target || null, pres: heroPresentationOf(r.pres), note: r.note || '' };
    } catch (e) {
      return { target: null, pres: heroPresentationOf(null), note: (e && e.message) || String(e) };
    }
  }

  async function refreshHeroPreview() {
    const body = document.getElementById('hero-preview-body');
    if (!body) return;
    const { target, pres, note } = previewTargetFromReader();
    if (note) { body.innerHTML = ''; body.appendChild(el('p', 'muted text-sm', note)); return; }
    if (!target) { body.innerHTML = ''; body.appendChild(el('p', 'muted text-sm', 'No fixed title to preview (rule-based sources resolve at runtime).')); return; }
    body.innerHTML = '<p class="muted text-sm">Loading preview…</p>';
    try {
      const res = await fetch('/api/' + target.media + '/' + target.id, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error('Title not found (' + res.status + ').');
      const d = await res.json();
      body.innerHTML = '';
      const art = el('div', 'hero-preview-art');
      let artUrl = '';
      if (pres.artwork.backdrop === 'custom' && pres.artwork.backdropUrl) artUrl = pres.artwork.backdropUrl;
      else if (d.backdrop_path) artUrl = 'https://image.tmdb.org/t/p/w1280' + d.backdrop_path;
      else if (d.poster_path) artUrl = 'https://image.tmdb.org/t/p/w500' + d.poster_path;
      if (artUrl) {
        const img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        img.src = artUrl;
        img.onerror = function () { try { img.remove(); } catch (e) { /* noop */ } };
        art.appendChild(img);
      } else {
        art.appendChild(el('p', 'muted text-sm', '(no artwork available)'));
      }
      body.appendChild(art);
      const title = d.title || d.name || 'Untitled';
      if (pres.artwork.logo === 'custom' && pres.artwork.logoUrl) {
        const li = document.createElement('img');
        li.alt = title;
        li.className = 'hero-preview-logo';
        li.loading = 'lazy';
        li.src = pres.artwork.logoUrl;
        body.appendChild(li);
      } else if (pres.artwork.logo === 'tmdb') {
        const lz = el('p', 'muted text-sm', 'Logo: TMDB (resolved on the public page)');
        body.appendChild(lz);
        body.appendChild(el('p', 'hero-preview-title', title));
      } else {
        body.appendChild(el('p', 'hero-preview-title', title));
      }
      const date = String(d.release_date || d.first_air_date || '').slice(0, 4);
      body.appendChild(el('p', 'muted text-sm', [(date || '—'), target.media === 'tv' ? 'TV' : 'Movie', 'TMDB ' + target.media + ':' + target.id].join(' · ')));
      if (d.overview) body.appendChild(el('p', 'muted text-sm', String(d.overview).slice(0, 220)));
      const ov = findCachedOverride(target.media, target.id);
      if (ov) body.appendChild(el('p', 'muted text-sm', 'Metadata override active (' + Object.keys(ov).filter((k) => k !== 'media' && k !== 'tmdb_id').join(', ') + ').'));
      body.appendChild(el('p', 'muted text-sm', describeTrailer(pres)));
    } catch (e) {
      body.innerHTML = '';
      body.appendChild(el('p', 'muted text-sm', 'Preview failed: ' + ((e && e.message) || e)));
    }
  }

  /* ---------- home hero editor ---------- */

  function openHomeHeroEditor(hero) {
    const h = (hero && typeof hero === 'object') ? hero : { mode: 'follow-grid' };
    const pres = heroPresentationOf(h);
    const f = document.createElement('form');
    f.id = 'hh-form';
    f.autocomplete = 'off';
    f.style.cssText = 'display:grid;gap:.8rem';
    f.appendChild(heroPreviewNode());
    f.appendChild(groupBox('Content', [
      fieldRow('Mode', selectInput('hh-mode',
        [['follow-grid', 'Follow-grid (banner follows the grid)'], ['custom', 'Custom (rule source + pick)'], ['spotlight', 'Spotlight (one explicit title)']],
        h.mode === 'custom' ? 'custom' : (h.mode === 'spotlight' ? 'spotlight' : 'follow-grid'))),
      (() => {
        const w = el('div', '');
        w.appendChild(el('span', 'flabel', 'Spotlight title (explicit media identity)'));
        w.appendChild(heroItemPickerNode('hhi', h.heroItem || null));
        w.appendChild(el('p', 'muted text-sm', 'Honored in Spotlight mode only — Custom uses the rule source + pick below, Follow-grid uses the grid. Stored values in other modes are preserved but inactive.'));
        return w;
      })(),
      fieldRow('Badge (custom/spotlight label, optional)', textInput('hh-badge', h.badge || '', 'Greybox Spotlight')),
      fieldRow('Pick (custom mode item index)', numInput('hh-pick', (h.pick != null ? h.pick : 0), '0')),
      (() => {
        const srcHost = el('div', '');
        srcHost.style.cssText = 'display:grid;gap:.7rem';
        srcHost.id = 'hh-source';
        const w = el('div', '');
        w.appendChild(el('span', 'flabel', 'Rule source (custom mode)'));
        w.appendChild(srcHost);
        renderSourceFields(srcHost, 'hh-src', HOME_SOURCE_TYPES, h.source || null);
        return w;
      })(),
    ]));
    f.appendChild(groupBox('Artwork', [artworkFieldsNode('hha', pres.artwork)]));
    f.appendChild(groupBox('Trailer', [trailerFieldsNode('hht', pres.trailer)]));
    const row = el('div', '');
    row.style.cssText = 'display:flex;gap:.5rem;flex-wrap:wrap';
    const save = el('button', 'btn btn-primary btn-sm', 'Save Changes');
    save.type = 'submit';
    const cancel = el('button', 'btn btn-ghost btn-sm', 'Discard');
    cancel.type = 'button';
    cancel.addEventListener('click', closeDrawer);
    row.appendChild(save);
    row.appendChild(cancel);
    f.appendChild(row);
    f.addEventListener('submit', (e) => { e.preventDefault(); saveHomeHero(); });
    openDrawer({ kicker: 'Heroes', title: 'Edit home hero', sub: 'Content, artwork and trailer. Preview above is unsaved.', node: f, form: f });
    previewReader = () => {
      const modeEl = document.getElementById('hh-mode');
      const mode = modeEl ? modeEl.value : 'follow-grid';
      if (mode === 'spotlight') return { target: readHeroItem('hhi'), pres: { artwork: readArtwork('hha'), trailer: readTrailer('hht') } };
      if (mode === 'custom') {
        try {
          const src = readSource('hh-src');
          // Same selection as the public homepage (js/data.js getHeroItem):
          // items[pick], falling back to items[0]. Never items[0] alone.
          const pickEl = document.getElementById('hh-pick');
          const pick = pickEl ? Math.max(0, parseInt(pickEl.value, 10) || 0) : 0;
          if (src && src.type === 'ids' && Array.isArray(src.items) && src.items.length) {
            const valid = src.items.filter((it) => it && (it.media === 'movie' || it.media === 'tv') &&
              Number.isInteger(it.id) && it.id > 0 && it.id <= 2147483647);
            const chosen = valid[pick] || valid[0];
            if (chosen) return { target: chosen, pres: { artwork: readArtwork('hha'), trailer: readTrailer('hht') } };
            return { target: null, pres: null, note: 'No valid items in the rule source.' };
          }
          return { target: null, pres: null, note: 'Rule-based source (' + summarizeSource(src) + ' · pick ' + pick + ') resolves at runtime — save, then verify on the homepage.' };
        } catch (e) { return { target: null, pres: null, note: e && e.message ? e.message : String(e) }; }
      }
      return { target: null, pres: null, note: 'Follows the homepage grid — no fixed title to preview.' };
    };
    refreshHeroPreview();
  }

  function readHomeHeroForm() {
    const modeEl = $('hh-mode');
    const modeRaw = modeEl ? modeEl.value : 'follow-grid';
    const mode = modeRaw === 'custom' ? 'custom' : (modeRaw === 'spotlight' ? 'spotlight' : 'follow-grid');
    const badge = ($('hh-badge') ? $('hh-badge').value : '').trim();
    if (badge.length > 120) throw { message: 'Badge must be at most 120 characters.' };
    const pick = parseInt($('hh-pick') ? $('hh-pick').value : '0', 10);
    if (!Number.isInteger(pick) || pick < 0 || pick > 100) throw { message: 'Pick must be 0–100.' };
    let heroItem = null;
    if (mode === 'spotlight') heroItem = readHeroItem('hhi');
    else {
      try { heroItem = readHeroItem('hhi'); } catch { heroItem = null; }
    }
    const body = { mode, badge, pick, heroItem, artwork: readArtwork('hha'), trailer: readTrailer('hht') };
    if (mode === 'custom') {
      body.source = readSource('hh-src');
      const srcErr = vSource(body.source, HOME_SOURCE_TYPES);
      if (srcErr) throw { message: srcErr };
    }
    return body;
  }

  // Stable subset comparison for save → read-back verification: the PUT
  // echo and a fresh GET must describe the same stored row (same endpoint,
  // same D1 settings.home_hero key). Key order + unknown keys ignored.
  function stableHeroJson(hero) {
    try {
      const h = (hero && typeof hero === 'object') ? hero : {};
      return JSON.stringify({
        mode: h.mode || null,
        badge: h.badge != null ? h.badge : null,
        pick: h.pick != null ? h.pick : null,
        source: h.source !== undefined ? h.source : null,
        heroItem: h.heroItem !== undefined ? h.heroItem : null,
        artwork: h.artwork !== undefined ? h.artwork : null,
        trailer: h.trailer !== undefined ? h.trailer : null,
      });
    } catch { return null; }
  }

  async function saveHomeHero() {
    const form = $('hh-form');
    setFormSaving(form, true);
    try {
      const body = readHomeHeroForm();
      const saved = await api(API.hero, { method: 'PUT', body });
      // Never trust the 200 alone: read the row back and compare against
      // what the server stored before showing success.
      const readBack = await api(API.hero);
      if (stableHeroJson(saved) !== stableHeroJson(readBack)) {
        notice('err', 'Home hero saved, but a fresh read-back differs — not showing success. Reload Heroes and retry.');
      } else {
        notice('ok', 'Home hero saved.');
      }
      previewReader = null;
      closeDrawer();
      await loadHeroes();
      await loadHero(); // keep General Settings in sync (same endpoint)
      if (currentView === 'dashboard') loadDashboard();
    } catch (e) {
      notice('err', (e.message || e));
    } finally {
      setFormSaving(form, false);
    }
  }

  /* ---------- collection hero editor ---------- */

  function openCollectionHeroEditor(col, entry) {
    const custom = !!(entry && entry.mode === 'custom');
    const pres = heroPresentationOf(entry);
    const f = document.createElement('form');
    f.id = 'ch-form';
    f.autocomplete = 'off';
    f.style.cssText = 'display:grid;gap:.8rem';
    f.appendChild(heroPreviewNode());
    f.appendChild(groupBox('Behavior', [
      fieldRow('Hero for /collection/' + col.slug, selectInput('ch-mode',
        [['default', 'Default (first title drives the hero)'], ['custom', 'Custom (pin one explicit title)']],
        custom ? 'custom' : 'default')),
      el('p', 'muted text-sm', 'A custom hero never changes the collection’s titles — only which title the hero presents.'),
    ]));
    f.appendChild(groupBox('Content', [heroItemPickerNode('chi', (entry && entry.heroItem) || null)]));
    f.appendChild(groupBox('Artwork', [artworkFieldsNode('cha', pres.artwork)]));
    f.appendChild(groupBox('Trailer', [trailerFieldsNode('cht', pres.trailer)]));
    const row = el('div', '');
    row.style.cssText = 'display:flex;gap:.5rem;flex-wrap:wrap';
    const save = el('button', 'btn btn-primary btn-sm', 'Save Changes');
    save.type = 'submit';
    const reset = el('button', 'btn btn-ghost btn-sm', 'Reset to default');
    reset.type = 'button';
    reset.addEventListener('click', () => resetCollectionHero(col));
    const cancel = el('button', 'btn btn-ghost btn-sm', 'Discard');
    cancel.type = 'button';
    cancel.addEventListener('click', closeDrawer);
    row.appendChild(save);
    row.appendChild(reset);
    row.appendChild(cancel);
    f.appendChild(row);
    f.addEventListener('submit', (e) => { e.preventDefault(); saveCollectionHero(col); });
    openDrawer({ kicker: 'Heroes', title: 'Hero — ' + (col.title || col.slug), sub: '/collection/' + col.slug, node: f, form: f });
    previewReader = () => {
      const mEl = document.getElementById('ch-mode');
      if (!mEl || mEl.value !== 'custom') return { target: null, pres: null, note: 'Default hero — the collection’s first title drives it.' };
      return { target: readHeroItem('chi'), pres: { artwork: readArtwork('cha'), trailer: readTrailer('cht') } };
    };
    refreshHeroPreview();
  }

  async function saveCollectionHero(col) {
    const form = $('ch-form');
    setFormSaving(form, true);
    try {
      const modeEl = $('ch-mode');
      const custom = !!modeEl && modeEl.value === 'custom';
      const map = await api(API.colHeroes);
      const next = (map && typeof map === 'object' && !Array.isArray(map)) ? { ...map } : {};
      if (custom) {
        // Read-modify-write on a fresh GET so concurrent edits to OTHER
        // collections are never clobbered (single-operator tool).
        next[col.slug] = { mode: 'custom', heroItem: readHeroItem('chi'), artwork: readArtwork('cha'), trailer: readTrailer('cht') };
      } else {
        // Default behavior is the ABSENCE of an entry — the map holds
        // custom heroes only, so it can never go stale.
        delete next[col.slug];
      }
      await api(API.colHeroes, { method: 'PUT', body: next });
      notice('ok', custom ? 'Custom hero saved for /collection/' + col.slug + '.' : 'Default hero restored for /collection/' + col.slug + '.');
      previewReader = null;
      closeDrawer();
      await loadHeroes();
    } catch (e) {
      notice('err', (e.message || e));
    } finally {
      setFormSaving(form, false);
    }
  }

  async function resetCollectionHero(col) {
    const ok = await confirmDialog({ title: 'Reset hero?', message: 'Remove the custom hero for /collection/' + col.slug + '? The first title will drive the hero again.', okLabel: 'Reset' });
    if (!ok) return;
    try {
      const map = await api(API.colHeroes);
      const next = (map && typeof map === 'object' && !Array.isArray(map)) ? { ...map } : {};
      delete next[col.slug];
      await api(API.colHeroes, { method: 'PUT', body: next });
      notice('ok', 'Hero reset to default for /collection/' + col.slug + '.');
      previewReader = null;
      closeDrawer();
      await loadHeroes();
    } catch (e) {
      notice('err', (e.message || e));
    }
  }

  /* ================= TMDB SEARCH (admin helper, existing systems only) ================= */
  const EDITOR_PICKS_SLUG = 'editor-picks';
  const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';
  let searchState = { query: '', results: [], epItems: null, blockedKeys: null }; // epItems null = unknown

  function detailUrlFor(media, id) {
    const n = parseInt(id, 10);
    if (!Number.isInteger(n) || n < 1) return '/';
    return media === 'tv' ? '/tv/' + n : '/movie/' + n;
  }

  function tmdbPosterUrl(posterPath) {
    if (typeof posterPath !== 'string' || posterPath.indexOf('..') >= 0 || !/^\/[A-Za-z0-9/_\-.]+$/.test(posterPath)) return null;
    return TMDB_IMG + posterPath;
  }

  // Normalize raw TMDB search rows into picker cards
  // ({ media, id, title, year, vote, poster, overview }). /search/multi tags
  // every row with media_type, but /search/movie and /search/tv return rows
  // WITHOUT media_type (every result shares the endpoint type) — the caller
  // passes that endpoint type as fallbackMedia so type-scoped searches keep
  // their results instead of filtering everything out as "no matches".
  // Single-arg callers (multi search) behave exactly as before.
  function normalizeTmdbSearchResults(raw, fallbackMedia) {
    const list = raw && Array.isArray(raw.results) ? raw.results : [];
    const fb = fallbackMedia === 'tv' ? 'tv' : (fallbackMedia === 'movie' ? 'movie' : null);
    const out = [];
    for (const r of list) {
      const mt = (r && (r.media_type === 'movie' || r.media_type === 'tv')) ? r.media_type : fb;
      if (!r || (mt !== 'movie' && mt !== 'tv')) continue;
      const id = parseInt(r.id, 10);
      if (!Number.isInteger(id) || id < 1 || id > 2147483647) continue;
      const title = String(r.title || r.name || '').trim() || 'Untitled';
      const date = String(r.release_date || r.first_air_date || '');
      const vote = Number(r.vote_average);
      out.push({
        media: mt,
        id,
        title: title.slice(0, 200),
        year: date.slice(0, 4),
        vote: Number.isFinite(vote) ? vote : 0,
        poster: typeof r.poster_path === 'string' && r.poster_path ? r.poster_path : null,
        overview: String(r.overview || '').slice(0, 500),
      });
    }
    return out;
  }

  function normalizeEpItems(items) {
    return (Array.isArray(items) ? items : [])
      .map((it) => {
        if (!it || typeof it !== 'object') return null;
        const id = parseInt(it.id, 10);
        if (!Number.isInteger(id) || id < 1) return null;
        return { media: it.media === 'tv' ? 'tv' : 'movie', id };
      })
      .filter(Boolean);
  }

  function isInEditorPicks(items, media, id) {
    const n = parseInt(id, 10);
    return normalizeEpItems(items).some((it) => it.media === media && it.id === n);
  }

  function withAddedToEditorPicks(items, media, id) {
    const t = validPickTarget(media, id);
    const cur = normalizeEpItems(items);
    if (cur.some((it) => it.media === t.media && it.id === t.id)) return cur;
    return cur.concat([{ media: t.media, id: t.id }]);
  }

  function withRemovedFromEditorPicks(items, media, id) {
    const t = validPickTarget(media, id);
    return normalizeEpItems(items).filter((it) => !(it.media === t.media && it.id === t.id));
  }

  // Title search through the existing server-side TMDB proxy (the TMDB
  // credential never reaches the browser). The media scope picks the real
  // TMDB endpoint: Movies → /search/movie, TV Shows → /search/tv,
  // All (or omitted) → /search/multi. Single-arg callers build exactly the
  // same multi URL as before.
  async function tmdbSearchFetch(query, media) {
    const q = String(query || '').trim();
    if (!q) throw { status: 400, message: 'Type a title first.' };
    if (q.length > 120) throw { status: 400, message: 'Query must be at most 120 characters.' };
    const scope = media === 'tv' ? 'tv' : (media === 'movie' ? 'movie' : 'multi');
    const path = scope === 'multi' ? 'search/multi' : ('search/' + scope);
    const url = '/api/tmdb/' + path + '?language=en-US&page=1&include_adult=false&query=' + encodeURIComponent(q);
    let res;
    try {
      res = await fetch(url, { headers: { accept: 'application/json' } });
    } catch (e) {
      throw { status: 0, message: 'Network error: could not reach the server.' };
    }
    if (res.status === 204) return { results: [] };
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) throw { status: res.status, message: (data && data.error) || ('Search failed (' + res.status + ').') };
    return data;
  }

  // Direct TMDB ID lookup through the same existing server-side proxy (no
  // key in the browser). Movies verifies /movie/{id}, TV Shows verifies
  // /tv/{id}. Returns one normalized picker card
  // ({ media, id, title, year, vote, poster, overview }) or throws
  // { status: 404 } when TMDB has no such title, { status: 400 } for a
  // non-numeric ID, and the proxy error otherwise (never masked as empty).
  async function tmdbDetailFetch(media, id) {
    const mt = media === 'tv' ? 'tv' : 'movie';
    const n = parseInt(String(id == null ? '' : id).trim(), 10);
    if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw { status: 400, message: 'Enter a numeric TMDB ID.' };
    const kind = mt === 'tv' ? 'TV show' : 'movie';
    const url = '/api/tmdb/' + mt + '/' + n + '?language=en-US';
    let res;
    try {
      res = await fetch(url, { headers: { accept: 'application/json' } });
    } catch (e) {
      throw { status: 0, message: 'Network error: could not reach the server.' };
    }
    if (res.status === 404) throw { status: 404, message: 'No ' + kind + ' found for TMDB ID ' + n + '.' };
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) throw { status: res.status, message: (data && data.error) || ('Lookup failed (' + res.status + ').') };
    if (!data || data.success === false) throw { status: 404, message: 'No ' + kind + ' found for TMDB ID ' + n + '.' };
    const title = String(data.title || data.name || '').trim() || 'Untitled';
    const date = String(data.release_date || data.first_air_date || '');
    const vote = Number(data.vote_average);
    return {
      media: mt,
      id: (Number.isInteger(data.id) && data.id > 0) ? data.id : n,
      title: title.slice(0, 200),
      year: date.slice(0, 4),
      vote: Number.isFinite(vote) ? vote : 0,
      poster: typeof data.poster_path === 'string' && data.poster_path ? data.poster_path : null,
      overview: String(data.overview || '').slice(0, 500),
    };
  }

  // TMDB ID mode resolution for the Blocked Titles picker (always returns an
  // array of verified cards). Movies / TV Shows verify the exact endpoint;
  // All resolves BOTH endpoints and returns whichever identities verify
  // (0, 1, or 2 cards — e.g. the same numeric ID can exist as a movie AND a
  // show), so a bare numeric ID is never silently assigned the wrong media
  // type. A hard failure (network/auth) is never masked as "no match".
  async function resolveBlockedId(nid, scope) {
    if (scope === 'movie') return [await tmdbDetailFetch('movie', nid)];
    if (scope === 'tv') return [await tmdbDetailFetch('tv', nid)];
    const settled = await Promise.allSettled([tmdbDetailFetch('movie', nid), tmdbDetailFetch('tv', nid)]);
    const out = [];
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) out.push(s.value);
    }
    if (out.length) return out;
    const hard = settled.map((s) => s.reason).find((e) => e && e.status !== 404);
    if (hard) throw hard;
    const nf = new Error('No movie or TV show found for TMDB ID ' + nid + '.');
    nf.status = 404;
    throw nf;
  }

  async function setEditorPicksMembership(media, id, want) {
    const t = validPickTarget(media, id);
    let col;
    try {
      col = await api(API.collections + '/' + EDITOR_PICKS_SLUG);
    } catch (e) {
      if (e && e.status === 404) throw { message: "Editor's Picks collection not found." };
      throw e;
    }
    if (!col.source || col.source.type !== 'custom' || !Array.isArray(col.source.items)) {
      throw { message: "Editor's Picks is not a custom collection." };
    }
    const items = want
      ? withAddedToEditorPicks(col.source.items, t.media, t.id)
      : withRemovedFromEditorPicks(col.source.items, t.media, t.id);
    const updated = await api(API.collections + '/' + EDITOR_PICKS_SLUG, {
      method: 'PUT',
      body: { ...col, slug: EDITOR_PICKS_SLUG, source: { type: 'custom', items } },
    });
    searchState.epItems = normalizeEpItems(updated.source && updated.source.items);
    return updated;
  }

  function manageOverrideFor(media, id) {
    const t = validPickTarget(media, id);
    const known = findCachedOverride(t.media, t.id);
    const apply = (row) => {
      // Existence is known here: pass it explicitly so a new override
      // POSTs instead of PUT-404ing.
      openOverrideEditor(row || { media: t.media, tmdb_id: t.id }, { isNew: !row });
    };
    if (known) { apply(known); return Promise.resolve(); }
    return readOverrideRow(t.media, t.id).then(apply, (e) => { notice('err', (e && e.message) || e); });
  }

  function buildSearchPanel() {
    const f = $('tmdb-search-form');
    if (!f) return;
    f.innerHTML = '';
    f.appendChild(fieldRow('Title', textInput('tmdb-search-q', '', 'Fight Club')));
    f.appendChild(el('p', 'muted text-sm', 'Searches TMDB through the existing server-side proxy (no key in the browser). Movies + TV only — people are hidden.'));
    const row = el('div', '');
    row.style.cssText = 'display:flex;gap:.5rem';
    const go = el('button', 'btn btn-primary btn-sm', 'Search');
    go.type = 'submit';
    row.appendChild(go);
    f.appendChild(row);
    f.addEventListener('submit', (e) => { e.preventDefault(); runTmdbSearch(); });
    const host = $('tmdb-search-list');
    if (host) stateBox(host, 'empty', 'Search TMDB', 'Type a movie or TV title above, then Search.');
  }

  async function runTmdbSearch() {
    const host = $('tmdb-search-list');
    const qEl = $('tmdb-search-q');
    const q = qEl ? qEl.value.trim() : '';
    if (!q) { notice('err', 'Type a title first.'); return; }
    if (q.length > 120) { notice('err', 'Query must be at most 120 characters.'); return; }
    if (host) stateBox(host, 'loading', 'Searching TMDB…');
    try {
      const [tmdbRes, epRes, ovRes, blockedRes] = await Promise.allSettled([
        tmdbSearchFetch(q),
        api(API.collections + '/' + EDITOR_PICKS_SLUG),
        api(API.overrides),
        api(API.blocked),
      ]);
      if (tmdbRes.status === 'rejected') throw tmdbRes.reason;
      if (ovRes.status === 'fulfilled') ovCache = ovRes.value;
      searchState = {
        query: q,
        results: normalizeTmdbSearchResults(tmdbRes.value),
        epItems: epRes.status === 'fulfilled' && epRes.value && epRes.value.source
          ? normalizeEpItems(epRes.value.source.items)
          : null,
        // Admin search never hides blocked titles — it marks them BLOCKED
        // (public search filters them out via js/data.js instead).
        blockedKeys: blockedRes.status === 'fulfilled' && Array.isArray(blockedRes.value)
          ? new Set(blockedRes.value.map((b) => blockedKey(b.media, b.tmdb_id)).filter(Boolean))
          : null,
      };
      renderSearchCards();
      if (!searchState.results.length && host) {
        host.innerHTML = '';
        const box = stateBox(host, 'empty', 'No matches', 'No matches for “' + q + '”. Try another spelling.');
        void box;
      }
    } catch (e) {
      if (host) {
        host.innerHTML = '';
        stateBox(host, 'error', 'Search failed', (e && e.message) || String(e));
      }
      notice('err', 'Search failed: ' + ((e && e.message) || e));
    }
  }

  function renderSearchCards() {
    const host = $('tmdb-search-list');
    if (!host) return;
    host.innerHTML = '';
    if (!searchState.results.length) return;
    searchState.results.forEach((r) => {
      const card = el('div', 'data-row');
      const row = el('div', '');
      row.style.cssText = 'display:flex;gap:.75rem';
      const img = document.createElement('img');
      const posterUrl = tmdbPosterUrl(r.poster);
      img.className = 'search-thumb';
      img.loading = 'lazy';
      img.alt = '';
      img.src = posterUrl || 'https://via.placeholder.com/48x72?text=?';
      row.appendChild(img);
      const body = el('div', '');
      body.style.cssText = 'min-width:0;flex:1';
      const head = el('div', 'row-top');
      head.appendChild(el('span', 'row-title', r.title));
      head.appendChild(el('span', 'badge', r.media === 'tv' ? 'TV' : 'Movie'));
      if (searchState.blockedKeys && searchState.blockedKeys.has(blockedKey(r.media, r.id))) {
        head.appendChild(el('span', 'badge badge-blocked', 'Blocked'));
      }
      if (isGreyboxPick(findCachedOverride(r.media, r.id))) {
        head.appendChild(el('span', 'badge badge-pick', '★ Greybox Pick'));
      }
      body.appendChild(head);
      const metaBits = [(r.year || '—'), '⭐ ' + Number(r.vote || 0).toFixed(1), 'TMDB ' + r.media + ':' + r.id];
      body.appendChild(el('p', 'row-meta', metaBits.join(' · ')));
      if (r.overview) body.appendChild(el('p', 'row-meta', r.overview));
      row.appendChild(body);
      card.appendChild(row);
      const inPicks = searchState.epItems !== null && isInEditorPicks(searchState.epItems, r.media, r.id);
      const marked = isGreyboxPick(findCachedOverride(r.media, r.id));
      card.appendChild(rowButtons([
        ['Open ↗', '', () => { try { window.open(detailUrlFor(r.media, r.id), '_blank', 'noopener'); } catch { /* noop */ } }, 'Open public page'],
        [searchState.epItems === null ? "+ Editor's Picks" : (inPicks ? "✓ In Editor's Picks" : "+ Editor's Picks"), '', () => toggleEditorPicksFromSearch(r), "Toggle Editor's Picks membership"],
        [marked ? '☆ Unmark Pick' : '★ Mark Pick', '', () => togglePickFromSearch(r), marked ? 'Remove Greybox Pick badge' : 'Mark as Greybox Pick'],
        ['Override', 'go', () => manageOverrideFor(r.media, r.id), 'Create or edit override'],
      ]));
      host.appendChild(card);
    });
  }

  async function toggleEditorPicksFromSearch(r) {
    try {
      const member = searchState.epItems !== null && isInEditorPicks(searchState.epItems, r.media, r.id);
      await setEditorPicksMembership(r.media, r.id, !member);
      notice('ok', member ? ('Removed ' + r.media + ':' + r.id + " from Editor's Picks.") : ('Added ' + r.media + ':' + r.id + " to Editor's Picks."));
      renderSearchCards();
    } catch (e) {
      notice('err', (e && e.message) || e);
    }
  }

  async function togglePickFromSearch(r) {
    try {
      const known = findCachedOverride(r.media, r.id);
      await toggleGreyboxPick(r.media, r.id, known);
      try { ovCache = await api(API.overrides); } catch { /* keep stale cache */ }
      notice('ok', isGreyboxPick(findCachedOverride(r.media, r.id))
        ? ('Marked ' + r.media + ':' + r.id + ' as Greybox Pick.')
        : ('Unmarked ' + r.media + ':' + r.id + '.'));
      renderSearchCards();
    } catch (e) {
      notice('err', (e && e.message) || e);
    }
  }

  /* ================= SETTINGS (hero — existing controls preserved) ================= */
  let settingsHeroCache = null; // last hero read (preserves artwork/trailer cn save)

  function buildHeroForm() {
    const f = $('hero-form');
    if (!f) return;
    f.innerHTML = '';
    f.appendChild(fieldRow('Mode', selectInput('h-mode', [['follow-grid', 'follow-grid (banner follows the grid)'], ['custom', 'custom (fixed spotlight)'], ['spotlight', 'spotlight (one explicit title)']], 'follow-grid')));
    f.appendChild(fieldRow('Spotlight title media', selectInput('h-heroItem-media', [['movie', 'movie'], ['tv', 'tv']], 'movie')));
    f.appendChild(fieldRow('Spotlight TMDB ID (spotlight mode)', numInput('h-heroItem-id', '', '550')));
    f.appendChild(fieldRow('Badge (custom mode label, optional)', textInput('h-badge', '', 'Greybox Spotlight')));
    f.appendChild(fieldRow('Pick (custom mode item index)', numInput('h-pick', '0', '0')));
    const srcHost = el('div', '');
    srcHost.style.cssText = 'display:grid;gap:.7rem';
    srcHost.id = 'h-source';
    const srcLabel = el('div', '');
    srcLabel.appendChild(el('span', 'flabel', 'Rule source (required for custom mode)'));
    srcLabel.appendChild(srcHost);
    f.appendChild(srcLabel);
    renderSourceFields(srcHost, 'h-src', HOME_SOURCE_TYPES, null);
    const row = el('div', '');
    row.style.cssText = 'display:flex;gap:.5rem;flex-wrap:wrap';
    const save = el('button', 'btn btn-primary btn-sm', 'Save hero');
    save.type = 'submit';
    row.appendChild(save);
    const refresh = el('button', 'btn btn-secondary btn-sm', 'Reload');
    refresh.type = 'button';
    refresh.addEventListener('click', loadHero);
    row.appendChild(refresh);
    f.appendChild(row);
    f.addEventListener('submit', (e) => { e.preventDefault(); saveHero(); });
  }

  async function loadHero() {
    try {
      const hero = await api(API.hero);
      settingsHeroCache = (hero && typeof hero === 'object') ? hero : null;
      if (!$('h-mode')) return;
      $('h-mode').value = hero && hero.mode === 'custom' ? 'custom' : (hero && hero.mode === 'spotlight' ? 'spotlight' : 'follow-grid');
      $('h-heroItem-media').value = (hero && hero.heroItem && hero.heroItem.media) || 'movie';
      $('h-heroItem-id').value = (hero && hero.heroItem && hero.heroItem.id != null) ? hero.heroItem.id : '';
      $('h-badge').value = (hero && hero.badge) || '';
      $('h-pick').value = (hero && hero.pick != null) ? hero.pick : 0;
      renderSourceFields($('h-source'), 'h-src', HOME_SOURCE_TYPES, hero && hero.source);
    } catch (e) {
      notice('err', 'Hero settings failed to load: ' + (e.message || e));
    }
  }

  function readHeroForm() {
    const modeRaw = $('h-mode').value;
    const mode = modeRaw === 'custom' ? 'custom' : (modeRaw === 'spotlight' ? 'spotlight' : 'follow-grid');
    const badge = $('h-badge').value.trim();
    if (badge.length > 120) throw { message: 'Badge must be at most 120 characters.' };
    const pick = parseInt($('h-pick').value, 10);
    if (!Number.isInteger(pick) || pick < 0 || pick > 100) throw { message: 'Pick must be 0–100.' };
    const himRaw = $('h-heroItem-media') ? $('h-heroItem-media').value : 'movie';
    const him = himRaw === 'tv' ? 'tv' : 'movie';
    const hii = $('h-heroItem-id') ? parseInt($('h-heroItem-id').value, 10) : NaN;
    let heroItem = null;
    if (mode === 'spotlight') {
      if (!Number.isInteger(hii) || hii < 1 || hii > 2147483647) throw { message: 'Spotlight hero needs a TMDB ID (positive integer).' };
      heroItem = { media: him, id: hii };
    } else if (Number.isInteger(hii) && hii >= 1 && hii <= 2147483647) {
      heroItem = { media: him, id: hii };
    }
    const body = { mode, badge, pick, heroItem };
    if (mode === 'custom') {
      body.source = readSource('h-src');
      const srcErr = vSource(body.source, HOME_SOURCE_TYPES);
      if (srcErr) throw { message: srcErr };
    }
    // This form does not edit artwork/trailer (see Heroes) — carry the last
    // loaded values through so saving here never wipes them.
    const cached = (settingsHeroCache && typeof settingsHeroCache === 'object') ? settingsHeroCache : {};
    if (cached.artwork && typeof cached.artwork === 'object') body.artwork = cached.artwork;
    if (cached.trailer && typeof cached.trailer === 'object') body.trailer = cached.trailer;
    return body;
  }

  async function saveHero() {
    const form = $('hero-form');
    setFormSaving(form, true);
    try {
      // Read-modify-write on a FRESH read: this form owns mode/badge/pick/
      // heroItem/source only — artwork/trailer belong to the Heroes editor,
      // so carry the current server values through instead of a load-time
      // snapshot that could wipe a newer Heroes save.
      const fresh = await api(API.hero);
      settingsHeroCache = (fresh && typeof fresh === 'object') ? fresh : null;
      const body = readHeroForm();
      const saved = await api(API.hero, { method: 'PUT', body });
      const readBack = await api(API.hero);
      settingsHeroCache = (readBack && typeof readBack === 'object') ? readBack : null;
      $('h-badge').value = settingsHeroCache.badge || '';
      $('h-pick').value = settingsHeroCache.pick != null ? settingsHeroCache.pick : 0;
      if ($('h-heroItem-media')) $('h-heroItem-media').value = (settingsHeroCache.heroItem && settingsHeroCache.heroItem.media) || 'movie';
      if ($('h-heroItem-id')) $('h-heroItem-id').value = (settingsHeroCache.heroItem && settingsHeroCache.heroItem.id != null) ? settingsHeroCache.heroItem.id : '';
      if (stableHeroJson(saved) !== stableHeroJson(readBack)) {
        notice('err', 'Hero settings saved, but a fresh read-back differs — review before continuing.');
      } else {
        notice('ok', 'Hero settings saved.');
      }
      // Same row feeds the Home strip, Heroes and Dashboard summaries.
      await loadHomeHero();
      if (currentView === 'dashboard') loadDashboard();
      if (currentView === 'heroes') loadHeroes();
    } catch (e) {
      notice('err', (e.message || e));
    } finally {
      setFormSaving(form, false);
    }
  }

  /* ================= DASHBOARD ================= */
  function dashSkeletonRows(host, n) {
    host.innerHTML = '';
    for (let i = 0; i < (n || 3); i++) {
      const sk = el('div', 'skel');
      sk.style.minHeight = '2.4rem';
      host.appendChild(sk);
    }
  }

  // Scannable config row: NAME / detail / [Open|Configure|action].
  function dashRow(host, name, detail, actionLabel, onAction) {
    const row = el('div', 'cfg-row');
    const main = el('div', 'cfg-main');
    main.appendChild(el('span', 'cfg-name', name));
    main.appendChild(el('span', 'cfg-detail', detail || '—'));
    row.appendChild(main);
    if (onAction) {
      const b = el('button', 'rowbtn', actionLabel || 'Open');
      b.type = 'button';
      b.addEventListener('click', onAction);
      row.appendChild(b);
    }
    host.appendChild(row);
    return row;
  }

  // Dashboard-only icons (static strings, no user data — safe for innerHTML).
  // Same stroke set as the sidebar; kept local so workspace code is untouched.
  const DASH_ICONS = {
    sections: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg>',
    collections: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
    tags: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
    overrides: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
    heroes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/></svg>',
  };

  // Hero status panel: mode + the same runtime summary the config row used.
  // Values come from the live /api/admin/settings/home-hero response.
  function renderDashHero(hero, failed) {
    const host = $('dash-hero');
    if (!host) return;
    host.innerHTML = '';
    if (!hero) {
      host.appendChild(el('p', 'dash-hero-mode', '—'));
      host.appendChild(el('p', 'dash-hero-detail muted text-sm', failed ? 'Hero settings unavailable.' : 'Loading…'));
      return;
    }
    const mode = hero.mode === 'custom' ? 'Custom spotlight' : (hero.mode === 'spotlight' ? 'Spotlight title' : 'Follow-grid');
    host.appendChild(el('p', 'dash-hero-mode', mode));
    host.appendChild(el('p', 'dash-hero-detail muted text-sm', heroSummaryText(hero)));
  }

  // Roadmap mirrors the sidebar Soon entries (single source: #admin-nav).
  // No backend, no hardcoding — regroups automatically if nav changes.
  function renderDashRoadmap() {
    const host = $('dash-roadmap');
    if (!host) return;
    host.innerHTML = '';
    const items = document.querySelectorAll('#admin-nav .nav-item.nav-soon');
    if (!items.length) {
      host.appendChild(el('p', 'muted text-sm', 'No roadmap items — every section is live.'));
      return;
    }
    const groups = {};
    const order = [];
    items.forEach((b) => {
      const g = (b.dataset.group || 'Roadmap').trim() || 'Roadmap';
      const label = (b.dataset.soon || (b.textContent || '').trim()).trim() || 'Coming soon';
      if (!groups[g]) { groups[g] = []; order.push(g); }
      groups[g].push(label);
    });
    order.forEach((g) => {
      const col = el('div', 'roadmap-col');
      col.appendChild(el('p', 'roadmap-group', g));
      groups[g].forEach((label) => {
        const row = el('div', 'roadmap-row');
        row.appendChild(el('span', 'roadmap-label', label));
        row.appendChild(el('span', 'badge badge-soon', 'Soon'));
        col.appendChild(row);
      });
      host.appendChild(col);
    });
  }

  async function loadDashboard() {
    const cards = $('dash-cards');
    const cfg = $('dash-config');
    if (!cards || !cfg) return;
    renderDashRoadmap();
    renderDashHero(null, false);
    cards.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const sk = el('div', 'skel');
      cards.appendChild(sk);
    }
    dashSkeletonRows(cfg, 5);
    const [secRes, colRes, tagRes, ovRes, heroRes] = await Promise.allSettled([
      api(API.homeSections),
      api(API.collections),
      api(API.tags),
      api(API.overrides),
      api(API.hero),
    ]);
    const secs = secRes.status === 'fulfilled' && Array.isArray(secRes.value) ? secRes.value : null;
    const cols = colRes.status === 'fulfilled' && Array.isArray(colRes.value) ? colRes.value : null;
    const tags = tagRes.status === 'fulfilled' && Array.isArray(tagRes.value) ? tagRes.value : null;
    const ovs = ovRes.status === 'fulfilled' && Array.isArray(ovRes.value) ? ovRes.value : null;
    const hero = heroRes.status === 'fulfilled' ? heroRes.value : null;
    if (secs) secCache = secs;
    if (cols) colCache = cols;
    if (tags) tagCache = tags;
    if (ovs) ovCache = ovs;

    const count = (a) => (Array.isArray(a) ? a.length : null);
    const visCount = (a) => (Array.isArray(a) ? a.filter((x) => x && x.visible !== false).length : null);
    const picks = Array.isArray(ovs) ? ovs.filter(isGreyboxPick).length : null;
    const fmt = (n) => (n == null ? '—' : String(n));

    const stats = [
      { label: 'Home Sections', n: fmt(count(secs)), sub: secs ? visCount(secs) + ' visible · ' + (secs.length - visCount(secs)) + ' hidden' : 'Unavailable', view: 'sections' },
      { label: 'Collections', n: fmt(count(cols)), sub: cols ? visCount(cols) + ' visible · ' + (cols.length - visCount(cols)) + ' hidden' : 'Unavailable', view: 'collections' },
      { label: 'Tags', n: fmt(count(tags)), sub: tags ? visCount(tags) + ' visible · ' + tags.reduce((a, t) => a + (t.member_count || 0), 0) + ' titles' : 'Unavailable', view: 'tags' },
      { label: 'Overrides', n: fmt(count(ovs)), sub: ovs ? picks + ' ★ picks' : 'Unavailable', view: 'overrides' },
      { label: 'Hero Mode', n: hero && hero.mode ? hero.mode : '—', sub: hero ? 'pick ' + (hero.pick != null ? hero.pick : 0) + (hero.badge ? ' · ' + hero.badge : '') : 'Unavailable', view: 'heroes' },
    ];
    cards.innerHTML = '';
    stats.forEach((s) => {
      const b = el('button', 'stat-card');
      b.type = 'button';
      b.setAttribute('aria-label', s.label + ': ' + s.n + '. Go to ' + s.label);
      const top = el('span', 'stat-top');
      const ic = document.createElement('span');
      ic.className = 'stat-ic';
      ic.setAttribute('aria-hidden', 'true');
      ic.innerHTML = DASH_ICONS[s.view] || '';
      top.appendChild(ic);
      top.appendChild(el('span', 'stat-label', s.label));
      b.appendChild(top);
      b.appendChild(el('p', 'stat-num', s.n));
      b.appendChild(el('p', 'stat-sub', s.sub));
      b.addEventListener('click', () => showView(s.view));
      cards.appendChild(b);
    });

    cfg.innerHTML = '';
    if (!secs && !cols && !tags && !ovs && !hero) {
      const box = stateBox(cfg, 'error', 'Configuration unavailable', 'The management API could not be reached. Check the connection and retry.');
      const retry = el('button', 'btn btn-secondary btn-sm', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', loadDashboard);
      box.appendChild(retry);
      renderDashHero(null, true);
      return;
    }
    if (secs) {
      if (!secs.length) {
        const row = dashRow(cfg, 'Home', 'No Home sections configured.', '+ Create your first section', () => openSectionEditor(null));
        void row;
      } else {
        const v = visCount(secs);
        dashRow(cfg, 'Home', v + ' active section' + (v === 1 ? '' : 's') + (secs.length - v ? ' · ' + (secs.length - v) + ' hidden' : ''), 'Open', () => showView('sections'));
      }
    }
    if (cols) {
      const v = visCount(cols);
      dashRow(cfg, 'Collections', cols.length ? v + ' published' + (cols.length - v ? ' · ' + (cols.length - v) + ' hidden' : '') : 'None yet', 'Open', () => showView('collections'));
    }
    if (tags) {
      const v = visCount(tags);
      const titles = tags.reduce((a, t) => a + (t.member_count || 0), 0);
      dashRow(cfg, 'Tags', tags.length ? v + ' visible · ' + titles + (titles === 1 ? ' title' : ' titles') : 'None yet', 'Open', () => showView('tags'));
    }
    if (ovs) {
      dashRow(cfg, 'Overrides', ovs.length ? ovs.length + ' configured · ' + picks + ' ★ picks' : 'None yet', 'Open', () => showView('overrides'));
    }
    if (hero) {
      renderDashHero(hero, false);
    } else if (heroRes.status === 'rejected') {
      renderDashHero(null, true);
    } else {
      renderDashHero(null, false);
    }
  }

  /* ---------------- boot ---------------- */
  function bindNav() {
    document.querySelectorAll('#admin-nav .nav-item[data-view]').forEach((b) => {
      // Legacy guard: disabled buttons never fire click events, so a disabled
      // Soon row is a dead control — Soon items are enabled buttons now.
      if (b.disabled) {
        b.addEventListener('click', () => showView('soon'));
        return;
      }
      if (b.dataset.view === 'soon') {
        b.addEventListener('click', () => showView('soon', {
          label: b.dataset.soon || (b.textContent || '').trim() || 'Coming soon',
          group: b.dataset.group || 'Roadmap',
        }));
        return;
      }
      b.addEventListener('click', () => showView(b.dataset.view));
    });
    document.querySelectorAll('[data-goto]').forEach((b) => {
      b.addEventListener('click', () => showView(b.dataset.goto));
    });
    document.querySelectorAll('[data-quick-new]').forEach((b) => {
      b.addEventListener('click', () => {
        const k = b.dataset.quickNew;
        if (k === 'section') openSectionEditor(null);
        else if (k === 'collection') openCollectionEditor(null);
        else if (k === 'tag') openTagEditor(null);
        else if (k === 'override') openOverrideEditor(null);
      });
    });
  }

  function bindToolbar() {
    const secNew = $('sec-new');
    if (secNew) secNew.addEventListener('click', () => openSectionEditor(null));
    const colNew = $('col-new');
    if (colNew) colNew.addEventListener('click', () => openCollectionEditor(null));
    const tagNew = $('tag-new');
    if (tagNew) tagNew.addEventListener('click', () => openTagEditor(null));
    const ovNew = $('ov-new');
    if (ovNew) ovNew.addEventListener('click', () => openOverrideEditor(null));
    const sr = $('sec-refresh');
    if (sr) sr.addEventListener('click', loadSections);
    const cr = $('col-refresh');
    if (cr) cr.addEventListener('click', loadCollections);
    const tr = $('tag-refresh');
    if (tr) tr.addEventListener('click', loadTags);
    const orr = $('ov-refresh');
    if (orr) orr.addEventListener('click', loadOverrides);
    const brNew = $('blocked-new');
    if (brNew) brNew.addEventListener('click', openBlockPicker);
    const br = $('blocked-refresh');
    if (br) br.addEventListener('click', loadBlocked);
    const nvSave = $('nav-save');
    if (nvSave) nvSave.addEventListener('click', saveNavigation);
    const nvDiscard = $('nav-discard');
    if (nvDiscard) nvDiscard.addEventListener('click', discardNavigation);
    const nvReset = $('nav-reset');
    if (nvReset) nvReset.addEventListener('click', resetNavigation);
    const nvRefresh = $('nav-refresh');
    if (nvRefresh) nvRefresh.addEventListener('click', loadNavigation);
    const dpSave = $('dp-save');
    if (dpSave) dpSave.addEventListener('click', saveDetailPages);
    const dpDiscard = $('dp-discard');
    if (dpDiscard) dpDiscard.addEventListener('click', discardDetailPages);
    const dpReset = $('dp-reset');
    if (dpReset) dpReset.addEventListener('click', resetDetailPages);
    const dpRefresh = $('dp-refresh');
    if (dpRefresh) dpRefresh.addEventListener('click', loadDetailPages);
    const pbSave = $('pb-save');
    if (pbSave) pbSave.addEventListener('click', savePlayback);
    const pbDiscard = $('pb-discard');
    if (pbDiscard) pbDiscard.addEventListener('click', discardPlayback);
    const pbReset = $('pb-reset');
    if (pbReset) pbReset.addEventListener('click', resetPlayback);
    const pbRefresh = $('pb-refresh');
    if (pbRefresh) pbRefresh.addEventListener('click', loadPlayback);
    const dr = $('dash-refresh');
    if (dr) dr.addEventListener('click', loadDashboard);
    const hr = $('heroes-refresh');
    if (hr) hr.addEventListener('click', loadHeroes);
    const ss = $('sec-search');
    if (ss) ss.addEventListener('input', renderSections);
    const sf = $('sec-filter');
    if (sf) sf.addEventListener('change', renderSections);
    const ssrc = $('sec-source');
    if (ssrc) {
      // Source-type options mirror the supported HOME_SOURCE_TYPES exactly,
      // so the filter can never offer a type the editor cannot produce.
      HOME_SOURCE_TYPES.forEach((t) => {
        const o = document.createElement('option');
        o.value = t; o.textContent = t;
        ssrc.appendChild(o);
      });
      ssrc.addEventListener('change', renderSections);
    }
    const cs = $('col-search');
    if (cs) cs.addEventListener('input', renderCollections);
    const cf = $('col-filter');
    if (cf) cf.addEventListener('change', renderCollections);
    const ct = $('col-type');
    if (ct) {
      // Source-type options mirror the supported COL_SOURCE_TYPES exactly,
      // so the filter can never offer a type the editor cannot produce.
      COL_SOURCE_TYPES.forEach((t) => {
        const o = document.createElement('option');
        o.value = t; o.textContent = t;
        ct.appendChild(o);
      });
      ct.addEventListener('change', renderCollections);
    }
    const cm = $('col-media');
    if (cm) cm.addEventListener('change', renderCollections);
    const ts = $('tag-search');
    if (ts) ts.addEventListener('input', renderTags);
    const tf = $('tag-filter');
    if (tf) tf.addEventListener('change', renderTags);
    const os = $('ov-search');
    if (os) os.addEventListener('input', renderOverrides);
    const om = $('ov-media');
    if (om) om.addEventListener('change', renderOverrides);
    const op = $('ov-pick');
    if (op) op.addEventListener('change', renderOverrides);
    const bs = $('blocked-search');
    if (bs) bs.addEventListener('input', renderBlocked);
    const bm = $('blocked-media');
    if (bm) bm.addEventListener('change', renderBlocked);
  }

  function bindChrome() {
    // Desktop sidebar collapse: icon rail ⇄ full labels. Purely presentational
    // (no navigation, auth, or data impact); hidden on mobile via CSS.
    const sc = $('side-collapse');
    if (sc) sc.addEventListener('click', () => {
      const app = document.querySelector('.admin-shell');
      if (!app) return;
      const collapsed = app.classList.toggle('is-collapsed');
      sc.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      sc.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
      sc.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    });
    const t = $('nav-toggle');
    if (t) t.addEventListener('click', () => {
      const s = $('admin-sidebar');
      if (s && s.classList.contains('open')) closeMobileNav();
      else openMobileNav();
    });
    const scrim = $('nav-scrim');
    if (scrim) scrim.addEventListener('click', closeMobileNav);
    const dc = $('drawer-close');
    if (dc) dc.addEventListener('click', closeDrawer);
    const ds = $('drawer-scrim');
    if (ds) ds.addEventListener('click', closeDrawer);
    const discard = $('drawer-discard');
    if (discard) discard.addEventListener('click', closeDrawer);
    const save = $('drawer-save');
    if (save) save.addEventListener('click', () => {
      try {
        if (drawerForm && drawerForm.requestSubmit) drawerForm.requestSubmit();
        else if (drawerForm) drawerForm.dispatchEvent(new Event('submit', { cancelable: true }));
      } catch { /* noop */ }
    });
    const cc = $('confirm-cancel');
    if (cc) cc.addEventListener('click', () => { if (confirmState && confirmState.close) confirmState.close(false); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (confirmState && confirmState.close) { confirmState.close(false); return; }
      if (isDrawerOpen()) { closeDrawer(); return; }
      closeMobileNav();
    });
  }

  function connect() {
    const pw = $('admin-token');
    const token = pw ? pw.value.trim() : '';
    const errBox = $('admin-connect-error');
    if (errBox) errBox.classList.add('hidden');
    if (!token) {
      if (errBox) { errBox.textContent = 'Paste the admin token first.'; errBox.classList.remove('hidden'); }
      return;
    }
    ADMIN_TOKEN = token; // memory only — never persisted (see file header)
    if (pw) pw.value = '';
    api(API.collections).then(
      () => {
        setAuthed(true);
        showView('dashboard');
        notice('ok', 'Connected. Token lives in this tab’s memory only.');
      },
      (e) => {
        ADMIN_TOKEN = null;
        if (errBox) { errBox.textContent = e.message || e; errBox.classList.remove('hidden'); }
      },
    );
  }

  function disconnect() {
    ADMIN_TOKEN = null;
    setAuthed(false);
    const n = $('admin-notice');
    if (n) n.classList.add('hidden');
  }

  buildSearchPanel();
  buildHeroForm();
  bindNav();
  bindToolbar();
  bindChrome();
  const cbtn = $('admin-connect-btn');
  if (cbtn) cbtn.addEventListener('click', connect);
  const pw = $('admin-token');
  if (pw) pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
  const dc = $('admin-disconnect');
  if (dc) dc.addEventListener('click', disconnect);
  const td = $('top-disconnect');
  if (td) td.addEventListener('click', disconnect);

  // Headless/test hook: pure helpers only (no DOM, no fetch, no token).
  try {
    window.GreyboxAdminTest = window.GreyboxAdminTest || {};
    Object.assign(window.GreyboxAdminTest, {
      esc, vSlug, vReqStr: vReqStr, vInt, vTmdbId, vSource,
      parseEntryLines, parseMetaText, summarizeSource, heroSummaryText,
      heroResolvedIdentity,
      parseYoutubeKey, heroPresentationOf, describeTrailer, describeArtwork,
      fillSectionForm, readSectionForm,
      fillCollectionForm, readCollectionForm,
      collectionScopeLabel, collectionTargetsMedia, colHeroSummary,
      stableCollectionJson, refreshCollectionPreview,
      fillOverrideForm, readOverrideForm, readHeroForm,
      ovDisplayLabel, ovEffective, stableOverrideJson, ovRowHasFields,
      blockedKey, isBlockedCached, blockedDisplayLabel, filteredBlocked,
      openBlockPicker, openBlockConfirm, readBlockedRow,
      navDefaults, navValidateDraft, navStableJson, navRouteLabel,
      normalizeNavServer, loadNavigation, renderNavigation, navIsDirty,
      NAV_LABEL_MAX,
      DP_GROUPS, dpDefaults, dpValidateDraft, dpStableJson,
      normalizeDpServer, loadDetailPages, renderDetailPages, dpIsDirty,
      PB_MODES, pbDefaults, pbValidateDraft, pbStableJson,
      normalizePbServer, loadPlayback, renderPlayback, pbIsDirty,
      slugifyTag, tagCounts, stableTagJson, tagMemberKey,
      fetchGenres, genreName, GENRE_CACHE,
      PICK_BADGE, isGreyboxPick, validPickTarget,
      markGreyboxPick, unmarkGreyboxPick, toggleGreyboxPick,
      EDITOR_PICKS_SLUG, detailUrlFor, tmdbPosterUrl,
      normalizeTmdbSearchResults, normalizeEpItems, isInEditorPicks,
      withAddedToEditorPicks, withRemovedFromEditorPicks, tmdbSearchFetch,
      showView, showTab,
      HOME_SOURCE_TYPES, COL_SOURCE_TYPES, OVERRIDE_FIELDS, SLUG_RE,
      API,
    });
  } catch { /* noop */ }
})();
