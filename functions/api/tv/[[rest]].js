/**
 * Greybox API (Cloudflare): /api/tv/* — one file, three shapes:
 *   GET /api/tv/:category?page=1        list    (:category = popular|top-rated|on-the-air|airing-today)
 *   GET /api/tv/:id?region=US           detail  (bundle: detail+credits+videos+providers+seasons)
 *   GET /api/tv/:id/season/:n           season  (episodes)
 * Single file because lists and ids share the /api/tv/ prefix; the first
 * segment is a category name or a numeric TMDB id (never both).
 */
import {
  TV_CATS,
  getCreds,
  parseId,
  parsePage,
  parseRegion,
  shapeDetail,
  shapeList,
  shapeSeason,
  tmdbGet,
} from '../../lib/greybox.js';

export async function onRequest(context) {
  try {
    const { request, env, params } = context;
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

    const creds = getCreds(env);
    if (!creds) return json({ error: 'Missing TMDB_READ_TOKEN (or TMDB_API_KEY) in Pages env vars. See README.' }, 500);

    const raw = params.rest ?? params['rest'] ?? [];
    const parts = (Array.isArray(raw) ? raw : String(raw || '').split('/').filter(Boolean))
      .map((p) => String(p));
    const url = new URL(request.url);

    // /api/tv/:id/season/:n
    if (parts.length === 3 && parts[1].toLowerCase() === 'season') {
      const id = parseId(parts[0]);
      const n = parseId(parts[2]);
      if (!id || !n) return json({ error: 'Invalid tv id or season number' }, 400);
      const data = await tmdbGet(creds, 'tv/' + id + '/season/' + n, { language: 'en-US' });
      return cacheable(request, context, shapeSeason(data, id, n));
    }

    // /api/tv/:id  (numeric)  OR  /api/tv/:category (name)
    if (parts.length === 1) {
      const [seg] = parts;
      if (/^\d+$/.test(seg)) {
        const id = parseId(seg);
        const region = parseRegion(url.searchParams.get('region'));
        const base = { language: 'en-US' };
        const [detail, credits, videos, providers] = await Promise.all([
          tmdbGet(creds, 'tv/' + id, base),
          tmdbGet(creds, 'tv/' + id + '/credits', base).catch(() => ({ cast: [] })),
          tmdbGet(creds, 'tv/' + id + '/videos', base).catch(() => ({ results: [] })),
          tmdbGet(creds, 'tv/' + id + '/watch/providers', {}).catch(() => ({ results: {} })),
        ]);
        return cacheable(request, context, shapeDetail(detail, credits, videos, providers, region, 'tv'));
      }
      const tmdbCat = TV_CATS[seg.toLowerCase()];
      if (!tmdbCat) {
        return json({ error: 'Unknown tv route: ' + seg + '. Use a category (' + Object.keys(TV_CATS).join(', ') + '), a numeric id, or :id/season/:n' }, 400);
      }
      const page = parsePage(url.searchParams.get('page'));
      const data = await tmdbGet(creds, 'tv/' + tmdbCat, { language: 'en-US', page });
      return cacheable(request, context, shapeList(data, 'tv'));
    }

    return json({ error: 'Unknown tv route. Use /api/tv/:category, /api/tv/:id, or /api/tv/:id/season/:n' }, 400);
  } catch (e) {
    return json({ error: e && e.message ? e.message : String(e) }, (e && e.status) || 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors() });
}

function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
}

function json(o, s = 200, cache = false) {
  return new Response(JSON.stringify(o), {
    status: s,
    headers: {
      'content-type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': s === 200 && cache ? 'public, max-age=600' : 'no-store',
    },
  });
}

function cacheable(request, context, body) {
  const out = json(body, 200, true);
  try {
    if (request.method === 'GET') context.waitUntil(caches.default.put(new Request(request.url), out.clone()));
  } catch { /* cache unavailable locally — ignore */ }
  return out;
}
