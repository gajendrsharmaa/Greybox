/**
 * Cloudflare Pages Function: TMDB proxy
 * Route: /api/tmdb/*  ->  https://api.themoviedb.org/3/*
 * Keeps TMDB_API_KEY / TMDB_READ_TOKEN secret (set in Pages env vars).
 *
 * Env vars (Pages Dashboard > Settings > Environment variables):
 *   TMDB_READ_TOKEN = your TMDB v4 Read Access Token (eyJ...)  [preferred]
 *   or TMDB_API_KEY = your TMDB v3 api_key
 */
export async function onRequest(context) {
  try {
    const { request, env, params } = context;
    const url = new URL(request.url);

    const token = env.TMDB_READ_TOKEN;
    const apiKey = env.TMDB_API_KEY;
    if (!token && !apiKey) {
      return json({ error: 'Missing TMDB_READ_TOKEN (or TMDB_API_KEY) in .dev.vars / Pages env vars. See README.' }, 500);
    }

    // params.path can be an array (catch-all) or a string depending on
    // wrangler version — normalize to an array so .join never throws
    // (a throw here is what produced the HTML "An error has occurred" page).
    const raw = params.path ?? params['path'] ?? [];
    const parts = Array.isArray(raw)
      ? raw
      : String(raw || '').split('/').filter(Boolean);
    // allowlist to avoid open-proxy abuse
    const allowed = /^(trending|movie|tv|search|genre|discover|person|collection|watch)[\/a-zA-Z0-9_\-]*$/;
    const tmdbPath = parts.join('/');
    if (!allowed.test(tmdbPath)) return json({ error: 'Blocked path: ' + tmdbPath }, 403);

  const target = new URL(`https://api.themoviedb.org/3/${tmdbPath}`);
  // forward safe query params only (include_image_language lets the hero
  // title-logo request ask for English + language-neutral logos)
  const fwd = ['language', 'page', 'query', 'region', 'watch_region', 'include_adult', 'sort_by', 'with_genres', 'with_original_language', 'with_watch_providers', 'primary_release_year', 'first_air_date_year', 'include_image_language'];
  for (const k of fwd) {
    const v = url.searchParams.get(k);
    if (v !== null) target.searchParams.set(k, v);
  }
  if (apiKey && !token) target.searchParams.set('api_key', apiKey);

  const headers = { accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  // simple edge cache (optional — never let cache break local dev)
  const cacheKey = new Request(target.toString(), { headers });
  try {
    const cache = caches.default;
    if (request.method === 'GET') {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }
  } catch { /* cache unavailable locally — continue without it */ }

  let res;
  try {
    res = await fetch(target.toString(), { headers });
  } catch (e) {
    return json({ error: 'Could not reach TMDB: ' + (e.message || e) }, 502);
  }
  const body = await res.text();
  const out = new Response(body, {
    status: res.status,
    headers: {
      'content-type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': res.ok ? 'public, max-age=600' : 'no-store',
    },
  });
  if (res.ok && request.method === 'GET') {
    try { context.waitUntil(caches.default.put(cacheKey, out.clone())); } catch { /* noop */ }
  }
  return out;
  } catch (e) {
    // Always return JSON — never let an uncaught throw become an HTML error page.
    return json({ error: 'Proxy crash: ' + (e && e.message ? e.message : String(e)) }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors() });
}
function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
}
function json(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
}
