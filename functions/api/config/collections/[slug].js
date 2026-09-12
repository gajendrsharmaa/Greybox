/**
 * Greybox API (Cloudflare): GET /api/config/collections/:slug
 * One collection from D1. Unknown slugs AND hidden collections are 404,
 * mirroring the local-config behavior in js/data.js getCollection().
 */
import { getDb, readCollection, readSetting } from '../../../lib/db.js';
import { sanitizeCollectionHero } from '../../../lib/validate.js';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function onRequest(context) {
  try {
    const { request, env, params } = context;
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

    const db = getDb(env);
    if (!db) return json({ error: 'Greybox config database (D1 binding DB) is not configured. See README.' }, 503);

    const raw = params.slug ?? params['slug'] ?? '';
    const slug = String(Array.isArray(raw) ? raw[0] : raw).trim().toLowerCase();
    if (!slug || slug.length > 64 || !SLUG.test(slug)) return json({ error: 'Invalid collection slug' }, 400);

    const col = await readCollection(db, slug);
    if (!col || col.visible === false) return json({ error: 'Collection not found' }, 404);
    // Collection hero override (null = default behavior: first shown item).
    // Re-sanitized on every read so a stale/hand-edited map can never break
    // public rendering. Additive field — existing clients ignore it.
    let hero = null;
    try {
      const heroes = await readSetting(db, 'collection_heroes');
      hero = sanitizeCollectionHero(heroes, slug);
    } catch {
      hero = null;
    }
    return json({ ...col, hero }, 200);
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
