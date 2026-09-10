/**
 * Greybox API (Vercel): GET /api/trending?page=1
 * Home "Trending Now" rail + hero. Upstream: trending/all/week.
 * Shares shaping logic with Cloudflare via functions/lib/greybox.js.
 */
'use strict';

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return cors(res).status(200).send('');
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });

    const gb = await import('../functions/lib/greybox.js');
    const creds = gb.getCreds(process.env);
    if (!creds) return json(res, 500, { error: 'Missing TMDB_READ_TOKEN (or TMDB_API_KEY) env var. See README.' });

    const page = gb.parsePage(req.query && req.query.page);
    const data = await gb.tmdbGet(creds, 'trending/all/week', { language: 'en-US', page });
    return json(res, 200, gb.shapeList(data), true);
  } catch (e) {
    return json(res, (e && e.status) || 500, { error: (e && e.message) || String(e) });
  }
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return res;
}

function json(res, status, obj, cache = false) {
  res.status(status);
  res.setHeader('content-type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', status === 200 && cache ? 'public, max-age=600' : 'no-store');
  res.send(JSON.stringify(obj));
}
