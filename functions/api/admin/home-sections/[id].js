/**
 * Greybox management API (Cloudflare): /api/admin/home-sections/:id
 *   GET    — read one homepage section, 404 when missing
 *   PUT    — full update (body.id must match when present), 404 when missing
 *   DELETE — remove, 204 on success, 404 when missing
 *
 * Gated by requireAdmin(): anonymous requests get 401/403, never touch D1.
 */
import { deleteHomeSection, getDb, readHomeSection, updateHomeSection } from '../../../lib/db.js';
import { adminCors, adminError, adminJson, readJsonBody, requireAdmin } from '../../../lib/admin.js';
import { validateHomeSectionBody, validateSectionId } from '../../../lib/validate.js';

const METHODS = 'GET,PUT,DELETE,OPTIONS';

function idFrom(params) {
  const raw = params.id ?? params['id'] ?? '';
  const s = String(Array.isArray(raw) ? raw[0] : raw).trim();
  try {
    return validateSectionId(s);
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

    const id = idFrom(params);
    if (!id) return adminJson({ error: 'Invalid home section id' }, 400);

    if (request.method === 'GET') {
      const section = await readHomeSection(db, id);
      if (!section) return adminJson({ error: 'Home section not found' }, 404);
      return adminJson(section, 200);
    }
    if (request.method === 'PUT') {
      const body = await readJsonBody(request);
      if (body && body.id != null && String(body.id).trim() !== id) {
        return adminJson({ error: 'Body id must match the URL id (rename via delete + create).' }, 400);
      }
      const updated = await updateHomeSection(db, id, validateHomeSectionBody({ ...body, id }));
      if (!updated) return adminJson({ error: 'Home section not found' }, 404);
      return adminJson(updated, 200);
    }
    if (request.method === 'DELETE') {
      const removed = await deleteHomeSection(db, id);
      if (!removed) return adminJson({ error: 'Home section not found' }, 404);
      return new Response(null, { status: 204, headers: { ...adminCors(METHODS), 'Cache-Control': 'no-store' } });
    }
    return adminJson({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return adminError(e, 'admin home-sections/:id');
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: adminCors(METHODS) });
}
