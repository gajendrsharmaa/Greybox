/**
 * Greybox management API (Cloudflare): /api/admin/home-sections
 *   GET  — list all homepage sections in display order (hidden included)
 *   POST — create a section (201), 409 on duplicate id, 400 on bad input
 *
 * Entire namespace is gated by requireAdmin(): anonymous requests get
 * 401/403 and never touch D1. No admin UI calls this yet.
 */
import { createHomeSection, getDb, readHomeConfig } from '../../lib/db.js';
import { adminCors, adminError, adminJson, readJsonBody, requireAdmin } from '../../lib/admin.js';
import { validateHomeSectionBody } from '../../lib/validate.js';

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
      const cfg = await readHomeConfig(db);
      return adminJson(cfg.sections, 200);
    }
    if (request.method === 'POST') {
      const body = await readJsonBody(request);
      const created = await createHomeSection(db, validateHomeSectionBody(body));
      return adminJson(created, 201);
    }
    return adminJson({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return adminError(e, 'admin home-sections');
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: adminCors(METHODS) });
}
