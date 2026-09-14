/**
 * Greybox management API (Cloudflare): /api/admin/navigation
 *   GET — read the full public navigation configuration (hidden items
 *     included with their visible flags, in display order, with routes)
 *   PUT — replace it (full-replace: send the complete six-item menu in
 *     display order plus searchVisible; validated, 400 on bad input)
 *
 * The navigation menu is a fixed six-item set with stable keys (home,
 * movies, tv, anime, collections, my-list) — there is no create/delete,
 * only reorder / relabel / show-hide plus the header-search flag. Routes
 * are derived server-side from each key (controlled known routes only —
 * arbitrary URLs are never accepted). Hiding removes the entry from the
 * public navbar but keeps it server-side, so re-showing restores it.
 *
 * Gated by requireAdmin(): anonymous requests get 401/403, never touch D1.
 * The Admin Control Center (Navigation workspace) verifies saves with a
 * fresh GET — a 200 alone is never shown as success.
 */
import { getDb, readNavigation, writeSetting } from '../../lib/db.js';
import { adminCors, adminError, adminJson, readJsonBody, requireAdmin } from '../../lib/admin.js';
import { validateNavigationBody } from '../../lib/validate.js';

const METHODS = 'GET,PUT,OPTIONS';
const KEY = 'navigation';

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
      // Admin always sees exactly what the public site renders (plus flags).
      return adminJson(await readNavigation(db), 200);
    }
    if (request.method === 'PUT') {
      const body = await readJsonBody(request);
      await writeSetting(db, KEY, validateNavigationBody(body));
      // Read back through the shaped reader so the response matches GET.
      return adminJson(await readNavigation(db), 200);
    }
    return adminJson({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return adminError(e, 'admin navigation');
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: adminCors(METHODS) });
}
