'use strict';

/**
 * Local mock of Weibo's /signup/v5/formcheck endpoint, returning the exact
 * JSON shapes observed from the real service. Used for offline testing
 * (weibo.com is not contacted).
 */

const http = require('http');
const { URL } = require('url');

// Real response shapes captured from https://weibo.com/signup/v5/formcheck
const RESP = {
  registered: {
    code: '600001',
    data: {
      id: '', state: false, type: 'err', code: '600001', action: 'io',
      msg: '该邮箱已注册，请<a href="//weibo.com/login.php" target="_top">直接登录</a>',
      iodata: '',
    },
    msg: '',
  },
  available: {
    code: '600001',
    data: { id: '', state: true, type: 'ok', code: '600001', action: 'io', msg: '', iodata: '' },
    msg: '',
  },
  unsupported: {
    code: '600001',
    data: { id: '', state: false, type: 'err', code: '600001', action: 'io', msg: '注册失败(邮箱不支持)', iodata: '' },
    msg: '',
  },
  challenge: {
    code: '600001',
    data: { id: '', state: false, type: 'err', code: '600001', action: 'io', msg: '请输入验证码完成安全验证', iodata: '' },
    msg: '',
  },
  paramerr: { code: '100001', data: [], msg: '参数错误！(RG020101)' },
};

function pick(value) {
  if (value.startsWith('reg')) return RESP.registered;
  if (value.startsWith('free') || value.startsWith('avail')) return RESP.available;
  if (value.startsWith('nope') || value.startsWith('bad')) return RESP.unsupported;
  if (value.startsWith('captcha')) return RESP.challenge;
  if (value.startsWith('param')) return RESP.paramerr;
  return RESP.available; // default: treat unknown as available
}

function createMockServer() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://mock');
    if (u.pathname === '/signup/v5/formcheck') {
      const value = (u.searchParams.get('value') || '').trim();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(pick(value)));
    }
    res.writeHead(404);
    res.end('not found');
  });
}

module.exports = { createMockServer, RESP };
