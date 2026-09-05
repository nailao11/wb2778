'use strict';

/**
 * Tiny HTTP server for the Weibo email registration checker.
 *
 * - Serves the frontend from ./public
 * - GET /api/check?email=...  -> JSON verdict (registered / not_registered /
 *   inconclusive / invalid_email)
 *
 * The heavy lifting (driving the real Weibo signup page) lives in lib/checker.js.
 * A backend is required because the browser cannot read weibo.com's response
 * cross-origin, and Weibo runs anti-bot JS that a plain fetch cannot satisfy.
 *
 * For personal learning / authorized security research only.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { checkEmail, closeBrowser, CONFIG } = require('./lib/checker');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// Very small per-IP rate limit (the checker also serializes globally).
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = parseInt(process.env.RATE_MAX || '20', 10); // per IP per minute
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_MAX;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  // Prevent path traversal.
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  let parsed;
  try {
    parsed = new URL(req.url, `http://${req.headers.host || HOST}`);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  const pathname = parsed.pathname;

  if (pathname === '/api/check') {
    const ip =
      (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket.remoteAddress ||
      'unknown';
    if (rateLimited(ip)) {
      return sendJson(res, 429, {
        status: 'error',
        error: 'rate_limited',
        message: '请求过于频繁，请稍后再试 (rate limited).',
      });
    }
    const email = (parsed.searchParams.get('email') || '').trim();
    if (!email) {
      return sendJson(res, 400, {
        status: 'error',
        error: 'missing_email',
        message: '缺少 email 参数 (missing "email" query parameter).',
      });
    }
    try {
      const result = await checkEmail(email);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 500, {
        status: 'error',
        error: 'internal',
        message: String((err && err.message) || err),
      });
    }
  }

  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, weiboUrl: CONFIG.weiboUrl });
  }

  if (req.method === 'GET') {
    return serveStatic(req, res, pathname);
  }

  res.writeHead(405);
  res.end('Method not allowed');
});

server.listen(PORT, HOST, () => {
  console.log(`\n  微博邮箱注册检测 / Weibo email registration checker`);
  console.log(`  Server running at  http://${HOST}:${PORT}`);
  console.log(`  Target signup page: ${CONFIG.weiboUrl}`);
  console.log(`  Headless: ${!CONFIG.headful}  |  Min interval: ${CONFIG.minIntervalMs}ms\n`);
  console.log('  ⚠  For personal learning / authorized testing only. Check emails you own or are authorized to check.\n');
});

async function shutdown() {
  console.log('\nShutting down...');
  server.close();
  await closeBrowser();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
