'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { checkEmail, CONFIG } = require('./lib/checker');

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

const RATE_WINDOW_MS = 60000;
const RATE_MAX = parseInt(process.env.RATE_MAX || '120', 10);
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_MAX;
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj, null, 2));
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
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
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket.remoteAddress || 'unknown';
    if (rateLimited(ip)) {
      return sendJson(res, 429, { status: 'error', error: 'rate_limited', message: '请求过于频繁，请稍后再试' });
    }
    const email = (parsed.searchParams.get('email') || '').trim();
    if (!email) {
      return sendJson(res, 400, { status: 'error', error: 'missing_email', message: '缺少 email 参数' });
    }
    try {
      return sendJson(res, 200, await checkEmail(email));
    } catch (err) {
      return sendJson(res, 500, { status: 'error', error: 'internal', message: String((err && err.message) || err) });
    }
  }

  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, endpoint: CONFIG.formcheckUrl });
  }

  if (req.method === 'GET') {
    return serveStatic(res, pathname);
  }

  res.writeHead(405);
  res.end('Method not allowed');
});

server.listen(PORT, HOST, () => {
  console.log(`Weibo email checker running at http://${HOST}:${PORT}`);
});

process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
