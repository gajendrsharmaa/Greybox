/* API layer: proxy-only. The secret lives ONLY in server-side env vars
   (TMDB_READ_TOKEN / TMDB_API_KEY on Cloudflare Pages or Vercel) and is
   never present in this file, so the repo is safe to push.
   The frontend calls same-origin /api/tmdb/* — never api.themoviedb.org. */
(function () {
  const LS_TOKEN = 'sb_tmdb_token';
  const LS_REGION = 'sb_region';

  // Per-browser dev override for local static preview only (Settings UI,
  // stored in the visitor's own localStorage, never committed).
  // Empty by default — production traffic goes through the /api/tmdb proxy.
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

  window.API = { tmdb, getToken, getRegion, LS_TOKEN, LS_REGION };
})();
