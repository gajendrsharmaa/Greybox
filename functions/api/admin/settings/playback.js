/**
 * Greybox management API (Cloudflare): /api/admin/settings/playback
 *   GET — read the playback mode setting (the single authoritative
 *     Playback config: D1 settings.playback with { mode })
 *   PUT — replace it (full-replace: send the complete object;
 *     validated like the local js/playback.config.js fallback)
 *
 * V1 exposes exactly ONE setting: mode (auto/direct/embed). No provider
 * URLs, tokens, or secrets are accepted or stored here. Direct mode fails
 * cleanly for catalog titles when no direct production source exists
 * (today: always — the EMBED resolver supplies embed-page URLs only).
 *
 * Gated by requireAdmin(): anonymous requests get 401/403, never touch D1.
 */
import { getDb, readPlayback, writeSetting } from '../../../lib/db.js';
import { adminCors, adminError, adminJson, readJsonBody, requireAdmin } from '../../../lib/admin.js';
import { validatePlaybackBody } from '../../../lib/validate.js';

const METHODS = 'GET,PUT,OPTIONS';
const KEY = 'playback';

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
      // Admin always sees exactly what the public resolver uses.
      return adminJson(await readPlayback(db), 200);
    }
    if (request.method === 'PUT') {
      const body = await readJsonBody(request);
      await writeSetting(db, KEY, validatePlaybackBody(body));
      // Read back through the shaped reader so the response matches GET.
      return adminJson(await readPlayback(db), 200);
    }
    return adminJson({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return adminError(e, 'admin settings/playback');
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: adminCors(METHODS) });
}
