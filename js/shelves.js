/* Greybox Phase 4 — shelf carousel behavior. Vanilla JS, no dependency.
 *
 * Owns ONLY shelf interaction: prev/next arrows (scroll + disabled state),
 * edge-fade bookkeeping, and card keyboard activation. No fetching, no
 * routing, no data changes — card clicks still flow through the existing
 * app.js delegation untouched. All wiring is delegated, so re-rendered
 * shelves keep working with zero per-render binding. */
(function () {
  'use strict';

  var rafPending = false;

  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  }

  function viewportOf(el) {
    try {
      if (el && el.closest) return el.closest('.gx-shelf-viewport');
    } catch (e) { /* noop */ }
    return null;
  }

  /* Arrow enabled state + edge fades for one shelf viewport. */
  function refresh(viewport) {
    if (!viewport) return;
    var track = null;
    try { track = viewport.querySelector('.gx-shelf-track'); } catch (e) { track = null; }
    if (!track) return;
    var overflow = false;
    var atStart = true;
    var atEnd = true;
    try {
      overflow = track.scrollWidth > track.clientWidth + 2;
      atStart = track.scrollLeft <= 2;
      atEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - 2;
    } catch (e) { /* keep defaults */ }
    try {
      viewport.setAttribute('data-overflow', overflow ? 'true' : 'false');
      viewport.setAttribute('data-at-start', atStart ? 'true' : 'false');
      viewport.setAttribute('data-at-end', atEnd ? 'true' : 'false');
      var btns = viewport.querySelectorAll('.gx-shelf-btn');
      for (var i = 0; i < btns.length; i++) {
        var dir = btns[i].getAttribute('data-dir');
        btns[i].disabled = !overflow || (dir === 'prev' ? atStart : atEnd);
      }
    } catch (e) { /* noop */ }
  }

  function refreshAll() {
    var vps = null;
    try { vps = document.querySelectorAll('.gx-shelf-viewport'); } catch (e) { return; }
    for (var i = 0; i < vps.length; i++) refresh(vps[i]);
  }

  function scheduleRefresh(viewport) {
    if (rafPending) return;
    rafPending = true;
    function run() {
      rafPending = false;
      refresh(viewport);
    }
    try {
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run);
      else setTimeout(run, 0);
    } catch (e) { rafPending = false; }
  }

  function scrollShelf(viewport, dir) {
    var track = null;
    try { track = viewport.querySelector('.gx-shelf-track'); } catch (e) { track = null; }
    if (!track) return;
    var amount = 0;
    try { amount = Math.max(track.clientWidth * 0.85, 200); } catch (e) { amount = 320; }
    try {
      track.scrollBy({ left: dir * amount, behavior: reducedMotion() ? 'auto' : 'smooth' });
    } catch (e) {
      try { track.scrollLeft += dir * amount; } catch (ignored) { /* noop */ }
    }
    scheduleRefresh(viewport);
  }

  function bind() {
    // Arrow buttons (real <button>s, delegated so re-renders just work).
    document.addEventListener('click', function (e) {
      if (!e.target || !e.target.closest) return;
      // Keep the card star's amber state in sync after the app toggles it
      // (app.js flips textContent synchronously; we read it right after).
      var lb = e.target.closest('.list-btn');
      if (lb) {
        setTimeout(function () {
          try { lb.classList.toggle('is-in-list', lb.textContent.trim().indexOf('★') === 0); }
          catch (err) { /* noop */ }
        }, 0);
      }
      var btn = e.target.closest('.gx-shelf-btn');
      if (!btn || btn.disabled) return;
      var viewport = viewportOf(btn);
      if (!viewport) return;
      scrollShelf(viewport, btn.getAttribute('data-dir') === 'prev' ? -1 : 1);
    });

    // Scroll position -> arrow state + edge fades (scroll doesn't bubble).
    document.addEventListener('scroll', function (e) {
      if (!e.target || !e.target.classList || !e.target.classList.contains('gx-shelf-track')) return;
      var viewport = viewportOf(e.target);
      if (viewport) scheduleRefresh(viewport);
    }, true);

    // Card keyboard activation: Enter/Space on the card routes through the
    // existing app.js click delegation. Inner buttons keep native behavior.
    document.addEventListener('keydown', function (e) {
      if ((e.key !== 'Enter' && e.key !== ' ') || !e.target || !e.target.closest) return;
      var card = e.target.closest('.card[data-id]');
      if (!card || e.target.closest('.list-btn')) return;
      if (e.target !== card) return;
      e.preventDefault();
      try { card.click(); } catch (err) { /* noop */ }
    });

    window.addEventListener('resize', refreshAll);

    // Freshly rendered shelves get correct initial arrow state.
    try {
      var host = document.getElementById('home-sections');
      if (host && typeof MutationObserver !== 'undefined') {
        var mo = new MutationObserver(function () { refreshAll(); });
        mo.observe(host, { childList: true });
      }
    } catch (e) { /* observer optional */ }

    refreshAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  try {
    window.GreyboxShelves = { refresh: refresh, refreshAll: refreshAll };
  } catch (e) { /* noop */ }
})();
