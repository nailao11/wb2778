# 微博邮箱注册检测（PHP 版）

输入邮箱，判断其是否已在微博注册。支持单个或批量（逐个检测）。
**为宝塔面板 / PHP 虚拟主机而做，上传即用，无需 Node、无需数据库。**

> ⚠️ **仅供个人学习与已获授权范围内的安全测试。** 请只检测本人拥有或已获授权的邮箱，
> 控制数量与频率，遵守微博服务条款及当地法律法规。使用后果由使用者自行承担。

---

## 原理

调用微博注册页自身的字段校验接口：

```
GET https://weibo.com/signup/v5/formcheck?type=email&value=<邮箱>
```

请求必须携带 `weibo.com` 的 `Referer`（浏览器在其它域名下无法伪造，跨域 `fetch` 也会被 CORS 拦截），
因此需要一个后端代为请求——这里就是 `check.php`。返回 JSON 中的 `data.state` 与 `data.msg` 即为结论。

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
├── index.html    页面（前端，默认请求同目录的 check.php）
├── check.php     检测接口（HTTP 入口）
├── lib.php       核心逻辑：判定 / 取数 / 限速退避（被 check.php 引入）
├── test.php      离线单元测试（命令行运行：php test.php）
└── README.md
```

上传时至少需要 **`index.html`、`check.php`、`lib.php`** 三个文件；`test.php`、`README.md` 可传可不传。

---

## 部署

要求：**PHP 7.0+**，建议启用 **curl 扩展**（未启用时自动回退 `allow_url_fopen`）。运行环境需能访问 `weibo.com`。

### 方式一：宝塔面板

1. 软件商店安装 **Nginx**（或 Apache）与 **PHP 7.4 / 8.x**。
2. 软件商店 → 对应 PHP 版本 → 设置 → **安装扩展**，确认 `curl` 已安装（默认通常已装）；
   在同页 **禁用函数** 列表里确认 `curl_exec`、`curl_init` 未被禁用，若被禁用则移除。
3. **网站 → 添加站点**：填入域名，PHP 版本选已装版本，数据库选“不创建”。
4. 进入该站点 → **根目录**（默认 `/www/wwwroot/<域名>`），删除自带的 `index.html`；
   把 `index.html`、`check.php`、`lib.php` 上传到根目录。
5. 浏览器访问 `http://<域名>/`，输入邮箱点“检测”。
6. （可选）站点 → **SSL** → Let's Encrypt 一键签发，启用 HTTPS。

### 方式二：普通 PHP 虚拟主机（cPanel / 宝塔虚拟主机 / 传统空间）

1. 确认主机支持 PHP 7+（有 curl 更好）。
2. 用 FTP / 文件管理，把 `index.html`、`check.php`、`lib.php` 上传到网站根目录
   （常见为 `public_html` / `htdocs` / `wwwroot`）。
3. 访问 `http://<域名>/`。

**验证接口：** 浏览器打开 `http://<域名>/check.php?email=test@example.com`，应返回一段 JSON。

---

## 配置（环境变量，均可选）

| 变量 | 默认 | 说明 |
|------|------|------|
| `MIN_INTERVAL_MS` | `1500` | 两次检测的最小间隔（毫秒），全局节流 |
| `MAX_BACKOFF_MS` | `30000` | 触发风控时的最大自适应退避（毫秒） |
| `RATE_MAX` | `120` | 每 IP 每分钟请求上限；设 `0` 关闭 |
| `CHECK_TIMEOUT` | `15` | 单次请求超时（秒） |
| `USER_AGENT` | 桌面 Chrome UA | 自定义 UA |
| `WEIBO_FORMCHECK_URL` | 上述接口 | 目标接口 |
| `WEIBO_REFERER` | 注册页 URL | 请求 Referer |

- **宝塔面板：** 网站 → 该站点 → **配置文件**，在 PHP 的 `location ~ \.php` 段用 `fastcgi_param` 传入，
  或在「PHP 命令行 / 项目」环境变量中设置；也可用系统环境变量。
- 不设置时使用上表默认值即可正常工作。节流 / 限速状态存放在系统临时目录（`sys_get_temp_dir()`）的
  `weibo_check_state.json`，临时目录不可写时会自动跳过节流（不影响判定）。

## API

```
GET check.php?email=<邮箱>
```

返回示例：

```json
{
  "email": "name@example.com",
  "source": "weibo-formcheck",
  "checkedAt": "2026-01-01T00:00:00+00:00",
  "status": "registered",
  "registered": true,
  "message": "该邮箱已注册，请直接登录",
  "evidence": { "state": false, "code": "600001", "msg": "该邮箱已注册，请直接登录" }
}
```

## 测试

在任意有 PHP 命令行的环境（含宝塔的「PHP 命令行」）运行离线单元测试，不联网：

```bash
php test.php
```

会校验各种微博返回（已注册 / 可注册 / 不支持 / 参数错误 / 参数限制 / 非 JSON / HTTP 5xx）的判定是否正确。

## 常见问题

- **纯静态页面能直接用吗？** 不能。接口要求 `weibo.com` 的 Referer，浏览器无法伪造，必须由 `check.php` 代为请求。
- **结果为 `network_error`：** 运行环境不能访问 `weibo.com`，或 PHP 未启用 curl 且禁用了 `allow_url_fopen`。
- **持续 `inconclusive`（验证码 / 参数限制）：** 触发了微博风控 / 频率限制，结果不可靠。后端已内置
  **自适应退避**（连续受阻会自动放慢并重试），前端也提供「自动重试未确定项直到全部确定」开关与
  「每个间隔 / 轮间等待」设置——可挂机让其耐心重试到每个候选都有确定结论，避免把目标漏在未验证的一批里。
  但仍应减少数量、降低频率或稍后再试；批量越大越容易被限速。
- **`unsupported`（邮箱不可用）：** 微博不接受该邮箱（如全数字 `@163.com` 等非法格式）。判定顺序是
  「先查是否已注册」：已注册的邮箱即使格式特殊也会显示 `registered`，因此 `unsupported` 通常意味着未注册且该地址不可用于注册。
- **准确性说明：** `registered`（已注册）结果最可信；被限速时若返回貌似「可注册」的响应，`not_registered`
  可能是假象——出现风控迹象时请以重试到稳定后的结果为准。
- **放到公网时的安全：** 后端没有登录鉴权，任何能访问该地址的人都能用它做邮箱枚举。个人使用建议
  绑私有域名 / 加访问限制，并按需调低 `RATE_MAX`；`RATE_MAX` 已默认开启每 IP 每分钟上限。
- **能绕过验证码 / 提高频率上限吗？** 不能也不应；验证码与限速是微博的反滥用机制。可靠做法是小批量、低频率检测，并信任 `registered` 结果。

## 免责声明

本项目仅用于个人学习与已获授权的安全测试，用于演示注册表单的账号枚举（account enumeration）行为。
禁止用于批量枚举、骚扰、侵犯隐私或任何违反微博服务条款与法律法规的用途。使用者需自行承担全部责任。
