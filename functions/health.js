/**
 * Cloudflare Pages Function: /health
 * Proxies health check to Railway backend.
 * File location: functions/health.js
 */
export async function onRequest(context) {
  try {
    const response = await fetch('https://casca-production.up.railway.app/health');
    return new Response(response.body, {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
