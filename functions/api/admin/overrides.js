/**
 * Greybox management API (Cloudflare): /api/admin/overrides
 *   GET  — list all metadata overrides (override fields only, never TMDB data)
 *   POST — create an override { media, tmdb_id, ...fields } (201),
 *          409 on duplicate, 400 on bad input
 *
 * Entire namespace is gated by requireAdmin(): anonymous requests get
 * 401/403 and never touch D1. No admin UI calls this yet.
 */
import { createOverride, getDb, readOverrides } from '../../lib/db.js';
import { adminCors, adminError, adminJson, readJsonBody, requireAdmin } from '../../lib/admin.js';
import { validateMedia, validateOverrideFields, validateTmdbId } from '../../lib/validate.js';

const METHODS = 'GET,POST,OPTIONS';

export async function onRequest(context) {
  try {
    const { request, env } = context;
    if (request.method === 'OPTIONS') return new Response(null, { headers: adminCors(METHODS) });

    const gate = requireAdmin(request, env);
    if (!gate.ok) return adminJson({ error: gate.error }, gate.status);

    const db = getDb(env);
    if (!db) return adminJson({ error: 'Greybox config database (D1 binding DB) is not configured. See README.' }, 503);

    if (request.method === 'GET') {
      return adminJson(await readOverrides(db), 200);
    }
    if (request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return adminJson({ error: 'Body must be a JSON object.' }, 400);
      }
      const created = await createOverride(db, {
        media: validateMedia(body.media),
        tmdb_id: validateTmdbId(body.tmdb_id != null ? body.tmdb_id : body.id),
        fields: validateOverrideFields(body),
      });
      return adminJson(created, 201);
    }
    return adminJson({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return adminError(e, 'admin overrides');
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: adminCors(METHODS) });
}
