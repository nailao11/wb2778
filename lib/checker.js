'use strict';

/**
 * Weibo email registration checker (core logic).
 *
 * Uses the exact request Weibo's own signup page makes when you type an email
 * and it validates the field:
 *
 *   GET https://weibo.com/signup/v5/formcheck?type=email&value=<email>
 *
 * The JSON response tells us directly whether the email is registered:
 *
 *   {"code":"600001","data":{"state":false,"type":"err",
 *        "msg":"该邮箱已注册，请<a ...>直接登录</a>", ...},"msg":""}   -> registered
 *   {"code":"600001","data":{"state":true ,"type":"ok" ,"msg":""},"msg":""}   -> not registered
 *   {"code":"600001","data":{"state":false,"type":"err",
 *        "msg":"注册失败(邮箱不支持)", ...},"msg":""}                  -> unsupported
 *
 * This is the same signal the user sees on the page ("该邮箱已注册，请直接登录"),
 * read straight from Weibo's response — no browser, no dependencies.
 *
 * Anything unexpected (captcha / rate-limit / changed API / network error)
 * returns "inconclusive" rather than guessing. Accuracy first.
 *
 * For personal learning / authorized security research only.
 */

// On a normal machine this talks to weibo.com directly — nothing to configure.
// Behind an outbound proxy, launch the process with HTTPS_PROXY set AND
// NODE_USE_ENV_PROXY=1 (undici reads that at startup, so it can't be set from
// code here). See the README "Behind a proxy" section.

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
  minIntervalMs: parseInt(process.env.MIN_INTERVAL_MS || '1000', 10),
};

// A loose but real email format check (fast client-side guard).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Response-message classification.
const REGISTERED_RE = /已注册|已被注册|已经注册/;
const CHALLENGE_RE = /验证码|安全验证|滑块|频繁|请稍后|访问(受限|异常)|人机/;
const UNSUPPORTED_RE = /不支持|不可用|不合法|无效|格式/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stripHtml(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Serialize checks: one at a time, with a minimum gap between them (polite).
// ---------------------------------------------------------------------------
let queueTail = Promise.resolve();
let lastFinishedAt = 0;

function enqueue(task) {
  const run = queueTail.then(async () => {
    const gap = Date.now() - lastFinishedAt;
    const wait = CONFIG.minIntervalMs - gap;
    if (wait > 0) await sleep(wait);
    try {
      return await task();
    } finally {
      lastFinishedAt = Date.now();
    }
  });
  queueTail = run.then(
    () => {},
    () => {}
  );
  return run;
}

// ---------------------------------------------------------------------------
// HTTP call
// ---------------------------------------------------------------------------
async function fetchFormcheck(email, signal) {
  const url =
    CONFIG.formcheckUrl + '?type=email&value=' + encodeURIComponent(email);
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

// ---------------------------------------------------------------------------
// Interpret Weibo's response into a verdict.
// ---------------------------------------------------------------------------
function interpret(email, httpStatus, text) {
  const base = {
    email,
    source: 'weibo-formcheck',
    checkedAt: new Date().toISOString(),
  };

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }

  if (httpStatus !== 200 || !json) {
    return {
      ...base,
      status: 'inconclusive',
      registered: null,
      reason: 'bad_response',
      message: '微博返回了非预期内容，无法判断',
      evidence: { httpStatus, raw: (text || '').slice(0, 300) },
    };
  }

  const data = json.data;
  // e.g. {"code":"100001","data":[],"msg":"参数错误！"} — missing params / API change.
  if (!data || Array.isArray(data) || typeof data !== 'object') {
    return {
      ...base,
      status: 'inconclusive',
      registered: null,
      reason: 'unexpected_response',
      message: stripHtml(json.msg) || '微博返回了非预期结构，无法判断',
      evidence: { code: json.code, topMsg: stripHtml(json.msg), raw: text.slice(0, 300) },
    };
  }

  const msg = stripHtml(data.msg);
  const evidence = { state: data.state, code: data.code, msg };

  // Available → not registered.
  if (data.state === true) {
    return {
      ...base,
      status: 'not_registered',
      registered: false,
      message: msg || '该邮箱可以注册（未注册）',
      evidence,
    };
  }

  // Registered → the decisive signal the user specified.
  if (REGISTERED_RE.test(msg)) {
    return { ...base, status: 'registered', registered: true, message: msg, evidence };
  }

  // Captcha / rate-limit / verification → do not guess.
  if (CHALLENGE_RE.test(msg)) {
    return {
      ...base,
      status: 'inconclusive',
      registered: null,
      reason: 'challenge_or_rate_limit',
      message: msg || '微博要求验证或触发了频率限制',
      evidence,
    };
  }

  // Email not accepted by Weibo (bad format / unsupported provider rules).
  if (UNSUPPORTED_RE.test(msg)) {
    return {
      ...base,
      status: 'unsupported',
      registered: null,
      reason: 'email_unsupported',
      message: msg || '该邮箱不可用/不被支持',
      evidence,
    };
  }

  // Anything else: unknown message — surface it, don't force a verdict.
  return {
    ...base,
    status: 'inconclusive',
    registered: null,
    reason: 'unknown_message',
    message: msg || '微博返回了未知提示',
    evidence: { ...evidence, raw: text.slice(0, 300) },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
async function checkEmail(email) {
  email = String(email || '').trim();

  if (!EMAIL_RE.test(email)) {
    return {
      email,
      status: 'invalid_email',
      registered: null,
      reason: 'client_format_check',
      message: '邮箱格式不正确',
      evidence: {},
      checkedAt: new Date().toISOString(),
      source: 'local-validation',
    };
  }

  return enqueue(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.timeout);
    try {
      const { httpStatus, text } = await fetchFormcheck(email, controller.signal);
      return interpret(email, httpStatus, text);
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || /abort/i.test(String(err.message)));
      return {
        email,
        status: 'inconclusive',
        registered: null,
        reason: aborted ? 'timeout' : 'network_error',
        message: aborted ? '请求超时，无法判断' : '无法连接微博，无法判断',
        error: String((err && err.message) || err),
        evidence: {},
        checkedAt: new Date().toISOString(),
        source: 'weibo-formcheck',
      };
    } finally {
      clearTimeout(timer);
    }
  });
}

// Kept as a no-op so existing callers (server shutdown) stay compatible.
async function closeBrowser() {}

module.exports = { checkEmail, closeBrowser, interpret, CONFIG };
