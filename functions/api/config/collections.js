/**
 * Greybox API (Cloudflare): GET /api/config/collections
 * All collections from D1 in display order (Greybox-owned rules only —
 * no TMDB data here). Short cache on purpose: edits show up within ~a minute.
 */
import { getDb, readCollections } from '../../lib/db.js';

export async function onRequest(context) {
  try {
    const { request, env } = context;
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

    const db = getDb(env);
    if (!db) return json({ error: 'Greybox config database (D1 binding DB) is not configured. See README.' }, 503);

    return json(await readCollections(db), 200);
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
      // config edits must become visible quickly for verification.
      'Cache-Control': s === 200 ? 'public, max-age=60' : 'no-store',
    },
  });
}
