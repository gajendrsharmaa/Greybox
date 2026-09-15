/**
 * Greybox API (Cloudflare): GET /api/config/navigation
 * Public navigation configuration from D1 (Greybox-owned labels, order and
 * visibility only — no TMDB data here). All six items with their visible
 * flags, in display order, plus controlled routes — the browser filters by
 * `visible` (same pattern as collections: the list endpoint returns hidden
 * rows too and renderers decide). No caching on purpose:
 * navigation edits apply immediately after an Admin save.
 */
import { getDb, readNavigation } from '../../lib/db.js';

export async function onRequest(context) {
  try {
    const { request, env } = context;
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

    const db = getDb(env);
    if (!db) return json({ error: 'Greybox config database (D1 binding DB) is not configured. See README.' }, 503);

    return json(await readNavigation(db), 200);
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
      // Tiny config, edits must verify immediately: never cache at the edge
      // or in the browser (unlike TMDB-backed routes which cache for 10 min).
      'Cache-Control': 'no-store',
    },
  });
}
