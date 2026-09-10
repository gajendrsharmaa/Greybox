/* Main UI — router-driven (Vanilla JS + History API, no framework).
 *
 * URL is the source of truth for *what* is shown; in-memory mode/subTab/pageNum
 * are derived from the route on every navigation (including back/forward,
 * refresh, and direct-URL loads). Data layer (js/api.js) and player
 * (js/stream.js) are untouched.
 *
 * Route -> state mapping (see js/router.js for parsing):
 *   /                              home/trending
 *   /?tab=popular-movie            home sub-tabs (preserved, deep-linkable)
 *   /movies[?page=N]               movie/popular
 *   /movies/<kebab>[?page=N]       movie/<snake>
 *   /tv[?page=N]                   tv/popular
 *   /tv/<kebab>[?page=N]           tv/<snake>
 *   /movie/:id                     detail modal over current/background list
 *   /tv/:id                        detail modal over current/background list
 *   /search?q=...[&page=N]         search grid page
 *   /person/:id                    person overlay in the same modal shell
 *   /anime[/series|/movies]        anime (series <-> tv-anime, movies <-> movie-anime)
 *   /mylist                        localStorage list
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const IMG = 'https://image.tmdb.org/t/p/w500';
  const IMG_BIG = 'https://image.tmdb.org/t/p/original';
  const R = window.Router || null;

  let mode = 'home';       // home | movie | tv | anime | mylist | search
  let subTab = 'trending'; // per-mode tab
  let pageNum = 1;
  let searchQuery = '';
  let heroItem = null;
  let currentDetail = null; // {...} + media_type, or {kind:'person', id}
  let currentSeasons = [];
  let currentEpisodes = [];
  let currentSeasonNum = 1;
  let hasLoadedList = false;
  let lastRouteName = '';

  const myList = {
    load() { try { return JSON.parse(localStorage.getItem('sb_mylist') || '[]'); } catch { return []; } },
    save(v) { localStorage.setItem('sb_mylist', JSON.stringify(v)); updateCount(); },
    toggle(item) {
      const l = myList.load();
      const i = l.findIndex(x => x.id === item.id && x.media_type === item.media_type);
      if (i >= 0) l.splice(i, 1); else l.push(item);
      myList.save(l); return i < 0;
    },
    has(id, mt) { return myList.load().some(x => x.id === id && x.media_type === mt); }
  };
  function updateCount() { const c = $('mylist-count'); if (!c) return; const n = myList.load().length; c.textContent = n || ''; c.classList.toggle('hidden', !n); }

  function notice(msg) {
    const n = $('notice');
    if (!msg) { n.classList.add('hidden'); return; }
    n.textContent = msg; n.classList.remove('hidden');
  }

  function cardHTML(item) {
    const mt = item.media_type || (item.title ? 'movie' : 'tv');
    const title = item.title || item.name || 'Untitled';
    const date = item.release_date || item.first_air_date || '';
    const poster = item.poster_path ? IMG + item.poster_path : 'https://via.placeholder.com/500x750?text=No+Image';
    const inList = myList.has(item.id, mt) ? '★' : '☆';
    return `<div class="card bg-white/5 rounded-xl overflow-hidden border border-white/10" data-id="${item.id}" data-type="${mt}">
      <div class="relative"><img loading="lazy" src="${poster}" alt="${escapeHtml(title)}"/>
      <button class="absolute top-2 right-2 bg-black/70 rounded-full w-8 h-8 list-btn" data-id="${item.id}" data-type="${mt}" title="My List">${inList}</button>
      ${item.vote_average ? `<span class="absolute bottom-2 left-2 text-xs bg-black/75 px-2 py-0.5 rounded">⭐ ${Number(item.vote_average).toFixed(1)}</span>` : ''}</div>
      <div class="p-2.5"><div class="text-sm font-semibold truncate">${escapeHtml(title)}</div>
      <div class="text-xs text-zinc-500">${date ? date.slice(0, 4) : ''} · ${mt === 'movie' ? 'Movie' : 'TV'}</div></div></div>`;
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  /* ---- loading skeletons (no more blank black page) ---- */
  function gridSkeleton(n = 12) {
    let h = '';
    for (let i = 0; i < n; i++) {
      h += `<div class="rounded-xl overflow-hidden border border-white/10 bg-white/5">
        <div class="skeleton aspect-[2/3]"></div>
        <div class="p-2.5"><div class="skeleton h-3 rounded w-3/4"></div>
        <div class="skeleton h-2.5 rounded w-1/3 mt-2"></div></div></div>`;
    }
    return h;
  }
  function setHeroLoading(on) {
    const hero = $('hero');
    if (hero) hero.classList.toggle('hero-loading', !!on);
    if (on) {
      $('hero-badge').textContent = 'Loading…';
      $('hero-title').innerHTML = '<span class="hero-spinner"></span> Fetching trending…';
      $('hero-overview').innerHTML = '<span class="skeleton skeleton-line"></span><span class="skeleton skeleton-line short"></span>';
      $('hero-img').removeAttribute('src');
    }
  }

  /* ---------------- routing helpers (state <-> URL, no fetching) ---------------- */
  const kebabToSnake = (s) => String(s || '').split('-').join('_');
  const snakeToKebab = (s) => String(s || '').split('_').join('-');
  const animeKindToSub = (k) => (k === 'movies' ? 'movie-anime' : 'tv-anime');
  const animeSubToKind = (s) => (s === 'movie-anime' ? 'movies' : 'series');

  function navTo(to) {
    if (R) R.navigate(to);
    else { try { window.location.href = to; } catch { /* noop */ } }
  }

  // Canonical list URL for the current in-memory list state (tabs + pager use this).
  function currentListURL(page) {
    const p = page || pageNum;
    if (!R) return '/';
    if (mode === 'home') return R.url.home(subTab, p);
    if (mode === 'movie') return R.url.movies(snakeToKebab(subTab), p);
    if (mode === 'tv') return R.url.tv(snakeToKebab(subTab), p);
    if (mode === 'anime') return R.url.anime(animeSubToKind(subTab), p);
    if (mode === 'mylist') return R.url.mylist();
    if (mode === 'search') return R.url.search(searchQuery, p);
    return '/';
  }

  function detailURL(id, mt) {
    if (!R) return '/';
    return mt === 'tv' ? R.url.show(id) : R.url.movie(id);
  }

  function highlightNav() {
    // Detail routes highlight their parent section so the nav never looks dead.
    let key = mode;
    if (currentDetail && (lastRouteName === 'movie-detail')) key = 'movie';
    if (currentDetail && (lastRouteName === 'tv-detail')) key = 'tv';
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === key));
  }

  async function load() {
    notice(''); $('page').textContent = 'Page ' + pageNum;
    highlightNav();
    renderTabs();
    if (mode === 'mylist') return renderMyList();
    if (mode === 'search') return loadSearchPage();
    $('section-title').textContent =
      mode === 'home' ? (subTab === 'trending' ? 'Trending Now' : subTab === 'popular-movie' ? 'Popular Movies' : subTab === 'popular-tv' ? 'Popular TV' : 'Top Rated Movies') :
      mode === 'movie' ? ({ popular: 'Popular Movies', top_rated: 'Top Rated Movies', upcoming: 'Upcoming Movies', now_playing: 'Now Playing' }[subTab]) :
      mode === 'anime' ? (subTab === 'tv-anime' ? 'Anime Series' : 'Anime Movies') :
      ({ popular: 'Popular TV', top_rated: 'Top Rated TV', on_the_air: 'On The Air', airing_today: 'Airing Today' }[subTab]);

    $('grid').innerHTML = gridSkeleton(12);
    setHeroLoading(pageNum === 1);
    try {
      let data;
      if (mode === 'home') {
        if (subTab === 'trending') data = await API.gb.trending(pageNum);
        else if (subTab === 'popular-movie') data = await API.gb.movies('popular', pageNum);
        else if (subTab === 'popular-tv') data = await API.gb.tvList('popular', pageNum);
        else data = await API.gb.movies('top-rated', pageNum);
      } else if (mode === 'anime') {
        // Animation (genre 16) + Japanese original language = anime via Greybox
        if (subTab === 'movie-anime') data = await API.gb.anime('movies', pageNum);
        else data = await API.gb.anime('series', pageNum);
      } else if (mode === 'movie') {
        // app tabs keep TMDB snake_case internally; Greybox uses kebab-case.
        data = await API.gb.movies(subTab.split('_').join('-'), pageNum);
      } else {
        data = await API.gb.tvList(subTab.split('_').join('-'), pageNum);
      }
      const items = (data.results || []).filter(x => x.poster_path || x.backdrop_path);
      $('grid').innerHTML = items.map(cardHTML).join('') || '<div class="text-zinc-500">No results.</div>';
      if (pageNum === 1 && items[0]) setHero(items[0]);
      else { const hero = $('hero'); if (hero) hero.classList.remove('hero-loading'); }
      hasLoadedList = true;
    } catch (e) {
      $('grid').innerHTML = '';
      const hero = $('hero'); if (hero) hero.classList.remove('hero-loading');
      if (pageNum === 1) { $('hero-badge').textContent = 'Offline'; $('hero-title').textContent = 'Could not load'; $('hero-overview').textContent = e.message; }
      notice('⚠️ ' + e.message);
    }
  }

  async function loadSearchPage() {
    $('section-title').textContent = searchQuery ? `Results for “${searchQuery}”` : 'Search';
    $('tabs').innerHTML = '';
    highlightNav();
    if (!searchQuery) {
      $('grid').innerHTML = '<div class="text-zinc-500 col-span-full">Type in the search box above, or open a URL like <code>/search?q=dune</code>.</div>';
      const hero = $('hero'); if (hero) hero.classList.remove('hero-loading');
      $('page').textContent = 'Page ' + pageNum;
      return;
    }
    $('grid').innerHTML = gridSkeleton(12);
    setHeroLoading(false);
    const hero = $('hero'); if (hero) hero.classList.remove('hero-loading');
    try {
      const d = await API.gb.search(searchQuery, pageNum);
      const items = (d.results || []).filter(x => (x.media_type === 'movie' || x.media_type === 'tv'));
      $('grid').innerHTML = items.map(cardHTML).join('') || '<div class="text-zinc-500">No matches.</div>';
      $('page').textContent = 'Page ' + pageNum;
      hasLoadedList = true;
    } catch (e) {
      $('grid').innerHTML = '';
      notice('⚠️ ' + e.message);
    }
  }

  function renderNotFound(path) {
    hideModal();
    $('section-title').textContent = 'Not found';
    $('tabs').innerHTML = '';
    $('grid').innerHTML = `<div class="text-zinc-400 col-span-full">No page at <code>${escapeHtml(path || '')}</code>. <a class="text-red-400 underline" href="/" data-route>Back to home</a></div>`;
    const hero = $('hero'); if (hero) hero.classList.remove('hero-loading');
    $('hero-badge').textContent = '404';
    $('hero-title').textContent = 'That URL does not exist';
    $('hero-overview').textContent = 'Check /movies, /tv, /movie/:id, /tv/:id, /search?q=..., or /person/:id.';
    $('page').textContent = 'Page 1';
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  }

  function renderTabs() {
    const t = $('tabs'); t.innerHTML = '';
    let tabs = [];
    if (mode === 'home') tabs = [['trending', 'Trending'], ['popular-movie', 'Movies'], ['popular-tv', 'TV'], ['top', 'Top Rated']];
    if (mode === 'movie') tabs = [['popular', 'Popular'], ['top_rated', 'Top Rated'], ['upcoming', 'Upcoming'], ['now_playing', 'Now Playing']];
    if (mode === 'tv') tabs = [['popular', 'Popular'], ['top_rated', 'Top Rated'], ['on_the_air', 'On Air'], ['airing_today', 'Airing Today']];
    if (mode === 'anime') tabs = [['tv-anime', 'Anime Series'], ['movie-anime', 'Anime Movies']];
    for (const [k, label] of tabs) {
      const b = document.createElement('button');
      b.className = 'px-3 py-1.5 rounded-lg ' + (subTab === k ? 'bg-red-600 font-bold' : 'bg-white/10');
      b.textContent = label;
      // Tabs are navigation: the URL updates so refresh/back/deep-links keep working.
      b.onclick = () => {
        if (mode === 'home') navTo(R ? R.url.home(k, 1) : '/');
        else if (mode === 'movie') navTo(R ? R.url.movies(snakeToKebab(k), 1) : '/movies');
        else if (mode === 'tv') navTo(R ? R.url.tv(snakeToKebab(k), 1) : '/tv');
        else if (mode === 'anime') navTo(R ? R.url.anime(animeSubToKind(k), 1) : '/anime');
      };
      t.appendChild(b);
    }
  }

  function setHero(item) {
    heroItem = item;
    const hero = $('hero');
    if (hero) hero.classList.remove('hero-loading');
    const badge = $('hero-badge');
    if (badge) badge.textContent = '#1 Trending';
    const title = item.title || item.name;
    $('hero-title').textContent = title;
    $('hero-overview').textContent = item.overview || '';
    $('hero-img').src = item.backdrop_path ? IMG_BIG + item.backdrop_path : (item.poster_path ? IMG + item.poster_path : '');
  }

  function renderMyList() {
    $('section-title').textContent = 'My List';
    $('tabs').innerHTML = ''; $('grid').innerHTML = '';
    const l = myList.load();
    $('grid').innerHTML = l.length ? l.map(cardHTML).join('') : '<div class="text-zinc-500 col-span-full">Empty. Hover a poster and hit ☆, or open details → + My List. Stored locally in your browser.</div>';
    const hero = $('hero'); if (hero) hero.classList.remove('hero-loading');
    hasLoadedList = true;
  }

  function streamMsg(msg, ok) {
    const n = $('m-stream-msg');
    if (!msg) { n.classList.add('hidden'); n.textContent = ''; return; }
    n.textContent = msg;
    n.classList.remove('hidden');
    n.className = 'mt-3 text-sm rounded-xl p-3 ' + (ok
      ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-200'
      : 'bg-amber-500/10 border border-amber-500/30 text-amber-200');
  }

  function setModalActionsVisible(visible) {
    // Person view reuses the modal shell but has no Watch/Trailer/List/custom-source.
    for (const id of ['m-watch', 'm-trailer', 'm-list']) {
      const el = $(id);
      if (el) el.style.display = visible ? '' : 'none';
    }
    const custom = $('custom-url');
    if (custom && custom.parentElement) custom.parentElement.style.display = visible ? '' : 'none';
    const tvWrap = $('m-tv-wrap');
    if (!visible && tvWrap) tvWrap.classList.add('hidden');
  }

  // ---- detail (single Greybox bundle: detail + cast + trailer + providers) ----
  // NOTE: never pushes history itself — callers navigate first, the router calls this.
  async function openDetail(id, mt) {
    // Normalize media type — the Greybox detail routes only serve movie|tv.
    mt = mt === 'tv' ? 'tv' : 'movie';
    setModalActionsVisible(true);
    $('modal').classList.remove('hidden'); document.body.style.overflow = 'hidden';
    $('m-video-wrap').classList.add('hidden'); $('m-video').src = '';
    streamMsg('');
    $('m-tv-wrap').classList.add('hidden'); $('m-episodes').innerHTML = ''; $('m-season').innerHTML = '';
    currentSeasons = []; currentEpisodes = [];
    $('m-title').textContent = 'Loading...'; $('m-overview').textContent = '';
    $('m-cast').innerHTML = '<div class="inline-loader"><span class="spinner"></span> Loading cast…</div>';
    $('m-providers').innerHTML = '<div class="inline-loader"><span class="spinner"></span> Finding where to watch…</div>';
    $('m-backdrop').src = '';
    $('m-watch').textContent = '▶ Watch Now';
    let d = null;
    try {
      const region = API.getRegion();
      d = mt === 'tv' ? await API.gb.show(id, region) : await API.gb.movie(id, region);
      if (!d || !d.id) {
        throw new Error('Greybox API returned an error for ' + mt + '/' + id);
      }
      currentDetail = { ...d, id, media_type: mt, kind: 'title' };
      highlightNav();
      if (R) document.title = `${d.title || d.name || (mt === 'tv' ? 'TV Show' : 'Movie')} (${id}) — Greybox`;
      const title = d.title || d.name || 'Untitled';
      $('m-title').textContent = title;
      $('m-meta').textContent = `${(d.release_date || d.first_air_date || '').slice(0, 4)} · ⭐ ${Number(d.vote_average || 0).toFixed(1)} · ${(d.genres || []).join(', ')}`;
      $('m-overview').textContent = d.overview || 'No overview.';
      $('m-backdrop').src = d.backdrop_path ? IMG_BIG + d.backdrop_path : (d.poster_path ? IMG + d.poster_path : '');
      // NOTE: removed dead m-tmdb href lookup — that element id does not exist in
      // index.html, and old deployed copies threw
      // "Cannot set properties of null (setting 'href')" here, which blanked
      // the title to "Error" and left providers stuck on "Loading...".
      $('m-list').textContent = myList.has(id, mt) ? '★ In My List' : '+ My List';
      const trailerKey = d.trailer_key;
      $('m-trailer').onclick = () => {
        if (!trailerKey) return alert('No trailer on TMDB for this title.');
        $('m-video-wrap').classList.remove('hidden');
        $('m-video').src = `https://www.youtube.com/embed/${trailerKey}?autoplay=1`;
        $('m-video-wrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
      // ---- Watch Now: resolves a direct-file URL from the (blank-by-default) source slot ----
      wireWatchButton();
      if (mt === 'tv') loadTvSeasons(id, d);
      else {
        const resume = Stream.resumeLabel('movie:' + id);
        if (resume && Stream.isConfigured('movie')) streamMsg(resume + ' — press Watch Now to continue.', true);
        else if (!Stream.isConfigured('movie')) streamMsg('No stream source configured yet. Put your official API streaming link here — open js/stream.js (EMBED.base in js/stream.js), or play the trailer below.');
      }
    } catch (e) {
      console.error('[detail] failed for', mt + '/' + id, e);
      $('m-title').textContent = 'Error';
      $('m-overview').textContent = (e && e.message ? e.message : String(e)) + ' — press F12 → Console for details, then hard-refresh (Ctrl+Shift+R).';
      $('m-providers').textContent = '—';
      return;
    }
    // Cast renders from the already-fetched bundle so it never blanks the title.
    try {
      const castList = (d.cast || []);
      $('m-cast').innerHTML = castList.slice(0, 12).map(c =>
        `<div class="min-w-[90px] text-center"><img class="w-[90px] h-[120px] object-cover rounded-lg" loading="lazy" src="${c.profile_path ? IMG + c.profile_path : 'https://via.placeholder.com/90x120?text=?'}"/><div class="mt-1 font-semibold truncate">${escapeHtml(c.name)}</div><div class="text-zinc-500 truncate">${escapeHtml(c.character || '')}</div></div>`).join('') || '—';
    } catch (err) { console.warn('[detail] cast failed', err); $('m-cast').textContent = '—'; }
    // providers (already region-filtered by the Greybox bundle)
    try {
      const p = d.providers;
      const region = (p && p.region) || API.getRegion();
      const hasOffer = p && (p.flatrate.length || p.rent.length || p.buy.length || p.link);
      $('m-providers').innerHTML = hasOffer
        ? `${p.flatrate?.length ? '<b>Stream:</b> ' + p.flatrate.map(escapeHtml).join(', ') + '<br/>' : ''}${p.rent?.length ? '<b>Rent:</b> ' + p.rent.map(escapeHtml).join(', ') + '<br/>' : ''}${p.buy?.length ? '<b>Buy:</b> ' + p.buy.map(escapeHtml).join(', ') : ''}${p.link ? `<br/><a class="text-red-400 underline" target="_blank" href="${p.link}">Open JustWatch/TMDB guide ↗</a>` : ''}`
        : `No legal offer found for region ${region}. Change region in Settings ⚙️.`;
    } catch (err) { console.warn('[detail] providers failed', err); $('m-providers').textContent = 'Provider lookup failed.'; }
  }

  // ---- person (/person/:id) — read-only via the EXISTING /api/tmdb proxy transport.
  // No new backend, no new Greybox endpoint, no arch change: same tmdb() the
  // static-preview fallback already uses (allowlisted for person/* server-side).
  async function openPerson(id) {
    setModalActionsVisible(false);
    $('modal').classList.remove('hidden'); document.body.style.overflow = 'hidden';
    $('m-video-wrap').classList.add('hidden'); $('m-video').src = '';
    streamMsg('');
    $('m-tv-wrap').classList.add('hidden'); $('m-episodes').innerHTML = ''; $('m-season').innerHTML = '';
    currentSeasons = []; currentEpisodes = [];
    $('m-title').textContent = 'Loading person…'; $('m-overview').textContent = '';
    $('m-meta').textContent = '';
    $('m-cast').innerHTML = '<div class="inline-loader"><span class="spinner"></span> Loading…</div>';
    $('m-providers').innerHTML = '<div class="inline-loader"><span class="spinner"></span> Loading…</div>';
    $('m-backdrop').src = '';
    try {
      const [person, credits] = await Promise.all([
        API.tmdb('person/' + id, { language: 'en-US' }),
        API.tmdb('person/' + id + '/combined_credits', { language: 'en-US' }).catch(() => ({ cast: [] })),
      ]);
      if (!person || !person.id) throw new Error('Greybox API returned an error for person/' + id);
      currentDetail = { kind: 'person', id, media_type: 'person' };
      highlightNav();
      if (R) document.title = `${person.name || 'Person'} (${id}) — Greybox`;
      $('m-title').textContent = person.name || 'Untitled';
      const facts = [
        person.known_for_department || '',
        person.birthday || '',
        person.place_of_birth || '',
      ].filter(Boolean).join(' · ');
      $('m-meta').textContent = facts || 'Person';
      $('m-overview').textContent = person.biography || 'No biography on TMDB.';
      $('m-backdrop').src = person.profile_path ? IMG_BIG + person.profile_path : '';
      $('m-providers').innerHTML =
        `${person.birthday ? '<b>Born:</b> ' + escapeHtml(person.birthday) + (person.place_of_birth ? ' in ' + escapeHtml(person.place_of_birth) : '') + '<br/>' : ''}` +
        `${person.known_for_department ? '<b>Known for:</b> ' + escapeHtml(person.known_for_department) + '<br/>' : ''}` +
        `<a class="text-red-400 underline" target="_blank" href="https://www.themoviedb.org/person/${id}">Open on TMDB ↗</a>`;
      const known = ((credits && credits.cast) || [])
        .filter(x => x && (x.media_type === 'movie' || x.media_type === 'tv'))
        .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
        .slice(0, 12);
      $('m-cast').innerHTML = known.map(x => {
        const mt = x.media_type;
        const title = x.title || x.name || 'Untitled';
        return `<div class="min-w-[90px] text-center cursor-pointer known-for" data-id="${x.id}" data-type="${mt}"><img class="w-[90px] h-[120px] object-cover rounded-lg" loading="lazy" src="${x.poster_path ? IMG + x.poster_path : 'https://via.placeholder.com/90x120?text=?'}"/><div class="mt-1 font-semibold truncate">${escapeHtml(title)}</div><div class="text-zinc-500 truncate">${mt === 'movie' ? 'Movie' : 'TV'}</div></div>`;
      }).join('') || '—';
      $('m-cast').querySelectorAll('.known-for').forEach(el => {
        el.onclick = () => navTo(detailURL(+el.dataset.id, el.dataset.type));
      });
    } catch (e) {
      console.error('[person] failed for person/' + id, e);
      $('m-title').textContent = 'Error';
      $('m-overview').textContent = (e && e.message ? e.message : String(e));
      $('m-providers').textContent = '—';
      $('m-cast').textContent = '—';
    }
  }

  function hideModal() {
    // Silent hide — used when the ROUTER renders a non-detail route (back/forward,
    // direct list URL). Never touches history itself.
    if ($('modal').classList.contains('hidden')) return;
    $('modal').classList.add('hidden'); $('m-video').src = ''; document.body.style.overflow = '';
  }

  function userCloseDetail() {
    // User pressed X / backdrop / Escape on a detail/person URL:
    // go back when this detail was reached in-app, else replace with a list URL
    // so a direct-URL load still has somewhere sensible to land.
    const route = R ? R.current() : null;
    const isDetail = route && (route.name === 'movie-detail' || route.name === 'tv-detail' || route.name === 'person');
    if (!isDetail) { hideModal(); return; }
    const fallback = route.name === 'movie-detail' ? '/movies'
      : route.name === 'tv-detail' ? '/tv' : '/';
    if (R && R.hasInAppHistory()) { try { window.history.back(); return; } catch { /* fall through */ } }
    hideModal();
    navTo(fallback);
  }

  function closeDetail() { hideModal(); }

  // ---- Watch resolution (source slot blank by default) ----
  function wireWatchButton() {
    $('m-watch').onclick = () => {
      if (!currentDetail) return;
      if (currentDetail.media_type === 'movie') playMovie();
      else {
        // TV: scroll to episodes; play first episode if source configured
        $('m-tv-wrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (currentEpisodes.length && Stream.isConfigured('tv')) playEpisode(currentEpisodes[0]);
        else if (!Stream.isConfigured('tv')) streamMsg('Pick an episode below. To enable playback, put your official API streaming link here — open js/stream.js (EMBED.base in js/stream.js).');
      }
    };
  }

  function playMovie() {
    const d = currentDetail;
    const url = Stream.getMovieUrl(d.id);
    if (!url) { streamMsg('No stream source configured yet. Put your official API streaming link here — open js/stream.js (EMBED.base in js/stream.js). Trailers play without it.'); return; }
    streamMsg('');
    closeDetail();
    Stream.Player.open({
      title: d.title || d.name || 'Movie',
      sub: 'Movie',
      url,
      mode: 'embed',
      progressKey: 'movie:' + d.id,
    });
  }

  async function loadTvSeasons(tmdbId, detail) {
    currentSeasons = (detail.seasons || []).filter(s => s.season_number >= 0);
    if (!currentSeasons.length) return;
    $('m-tv-wrap').classList.remove('hidden');
    const sel = $('m-season');
    sel.innerHTML = currentSeasons.map(s => `<option value="${s.season_number}">${escapeHtml(s.name)} (${s.episode_count} eps)</option>`).join('');
    currentSeasonNum = (currentSeasons.find(s => s.season_number === 1) || currentSeasons[0]).season_number;
    sel.value = String(currentSeasonNum);
    sel.onchange = () => { currentSeasonNum = +sel.value; loadEpisodes(tmdbId, currentSeasonNum); };
    loadEpisodes(tmdbId, currentSeasonNum);
    if (!Stream.isConfigured('tv')) streamMsg('Episode list loaded from TMDB. Playback needs you to put your official API streaming link here — open js/stream.js (EMBED.base in js/stream.js) — links left blank until then.');
  }

  async function loadEpisodes(tmdbId, seasonNum) {
    $('m-episodes').innerHTML = '<div class="inline-loader"><span class="spinner"></span> Loading episodes…</div>';
    try {
      const s = await API.gb.season(tmdbId, seasonNum);
      currentEpisodes = s.episodes || [];
      renderEpisodes(tmdbId, seasonNum);
    } catch { $('m-episodes').innerHTML = '<div class="text-sm text-red-300">Could not load episodes.</div>'; }
  }

  function renderEpisodes(tmdbId, seasonNum) {
    const configured = Stream.isConfigured('tv');
    $('m-episodes').innerHTML = currentEpisodes.map(ep => {
      const resume = Stream.resumeLabel(`tv:${tmdbId}:${seasonNum}:${ep.episode_number}`);
      return `<div class="flex gap-3 bg-white/5 border border-white/10 rounded-xl p-3">
        <img class="w-32 h-[72px] object-cover rounded-lg shrink-0" loading="lazy"
          src="${ep.still_path ? IMG + ep.still_path : 'https://via.placeholder.com/128x72?text=No+Still'}" alt=""/>
        <div class="min-w-0 flex-1">
          <div class="text-sm font-bold truncate">E${ep.episode_number} · ${escapeHtml(ep.name || 'Episode')}</div>
          <div class="text-xs text-zinc-400 line-clamp-3 mt-0.5">${escapeHtml(ep.overview || '')}</div>
          <div class="text-xs text-zinc-500 mt-1">${ep.runtime ? ep.runtime + ' min · ' : ''}${ep.air_date || ''}${resume ? ' · <span class="text-emerald-300">' + resume + '</span>' : ''}</div>
        </div>
        <button class="self-center shrink-0 px-4 py-2 rounded-lg font-bold text-sm ${configured ? 'bg-red-600 hover:bg-red-500' : 'bg-white/10 text-zinc-400'}"
          data-season="${seasonNum}" data-ep="${ep.episode_number}">▶</button>
      </div>`;
    }).join('') || '<div class="text-sm text-zinc-500">No episodes listed.</div>';
    $('m-episodes').querySelectorAll('button[data-ep]').forEach(b => {
      b.onclick = () => {
        const ep = currentEpisodes.find(x => x.episode_number === +b.dataset.ep);
        if (ep) playEpisode(ep);
      };
    });
  }

  function playEpisode(ep) {
    const d = currentDetail;
    const seasonNum = +($('m-season').value || currentSeasonNum || 1);
    const url = Stream.getEpisodeUrl(d.id, seasonNum, ep.episode_number);
    if (!url) { streamMsg('No stream source configured yet. Put your official API streaming link here — open js/stream.js (EMBED.base in js/stream.js).'); return; }
    streamMsg('');
    const title = d.name || d.title || 'Show';
    closeDetail();
    Stream.Player.open({
      title,
      sub: `S${seasonNum} E${ep.episode_number} · ${ep.name || ''}`,
      url,
      mode: 'embed',
      progressKey: `tv:${d.id}:${seasonNum}:${ep.episode_number}`,
      showPrevNext: true,
      onEnded: () => autoNext(seasonNum, ep.episode_number),
    });
  }

  function stepEpisode(dir) {
    const cur = Stream.Player.current();
    if (!cur || !currentDetail || !currentEpisodes.length) return;
    const m = /S(\d+)\s*E(\d+)/.exec(cur.sub || '');
    const epNum = m ? +m[2] : null;
    const idx = currentEpisodes.findIndex(x => x.episode_number === epNum);
    const next = currentEpisodes[idx + dir];
    if (!next) { streamMsg(dir > 0 ? 'That was the last listed episode of this season.' : 'Already at the first episode.'); return; }
    playEpisodeFromPlayer(next);
  }

  function playEpisodeFromPlayer(ep) {
    const d = currentDetail;
    const seasonNum = currentSeasonNum;
    const url = Stream.getEpisodeUrl(d.id, seasonNum, ep.episode_number);
    if (!url) return;
    Stream.Player.open({
      title: d.name || d.title || 'Show',
      sub: `S${seasonNum} E${ep.episode_number} · ${ep.name || ''}`,
      url,
      mode: 'embed',
      progressKey: `tv:${d.id}:${seasonNum}:${ep.episode_number}`,
      showPrevNext: true,
      onEnded: () => autoNext(seasonNum, ep.episode_number),
    });
  }

  function autoNext(seasonNum, epNum) {
    const idx = currentEpisodes.findIndex(x => x.episode_number === epNum);
    const next = currentEpisodes[idx + 1];
    if (!next) return; // season finished — leave player open at ended state
    if (!Stream.getEpisodeUrl(currentDetail.id, seasonNum, next.episode_number)) return;
    playEpisodeFromPlayer(next);
  }

  // ---- player: custom files route through the same engine ----
  function playFile(url, title) {
    closeDetail();
    Stream.Player.open({ title, sub: 'Direct file', url, progressKey: 'file:' + url.length + ':' + [...url].reduce((a, c) => a + c.charCodeAt(0), 0) % 100000 });
  }
  function closePlayer() { Stream.Player.close(); }

  /* ---------------- route renderer (single entry for ALL navigation) ---------------- */
  async function renderRoute(route) {
    if (!route) route = R ? R.current() : { name: 'home', tab: 'trending', page: 1, path: '/' };
    lastRouteName = route.name;
    if (R) document.title = R.titleFor(route);
    // Keep the header search box in sync with /search?q=... (but never clobber typing elsewhere).
    try {
      if (route.name === 'search' && document.activeElement !== $('search')) $('search').value = route.q || '';
    } catch { /* noop */ }

    if (route.name === 'home') {
      hideModal(); currentDetail = null;
      mode = 'home'; subTab = route.tab || 'trending'; pageNum = route.page || 1;
      window.scrollTo({ top: 0 });
      await load();
      return;
    }
    if (route.name === 'movies') {
      hideModal(); currentDetail = null;
      mode = 'movie'; subTab = kebabToSnake(route.cat || 'popular'); pageNum = route.page || 1;
      window.scrollTo({ top: 0 });
      await load();
      return;
    }
    if (route.name === 'tv') {
      hideModal(); currentDetail = null;
      mode = 'tv'; subTab = kebabToSnake(route.cat || 'popular'); pageNum = route.page || 1;
      window.scrollTo({ top: 0 });
      await load();
      return;
    }
    if (route.name === 'anime') {
      hideModal(); currentDetail = null;
      mode = 'anime'; subTab = animeKindToSub(route.kind || 'series'); pageNum = route.page || 1;
      window.scrollTo({ top: 0 });
      await load();
      return;
    }
    if (route.name === 'mylist') {
      hideModal(); currentDetail = null;
      mode = 'mylist'; pageNum = 1;
      window.scrollTo({ top: 0 });
      await load();
      return;
    }
    if (route.name === 'search') {
      hideModal(); currentDetail = null;
      mode = 'search'; searchQuery = route.q || ''; pageNum = route.page || 1;
      window.scrollTo({ top: 0 });
      await load();
      return;
    }
    if (route.name === 'movie-detail' || route.name === 'tv-detail') {
      const mt = route.name === 'tv-detail' ? 'tv' : 'movie';
      // Background list: keep the current grid for in-app navigation so Back
      // returns to exactly where the user was. On direct load / refresh (no
      // list yet), boot a sensible background first without touching the URL.
      if (!hasLoadedList) {
        mode = 'home'; subTab = 'trending'; pageNum = 1;
        await load();
      }
      await openDetail(route.id, mt);
      return;
    }
    if (route.name === 'person') {
      if (!hasLoadedList) {
        mode = 'home'; subTab = 'trending'; pageNum = 1;
        await load();
      }
      await openPerson(route.id);
      return;
    }
    renderNotFound(route.path);
  }

  // ---- events ----
  document.addEventListener('click', (e) => {
    const lb = e.target.closest('.list-btn');
    if (lb) {
      e.stopPropagation();
      const id = +lb.dataset.id, mt = lb.dataset.type;
      // need minimal item: find in DOM? store title from card
      const card = lb.closest('.card');
      const title = card ? card.querySelector('.font-semibold').textContent : 'Title';
      const img = card ? card.querySelector('img').src : '';
      const added = myList.toggle({ id, media_type: mt, title, name: title, poster_path: img.includes('image.tmdb') ? img.split('/w500')[1] : null });
      lb.textContent = added ? '★' : '☆';
      updateCount(); return;
    }
    const card = e.target.closest('.card[data-id]');
    // Cards are navigation — the URL becomes /movie/:id or /tv/:id.
    if (card) { navTo(detailURL(+card.dataset.id, card.dataset.type)); return; }
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      const key = nav.dataset.nav;
      if (key === 'home') navTo(R ? R.url.home('trending', 1) : '/');
      else if (key === 'movie') navTo(R ? R.url.movies('popular', 1) : '/movies');
      else if (key === 'tv') navTo(R ? R.url.tv('popular', 1) : '/tv');
      else if (key === 'anime') navTo(R ? R.url.anime('series', 1) : '/anime');
      else if (key === 'mylist') navTo(R ? R.url.mylist() : '/mylist');
      else navTo('/');
      return;
    }
  });

  $('modal-close').addEventListener('click', (e) => { e.stopPropagation(); userCloseDetail(); });
  $('modal-bg').addEventListener('click', userCloseDetail);
  $('player-close').onclick = closePlayer;
  $('ep-prev').onclick = () => stepEpisode(-1);
  $('ep-next').onclick = () => stepEpisode(1);
  // Pager is navigation: ?page=N stays in the URL so refresh/deep-links keep it.
  $('prev').onclick = () => { if (pageNum > 1) navTo(currentListURL(pageNum - 1)); };
  $('next').onclick = () => { navTo(currentListURL(pageNum + 1)); };
  $('hero-play').onclick = () => heroItem && navTo(detailURL(heroItem.id, heroItem.media_type || (heroItem.title ? 'movie' : 'tv')));
  $('hero-list').onclick = () => {
    if (!heroItem) return;
    const mt = heroItem.media_type || (heroItem.title ? 'movie' : 'tv');
    myList.toggle({ ...heroItem, media_type: mt }); updateCount();
  };
  $('m-list').onclick = () => { if (currentDetail) { const added = myList.toggle(currentDetail); $('m-list').textContent = added ? '★ In My List' : '+ My List'; updateCount(); } };
  $('custom-play').onclick = () => {
    const u = $('custom-url').value.trim();
    if (!u) return alert('Paste an .m3u8 or .mp4 URL you own.');
    playFile(u, ($('m-title').textContent || 'Custom') + ' (custom file)');
  };

  // search: dropdown suggestions stay as-is, but every destination is a route.
  let deb = null;
  $('search').addEventListener('input', (e) => {
    clearTimeout(deb);
    const q = e.target.value.trim();
    const box = $('search-results');
    if (!q) { box.classList.add('hidden'); return; }
    deb = setTimeout(async () => {
      try {
        const d = await API.gb.search(q);
        const items = (d.results || []).filter(x => (x.media_type === 'movie' || x.media_type === 'tv') && (x.poster_path || x.profile_path));
        box.innerHTML = items.slice(0, 8).map(x => `<div class="flex gap-3 p-2.5 hover:bg-white/10 cursor-pointer sr" data-id="${x.id}" data-type="${x.media_type}">
          <img class="w-10 h-14 object-cover rounded" src="${x.poster_path ? IMG + x.poster_path : 'https://via.placeholder.com/40x56?text=?'}"/>
          <div><div class="text-sm font-semibold">${escapeHtml(x.title || x.name)}</div><div class="text-xs text-zinc-500">${x.media_type} · ${(x.release_date || x.first_air_date || '').slice(0, 4)}</div></div></div>`).join('') || '<div class="p-3 text-sm text-zinc-500">No matches.</div>';
        box.classList.remove('hidden');
        box.querySelectorAll('.sr').forEach(el => el.onclick = () => { box.classList.add('hidden'); $('search').value = ''; navTo(detailURL(+el.dataset.id, el.dataset.type)); });
      } catch (err) { box.innerHTML = `<div class="p-3 text-sm text-red-300">${escapeHtml(err.message)}</div>`; box.classList.remove('hidden'); }
    }, 350);
  });
  // Enter commits the query as a real URL: /search?q=... (refreshable, shareable).
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = e.target.value.trim();
      if (!q) return;
      $('search-results').classList.add('hidden');
      navTo(R ? R.url.search(q, 1) : ('/search?q=' + encodeURIComponent(q)));
    }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#search') && !e.target.closest('#search-results')) $('search-results').classList.add('hidden'); });

  // settings
  $('settings-btn').onclick = () => { $('settings').classList.remove('hidden'); $('tmdb-token').value = API.getToken(); $('region').value = API.getRegion(); };
  document.querySelectorAll('[data-close-settings]').forEach(b => b.onclick = () => $('settings').classList.add('hidden'));
  $('save-settings').onclick = () => {
    localStorage.setItem(API.LS_TOKEN, $('tmdb-token').value.trim());
    localStorage.setItem(API.LS_REGION, ($('region').value.trim() || 'US').toUpperCase());
    $('settings').classList.add('hidden'); load();
  };

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { userCloseDetail(); closePlayer(); $('settings').classList.add('hidden'); } });

  // ---- interaction protection (lightweight): no right-click menu, text
  // selection, copy, cut, paste, drag-out, or long-press menus on the page
  // and player container. Exceptions: paste/cut stay allowed in the search
  // box (#search). Scrolling, video playback, and player controls are left
  // alone (no key, touch-action, or pointer-events interference). The player
  // iframe may be cross-origin, so this only guards our own page/container —
  // it never touches the iframe's internal document. ----
  (function protect() {
    const inSearch = (el) => !!(el && el.closest && el.closest('#search'));
    const inField = (el) => !!(el && el.closest && el.closest('input,textarea,select,[contenteditable="true"]'));
    // right-click / long-press menu: blocked everywhere except search (so mouse-paste works there)
    document.addEventListener('contextmenu', (e) => {
      if (!inSearch(e.target)) e.preventDefault();
    });
    // text selection: blocked page-wide except inside editable fields
    document.addEventListener('selectstart', (e) => {
      if (!inField(e.target)) e.preventDefault();
    });
    // copy: blocked everywhere (covers Ctrl+C / Cmd+C / long-press copy)
    document.addEventListener('copy', (e) => e.preventDefault());
    // cut: blocked everywhere except search (keeps search editable)
    document.addEventListener('cut', (e) => {
      if (!inSearch(e.target)) e.preventDefault();
    });
    // paste: allowed ONLY in search, blocked in all other inputs
    document.addEventListener('paste', (e) => {
      if (!inSearch(e.target)) e.preventDefault();
    });
    // drag-out (images/text): blocked except from search
    document.addEventListener('dragstart', (e) => {
      if (!inSearch(e.target)) e.preventDefault();
    });
  })();

  /* ---- boot: router owns the initial render so refresh/direct-URL work ---- */
  updateCount();
  try { if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual'; } catch { /* noop */ }
  if (R) {
    R.init();
    R.onChange((route) => { renderRoute(route); });
    renderRoute(R.current());
  } else {
    load();
  }

  // Headless/test hook (no UI effect): lets node-based checks drive the
  // route->state mapping without a browser.
  try { window.GreyboxApp = window.GreyboxApp || {}; window.GreyboxApp.renderRoute = renderRoute; } catch { /* noop */ }
})();
