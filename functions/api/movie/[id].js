/**
 * Greybox API (Cloudflare): GET /api/movie/:id?region=US
 * Movie detail bundle (replaces 4 frontend calls). Upstream, in parallel:
 *   movie/:id + movie/:id/credits + movie/:id/videos + movie/:id/watch/providers
 */
import { getCreds, parseId, parseRegion, shapeDetail, tmdbGet } from '../../lib/greybox.js';

export async function onRequest(context) {
  try {
    const { request, env, params } = context;
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

    const creds = getCreds(env);
    if (!creds) return json({ error: 'Missing TMDB_READ_TOKEN (or TMDB_API_KEY) in Pages env vars. See README.' }, 500);

    const raw = params.id ?? params['id'] ?? '';
    const id = parseId(Array.isArray(raw) ? raw[0] : raw);
    if (!id) return json({ error: 'Invalid movie id' }, 400);

    const url = new URL(request.url);
    const region = parseRegion(url.searchParams.get('region'));
    const base = { language: 'en-US' };
    const [detail, credits, videos, providers] = await Promise.all([
      tmdbGet(creds, 'movie/' + id, base),
      tmdbGet(creds, 'movie/' + id + '/credits', base).catch(() => ({ cast: [] })),
      tmdbGet(creds, 'movie/' + id + '/videos', base).catch(() => ({ results: [] })),
      tmdbGet(creds, 'movie/' + id + '/watch/providers', {}).catch(() => ({ results: {} })),
    ]);
    return cacheable(request, context, shapeDetail(detail, credits, videos, providers, region, 'movie'));
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
