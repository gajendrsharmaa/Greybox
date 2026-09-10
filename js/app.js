/* Main UI */
(function () {
  const $ = (id) => document.getElementById(id);
  const IMG = 'https://image.tmdb.org/t/p/w500';
  const IMG_BIG = 'https://image.tmdb.org/t/p/original';

  let mode = 'home';       // home | movie | tv | anime | mylist | search
  let subTab = 'trending'; // per-mode tab
  let pageNum = 1;
  let heroItem = null;
  let currentDetail = null;
  let currentSeasons = [];
  let currentEpisodes = [];
  let currentSeasonNum = 1;

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

  async function load() {
    notice(''); $('page').textContent = 'Page ' + pageNum;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === mode));
    renderTabs();
    if (mode === 'mylist') return renderMyList();
    if (mode === 'search') return; // handled by search box
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
    } catch (e) {
      $('grid').innerHTML = '';
      const hero = $('hero'); if (hero) hero.classList.remove('hero-loading');
      if (pageNum === 1) { $('hero-badge').textContent = 'Offline'; $('hero-title').textContent = 'Could not load'; $('hero-overview').textContent = e.message; }
      notice('⚠️ ' + e.message);
    }
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
      b.textContent = label; b.onclick = () => { subTab = k; pageNum = 1; load(); };
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

  // ---- detail (single Greybox bundle: detail + cast + trailer + providers) ----
  async function openDetail(id, mt) {
    // Normalize media type — the Greybox detail routes only serve movie|tv.
    mt = mt === 'tv' ? 'tv' : 'movie';
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
      currentDetail = { ...d, id, media_type: mt };
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
  function closeDetail() { $('modal').classList.add('hidden'); $('m-video').src = ''; document.body.style.overflow = ''; }

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
    if (card) openDetail(+card.dataset.id, card.dataset.type);
    const nav = e.target.closest('[data-nav]');
    if (nav) { mode = nav.dataset.nav; pageNum = 1; if (mode === 'movie') subTab = 'popular'; if (mode === 'tv') subTab = 'popular'; if (mode === 'anime') subTab = 'tv-anime'; if (mode === 'home') subTab = 'trending'; window.scrollTo({ top: 0 }); load(); }
  });

  $('modal-close').addEventListener('click', (e) => { e.stopPropagation(); closeDetail(); });
  $('modal-bg').addEventListener('click', closeDetail);
  $('player-close').onclick = closePlayer;
  $('ep-prev').onclick = () => stepEpisode(-1);
  $('ep-next').onclick = () => stepEpisode(1);
  $('prev').onclick = () => { if (pageNum > 1) { pageNum--; load(); } };
  $('next').onclick = () => { pageNum++; load(); };
  $('hero-play').onclick = () => heroItem && openDetail(heroItem.id, heroItem.media_type || (heroItem.title ? 'movie' : 'tv'));
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

  // search
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
        box.querySelectorAll('.sr').forEach(el => el.onclick = () => { box.classList.add('hidden'); $('search').value = ''; openDetail(+el.dataset.id, el.dataset.type); });
      } catch (err) { box.innerHTML = `<div class="p-3 text-sm text-red-300">${escapeHtml(err.message)}</div>`; box.classList.remove('hidden'); }
    }, 350);
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

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDetail(); closePlayer(); $('settings').classList.add('hidden'); } });
  $('logo').onclick = (e) => { e.preventDefault(); mode = 'home'; subTab = 'trending'; pageNum = 1; load(); };

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

  updateCount(); load();
})();
