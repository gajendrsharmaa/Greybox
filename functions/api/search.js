/**
 * Greybox API (Cloudflare): GET /api/search?q=...&page=1
 * Header search dropdown. Upstream: search/multi (movie+tv only, needs image).
 */
import { getCreds, parsePage, shapeSearch, tmdbGet } from '../lib/greybox.js';

export async function onRequest(context) {
  try {
    const { request, env } = context;
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

    const creds = getCreds(env);
    if (!creds) return json({ error: 'Missing TMDB_READ_TOKEN (or TMDB_API_KEY) in Pages env vars. See README.' }, 500);

    const url = new URL(request.url);
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return json({ error: 'Missing ?q= search query' }, 400);
    const page = parsePage(url.searchParams.get('page'));
    const data = await tmdbGet(creds, 'search/multi', {
      language: 'en-US',
      query: q,
      page,
      include_adult: 'false',
    });
    return json(shapeSearch(data, q), 200, true);
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
