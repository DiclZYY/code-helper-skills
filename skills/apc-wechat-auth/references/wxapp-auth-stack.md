# 微信小程序鉴权栈（Layer1 + Layer2 + Layer3）

本文件为 [SKILL.md](../SKILL.md) 的补充。仅在 **微信小程序** 对接 admin-pro-core `/wxapp` 路由时阅读。

**Layer1（device.authorize）** 必须先读 [device-authorize.md](device-authorize.md)，本文在其之上叠加用户登录与微信 openid 绑定。

## 1. 路由结构

`RouteServiceProvider::mapWxappRoutes()`：

```php
Route::prefix('wxapp')
    ->middleware('json')
    ->namespace($this->namespace . '\Wxapp')
    ->group(base_path('routes/wxapp.php'));
```

### 三层中间件分组

```
公开（无 device）
├── POST auth/authorize      ← Layer1 换 auth_code
└── GET  auth/signature      ← 微信服务器 URL 校验

device.authorize
├── POST auth/trylogin       ← 微信 code 快捷登录
├── POST auth/login          ← 账号密码 + 可选 bind code
└── GET  dictionary/*        ← 匿名可读字典等

device.authorize + auth.admin
├── GET/POST auth/info|logout|passwd
├── POST auth/update_profile
└── … 业务 API
```

## 2. 服务端组件

| 组件 | 路径 | 职责 |
|------|------|------|
| `Weixin` | `App\Extensions\Weixin` | `code2Session`, `decryptData`, `accessToken`, 订阅消息 |
| `AdminWxapp` | Model + Migration | openid ↔ admin_id，昵称头像等 |
| `AdminWxappRepository` | `Implement/AdminWxappRepository` | 登录、绑定、资料更新 |
| `AuthController` | `Http/Controllers/Wxapp/AuthController` | authorize + 登录 + info |
| `Constant::PLATFORM_WXAPP` | `= 2` | 登录平台标识 |
| `AdminAuthRepository::EXPIRE_WXAPP` | 129600 分钟 | 小程序会话约 90 天 |

### 环境变量 / 配置

`config/admin.php` → `wxapp`：

```php
'wxapp' => [
    'state'     => env('ADMIN_WXAPP_STATE'),     // developer|trial|formal
    'appid'     => env('ADMIN_WXAPP_APPID'),
    'appsecret' => env('ADMIN_WXAPP_APPSECRET'),
],
```

`.env.example`：`ADMIN_WXAPP_STATE`, `ADMIN_WXAPP_APPID`, `ADMIN_WXAPP_APPSECRET`

依赖：`ext-curl`, `php-curl-class/php-curl-class`

## 3. 登录流程

### 3.1 trylogin（openid 已绑定）

```
POST /wxapp/auth/trylogin
Headers: Auth-Code, Signature, Auth-Token(无)
Query: _time=...
Body: { "code": "wx.login() 返回的 code" }
```

1. `Weixin::code2Session($code)` → openid
2. 查 `admin_wxapp`  where openid
3. 未绑定 → 业务错误（需先账号密码登录绑定）
4. 已绑定 → `loginSuccess($admin)` → 返回 `Auth-Token` 等

### 3.2 login（账号密码 + 可选绑定）

```
POST /wxapp/auth/login
Body: { "account", "password", "code"? }
```

1. `ServiceFactory::auth()->login(..., PLATFORM_WXAPP)`
2. 若带 `code` → `bindAccountByCode` 写 `admin_wxapp`
3. 返回用户 token（与后台 admin 同源）

### 3.3 updateProfile

需 `auth.admin`。用缓存的 `session_key` 校验 `signature`，解密 `encryptedData` 更新昵称头像等。

### 3.4 checkSignature

微信消息推送服务器配置用，GET 校验 `token/timestamp/nonce` SHA1。

## 4. admin_wxapp 表

| 字段 | 说明 |
|------|------|
| admin_id | FK → admin |
| openid | 微信 openid |
| nickName, avatarUrl, … | 用户资料 |
| unionId | 可选 |
| device | 客户端信息 JSON |

openid 须预先存在（密码登录时 bind，或后台预置）才能 `trylogin`。

## 5. 客户端（apis.ts 解读）

完整实现参考 APC 项目 `wxapp/miniprogram/apis/apis.ts`；精简示例见 [../assets/client-auth-miniprogram.example.ts](../assets/client-auth-miniprogram.example.ts)。

### 5.1 全局配置

```typescript
const { appkey, appsecret, baseUrl } = getApp().globalData
const apiBase = baseUrl + '/wxapp'  // 所有业务请求前缀
```

appkey/appsecret 与 `php artisan admin:authorize Wxapp` 生成的记录一致（命令定义在 `api/routes/console.php`，**默认注释关闭**，启用方法见 [device-authorize.md §生成客户端凭证](device-authorize.md)）。

### 5.2 Layer1：auth_code 生命周期

| 步骤 | 实现 |
|------|------|
| 缓存 key | `authorization_code`（storage） |
| 换取 | `POST ${apiBase}/auth/authorize`，body `{ type, appkey, appsecret }` |
| 本地 TTL | apis.ts 用 7 天；服务端默认 10 天 — **以服务端 expire 为准，宜提前刷新** |
| 签名 | `md5(\`${appkey}-${code}-${_time}\`)` |
| 重试 | 响应 code ∈ {2001,2002,2003} → 清缓存 → 重新 authorize → 重发 |

### 5.3 Layer2：用户 token

```typescript
header['Auth-Token'] = getUserTokenAsync()
```

用户失效：`code` 为 `1102` 或 `1103` → 清用户信息、引导重新登录（**不要**与 200x 混在同一分支）。

### 5.4 请求流水线（request 函数）

```
getAuthCode()
  → mergeOptions + setHeaderCode(code) + append _time to URL
  → wx.request / wx.uploadFile
  → checkAuth (200x 重试)
  → checkUserToken (1102/1103)
  → handleRequestSuccess (code === 0)
```

### 5.5 下载 / 二进制

`requestDownload`、`requestArrayBuffer` 复用 `fetchAuthCode` + `buildSignedRequestHeaders`，GET URL 带 query + `_time`。

## 6. validation.php（wxapp 场景）

```php
'wxapp' => [
    'trylogin' => [ /* code, encryptedData, iv — 旧版手机号解密 */ ],
    'update_profile' => [ /* code, rawData, signature, encryptedData, iv */ ],
],
'device' => [
    'login' => [ 'account', 'password', 'code' => nullable ],
],
```

当前 `trylogin` 实现仅传 `code`（openid 绑定模式），校验 scene 可简化为 `auth.login` 的 code 字段。

## 7. 排查清单

| 现象 | 检查 |
|------|------|
| 2003 | module 是否为 `Wxapp`；签名 _time 是否与 URL 一致；auth_code 是否过期 |
| 2001 | appkey/appsecret 是否与 DB 一致 |
| trylogin 账号不存在 | openid 未 bind；需先 login 带 code |
| 1102/1103 | Auth-Token 过期；重新 login |
| 微信 code2Session 失败 | ADMIN_WXAPP_APPID/SECRET、网络、code 一次性 |

## 8. 与仅 device 模式的对比

```
仅 Layer1（第三方 App）:
  authorize → 带签名调 API → （可选）自建用户体系或 auth.admin

完整小程序:
  authorize → trylogin/login → Auth-Token → 带签名+Token 调业务 API
  updateProfile / 订阅消息 等依赖 Weixin + admin_wxapp
```

新增小程序功能时：**不要**跳过 Layer1；所有 `/wxapp` 业务请求（除 authorize/signature）均须 device 签名。
