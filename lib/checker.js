'use strict';

/**
 * Weibo email registration checker (core logic).
 *
 * Strategy (as requested): drive the *real* Weibo signup page with a headless
 * browser, type the email into the email field exactly like a human, then read
 * the prompt the page shows. If the prompt says "该邮箱已注册，请直接登录" the
 * email is already registered; if the validation completes with no such prompt
 * the email is not registered. Anything ambiguous (captcha / rate-limit /
 * unexpected page) returns "inconclusive" instead of guessing — accuracy first.
 *
 * For personal learning / authorized security research only. Single email per
 * call, serialized, with a minimum interval between checks.
 */

const { chromium } = require('playwright');

// ---------------------------------------------------------------------------
// Configuration (override via environment variables)
// ---------------------------------------------------------------------------
const DEFAULT_WEIBO_URL =
  'https://www.weibo.com/signup/mobile.php?lang=zh-cn&inviteCode=&from=&appsrc=&backurl=&showlogo=';

const CONFIG = {
  weiboUrl: process.env.WEIBO_URL || DEFAULT_WEIBO_URL,
  // If set, use this exact Chromium binary. Otherwise let Playwright resolve
  // the browser it installed via `npx playwright install chromium`.
  chromiumPath: process.env.CHROMIUM_PATH || undefined,
  headful: process.env.HEADFUL === '1',
  navTimeout: parseInt(process.env.NAV_TIMEOUT || '30000', 10),
  checkTimeout: parseInt(process.env.CHECK_TIMEOUT || '15000', 10),
  minIntervalMs: parseInt(process.env.MIN_INTERVAL_MS || '3000', 10),
  userAgent:
    process.env.USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  // Extra Chromium args. --no-sandbox is commonly required when running as root
  // / inside containers. It is harmless for this single-purpose local tool.
  noSandbox: process.env.NO_SANDBOX !== '0',
};

// ---------------------------------------------------------------------------
// Detection phrases
// ---------------------------------------------------------------------------
// "Already registered" — the decisive signal the user specified.
const REGISTERED_PATTERNS = [
  /该邮箱已注册/,
  /邮箱已注册/,
  /已被注册/,
  /已经注册/,
  /已注册[，,、\s]*请?直接?登录/,
  /该帐号已(经)?存在/,
  /账号已存在/,
];
// Explicit "you can register / available" hints (not always shown).
const AVAILABLE_PATTERNS = [
  /该邮箱可以?使用/,
  /可以注册/,
  /可注册/,
  /邮箱可用/,
  /恭喜.{0,6}可以使用/,
];
// Anti-bot / rate-limit / verification — we must NOT guess in these cases.
const CHALLENGE_PATTERNS = [
  /验证码/,
  /安全验证/,
  /滑块/,
  /拖(动|拽)/,
  /操作(过于)?频繁/,
  /请稍后(再试)?/,
  /访问(受限|异常)/,
  /人机/,
  /为了(你|您)的帐号安全/,
];
// Email format rejected by the page.
const INVALID_PATTERNS = [
  /邮箱格式(不正确|错误|有误)/,
  /请输入(正确|有效)的?邮箱/,
  /邮箱地址(不正确|有误)/,
  /请填写邮箱/,
  /请输入邮箱/,
];

// URL fragments that hint a request is the "is this email available" check.
const CHECK_URL_HINT = /(email|mail|account|reg|check|avail|exist|unique|user|signup|sign_up|verify|validate)/i;

// Selectors used to locate the email input, in priority order.
const EMAIL_INPUT_SELECTORS = [
  'input[placeholder*="邮箱"]',
  'input[node-type="email"]',
  'input[name="email"]',
  'input[name*="mail" i]',
  'input[type="email"]',
  'input[id*="email" i]',
  'input[id*="mail" i]',
];

// A loose but real email format check (backend-side guard).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Decode \uXXXX escapes so JSON API bodies match Chinese phrases too. */
function decodeUnicodeEscapes(text) {
  if (!text || text.indexOf('\\u') === -1) return text;
  try {
    return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    );
  } catch {
    return text;
  }
}

