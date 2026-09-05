'use strict';

/**
 * Local mock of the Weibo signup page + its email-availability endpoint.
 * Used only for offline testing of the detection logic (weibo.com itself is
 * not contacted). Behaviour is designed to exercise every verdict branch.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const REGISTERED = new Set(['14725836900@163.com', 'registered@163.com']);
const HTML = fs.readFileSync(path.join(__dirname, 'mock-weibo.html'));

function createMockServer() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://mock');

    if (u.pathname === '/signup') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(HTML);
    }

    if (u.pathname === '/api/check_email') {
      const email = (u.searchParams.get('email') || '').trim();
      let body;
      if (email === 'captcha@test.com') {
        body = { code: 'challenge', msg: '请输入验证码完成安全验证' };
      } else if (REGISTERED.has(email)) {
        body = { code: 'exist', msg: '该邮箱已注册，请直接登录' };
      } else if (email === 'silent@163.com') {
        body = { code: 'ok', msg: '' }; // valid but no visible prompt
      } else {
        body = { code: 'ok', msg: '该邮箱可以注册' };
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(body));
    }

    res.writeHead(404);
    res.end('not found');
  });
}

module.exports = { createMockServer };
