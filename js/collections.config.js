/* Greybox collections — YOU define the RULES, TMDB supplies the data.
 *
 * D1 (`collections` table, managed through /api/admin/collections and the
 * Admin Collections workspace) is the live source of truth. THIS FILE is the
 * offline fallback: it is used only when D1 is unreachable (static preview,
 * Vercel without D1, binding missing) — see js/data.js preloadGreyboxConfig.
 * Keep it in sync with the seed (migrations/0002_seed.sql) so fallback and
 * live agree; never paste TMDB metadata here — just rules.
 *
 * Each collection renders at /collection/<slug> (e.g. /collection/science-fiction).
 * A collection is Greybox-controlled structure; TMDB only provides the current
 * matching titles, posters, metadata, ratings and release info. Never paste
 * TMDB metadata (titles, posters, overviews, ratings) in here — just rules.
 *
 * A collection:
 *   {
 *     slug: 'science-fiction',     // required, unique, lowercase letters/numbers/hyphens
 *     title: 'Science Fiction',    // required; page heading + tab title
 *     description: '...',          // optional subtitle under the heading
 *     cover: 'https://.../img.jpg',// optional banner image (or use `hero:` as an alias)
 *     visible: true,               // false hides the collection everywhere (URL shows Not found)
 *     limit: 24,                   // max cards, default 20 (dynamic sources may fetch extra pages)
 *     source: { ... },             // required: ONE rule source (see below)
 *     pin: [ ... ],                // optional manual overrides, always shown FIRST
 *     exclude: [ ... ],            // optional TMDB ids to hide from this collection
 *     meta: { curator: '...', updated: '...' },  // optional metadata line
 *   }
 *
 * Sources (all fetched through the Greybox API — secret stays server-side):
 *   { type: 'trending', media: 'movie'|'tv'|'all' }              // default 'all'
 *   { type: 'popular', media: 'movie'|'tv' }                     // default 'movie'
 *   { type: 'top-rated', media: 'movie'|'tv' }                   // default 'movie'
 *   { type: 'now-playing', media: 'movie' }                      // movies only
 *   { type: 'discover', media: 'movie'|'tv', genre: 878, year: 2024, sort: 'popularity.desc' }
 *       // genre = TMDB genre id, year = release year, sort = TMDB sort_by;
 *       // every filter is optional — { type: 'discover', media: 'tv' } lists popular TV
 *   { type: 'genre', media: 'movie'|'tv', genreId: 878, sort: 'popularity.desc' }
 *       // shorthand for discover with a genre
 *   { type: 'genre', media: 'both',
 *     genre: { name: 'Horror', movie_id: 27, tv_id: 9648 }, sort: 'popularity.desc' }
 *       // Movies + TV shelf: one genre ID per TMDB list (movie and TV genre
 *       // IDs differ, so each side carries its own — never reuse one ID)
 *   { type: 'year', media: 'movie'|'tv', year: 1999, sort: 'popularity.desc' }
 *       // shorthand for discover with a release year
 *   { type: 'search', query: 'dune' }                            // TMDB text search
 *   { type: 'custom', items: [{ media: 'movie'|'tv', id: 550 }] }// hand-picked TMDB IDs, in YOUR order
 *       // shorthand: a bare number means { media: 'movie', id: <number> }
 *
 * TMDB genre IDs (commonly used): Action 28, Adventure 12, Animation 16,
 * Comedy 35, Crime 80, Documentary 99, Drama 18, Family 10751, Fantasy 14,
 * History 36, Horror 27, Music 10402, Mystery 9648, Romance 10749,
 * Sci-Fi 878, Thriller 53, War 10752, Western 37.
 * (TV adds: Action & Adventure 10759, Kids 10762, News 10763, Reality 10764,
 *  Sci-Fi & Fantasy 10765, Soap 10766, Talk 10767, War & Politics 10768.)
 *
 * Manual overrides:
 *   pin: [{ media: 'movie', id: 438631 }]  // resolved via details, pinned FIRST
 *   exclude: [123, { media: 'tv', id: 456 }]  // bare id hides any media; object is exact
 */
(function () {
  'use strict';

  window.GreyboxCollections = [
    {
      slug: 'science-fiction',
      title: 'Science Fiction',
      description: 'Space, time travel and robots — currently popular sci-fi, refreshed from TMDB.',
      // cover: 'https://image.tmdb.org/t/p/original/your-backdrop.jpg',
      visible: true,
      limit: 24,
      source: { type: 'discover', media: 'movie', genre: 878, sort: 'popularity.desc' },
      meta: { curator: 'Greybox', updated: '2026-09' },
    },
    {
      slug: 'top-rated',
      title: 'Top Rated',
      description: 'The highest-rated films of all time, live from TMDB.',
      visible: true,
      limit: 20,
      source: { type: 'top-rated', media: 'movie' },
      meta: { curator: 'Greybox' },
    },
    {
      slug: 'recently-released',
      title: 'Recently Released',
      description: 'Now playing in cinemas — updated as new films arrive.',
      visible: true,
      limit: 20,
      source: { type: 'now-playing', media: 'movie' },
      meta: { curator: 'Greybox' },
    },
    {
      slug: 'editor-picks',
      title: "Editor's Picks",
      description: 'Exact titles, hand-picked by Greybox in viewing order.',
      visible: true,
      limit: 12,
      source: {
        type: 'custom',
        items: [
          { media: 'movie', id: 550 },  // Fight Club
          { media: 'movie', id: 155 },  // The Dark Knight
          { media: 'tv', id: 1399 },    // Game of Thrones
        ],
      },
      meta: { curator: 'Greybox' },
    },

    // ---- Template for your next collection (copy, rename, flip visible) ----
    // {
    //   slug: 'hidden-gems',
    //   title: 'Hidden Gems',
    //   description: 'Great films most people missed.',
    //   visible: false, // draft: renders nowhere until true (URL shows Not found)
    //   limit: 20,
    //   source: { type: 'discover', media: 'movie', sort: 'vote_average.desc' },
    //   exclude: [550],
    //   meta: { curator: 'Greybox' },
    // },
  ];
})();
