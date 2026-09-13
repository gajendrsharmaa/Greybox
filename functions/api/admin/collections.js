/**
 * Greybox management API (Cloudflare): /api/admin/collections
 *   GET  — list all collections in display order (hidden included)
 *   POST — create a collection (201), 409 on duplicate slug, 400 on bad input
 *
 * Entire namespace is gated by requireAdmin(): anonymous requests get
 * 401/403 and never touch D1. The Admin Control Center (admin.html/js/admin.js
 * Collections workspace) is the primary caller: list/read/create/full-update/
 * delete plus reorder (sort_order swaps), visibility toggles and read-back
 * verification after every mutation.
 */
import { createCollection, getDb, readCollections } from '../../lib/db.js';
import { adminCors, adminError, adminJson, readJsonBody, requireAdmin } from '../../lib/admin.js';
import { validateCollectionBody } from '../../lib/validate.js';

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
      return adminJson(await readCollections(db), 200);
    }
    if (request.method === 'POST') {
      const body = await readJsonBody(request);
      const created = await createCollection(db, validateCollectionBody(body));
      return adminJson(created, 201);
    }
    return adminJson({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return adminError(e, 'admin collections');
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: adminCors(METHODS) });
}
