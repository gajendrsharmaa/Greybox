/**
 * Greybox management API (Cloudflare): /api/admin/tags/:slug
 *   GET    — read one tag with ordered members + usage, 404 when missing
 *   PUT    — full update incl. ordered members (slug immutable), 404 when missing
 *   DELETE — remove tag + memberships, 204 on success, 404 when missing,
 *            409 with used_by when home sections/collections reference it
 *
 * Gated by requireAdmin(): anonymous requests get 401/403, never touch D1.
 * Deletion is BLOCKED (not cascaded) while references exist: dangling
 * {type:"tag"} sources must never be created silently. The 409 body carries
 * the real reference list so the Admin can link the operator to each user.
 */
import { deleteTag, findTagUsage, getDb, readTag, updateTag } from '../../../lib/db.js';
import { adminCors, adminError, adminJson, readJsonBody, requireAdmin } from '../../../lib/admin.js';
import { validateSlug, validateTagBody } from '../../../lib/validate.js';

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
    if (!slug) return adminJson({ error: 'Invalid tag slug' }, 400);

    if (request.method === 'GET') {
      const tag = await readTag(db, slug);
      if (!tag) return adminJson({ error: 'Tag not found' }, 404);
      return adminJson({ ...tag, used_by: await findTagUsage(db, slug) }, 200);
    }
    if (request.method === 'PUT') {
      const body = await readJsonBody(request);
      if (body && body.slug != null && String(body.slug).trim().toLowerCase() !== slug) {
        return adminJson({ error: 'Body slug must match the URL slug (rename via delete + create).' }, 400);
      }
      const updated = await updateTag(db, slug, validateTagBody({ ...body, slug }));
      if (!updated) return adminJson({ error: 'Tag not found' }, 404);
      return adminJson({ ...updated, used_by: await findTagUsage(db, slug) }, 200);
    }
    if (request.method === 'DELETE') {
      const usedBy = await findTagUsage(db, slug);
      if (usedBy.sections.length || usedBy.collections.length) {
        return adminJson({
          error: `Tag "${slug}" is still used as a content source. Remove it from the listed sections/collections first.`,
          used_by: usedBy,
        }, 409);
      }
      const removed = await deleteTag(db, slug);
      if (!removed) return adminJson({ error: 'Tag not found' }, 404);
      return new Response(null, { status: 204, headers: { ...adminCors(METHODS), 'Cache-Control': 'no-store' } });
    }
    return adminJson({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return adminError(e, 'admin tags/:slug');
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: adminCors(METHODS) });
}
