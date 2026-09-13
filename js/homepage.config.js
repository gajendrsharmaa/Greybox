/* Greybox homepage configuration — YOU control the homepage here, not TMDB.
 *
 * D1 (`home_sections` + `settings.home_hero`, managed through /api/admin/*
 * and the Admin Home workspace) is the live source of truth. THIS FILE is
 * the offline fallback: it is used only when D1 is unreachable (static
 * preview, Vercel without D1, binding missing) — see js/data.js
 * preloadGreyboxConfig. Keep it representative; never paste TMDB metadata
 * here — just structure.
 *
 * Architecture:
 *   this file (structure: order, titles, limits, visibility, sources)
 *     ↓  js/data.js resolves each section through the Greybox API (/api/*)
 *   TMDB (data only — posters, titles, ratings; never page structure)
 *     ↓  js/pages.js renders with the existing card style
 *   HTML (same .card grid + headings you already have)
 *
 * A section:
 *   {
 *     id: 'popular-movies',          // required, unique; becomes home-section-<id>
 *     title: 'Popular Movies',       // required; the shelf heading
 *     description: '...',            // optional subtitle under the heading
 *     visible: true,                 // false hides the shelf (keeps its place)
 *     limit: 12,                     // max cards (default 12)
 *     source: { ... }                // exactly ONE source (see below)
 *   }
 *
 * Sources (all fetched through the Greybox API — secret stays server-side):
 *   { type: 'trending' }
 *   { type: 'movies', category: 'popular' | 'top-rated' | 'upcoming' | 'now-playing' }
 *   { type: 'tv',     category: 'popular' | 'top-rated' | 'on-the-air' | 'airing-today' }
 *   { type: 'anime',  kind: 'series' | 'movies' }
 *   { type: 'search', query: 'dune' }                       // TMDB text search
 *   { type: 'ids', items: [{ media: 'movie'|'tv', id: 550 }] }  // hand-picked TMDB IDs, in YOUR order
 *   { type: 'genre', media: 'movie'|'tv', genreId: 28, sort: 'popularity.desc' }
 *   { type: 'collection', slug: 'kids' }                   // expandable shelf: preview + View All → /collection/kids share the SAME collection rule
 *   { type: 'tag', tag: 'kids-fav' }                      // editorial shelf: ordered custom-tag membership (Admin → Tags), in tag order, no View All page
 *
 * TMDB genre IDs (commonly used): Action 28, Adventure 12, Animation 16,
 * Comedy 35, Crime 80, Documentary 99, Drama 18, Family 10751, Fantasy 14,
 * History 36, Horror 27, Music 10402, Mystery 9648, Romance 10749,
 * Sci-Fi 878, Thriller 53, War 10752, Western 37.
 * (TV adds: Action & Adventure 10759, Kids 10762, News 10763, Reality 10764,
 *  Sci-Fi & Fantasy 10765, Soap 10766, Talk 10767, War & Politics 10768.)
 *
 * Hero (the big banner above the grid) — single authoritative config, stored
 * as D1 settings.home_hero (this file is the offline fallback for it):
 *   hero: { mode: 'follow-grid' }              // default: first item of the main grid, exactly as today
 *   hero: { mode: 'custom', badge: '...',      // fixed spotlight instead
 *           source: { type: 'ids', items: [{ media: 'movie', id: 550 }] }, pick: 0 }
 *   hero: { mode: 'custom', badge: 'Trending #1', source: { type: 'trending' }, pick: 0 }
 *   hero: { mode: 'spotlight',                 // one explicit title (media_type + TMDB ID identity)
 *           heroItem: { media: 'movie', id: 27205 }, badge: 'Greybox Spotlight' }
 * Authority per mode (Admin + public homepage share it — see README §4):
 * spotlight honors heroItem, custom honors source+pick (items[pick],
 * fallback items[0]), follow-grid honors the grid. Values kept for inactive
 * modes are preserved but ignored. artwork/trailer presentation travels with
 * every mode; collection heroes are a separate scope (settings key
 * collection_heroes) and never affect the Home Hero.
 */
(function () {
  'use strict';

  window.GreyboxHome = {
    hero: {
      mode: 'follow-grid', // 'follow-grid' | 'custom'
      // badge: 'Greybox Spotlight',
      // source: { type: 'ids', items: [{ media: 'movie', id: 550 }] },
      // pick: 0,
    },

    // Shelf order = array order. Reorder the blocks to reorder the homepage.
    // Delete (or set visible: false on) a block to remove a shelf.
    sections: [
      {
        id: 'popular-movies',
        title: 'Popular Movies',
        description: 'What everyone is watching right now.',
        visible: true,
        limit: 12,
        source: { type: 'movies', category: 'popular' },
      },
      {
        id: 'popular-tv',
        title: 'Popular TV Shows',
        description: 'Binge-worthy series trending this week.',
        visible: true,
        limit: 12,
        source: { type: 'tv', category: 'popular' },
      },

      // ---- Examples (uncomment to use) ----
      //
      // Hand-picked shelf — specific TMDB IDs in YOUR order:
      // {
      //   id: 'editors-picks',
      //   title: "Editor's Picks",
      //   description: 'Chosen by the Greybox team.',
      //   visible: true,
      //   limit: 6,
      //   source: {
      //     type: 'ids',
      //     items: [
      //       { media: 'movie', id: 550 },   // Fight Club
      //       { media: 'tv', id: 1399 },     // Game of Thrones
      //       { media: 'movie', id: 155 },   // The Dark Knight
      //     ],
      //   },
      // },
      //
      // Genre shelf — TMDB provides the titles, you provide the shelf:
      // {
      //   id: 'sci-fi-movies',
      //   title: 'Sci-Fi Movies',
      //   description: 'Space, time travel, and robots.',
      //   visible: true,
      //   limit: 12,
      //   source: { type: 'genre', media: 'movie', genreId: 878, sort: 'popularity.desc' },
      // },
      //
      // Hidden draft — kept in place, rendered nowhere until visible: true:
      // {
      //   id: 'coming-soon',
      //   title: 'Coming Soon',
      //   description: '',
      //   visible: false,
      //   limit: 12,
      //   source: { type: 'movies', category: 'upcoming' },
      // },
    ],
  };
})();
