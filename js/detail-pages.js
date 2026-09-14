/* Greybox detail page presentation — config-driven visibility (Detail Pages V1).
 *
 * Source of truth: window.GreyboxData.getDetailPagesConfig() (D1 via
 * /api/config/detail-pages once preloaded, else js/detail-pages.config.js —
 * every flag defaults to shown, so a missing config renders exactly the
 * current detail page).
 *
 * This file only APPLIES that config to the existing detail modal. It is
 * NOT a second renderer: it wraps the four existing GreyboxPages entry
 * points (renderTitleDetail, renderSeasons, renderEpisodes, renderPerson)
 * in place — same object app.js already calls, so no caller changes — and
 * adjusts visibility around the original render:
 *   - renderTitleDetail: original fills the shell, then sections flagged
 *     off are hidden (backdrop, poster, badge + tag badges, title, meta
 *     line, rating/genres segments inside the meta line, synopsis, Watch /
 *     Trailer / My List buttons, where-to-watch, cast).
 *   - renderSeasons / renderEpisodes (TV only; movies never reach them):
 *     episode preferences are folded into a COPY of the episodes context
 *     (never the controller's arrays), and the section stays hidden when
 *     flagged off. Season selection, episode loading, playback, routing
 *     and resume state are untouched.
 *   - renderPerson: person pages are outside V1 scope and always render
 *     full — the wrapper resets any display state a previous title render
 *     may have left behind.
 *
 * Blocked Titles always win: blocking is enforced in js/data.js
 * getMovie/getTVDetails before any rendering, so this layer only ever sees
 * resolved, allowed titles — no flag here can render blocked content. The
 * error state (showDetailError) is never wrapped and always renders full.
 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function getCfg() {
    try {
      if (window.GreyboxData && typeof window.GreyboxData.getDetailPagesConfig === 'function') {
        return window.GreyboxData.getDetailPagesConfig();
      }
    } catch (e) { /* fall through to null (all-shown) */ }
    return null;
  }

  // One flag lookup for the whole layer: anything unexpected (no config,
  // no group, non-boolean) reads as shown, so the detail page can only
  // ever degrade to its current appearance — never to a blank page.
  function flag(cfg, group, key) {
    try {
      if (!cfg || !cfg[group]) return true;
      return cfg[group][key] !== false;
    } catch (e) { return true; }
  }

  function show(elm, on) {
    if (!elm) return;
    try { elm.style.display = on ? '' : 'none'; } catch (e) { /* noop */ }
  }

  // Hide-only for artwork: the original renderer already decides
  // show-vs-hide from data (no art = hidden), so a shown flag must never
  // force-display an artwork-less img — it only skips the hide.
  function hideArt(id, on) {
    if (on) return;
    show($(id), false);
  }

  // Meta-line segments without duplicating renderer logic: the rendered
  // line is `year · Movie|TV Show · ⭐ x.x · genres`. Year/type segments
  // are classified by shape; the star segment is the rating; anything else
  // trailing is the genre list. Pure (text in, text out) for tests.
  function filterMetaText(text, cfg) {
    const parts = String(text == null ? '' : text).split(' · ').filter((s) => s !== '');
    if (!parts.length) return '';
    const keepRating = flag(cfg, 'header', 'rating');
    const keepGenres = flag(cfg, 'header', 'genres');
    if (keepRating && keepGenres) return parts.join(' · ');
    const out = [];
    for (const seg of parts) {
      const s = String(seg);
      if (/^\d{4}$/.test(s) || s === 'Movie' || s === 'TV Show') { out.push(s); continue; }
      if (s.charAt(0) === '⭐') { if (keepRating) out.push(s); continue; }
      if (keepGenres) out.push(s);
    }
    return out.join(' · ');
  }

  function applyTitle(ctx) {
    if (!ctx || !ctx.detail) return false;
    const cfg = getCfg();
    hideArt('m-backdrop', flag(cfg, 'header', 'backdrop'));
    hideArt('m-poster', flag(cfg, 'header', 'poster'));
    const badgeOn = flag(cfg, 'header', 'badge');
    show($('m-badge'), badgeOn);
    try {
      const badge = $('m-badge');
      const head = badge && badge.parentElement ? badge.parentElement : null;
      if (head) head.querySelectorAll('.gx-detail-tagbadge').forEach((n) => { show(n, badgeOn); });
    } catch (e) { /* badges are decorative */ }
    show($('m-title'), flag(cfg, 'header', 'title'));
    const metaEl = $('m-meta');
    if (flag(cfg, 'header', 'meta')) {
      show(metaEl, true);
      try { if (metaEl) metaEl.textContent = filterMetaText(metaEl.textContent, cfg); } catch (e) { /* keep line as-is */ }
    } else {
      show(metaEl, false);
    }
    show($('m-overview'), flag(cfg, 'header', 'overview'));
    show($('m-watch'), flag(cfg, 'actions', 'watch'));
    show($('m-trailer'), flag(cfg, 'actions', 'trailer'));
    show($('m-list'), flag(cfg, 'actions', 'myList'));
    const provOn = flag(cfg, 'content', 'providers');
    show($('m-providers'), provOn);
    show($('m-providers-head'), provOn);
    const castOn = flag(cfg, 'content', 'cast');
    show($('m-cast'), castOn);
    show($('m-cast-head'), castOn);
    return true;
  }

  // Episodes preferences folded into a COPY of the context: the original
  // renderer paints from the copy while the controller's arrays, resume
  // wiring and playback callbacks stay exactly as passed in. Resume state
  // always stays (it is functional, not presentational).
  function episodesCtx(ctx, cfg) {
    const epsOn = flag(cfg, 'tv', 'episodes');
    const ovOn = flag(cfg, 'tv', 'episodeOverview');
    const metaOn = flag(cfg, 'tv', 'episodeMeta');
    if (epsOn && ovOn && metaOn) return ctx;
    try {
      const eps = Array.isArray(ctx && ctx.episodes) ? ctx.episodes : [];
      return Object.assign({}, ctx, {
        episodes: epsOn ? eps.map((ep) => {
          const o = Object.assign({}, ep);
          if (!ovOn) o.overview = '';
          if (!metaOn) { o.runtime = null; o.air_date = ''; }
          return o;
        }) : [],
      });
    } catch (e) { return ctx; }
  }

  function hideTvWrap() {
    const w = $('m-tv-wrap');
    if (w) w.classList.add('hidden');
  }

  function resetPersonShell() {
    // Person pages always render full: undo any display state a previous
    // title render left on the shared shell (artwork + badge + actions are
    // owned by renderPerson itself and left alone here).
    ['m-title', 'm-meta', 'm-overview', 'm-cast', 'm-providers', 'm-providers-head', 'm-cast-head']
      .forEach((id) => show($(id), true));
  }

  function boot() {
    try {
      const P = window.GreyboxPages;
      if (!P || P.__dpWrapped) return;
      if (typeof P.renderTitleDetail === 'function') {
        const orig = P.renderTitleDetail;
        P.renderTitleDetail = function (ctx) {
          const r = orig.apply(this, arguments);
          try { applyTitle(ctx); } catch (e) { /* config must never break render */ }
          return r;
        };
      }
      if (typeof P.renderSeasons === 'function') {
        const orig = P.renderSeasons;
        P.renderSeasons = function (seasons) {
          const r = orig.apply(this, arguments);
          try { if (!flag(getCfg(), 'tv', 'episodes')) hideTvWrap(); } catch (e) { /* noop */ }
          return r;
        };
      }
      if (typeof P.renderEpisodes === 'function') {
        const orig = P.renderEpisodes;
        P.renderEpisodes = function (ctx) {
          let cfg = null;
          let useCtx = ctx;
          try { cfg = getCfg(); useCtx = episodesCtx(ctx, cfg); } catch (e) { useCtx = ctx; }
          const r = orig.call(this, useCtx);
          try { if (!flag(cfg, 'tv', 'episodes')) hideTvWrap(); } catch (e) { /* noop */ }
          return r;
        };
      }
      if (typeof P.renderPerson === 'function') {
        const orig = P.renderPerson;
        P.renderPerson = function (ctx) {
          const r = orig.apply(this, arguments);
          try { resetPersonShell(); } catch (e) { /* noop */ }
          return r;
        };
      }
      P.__dpWrapped = true;
    } catch (e) { /* presentation layer must never break boot */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Headless/test hook (no UI effect beyond the wraps above).
  try {
    window.GreyboxDetailPagesApply = {
      getConfig: getCfg,
      flag: flag,
      filterMetaText: filterMetaText,
      applyTitle: applyTitle,
      episodesCtx: episodesCtx,
      boot: boot,
    };
  } catch (e) { /* noop */ }
})();
