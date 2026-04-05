// Remux Discovery Service — Cloudflare Worker
// Maps 9-digit short codes to tunnel URLs for RustDesk-like remote access.
//
// KV Namespace binding: CODES
//
// Endpoints:
//   POST /register  { tunnelUrl, token? } → { code: "847293015" }
//   GET  /resolve/:code                   → { tunnelUrl, token? } or 404
//   DELETE /unregister/:code              → 204
//   GET  /health                          → { ok: true }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers for browser clients
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      // POST /register
      if (path === '/register' && request.method === 'POST') {
        const body = await request.json();
        const { tunnelUrl, token } = body;

        if (!tunnelUrl || typeof tunnelUrl !== 'string') {
          return json({ error: 'tunnelUrl required' }, 400, corsHeaders);
        }

        // Generate unique 9-digit code (3 groups of 3)
        let code;
        let attempts = 0;
        do {
          code = generateCode();
          const existing = await env.CODES.get(code);
          if (!existing) break;
          attempts++;
        } while (attempts < 10);

        if (attempts >= 10) {
          return json({ error: 'failed to generate unique code' }, 500, corsHeaders);
        }

        const value = JSON.stringify({
          tunnelUrl,
          token: token || null,
          createdAt: Date.now(),
        });

        // TTL: 24 hours
        await env.CODES.put(code, value, { expirationTtl: 86400 });

        return json({ code, formatted: formatCode(code) }, 200, corsHeaders);
      }

      // GET /resolve/:code
      if (path.startsWith('/resolve/') && request.method === 'GET') {
        const rawCode = path.slice('/resolve/'.length).replace(/[\s-]/g, '');
        if (!/^\d{9}$/.test(rawCode)) {
          return json({ error: 'invalid code format, expected 9 digits' }, 400, corsHeaders);
        }

        const data = await env.CODES.get(rawCode);
        if (!data) {
          return json({ error: 'code not found or expired' }, 404, corsHeaders);
        }

        const parsed = JSON.parse(data);
        return json({
          tunnelUrl: parsed.tunnelUrl,
          token: parsed.token,
        }, 200, corsHeaders);
      }

      // DELETE /unregister/:code
      if (path.startsWith('/unregister/') && request.method === 'DELETE') {
        const rawCode = path.slice('/unregister/'.length).replace(/[\s-]/g, '');
        if (!/^\d{9}$/.test(rawCode)) {
          return json({ error: 'invalid code format' }, 400, corsHeaders);
        }
        await env.CODES.delete(rawCode);
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // GET /health
      if (path === '/health') {
        return json({ ok: true, ts: Date.now() }, 200, corsHeaders);
      }

      return json({ error: 'not found' }, 404, corsHeaders);
    } catch (err) {
      return json({ error: err.message }, 500, corsHeaders);
    }
  },
};

function generateCode() {
  // 9 random digits: each group 100-999
  const a = 100 + Math.floor(Math.random() * 900);
  const b = 100 + Math.floor(Math.random() * 900);
  const c = 100 + Math.floor(Math.random() * 900);
  return `${a}${b}${c}`;
}

function formatCode(code) {
  return `${code.slice(0, 3)} ${code.slice(3, 6)} ${code.slice(6, 9)}`;
}

function json(data, status, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}
