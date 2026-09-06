# 微博邮箱注册检测

输入邮箱，判断其是否已在微博注册。支持单个或批量（逐个检测）。

> ⚠️ **仅供个人学习与已获授权范围内的安全测试。** 请只检测本人拥有或已获授权的邮箱，
> 控制数量与频率，遵守微博服务条款及当地法律法规。使用后果由使用者自行承担。

---

## 原理

调用微博注册页自身的字段校验接口：

```
GET https://weibo.com/signup/v5/formcheck?type=email&value=<邮箱>
```

请求必须携带 `weibo.com` 的 `Referer`（浏览器在其它域名下无法伪造，跨域 `fetch` 也会被 CORS 拦截），
因此需要一个后端代为请求。返回 JSON 中的 `data.state` 与 `data.msg` 即为结论。

## 结果状态

| 状态 | 含义 | `registered` |
|------|------|:---:|
| `registered` | 已注册 | `true` |
| `not_registered` | 未注册（可注册） | `false` |
| `unsupported` | 微博不接受该邮箱（格式 / 服务商规则） | `null` |
| `inconclusive` | 无法确定（验证码 / 频率限制 / 接口异常 / 网络错误） | `null` |
| `invalid_email` | 邮箱格式无效（本地预校验） | `null` |

判定顺序：命中「已注册」→ 已注册；命中验证码 / 频率限制 / 参数限制 → 无法确定；`state=true` → 未注册；
命中「不支持」→ 邮箱不可用；其余 → 无法确定。任何异常返回都判为「无法确定」，不做二义性猜测。

## 目录结构

```
├── php/                 部署到 PHP 虚拟主机 / 宝塔用（只需这个目录）
│   ├── check.php        检测接口
│   └── index.html       页面
├── server.js            Node 版：HTTP 服务（静态页面 + /api/check）
├── lib/checker.js       Node 版核心逻辑
├── public/index.html    Node 版页面
├── test/                测试（离线 + 真实）
└── package.json
```

---

## 部署（三选一）

### 方式一：PHP 虚拟主机 / 宝塔面板（推荐，无需 Node）

只需 `php/` 目录里的两个文件。要求：**PHP 7+ 且启用 curl 扩展**（无 curl 时自动回退 `allow_url_fopen`）。

**宝塔面板：**

1. 软件商店安装 **Nginx**（或 Apache）与 **PHP 7.4 / 8.x**。
2. 软件商店 → 对应 PHP 版本 → 设置 → **安装扩展**，确认 `curl` 已安装（默认通常已装）；
   在同页 **禁用函数** 列表中确认 `curl_exec`、`curl_init` 未被禁用，若被禁用则移除。
3. **网站 → 添加站点**：填入域名，PHP 版本选已装版本，数据库选“不创建”。
4. 进入该站点 → **根目录**（默认 `/www/wwwroot/<域名>`），删除自带的 `index.html`；
   上传 `php/check.php` 与 `php/index.html` 到根目录（是 `php/` 里的两个文件，不是整个仓库）。
5. 浏览器访问 `http://<域名>/`（页面会自动请求同目录的 `check.php`）。
6. （可选）站点 → **SSL** → Let's Encrypt 一键签发，启用 HTTPS。

**普通 PHP 虚拟主机（无宝塔）：**

1. 确认主机支持 PHP 7+ 且有 curl 扩展。
2. 用 FTP / 文件管理，将 `php/check.php` 与 `php/index.html` 上传到网站根目录（`public_html` / `htdocs` / `wwwroot`）。
3. 访问 `http://<域名>/index.html`。

**验证：** 打开 `http://<域名>/check.php?email=test@example.com`，应返回一段 JSON。

### 方式二：本机运行（Node，最快自测）

要求 Node.js 18+，无第三方依赖。

```bash
node server.js
```

打开 `http://127.0.0.1:3000`。

### 方式三：VPS + 宝塔运行 Node（长期在线）

1. 宝塔软件商店安装 **Node 版本管理器**，安装 Node 18+。
2. 上传整个项目到一个目录。
3. **网站 → Node 项目 → 添加项目**：项目目录选该目录，启动文件 `server.js`，端口 `3000`，
   运行方式选常驻；如需域名，绑定域名并开启反向代理到该端口。

---

## 配置（环境变量，可选）

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `3000` | 端口（Node） |
| `HOST` | `127.0.0.1` | 监听地址（Node） |
| `MIN_INTERVAL_MS` | `1500` | 两次检测最小间隔（毫秒），限速 |
| `MAX_BACKOFF_MS` | `30000` | 触发风控时的最大自适应退避（Node） |
| `CHECK_TIMEOUT` | `15000`（PHP 为秒：`15`） | 单次请求超时 |
| `RATE_MAX` | `120` | 每 IP 每分钟上限（Node） |
| `USER_AGENT` | 桌面 Chrome UA | 自定义 UA |
| `WEIBO_FORMCHECK_URL` | 上述接口 | 目标接口 |
| `WEIBO_REFERER` | 注册页 URL | 请求 Referer |

宝塔 Node 项目可在“项目设置 → 环境变量”中配置；PHP 版可在服务器环境变量或站点配置中设置。

## API

```
GET /api/check?email=<邮箱>     (Node)
GET /check.php?email=<邮箱>      (PHP)
```

返回示例：

```json
{
  "email": "name@example.com",
  "status": "registered",
  "registered": true,
  "message": "该邮箱已注册，请直接登录",
  "evidence": { "state": false, "code": "600001", "msg": "该邮箱已注册，请直接登录" },
  "checkedAt": "2026-01-01T00:00:00.000Z",
  "source": "weibo-formcheck"
}
```

## 测试

```bash
npm test                    # 离线：单元 + mock 集成
node test/smoke-server.js   # 离线：服务端到端
node test/real-weibo.js a@example.com b@example.com   # 真实接口（需能访问微博）
```

## 常见问题

- **纯静态页面能否直接用？** 不能。接口要求 `weibo.com` 的 Referer，浏览器无法伪造，必须有后端（PHP 或 Node）。
- **结果为 `network_error`：** 运行环境不能访问 `weibo.com`，或 PHP 未启用 curl / 禁用了 curl 函数。
- **持续 `inconclusive`（验证码 / 参数限制）：** 触发了微博风控 / 频率限制，结果不可靠。工具已内置自适应退避（连续受阻会自动放慢并重试），但仍应减少数量、降低频率或稍后再试。批量越大越容易被限速。
- **`unsupported`（邮箱不可用）：** 微博不接受该邮箱（如全数字 `@163.com` 等非法格式）。注意判定顺序是「先查是否已注册」：已注册的邮箱即使格式特殊也会显示 `registered`，因此 `unsupported` 通常意味着未注册且该地址不可用于注册。
- **能否绕过验证码 / 提高频率上限？** 不能也不应；验证码与限速是微博的反滥用机制。可靠做法是小批量、低频率检测，并信任 `registered` 结果。

## 免责声明

本项目仅用于个人学习与已获授权的安全测试，用于演示注册表单的账号枚举（account enumeration）行为。
禁止用于批量枚举、骚扰、侵犯隐私或任何违反微博服务条款与法律法规的用途。使用者需自行承担全部责任。
