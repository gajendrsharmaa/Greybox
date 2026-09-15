/* Greybox public navigation applier — config-driven navbar (Navigation V1).
 *
 * Source of truth: window.GreyboxData.getNavigationConfig() (D1 via
 * /api/config/navigation once preloaded with cache:no-store, else
 * js/navigation.config.js).
 * This file only RENDERS that config into the existing navbar + footer:
 *   - labels: the leading text of each nav button (badges, counts, icons
 *     and data-nav wiring are never touched)
 *   - order: DOM order of the desktop + mobile nav entries follows config
 *     order (existing buttons are moved, never rebuilt — all app.js /
 *     router listeners stay attached)
 *   - visibility: hidden entries get hidden (recoverable in Admin — the
 *     nodes stay in the DOM; only their display changes). Footer Browse
 *     links mirror the same visibility/labels so a hidden entry disappears
 *     everywhere, not just the header.
 *   - header search: the separate searchVisible flag toggles .gx-search
 *
 * No admin logic here, no fetching here, no routing changes here. My List
 * storage/count behavior, search suggestions behavior and the collections
 * dropdown contents are all untouched — only entry visibility/labels/order
 * change. If the config cannot be loaded, the static navbar (which already
 * matches the defaults) is left exactly as-is — a config failure never
 * makes the site unusable.
 */
