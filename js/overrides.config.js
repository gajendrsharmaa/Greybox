/* Greybox metadata overrides — selected Greybox values win over TMDB.
 *
 * No database, no admin panel, no build step: edit this file, redeploy
 * (Cloudflare Pages / Vercel serve it as static JS), hard-refresh.
 *
 * Pipeline:
 *   TMDB data
 *     ↓  js/data.js looks up an entry below by (media, tmdb_id)
 *   override exists? yes → use Greybox value / no → keep TMDB value
 *     ↓  final resolved object (renderers can't tell the source apart)
 *   existing renderer (pages.js / components.js, unchanged behaviour)
 *
 * An entry stores ONLY the fields Greybox explicitly overrides — never paste
 * a complete TMDB response in here:
 *   {
 *     tmdb_id: 550,            // required; TMDB movie/TV id
 *     media: 'movie',          // required; 'movie' or 'tv'
 *     title: 'Custom title',   // optional; also syncs the title/name alias
 *     description: '...',      // optional; Greybox name for TMDB `overview`
 *     poster_path: '/x.jpg',   // optional; TMDB-style image path
 *     backdrop_path: '/y.jpg', // optional; TMDB-style image path
 *     vote_average: 9.2,       // optional; numeric rating
 *     release_date: '...',     // optional (movies); first_air_date for TV
 *     first_air_date: '...',   // optional (TV shows)
 *     featured: true,          // optional Greybox flag, carried on the object
 *     custom_badge: 'Greybox Pick', // optional; shown as a small card/badge label
 *   }
 *
 * Rules: empty strings / null / undefined mean "not overridden" (TMDB kept).
 * Unknown fields are ignored. First entry wins on duplicate (media, tmdb_id).
 */
(function () {
  'use strict';

  window.GreyboxOverrides = [
    {
      tmdb_id: 550,
      media: 'movie',
      title: 'Fight Club — Greybox Cut',
      description: 'Greybox pick: an insomniac office worker and a soap salesman build something they cannot control.',
      featured: true,
      custom_badge: 'Greybox Pick',
    },
    {
      tmdb_id: 1399,
      media: 'tv',
      description: 'Greybox pick: Game of Thrones is an epic fantasy television series that follows noble families fighting for control of the Iron Throne of the Seven Kingdoms, while an ancient existential threat rises in the frozen north',
      custom_badge: 'Greybox Pick',
    },
  ];
})();
