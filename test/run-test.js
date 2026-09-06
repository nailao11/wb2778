'use strict';

const { createMockServer } = require('./mock-server');

const PORT = parseInt(process.env.MOCK_PORT || '4599', 10);
process.env.WEIBO_FORMCHECK_URL = `http://127.0.0.1:${PORT}/signup/v5/formcheck`;
process.env.MIN_INTERVAL_MS = '0';

const { checkEmail, interpret } = require('../lib/checker');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

const REAL = {
  registered:
    '{"code":"600001","data":{"id":"","state":false,"type":"err","code":"600001","action":"io","msg":"该邮箱已注册，请<a href=\\"//weibo.com/login.php\\" target=\\"_top\\">直接登录</a>","iodata":""},"msg":""}',
  available:
    '{"code":"600001","data":{"id":"","state":true,"type":"ok","code":"600001","action":"io","msg":"","iodata":""},"msg":""}',
  unsupported:
    '{"code":"600001","data":{"id":"","state":false,"type":"err","code":"600001","action":"io","msg":"注册失败(邮箱不支持)","iodata":""},"msg":""}',
  paramerr: '{"code":"100001","data":[],"msg":"参数错误！(RG020101)"}',
  paramlimit:
    '{"code":"600001","data":{"id":"","state":true,"type":"err","code":"600001","action":"io","msg":"参数限制01","iodata":""},"msg":""}',
};

function runUnit() {
  console.log('--- interpret() ---');
  let r;
  r = interpret('a@b.com', 200, REAL.registered);
  check('registered -> registered', r.status === 'registered' && r.registered === true, `(${r.status})`);
  r = interpret('a@b.com', 200, REAL.available);
  check('available -> not_registered', r.status === 'not_registered' && r.registered === false, `(${r.status})`);
  r = interpret('a@b.com', 200, REAL.unsupported);
  check('unsupported -> unsupported', r.status === 'unsupported', `(${r.status})`);
  r = interpret('a@b.com', 200, REAL.paramerr);
  check('param-error -> inconclusive', r.status === 'inconclusive', `(${r.status}/${r.reason})`);
  r = interpret('a@b.com', 200, REAL.paramlimit);
  check('参数限制+state:true -> inconclusive', r.status === 'inconclusive' && r.registered === null, `(${r.status}/${r.reason})`);
  r = interpret('a@b.com', 200, 'not-json');
  check('non-JSON -> inconclusive', r.status === 'inconclusive' && r.reason === 'bad_response', `(${r.reason})`);
  r = interpret('a@b.com', 503, '{}');
  check('HTTP 503 -> inconclusive', r.status === 'inconclusive', `(${r.status})`);
}

const CASES = [
  { email: 'registered_user@163.com', expect: 'registered' },
  { email: 'free_user@163.com', expect: 'not_registered' },
  { email: 'nope_user@163.com', expect: 'unsupported' },
  { email: 'captcha_user@163.com', expect: 'inconclusive' },
  { email: 'param_user@163.com', expect: 'inconclusive' },
  { email: 'not-an-email', expect: 'invalid_email' },
];

(async () => {
  runUnit();

  const server = createMockServer();
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log(`--- checkEmail() (mock) ---`);

  for (const c of CASES) {
    const res = await checkEmail(c.email);
    check(`${c.email.padEnd(26)} -> ${c.expect}`, res.status === c.expect, `(${res.status})`);
  }

  await new Promise((r) => server.close(r));
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail === 0 ? 0 : 1);
})();
