/**
 * Greybox API (Vercel): GET /api/search?q=...&page=1
 * Header search dropdown. Upstream: search/multi (movie+tv only, needs image).
 */
'use strict';

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return cors(res).status(200).send('');
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });

    const gb = await import('../functions/lib/greybox.js');
    const creds = gb.getCreds(process.env);
    if (!creds) return json(res, 500, { error: 'Missing TMDB_READ_TOKEN (or TMDB_API_KEY) env var. See README.' });

    const q = String((req.query && req.query.q) || '').trim();
    if (!q) return json(res, 400, { error: 'Missing ?q= search query' });
    const page = gb.parsePage(req.query && req.query.page);
    const data = await gb.tmdbGet(creds, 'search/multi', {
      language: 'en-US',
      query: q,
      page,
      include_adult: 'false',
    });
    return json(res, 200, gb.shapeSearch(data, q), true);
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
