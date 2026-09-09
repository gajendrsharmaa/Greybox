/**
 * Vercel Serverless Function: TMDB proxy
 * Route: /api/tmdb/*  ->  https://api.themoviedb.org/3/*
 *
 * The secret lives ONLY in server-side env vars (never in client code):
 *   TMDB_READ_TOKEN = your TMDB v4 Read Access Token (eyJ...)  [preferred]
 *   or TMDB_API_KEY = your TMDB v3 api_key
 * Set them in: Vercel Dashboard > Project > Settings > Environment Variables,
 * or locally in a gitignored `.env` file (see .env.example) + `vercel dev`.
 *
 * The same-origin frontend (js/api.js) calls /api/tmdb/* on both Vercel
 * (this file) and Cloudflare Pages (functions/api/tmdb/[[path]].js),
 * so no frontend changes are needed per platform.
 */
'use strict';

const ALLOWED = /^(trending|movie|tv|search|genre|discover|person|collection|watch)[\/a-zA-Z0-9_\-]*$/;
const FWD_PARAMS = [
  'language', 'page', 'query', 'region', 'watch_region', 'include_adult',
  'sort_by', 'with_genres', 'with_original_language', 'with_watch_providers',
  'primary_release_year', 'first_air_date_year',
];

function json(res, status, obj) {
  res.status(status);
  res.setHeader('content-type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', status === 200 ? 'public, max-age=600' : 'no-store');
  res.send(JSON.stringify(obj));
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.status(200).send('');
      return;
    }
    if (req.method !== 'GET') {
      json(res, 405, { error: 'Method not allowed' });
      return;
    }

    const token = process.env.TMDB_READ_TOKEN;
    const apiKey = process.env.TMDB_API_KEY;
    if (!token && !apiKey) {
      json(res, 500, { error: 'Missing TMDB_READ_TOKEN (or TMDB_API_KEY) env var. See README.' });
      return;
    }

    // Catch-all segment: array for [...path].js — normalize defensively.
    const raw = req.query && req.query.path !== undefined ? req.query.path : [];
    const parts = Array.isArray(raw)
      ? raw
      : String(raw || '').split('/').filter(Boolean);
    const tmdbPath = parts.map((p) => String(p)).join('/');
    if (!ALLOWED.test(tmdbPath)) {
      json(res, 403, { error: 'Blocked path: ' + tmdbPath });
      return;
    }

    const target = new URL('https://api.themoviedb.org/3/' + tmdbPath);
    const src = req.query || {};
    for (const k of FWD_PARAMS) {
      const v = src[k];
      if (v !== undefined && v !== null && String(v) !== '') {
        target.searchParams.set(k, String(v));
      }
    }
    // NOTE: `api_key` is never accepted from the client — it is only ever
    // attached here, server-side, from the env var.
    if (apiKey && !token) target.searchParams.set('api_key', apiKey);

    const headers = { accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;

    let upstream;
    try {
      upstream = await fetch(target.toString(), { headers });
    } catch (e) {
      json(res, 502, { error: 'Could not reach TMDB: ' + (e.message || e) });
      return;
    }
    const body = await upstream.text();
    // Pass through TMDB's JSON only — the secret is in the request headers
    // above and is never part of the response body.
    res.status(upstream.status);
    res.setHeader('content-type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', upstream.ok ? 'public, max-age=600' : 'no-store');
    res.send(body);
  } catch (e) {
    // Always JSON, never a stack trace or env dump.
    json(res, 500, { error: 'Proxy error: ' + (e && e.message ? e.message : String(e)) });
  }
};