function firstMatch(text, patterns) {
  if (!text) return null;
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

/** Trim a snippet of text around a matched phrase, for evidence display. */
function snippetAround(text, phrase, radius = 60) {
  if (!text || !phrase) return '';
  const i = text.indexOf(phrase);
  if (i === -1) return text.slice(0, radius * 2).trim();
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + phrase.length + radius);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Shared browser + serialization (rate limiting)
// ---------------------------------------------------------------------------
let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    const launchOpts = {
      headless: !CONFIG.headful,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    };
    if (CONFIG.noSandbox) {
      launchOpts.args.push('--no-sandbox', '--disable-setuid-sandbox');
    }
    if (CONFIG.chromiumPath) launchOpts.executablePath = CONFIG.chromiumPath;
    browserPromise = chromium.launch(launchOpts).catch((e) => {
      browserPromise = null; // allow retry on next call
      throw e;
    });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      await b.close();
    } catch {
      /* ignore */
    }
    browserPromise = null;
  }
}

// Serialize checks: one at a time, with a minimum gap between them.
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
  // Keep the chain alive even if a task rejects.
  queueTail = run.then(
    () => {},
    () => {}
  );
  return run;
}

// ---------------------------------------------------------------------------
// Page interaction
// ---------------------------------------------------------------------------

