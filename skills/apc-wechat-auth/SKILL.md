---
name: apc-wechat-auth
description: >-
  Use when integrating admin-pro-core (Laravel + lis/admin-service) mobile or
  third-party clients that need device.authorize (Auth-Code/Signature) and/or
  WeChat mini program login against /wxapp routes. Symptoms: 2001–2003 auth
  errors, missing Auth-Code header, wxapp auth/authorize setup.
---

# APC WeChat Auth

admin-pro-core（Laravel + `lis/admin-service` + Element UI）面向移动/第三方客户端的鉴权模式：**应用级 device.authorize** + **用户级 auth.admin** + **可选微信 openid 绑定**。

- **仅客户端授权（与微信无关）**：[references/device-authorize.md](references/device-authorize.md)
- **微信小程序完整栈**：[references/wxapp-auth-stack.md](references/wxapp-auth-stack.md)
- **客户端示例**：[assets/client-auth-generic.example.ts](assets/client-auth-generic.example.ts)、[assets/client-auth-miniprogram.example.ts](assets/client-auth-miniprogram.example.ts)

## When to use

| 场景 | 读哪份文档 | 需要 |
|------|-----------|------|
| H5 / Cordova / 第三方 App 接 APC API | `device-authorize.md` | Layer1 only |
| 微信小程序 + 后台同一套 admin 账号 | 两份都读 | Layer1 + Layer2 + Layer3 |
| 排查 2001–2003 | `device-authorize.md` | — |
| 排查 1102/1103 或 openid 未绑定 | `wxapp-auth-stack.md` | — |

**不适用**：纯管理后台 Vue 页面（走 `/api` + 浏览器 session，无 device 协议）。

## 三层鉴权

| 层 | 机制 | 校验对象 |
|----|------|----------|
| **Layer1** | `device.authorize` | 应用 appkey/appsecret → auth_code + Signature |
| **Layer2** | `auth.admin` | 用户 `Auth-Token`（与后台同源） |
| **Layer3** | 微信 `code2Session` | openid ↔ admin（仅小程序） |

Layer1 **可独立使用**，不必引入 `Weixin`、`admin_wxapp` 或小程序登录接口。

## Quick reference

| 项 | 值 |
|----|-----|
| 换取 auth_code | `POST …/auth/authorize` body: `{ type:"authorization_code", appkey, appsecret }` |
| 受保护请求 Header | `Auth-Code`, `Signature`；Query: `_time`（毫秒） |
| 签名 | `md5("{appkey}-{auth_code}-{_time}")` |
| 用户会话 Header | `Auth-Token` |
| 错误码 | `2001` 凭证错 / `2002` 缺参 / `2003` 签名或 module 不匹配 |
| 生成凭证 | `php artisan admin:authorize {Module} {remark?}` |
| 关键 PHP | `AuthorizeRepository`, `DeviceAuthorize`, `AuthorizeAction` |

## Implementation checklist

### 服务端（Layer1，任意 module）

1. Migration `authorize` 表 + `Authorize` Model
2. `AuthorizeRepository` + `ServiceFactory::authorize()`
3. `AuthorizeAction::getAuthorize` + 公开路由 `POST auth/authorize`
4. `DeviceAuthorize` 中间件注册为 `device.authorize`
5. 受保护路由组挂 `device.authorize`（**authorize 端点本身不要挂**）
6. `validation.php` scene `device.authorize`
7. `current_module()` 与 `admin:authorize` 的 module 参数一致
8. Redis Cache 前缀 `auth_code:`

### 客户端（Layer1）

1. 配置 appkey/appsecret（与 DB 记录对应）
2. 启动或过期前 `POST …/auth/authorize` 换 auth_code 并本地缓存
3. 每次请求附加 Header + `_time` 签名
4. 收到 2001–2003：清缓存 → 重新 authorize → 重发
5. 框架无关示例见 `assets/client-auth-generic.example.ts`

### 微信小程序追加（Layer2+3）

见 [references/wxapp-auth-stack.md](references/wxapp-auth-stack.md) 与 `assets/client-auth-miniprogram.example.ts`。

## Common mistakes

1. **device.authorize 与 auth.admin 混用** — 前者验应用，后者验用户
2. **authorize 端点误挂 device 中间件** — 无法换取 auth_code
3. **module 不匹配** — `admin:authorize Wxapp` 但路由 namespace 不是 `Wxapp`
4. **签名 _time 与 Query 不一致** — 服务端读 `$request->input('_time')`
5. **仅需第三方客户端却引入 Weixin** — 只实现 Layer1
6. **客户端缓存 TTL 与服务端 expire 不同步** — 以服务端 `expire` 为准提前刷新
