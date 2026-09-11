/**
 * Greybox management API (Cloudflare): /api/admin/collections/:slug
 *   GET    — read one collection (hidden included), 404 when missing
 *   PUT    — full update (body.slug must match when present), 404 when missing
 *   DELETE — remove, 204 on success, 404 when missing
 *
 * Gated by requireAdmin(): anonymous requests get 401/403, never touch D1.
 */
import { deleteCollection, getDb, readCollection, updateCollection } from '../../../lib/db.js';
import { adminCors, adminError, adminJson, readJsonBody, requireAdmin } from '../../../lib/admin.js';
import { validateCollectionBody, validateSlug } from '../../../lib/validate.js';

const METHODS = 'GET,PUT,DELETE,OPTIONS';

function slugFrom(params) {
  const raw = params.slug ?? params['slug'] ?? '';
  const s = String(Array.isArray(raw) ? raw[0] : raw).trim().toLowerCase();
  try {
    return validateSlug(s);
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

    const slug = slugFrom(params);
    if (!slug) return adminJson({ error: 'Invalid collection slug' }, 400);

    if (request.method === 'GET') {
      const col = await readCollection(db, slug);
      if (!col) return adminJson({ error: 'Collection not found' }, 404);
      return adminJson(col, 200);
    }
    if (request.method === 'PUT') {
      const body = await readJsonBody(request);
      if (body && body.slug != null && String(body.slug).trim().toLowerCase() !== slug) {
        return adminJson({ error: 'Body slug must match the URL slug (rename via delete + create).' }, 400);
      }
      const updated = await updateCollection(db, slug, validateCollectionBody({ ...body, slug }));
      if (!updated) return adminJson({ error: 'Collection not found' }, 404);
      return adminJson(updated, 200);
    }
    if (request.method === 'DELETE') {
      const removed = await deleteCollection(db, slug);
      if (!removed) return adminJson({ error: 'Collection not found' }, 404);
      return new Response(null, { status: 204, headers: { ...adminCors(METHODS), 'Cache-Control': 'no-store' } });
    }
    return adminJson({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return adminError(e, 'admin collections/:slug');
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: adminCors(METHODS) });
}
