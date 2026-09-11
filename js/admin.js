/* Greybox Admin Control Panel — vanilla JS, no framework, no router.
 *
 * AUTH MODEL (read carefully): the operator pastes the GREYBOX_ADMIN_TOKEN
 * server secret into the connect screen. It lives ONLY in the `ADMIN_TOKEN`
 * variable below — plain page memory for the lifetime of this tab. It is
 * NEVER written to source code, localStorage, sessionStorage, cookies, D1,
 * the URL, or any API response. Reload / Disconnect forgets it immediately.
 * Every /api/admin/* request carries it as an `Authorization: Bearer` header;
 * a 401/403 at any point drops back to the connect screen. No server-side
 * session store exists (and none is needed: adding one would only create
 * CSRF/session-fixation surface for a single-operator tool).
 *
 * The panel talks ONLY to the protected management API from Step 9 and the
 * public read API for verification links. It never touches D1 directly and
 * contains no SQL. After every mutation it re-reads from the API instead of
 * assuming success.
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

  /* ---------------- status + tabs ---------------- */
  let noticeTimer = 0;
  function notice(kind, text) {
    const n = $('admin-notice');
    if (!n) return;
    n.classList.remove('hidden');
    n.className = 'mt-6 text-sm rounded-xl p-4 ' + (kind === 'ok'
      ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-200'
      : 'bg-red-500/10 border border-red-500/40 text-red-200');
    n.textContent = text;
    if (noticeTimer) clearTimeout(noticeTimer);
    if (kind === 'ok') noticeTimer = setTimeout(() => n.classList.add('hidden'), 6000);
  }

  function showTab(name) {
    document.querySelectorAll('.atab').forEach((b) => {
      const on = b.dataset.atab === name;
      b.classList.toggle('bg-amber-500', on);
      b.classList.toggle('text-black', on);
      b.classList.toggle('font-bold', on);
      b.classList.toggle('bg-white/10', !on);
    });
    document.querySelectorAll('.apanel').forEach((p) => p.classList.add('hidden'));
    const panel = $('apanel-' + name);
    if (panel) panel.classList.remove('hidden');
  }

  function setAuthed(on, msg) {
    $('admin-connect').classList.toggle('hidden', on);
    $('admin-dash').classList.toggle('hidden', !on);
    $('admin-tabs').classList.toggle('hidden', !on);
    $('admin-disconnect').classList.toggle('hidden', !on);
    if (!on) {
      const e = $('admin-connect-error');
      if (msg && e) { e.textContent = msg; e.classList.remove('hidden'); }
      const pw = $('admin-token');
      if (pw) pw.value = '';
    }
  }

  function forceDisconnect(msg) {
    ADMIN_TOKEN = null;
    setAuthed(false, msg);
  }

  /* ---------------- client-side validation (mirrors functions/lib/validate.js) ---------------- */
  const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const HOME_MOVIE_CATS = ['popular', 'top-rated', 'upcoming', 'now-playing'];
  const HOME_TV_CATS = ['popular', 'top-rated', 'on-the-air', 'airing-today'];
  const HOME_SOURCE_TYPES = ['trending', 'movies', 'tv', 'anime', 'search', 'ids', 'genre'];
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
    if ((t === 'genre') && !(parseInt(src.genreId, 10) > 0)) return 'genre needs a genreId';
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
    if (src.category) bits.push(src.category);
    if (src.kind) bits.push(src.kind);
    if (src.media) bits.push(src.media);
    if (src.query) bits.push('“' + src.query + '”');
    if (src.genreId != null) bits.push('genre ' + src.genreId);
    if (src.genre != null) bits.push('genre ' + src.genre);
    if (src.year != null) bits.push(String(src.year));
    if (Array.isArray(src.items)) bits.push(src.items.length + ' ids');
    if (src.sort && src.sort !== 'popularity.desc') bits.push(src.sort);
    return bits.join(' · ');
  }

  /* ---------------- shared DOM builders ---------------- */
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fieldRow(labelText, input) {
    const wrap = el('label', 'block');
    wrap.appendChild(el('span', 'block text-xs text-zinc-400 mb-1', labelText));
    wrap.appendChild(input);
    return wrap;
  }

  function textInput(id, value, placeholder) {
    const i = document.createElement('input');
    i.id = id; i.type = 'text';
    i.value = value == null ? '' : String(value);
    if (placeholder) i.placeholder = placeholder;
    i.className = 'w-full bg-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 ring-amber-500';
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
    t.className = 'w-full bg-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 ring-amber-500 font-mono';
    return t;
  }

  function selectInput(id, options, value) {
    const s = document.createElement('select');
    s.id = id;
    s.className = 'w-full bg-[#23232f] border border-white/20 rounded-lg px-3 py-2 text-sm outline-none cursor-pointer';
    for (const [v, label] of options) {
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      if (v === value) o.selected = true;
      s.appendChild(o);
    }
    return s;
  }

  function checkInput(id, checked, labelText) {
    const wrap = el('label', 'flex items-center gap-2 text-sm text-zinc-300 cursor-pointer');
    const c = document.createElement('input');
    c.id = id; c.type = 'checkbox'; c.checked = !!checked;
    c.className = 'w-4 h-4 accent-amber-500';
    wrap.appendChild(c);
    wrap.appendChild(el('span', '', labelText));
    return wrap;
  }

  function rowButtons(defs) {
    const wrap = el('div', 'flex flex-wrap gap-2 mt-3');
    for (const [label, cls, fn] of defs) {
      const b = el('button', 'text-xs px-3 py-1.5 rounded-lg ' + cls, label);
      b.type = 'button';
      b.onclick = fn;
      wrap.appendChild(b);
    }
    return wrap;
  }

  const BTN = 'bg-white/10 hover:bg-white/20';
  const BTN_GO = 'bg-amber-500 hover:bg-amber-400 text-black font-bold';
  const BTN_DANGER = 'bg-red-600/80 hover:bg-red-600';

  /* ---------------- source sub-form (shared by sections, collections, hero) ---------------- */

  // Renders type-specific inputs for a rule source into `host`. `prefix`
  // namespaces input ids; `allowed` is the type list for this resource.
  function renderSourceFields(host, prefix, allowed, src) {
    host.innerHTML = '';
    const s = src && typeof src === 'object' ? src : {};
    const typeSel = selectInput(prefix + '-type', allowed.map((t) => [t, t]), s.type || allowed[0]);
    host.appendChild(fieldRow('Source type', typeSel));
    const sub = el('div', 'grid gap-3');
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
        sub.appendChild(el('p', 'text-xs text-zinc-500', 'Movies only — no extra options.'));
      } else if (t === 'anime') {
        sub.appendChild(fieldRow('Kind', selectInput(prefix + '-kind', [['series', 'series'], ['movies', 'movies']], val('kind', 'series'))));
      } else if (t === 'search') {
        sub.appendChild(fieldRow('Query', textInput(prefix + '-query', val('query', ''), 'dune')));
      } else if (t === 'ids' || t === 'custom') {
        const lines = Array.isArray(s.items) ? s.items.map((it) => (it && typeof it === 'object' ? it.media + ':' + it.id : it)).join('\n') : '';
        sub.appendChild(fieldRow(t === 'custom' ? 'Items (one per line: media:id or bare movie id)' : 'Items (one per line: media:id)', areaInput(prefix + '-items', lines, 'movie:550\ntv:1399', 4)));
      } else if (t === 'genre') {
        sub.appendChild(fieldRow('Media', selectInput(prefix + '-media', [['movie', 'movie'], ['tv', 'tv']], val('media', 'movie'))));
        sub.appendChild(fieldRow('Genre ID', numInput(prefix + '-genreId', val('genreId', ''), '878')));
        sub.appendChild(fieldRow('Sort', textInput(prefix + '-sort', val('sort', 'popularity.desc'), 'popularity.desc')));
      } else if (t === 'discover') {
        sub.appendChild(fieldRow('Media', selectInput(prefix + '-media', [['movie', 'movie'], ['tv', 'tv']], val('media', 'movie'))));
        sub.appendChild(fieldRow('Genre ID (optional)', numInput(prefix + '-genre', val('genre', ''), '878')));
        sub.appendChild(fieldRow('Year (optional)', numInput(prefix + '-year', val('year', ''), '2024')));
        sub.appendChild(fieldRow('Sort', textInput(prefix + '-sort', val('sort', 'popularity.desc'), 'popularity.desc')));
      } else if (t === 'year') {
        sub.appendChild(fieldRow('Media', selectInput(prefix + '-media', [['movie', 'movie'], ['tv', 'tv']], val('media', 'movie'))));
        sub.appendChild(fieldRow('Year', numInput(prefix + '-year', val('year', ''), '1999')));
        sub.appendChild(fieldRow('Sort', textInput(prefix + '-sort', val('sort', 'popularity.desc'), 'popularity.desc')));
      }
    };
    typeSel.onchange = paint;
    paint();
  }

  // Reads the inputs rendered by renderSourceFields back into a source object.
  // Numbers stay empty-string when blank (server applies defaults); the
  // items textarea is parsed strictly — throws { message } on bad lines.
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
    if (document.getElementById(prefix + '-genreId')) { const n = numOrEmpty(v(prefix + '-genreId')); if (n !== '') src.genreId = n; }
    if (document.getElementById(prefix + '-genre')) { const n = numOrEmpty(v(prefix + '-genre')); if (n !== '') src.genre = n; }
    if (document.getElementById(prefix + '-year')) { const n = numOrEmpty(v(prefix + '-year')); if (n !== '') src.year = n; }
    if (document.getElementById(prefix + '-items')) {
      const parsed = parseEntryLines(v(prefix + '-items'));
      if (!parsed.ok) throw { message: parsed.error };
      src.items = parsed.items;
    }
    return src;
  }

  /* ================= HOME SECTIONS ================= */
  let secEditing = null; // id being edited, or null for create

  function buildSectionForm() {
    const f = $('sec-form');
    f.innerHTML = '';
    f.appendChild(fieldRow('ID (lowercase letters/numbers/hyphens; set once)', textInput('s-id', '', 'editors-picks')));
    f.appendChild(fieldRow('Title', textInput('s-title', '', 'Editor’s Picks')));
    f.appendChild(fieldRow('Description (optional)', textInput('s-desc', '', '')));
    f.appendChild(checkInput('s-visible', true, 'Visible'));
    f.appendChild(fieldRow('Limit (1–24)', numInput('s-limit', '12', '12')));
    f.appendChild(fieldRow('Sort order (optional, blank = keep/append)', numInput('s-sort', '', '')));
    const srcHost = el('div', 'grid gap-3');
    srcHost.id = 's-source';
    f.appendChild(fieldRow('Rule source', srcHost));
    renderSourceFields(srcHost, 's-src', HOME_SOURCE_TYPES, null);
    const row = el('div', 'flex gap-2');
    const save = el('button', BTN_GO + ' px-5 py-2 rounded-lg text-sm', 'Save section');
    save.type = 'submit';
    const cancel = el('button', BTN + ' px-4 py-2 rounded-lg text-sm hidden', 'Cancel');
    cancel.type = 'button';
    cancel.id = 's-cancel';
    cancel.onclick = () => fillSectionForm(null);
    row.appendChild(save);
    row.appendChild(cancel);
    f.appendChild(row);
    f.onsubmit = (e) => { e.preventDefault(); saveSection(); };
  }

  function fillSectionForm(item) {
    secEditing = item ? item.id : null;
    $('sec-form-title').textContent = item ? 'Edit section: ' + item.id : 'New section';
    $('s-id').value = item ? item.id : '';
    $('s-id').disabled = !!item;
    $('s-title').value = item ? item.title || '' : '';
    $('s-desc').value = item ? item.description || '' : '';
    $('s-visible').checked = item ? item.visible !== false : true;
    $('s-limit').value = item && item.limit != null ? item.limit : 12;
    $('s-sort').value = '';
    $('s-cancel').classList.toggle('hidden', !item);
    renderSourceFields($('s-source'), 's-src', HOME_SOURCE_TYPES, item ? item.source : null);
    if (item) $('sec-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
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

  async function loadSections() {
    const host = $('sec-list');
    host.innerHTML = '<div class="inline-loader"><span class="spinner"></span> Loading sections…</div>';
    try {
      const list = await api(API.homeSections);
      host.innerHTML = '';
      if (!list.length) host.appendChild(el('p', 'text-sm text-zinc-500', 'No sections yet. Create one below.'));
      list.forEach((s, i) => {
        const card = el('div', 'bg-white/5 border border-white/10 rounded-2xl p-4');
        const head = el('div', 'flex items-center gap-2 flex-wrap');
        head.appendChild(el('span', 'font-bold', s.title));
        if (s.visible === false) head.appendChild(el('span', 'text-xs bg-zinc-600/60 px-2 py-0.5 rounded', 'hidden'));
        head.appendChild(el('span', 'text-xs text-zinc-500', '#' + (i + 1) + ' · id: ' + s.id + ' · limit ' + (s.limit != null ? s.limit : '?')));
        card.appendChild(head);
        card.appendChild(el('p', 'mt-1 text-xs text-zinc-400', summarizeSource(s.source) + (s.description ? ' — ' + s.description : '')));
        card.appendChild(rowButtons([
          ['Edit', BTN, () => fillSectionForm(s)],
          [s.visible === false ? 'Show' : 'Hide', BTN, () => toggleSection(s)],
          ['Up', BTN, () => moveSection(list, i, -1)],
          ['Down', BTN, () => moveSection(list, i, 1)],
          ['Delete', BTN_DANGER, () => deleteSection(s)],
        ]));
        host.appendChild(card);
      });
    } catch (e) {
      host.innerHTML = '';
      notice('err', 'Sections failed to load: ' + (e.message || e));
    }
  }

  async function saveSection() {
    try {
      const body = readSectionForm();
      if (secEditing) {
        await api(API.homeSections + '/' + encodeURIComponent(secEditing), { method: 'PUT', body });
        notice('ok', 'Section updated.');
      } else {
        await api(API.homeSections, { method: 'POST', body });
        notice('ok', 'Section created.');
      }
      fillSectionForm(null);
      await loadSections();
    } catch (e) {
      notice('err', (e.message || e));
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
      $('sec-list').querySelectorAll('button').forEach((b) => { b.disabled = true; });
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
    if (!confirm('Delete home section "' + s.id + '"? This cannot be undone.')) return;
    try {
      await api(API.homeSections + '/' + encodeURIComponent(s.id), { method: 'DELETE' });
      if (secEditing === s.id) fillSectionForm(null);
      notice('ok', 'Section deleted.');
      await loadSections();
    } catch (e) {
      notice('err', e.message || e);
    }
  }

  /* ================= COLLECTIONS ================= */
  let colEditing = null;

  function buildCollectionForm() {
    const f = $('col-form');
    f.innerHTML = '';
    f.appendChild(fieldRow('Slug (lowercase letters/numbers/hyphens; set once)', textInput('c-slug', '', 'gothic-horror')));
    f.appendChild(fieldRow('Title', textInput('c-title', '', 'Gothic Horror')));
    f.appendChild(fieldRow('Description (optional)', textInput('c-desc', '', '')));
    f.appendChild(fieldRow('Cover URL (optional, https://…)', textInput('c-cover', '', 'https://…')));
    f.appendChild(checkInput('c-visible', true, 'Visible (hidden collections 404 everywhere)'));
    f.appendChild(fieldRow('Limit (1–60)', numInput('c-limit', '20', '20')));
    f.appendChild(fieldRow('Sort order (optional, blank = keep/append)', numInput('c-sort', '', '')));
    const srcHost = el('div', 'grid gap-3');
    srcHost.id = 'c-source';
    f.appendChild(fieldRow('Rule source', srcHost));
    renderSourceFields(srcHost, 'c-src', COL_SOURCE_TYPES, null);
    f.appendChild(fieldRow('Pin (optional, one per line: media:id)', areaInput('c-pin', '', 'movie:550', 3)));
    f.appendChild(fieldRow('Exclude (optional, one per line: id or media:id)', areaInput('c-exclude', '', '123', 3)));
    f.appendChild(fieldRow('Meta JSON (optional, e.g. {"curator":"Greybox"})', areaInput('c-meta', '', '{"curator":"Greybox"}', 2)));
    const row = el('div', 'flex gap-2');
    const save = el('button', BTN_GO + ' px-5 py-2 rounded-lg text-sm', 'Save collection');
    save.type = 'submit';
    const cancel = el('button', BTN + ' px-4 py-2 rounded-lg text-sm hidden', 'Cancel');
    cancel.type = 'button';
    cancel.id = 'c-cancel';
    cancel.onclick = () => fillCollectionForm(null);
    row.appendChild(save);
    row.appendChild(cancel);
    f.appendChild(row);
    f.onsubmit = (e) => { e.preventDefault(); saveCollection(); };
  }

  function fillCollectionForm(item) {
    colEditing = item ? item.slug : null;
    $('col-form-title').textContent = item ? 'Edit collection: ' + item.slug : 'New collection';
    $('c-slug').value = item ? item.slug : '';
    $('c-slug').disabled = !!item;
    $('c-title').value = item ? item.title || '' : '';
    $('c-desc').value = item ? item.description || '' : '';
    $('c-cover').value = item ? item.cover || '' : '';
    $('c-visible').checked = item ? item.visible !== false : true;
    $('c-limit').value = item && item.limit != null ? item.limit : 20;
    $('c-sort').value = '';
    $('c-cancel').classList.toggle('hidden', !item);
    renderSourceFields($('c-source'), 'c-src', COL_SOURCE_TYPES, item ? item.source : null);
    const lines = (arr) => (Array.isArray(arr) ? arr.map((it) => (it && typeof it === 'object' ? (it.media ? it.media + ':' + it.id : it.id) : it)).join('\n') : '');
    $('c-pin').value = item ? lines(item.pin) : '';
    $('c-exclude').value = item ? lines(item.exclude) : '';
    $('c-meta').value = item && item.meta ? JSON.stringify(item.meta) : '';
    if (item) $('col-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
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

  async function loadCollections() {
    const host = $('col-list');
    host.innerHTML = '<div class="inline-loader"><span class="spinner"></span> Loading collections…</div>';
    try {
      const list = await api(API.collections);
      host.innerHTML = '';
      if (!list.length) host.appendChild(el('p', 'text-sm text-zinc-500', 'No collections yet. Create one below.'));
      list.forEach((c, i) => {
        const card = el('div', 'bg-white/5 border border-white/10 rounded-2xl p-4');
        const head = el('div', 'flex items-center gap-2 flex-wrap');
        head.appendChild(el('span', 'font-bold', c.title));
        if (c.visible === false) head.appendChild(el('span', 'text-xs bg-zinc-600/60 px-2 py-0.5 rounded', 'hidden'));
        head.appendChild(el('span', 'text-xs text-zinc-500', '#' + (i + 1) + ' · /collection/' + c.slug));
        card.appendChild(head);
        card.appendChild(el('p', 'mt-1 text-xs text-zinc-400', summarizeSource(c.source) + (c.description ? ' — ' + c.description : '')));
        const links = el('div', 'mt-1 text-xs');
        const a = el('a', 'text-amber-300 hover:text-amber-200 underline', 'Open public page ↗');
        a.href = '/collection/' + c.slug;
        a.target = '_blank';
        a.rel = 'noopener';
        links.appendChild(a);
        card.appendChild(links);
        card.appendChild(rowButtons([
          ['Edit', BTN, () => fillCollectionForm(c)],
          [c.visible === false ? 'Show' : 'Hide', BTN, () => toggleCollection(c)],
          ['Up', BTN, () => moveCollection(list, i, -1)],
          ['Down', BTN, () => moveCollection(list, i, 1)],
          ['Delete', BTN_DANGER, () => deleteCollection(c)],
        ]));
        host.appendChild(card);
      });
    } catch (e) {
      host.innerHTML = '';
      notice('err', 'Collections failed to load: ' + (e.message || e));
    }
  }

  async function saveCollection() {
    try {
      const body = readCollectionForm();
      if (colEditing) {
        await api(API.collections + '/' + encodeURIComponent(colEditing), { method: 'PUT', body });
        notice('ok', 'Collection updated.');
      } else {
        await api(API.collections, { method: 'POST', body });
        notice('ok', 'Collection created.');
      }
      fillCollectionForm(null);
      await loadCollections();
    } catch (e) {
      notice('err', (e.message || e));
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
      $('col-list').querySelectorAll('button').forEach((b) => { b.disabled = true; });
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
    if (!confirm('Delete collection "' + c.slug + '"? This cannot be undone.')) return;
    try {
      await api(API.collections + '/' + encodeURIComponent(c.slug), { method: 'DELETE' });
      if (colEditing === c.slug) fillCollectionForm(null);
      notice('ok', 'Collection deleted.');
      await loadCollections();
    } catch (e) {
      notice('err', e.message || e);
    }
  }

  /* ================= OVERRIDES ================= */
  let ovEditing = null; // { media, id } being edited, or null

  function buildOverrideForm() {
    const f = $('ov-form');
    f.innerHTML = '';
    f.appendChild(fieldRow('Media', selectInput('o-media', [['movie', 'movie'], ['tv', 'tv']], 'movie')));
    f.appendChild(fieldRow('TMDB ID', numInput('o-id', '', '550')));
    for (const k of OVERRIDE_FIELDS) {
      if (k === 'featured') {
        f.appendChild(checkInput('o-featured', false, 'featured'));
      } else if (k === 'vote_average') {
        f.appendChild(fieldRow('vote_average (number)', numInput('o-vote_average', '', '8.5')));
      } else if (k === 'overview' || k === 'description') {
        f.appendChild(fieldRow(k + ' (optional)', areaInput('o-' + k, '', '', 2)));
      } else {
        f.appendChild(fieldRow(k + ' (optional)', textInput('o-' + k, '', '')));
      }
    }
    const hint = el('p', 'text-xs text-zinc-500', 'Only filled fields are stored — clearing a field removes that override. Editing replaces all fields.');
    f.appendChild(hint);
    const row = el('div', 'flex gap-2');
    const save = el('button', BTN_GO + ' px-5 py-2 rounded-lg text-sm', 'Save override');
    save.type = 'submit';
    const cancel = el('button', BTN + ' px-4 py-2 rounded-lg text-sm hidden', 'Cancel');
    cancel.type = 'button';
    cancel.id = 'o-cancel';
    cancel.onclick = () => fillOverrideForm(null);
    row.appendChild(save);
    row.appendChild(cancel);
    f.appendChild(row);
    f.onsubmit = (e) => { e.preventDefault(); saveOverride(); };
  }

  function fillOverrideForm(item) {
    ovEditing = item ? { media: item.media, id: item.tmdb_id } : null;
    $('ov-form-title').textContent = item ? 'Edit override: ' + item.media + ':' + item.tmdb_id : 'New override';
    $('o-media').value = item ? item.media : 'movie';
    $('o-media').disabled = !!item;
    $('o-id').value = item ? item.tmdb_id : '';
    $('o-id').disabled = !!item;
    for (const k of OVERRIDE_FIELDS) {
      const n = document.getElementById('o-' + k);
      if (!n) continue;
      if (k === 'featured') n.checked = !!(item && item[k]);
      else n.value = item && item[k] != null ? String(item[k]) : '';
    }
    $('o-cancel').classList.toggle('hidden', !item);
    if (item) $('ov-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
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

  async function loadOverrides() {
    const host = $('ov-list');
    host.innerHTML = '<div class="inline-loader"><span class="spinner"></span> Loading overrides…</div>';
    try {
      const list = await api(API.overrides);
      host.innerHTML = '';
      if (!list.length) host.appendChild(el('p', 'text-sm text-zinc-500', 'No overrides yet. Create one below — TMDB stays the fallback for everything else.'));
      for (const o of list) {
        const keys = Object.keys(o).filter((k) => k !== 'media' && k !== 'tmdb_id');
        const card = el('div', 'bg-white/5 border border-white/10 rounded-2xl p-4');
        const head = el('div', 'flex items-center gap-2 flex-wrap');
        head.appendChild(el('span', 'font-bold font-mono', o.media + ':' + o.tmdb_id));
        head.appendChild(el('span', 'text-xs text-zinc-500', keys.join(', ') || '(no fields)'));
        card.appendChild(head);
        card.appendChild(rowButtons([
          ['Edit', BTN, () => fillOverrideForm(o)],
          ['Delete', BTN_DANGER, () => deleteOverride(o)],
        ]));
        host.appendChild(card);
      }
    } catch (e) {
      host.innerHTML = '';
      notice('err', 'Overrides failed to load: ' + (e.message || e));
    }
  }

  async function saveOverride() {
    try {
      const { media, tmdb_id, fields } = readOverrideForm();
      if (ovEditing) {
        await api(API.overrides + '/' + media + '/' + tmdb_id, { method: 'PUT', body: { media, tmdb_id, ...fields } });
        notice('ok', 'Override updated.');
      } else {
        await api(API.overrides, { method: 'POST', body: { media, tmdb_id, ...fields } });
        notice('ok', 'Override created.');
      }
      fillOverrideForm(null);
      await loadOverrides();
    } catch (e) {
      notice('err', (e.message || e));
    }
  }

  async function deleteOverride(o) {
    if (!confirm('Delete override ' + o.media + ':' + o.tmdb_id + '? TMDB data becomes the fallback again.')) return;
    try {
      await api(API.overrides + '/' + o.media + '/' + o.tmdb_id, { method: 'DELETE' });
      if (ovEditing && ovEditing.media === o.media && ovEditing.id === o.tmdb_id) fillOverrideForm(null);
      notice('ok', 'Override deleted.');
      await loadOverrides();
    } catch (e) {
      notice('err', e.message || e);
    }
  }

  /* ================= SETTINGS (hero) ================= */
  function buildHeroForm() {
    const f = $('hero-form');
    f.innerHTML = '';
    f.appendChild(fieldRow('Mode', selectInput('h-mode', [['follow-grid', 'follow-grid (banner follows the grid)'], ['custom', 'custom (fixed spotlight)']], 'follow-grid')));
    f.appendChild(fieldRow('Badge (custom mode label, optional)', textInput('h-badge', '', 'Greybox Spotlight')));
    f.appendChild(fieldRow('Pick (custom mode item index)', numInput('h-pick', '0', '0')));
    const srcHost = el('div', 'grid gap-3');
    srcHost.id = 'h-source';
    f.appendChild(fieldRow('Rule source (required for custom mode)', srcHost));
    renderSourceFields(srcHost, 'h-src', HOME_SOURCE_TYPES, null);
    const row = el('div', 'flex gap-2');
    const save = el('button', BTN_GO + ' px-5 py-2 rounded-lg text-sm', 'Save hero');
    save.type = 'submit';
    row.appendChild(save);
    const refresh = el('button', BTN + ' px-4 py-2 rounded-lg text-sm', 'Reload');
    refresh.type = 'button';
    refresh.onclick = () => loadHero();
    row.appendChild(refresh);
    f.appendChild(row);
    f.onsubmit = (e) => { e.preventDefault(); saveHero(); };
  }

  async function loadHero() {
    try {
      const hero = await api(API.hero);
      $('h-mode').value = hero && hero.mode === 'custom' ? 'custom' : 'follow-grid';
      $('h-badge').value = (hero && hero.badge) || '';
      $('h-pick').value = (hero && hero.pick != null) ? hero.pick : 0;
      renderSourceFields($('h-source'), 'h-src', HOME_SOURCE_TYPES, hero && hero.source);
    } catch (e) {
      notice('err', 'Hero settings failed to load: ' + (e.message || e));
    }
  }

  function readHeroForm() {
    const mode = $('h-mode').value;
    const badge = $('h-badge').value.trim();
    if (badge.length > 120) throw { message: 'Badge must be at most 120 characters.' };
    const pick = parseInt($('h-pick').value, 10);
    if (!Number.isInteger(pick) || pick < 0 || pick > 100) throw { message: 'Pick must be 0–100.' };
    const body = { mode, badge, pick };
    if (mode === 'custom') {
      body.source = readSource('h-src');
      const srcErr = vSource(body.source, HOME_SOURCE_TYPES);
      if (srcErr) throw { message: srcErr };
    }
    return body;
  }

  async function saveHero() {
    try {
      const body = readHeroForm();
      const saved = await api(API.hero, { method: 'PUT', body });
      $('h-badge').value = saved.badge || '';
      $('h-pick').value = saved.pick != null ? saved.pick : 0;
      notice('ok', 'Hero settings saved.');
    } catch (e) {
      notice('err', (e.message || e));
    }
  }

  /* ---------------- boot ---------------- */
  function bindTabs() {
    document.querySelectorAll('.atab').forEach((b) => {
      b.onclick = () => {
        showTab(b.dataset.atab);
        if (b.dataset.atab === 'sections') loadSections();
        if (b.dataset.atab === 'collections') loadCollections();
        if (b.dataset.atab === 'overrides') loadOverrides();
        if (b.dataset.atab === 'settings') loadHero();
      };
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
        showTab('sections');
        loadSections();
        notice('ok', 'Connected. Token lives in this tab’s memory only.');
      },
      (e) => {
        ADMIN_TOKEN = null;
        if (errBox) { errBox.textContent = e.message || e; errBox.classList.remove('hidden'); }
      },
    );
  }

  buildSectionForm();
  buildCollectionForm();
  buildOverrideForm();
  buildHeroForm();
  bindTabs();
  const cbtn = $('admin-connect-btn');
  if (cbtn) cbtn.onclick = connect;
  const pw = $('admin-token');
  if (pw) pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
  const dc = $('admin-disconnect');
  if (dc) dc.onclick = () => { ADMIN_TOKEN = null; setAuthed(false); const n = $('admin-notice'); if (n) n.classList.add('hidden'); };

  // Headless/test hook: pure helpers only (no DOM, no fetch, no token).
  try {
    window.GreyboxAdminTest = window.GreyboxAdminTest || {};
    Object.assign(window.GreyboxAdminTest, {
      esc, vSlug, vReqStr: vReqStr, vInt, vTmdbId, vSource,
      parseEntryLines, parseMetaText, summarizeSource,
      fillSectionForm, readSectionForm,
      fillCollectionForm, readCollectionForm,
      fillOverrideForm, readOverrideForm, readHeroForm,
      HOME_SOURCE_TYPES, COL_SOURCE_TYPES, OVERRIDE_FIELDS, SLUG_RE,
      API,
    });
  } catch { /* noop */ }
})();
