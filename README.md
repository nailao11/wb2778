# 微博邮箱注册检测 · Weibo Email Registration Checker

一个网页小工具：输入一个邮箱，点击按钮，判断它**是否已在微博注册**，并把结果显示出来。

> ⚠️ **仅供个人学习与已授权范围内的安全测试（账号枚举 / account enumeration 演示）。**
> 请只检测你本人拥有或已获授权的邮箱，控制检测频率，遵守微博服务条款与当地法律。

**零依赖**：只用 Node.js 内置模块，不需要安装任何包，也不需要浏览器。

---

## 判断依据

直接调用微博注册页**自身**在你输入邮箱、离开输入框时所调用的校验接口：

```
GET https://weibo.com/signup/v5/formcheck?type=email&value=<邮箱>
```

它返回一段 JSON，微博自己就在里面给出了结论（以下为真实抓包结果）：

| `data.state` | `data.msg` | 工具结论 |
|:---:|---|---|
| `false` | `该邮箱已注册，请直接登录` | **已注册** `registered` |
| `true` | （空） | **未注册（可注册）** `not_registered` |
| `false` | `注册失败(邮箱不支持)` | **邮箱不可用** `unsupported`（格式/服务商不被接受） |

这正是你在页面上看到的那句「该邮箱已注册，请直接登录」，只是直接从接口读取，所以又快又准。
出现验证码 / 频率限制 / 接口改版 / 网络错误等**无法确定**的情况时，一律返回 `inconclusive`，
**绝不猜测、绝不误判**。

### 结果状态

| 状态 | 含义 | `registered` |
|------|------|:---:|
| `registered` | 已注册 | `true` |
| `not_registered` | 未注册（可注册） | `false` |
| `unsupported` | 微博不接受该邮箱（格式/服务商规则） | `null` |
| `inconclusive` | 无法确定（验证码 / 频率限制 / 接口异常 / 网络错误） | `null` |
| `invalid_email` | 邮箱格式无效（本地预校验） | `null` |

**为什么需要后端？** 浏览器同源策略下前端 JS 读不到 weibo.com 的返回，所以用一个极小的
Node 后端代为请求、解析并返回结果。前端页面由同一个后端提供，天然无跨域问题。

---

## 运行方式

### 1. 环境要求
- Node.js **18+**（推荐 20/22；用到内置 `fetch`）
- 运行环境需能正常访问 `weibo.com`

### 2. 启动
```bash
node server.js
# 或
npm start
```
> 没有第三方依赖，`npm install` 可跳过（跑一下也行，它不会装任何东西）。

然后浏览器打开 **http://127.0.0.1:3000** ，输入邮箱、点「检测」。

### 命令行直接测（可选）
```bash
node test/real-weibo.js someone@example.com another@example.com
```

---

## 配置（环境变量，均可选）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `MIN_INTERVAL_MS` | `1000` | 两次检测的最小间隔（毫秒），礼貌限速 |
| `CHECK_TIMEOUT` | `15000` | 单次请求超时（毫秒） |
| `RATE_MAX` | `20` | 每个 IP 每分钟最多请求数 |
| `USER_AGENT` | 常见桌面 Chrome UA | 自定义 UA |
| `WEIBO_FORMCHECK_URL` | 上述接口 | 目标接口（测试时可指向本地 mock） |
| `WEIBO_REFERER` | 注册页 URL | 请求携带的 Referer |

### Behind a proxy / 在代理环境下
若你的机器必须经代理访问外网，用如下方式启动（Node 的内置 fetch 需要在**启动时**开启代理）：
```bash
HTTPS_PROXY=http://your-proxy:port NODE_USE_ENV_PROXY=1 node server.js
# 若代理会重签 TLS，还需： NODE_EXTRA_CA_CERTS=/path/to/proxy-ca.crt
```

---

## API

```
GET /api/check?email=someone@163.com
```
返回 JSON，例如（真实返回）：
```json
{
  "email": "someone@163.com",
  "status": "registered",
  "registered": true,
  "message": "该邮箱已注册，请直接登录",
  "evidence": { "state": false, "code": "600001", "msg": "该邮箱已注册，请直接登录" },
  "checkedAt": "2026-09-05T12:00:00.000Z",
  "source": "weibo-formcheck"
}
```
另有 `GET /api/health` 健康检查。

---

## 测试

```bash
npm test              # 离线测试：interpret() 单测（用真实抓到的 JSON）+ 对本地 mock 的集成测试，不联网
npm run test:real     # 真实测试：直接请求 weibo.com（需能访问微博）
node test/smoke-server.js   # 端到端：起服务 + 前端 + /api/check（对本地 mock）
```
`test/mock-server.js` 复现了 `formcheck` 的真实 JSON 结构，覆盖：已注册 / 未注册 / 邮箱不可用 /
验证码 / 参数错误 / 非 JSON / 非 200 等分支。

> 说明：本工具已在真实 weibo.com 上验证通过（例如 `14725836900@163.com` → 已注册，
> 返回「该邮箱已注册，请直接登录」，与注册页表现一致）。

---

## 常见问题

- **返回「无法确定」inconclusive**：可能是微博要求验证码 / 触发频率限制（降低频率、稍后再试），
  或接口返回异常（`reason` 字段会说明：`challenge_or_rate_limit` / `unexpected_response` /
  `bad_response` / `unknown_message`）。`network_error` / `timeout` 则表示本机访问微博失败。
- **全部返回 `bad_response` 且提示 host 不在白名单**：说明当前环境的网络策略未放行 weibo.com，
  请在能访问微博的机器/网络上运行（或按上文配置代理并放行 weibo.com）。
- **结果会变**：一切以微博接口实时返回为准，可能随其改版与风控策略变化；本工具已尽量对异常返回
  保守处理，避免误判。

---

## 项目结构

```
.
├── server.js            # 极小 HTTP 服务：静态前端 + /api/check（Node 内置模块）
├── lib/checker.js       # 核心：请求 formcheck 接口并解析 JSON 给出判定（零依赖）
├── public/index.html    # 前端页面
├── test/
│   ├── mock-server.js   # 本地 mock：复现 formcheck 的真实 JSON
│   ├── run-test.js      # 单测 + 集成测试（离线）
│   ├── smoke-server.js  # 端到端测试（离线）
│   └── real-weibo.js    # 真实接口测试（需联网）
├── package.json
└── README.md
```

---

## 免责声明

本项目仅用于**个人学习**与**已获授权**的安全测试 / 调试，用于演示注册表单的账号枚举
（account/username enumeration）行为。请勿用于批量枚举、骚扰、侵犯他人隐私或任何违反
微博服务条款及法律法规的用途。使用者需自行承担相应责任。
