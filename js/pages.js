/* Greybox page renderers — data in, HTML out. No fetching, no Router.
 *
 * Each function takes already-fetched data (from js/data.js, passed by the
 * controller in js/app.js) and renders it with shared helpers from
 * js/components.js. Visual output is identical to the pre-refactor app:
 * same headings, same cards, same modal fields, same copy.
 *
 * Behaviour callbacks (tab select, episode play, known-for select) are
 * injected by the controller so renderers never navigate or play directly.
 */
(function () {
  'use strict';

  function C() {
    if (!window.GreyboxComponents) throw new Error('GreyboxComponents not loaded (components.js before pages.js).');
    return window.GreyboxComponents;
  }

  function $(id) { return document.getElementById(id); }

  /* ---------------- headings + tabs (exact pre-refactor copy) ---------------- */

  const TITLES = {
    home: { trending: 'Trending Now', 'popular-movie': 'Popular Movies', 'popular-tv': 'Popular TV', top: 'Top Rated Movies' },
    movie: { popular: 'Popular Movies', top_rated: 'Top Rated Movies', upcoming: 'Upcoming Movies', now_playing: 'Now Playing' },
    tv: { popular: 'Popular TV', top_rated: 'Top Rated TV', on_the_air: 'On The Air', airing_today: 'Airing Today' },
    anime: { 'tv-anime': 'Anime Series', 'movie-anime': 'Anime Movies' },
  };

  const TABS = {
    home: [['trending', 'Trending'], ['popular-movie', 'Movies'], ['popular-tv', 'TV'], ['top', 'Top Rated']],
    movie: [['popular', 'Popular'], ['top_rated', 'Top Rated'], ['upcoming', 'Upcoming'], ['now_playing', 'Now Playing']],
    tv: [['popular', 'Popular'], ['top_rated', 'Top Rated'], ['on_the_air', 'On Air'], ['airing_today', 'Airing Today']],
    anime: [['tv-anime', 'Anime Series'], ['movie-anime', 'Anime Movies']],
  };

  function headingFor(mode, subTab) {
    if (mode === 'home') return TITLES.home[subTab] || TITLES.home.top;
    if (mode === 'movie') return TITLES.movie[subTab];
    if (mode === 'tv') return TITLES.tv[subTab];
    if (mode === 'anime') return subTab === 'tv-anime' ? TITLES.anime['tv-anime'] : TITLES.anime['movie-anime'];
    return '';
  }

  /* ---------------- generic list page ---------------- */

  // Renders heading + tabs + grid + pager + hero. Returns the hero item
  // (first result on page 1) so the controller can wire hero-play/list.
  // ctx: { mode, subTab, page, items, isInList(id, mt), onTab(subTab) }
  function renderList(ctx) {
    const c = C();
    c.setSectionTitle(headingFor(ctx.mode, ctx.subTab));
    c.setPageLabel(ctx.page);
    c.renderTabs(TABS[ctx.mode] || [], ctx.subTab, ctx.onTab);
    const items = Array.isArray(ctx.items) ? ctx.items : [];
    $('grid').innerHTML = c.cardsHTML(items, ctx.isInList) || '<div class="text-zinc-500">No results.</div>';
    if (ctx.page === 1 && items[0]) {
      c.setHero(items[0]);
      return items[0];
    }
    c.clearHeroLoading();
    return null;
  }

  function renderListLoading(page) {
    const c = C();
    c.setNotice('');
    c.showGridLoading(12);
    c.setHeroLoading(page === 1);
  }

  // Instant heading + tabs before the fetch resolves (pre-refactor load()
  // painted tabs synchronously, then filled the grid when data arrived).
  function renderListChrome(mode, subTab, onTab) {
    const c = C();
    c.setSectionTitle(headingFor(mode, subTab));
    c.renderTabs(TABS[mode] || [], subTab, onTab);
  }

  function renderListError(err, page) {
    const c = C();
    $('grid').innerHTML = '';
    c.clearHeroLoading();
    if (page === 1) c.showHeroError(err && err.message ? err.message : String(err));
    c.showErrorNotice(err);
  }

  /* ---------------- search page ---------------- */

  // ctx: { query, page, items, isInList }
  function renderSearch(ctx) {
    const c = C();
    c.setSectionTitle(ctx.query ? `Results for “${ctx.query}”` : 'Search');
    c.clearTabs();
    c.setPageLabel(ctx.page);
    c.clearHeroLoading();
    if (!ctx.query) {
      $('grid').innerHTML = '<div class="text-zinc-500 col-span-full">Type in the search box above, or open a URL like <code>/search?q=dune</code>.</div>';
      return;
    }
    const items = Array.isArray(ctx.items) ? ctx.items : [];
    $('grid').innerHTML = c.cardsHTML(items, ctx.isInList) || '<div class="text-zinc-500">No matches.</div>';
  }

  function renderSearchLoading(query) {
    const c = C();
    c.setNotice('');
    c.setSectionTitle(query ? `Results for “${query}”` : 'Search');
    c.clearTabs();
    c.showGridLoading(12);
    c.setHeroLoading(false);
    c.clearHeroLoading();
  }

  function renderSearchError(err) {
    const c = C();
    $('grid').innerHTML = '';
    c.showErrorNotice(err);
  }

  /* ---------------- my list page ---------------- */

  function renderMyList(items, isInList) {
    const c = C();
    c.setSectionTitle('My List');
    c.clearTabs();
    $('grid').innerHTML = '';
    const list = Array.isArray(items) ? items : [];
    $('grid').innerHTML = list.length
      ? c.cardsHTML(list, isInList)
      : '<div class="text-zinc-500 col-span-full">Empty. Hover a poster and hit ☆, or open details → + My List. Stored locally in your browser.</div>';
    c.clearHeroLoading();
  }

  /* ---------------- homepage shelves (config-driven, same card style) ---------------- */

  // Renders resolved config sections below the main grid. Same heading sizes,
  // same .card grid as the main section — the style is reused, not redesigned.
  // resolved: [{ section: {id,title,description}, items, collection? }] in
  // config order. Empty shelves render nothing (a bad query shouldn't leave
  // holes). Sections with source { type: 'collection', slug } get an optional
  // "View All →" link to the SAME collection (/collection/:slug) — the preview
  // above already resolved through resolveCollection, so no second list system.
  // Sections without a collection keep the current header with no link.
  function homeSectionHref(r) {
    const s = (r && r.section) || {};
    const src = (s.source && typeof s.source === 'object') ? s.source : null;
    let slug = '';
    if (r && r.collection && typeof r.collection.slug === 'string') slug = r.collection.slug;
    else if (src && src.type === 'collection' && typeof src.slug === 'string') slug = src.slug;
    else return '';
    slug = String(slug).trim().toLowerCase();
    if (!slug || slug.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return '';
    try {
      if (window.Router && window.Router.url && typeof window.Router.url.collection === 'function') {
        return window.Router.url.collection(slug);
      }
    } catch { /* fall through to plain path */ }
    return '/collection/' + slug;
  }

  function renderHomeSections(resolved, isInList) {
    const c = C();
    const host = $('home-sections');
    if (!host) return;
    const list = Array.isArray(resolved) ? resolved : [];
    host.innerHTML = list
      .filter((r) => r && r.section && (r.items || []).length)
      .map((r) => {
        const s = r.section;
        const domId = 'home-section-' + String(s.id).replace(/[^a-z0-9-_]/gi, '-');
        const href = homeSectionHref(r);
        const viewAll = href
          ? `<a href="${c.escapeHtml(href)}" class="text-sm text-zinc-400 hover:text-white shrink-0 ml-4 whitespace-nowrap">View All →</a>`
          : '';
        return `<section class="mt-8" id="${c.escapeHtml(domId)}">` +
          `<div class="flex items-end justify-between mb-3"><h2 class="text-xl font-bold">${c.escapeHtml(s.title)}</h2>${viewAll}</div>` +
          (s.description ? `<p class="text-sm text-zinc-400 -mt-1 mb-3">${c.escapeHtml(s.description)}</p>` : '') +
          `<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">${c.cardsHTML(r.items, isInList)}</div>` +
          `</section>`;
      }).join('');
  }

  function clearHomeSections() {
    const host = $('home-sections');
    if (host) host.innerHTML = '';
  }

  /* ---------------- footer navigation (config-driven collections) ---------------- */

  // Renders footer collection links from [{ href, label }]. Labels use
  // textContent (never innerHTML), so config titles cannot inject markup.
  // Empty/invalid lists hide the whole Collections column instead of leaving
  // a dead heading. Styling matches the static footer links in index.html.
  function renderFooterCollections(links) {
    const host = $('footer-collections');
    const section = $('footer-collections-section');
    if (!host || !section) return;
    host.innerHTML = '';
    const list = (Array.isArray(links) ? links : []).filter((l) => l && typeof l.href === 'string' && l.href);
    if (!list.length) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    for (const l of list) {
      const a = document.createElement('a');
      a.href = l.href;
      a.textContent = typeof l.label === 'string' && l.label ? l.label : l.href;
      a.className = 'block mt-2 hover:text-white';
      host.appendChild(a);
    }
  }

  /* ---------------- Greybox collection page (config order, shared grid shell) ---------------- */

  // Renders a resolved collection into the standard list shell (#grid):
  // title header, optional cover banner + description + metadata line, then
  // cards in Greybox config order. Reuses .card markup and col-span-full
  // message blocks exactly like search/mylist — no new layout.
  // ctx: { collection: {title, description, cover, meta}, items, isInList(id, mt) }
  function renderCollection(ctx) {
    const c = C();
    const col = (ctx && ctx.collection) || {};
    c.setSectionTitle(col.title || 'Collection');
    c.clearTabs();
    c.setPageLabel(1);
    c.clearHeroLoading();
    const items = Array.isArray(ctx.items) ? ctx.items : [];
    let head = '';
    if (col.cover) {
      head += `<div class="col-span-full overflow-hidden rounded-2xl border border-white/10"><img src="${c.escapeHtml(col.cover)}" alt="" loading="lazy" class="w-full h-48 md:h-64 object-cover"/></div>`;
    }
    if (col.description) {
      head += `<p class="col-span-full text-sm text-zinc-400">${c.escapeHtml(col.description)}</p>`;
    }
    const metaBits = [];
    if (col.meta && col.meta.curator) metaBits.push('Curated by ' + col.meta.curator);
    if (col.meta && col.meta.updated) metaBits.push('Updated ' + col.meta.updated);
    if (metaBits.length) {
      head += `<p class="col-span-full text-xs text-zinc-500">${c.escapeHtml(metaBits.join(' · '))}</p>`;
    }
    $('grid').innerHTML = head + (c.cardsHTML(items, ctx.isInList) || '<div class="text-zinc-500 col-span-full">No titles available in this collection right now.</div>');
    if (items[0]) c.setHero(items[0]);
  }

  function renderCollectionLoading(title) {
    const c = C();
    c.setNotice('');
    c.setSectionTitle(title || 'Collection');
    c.clearTabs();
    c.showGridLoading(12);
    c.setHeroLoading(false);
    c.clearHeroLoading();
  }

  function renderCollectionError(err) {
    const c = C();
    $('grid').innerHTML = '';
    c.showErrorNotice(err);
  }

  /* ---------------- not found ---------------- */

  function renderNotFound(path) {
    const c = C();
    c.hideModal();
    try { if (window.GreyboxHero && typeof window.GreyboxHero.reset === 'function') window.GreyboxHero.reset(); } catch (e) { /* hero optional */ }
    c.setSectionTitle('Not found');
    c.clearTabs();
    $('grid').innerHTML = `<div class="text-zinc-400 col-span-full">No page at <code>${c.escapeHtml(path || '')}</code>. <a class="text-red-400 underline" href="/" data-route>Back to home</a></div>`;
    c.clearHeroLoading();
    $('hero-badge').textContent = '404';
    $('hero-title').textContent = 'That URL does not exist';
    $('hero-overview').textContent = 'Check /movies, /tv, /movie/:id, /tv/:id, /search?q=..., or /person/:id.';
    c.setPageLabel(1);
  }

  /* ---------------- title detail (movie + tv share one shell) ---------------- */

  function detailMeta(d) {
    return `${(d.release_date || d.first_air_date || '').slice(0, 4)} · ⭐ ${Number(d.vote_average || 0).toFixed(1)} · ${(d.genres || []).join(', ')}`;
  }

  // Fills the modal shell from an already-fetched Greybox detail bundle.
  // Returns nothing — the controller wires trailer/watch/list afterwards.
  // ctx: { detail, mediaType: 'movie'|'tv', inList: bool }
  function renderTitleDetail(ctx) {
    const c = C();
    const d = ctx.detail;
    c.setModalActionsVisible(true);
    c.showModal();
    c.showDetailLoading();
    const title = d.title || d.name || 'Untitled';
    $('m-title').textContent = title;
    $('m-meta').textContent = detailMeta(d);
    if (d.custom_badge) $('m-meta').textContent += ' · ' + d.custom_badge;
    $('m-overview').textContent = d.overview || 'No overview.';
    $('m-backdrop').src = d.backdrop_path ? c.IMG_BIG + d.backdrop_path : (d.poster_path ? c.IMG + d.poster_path : '');
    $('m-list').textContent = ctx.inList ? '★ In My List' : '+ My List';
    renderCast(d.cast || []);
    renderProviders(d.providers, ctx.region);
  }

  function renderCast(castList) {
    const c = C();
    try {
      $('m-cast').innerHTML = castList.slice(0, 12).map((cast) =>
        `<div class="min-w-[90px] text-center"><img class="w-[90px] h-[120px] object-cover rounded-lg" loading="lazy" src="${cast.profile_path ? c.IMG + cast.profile_path : 'https://via.placeholder.com/90x120?text=?'}"/><div class="mt-1 font-semibold truncate">${c.escapeHtml(cast.name)}</div><div class="text-zinc-500 truncate">${c.escapeHtml(cast.character || '')}</div></div>`).join('') || '—';
    } catch (err) {
      console.warn('[detail] cast failed', err);
      $('m-cast').textContent = '—';
    }
  }

  function renderProviders(p, region) {
    const c = C();
    try {
      const hasOffer = p && (p.flatrate.length || p.rent.length || p.buy.length || p.link);
      $('m-providers').innerHTML = hasOffer
        ? `${p.flatrate?.length ? '<b>Stream:</b> ' + p.flatrate.map(c.escapeHtml).join(', ') + '<br/>' : ''}${p.rent?.length ? '<b>Rent:</b> ' + p.rent.map(c.escapeHtml).join(', ') + '<br/>' : ''}${p.buy?.length ? '<b>Buy:</b> ' + p.buy.map(c.escapeHtml).join(', ') : ''}${p.link ? `<br/><a class="text-red-400 underline" target="_blank" href="${p.link}">Open JustWatch/TMDB guide ↗</a>` : ''}`
        : `No legal offer found for region ${region}. Change region in Settings ⚙️.`;
    } catch (err) {
      console.warn('[detail] providers failed', err);
      $('m-providers').textContent = 'Provider lookup failed.';
    }
  }

  /* ---------------- seasons + episodes ---------------- */

  // Fills the season <select>; returns the resolved season number (prefers 1).
  function renderSeasons(seasons) {
    const c = C();
    const list = (Array.isArray(seasons) ? seasons : []).filter((s) => s.season_number >= 0);
    if (!list.length) return null;
    $('m-tv-wrap').classList.remove('hidden');
    $('m-season').innerHTML = list.map((s) => `<option value="${s.season_number}">${c.escapeHtml(s.name)} (${s.episode_count} eps)</option>`).join('');
    const current = (list.find((s) => s.season_number === 1) || list[0]).season_number;
    $('m-season').value = String(current);
    return current;
  }

  function renderEpisodesLoading() {
    $('m-episodes').innerHTML = window.GreyboxComponents.inlineLoader('Loading episodes…');
  }

  function renderEpisodesError() {
    $('m-episodes').innerHTML = '<div class="text-sm text-red-300">Could not load episodes.</div>';
  }

  // ctx: { tmdbId, seasonNum, episodes, configured: bool, resumeLabel(key): string|null, onPlay(ep) }
  function renderEpisodes(ctx) {
    const c = C();
    const eps = Array.isArray(ctx.episodes) ? ctx.episodes : [];
    $('m-episodes').innerHTML = eps.map((ep) => {
      const resume = typeof ctx.resumeLabel === 'function'
        ? ctx.resumeLabel(`tv:${ctx.tmdbId}:${ctx.seasonNum}:${ep.episode_number}`)
        : null;
      return `<div class="flex gap-3 bg-white/5 border border-white/10 rounded-xl p-3">
        <img class="w-32 h-[72px] object-cover rounded-lg shrink-0" loading="lazy"
          src="${ep.still_path ? c.IMG + ep.still_path : 'https://via.placeholder.com/128x72?text=No+Still'}" alt=""/>
        <div class="min-w-0 flex-1">
          <div class="text-sm font-bold truncate">E${ep.episode_number} · ${c.escapeHtml(ep.name || 'Episode')}</div>
          <div class="text-xs text-zinc-400 line-clamp-3 mt-0.5">${c.escapeHtml(ep.overview || '')}</div>
          <div class="text-xs text-zinc-500 mt-1">${ep.runtime ? ep.runtime + ' min · ' : ''}${ep.air_date || ''}${resume ? ' · <span class="text-emerald-300">' + resume + '</span>' : ''}</div>
        </div>
        <button class="self-center shrink-0 px-4 py-2 rounded-lg font-bold text-sm ${ctx.configured ? 'bg-red-600 hover:bg-red-500' : 'bg-white/10 text-zinc-400'}"
          data-season="${ctx.seasonNum}" data-ep="${ep.episode_number}">▶</button>
      </div>`;
    }).join('') || '<div class="text-sm text-zinc-500">No episodes listed.</div>';
    $('m-episodes').querySelectorAll('button[data-ep]').forEach((b) => {
      b.onclick = () => {
        const ep = eps.find((x) => x.episode_number === +b.dataset.ep);
        if (ep && typeof ctx.onPlay === 'function') ctx.onPlay(ep);
      };
    });
  }

  /* ---------------- person ---------------- */

  // ctx: { person, knownFor, onSelect(id, mediaType) }
  function renderPerson(ctx) {
    const c = C();
    const person = ctx.person || {};
    const id = person.id;
    c.setModalActionsVisible(false);
    c.showModal();
    c.showPersonLoading();
    $('m-title').textContent = person.name || 'Untitled';
    const facts = [person.known_for_department || '', person.birthday || '', person.place_of_birth || ''].filter(Boolean).join(' · ');
    $('m-meta').textContent = facts || 'Person';
    $('m-overview').textContent = person.biography || 'No biography on TMDB.';
    $('m-backdrop').src = person.profile_path ? c.IMG_BIG + person.profile_path : '';
    $('m-providers').innerHTML =
      `${person.birthday ? '<b>Born:</b> ' + c.escapeHtml(person.birthday) + (person.place_of_birth ? ' in ' + c.escapeHtml(person.place_of_birth) : '') + '<br/>' : ''}` +
      `${person.known_for_department ? '<b>Known for:</b> ' + c.escapeHtml(person.known_for_department) + '<br/>' : ''}` +
      `<a class="text-red-400 underline" target="_blank" href="https://www.themoviedb.org/person/${id}">Open on TMDB ↗</a>`;
    const known = Array.isArray(ctx.knownFor) ? ctx.knownFor : [];
    $('m-cast').innerHTML = known.map((x) => {
      const mt = x.media_type;
      const title = x.title || x.name || 'Untitled';
      return `<div class="min-w-[90px] text-center cursor-pointer known-for" data-id="${x.id}" data-type="${mt}"><img class="w-[90px] h-[120px] object-cover rounded-lg" loading="lazy" src="${x.poster_path ? c.IMG + x.poster_path : 'https://via.placeholder.com/90x120?text=?'}"/><div class="mt-1 font-semibold truncate">${c.escapeHtml(title)}</div><div class="text-zinc-500 truncate">${mt === 'movie' ? 'Movie' : 'TV'}</div></div>`;
    }).join('') || '—';
    $('m-cast').querySelectorAll('.known-for').forEach((el) => {
      el.onclick = () => { if (typeof ctx.onSelect === 'function') ctx.onSelect(+el.dataset.id, el.dataset.type); };
    });
  }

  window.GreyboxPages = {
    headingFor,
    renderList,
    renderListLoading,
    renderListChrome,
    renderListError,
    renderSearch,
    renderSearchLoading,
    renderSearchError,
    renderMyList,
    renderNotFound,
    renderCollection,
    renderCollectionLoading,
    renderCollectionError,
    renderHomeSections,
    clearHomeSections,
    renderFooterCollections,
    renderTitleDetail,
    renderCast,
    renderProviders,
    renderSeasons,
    renderEpisodesLoading,
    renderEpisodesError,
    renderEpisodes,
    renderPerson,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = window.GreyboxPages;
})();
