#!/usr/bin/env node
// Local mock of the Remux Discovery Service for development.
// Stores codes in memory (not persistent).
// Usage: node local-server.js [port]

import { createServer } from 'http';

const PORT = parseInt(process.argv[2] || '8780');
const codes = new Map();

// Clean expired codes every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of codes) {
    if (now - data.createdAt > 86400000) codes.delete(code);
  }
}, 300000);

function generateCode() {
  const a = 100 + Math.floor(Math.random() * 900);
  const b = 100 + Math.floor(Math.random() * 900);
  const c = 100 + Math.floor(Math.random() * 900);
  return `${a}${b}${c}`;
}

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (path === '/register' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    if (!body.tunnelUrl) return json(res, { error: 'tunnelUrl required' }, 400);
    let code;
    for (let i = 0; i < 10; i++) {
      code = generateCode();
      if (!codes.has(code)) break;
    }
    codes.set(code, {
      tunnelUrl: body.tunnelUrl,
      token: body.token || null,
      createdAt: Date.now(),
    });
    const formatted = `${code.slice(0, 3)} ${code.slice(3, 6)} ${code.slice(6, 9)}`;
    console.log(`[register] ${formatted} → ${body.tunnelUrl}`);
    return json(res, { code, formatted });
  }

  if (path.startsWith('/resolve/') && req.method === 'GET') {
    const rawCode = path.slice('/resolve/'.length).replace(/[\s-]/g, '');
    if (!/^\d{9}$/.test(rawCode)) return json(res, { error: 'invalid code' }, 400);
    const data = codes.get(rawCode);
    if (!data) return json(res, { error: 'not found' }, 404);
    console.log(`[resolve] ${rawCode} → ${data.tunnelUrl}`);
    return json(res, { tunnelUrl: data.tunnelUrl, token: data.token });
  }

  if (path.startsWith('/unregister/') && req.method === 'DELETE') {
    const rawCode = path.slice('/unregister/'.length).replace(/[\s-]/g, '');
    codes.delete(rawCode);
    res.writeHead(204);
    return res.end();
  }

  if (path === '/health') return json(res, { ok: true, codes: codes.size });

  json(res, { error: 'not found' }, 404);
});

server.listen(PORT, () => {
  console.log(`Remux Discovery (local) running at http://localhost:${PORT}`);
});
