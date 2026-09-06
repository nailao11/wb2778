'use strict';

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { createMockServer } = require('./mock-server');

const MOCK_PORT = 4601;
const APP_PORT = 3131;

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const mock = createMockServer();
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

  const env = {
    ...process.env,
    PORT: String(APP_PORT),
    HOST: '127.0.0.1',
    WEIBO_FORMCHECK_URL: `http://127.0.0.1:${MOCK_PORT}/signup/v5/formcheck`,
    MIN_INTERVAL_MS: '0',
    CHECK_TIMEOUT: '8000',
  };
  const app = spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: 'inherit' });

  let failed = 0;
  const check = (name, cond, extra) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
    if (!cond) failed++;
  };

  try {
    for (let i = 0; i < 30; i++) {
      try { await get(`http://127.0.0.1:${APP_PORT}/api/health`); break; }
      catch { await sleep(300); }
    }

    const health = await get(`http://127.0.0.1:${APP_PORT}/api/health`);
    check('GET /api/health -> 200', health.status === 200, `(${health.status})`);

    const home = await get(`http://127.0.0.1:${APP_PORT}/`);
    check('GET / serves frontend', home.status === 200 && home.body.includes('微博邮箱注册检测'));

    const reg = await get(`http://127.0.0.1:${APP_PORT}/api/check?email=${encodeURIComponent('registered@163.com')}`);
    check('registered -> registered', JSON.parse(reg.body).status === 'registered');

    const free = await get(`http://127.0.0.1:${APP_PORT}/api/check?email=${encodeURIComponent('free@163.com')}`);
    check('new -> not_registered', JSON.parse(free.body).status === 'not_registered');

    const bad = await get(`http://127.0.0.1:${APP_PORT}/api/check?email=nope`);
    check('bad format -> invalid_email', JSON.parse(bad.body).status === 'invalid_email');

    const missing = await get(`http://127.0.0.1:${APP_PORT}/api/check`);
    check('missing email -> 400', missing.status === 400, `(${missing.status})`);
  } finally {
    app.kill('SIGTERM');
    await new Promise((r) => mock.close(r));
    await sleep(300);
  }

  console.log(`\n${failed === 0 ? 'ALL SMOKE TESTS PASSED' : failed + ' FAILED'}`);
  process.exit(failed === 0 ? 0 : 1);
})();
