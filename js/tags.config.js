/* Greybox custom editorial tags — reusable content groups, TMDB supplies the data.
 *
 * D1 (`tags` + `tag_members` tables, managed through /api/admin/tags and the
 * Admin Tags workspace) is the live source of truth. THIS FILE is the
 * offline fallback: it is used only when D1 is unreachable (static preview,
 * Vercel without D1, binding missing) — see js/data.js preloadGreyboxConfig.
 * Tags start empty; create them in Admin → Tags. Never paste TMDB metadata
 * (titles, posters, overviews) in here — membership is identity only:
 *
 *   {
 *     slug: 'kids-fav',          // required, unique, lowercase letters/numbers/hyphens
 *     name: 'Kids Fav',          // required; display name + card badge text
 *     description: '...',        // optional note for operators
 *     visible: true,             // false removes the tag from ALL public surfaces
 *     badge: false,              // true also shows the name as a card/detail badge
 *     members: [                 // ordered editorial order (position = list order)
 *       { media: 'movie', id: 550 },
 *       { media: 'tv', id: 1399 },
 *     ],
 *   }
 *
 * A title can belong to many tags (no cross-tag contamination: each tag
 * resolves its own membership list). Used as a content source via
 * { type: 'tag', tag: 'kids-fav' } in home sections AND collections.
 */
(function () {
  'use strict';

  window.GreyboxTags = [];
})();
