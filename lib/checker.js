'use strict';

const DEFAULT_FORMCHECK = 'https://weibo.com/signup/v5/formcheck';
const DEFAULT_REFERER =
  'https://www.weibo.com/signup/mobile.php?lang=zh-cn&inviteCode=&from=&appsrc=&backurl=&showlogo=';

const CONFIG = {
  formcheckUrl: process.env.WEIBO_FORMCHECK_URL || DEFAULT_FORMCHECK,
  referer: process.env.WEIBO_REFERER || DEFAULT_REFERER,
  userAgent:
    process.env.USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  timeout: parseInt(process.env.CHECK_TIMEOUT || '15000', 10),
  minIntervalMs: parseInt(process.env.MIN_INTERVAL_MS || '1500', 10),
  maxBackoffMs: parseInt(process.env.MAX_BACKOFF_MS || '30000', 10),
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REGISTERED_RE = /已注册|已被注册|已经注册/;
const CHALLENGE_RE = /验证码|安全验证|滑块|频繁|请稍后|访问(受限|异常)|人机|参数限制|参数错误/;
const UNSUPPORTED_RE = /不支持|不可用|不合法|无效|格式/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stripHtml(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

let queueTail = Promise.resolve();
let lastFinishedAt = 0;
let backoffUntil = 0;
let softBlockStreak = 0;

const SOFT_REASONS = new Set([
  'challenge_or_rate_limit', 'bad_response', 'unexpected_response', 'network_error', 'timeout',
]);

function noteResult(result) {
  if (result && SOFT_REASONS.has(result.reason)) {
    softBlockStreak++;
    backoffUntil = Date.now() + Math.min(CONFIG.maxBackoffMs, CONFIG.minIntervalMs * 2 ** softBlockStreak);
  } else {
    softBlockStreak = 0;
    backoffUntil = 0;
  }
}

function enqueue(task) {
  const run = queueTail.then(async () => {
    const now = Date.now();
    const wait = Math.max(CONFIG.minIntervalMs - (now - lastFinishedAt), backoffUntil - now, 0);
    if (wait > 0) await sleep(wait);
    try {
      return await task();
    } finally {
      lastFinishedAt = Date.now();
    }
  });
  queueTail = run.then(() => {}, () => {});
  return run;
}

async function fetchFormcheck(email, signal) {
  const url = CONFIG.formcheckUrl + '?type=email&value=' + encodeURIComponent(email);
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': CONFIG.userAgent,
      Referer: CONFIG.referer,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    redirect: 'follow',
    signal,
  });
  const text = await res.text();
  return { httpStatus: res.status, text };
}

function interpret(email, httpStatus, text) {
  const base = { email, source: 'weibo-formcheck', checkedAt: new Date().toISOString() };

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}

  if (httpStatus !== 200 || !json) {
    return {
      ...base, status: 'inconclusive', registered: null, reason: 'bad_response',
      message: '微博返回了非预期内容，无法判断',
      evidence: { httpStatus, raw: (text || '').slice(0, 300) },
    };
  }

  const data = json.data;
  if (!data || Array.isArray(data) || typeof data !== 'object') {
    return {
      ...base, status: 'inconclusive', registered: null, reason: 'unexpected_response',
      message: stripHtml(json.msg) || '微博返回了非预期结构，无法判断',
      evidence: { code: json.code, topMsg: stripHtml(json.msg), raw: text.slice(0, 300) },
    };
  }

  const msg = stripHtml(data.msg);
  const evidence = { state: data.state, code: data.code, msg };

  if (REGISTERED_RE.test(msg)) {
    return { ...base, status: 'registered', registered: true, message: msg, evidence };
  }
  if (CHALLENGE_RE.test(msg)) {
    return {
      ...base, status: 'inconclusive', registered: null, reason: 'challenge_or_rate_limit',
      message: msg || '微博要求验证或触发了频率限制', evidence,
    };
  }
  if (data.state === true) {
    return {
      ...base, status: 'not_registered', registered: false,
      message: msg || '该邮箱可以注册（未注册）', evidence,
    };
  }
  if (UNSUPPORTED_RE.test(msg)) {
    return {
      ...base, status: 'unsupported', registered: null, reason: 'email_unsupported',
      message: msg || '该邮箱不可用/不被支持', evidence,
    };
  }
  return {
    ...base, status: 'inconclusive', registered: null, reason: 'unknown_message',
    message: msg || '微博返回了未知提示',
    evidence: { ...evidence, raw: text.slice(0, 300) },
  };
}

async function checkEmail(email) {
  email = String(email || '').trim();

  if (!EMAIL_RE.test(email)) {
    return {
      email, status: 'invalid_email', registered: null, reason: 'client_format_check',
      message: '邮箱格式不正确', evidence: {},
      checkedAt: new Date().toISOString(), source: 'local-validation',
    };
  }

  return enqueue(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.timeout);
    let result;
    try {
      const { httpStatus, text } = await fetchFormcheck(email, controller.signal);
      result = interpret(email, httpStatus, text);
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || /abort/i.test(String(err.message)));
      result = {
        email, status: 'inconclusive', registered: null,
        reason: aborted ? 'timeout' : 'network_error',
        message: aborted ? '请求超时，无法判断' : '无法连接微博，无法判断',
        error: String((err && err.message) || err), evidence: {},
        checkedAt: new Date().toISOString(), source: 'weibo-formcheck',
      };
    } finally {
      clearTimeout(timer);
    }
    noteResult(result);
    return result;
  });
}

module.exports = { checkEmail, interpret, CONFIG };
