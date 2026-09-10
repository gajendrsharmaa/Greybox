/**
 * Greybox API (Vercel): /api/tv/* — one file, three shapes:
 *   GET /api/tv/:category?page=1        list
 *   GET /api/tv/:id?region=US           detail bundle
 *   GET /api/tv/:id/season/:n           season (episodes)
 */
'use strict';

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return cors(res).status(200).send('');
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });

    const gb = await import('../../functions/lib/greybox.js');
    const creds = gb.getCreds(process.env);
    if (!creds) return json(res, 500, { error: 'Missing TMDB_READ_TOKEN (or TMDB_API_KEY) env var. See README.' });

    const raw = req.query && req.query.rest !== undefined ? req.query.rest : [];
    const parts = (Array.isArray(raw) ? raw : String(raw || '').split('/').filter(Boolean))
      .map((p) => String(p));

    // /api/tv/:id/season/:n
    if (parts.length === 3 && parts[1].toLowerCase() === 'season') {
      const id = gb.parseId(parts[0]);
      const n = gb.parseId(parts[2]);
      if (!id || !n) return json(res, 400, { error: 'Invalid tv id or season number' });
      const data = await gb.tmdbGet(creds, 'tv/' + id + '/season/' + n, { language: 'en-US' });
      return json(res, 200, gb.shapeSeason(data, id, n), true);
    }

    if (parts.length === 1) {
      const [seg] = parts;
      if (/^\d+$/.test(seg)) {
        const id = gb.parseId(seg);
        const region = gb.parseRegion(req.query && req.query.region);
        const base = { language: 'en-US' };
        const [detail, credits, videos, providers] = await Promise.all([
          gb.tmdbGet(creds, 'tv/' + id, base),
          gb.tmdbGet(creds, 'tv/' + id + '/credits', base).catch(() => ({ cast: [] })),
          gb.tmdbGet(creds, 'tv/' + id + '/videos', base).catch(() => ({ results: [] })),
          gb.tmdbGet(creds, 'tv/' + id + '/watch/providers', {}).catch(() => ({ results: {} })),
        ]);
        return json(res, 200, gb.shapeDetail(detail, credits, videos, providers, region, 'tv'), true);
      }
      const tmdbCat = gb.TV_CATS[seg.toLowerCase()];
      if (!tmdbCat) {
        return json(res, 400, { error: 'Unknown tv route: ' + seg + '. Use a category (' + Object.keys(gb.TV_CATS).join(', ') + '), a numeric id, or :id/season/:n' });
      }
      const page = gb.parsePage(req.query && req.query.page);
      const data = await gb.tmdbGet(creds, 'tv/' + tmdbCat, { language: 'en-US', page });
      return json(res, 200, gb.shapeList(data, 'tv'), true);
    }

    return json(res, 400, { error: 'Unknown tv route. Use /api/tv/:category, /api/tv/:id, or /api/tv/:id/season/:n' });
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
