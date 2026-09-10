/**
 * Greybox API (Cloudflare): GET /api/trending?page=1
 * Home "Trending Now" rail + hero. Upstream: trending/all/week.
 */
import { getCreds, parsePage, shapeList, tmdbGet } from '../lib/greybox.js';

export async function onRequest(context) {
  try {
    const { request, env } = context;
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

    const creds = getCreds(env);
    if (!creds) return json({ error: 'Missing TMDB_READ_TOKEN (or TMDB_API_KEY) in Pages env vars. See README.' }, 500);

    const url = new URL(request.url);
    const page = parsePage(url.searchParams.get('page'));
    const data = await tmdbGet(creds, 'trending/all/week', { language: 'en-US', page });
    return cacheable(request, context, shapeList(data));
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
