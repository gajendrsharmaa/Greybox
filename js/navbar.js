/* Greybox Phase 1 navbar behavior — scroll elevation + mobile drawer.
 * Lightweight, no dependency. Preserves router/search/collections wiring:
 * this file only toggles classes + aria state, never navigates or fetches. */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var SCROLL_AT = 12;
  var DESKTOP_AT = 860;

  /* ---------- scroll: transparent at top, readable after scroll ---------- */
  var header = null;
  var ticking = false;

  function syncScrolled() {
    if (!header) return;
    var y = 0;
    try { y = window.scrollY || window.pageYOffset || 0; } catch (e) { y = 0; }
    header.classList.toggle('is-scrolled', y > SCROLL_AT);
    ticking = false;
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    try {
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(syncScrolled);
      else setTimeout(syncScrolled, 0);
    } catch (e) { ticking = false; }
  }

  /* ---------- mobile drawer ---------- */
  function isOpen() {
    var panel = $('mobile-menu');
    return !!panel && !panel.classList.contains('hidden');
  }

  function setToggle(expanded) {
    var btn = $('nav-toggle');
    if (!btn) return;
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    btn.setAttribute('aria-label', expanded ? 'Close menu' : 'Open menu');
  }

  function collapseInnerCollections() {
    // Keep collections-nav.js as the owner of its own panel; we only reset
    // its visible state so a reopened drawer starts collapsed.
    var inner = $('mobile-collections');
    var btn = $('collections-btn-mobile');
    if (inner) inner.classList.add('hidden');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function open(focusFirst) {
    var panel = $('mobile-menu');
    if (!panel || isOpen()) return;
    panel.classList.remove('hidden');
    panel.classList.remove('open');
    try { void panel.offsetWidth; } catch (e) { /* noop */ }
    panel.classList.add('open');
    setToggle(true);
    if (focusFirst) {
      var first = panel.querySelector('.gx-mobile-nav .nav-btn');
      if (first) { try { first.focus(); } catch (e) { /* noop */ } }
    }
  }

  function close(returnFocus) {
    var panel = $('mobile-menu');
    if (!panel || !isOpen()) return;
    panel.classList.add('hidden');
    panel.classList.remove('open');
    setToggle(false);
    collapseInnerCollections();
    if (returnFocus) {
      var btn = $('nav-toggle');
      if (btn) { try { btn.focus(); } catch (e) { /* noop */ } }
    }
  }

  function toggle() { if (isOpen()) close(false); else open(false); }

  function bind() {
    header = $('site-header');
    var btn = $('nav-toggle');
    var panel = $('mobile-menu');

    if (btn && panel) {
      btn.addEventListener('click', function () { toggle(); });
    }

    // Choosing any destination inside the drawer dismisses it;
    // the SPA router (or native anchor) still handles navigation.
    if (panel) {
      panel.addEventListener('click', function (e) {
        if (!e.target || !e.target.closest) return;
        if (e.target.closest('[data-nav], a[href]')) close(false);
      });
    }

    // Click outside the header closes (toggle itself is inside, so it is safe).
    document.addEventListener('click', function (e) {
      if (!isOpen()) return;
      if (e.target && e.target.closest && e.target.closest('#site-header')) return;
      close(false);
    });

    // Escape closes and returns focus to the trigger.
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      if (isOpen()) { e.preventDefault(); close(true); }
    });

    // Reaching desktop layout with an open drawer: reset to closed.
    var mq = null;
    try { mq = window.matchMedia('(min-width: ' + DESKTOP_AT + 'px)'); } catch (e) { mq = null; }
    function onViewport() {
      try {
        if (window.innerWidth >= DESKTOP_AT && isOpen()) close(false);
      } catch (e) { /* noop */ }
    }
    try {
      if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', onViewport);
      else if (mq && typeof mq.addListener === 'function') mq.addListener(onViewport);
    } catch (e) { /* noop */ }
    window.addEventListener('resize', onViewport);

    // Route changes dismiss the drawer and refresh scroll state.
    try {
      if (window.Router && typeof window.Router.onChange === 'function') {
        window.Router.onChange(function () { close(false); syncScrolled(); });
      }
    } catch (e) { /* router optional */ }

    window.addEventListener('scroll', onScroll, { passive: true });
    syncScrolled();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  try {
    window.GreyboxNavbar = {
      isOpen: isOpen,
      open: open,
      close: close,
      toggle: toggle,
      SCROLL_AT: SCROLL_AT,
    };
  } catch (e) { /* noop */ }
})();
