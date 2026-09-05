# 微博邮箱注册检测 · Weibo Email Registration Checker

一个网页小工具：输入一个邮箱，点击按钮，判断它**是否已在微博注册**，并把结果显示出来。

> ⚠️ **仅供个人学习与已授权范围内的安全测试（账号枚举 / account enumeration 演示）。**
> 请只检测你本人拥有或已获授权的邮箱，控制检测频率，遵守微博服务条款与当地法律。

---

## 判断依据

完全以**微博真实注册页**的实时提示为准，不猜测、不伪造：

1. 后端用无头浏览器（Playwright + Chromium）打开注册页：
   `https://www.weibo.com/signup/mobile.php?lang=zh-cn&inviteCode=&from=&appsrc=&backurl=&showlogo=`
2. 像真人一样把邮箱填进「邮箱」输入框并触发校验；
3. 读取页面提示：
   - 出现 **「该邮箱已注册，请直接登录」** → **已注册**；
   - 校验完成且无该提示（或提示「可以注册」）→ **未注册**；
   - 出现验证码 / 频率限制 / 页面异常等无法确定的情况 → **无法确定**（不会误判）。

### 结果状态

| 状态 | 含义 | `registered` |
|------|------|:---:|
| `registered` | 已注册 | `true` |
| `not_registered` | 未注册 | `false` |
| `inconclusive` | 无法确定（验证码 / 频率限制 / 页面改版 / 网络错误等） | `null` |
| `invalid_email` | 邮箱格式无效 | `null` |

**为什么需要后端？** 浏览器受同源策略限制，前端 JS 无法读取 `weibo.com` 的返回；微博还带有反爬 JS。
无头浏览器直接运行微博自己的页面脚本，天然携带所需的 cookie / token，是最准确、最不易误判的方式。

---

## 运行方式

### 1. 环境要求
- Node.js **18+**
- 首次运行需要下载一次 Chromium（约 150MB）

### 2. 安装
```bash
npm install
npx playwright install chromium
```

### 3. 启动
```bash
npm start
```
然后浏览器打开 **http://127.0.0.1:3000** ，输入邮箱、点「检测」。

---

## 配置（环境变量，均可选）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `HEADFUL` | `0` | 设为 `1` 用**有头模式**（能看到浏览器窗口；遇到验证码时便于手动处理/排查） |
| `MIN_INTERVAL_MS` | `3000` | 两次检测之间的最小间隔（毫秒），礼貌限速 |
| `CHECK_TIMEOUT` | `15000` | 等待页面提示的超时（毫秒） |
| `NAV_TIMEOUT` | `30000` | 打开注册页的超时（毫秒） |
| `RATE_MAX` | `20` | 每个 IP 每分钟最多请求数 |
| `USER_AGENT` | 一个常见的桌面 Chrome UA | 自定义 UA |
| `CHROMIUM_PATH` | 空（由 Playwright 自动定位） | 指定 Chromium 可执行文件路径 |
| `WEIBO_URL` | 上述注册页 | 目标页面（测试时可指向本地 mock） |

示例：有头模式 + 换端口
```bash
HEADFUL=1 PORT=8080 npm start
```

---

## API

```
GET /api/check?email=someone@163.com
```
返回 JSON，例如：
```json
{
  "email": "someone@163.com",
  "status": "registered",
  "registered": true,
  "matchedPhrase": "该邮箱已注册",
  "evidence": {
    "promptSnippet": "…该邮箱已注册，请直接登录…",
    "apiResponses": [ { "url": "…", "status": 200, "snippet": "…" } ]
  },
  "checkedAt": "2026-09-05T12:00:00.000Z",
  "source": "weibo-signup"
}
```
其他：`GET /api/health` 健康检查。

---

## 测试

无需联网、不访问 weibo.com。使用本地 mock 注册页验证判定逻辑的每个分支：
```bash
npm test                 # 直接测试核心判定逻辑（lib/checker.js）
node test/smoke-server.js  # 端到端测试 HTTP 服务 + 前端 + /api/check
```
`test/mock-weibo.html` + `test/mock-server.js` 复现了微博注册页「填邮箱→XHR校验→显示提示」的行为，
覆盖：已注册 / 未注册 / 无提示但校验通过 / 验证码 / 邮箱格式错误。

---

## 常见问题

- **总是返回「无法确定」（验证码 / 安全验证）**：微博对频繁或可疑访问会弹验证码。
  降低频率，或用 `HEADFUL=1` 打开可见窗口手动通过一次；换网络 / IP 也可能有帮助。
- **返回 `inconclusive` 且 `reason=error`（网络错误）**：所在环境无法访问 `weibo.com`。
  本工具需在**能正常打开微博的机器/网络**上运行。
- **找不到邮箱输入框（`email_field_not_found`）**：微博页面可能已改版；
  查看返回里的 `evidence.promptSnippet`，必要时更新 `lib/checker.js` 里的选择器 / 提示词。
- **结果会变**：一切以微博页面实时提示为准，可能随其改版与风控策略变化。

---

## 项目结构

```
.
├── server.js            # HTTP 服务：静态前端 + /api/check
├── lib/checker.js       # 核心：Playwright 打开注册页、读取提示、给出判定
├── public/index.html    # 前端页面
├── test/
│   ├── mock-weibo.html  # 本地 mock 注册页
│   ├── mock-server.js   # 本地 mock 服务（含校验接口）
│   ├── run-test.js      # 判定逻辑测试
│   └── smoke-server.js  # 端到端测试
├── package.json
└── README.md
```

---

## 免责声明

本项目仅用于**个人学习**与**已获授权**的安全测试/调试，用于演示注册表单的账号枚举
（account/username enumeration）行为。请勿用于批量枚举、骚扰、侵犯他人隐私或任何违反
微博服务条款及法律法规的用途。使用者需自行承担相应责任。
