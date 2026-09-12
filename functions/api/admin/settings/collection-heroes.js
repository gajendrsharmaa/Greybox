/**
 * Greybox management API (Cloudflare): /api/admin/settings/collection-heroes
 *   GET — read the collection_heroes map ({ [slug]: hero override })
 *   PUT — replace it (validated; unknown slugs kept, shape-checked)
 *
 * Gated by requireAdmin(): anonymous requests get 401/403, never touch D1.
 * Absent slugs / mode 'default' mean default hero behavior (first item).
 */
import { getDb, readSetting, writeSetting } from '../../../lib/db.js';
import { adminCors, adminError, adminJson, readJsonBody, requireAdmin } from '../../../lib/admin.js';
import { validateCollectionHeroes } from '../../../lib/validate.js';

const METHODS = 'GET,PUT,OPTIONS';
const KEY = 'collection_heroes';

export async function onRequest(context) {
  try {
    const { request, env } = context;
    if (request.method === 'OPTIONS') return new Response(null, { headers: adminCors(METHODS) });

    const gate = requireAdmin(request, env);
    if (!gate.ok) return adminJson({ error: gate.error }, gate.status);

    const db = getDb(env);
    if (!db) return adminJson({ error: 'Greybox config database (D1 binding DB) is not configured. See README.' }, 503);

    if (request.method === 'GET') {
      const heroes = (await readSetting(db, KEY)) || {};
      return adminJson(heroes && typeof heroes === 'object' ? heroes : {}, 200);
    }
    if (request.method === 'PUT') {
      const body = await readJsonBody(request);
      const stored = await writeSetting(db, KEY, validateCollectionHeroes(body));
      return adminJson(stored && typeof stored === 'object' ? stored : {}, 200);
    }
    return adminJson({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return adminError(e, 'admin settings/collection-heroes');
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: adminCors(METHODS) });
}