/** Find the email input across the main frame and any child frames. */
async function findEmailInput(page) {
  for (const frame of page.frames()) {
    for (const sel of EMAIL_INPUT_SELECTORS) {
      const loc = frame.locator(sel).first();
      try {
        if ((await loc.count()) > 0 && (await loc.isVisible())) {
          return { frame, loc };
        }
      } catch {
        /* frame may be detached; skip */
      }
    }
  }
  // Fallback: first visible text-like input in any frame.
  for (const frame of page.frames()) {
    const loc = frame
      .locator('input[type="text"]:visible, input:not([type]):visible')
      .first();
    try {
      if ((await loc.count()) > 0 && (await loc.isVisible())) {
        return { frame, loc };
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

/** Concatenate visible text of the main frame and all child frames. */
async function collectVisibleText(page) {
  let out = '';
  for (const frame of page.frames()) {
    try {
      const t = await frame.evaluate(() =>
        document.body ? document.body.innerText : ''
      );
      if (t) out += '\n' + t;
    } catch {
      /* skip detached */
    }
  }
  return out;
}

/**
 * Decide the verdict by polling the page text and inspecting captured
 * network responses, up to a timeout.
 */
async function waitForVerdict(page, checkResponses, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let sawCheckRequest = false;
  let lastText = '';

  while (Date.now() < deadline) {
    lastText = await collectVisibleText(page);

    // 1) Registered — decisive (DOM or any captured API body).
    let hit = firstMatch(lastText, REGISTERED_PATTERNS);
    if (hit) {
      return verdict('registered', hit, lastText, checkResponses);
    }
    for (const r of checkResponses) {
      const body = decodeUnicodeEscapes(r.snippet || '');
      const b = firstMatch(body, REGISTERED_PATTERNS);
      if (b) return verdict('registered', b, body, checkResponses);
    }

    // 2) Anti-bot / verification — do not guess.
    hit = firstMatch(lastText, CHALLENGE_PATTERNS);
    if (hit) {
      return verdict('inconclusive', hit, lastText, checkResponses, 'challenge_or_rate_limit');
    }

    // 3) Invalid email as judged by the page.
    hit = firstMatch(lastText, INVALID_PATTERNS);
    if (hit) {
      return verdict('invalid_email', hit, lastText, checkResponses);
    }

    // 4) Explicit "available" hint → not registered.
    hit = firstMatch(lastText, AVAILABLE_PATTERNS);
    if (hit) {
      return verdict('not_registered', hit, lastText, checkResponses);
    }

    // Note whether the availability check has fired at all.
    if (checkResponses.length > 0) sawCheckRequest = true;

    await sleep(400);
  }

  // Timed out with no decisive prompt.
  // If the availability check demonstrably fired and nothing said "registered",
  // that is Weibo's "no error" state → not registered.
  if (sawCheckRequest || checkResponses.length > 0) {
    return verdict(
      'not_registered',
      null,
      lastText,
      checkResponses,
      'no_registered_prompt_after_check'
    );
  }
  // We never observed the check running → we genuinely don't know.
  return verdict(
    'inconclusive',
    null,
    lastText,
    checkResponses,
    'check_not_observed'
  );
}

function verdict(status, matched, text, checkResponses, reason) {
  const registeredMap = {
    registered: true,
    not_registered: false,
    inconclusive: null,
    invalid_email: null,
  };
  return {
    status,
    registered: registeredMap[status],
    matchedPhrase: matched || null,
    reason: reason || null,
    evidence: {
      promptSnippet: matched ? snippetAround(text, matched) : (text || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      apiResponses: checkResponses.map((r) => ({
        url: r.url,
        status: r.status,
        snippet: (r.snippet || '').slice(0, 200),
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether `email` is already registered on Weibo.
 * @returns {Promise<object>} structured result (see verdict()).
 */
async function checkEmail(email) {
  email = String(email || '').trim();

  if (!EMAIL_RE.test(email)) {
    return {
      email,
      status: 'invalid_email',
      registered: null,
      matchedPhrase: null,
      reason: 'client_format_check',
      evidence: { promptSnippet: '邮箱格式不正确', apiResponses: [] },
      checkedAt: new Date().toISOString(),
      source: 'local-validation',
    };
  }

  return enqueue(async () => {
    const browser = await getBrowser();
    const context = await browser.newContext({
      userAgent: CONFIG.userAgent,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      viewport: { width: 1280, height: 900 },
    });
    // Reduce trivially-detectable automation signals.
    await context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      } catch (e) {}
    });

    const page = await context.newPage();
    const checkResponses = [];

    page.on('response', async (resp) => {
      try {
        const req = resp.request();
        const rt = req.resourceType();
        if (rt !== 'xhr' && rt !== 'fetch') return;
        const url = resp.url();
        if (!CHECK_URL_HINT.test(url)) return;
        let body = '';
        try {
          body = await resp.text();
        } catch {
          body = '';
        }
        checkResponses.push({
          url,
          status: resp.status(),
          snippet: (body || '').slice(0, 800),
        });
      } catch {
        /* ignore */
      }
    });

    try {
      await page.goto(CONFIG.weiboUrl, {
        waitUntil: 'domcontentloaded',
        timeout: CONFIG.navTimeout,
      });

      // Locate the email field (retry briefly; also try the 个人注册 tab).
      let found = await findEmailInput(page);
      if (!found) {
        for (const label of ['个人注册', '邮箱注册', '邮箱']) {
          const tab = page.locator(`text=${label}`).first();
          if ((await tab.count()) > 0) {
            await tab.click({ timeout: 2000 }).catch(() => {});
            found = await findEmailInput(page);
            if (found) break;
          }
        }
      }
      if (!found) {
        // Give slow scripts a moment, then retry once.
        await sleep(1500);
        found = await findEmailInput(page);
      }
      if (!found) {
        return {
          email,
          ...verdict('inconclusive', null, await collectVisibleText(page), checkResponses, 'email_field_not_found'),
          checkedAt: new Date().toISOString(),
          source: 'weibo-signup',
          weiboUrl: CONFIG.weiboUrl,
        };
      }

      const { loc } = found;
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click({ timeout: 5000 }).catch(() => {});
      await loc.fill('').catch(() => {});
      await loc.type(email, { delay: 30 });
      // Trigger the page's onblur/onchange validation.
      await page.keyboard.press('Tab').catch(() => {});
      await page.mouse.click(5, 5).catch(() => {});

      const result = await waitForVerdict(page, checkResponses, CONFIG.checkTimeout);
      return {
        email,
        ...result,
        checkedAt: new Date().toISOString(),
        source: 'weibo-signup',
        weiboUrl: CONFIG.weiboUrl,
      };
    } catch (err) {
      return {
        email,
        status: 'inconclusive',
        registered: null,
        matchedPhrase: null,
        reason: 'error',
        error: String((err && err.message) || err),
        evidence: { promptSnippet: '', apiResponses: checkResponses.slice(0, 5) },
        checkedAt: new Date().toISOString(),
        source: 'weibo-signup',
        weiboUrl: CONFIG.weiboUrl,
      };
    } finally {
      await context.close().catch(() => {});
    }
  });
}

module.exports = { checkEmail, closeBrowser, CONFIG };
