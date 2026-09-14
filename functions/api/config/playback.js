/**
 * Greybox API (Cloudflare): GET /api/config/playback
 * Public playback mode from D1 (Greybox-owned resolver strategy only —
 * no provider URLs, no TMDB data, no secrets here). Just { mode }; the
 * browser resolves catalog titles through js/stream.js resolvePlayback
 * (same pattern as navigation/detail-pages: the endpoint returns the raw
 * setting and the client sanitizes). Short cache on purpose: playback
 * edits show up within ~a minute. Missing/corrupt rows sanitize to auto,
 * so the public player never breaks.
 */
import { getDb, readPlayback } from '../../lib/db.js';

export async function onRequest(context) {
  try {
    const { request, env } = context;
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

    const db = getDb(env);
    if (!db) return json({ error: 'Greybox config database (D1 binding DB) is not configured. See README.' }, 503);

    return json(await readPlayback(db), 200);
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

function json(o, s = 200) {
  return new Response(JSON.stringify(o), {
    status: s,
    headers: {
      'content-type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      // Deliberately short + no edge-cache write (unlike TMDB-backed routes):
      // playback edits must become visible quickly for verification.
      'Cache-Control': s === 200 ? 'public, max-age=60' : 'no-store',
    },
  });
}
