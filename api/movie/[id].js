/**
 * Greybox API (Vercel): GET /api/movie/:id?region=US
 * Movie detail bundle (replaces 4 frontend calls).
 */
'use strict';

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return cors(res).status(200).send('');
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });

    const gb = await import('../../functions/lib/greybox.js');
    const creds = gb.getCreds(process.env);
    if (!creds) return json(res, 500, { error: 'Missing TMDB_READ_TOKEN (or TMDB_API_KEY) env var. See README.' });

    const raw = req.query && req.query.id !== undefined ? req.query.id : '';
    const id = gb.parseId(Array.isArray(raw) ? raw[0] : raw);
    if (!id) return json(res, 400, { error: 'Invalid movie id' });

    const region = gb.parseRegion(req.query && req.query.region);
    const base = { language: 'en-US' };
    const [detail, credits, videos, providers] = await Promise.all([
      gb.tmdbGet(creds, 'movie/' + id, base),
      gb.tmdbGet(creds, 'movie/' + id + '/credits', base).catch(() => ({ cast: [] })),
      gb.tmdbGet(creds, 'movie/' + id + '/videos', base).catch(() => ({ results: [] })),
      gb.tmdbGet(creds, 'movie/' + id + '/watch/providers', {}).catch(() => ({ results: {} })),
    ]);
    return json(res, 200, gb.shapeDetail(detail, credits, videos, providers, region, 'movie'), true);
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