(function () {
  'use strict';

  function data() {
    try {
      if (window.GreyboxData && typeof window.GreyboxData.getNavigationConfig === 'function') {
        return window.GreyboxData.getNavigationConfig();
      }
    } catch (e) { /* fall through to null */ }
    return null;
  }

  function $(id) { return document.getElementById(id); }

  function showEl(elm, show) {
    if (!elm) return;
    try {
      if (show) {
        elm.hidden = false;
        if (elm.style) elm.style.display = '';
      } else {
        elm.hidden = true;
        if (elm.style) elm.style.display = 'none';
      }
    } catch (e) { /* noop */ }
  }

  // Replace the leading text node of a nav button, preserving child nodes
  // (the My List count badge, the Collections chevron svg, …).
  function setButtonLabel(btn, label) {
    if (!btn || typeof label !== 'string') return;
    var text = label.trim();
    if (!text) return;
    try {
      var nodes = btn.childNodes;
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].nodeType === 3 && String(nodes[i].textContent || '').trim()) {
          var after = / $/.test(nodes[i].textContent) ? ' ' : '';
          nodes[i].textContent = text + after;
          return;
        }
      }
      btn.insertBefore(document.createTextNode(text + ' '), btn.firstChild);
    } catch (e) { /* label optional */ }
  }

  // Stable key -> desktop entry element. Collections is the dropdown wrapper
  // (button + menu); everything else is its data-nav button.
  function desktopEntry(key, dataNav) {
    if (key === 'collections') return $('collections-wrap');
    if (!dataNav) return null;
    try { return document.querySelector('.gx-nav [data-nav="' + dataNav + '"]'); }
    catch (e) { return null; }
  }

  // Stable key -> mobile entry element. Collections is the expandable
  // button; the #mobile-collections panel follows it separately.
  function mobileEntry(key, dataNav) {
    if (key === 'collections') return $('collections-btn-mobile');
    if (!dataNav) return null;
    try { return document.querySelector('.gx-mobile-nav [data-nav="' + dataNav + '"]'); }
    catch (e) { return null; }
  }

  function labelTarget(entry, key) {
    if (!entry) return null;
    if (key === 'collections') {
      if (entry.id === 'collections-btn' || entry.id === 'collections-btn-mobile') return entry;
      try {
        var btn = entry.querySelector
          ? (entry.querySelector('#collections-btn') || entry.querySelector('#collections-btn-mobile'))
          : null;
        return btn || entry;
      } catch (e) { return entry; }
    }
    return entry;
  }

  // Footer Browse links mirror the navbar config (same keys, same labels,
  // same visibility). The footer has no Collections entry and keeps its
  // Search link always (searchVisible only controls the header box).
  function applyFooter(cfg) {
    var host = null;
    try { host = $('footer-browse'); } catch (e) { host = null; }
    if (!host) {
      try { host = document.querySelector('nav[aria-label="Browse"]'); } catch (e) { host = null; }
    }
    if (!host || !cfg || !Array.isArray(cfg.items)) return;
    try {
      var byKey = {};
      cfg.items.forEach(function (it) { if (it && it.key) byKey[it.key] = it; });
      var links = host.querySelectorAll ? host.querySelectorAll('[data-footnav]') : [];
      for (var i = 0; i < links.length; i++) {
        var a = links[i];
        var key = null;
        try { key = a.getAttribute('data-footnav'); } catch (e) { key = null; }
        if (!key || !byKey[key]) continue; // Search + unknown: always shown
        var it = byKey[key];
        try { if (typeof it.label === 'string' && it.label.trim()) a.textContent = it.label.trim(); } catch (e) { /* label optional */ }
        showEl(a, it.visible !== false);
      }
      // Footer order follows config order (footer-only Search stays last).
      try {
        var ordered = [];
        cfg.items.forEach(function (it) {
          if (!it || !it.key) return;
          var el = host.querySelector ? host.querySelector('[data-footnav="' + it.key + '"]') : null;
          if (el) ordered.push(el);
        });
        ordered.forEach(function (el) { try { host.appendChild(el); } catch (e) { /* order optional */ } });
      } catch (e) { /* order optional */ }
    } catch (e) { /* footer optional */ }
  }

  function applyConfig(cfg) {
    if (!cfg || !Array.isArray(cfg.items) || !cfg.items.length) return false;
    var desktopParent = null;
    var mobileParent = null;
    try { desktopParent = document.querySelector('.gx-nav'); } catch (e) { desktopParent = null; }
    try { mobileParent = document.querySelector('.gx-mobile-nav'); } catch (e) { mobileParent = null; }
    if (!desktopParent && !mobileParent) return false;

    cfg.items.forEach(function (it) {
      if (!it || !it.key) return;
      var visible = it.visible !== false;
      var d = desktopEntry(it.key, it.dataNav);
      if (d && desktopParent && desktopParent.contains(d)) {
        setButtonLabel(labelTarget(d, it.key), it.label);
        showEl(d, visible);
        try { desktopParent.appendChild(d); } catch (e) { /* order optional */ }
      }
      var m = mobileEntry(it.key, it.dataNav);
      if (m && mobileParent && mobileParent.contains(m)) {
        setButtonLabel(labelTarget(m, it.key), it.label);
        showEl(m, visible);
        try { mobileParent.appendChild(m); } catch (e) { /* order optional */ }
      }
      // The mobile collections panel belongs to the collections entry.
      if (it.key === 'collections') {
        showEl($('mobile-collections'), visible);
      }
    });

    // Header search box: separate clearly named flag (search itself is
    // unchanged — only the box visibility is configured).
    var searchVisible = !cfg || cfg.searchVisible !== false;
    try {
      var boxes = document.querySelectorAll('.gx-search');
      for (var i = 0; i < boxes.length; i++) showEl(boxes[i], searchVisible);
    } catch (e) { /* search optional */ }
    applyFooter(cfg);
    return true;
  }

  function apply() {
    var cfg = data();
    if (!cfg) return false; // no config yet: leave the static navbar as-is
    return applyConfig(cfg);
  }

  // collections-nav.js owns its own render() (which resets the collections
  // wrapper's inline display). Re-apply afterwards so a config-hidden
  // Collections entry stays hidden after its menu re-renders.
  function wrapCollectionsRefresh() {
    try {
      var nav = window.GreyboxCollectionsNav;
      if (!nav || typeof nav.refresh !== 'function' || nav.__greyboxNavWrapped) return;
      var orig = nav.refresh;
      nav.__greyboxNavWrapped = true;
      nav.refresh = function () {
        var r = orig.apply(this, arguments);
        try { apply(); } catch (e) { /* noop */ }
        return r;
      };
    } catch (e) { /* noop */ }
  }

  // SPA route renders never rebuild the navbar, but re-apply here so a
  // hidden entry can never reappear after in-app navigation or a late
  // collections menu render (the collections render() captured before this
  // file loads bypasses the refresh wrapper — the Router hook covers it).
  function watchRoutes() {
    try {
      if (window.Router && typeof window.Router.onChange === 'function' && !watchRoutes.__done) {
        watchRoutes.__done = true;
        window.Router.onChange(function () { try { apply(); } catch (e) { /* noop */ } });
      }
    } catch (e) { /* router optional */ }
  }

  function boot() {
    wrapCollectionsRefresh();
    apply(); // immediate paint from local fallback (works offline / pre-D1)
    watchRoutes();
    try {
      if (window.GreyboxData && typeof window.GreyboxData.preloadGreyboxConfig === 'function') {
        window.GreyboxData.preloadGreyboxConfig().then(function () {
          wrapCollectionsRefresh();
          watchRoutes();
          apply();
        });
      }
    } catch (e) { /* local config already rendered */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Headless/test hook (no UI effect beyond apply).
  try {
    window.GreyboxNavigationApply = {
      apply: apply,
      applyConfig: applyConfig,
      setButtonLabel: setButtonLabel,
    };
  } catch (e) { /* noop */ }
})();
