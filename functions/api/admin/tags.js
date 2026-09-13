/**
 * Greybox management API (Cloudflare): /api/admin/tags
 *   GET  — list all tags in display order with member counts (hidden included)
 *   POST — create a tag (201), 409 on duplicate slug, 400 on bad input
 *
 * Entire namespace is gated by requireAdmin(): anonymous requests get
 * 401/403 and never touch D1. The Admin Control Center (admin.html/js/admin.js
 * Tags workspace) is the primary caller: list/read/create/full-update/
 * delete plus membership management, usage display and read-back
 * verification after every mutation.
 */
import { createTag, getDb, readTags } from '../../lib/db.js';
import { adminCors, adminError, adminJson, readJsonBody, requireAdmin } from '../../lib/admin.js';
import { validateTagBody } from '../../lib/validate.js';

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
      return adminJson(await readTags(db), 200);
    }
    if (request.method === 'POST') {
      const body = await readJsonBody(request);
      const created = await createTag(db, validateTagBody(body));
      return adminJson(created, 201);
    }
    return adminJson({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return adminError(e, 'admin tags');
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: adminCors(METHODS) });
}
