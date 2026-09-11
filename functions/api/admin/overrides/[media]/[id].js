/**
 * Greybox management API (Cloudflare): /api/admin/overrides/:media/:id
 *   GET    — read one override (fields only), 404 when missing
 *   PUT    — replace its fields (≥1 valid field required), 404 when missing
 *   DELETE — remove, 204 on success, 404 when missing
 *
 * Gated by requireAdmin(): anonymous requests get 401/403, never touch D1.
 */
import { deleteOverride, getDb, readOverride, updateOverride } from '../../../../lib/db.js';
import { adminCors, adminError, adminJson, readJsonBody, requireAdmin } from '../../../../lib/admin.js';
import { validateMedia, validateOverrideFields, validateTmdbId } from '../../../../lib/validate.js';

const METHODS = 'GET,PUT,DELETE,OPTIONS';

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
    if (!target) return adminJson({ error: 'URL must be /api/admin/overrides/movie|tv/:tmdb_id' }, 400);

    if (request.method === 'GET') {
      const row = await readOverride(db, target.media, target.id);
      if (!row) return adminJson({ error: 'Override not found' }, 404);
      return adminJson(row, 200);
    }
    if (request.method === 'PUT') {
      const body = await readJsonBody(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return adminJson({ error: 'Body must be a JSON object.' }, 400);
      }
      if (body.media != null && body.media !== target.media) {
        return adminJson({ error: 'Body media must match the URL.' }, 400);
      }
      const bid = body.tmdb_id != null ? body.tmdb_id : body.id;
      if (bid != null && Number(bid) !== target.id) {
        return adminJson({ error: 'Body tmdb_id must match the URL.' }, 400);
      }
      const updated = await updateOverride(db, target.media, target.id, validateOverrideFields(body));
      if (!updated) return adminJson({ error: 'Override not found' }, 404);
      return adminJson(updated, 200);
    }
    if (request.method === 'DELETE') {
      const removed = await deleteOverride(db, target.media, target.id);
      if (!removed) return adminJson({ error: 'Override not found' }, 404);
      return new Response(null, { status: 204, headers: { ...adminCors(METHODS), 'Cache-Control': 'no-store' } });
    }
    return adminJson({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return adminError(e, 'admin overrides/:media/:id');
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: adminCors(METHODS) });
}
