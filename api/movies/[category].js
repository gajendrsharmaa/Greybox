/**
 * Greybox API (Vercel): GET /api/movies/:category?page=1
 * :category = popular | top-rated | upcoming | now-playing
 */
'use strict';

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return cors(res).status(200).send('');
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });

    const gb = await import('../../functions/lib/greybox.js');
    const creds = gb.getCreds(process.env);
    if (!creds) return json(res, 500, { error: 'Missing TMDB_READ_TOKEN (or TMDB_API_KEY) env var. See README.' });

    const raw = req.query && req.query.category !== undefined ? req.query.category : '';
    const category = String(Array.isArray(raw) ? raw[0] : raw || '').toLowerCase();
    const tmdbCat = gb.MOVIE_CATS[category];
    if (!tmdbCat) {
      return json(res, 400, { error: 'Unknown movies category: ' + (category || '(empty)') + '. Use: ' + Object.keys(gb.MOVIE_CATS).join(', ') });
    }

    const page = gb.parsePage(req.query && req.query.page);
    const data = await gb.tmdbGet(creds, 'movie/' + tmdbCat, { language: 'en-US', page });
    return json(res, 200, gb.shapeList(data, 'movie'), true);
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
