/**
 * Greybox management API (Cloudflare): /api/admin/settings/home-hero
 *   GET — read the homepage hero setting (the single authoritative Home Hero:
 *     D1 settings.home_hero: { mode, badge, pick, source, heroItem, artwork, trailer })
 *   PUT — replace it (validated like the local homepage.config.js hero)
 *
 * Authority per mode (shared with the public homepage — see README §4 and
 * js/data.js getHeroItem): spotlight honors heroItem, custom honors
 * source+pick, follow-grid honors the grid. Fields for other modes are
 * preserved but inactive. Artwork/trailer travel with every mode.
 *
 * Gated by requireAdmin(): anonymous requests get 401/403, never touch D1.
 */
import { getDb, readSetting, writeSetting } from '../../../lib/db.js';
import { adminCors, adminError, adminJson, readJsonBody, requireAdmin } from '../../../lib/admin.js';
import { validateHero } from '../../../lib/validate.js';

const METHODS = 'GET,PUT,OPTIONS';
const KEY = 'home_hero';

export async function onRequest(context) {
  try {
    const { request, env } = context;
    if (request.method === 'OPTIONS') return new Response(null, { headers: adminCors(METHODS) });

    const gate = requireAdmin(request, env);
    if (!gate.ok) return adminJson({ error: gate.error }, gate.status);

    const db = getDb(env);
    if (!db) return adminJson({ error: 'Greybox config database (D1 binding DB) is not configured. See README.' }, 503);

    if (request.method === 'GET') {
      const hero = (await readSetting(db, KEY)) || { mode: 'follow-grid' };
      return adminJson(hero, 200);
    }
    if (request.method === 'PUT') {
      const body = await readJsonBody(request);
      const stored = await writeSetting(db, KEY, validateHero(body));
      return adminJson(stored, 200);
    }
    return adminJson({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return adminError(e, 'admin settings/home-hero');
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: adminCors(METHODS) });
}
