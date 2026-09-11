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
    if (t === 'genre') {
      // Collections allow combined Movies + TV (media 'both' + genre object
      // because TMDB movie and TV genre IDs differ). Home/hero stay
      // single-media only (server validateHomeSource rejects 'both').
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

  /* ---------------- TMDB genre lists (via existing server-side proxy) ---------------- */
  // Genre names/IDs always come from TMDB through the same /api/tmdb/*
  // proxy the public site uses (secret stays server-side). Nothing is
  // hardcoded here: movie and TV lists are fetched separately because
  // TMDB IDs differ between the two lists.
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
        // Genre collections: Media (Movies / TV Shows / Movies + TV Shows for
        // collections) + Genre dropdown(s) populated live from TMDB through
        // the existing /api/tmdb proxy (no hardcoded IDs, no token in the
        // browser). TMDB movie and TV genre lists differ, so Movies + TV
        // keeps one ID per list. Single-media keeps the historic genreId
        // shape so existing collections reload unchanged.
        const isCollection = allowed.indexOf('discover') >= 0;
        const mediaOpts = isCollection
          ? [['movie', 'Movies'], ['tv', 'TV Shows'], ['both', 'Movies + TV Shows']]
          : [['movie', 'Movies'], ['tv', 'TV Shows']];
        let curMedia = val('media', 'movie');
        if (curMedia !== 'movie' && curMedia !== 'tv' && curMedia !== 'both') curMedia = 'movie';
        if (!isCollection && curMedia === 'both') curMedia = 'movie';
        const mediaSel = selectInput(prefix + '-media', mediaOpts, curMedia);
        sub.appendChild(fieldRow('Media', mediaSel));
        const genreHost = el('div', 'grid gap-3');
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
            // Preserve a single-media edit when flipping to Movies + TV.
            if (!bothMovieId && s.genreId) bothMovieId = String(s.genreId);
            if (!bothTvId && s.genreId && s.media === 'tv') bothTvId = String(s.genreId);
            const movieWrap = el('div', '');
            const tvWrap = el('div', '');
            movieWrap.appendChild(el('span', 'block text-xs text-zinc-400 mb-1', 'Movie genre (TMDB movie list)'));
            tvWrap.appendChild(el('span', 'block text-xs text-zinc-400 mb-1', 'TV genre (TMDB TV list — IDs differ)'));
            const mLoad = el('p', 'text-xs text-zinc-500', 'Loading movie genres…');
            const tLoad = el('p', 'text-xs text-zinc-500', 'Loading TV genres…');
            movieWrap.appendChild(mLoad);
            tvWrap.appendChild(tLoad);
            genreHost.appendChild(movieWrap);
            genreHost.appendChild(tvWrap);
            genreHost.appendChild(el('p', 'text-xs text-zinc-500', 'Movies fetch /discover/movie, TV fetch /discover/tv, then combine. Movies link to /movie/:id, TV to /tv/:id.'));
            Promise.all([fetchGenres('movie'), fetchGenres('tv')]).then(
              ([movieList, tvList]) => {
                if (myGen !== genreGen) return;
                movieWrap.innerHTML = '';
                tvWrap.innerHTML = '';
                movieWrap.appendChild(el('span', 'block text-xs text-zinc-400 mb-1', 'Movie genre (TMDB movie list)'));
                tvWrap.appendChild(el('span', 'block text-xs text-zinc-400 mb-1', 'TV genre (TMDB TV list — IDs differ)'));
                const mSel = selectInput(prefix + '-genreMovie', movieList.map((g) => [String(g.id), g.name]), bothMovieId || String((movieList[0] && movieList[0].id) || ''));
                const tSel = selectInput(prefix + '-genreTv', tvList.map((g) => [String(g.id), g.name]), bothTvId || String((tvList[0] && tvList[0].id) || ''));
                movieWrap.appendChild(mSel);
                tvWrap.appendChild(tSel);
              },
              () => {
                if (myGen !== genreGen) return;
                movieWrap.innerHTML = '';
                tvWrap.innerHTML = '';
                movieWrap.appendChild(el('span', 'block text-xs text-zinc-400 mb-1', 'Movie genre ID (list unavailable — check backend TMDB setup)'));
                tvWrap.appendChild(el('span', 'block text-xs text-zinc-400 mb-1', 'TV genre ID'));
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
            genreHost.appendChild(el('p', 'text-xs text-zinc-500', 'Loading genres from TMDB…'));
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
      }
    };
    typeSel.onchange = paint;
    paint();
  }

  // Reads the inputs rendered by renderSourceFields back into a source object.
  // Numbers stay empty-string when blank (server applies defaults); the
  // items textarea is parsed strictly — throws { message } on bad lines.
  // Genre Movies + TV (media 'both') reads the two dropdowns into
  // genre { name, movie_id, tv_id }; single-media keeps genreId.
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

  /* ---------------- Greybox Picks (override-based, no new database) ---------------- */
  // A "Greybox Pick" is just an override with featured=true + custom_badge.
  // Collection membership (custom items) and Pick status (overrides) stay
  // separate: toggling a Pick only calls /api/admin/overrides, never the
  // collections API — so unmarking never removes the title from Editor's
  // Picks, and editing a collection never deletes its overrides.
  const PICK_BADGE = 'Greybox Pick';
  let ovCache = null; // last GET /api/admin/overrides list (shared by both tabs)

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

  // Mark via existing endpoints only: POST when no row, PUT (preserving all
  // other override fields) when one exists. Never touches collections.
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

  // Unmark via existing endpoints only: PUT remaining fields when others
  // exist, DELETE when Pick fields were the only ones. Never touches
  // collections, so the title stays in Editor's Picks.
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
      // Pick states come from the existing overrides endpoint (shared cache).
      // A failure here must not break the collections list itself.
      try {
        ovCache = await api(API.overrides);
      } catch (ovErr) {
        if (ovErr && (ovErr.status === 401 || ovErr.status === 403)) throw ovErr;
        ovCache = null;
      }
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
        // Custom collections (e.g. Editor's Picks) list exact titles, so each
        // item gets a one-click Pick toggle using its existing media:id —
        // no manual TMDB ID entry. This only calls the overrides API.
        if (c.source && c.source.type === 'custom' && Array.isArray(c.source.items) && c.source.items.length) {
          const pickWrap = el('div', 'mt-2 flex items-start gap-2 flex-wrap');
          pickWrap.appendChild(el('span', 'text-xs text-zinc-500', 'Greybox Picks:'));
          c.source.items.forEach((it) => {
            const media = it && it.media === 'tv' ? 'tv' : 'movie';
            const id = it && parseInt(it.id, 10);
            if (!Number.isInteger(id) || id < 1) return;
            const known = findCachedOverride(media, id);
            const marked = isGreyboxPick(known);
            const b = el('button', 'text-xs px-2 py-1 rounded-lg ' + (marked ? 'bg-amber-500 text-black font-bold' : BTN),
              (marked ? '★ ' : '☆ ') + media + ':' + id);
            b.type = 'button';
            b.title = marked ? 'Unmark Greybox Pick (keeps it in this collection)' : 'Mark as Greybox Pick';
            b.onclick = async () => {
              b.disabled = true;
              try {
                await toggleGreyboxPick(media, id, findCachedOverride(media, id));
                ovCache = await api(API.overrides);
                notice('ok', marked ? ('Unmarked ' + media + ':' + id + ' (still in collection).') : ('Marked ' + media + ':' + id + ' as Greybox Pick.'));
                await loadCollections();
              } catch (e) {
                b.disabled = false;
                notice('err', (e && e.message) || e);
              }
            };
            pickWrap.appendChild(b);
          });
          if (ovCache === null) {
            pickWrap.appendChild(el('span', 'text-xs text-zinc-500', '(pick states unavailable — overrides failed to load)'));
          }
          card.appendChild(pickWrap);
        }
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
    const hint = el('p', 'text-xs text-zinc-500', 'Only filled fields are stored — clearing a field removes that override. Editing replaces all fields. Tip: use “Fill Greybox Pick” for featured + badge without typing them.');
    f.appendChild(hint);
    const row = el('div', 'flex gap-2 flex-wrap');
    const save = el('button', BTN_GO + ' px-5 py-2 rounded-lg text-sm', 'Save override');
    save.type = 'submit';
    const pickFill = el('button', BTN + ' px-4 py-2 rounded-lg text-sm', '★ Fill Greybox Pick');
    pickFill.type = 'button';
    pickFill.title = 'Set featured + custom_badge without typing them';
    pickFill.onclick = () => {
      const feat = document.getElementById('o-featured');
      const badge = document.getElementById('o-custom_badge');
      if (feat) feat.checked = true;
      if (badge) badge.value = PICK_BADGE;
    };
    row.appendChild(pickFill);
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
      ovCache = list;
      host.innerHTML = '';
      if (!list.length) host.appendChild(el('p', 'text-sm text-zinc-500', 'No overrides yet. Create one below — TMDB stays the fallback for everything else.'));
      for (const o of list) {
        const keys = Object.keys(o).filter((k) => k !== 'media' && k !== 'tmdb_id');
        const card = el('div', 'bg-white/5 border border-white/10 rounded-2xl p-4');
        const head = el('div', 'flex items-center gap-2 flex-wrap');
        head.appendChild(el('span', 'font-bold font-mono', o.media + ':' + o.tmdb_id));
        if (isGreyboxPick(o)) head.appendChild(el('span', 'text-xs bg-amber-500 text-black font-bold px-2 py-0.5 rounded', '★ Greybox Pick'));
        head.appendChild(el('span', 'text-xs text-zinc-500', keys.join(', ') || '(no fields)'));
        card.appendChild(head);
        const marked = isGreyboxPick(o);
        card.appendChild(rowButtons([
          ['Edit', BTN, () => fillOverrideForm(o)],
          [marked ? '☆ Unmark Pick' : '★ Mark Pick', BTN, () => togglePickFromOverrides(o)],
          ['Delete', BTN_DANGER, () => deleteOverride(o)],
        ]));
        host.appendChild(card);
      }
    } catch (e) {
      host.innerHTML = '';
      notice('err', 'Overrides failed to load: ' + (e.message || e));
    }
  }

  async function togglePickFromOverrides(o) {
    try {
      await toggleGreyboxPick(o.media, o.tmdb_id, o);
      notice('ok', isGreyboxPick(o)
        ? ('Unmarked ' + o.media + ':' + o.tmdb_id + ' (other override fields kept).')
        : ('Marked ' + o.media + ':' + o.tmdb_id + ' as Greybox Pick.'));
      await loadOverrides();
    } catch (e) {
      notice('err', (e && e.message) || e);
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
      notice('err', (e.message || e));
    }
  }

  /* ================= TMDB SEARCH (admin helper, existing systems only) ================= */
  // Title search for the operator: queries TMDB through the existing public
  // /api/tmdb proxy (no token in the browser — plain fetch, no Authorization
  // header). Every action reuses an existing system: public detail routing,
  // the collections API (Editor's Picks membership), the overrides API and
  // the Greybox Pick helpers above. No new database, API, or auth.
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

  // TMDB search/multi payload in, admin-ready rows out. Drops people and
  // anything without a usable id; preserves media_type exactly.
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

  // Pure Editor's Picks item helpers (same { media, id } shape as custom sources).
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

  // No admin token here on purpose: /api/tmdb is the public proxy and needs
  // none. Only safe params are sent (the proxy allowlists path + params).
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
      showTab('overrides');
      fillOverrideForm(row || { media: t.media, tmdb_id: t.id });
    };
    if (known) { apply(known); return Promise.resolve(); }
    return readOverrideRow(t.media, t.id).then(apply, (e) => { notice('err', (e && e.message) || e); });
  }

  function buildSearchPanel() {
    const f = $('tmdb-search-form');
    if (!f) return;
    f.innerHTML = '';
    f.appendChild(fieldRow('Title', textInput('tmdb-search-q', '', 'Fight Club')));
    const hint = el('p', 'text-xs text-zinc-500', 'Searches TMDB through the existing server-side proxy (no key in the browser). Movies + TV only — people are hidden.');
    f.appendChild(hint);
    const row = el('div', 'flex gap-2');
    const go = el('button', BTN_GO + ' px-5 py-2 rounded-lg text-sm', 'Search');
    go.type = 'submit';
    row.appendChild(go);
    f.appendChild(row);
    f.onsubmit = (e) => { e.preventDefault(); runTmdbSearch(); };
    const host = $('tmdb-search-list');
    if (host) host.innerHTML = '<p class="text-sm text-zinc-500">Type a movie or TV title above, then Search.</p>';
  }

  async function runTmdbSearch() {
    const host = $('tmdb-search-list');
    const qEl = $('tmdb-search-q');
    const q = qEl ? qEl.value.trim() : '';
    if (!q) { notice('err', 'Type a title first.'); return; }
    if (q.length > 120) { notice('err', 'Query must be at most 120 characters.'); return; }
    if (host) host.innerHTML = '<div class="inline-loader"><span class="spinner"></span> Searching TMDB…</div>';
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
        host.appendChild(el('p', 'text-sm text-zinc-500', 'No matches for “' + q + '”. Try another spelling.'));
      }
    } catch (e) {
      if (host) {
        host.innerHTML = '';
        host.appendChild(el('p', 'text-sm text-red-300', 'Search failed: ' + ((e && e.message) || e)));
      }
      notice('err', 'Search failed: ' + ((e && e.message) || e));
    }
  }

  function renderSearchCards() {
    const host = $('tmdb-search-list');
    if (!host) return;
    host.innerHTML = '';
    searchState.results.forEach((r) => {
      const card = el('div', 'bg-white/5 border border-white/10 rounded-2xl p-4');
      const row = el('div', 'flex gap-3');
      const img = document.createElement('img');
      const posterUrl = tmdbPosterUrl(r.poster);
      img.className = 'w-12 h-[72px] object-cover rounded-lg shrink-0';
      img.loading = 'lazy';
      img.alt = '';
      img.src = posterUrl || 'https://via.placeholder.com/48x72?text=?';
      row.appendChild(img);
      const body = el('div', 'min-w-0 flex-1');
      const head = el('div', 'flex items-center gap-2 flex-wrap');
      head.appendChild(el('span', 'font-bold', r.title));
      head.appendChild(el('span', 'text-xs bg-white/10 px-2 py-0.5 rounded', r.media === 'tv' ? 'TV' : 'Movie'));
      if (isGreyboxPick(findCachedOverride(r.media, r.id))) {
        head.appendChild(el('span', 'text-xs bg-amber-500 text-black font-bold px-2 py-0.5 rounded', '★ Greybox Pick'));
      }
      body.appendChild(head);
      const metaBits = [(r.year || '—'), '⭐ ' + Number(r.vote || 0).toFixed(1), 'TMDB ' + r.media + ':' + r.id];
      body.appendChild(el('p', 'mt-1 text-xs text-zinc-400', metaBits.join(' · ')));
      if (r.overview) body.appendChild(el('p', 'mt-1 text-xs text-zinc-500 line-clamp-3', r.overview));
      row.appendChild(body);
      card.appendChild(row);
      const inPicks = searchState.epItems !== null && isInEditorPicks(searchState.epItems, r.media, r.id);
      const marked = isGreyboxPick(findCachedOverride(r.media, r.id));
      card.appendChild(rowButtons([
        ['Open ↗', BTN, () => { try { window.open(detailUrlFor(r.media, r.id), '_blank', 'noopener'); } catch { /* noop */ } }],
        [searchState.epItems === null ? "+ Editor's Picks" : (inPicks ? "✓ In Editor's Picks" : "+ Editor's Picks"), BTN, () => toggleEditorPicksFromSearch(r)],
        [marked ? '☆ Unmark Pick' : '★ Mark Pick', BTN, () => togglePickFromSearch(r)],
        ['Override', BTN, () => manageOverrideFor(r.media, r.id)],
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
        if (b.dataset.atab === 'search') { /* results persist; nothing to reload */ }
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
  buildSearchPanel();
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
      fetchGenres, genreName, GENRE_CACHE,
      PICK_BADGE, isGreyboxPick, validPickTarget,
      markGreyboxPick, unmarkGreyboxPick, toggleGreyboxPick,
      EDITOR_PICKS_SLUG, detailUrlFor, tmdbPosterUrl,
      normalizeTmdbSearchResults, normalizeEpItems, isInEditorPicks,
      withAddedToEditorPicks, withRemovedFromEditorPicks, tmdbSearchFetch,
      HOME_SOURCE_TYPES, COL_SOURCE_TYPES, OVERRIDE_FIELDS, SLUG_RE,
      API,
    });
  } catch { /* noop */ }
})();
