/**
 * Greybox management API (Cloudflare): /api/admin/blocked/:media/:id
 *   GET    — read one blocked title (with snapshot), 404 when not blocked
 *   DELETE — unblock, 204 on success, 404 when not blocked
 *
 * Identity is ALWAYS media + TMDB ID from the URL (never title text).
 * Gated by requireAdmin(): anonymous requests get 401/403, never touch D1.
 */
import { deleteBlocked, getDb, readBlocked } from '../../../../lib/db.js';
import { adminCors, adminError, adminJson, requireAdmin } from '../../../../lib/admin.js';
import { validateMedia, validateTmdbId } from '../../../../lib/validate.js';

const METHODS = 'GET,DELETE,OPTIONS';

function targetFrom(params) {
  try {
    const rawMedia = params.media ?? params['media'] ?? '';
    const rawId = params.id ?? params['id'] ?? '';
    const media = validateMedia(String(Array.isArray(rawMedia) ? rawMedia[0] : rawMedia).trim().toLowerCase());
    const id = validateTmdbId(Array.isArray(rawId) ? rawId[0] : rawId);
    return { media, id };
  } catch {
    return null;
  }
}

export async function onRequest(context) {
  try {
    const { request, env, params } = context;
    if (request.method === 'OPTIONS') return new Response(null, { headers: adminCors(METHODS) });

    const gate = requireAdmin(request, env);
    if (!gate.ok) return adminJson({ error: gate.error }, gate.status);

    const db = getDb(env);
    if (!db) return adminJson({ error: 'Greybox config database (D1 binding DB) is not configured. See README.' }, 503);

    const target = targetFrom(params);
    if (!target) return adminJson({ error: 'URL must be /api/admin/blocked/movie|tv/:tmdb_id' }, 400);

    if (request.method === 'GET') {
      const row = await readBlocked(db, target.media, target.id);
      if (!row) return adminJson({ error: 'Blocked title not found' }, 404);
      return adminJson(row, 200);
    }
    if (request.method === 'DELETE') {
      const removed = await deleteBlocked(db, target.media, target.id);
      if (!removed) return adminJson({ error: 'Blocked title not found' }, 404);
      return new Response(null, { status: 204, headers: { ...adminCors(METHODS), 'Cache-Control': 'no-store' } });
    }
    return adminJson({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return adminError(e, 'admin blocked/:media/:id');
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: adminCors(METHODS) });
}
