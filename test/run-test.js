'use strict';

/**
 * Offline test of the detection logic against the local mock signup page.
 * weibo.com is never contacted here. Verifies every verdict branch.
 *
 *   node test/run-test.js
 */

const { createMockServer } = require('./mock-server');

const PORT = parseInt(process.env.MOCK_PORT || '4599', 10);

// Point the checker at the mock BEFORE requiring it (CONFIG reads env on load).
process.env.WEIBO_URL = `http://127.0.0.1:${PORT}/signup`;
process.env.MIN_INTERVAL_MS = '0';
process.env.CHECK_TIMEOUT = process.env.CHECK_TIMEOUT || '8000';
process.env.NAV_TIMEOUT = process.env.NAV_TIMEOUT || '15000';
// Use the pre-installed Chromium in this environment if present and no explicit
// path was given; on a normal machine Playwright resolves its own browser.
if (!process.env.CHROMIUM_PATH) {
  const fs = require('fs');
  const candidate = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  if (fs.existsSync(candidate)) process.env.CHROMIUM_PATH = candidate;
}

const { checkEmail, closeBrowser } = require('../lib/checker');

const CASES = [
  { email: '14725836900@163.com', expect: 'registered' },
  { email: 'registered@163.com', expect: 'registered' },
  { email: 'free@163.com', expect: 'not_registered' },
  { email: 'silent@163.com', expect: 'not_registered' },
  { email: 'captcha@test.com', expect: 'inconclusive' },
  { email: 'not-an-email', expect: 'invalid_email' },
];

(async () => {
  const server = createMockServer();
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  console.log(`Mock Weibo signup running at http://127.0.0.1:${PORT}/signup\n`);

  let pass = 0;
  let fail = 0;

  for (const c of CASES) {
    let got;
    try {
      const res = await checkEmail(c.email);
      got = res.status;
      const ok = got === c.expect;
      ok ? pass++ : fail++;
      console.log(
        `${ok ? 'PASS' : 'FAIL'}  ${c.email.padEnd(24)} expected=${c.expect.padEnd(15)} got=${got}` +
          (res.matchedPhrase ? `  ("${res.matchedPhrase}")` : res.reason ? `  [${res.reason}]` : '')
      );
    } catch (e) {
      fail++;
      console.log(`FAIL  ${c.email.padEnd(24)} threw: ${e.message}`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed.`);

  await closeBrowser();
  await new Promise((resolve) => server.close(resolve));
  process.exit(fail === 0 ? 0 : 1);
})();
