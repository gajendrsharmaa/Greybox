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
    overrides: '/api/admin/overrides',
    hero: '/api/admin/settings/home-hero',
    colHeroes: '/api/admin/settings/collection-heroes',
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
      const t = document.createElement('div');
      t.className = 'toast ' + (kind === 'ok' ? 'ok' : 'err');
      t.textContent = String(text == null ? '' : text);
      root.appendChild(t);
      while (root.children.length > 4) root.removeChild(root.firstChild);
      setTimeout(() => { try { if (t.isConnected) t.remove(); } catch { /* noop */ } }, kind === 'ok' ? 5000 : 8000);
    } catch { /* toast must never break flows */ }
  }

  let noticeTimer = 0;
  function notice(kind, text) {
    const n = $('admin-notice');
    if (!n) { toast(kind, text); return; }
    n.classList.remove('hidden');
    n.className = 'notice ' + (kind === 'ok' ? 'ok' : 'err');
    n.textContent = text;
    toast(kind, text);
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
    try { if (drawerPrevFocus && drawerPrevFocus.focus) drawerPrevFocus.focus(); } catch { /* noop */ }
    drawerPrevFocus = null;
  }

  function isDrawerOpen() {
    const d = $('editor-drawer');
    return !!(d && !d.classList.contains('hidden'));
  }

  /* ---------------- navigation / views ---------------- */
  const VIEWS = {
    dashboard: { title: 'Dashboard', sub: 'Overview' },
    sections: { title: 'Home', sub: 'Content' },
    heroes: { title: 'Heroes', sub: 'Content' },
    collections: { title: 'Collections', sub: 'Content' },
    overrides: { title: 'Overrides', sub: 'Content' },
    picks: { title: 'Greybox Picks', sub: 'Content' },
    search: { title: 'TMDB Search', sub: 'Content' },
    settings: { title: 'General Settings', sub: 'System' },
    soon: { title: 'Coming soon', sub: '' },
  };
  let currentView = 'dashboard';

  function showView(name) {
    const key = VIEWS[name] ? name : 'dashboard';
    currentView = key;
    document.querySelectorAll('#admin-nav .nav-item[data-view]').forEach((b) => {
      const on = b.dataset.view === key;
      b.classList.toggle('is-active', on);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    document.querySelectorAll('.admin-view').forEach((p) => p.classList.add('hidden'));
    const panel = $('view-' + key);
    if (panel) panel.classList.remove('hidden');
    const meta = VIEWS[key];
    if ($('crumb-section')) $('crumb-section').textContent = meta.title;
    if ($('crumb-sub')) $('crumb-sub').textContent = meta.sub || '';
    closeMobileNav();
    if (!ADMIN_TOKEN) return;
    if (key === 'dashboard') loadDashboard();
    if (key === 'sections') { loadHomeHero(); loadSections(); }
    if (key === 'heroes') loadHeroes();
    if (key === 'collections') loadCollections();
    if (key === 'overrides') loadOverrides();
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
  const HOME_SOURCE_TYPES = ['trending', 'movies', 'tv', 'anime', 'search', 'ids', 'genre', 'collection'];
  const COL_SOURCE_TYPES = ['trending', 'popular', 'top-rated', 'now-playing', 'discover', 'genre', 'year', 'search', 'custom'];
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
    if (document.getElementById(prefix + '-items')) {
      const parsed = parseEntryLines(v(prefix + '-items'));
      if (!parsed.ok) throw { message: parsed.error };
      src.items = parsed.items;
    }
    return src;
  }

  /* ================= HOME HERO strip (summary only — editing stays in General Settings) ================= */
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
      if (hero.heroItem) bits.push('pinned ' + hero.heroItem.media + ':' + hero.heroItem.id);
    } else {
      bits.push('banner follows the grid');
    }
    const pres = heroPresentationOf(hero);
    if (pres.trailer.source === 'off') bits.push('trailer off');
    else if (pres.trailer.source === 'custom') bits.push('trailer ' + (pres.trailer.key || 'custom'));
    else if (pres.trailer.activation !== 'delayed' || pres.trailer.delaySec !== 7) {
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

  function collectionEditorNode(item) {
    const f = document.createElement('form');
    f.id = 'col-form';
    f.autocomplete = 'off';
    f.style.cssText = 'display:grid;gap:.8rem';
    f.appendChild(fieldRow('Slug (lowercase letters/numbers/hyphens; set once)', textInput('c-slug', item ? item.slug : '', 'gothic-horror')));
    f.appendChild(fieldRow('Title', textInput('c-title', item ? item.title || '' : '', 'Gothic Horror')));
    f.appendChild(fieldRow('Description (optional)', textInput('c-desc', item ? item.description || '' : '', '')));
    f.appendChild(fieldRow('Cover URL (optional, https://…)', textInput('c-cover', item ? item.cover || '' : '', 'https://…')));
    f.appendChild(checkInput('c-visible', item ? item.visible !== false : true, 'Visible (hidden collections 404 everywhere)'));
    f.appendChild(fieldRow('Limit (1–60)', numInput('c-limit', item && item.limit != null ? item.limit : 20, '20')));
    f.appendChild(fieldRow('Sort order (optional, blank = keep/append)', numInput('c-sort', '', '')));
    const srcHost = el('div', '');
    srcHost.style.cssText = 'display:grid;gap:.7rem';
    srcHost.id = 'c-source';
    const srcLabel = el('div', '');
    srcLabel.appendChild(el('span', 'flabel', 'Rule source'));
    srcLabel.appendChild(srcHost);
    f.appendChild(srcLabel);
    renderSourceFields(srcHost, 'c-src', COL_SOURCE_TYPES, item ? item.source : null);
    const lines = (arr) => (Array.isArray(arr) ? arr.map((it) => (it && typeof it === 'object' ? (it.media ? it.media + ':' + it.id : it.id) : it)).join('\n') : '');
    f.appendChild(fieldRow('Pin (optional, one per line: media:id)', areaInput('c-pin', item ? lines(item.pin) : '', 'movie:550', 3)));
    f.appendChild(fieldRow('Exclude (optional, one per line: id or media:id)', areaInput('c-exclude', item ? lines(item.exclude) : '', '123', 3)));
    f.appendChild(fieldRow('Meta JSON (optional, e.g. {"curator":"Greybox"})', areaInput('c-meta', item && item.meta ? JSON.stringify(item.meta) : '', '{"curator":"Greybox"}', 2)));
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
    return colCache.filter((c) => {
      if (f === 'visible' && c.visible === false) return false;
      if (f === 'hidden' && c.visible !== false) return false;
      if (!q) return true;
      const hay = (c.slug + ' ' + (c.title || '') + ' ' + (c.description || '') + ' ' + summarizeSource(c.source)).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  async function loadCollections() {
    const host = $('col-list');
    if (!host) return;
    stateBox(host, 'loading', 'Loading collections…');
    try {
      const list = await api(API.collections);
      colCache = Array.isArray(list) ? list : [];
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
      stateBox(host, 'empty', 'No matches', 'Try a different search or status filter.');
      return;
    }
    list.forEach((c) => {
      const idx = colCache.indexOf(c);
      const card = el('div', 'data-row');
      const head = el('div', 'row-top');
      head.appendChild(el('span', 'row-title', c.title || c.slug));
      head.appendChild(statusBadge(c));
      head.appendChild(el('span', 'row-mono muted', '#' + (idx + 1) + ' · /collection/' + c.slug));
      card.appendChild(head);
      card.appendChild(el('p', 'row-meta', summarizeSource(c.source) + (c.description ? ' — ' + c.description : '')));
      const links = el('div', '');
      links.style.marginTop = '.35rem';
      const a = el('a', 'row-link', 'Open public page ↗');
      a.href = '/collection/' + c.slug;
      a.target = '_blank';
      a.rel = 'noopener';
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
        ['↑ Up', '', () => moveCollection(colCache, idx, -1), 'Move up'],
        ['↓ Down', '', () => moveCollection(colCache, idx, 1), 'Move down'],
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
      if (colEditing) {
        await api(API.collections + '/' + encodeURIComponent(colEditing), { method: 'PUT', body });
        notice('ok', 'Collection updated.');
      } else {
        await api(API.collections, { method: 'POST', body });
        notice('ok', 'Collection created.');
      }
      colEditing = null;
      closeDrawer();
      await loadCollections();
      if (currentView === 'dashboard') loadDashboard();
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
    const ok = await confirmDialog({ title: 'Delete collection?', message: 'Delete collection "' + c.slug + '"? This cannot be undone.', okLabel: 'Delete' });
    if (!ok) return;
    try {
      await api(API.collections + '/' + encodeURIComponent(c.slug), { method: 'DELETE' });
      if (colEditing === c.slug) colEditing = null;
      notice('ok', 'Collection deleted.');
      await loadCollections();
      if (currentView === 'dashboard') loadDashboard();
    } catch (e) {
      notice('err', e.message || e);
    }
  }

  /* ================= OVERRIDES ================= */
  let ovEditing = null; // { media, id } being edited, or null

  function overrideEditorNode(item) {
    const f = document.createElement('form');
    f.id = 'ov-form';
    f.autocomplete = 'off';
    f.style.cssText = 'display:grid;gap:.8rem';
    f.appendChild(fieldRow('Media', selectInput('o-media', [['movie', 'movie'], ['tv', 'tv']], item ? item.media : 'movie')));
    f.appendChild(fieldRow('TMDB ID', numInput('o-id', item ? item.tmdb_id : '', '550')));
    for (const k of OVERRIDE_FIELDS) {
      if (k === 'featured') {
        f.appendChild(checkInput('o-featured', !!(item && item[k]), 'featured'));
      } else if (k === 'vote_average') {
        f.appendChild(fieldRow('vote_average (number)', numInput('o-vote_average', item && item[k] != null ? item[k] : '', '8.5')));
      } else if (k === 'overview' || k === 'description') {
        f.appendChild(fieldRow(k + ' (optional)', areaInput('o-' + k, item && item[k] != null ? item[k] : '', '', 2)));
      } else {
        f.appendChild(fieldRow(k + ' (optional)', textInput('o-' + k, item && item[k] != null ? item[k] : '', '')));
      }
    }
    f.appendChild(el('p', 'muted text-sm', 'Only filled fields are stored — clearing a field removes that override. Editing replaces all fields. Tip: use “Fill Greybox Pick” for featured + badge without typing them.'));
    const row = el('div', '');
    row.style.cssText = 'display:flex;gap:.5rem;flex-wrap:wrap';
    const pickFill = el('button', 'btn btn-secondary btn-sm', '★ Fill Greybox Pick');
    pickFill.type = 'button';
    pickFill.title = 'Set featured + custom_badge without typing them';
    pickFill.addEventListener('click', () => {
      const feat = document.getElementById('o-featured');
      const badge = document.getElementById('o-custom_badge');
      if (feat) feat.checked = true;
      if (badge) badge.value = PICK_BADGE;
      setDrawerDirty(true);
    });
    const save = el('button', 'btn btn-primary btn-sm', item ? 'Save Changes' : 'Create override');
    save.type = 'submit';
    const cancel = el('button', 'btn btn-ghost btn-sm', 'Discard');
    cancel.type = 'button';
    cancel.addEventListener('click', closeDrawer);
    row.appendChild(save);
    row.appendChild(pickFill);
    row.appendChild(cancel);
    f.appendChild(row);
    f.addEventListener('submit', (e) => { e.preventDefault(); saveOverride(); });
    return f;
  }

  function openOverrideEditor(item) {
    ovEditing = item ? { media: item.media, id: item.tmdb_id } : null;
    const node = overrideEditorNode(item);
    openDrawer({
      kicker: 'Overrides',
      title: item ? 'Edit override' : 'New override',
      sub: item ? item.media + ':' + item.tmdb_id + ' — TMDB stays the fallback for everything else.' : 'TMDB stays the fallback for everything else.',
      node,
      form: node,
    });
    const mEl = $('o-media');
    const idEl = $('o-id');
    if (mEl && item) mEl.disabled = true;
    if (idEl && item) idEl.disabled = true;
  }

  function buildOverrideForm() { /* built on demand in the drawer */ }
  function fillOverrideForm(item) {
    if (!ADMIN_TOKEN || !$('admin-app') || $('admin-app').classList.contains('hidden')) {
      ovEditing = item ? { media: item.media, id: item.tmdb_id } : null;
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

  function filteredOverrides() {
    const list = Array.isArray(ovCache) ? ovCache : [];
    const q = String(($('ov-search') && $('ov-search').value) || '').trim().toLowerCase();
    const f = ($('ov-filter') && $('ov-filter').value) || 'all';
    return list.filter((o) => {
      if (f === 'picks' && !isGreyboxPick(o)) return false;
      if (f === 'movie' && o.media !== 'movie') return false;
      if (f === 'tv' && o.media !== 'tv') return false;
      if (!q) return true;
      const keys = Object.keys(o).filter((k) => k !== 'media' && k !== 'tmdb_id');
      const hay = (o.media + ':' + o.tmdb_id + ' ' + keys.join(' ') + ' ' + keys.map((k) => String(o[k])).join(' ')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
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
    host.innerHTML = '';
    if (!all.length) {
      const box = stateBox(host, 'empty', 'No overrides yet', 'Create one — TMDB stays the fallback for everything else.');
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
      const card = el('div', 'data-row');
      const head = el('div', 'row-top');
      head.appendChild(el('span', 'row-title row-mono', o.media + ':' + o.tmdb_id));
      if (isGreyboxPick(o)) head.appendChild(el('span', 'badge badge-pick', '★ Greybox Pick'));
      head.appendChild(el('span', 'muted text-sm', keys.join(', ') || '(no fields)'));
      card.appendChild(head);
      const marked = isGreyboxPick(o);
      card.appendChild(rowButtons([
        ['Edit', 'go', () => openOverrideEditor(o)],
        [marked ? '☆ Unmark Pick' : '★ Mark Pick', '', () => togglePickFromOverrides(o), marked ? 'Remove Greybox Pick badge' : 'Mark as Greybox Pick'],
        ['Delete', 'danger', () => deleteOverride(o), 'Delete override'],
      ]));
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
      if (ovEditing) {
        await api(API.overrides + '/' + media + '/' + tmdb_id, { method: 'PUT', body: { media, tmdb_id, ...fields } });
        notice('ok', 'Override updated.');
      } else {
        await api(API.overrides, { method: 'POST', body: { media, tmdb_id, ...fields } });
        notice('ok', 'Override created.');
      }
      ovEditing = null;
      closeDrawer();
      await loadOverrides();
      if (currentView === 'dashboard' || currentView === 'picks') loadDashboard();
    } catch (e) {
      notice('err', (e.message || e));
    } finally {
      setFormSaving(form, false);
    }
  }

  async function deleteOverride(o) {
    const ok = await confirmDialog({ title: 'Delete override?', message: 'Delete override ' + o.media + ':' + o.tmdb_id + '? TMDB data becomes the fallback again.', okLabel: 'Delete' });
    if (!ok) return;
    try {
      await api(API.overrides + '/' + o.media + '/' + o.tmdb_id, { method: 'DELETE' });
      if (ovEditing && ovEditing.media === o.media && ovEditing.id === o.tmdb_id) ovEditing = null;
      notice('ok', 'Override deleted.');
      await loadOverrides();
      if (currentView === 'picks') loadPicks();
      if (currentView === 'dashboard') loadDashboard();
    } catch (e) {
      notice('err', e.message || e);
    }
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
    if (!Number.isInteger(delay) || delay < 0) delay = 7;
    if (delay > 120) delay = 120;
    return {
      artwork: {
        backdrop: a.backdrop === 'custom' ? 'custom' : 'auto',
        backdropUrl: typeof a.backdropUrl === 'string' ? a.backdropUrl.trim() : '',
        logo: a.logo === 'tmdb' ? 'tmdb' : (a.logo === 'custom' ? 'custom' : 'text'),
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
    if (hero.mode === 'spotlight' && hero.heroItem) lines.push('Title: ' + hero.heroItem.media + ':' + hero.heroItem.id);
    else if (hero.mode === 'custom') lines.push('Source: ' + summarizeSource(hero.source) + ' · pick ' + (hero.pick != null ? hero.pick : 0));
    else lines.push('Follows the homepage grid');
    if (hero.badge) lines.push('Badge: ' + hero.badge);
    lines.push(describeArtwork(pres));
    lines.push(describeTrailer(pres));
    lines.forEach((ln) => card.appendChild(el('p', 'row-meta', ln)));
    card.appendChild(rowButtons([
      ['Edit home hero', 'go', () => openHomeHeroEditor(hero), 'Edit home hero content, artwork and trailer'],
      ['Open homepage ↗', '', () => { try { window.open('/', '_blank', 'noopener'); } catch { /* noop */ } }, 'Verify on the public site'],
    ]));
    host.appendChild(card);
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
        ['Configure', custom ? 'go' : '', () => openCollectionHeroEditor(c, custom ? entry : null), 'Configure hero for /collection/' + c.slug],
        ['Open ↗', '', () => { try { window.open('/collection/' + c.slug, '_blank', 'noopener'); } catch { /* noop */ } }, 'Verify on the public site'],
      ]));
      host.appendChild(card);
    });
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
    wrap.appendChild(fieldRow('Title / logo', selectInput(prefix + '-logo', [['text', 'Text title (fallback)'], ['tmdb', 'TMDB logo (automatic)'], ['custom', 'Custom logo URL']], a.logo === 'tmdb' ? 'tmdb' : (a.logo === 'custom' ? 'custom' : 'text'))));
    wrap.appendChild(fieldRow('Custom logo URL (https://…)', textInput(prefix + '-logoUrl', a.logoUrl || '', 'https://…')));
    return wrap;
  }

  function readArtwork(prefix) {
    const v = (id) => { const n = document.getElementById(id); return n ? n.value : ''; };
    const backdrop = v(prefix + '-backdrop') === 'custom' ? 'custom' : 'auto';
    const backdropUrl = String(v(prefix + '-backdropUrl') || '').trim();
    const logoRaw = v(prefix + '-logo');
    const logo = logoRaw === 'tmdb' ? 'tmdb' : (logoRaw === 'custom' ? 'custom' : 'text');
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
    wrap.appendChild(fieldRow('Delay (seconds, 0–120)', numInput(prefix + '-delay', (t.delaySec != null ? t.delaySec : 7), '7')));
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
          if (src && src.type === 'ids' && Array.isArray(src.items) && src.items[0]) {
            return { target: src.items[0], pres: { artwork: readArtwork('hha'), trailer: readTrailer('hht') } };
          }
        } catch (e) { return { target: null, pres: null, note: e && e.message ? e.message : String(e) }; }
        return { target: null, pres: null, note: '' };
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

  async function saveHomeHero() {
    const form = $('hh-form');
    setFormSaving(form, true);
    try {
      const body = readHomeHeroForm();
      await api(API.hero, { method: 'PUT', body });
      notice('ok', 'Home hero saved.');
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
  let searchState = { query: '', results: [], epItems: null }; // epItems null = unknown

  function detailUrlFor(media, id) {
    const n = parseInt(id, 10);
    if (!Number.isInteger(n) || n < 1) return '/';
    return media === 'tv' ? '/tv/' + n : '/movie/' + n;
  }

  function tmdbPosterUrl(posterPath) {
    if (typeof posterPath !== 'string' || posterPath.indexOf('..') >= 0 || !/^\/[A-Za-z0-9/_\-.]+$/.test(posterPath)) return null;
    return TMDB_IMG + posterPath;
  }

  function normalizeTmdbSearchResults(raw) {
    const list = raw && Array.isArray(raw.results) ? raw.results : [];
    const out = [];
    for (const r of list) {
      if (!r || (r.media_type !== 'movie' && r.media_type !== 'tv')) continue;
      const id = parseInt(r.id, 10);
      if (!Number.isInteger(id) || id < 1 || id > 2147483647) continue;
      const title = String(r.title || r.name || '').trim() || 'Untitled';
      const date = String(r.release_date || r.first_air_date || '');
      const vote = Number(r.vote_average);
      out.push({
        media: r.media_type,
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

  async function tmdbSearchFetch(query) {
    const q = String(query || '').trim();
    if (!q) throw { status: 400, message: 'Type a title first.' };
    if (q.length > 120) throw { status: 400, message: 'Query must be at most 120 characters.' };
    const url = '/api/tmdb/search/multi?language=en-US&page=1&include_adult=false&query=' + encodeURIComponent(q);
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
      openOverrideEditor(row || { media: t.media, tmdb_id: t.id });
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
      const [tmdbRes, epRes, ovRes] = await Promise.allSettled([
        tmdbSearchFetch(q),
        api(API.collections + '/' + EDITOR_PICKS_SLUG),
        api(API.overrides),
      ]);
      if (tmdbRes.status === 'rejected') throw tmdbRes.reason;
      if (ovRes.status === 'fulfilled') ovCache = ovRes.value;
      searchState = {
        query: q,
        results: normalizeTmdbSearchResults(tmdbRes.value),
        epItems: epRes.status === 'fulfilled' && epRes.value && epRes.value.source
          ? normalizeEpItems(epRes.value.source.items)
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
      const body = readHeroForm();
      const saved = await api(API.hero, { method: 'PUT', body });
      settingsHeroCache = (saved && typeof saved === 'object') ? saved : null;
      $('h-badge').value = saved.badge || '';
      $('h-pick').value = saved.pick != null ? saved.pick : 0;
      if ($('h-heroItem-media')) $('h-heroItem-media').value = (saved.heroItem && saved.heroItem.media) || 'movie';
      if ($('h-heroItem-id')) $('h-heroItem-id').value = (saved.heroItem && saved.heroItem.id != null) ? saved.heroItem.id : '';
      notice('ok', 'Hero settings saved.');
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

  async function loadDashboard() {
    const cards = $('dash-cards');
    const cfg = $('dash-config');
    if (!cards || !cfg) return;
    cards.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      const sk = el('div', 'skel');
      cards.appendChild(sk);
    }
    dashSkeletonRows(cfg, 4);
    const [secRes, colRes, ovRes, heroRes] = await Promise.allSettled([
      api(API.homeSections),
      api(API.collections),
      api(API.overrides),
      api(API.hero),
    ]);
    const secs = secRes.status === 'fulfilled' && Array.isArray(secRes.value) ? secRes.value : null;
    const cols = colRes.status === 'fulfilled' && Array.isArray(colRes.value) ? colRes.value : null;
    const ovs = ovRes.status === 'fulfilled' && Array.isArray(ovRes.value) ? ovRes.value : null;
    const hero = heroRes.status === 'fulfilled' ? heroRes.value : null;
    if (secs) secCache = secs;
    if (cols) colCache = cols;
    if (ovs) ovCache = ovs;

    const count = (a) => (Array.isArray(a) ? a.length : null);
    const visCount = (a) => (Array.isArray(a) ? a.filter((x) => x && x.visible !== false).length : null);
    const picks = Array.isArray(ovs) ? ovs.filter(isGreyboxPick).length : null;
    const fmt = (n) => (n == null ? '—' : String(n));

    const stats = [
      { label: 'Home Sections', n: fmt(count(secs)), sub: secs ? visCount(secs) + ' visible · ' + (secs.length - visCount(secs)) + ' hidden' : 'Unavailable', view: 'sections' },
      { label: 'Collections', n: fmt(count(cols)), sub: cols ? visCount(cols) + ' visible · ' + (cols.length - visCount(cols)) + ' hidden' : 'Unavailable', view: 'collections' },
      { label: 'Overrides', n: fmt(count(ovs)), sub: ovs ? picks + ' ★ picks' : 'Unavailable', view: 'overrides' },
      { label: 'Hero Mode', n: hero && hero.mode ? hero.mode : '—', sub: hero ? 'pick ' + (hero.pick != null ? hero.pick : 0) + (hero.badge ? ' · ' + hero.badge : '') : 'Unavailable', view: 'heroes' },
    ];
    cards.innerHTML = '';
    stats.forEach((s) => {
      const b = el('button', 'stat-card');
      b.type = 'button';
      b.setAttribute('aria-label', s.label + ': ' + s.n + '. Go to ' + s.label);
      b.appendChild(el('p', 'stat-num', s.n));
      b.appendChild(el('p', 'stat-label', s.label));
      b.appendChild(el('p', 'stat-sub', s.sub));
      b.addEventListener('click', () => showView(s.view));
      cards.appendChild(b);
    });

    cfg.innerHTML = '';
    if (!secs && !cols && !ovs && !hero) {
      const box = stateBox(cfg, 'error', 'Configuration unavailable', 'The management API could not be reached. Check the connection and retry.');
      const retry = el('button', 'btn btn-secondary btn-sm', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', loadDashboard);
      box.appendChild(retry);
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
    if (ovs) {
      dashRow(cfg, 'Overrides', ovs.length ? ovs.length + ' configured · ' + picks + ' ★ picks' : 'None yet', 'Open', () => showView('overrides'));
    }
    if (hero) {
      dashRow(cfg, 'Hero', heroSummaryText(hero), 'Configure', () => showView('heroes'));
    } else if (heroRes.status === 'rejected') {
      dashRow(cfg, 'Hero', 'Unavailable', 'Configure', () => showView('heroes'));
    }
  }

  /* ---------------- boot ---------------- */
  function bindNav() {
    document.querySelectorAll('#admin-nav .nav-item[data-view]').forEach((b) => {
      if (b.disabled) {
        b.addEventListener('click', () => showView('soon'));
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
        else if (k === 'override') openOverrideEditor(null);
      });
    });
  }

  function bindToolbar() {
    const secNew = $('sec-new');
    if (secNew) secNew.addEventListener('click', () => openSectionEditor(null));
    const colNew = $('col-new');
    if (colNew) colNew.addEventListener('click', () => openCollectionEditor(null));
    const ovNew = $('ov-new');
    if (ovNew) ovNew.addEventListener('click', () => openOverrideEditor(null));
    const sr = $('sec-refresh');
    if (sr) sr.addEventListener('click', loadSections);
    const cr = $('col-refresh');
    if (cr) cr.addEventListener('click', loadCollections);
    const orr = $('ov-refresh');
    if (orr) orr.addEventListener('click', loadOverrides);
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
    const os = $('ov-search');
    if (os) os.addEventListener('input', renderOverrides);
    const of = $('ov-filter');
    if (of) of.addEventListener('change', renderOverrides);
  }

  function bindChrome() {
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
      parseYoutubeKey, heroPresentationOf, describeTrailer, describeArtwork,
      fillSectionForm, readSectionForm,
      fillCollectionForm, readCollectionForm,
      fillOverrideForm, readOverrideForm, readHeroForm,
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
