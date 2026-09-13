/**
 * Greybox management-API shared helpers: authorization boundary + HTTP plumbing.
 *
 * SECURITY MODEL (Admin Control Panel in admin.html/js/admin.js, no user accounts):
 * - Write routes under /api/admin/* MUST call requireAdmin() first.
 * - Authorization is a server-side bearer token compared in constant time
 *   against the GREYBOX_ADMIN_TOKEN Pages secret (local: .dev.vars, never
 *   committed). The token NEVER appears in frontend JavaScript, API
 *   responses, or the repo.
 * - Until GREYBOX_ADMIN_TOKEN is configured, every protected route fails
 *   CLOSED (401) — anonymous visitors can never mutate D1 by accident.
 *
 * Status convention used by all admin routes:
 *   401 — missing credentials, or admin auth not configured yet
 *   403 — credentials presented but invalid
 */

function timingSafeEqual(a, b) {
  const x = String(a), y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function bearerToken(request) {
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (!m) return '';
  return m[1].trim().slice(0, 512);
}

/**
 * Gate for /api/admin/* write routes. Returns { ok: true } or
 * { ok: false, status, error } — route handlers return early on !ok.
 * Never throws, never leaks the expected token or stack traces.
 */
export function requireAdmin(request, env) {
  let expected = '';
  try {
    expected = String((env && env.GREYBOX_ADMIN_TOKEN) || '').trim();
  } catch {
    expected = '';
  }
  if (!expected) {
    return {
      ok: false,
      status: 401,
      error: 'Admin authentication is not configured. Set the GREYBOX_ADMIN_TOKEN secret (Pages env vars / .dev.vars) — see README.',
    };
  }
  const got = bearerToken(request);
  if (!got) {
    return { ok: false, status: 401, error: 'Missing admin credentials. Send Authorization: Bearer <token>.' };
  }
  if (!timingSafeEqual(got, expected)) {
    return { ok: false, status: 403, error: 'Invalid admin credentials.' };
  }
  return { ok: true };
}

/** Parse a JSON request body. Throws { status: 400 } on bad JSON. */
export async function readJsonBody(request) {
  let raw = '';
  try {
    raw = await request.text();
  } catch {
    throw { status: 400, message: 'Could not read request body.' };
  }
  if (!raw.trim()) throw { status: 400, message: 'Request body must be a JSON object.' };
  try {
    const parsed = JSON.parse(raw);
    return parsed;
  } catch {
    throw { status: 400, message: 'Request body must be valid JSON.' };
  }
}

export function adminCors(methods) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export function adminJson(o, s = 200) {
  return new Response(JSON.stringify(o), {
    status: s,
    headers: {
      'content-type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Map any thrown value to a safe JSON error Response. ValidationError-style
 * throws ({ status, message }) keep their message; everything else becomes
 * a generic 500 with the details logged server-side only — no stack traces,
 * no SQL, no secrets ever reach the client.
 */
export function adminError(e, logCtx) {
  try {
    if (e && typeof e.status === 'number' && e.status >= 400 && e.status < 500) {
      return adminJson({ error: e.message || 'Invalid request.' }, e.status);
    }
    console.error('[admin]', logCtx || 'error', e && e.message ? e.message : e);
  } catch { /* logging must never break the response */ }
  return adminJson({ error: 'Internal error.' }, 500);
}
