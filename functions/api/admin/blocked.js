/**
 * Greybox management API (Cloudflare): /api/admin/blocked
 *   GET  — list all blocked titles (with Admin display snapshots), newest first
 *   POST — block a title { media, tmdb_id, title?, poster_path?, backdrop_path?, year? } (201),
 *          409 when the same media + TMDB ID is already blocked, 400 on bad input
 *
 * Identity is ALWAYS media + TMDB ID (never title text). The entire namespace
 * is gated by requireAdmin(): anonymous requests get 401/403 and never touch
 * D1. The Admin Control Center (admin.html/js/admin.js Blocked Titles
 * workspace) is the primary caller: list/block/unblock plus read-back
 * verification after every mutation.
 */
import { createBlocked, getDb, readBlockedTitles } from '../../lib/db.js';
import { adminCors, adminError, adminJson, readJsonBody, requireAdmin } from '../../lib/admin.js';
import { validateBlockedBody } from '../../lib/validate.js';

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
      return adminJson(await readBlockedTitles(db), 200);
    }
    if (request.method === 'POST') {
      const body = await readJsonBody(request);
      const created = await createBlocked(db, validateBlockedBody(body));
      return adminJson(created, 201);
    }
    return adminJson({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return adminError(e, 'admin blocked');
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: adminCors(METHODS) });
}
