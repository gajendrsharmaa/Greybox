/**
 * Greybox management API (Cloudflare): /api/admin/settings/detail-pages
 *   GET — read the detail page presentation setting (the single
 *     authoritative Detail Pages config: D1 settings.detail_pages with
 *     grouped visibility flags for header/actions/content/tv)
 *   PUT — replace it (full-replace: send the complete grouped object;
 *     validated like the local js/detail-pages.config.js fallback)
 *
 * Every flag defaults to shown, so a fresh row renders exactly the current
 * detail page. TV-only flags safely no-op for movies. Presentation never
 * overrides Blocked Titles (enforced upstream in js/data.js before render).
 *
 * Gated by requireAdmin(): anonymous requests get 401/403, never touch D1.
 */
import { getDb, readDetailPages, writeSetting } from '../../../lib/db.js';
import { adminCors, adminError, adminJson, readJsonBody, requireAdmin } from '../../../lib/admin.js';
import { validateDetailPagesBody } from '../../../lib/validate.js';

const METHODS = 'GET,PUT,OPTIONS';
const KEY = 'detail_pages';

export async function onRequest(context) {
  try {
    const { request, env } = context;
    if (request.method === 'OPTIONS') return new Response(null, { headers: adminCors(METHODS) });

    const gate = requireAdmin(request, env);
    if (!gate.ok) return adminJson({ error: gate.error }, gate.status);

    const db = getDb(env);
    if (!db) return adminJson({ error: 'Greybox config database (D1 binding DB) is not configured. See README.' }, 503);

    if (request.method === 'GET') {
      // Shaped through the same lenient reader the public route uses so the
      // Admin always sees exactly what the public site renders.
      return adminJson(await readDetailPages(db), 200);
    }
    if (request.method === 'PUT') {
      const body = await readJsonBody(request);
      const stored = await writeSetting(db, KEY, validateDetailPagesBody(body));
      return adminJson(stored, 200);
    }
    return adminJson({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return adminError(e, 'admin settings/detail-pages');
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: adminCors(METHODS) });
}
