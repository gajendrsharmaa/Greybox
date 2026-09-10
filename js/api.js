/* API layer: Greybox-owned endpoints first, TMDB proxy as fallback transport.
 *
 * The frontend talks to same-origin Greybox endpoints (/api/trending,
 * /api/movies/*, /api/tv/*, /api/movie/*, /api/anime/*, /api/search) and
 * NEVER constructs TMDB paths itself. The secret lives ONLY in server-side
 * env vars (TMDB_READ_TOKEN / TMDB_API_KEY on Cloudflare Pages or Vercel)
 * and is never present in this file, so the repo is safe to push.
 *
 * `tmdb()` (raw /api/tmdb/* proxy) is KEPT for the local static-preview
 * fallback below — do not remove while that fallback exists. */
(function () {
  const LS_TOKEN = 'sb_tmdb_token';
  const LS_REGION = 'sb_region';

  // Per-browser dev override for local static preview only (Settings UI,
  // stored in the visitor's own localStorage, never committed).
  // Empty by default — production traffic goes through the Greybox API.
  function getToken() { return localStorage.getItem(LS_TOKEN) || ''; }
  function getRegion() { return localStorage.getItem(LS_REGION) || 'US'; }

  async function tmdb(path, params = {}) {
    // path like "trending/all/week" or "movie/123" without leading /3/
    const qs = new URLSearchParams(params).toString();
    const proxyUrl = `/api/tmdb/${path}${qs ? '?' + qs : ''}`;

    // 1) Serverless proxy — secret key lives server-side in env vars.
    //    Works on Cloudflare Pages (functions/api/tmdb) and Vercel (api/tmdb).
    try {
      const r = await fetch(proxyUrl);
      if (r.ok) return await r.json();
      if (r.status === 404) {
        // No proxy (e.g. plain file preview without a serverless backend).
        // Fall through to dev override below.
      } else {
        const txt = await r.text().catch(() => '');
        // Never dump raw HTML (crash page) into the UI — parse JSON error if possible.
        let clean = 'Backend error ' + r.status;
        try {
          const j = JSON.parse(txt);
          if (j.error) clean += ': ' + j.error;
        } catch {
          if (txt && !txt.trim().startsWith('<')) clean += ': ' + txt.slice(0, 200);
          else clean += '. Check the server logs for the Function crash, then redeploy.';
        }
        // Dev-override direct call only if the user set one; otherwise surface backend error.
        if (!getToken()) throw new Error(clean);
        console.warn('proxy failed, trying dev override:', r.status, txt.slice(0, 200));
      }
    } catch (e) {
      if (!getToken()) throw e;
      // else fall through to direct with dev override
    }

    // 2) direct TMDB with per-browser dev override only (Settings UI, never committed).
    // Used only for local static preview when no serverless proxy is running.
    const token = getToken();
    if (!token) throw new Error('Backend not configured. Deploy with TMDB_READ_TOKEN set (Cloudflare Pages or Vercel env vars), or run `wrangler pages dev` / `vercel dev` with a local env file. See README.');
    const url = `https://api.themoviedb.org/3/${path}${qs ? '?' + qs : ''}`;
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token, accept: 'application/json' } });
    if (!res.ok) throw new Error('TMDB error ' + res.status);
    return await res.json();
  }

  /* ---------------- Greybox API client (primary data path) ---------------- */

  // Greybox category -> TMDB path. MIRROR of functions/lib/greybox.js (fallback only).
  const GB_MOVIES = { popular: 'popular', 'top-rated': 'top_rated', upcoming: 'upcoming', 'now-playing': 'now_playing' };
  const GB_TV = { popular: 'popular', 'top-rated': 'top_rated', 'on-the-air': 'on_the_air', 'airing-today': 'airing_today' };

  function gbItem(r, fallbackType) {
    const mt = r.media_type === 'tv' || r.media_type === 'movie' ? r.media_type : (fallbackType || (r.title ? 'movie' : 'tv'));
    const title = r.title || r.name || 'Untitled';
    return {
      id: r.id, media_type: mt, title, name: title,
      overview: r.overview || '',
      poster_path: r.poster_path || null,
      backdrop_path: r.backdrop_path || null,
      vote_average: typeof r.vote_average === 'number' ? r.vote_average : Number(r.vote_average || 0),
      release_date: r.release_date || '',
      first_air_date: r.first_air_date || '',
    };
  }

  function gbList(data, fallbackType) {
    const results = Array.isArray(data.results) ? data.results : [];
    return {
      page: data.page || 1,
      total_pages: data.total_pages || 1,
      total_results: data.total_results || 0,
      results: results
        .filter((x) => x.poster_path || x.backdrop_path)
        .map((x) => gbItem(x, fallbackType)),
    };
  }

  // Local fallback shapers — MIRROR of functions/lib/greybox.js shaping.
  // Used ONLY for plain-static preview (no /api backend) with a dev token set.
  async function gbDetailFallback(id, mt, region) {
    const base = { language: 'en-US' };
    const [detail, credits, videos, providers] = await Promise.all([
      tmdb(`${mt}/${id}`, base),
      tmdb(`${mt}/${id}/credits`, base).catch(() => ({ cast: [] })),
      tmdb(`${mt}/${id}/videos`, base).catch(() => ({ results: [] })),
      tmdb(`${mt}/${id}/watch/providers`, {}).catch(() => ({ results: {} })),
    ]);
    if (!detail || detail.success === false) {
      throw new Error(detail && detail.status_message ? 'TMDB: ' + detail.status_message : 'TMDB returned an error for ' + mt + '/' + id);
    }
    const title = detail.title || detail.name || 'Untitled';
    const list = (videos.results || []);
    const yt = list.find((v) => v.site === 'YouTube' && v.type === 'Trailer') || list.find((v) => v.site === 'YouTube');
    const pr = (providers.results || {})[region];
    const out = {
      id: detail.id, media_type: mt, title, name: title,
      overview: detail.overview || '',
      poster_path: detail.poster_path || null,
      backdrop_path: detail.backdrop_path || null,
      vote_average: Number(detail.vote_average || 0),
      release_date: detail.release_date || '',
      first_air_date: detail.first_air_date || '',
      genres: ((detail.genres || []).map((g) => g && g.name).filter(Boolean)),
      trailer_key: yt && yt.key ? yt.key : null,
      cast: ((credits.cast || []).slice(0, 12).map((c) => ({ name: c.name || '', character: c.character || '', profile_path: c.profile_path || null }))),
      providers: pr ? {
        region, link: pr.link || null,
        flatrate: ((pr.flatrate || []).map((x) => x.provider_name)),
        rent: ((pr.rent || []).map((x) => x.provider_name)),
        buy: ((pr.buy || []).map((x) => x.provider_name)),
      } : null,
    };
    if (mt === 'tv') {
      out.seasons = ((detail.seasons || [])
        .filter((s) => s && typeof s.season_number === 'number' && s.season_number >= 0)
        .map((s) => ({ season_number: s.season_number, name: s.name || 'Season ' + s.season_number, episode_count: s.episode_count || 0 })));
    }
    return out;
  }

  async function gbFallback(path, params) {
    const segs = String(path || '').split('/').filter(Boolean);
    const page = params.page || 1;
    if (segs[0] === 'trending' && segs.length === 1) {
      return gbList(await tmdb('trending/all/week', { language: 'en-US', page }));
    }
    if (segs[0] === 'movies' && segs.length === 2 && GB_MOVIES[segs[1]]) {
      return gbList(await tmdb('movie/' + GB_MOVIES[segs[1]], { language: 'en-US', page }), 'movie');
    }
    if (segs[0] === 'anime' && segs.length === 2 && (segs[1] === 'series' || segs[1] === 'movies')) {
      const t = segs[1] === 'series' ? 'tv' : 'movie';
      const base = { language: 'en-US', page, with_genres: '16', with_original_language: 'ja', sort_by: 'popularity.desc' };
      return gbList(await tmdb('discover/' + t, base), t);
    }
    if (segs[0] === 'movie' && segs.length === 2) {
      return gbDetailFallback(segs[1], 'movie', params.region || getRegion());
    }
    if (segs[0] === 'tv' && segs.length === 2) {
      if (GB_TV[segs[1]]) return gbList(await tmdb('tv/' + GB_TV[segs[1]], { language: 'en-US', page }), 'tv');
      return gbDetailFallback(segs[1], 'tv', params.region || getRegion());
    }
    if (segs[0] === 'tv' && segs.length === 4 && segs[2] === 'season') {
      const s = await tmdb(`tv/${segs[1]}/season/${segs[3]}`, { language: 'en-US' });
      return {
        id: +segs[1], season_number: +segs[3], name: s.name || 'Season ' + segs[3],
        episodes: ((s.episodes || []).map((e) => ({
          episode_number: e.episode_number, name: e.name || 'Episode', overview: e.overview || '',
          runtime: e.runtime || null, air_date: e.air_date || '', still_path: e.still_path || null,
        }))),
      };
    }
    if (segs[0] === 'search' && segs.length === 1) {
      const d = await tmdb('search/multi', { language: 'en-US', query: params.q || '', page: 1, include_adult: 'false' });
      const results = Array.isArray(d.results) ? d.results : [];
      return {
        query: params.q || '', page: d.page || 1,
        total_pages: d.total_pages || 1, total_results: d.total_results || 0,
        results: results
          .filter((x) => (x.media_type === 'movie' || x.media_type === 'tv') && (x.poster_path || x.profile_path))
          .map((x) => gbItem(x)),
      };
    }
    throw new Error('Unknown Greybox route: /api/' + path);
  }

  function gbError(status, txt) {
    let clean = 'Greybox API error ' + status;
    try {
      const j = JSON.parse(txt);
      if (j && j.error) clean += ': ' + j.error;
    } catch {
      if (txt && !txt.trim().startsWith('<')) clean += ': ' + txt.slice(0, 200);
      else clean += '. Check the server logs for the Function crash, then redeploy.';
    }
    return new Error(clean);
  }

  async function greybox(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const url = `/api/${path}${qs ? '?' + qs : ''}`;
    let r;
    try {
      r = await fetch(url);
    } catch (e) {
      // No same-origin backend reachable at all (plain static preview).
      if (getToken()) return gbFallback(path, params);
      throw new Error('Cannot reach Greybox API. Deploy with TMDB_READ_TOKEN set (Cloudflare Pages or Vercel env vars), or run `wrangler pages dev` / `vercel dev` with a local env file. See README.');
    }
    if (r.ok) return await r.json();
    const txt = await r.text().catch(() => '');
    let parsed = null;
    try { parsed = JSON.parse(txt); } catch { /* non-JSON: no backend route (static host) */ }
    // Our backend always answers JSON — a JSON error means the backend IS
    // running, so surface it instead of masking it with a fallback.
    if (parsed && parsed.error) throw gbError(r.status, txt);
    // Non-JSON error (e.g. static host 404 page): fall back to dev override.
    if (getToken()) {
      try { return await gbFallback(path, params); }
      catch (fb) { throw new Error(gbError(r.status, txt).message + ' (static-preview fallback also failed: ' + (fb && fb.message ? fb.message : fb) + ')'); }
    }
    throw gbError(r.status, txt);
  }

  const gb = {
    trending: (page = 1) => greybox('trending', { page }),
    movies: (cat, page = 1) => greybox('movies/' + cat, { page }),
    tvList: (cat, page = 1) => greybox('tv/' + cat, { page }),
    anime: (kind, page = 1) => greybox('anime/' + kind, { page }),
    movie: (id, region) => greybox('movie/' + id, { region: region || getRegion() }),
    show: (id, region) => greybox('tv/' + id, { region: region || getRegion() }),
    season: (id, n) => greybox(`tv/${id}/season/${n}`, {}),
    search: (q, page = 1) => greybox('search', { q, page }),
  };

  window.API = { tmdb, greybox, gb, getToken, getRegion, LS_TOKEN, LS_REGION };
})();
