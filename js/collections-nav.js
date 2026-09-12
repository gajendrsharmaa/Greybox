/* Greybox collections navbar dropdown — generic, config-driven.
 *
 * Source of truth: window.GreyboxData.getCollections() (D1 via
 * /api/config/collections once preloaded, else js/collections.config.js).
 * Only collections with `visible !== false` are shown, in config order.
 * Links use Router.url.collection(slug) so each collection keeps its
 * existing slug and opens /collection/:slug through the SPA router.
 *
 * No collection names are hardcoded here: titles, descriptions and hrefs
 * all come from the config. New collections appear after reload with zero
 * navbar code changes. No D1 schema change, no new routes, no change to
 * collection resolution or public collection pages.
 *
 * Grouping: an optional free-form group label is read from
 * `collection.group | collection.category | collection.meta.group |
 * collection.meta.category` (meta_json needs no schema change). When fewer
 * than 2 distinct groups exist the menu falls back to a flat list.
 *
 * Search/filter appears only when there are many collections (keeps the
 * panel compact for small sites). Desktop gets the dropdown panel;
 * mobile gets a simple expandable stacked list (no mega-menu layout).
 */
(function () {
  'use strict';

  var SEARCH_THRESHOLD = 5; // show the filter input only when visibleCount > this

  var collections = []; // visible collections, config order
  var query = '';

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    try {
      if (window.GreyboxComponents && typeof window.GreyboxComponents.escapeHtml === 'function') {
        return window.GreyboxComponents.escapeHtml(s);
      }
    } catch (e) { /* fall through to local */ }
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- data (generic, no hardcoded names) ---------------- */

  function visibleCollections() {
    try {
      if (!window.GreyboxData || typeof window.GreyboxData.getCollections !== 'function') return [];
      return (window.GreyboxData.getCollections() || [])
        .filter(function (c) { return c && c.visible !== false && c.slug && c.title; });
    } catch (e) { return []; }
  }

  function collectionHref(slug) {
    try {
      if (window.Router && window.Router.url && typeof window.Router.url.collection === 'function') {
        return window.Router.url.collection(slug);
      }
    } catch (e) { /* fall through */ }
    return '/collection/' + String(slug || '').trim().toLowerCase();
  }

  // Optional group label (all reads are tolerant: missing metadata -> '').
  function groupOf(c) {
    if (!c) return '';
    var g = c.group != null ? c.group : (c.category != null ? c.category : '');
    if (!g && c.meta && typeof c.meta === 'object') {
      g = c.meta.group != null ? c.meta.group : (c.meta.category != null ? c.meta.category : '');
    }
    g = String(g == null ? '' : g).trim();
    return g.slice(0, 48);
  }

  // Grouped in first-seen order (respects config order); flat when <2 groups.
  function grouped(list) {
    var order = [];
    var seen = Object.create(null);
    list.forEach(function (c) {
      var g = groupOf(c);
      if (!g) return;
      var key = g.toLowerCase();
      if (!seen[key]) { seen[key] = g; order.push(key); }
    });
    if (order.length < 2) return null;
    return order.map(function (key) {
      return {
        label: seen[key],
        items: list.filter(function (c) { return groupOf(c).toLowerCase() === key; }),
      };
    });
  }

  function filterCollections(list, q) {
    var needle = String(q == null ? '' : q).trim().toLowerCase();
    if (!needle) return list.slice();
    return list.filter(function (c) {
      return (String(c.title || '').toLowerCase().indexOf(needle) >= 0) ||
        (String(c.description || '').toLowerCase().indexOf(needle) >= 0) ||
        (String(c.slug || '').toLowerCase().indexOf(needle) >= 0);
    });
  }

  function iconFor(title) {
    var t = String(title || '').trim();
    return (t.charAt(0) || 'C').toUpperCase();
  }

  /* ---------------- rendering ---------------- */

  function itemHTML(c) {
    var title = String(c.title || c.slug);
    var desc = String(c.description || '').trim();
    return '<a class="collections-item" role="menuitem" href="' + esc(collectionHref(c.slug)) + '"' +
      ' data-slug="' + esc(c.slug) + '">' +
      '<span class="collections-item-icon" aria-hidden="true">' + esc(iconFor(title)) + '</span>' +
      '<span class="collections-item-body">' +
      '<span class="collections-item-title">' + esc(title) + '</span>' +
      (desc ? '<span class="collections-item-desc">' + esc(desc) + '</span>' : '') +
      '</span>' +
      '<span class="collections-item-arrow" aria-hidden="true">→</span></a>';
  }

  function listHTML(list) {
    if (!list.length) {
      return '<div class="collections-empty">' +
        (query ? 'No collections match “' + esc(query) + '”.' : 'No collections yet.') + '</div>';
    }
    var groups = grouped(list);
    if (!groups) return list.map(itemHTML).join('');
    return groups.map(function (g) {
      return '<div class="collections-group-label" role="presentation">' + esc(g.label) + '</div>' +
        g.items.map(itemHTML).join('');
    }).join('');
  }

  function render() {
    collections = visibleCollections();
    var listEl = $('collections-list');
    var mobileListEl = $('mobile-collections-list');
    var wrap = $('collections-wrap');
    var mobileBtn = $('collections-btn-mobile');
    var mobilePanel = $('mobile-collections');

    if (!collections.length) {
      // No visible collections: hide the nav entry points instead of a dead menu.
      if (wrap) wrap.style.display = 'none';
      if (mobileBtn) mobileBtn.style.display = 'none';
      if (mobilePanel) mobilePanel.classList.add('hidden');
      return;
    }
    if (wrap) wrap.style.display = '';
    if (mobileBtn) mobileBtn.style.display = '';

    var filtered = filterCollections(collections, query);
    if (listEl) listEl.innerHTML = listHTML(filtered);

    // Filter input only earns its space when there are many collections.
    var searchWrap = $('collections-search-wrap');
    if (searchWrap) searchWrap.classList.toggle('hidden', collections.length <= SEARCH_THRESHOLD);

    var count = $('collections-count');
    if (count) {
      count.textContent = String(collections.length);
      count.classList.remove('hidden');
    }

    if (mobileListEl) {
      // Mobile list is ungrouped + unfiltered by design: a short stacked menu.
      mobileListEl.innerHTML = collections.map(itemHTML).join('');
    }

    syncActive();
  }

  function menuLinks() {
    var menu = $('collections-menu');
    if (!menu) return [];
    return Array.prototype.slice.call(menu.querySelectorAll('a.collections-item'));
  }

  function syncActive() {
    var onCollection = false;
    try {
      if (window.Router && typeof window.Router.current === 'function') {
        onCollection = window.Router.current().name === 'collection';
      }
    } catch (e) { onCollection = false; }
    var btn = $('collections-btn');
    var mobileBtn = $('collections-btn-mobile');
    if (btn) btn.classList.toggle('active', onCollection);
    if (mobileBtn) mobileBtn.classList.toggle('active', onCollection);
  }

  /* ---------------- desktop dropdown behavior ---------------- */

  function isOpen() {
    var menu = $('collections-menu');
    return !!menu && !menu.classList.contains('hidden');
  }

  function open(focusFirst) {
    var menu = $('collections-menu');
    var btn = $('collections-btn');
    if (!menu || !btn || !collections.length) return;
    if (isOpen()) {
      if (focusFirst) { var l = menuLinks(); if (l[0]) l[0].focus(); }
      return;
    }
    menu.classList.remove('hidden');
    // Restart the pop animation on every open.
    menu.classList.remove('open');
    try { void menu.offsetWidth; } catch (e) { /* noop */ }
    menu.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    if (focusFirst) { var links = menuLinks(); if (links[0]) links[0].focus(); }
  }

  function close(focusButton) {
    var menu = $('collections-menu');
    var btn = $('collections-btn');
    if (menu) { menu.classList.add('hidden'); menu.classList.remove('open'); }
    if (btn) btn.setAttribute('aria-expanded', 'false');
    if (query) {
      query = '';
      var input = $('collections-search');
      if (input) input.value = '';
      var listEl = $('collections-list');
      if (listEl && collections.length) listEl.innerHTML = listHTML(collections);
    }
    if (focusButton && btn) btn.focus();
  }

  function toggle() { if (isOpen()) close(false); else open(false); }

  function hoverCapable() {
    try { return window.matchMedia('(hover: hover) and (pointer: fine)').matches; }
    catch (e) { return false; }
  }

  /* ---------------- mobile expandable ---------------- */

  function isMobileOpen() {
    var panel = $('mobile-collections');
    return !!panel && !panel.classList.contains('hidden');
  }

  function closeMobile() {
    var panel = $('mobile-collections');
    var btn = $('collections-btn-mobile');
    if (panel) {
      panel.classList.add('hidden');
      var inner = panel.querySelector('.mobile-collections-panel');
      if (inner) inner.classList.remove('open');
    }
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function toggleMobile() {
    var panel = $('mobile-collections');
    var btn = $('collections-btn-mobile');
    if (!panel || !btn || !collections.length) return;
    if (isMobileOpen()) { closeMobile(); return; }
    panel.classList.remove('hidden');
    var inner = panel.querySelector('.mobile-collections-panel');
    if (inner) {
      inner.classList.remove('open');
      try { void inner.offsetWidth; } catch (e) { /* noop */ }
      inner.classList.add('open');
    }
    btn.setAttribute('aria-expanded', 'true');
  }

  /* ---------------- events ---------------- */

  function bind() {
    var btn = $('collections-btn');
    var menu = $('collections-menu');
    var wrap = $('collections-wrap');
    var input = $('collections-search');
    var mobileBtn = $('collections-btn-mobile');
    var mobilePanel = $('mobile-collections');

    if (btn) {
      btn.addEventListener('click', function () {
        toggle();
      });
      btn.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
          if (!isOpen()) { e.preventDefault(); open(true); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); open(true); }
        } else if (e.key === 'Escape' && isOpen()) {
          e.preventDefault(); close(true);
        }
      });
    }

    // Hover-friendly on precise pointers only — touch uses click-to-toggle
    // (a tap would otherwise fire mouseenter + click and instantly re-close).
    if (wrap && hoverCapable()) {
      wrap.addEventListener('mouseenter', function () { open(false); });
      wrap.addEventListener('mouseleave', function () { close(false); });
    }

    if (menu) {
      menu.addEventListener('keydown', function (e) {
        var links = menuLinks();
        var idx = links.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          (links[idx + 1] || links[0] || $('collections-search')).focus();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (idx <= 0) { if (input && !input.closest('.hidden')) input.focus(); else if (btn) btn.focus(); }
          else links[idx - 1].focus();
        } else if (e.key === 'Home') { e.preventDefault(); if (links[0]) links[0].focus(); }
        else if (e.key === 'End') { e.preventDefault(); if (links.length) links[links.length - 1].focus(); }
        else if (e.key === 'Escape') { e.preventDefault(); close(true); }
        else if (e.key === 'Tab') { close(false); }
      });
      // Choosing any link (collection or View All) dismisses the menu;
      // the SPA router / native anchor handles the actual navigation.
      menu.addEventListener('click', function (e) {
        if (e.target && e.target.closest && e.target.closest('a[href]')) close(false);
      });
    }

    if (input) {
      input.addEventListener('input', function (e) {
        query = e.target.value;
        var listEl = $('collections-list');
        if (listEl) listEl.innerHTML = listHTML(filterCollections(collections, query));
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); var l = menuLinks(); if (l[0]) l[0].focus(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      });
    }

    // Click outside closes (clicks inside #collections-wrap are ignored below).
    document.addEventListener('click', function (e) {
      if (!isOpen()) return;
      if (e.target && e.target.closest &&
        (e.target.closest('#collections-wrap') || e.target.closest('#collections-search'))) return;
      close(false);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (isOpen()) close(false);
      if (isMobileOpen()) closeMobile();
    });

    if (mobileBtn) {
      mobileBtn.addEventListener('click', function () {
        toggleMobile();
      });
    }
    if (mobilePanel) {
      mobilePanel.addEventListener('click', function (e) {
        if (e.target && e.target.closest && e.target.closest('a[href]')) closeMobile();
      });
    }

    // Route changes dismiss menus and refresh the active highlight.
    try {
      if (window.Router && typeof window.Router.onChange === 'function') {
        window.Router.onChange(function () { close(false); closeMobile(); syncActive(); });
      }
    } catch (e) { /* router optional */ }
  }

  /* ---------------- boot ---------------- */

  function boot() {
    if (!($('collections-btn') || $('collections-btn-mobile'))) return;
    bind();
    render(); // immediate paint from local config (works offline / pre-D1)
    try {
      if (window.GreyboxData && typeof window.GreyboxData.preloadGreyboxConfig === 'function') {
        window.GreyboxData.preloadGreyboxConfig().then(function () { render(); });
      }
    } catch (e) { /* local config already rendered */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Headless/test hook (no UI effect).
  try {
    window.GreyboxCollectionsNav = {
      refresh: render,
      getVisible: visibleCollections,
      filter: filterCollections,
      groupOf: groupOf,
      grouped: grouped,
      hrefFor: collectionHref,
      isOpen: isOpen,
      isMobileOpen: isMobileOpen,
      SEARCH_THRESHOLD: SEARCH_THRESHOLD,
    };
  } catch (e) { /* noop */ }
})();
