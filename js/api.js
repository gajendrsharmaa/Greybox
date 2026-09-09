/* API layer: proxy-only. The secret lives in the Cloudflare Pages Function
   (env var TMDB_READ_TOKEN), never in this file, so the repo is safe to push. */
(function () {
  const LS_TOKEN = 'sb_tmdb_token';
  const LS_REGION = 'sb_region';

  // Default built-in token so visitors don't need to paste anything manually.
  // NOTE: this is public in frontend JS — anyone can view it. For a production
  // site use the /api/tmdb proxy + secret env var instead.
  const DEFAULT_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI3NTUxNjg0MTE1MzQ2NWE4MzQ0YzlmNzEyZTk4NmZjMiIsIm5iZiI6MTc4ODgwNTEwNy4yODQ5OTk4LCJzdWIiOiI2YTllZmZmMzRhMWIxYmJmODI0YjI1NzEiLCJzY29wZXMiOlsiYXBpX3JlYWQiXSwidmVyc2lvbiI6MX0.1c3FFm6k3kKlUdxgnjpzeg7Mv4OILRzax4w3lxAhRMU';

  // Optional per-browser override for local dev only (Settings ⚙️).
  // Falls back to DEFAULT_TOKEN so it loads automatically.
  function getToken() { return localStorage.getItem(LS_TOKEN) || DEFAULT_TOKEN; }
  function getRegion() { return localStorage.getItem(LS_REGION) || 'US'; }

  async function tmdb(path, params = {}) {
    // path like "trending/all/week" or "movie/123" without leading /3/
    const qs = new URLSearchParams(params).toString();
    const proxyUrl = `/api/tmdb/${path}${qs ? '?' + qs : ''}`;

    // 1) Pages Function proxy — secret key lives server-side (env TMDB_READ_TOKEN).
    try {
      const r = await fetch(proxyUrl);
      if (r.ok) return await r.json();
      if (r.status === 404) {
        // No proxy (e.g. plain file preview without `wrangler pages dev`).
        // Fall through to dev override below.
      } else {
        const txt = await r.text().catch(() => '');
        // Never dump raw HTML (wrangler crash page) into the UI — parse JSON error if possible.
        let clean = 'Backend error ' + r.status;
        try {
          const j = JSON.parse(txt);
          if (j.error) clean += ': ' + j.error;
        } catch {
          if (txt && !txt.trim().startsWith('<')) clean += ': ' + txt.slice(0, 200);
          else clean += '. Check the wrangler terminal for the Function crash log, then restart `npm run dev`.';
        }
        // If user set a dev override token, try direct as fallback; otherwise surface backend error.
        if (!getToken()) throw new Error(clean);
        console.warn('proxy failed, trying dev override:', r.status, txt.slice(0, 200));
      }
    } catch (e) {
      if (!getToken()) throw e;
      // else fall through to direct with dev override
    }

    // 2) direct TMDB with per-browser dev override only (Settings ⚙️, never committed).
    const token = getToken();
    if (!token) throw new Error('Backend not configured. Run with `wrangler pages dev` + .dev.vars, or deploy with TMDB_READ_TOKEN set. See README.');
    const url = `https://api.themoviedb.org/3/${path}${qs ? '?' + qs : ''}`;
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token, accept: 'application/json' } });
    if (!res.ok) throw new Error('TMDB error ' + res.status);
    return await res.json();
  }

  window.API = { tmdb, getToken, getRegion, LS_TOKEN, LS_REGION };
})();
