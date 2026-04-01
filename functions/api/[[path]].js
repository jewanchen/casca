/**
 * Cloudflare Pages Function: /api/*
 * Proxies all /api/* requests to Railway backend.
 * Replaces Netlify's [[redirects]] with status=200.
 *
 * File location: functions/api/[[path]].js
 * The [[path]] catch-all matches /api/anything/here
 */
export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  // Build Railway target URL: keep the full /api/... path
  const targetUrl = 'https://casca-production.up.railway.app' + url.pathname + url.search;

  // Clone request headers, add/forward all originals
  const headers = new Headers(request.headers);
  headers.set('X-Forwarded-Host', url.hostname);

  // Proxy the request
  const proxyRequest = new Request(targetUrl, {
    method:  request.method,
    headers: headers,
    body:    request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
    redirect: 'follow',
  });

  try {
    const response = await fetch(proxyRequest);

    // Clone response and add CORS headers
    const newHeaders = new Headers(response.headers);
    newHeaders.set('Access-Control-Allow-Origin', url.origin);
    newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    newHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Secret, X-Casca-Key');
    newHeaders.set('Access-Control-Allow-Credentials', 'true');

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: newHeaders });
    }

    return new Response(response.body, {
      status:     response.status,
      statusText: response.statusText,
      headers:    newHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Proxy error: ' + err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
