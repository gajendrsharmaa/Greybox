/**
 * Greybox API (Cloudflare): GET /api/movies/:category?page=1
 * :category = popular | top-rated | upcoming | now-playing
 * Upstream: movie/<tmdb_category>.
 */
import { MOVIE_CATS, getCreds, parsePage, shapeList, tmdbGet } from '../../lib/greybox.js';

export async function onRequest(context) {
  try {
    const { request, env, params } = context;
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

    const creds = getCreds(env);
    if (!creds) return json({ error: 'Missing TMDB_READ_TOKEN (or TMDB_API_KEY) in Pages env vars. See README.' }, 500);

    const raw = params.category ?? params['category'] ?? '';
    const category = (Array.isArray(raw) ? raw[0] : String(raw || '')).toLowerCase();
    const tmdbCat = MOVIE_CATS[category];
    if (!tmdbCat) return json({ error: 'Unknown movies category: ' + (category || '(empty)') + '. Use: ' + Object.keys(MOVIE_CATS).join(', ') }, 400);

    const url = new URL(request.url);
    const page = parsePage(url.searchParams.get('page'));
    const data = await tmdbGet(creds, 'movie/' + tmdbCat, { language: 'en-US', page });
    return cacheable(request, context, shapeList(data, 'movie'));
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
