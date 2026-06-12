# device.authorize — 客户端授权（与微信无关）

本文件为 [SKILL.md](../SKILL.md) 的补充。**任意移动客户端、H5、第三方 App** 接入 admin-pro-core API 时，只需实现本机制，**无需** `Weixin`、`admin_wxapp` 或小程序登录逻辑。

参考实现来源：APC 项目 `AuthorizeRepository`、`DeviceAuthorize` 中间件；客户端协议与小程序 `apis.ts` 对齐。

## 1. 服务端组件

| 组件 | 典型路径 | 职责 |
|------|----------|------|
| Migration | `authorize` 表 | `type`, `appkey`, `appsecret`(bcrypt), `module`, `expire`, `remark` |
| Model | `App\Models\Authorize` | 校验 rules scene |
| Repository | `App\Repositories\Implement\AuthorizeRepository` | 生成凭证、换 token、验签 |
| Middleware | `App\Http\Middleware\DeviceAuthorize` | 注册别名 `device.authorize` |
| Trait | `App\Traits\AuthorizeAction::getAuthorize` | 公开换取 auth_code |
| Helper | `current_module()` | 控制器 namespace 首段，如 `Wxapp`、`Api` |
| Console | `admin:authorize {module} {remark?}` | 生成 appkey/appsecret |

### ServiceFactory

```php
ServiceFactory::authorize()->generate($module, $remark);   // 生成 DB 记录
ServiceFactory::authorize()->createAuthToken($appkey);     // 换 auth_code
ServiceFactory::authorize()->checkAuthToken();             // 中间件调用
```

### 生成客户端凭证

`routes/console.php` 中启用 Artisan 命令后：

```bash
php artisan admin:authorize MobileApp "Cordova H5"
# 输出 appkey、appsecret（明文仅此次显示，DB 存 bcrypt）
```

`module` 参数须与目标路由控制器 namespace 首段一致（见 §4）。

## 2. 协议

### 2.1 换取 auth_code（公开端点）

- **不要**挂 `device.authorize` 中间件
- 限流建议：`throttle:10,1`

```
POST {ADMIN_PREFIX}/{modulePrefix}/auth/authorize
Content-Type: application/json

{
  "type": "authorization_code",
  "appkey": "xxxxxxxxxxxxxxx",
  "appsecret": "明文秘钥"
}
```

成功响应（Las `ApiResponse` 包装）：

```json
{
  "code": 0,
  "result": {
    "auth_code": "md5...",
    "expire": 1737456789
  }
}
```

服务端逻辑：

1. `verify(type, appkey, appsecret)` — DB 查 appkey + `Hash::check`
2. `createAuthToken(appkey)` — 写 Redis `auth_code:{token}`，TTL 默认 864000s（10 天）
3. 缓存内容含 `appkey`、`auth_code`、`module`（来自 `current_module()`）、`expire`

### 2.2 受保护请求

挂 `device.authorize` 的路由组内，每次请求须带：

| 位置 | 名称 | 说明 |
|------|------|------|
| Header 或 Body | `Auth-Code` | 上一步获得的 auth_code |
| Header 或 Body | `Signature` | 见下式 |
| Query | `_time` | 毫秒时间戳，与签名使用同一值 |

**签名公式**（客户端与服务端必须一致）：

```
Signature = md5("{appkey}-{auth_code}-{_time}")
```

服务端 `checkAuthToken()`：

1. 缺任一参数 → `2002` APP_AUTHTOKEN_EMPTY
2. 从 Cache 取 `auth_code:{Auth-Code}`
3. `data.module === current_module()` 且签名匹配 → 通过
4. 否则 → `2003` APP_AUTHTOKEN_ERROR

### 2.3 错误码

| code | 常量 | 含义 |
|------|------|------|
| 2001 | APP_AUTHORIZE_ERROR | appkey/appsecret 验证失败 |
| 2002 | APP_AUTHTOKEN_EMPTY | 缺 Auth-Code / Signature / _time |
| 2003 | APP_AUTHTOKEN_ERROR | 签名错误、token 过期或 module 不匹配 |

### 2.4 客户端重试

收到 `2001`–`2003`：

1. 清除本地 auth_code 缓存
2. 重新 `POST …/auth/authorize`
3. 用新 auth_code 重发原请求

## 3. 路由挂载（可泛化到任意 module）

```php
// Kernel.php
'device.authorize' => \App\Http\Middleware\DeviceAuthorize::class,

// routes/{module}.php — 公开换取
Route::post('auth/authorize', 'AuthController@getAuthorize')
    ->middleware('throttle:10,1');

// 受保护 API
Route::group(['middleware' => 'device.authorize'], function (Router $router) {
    // 匿名可访问的业务（如字典、登录入口）
    $router->post('auth/login', 'AuthController@login');

    // 需用户登录再加 auth.admin
    $router->group(['middleware' => ['auth.admin']], function (Router $router) {
        $router->get('auth/info', 'AuthController@info');
    });
});
```

控制器复用 Trait：

```php
use App\Traits\AuthorizeAction;

class AuthController extends Controller
{
    use AuthorizeAction;
}
```

## 4. module 与 current_module()

`current_module()` 从当前路由控制器类名解析 namespace 首段：

```php
// App\Http\Controllers\Wxapp\AuthController → "Wxapp"
function current_module() {
    $route = str_replace('App\Http\Controllers\\', '', Route::current()->getActionName());
    return mb_substr($route, 0, mb_strpos($route, '\\'));
}
```

`admin:authorize` 的 `{module}` **必须**与此一致，否则 auth_code 校验时 module 不匹配 → 2003。

可为不同客户端模块各建路由前缀与 namespace，例如：

| 路由前缀 | Namespace | admin:authorize module |
|----------|-----------|------------------------|
| `/wxapp` | `Wxapp` | `Wxapp` |
| `/mobile` | `Mobile` | `Mobile` |

## 5. validation.php

```php
'device' => [
    'authorize' => [
        'type'    => ['name' => '认证类型', 'rules' => 'required|string|max:20'],
        'appkey'  => ['name' => '认证key',  'rules' => 'required|string|max:15'],
        'appsecret' => ['name' => '认证秘钥', 'rules' => 'required|string|max:255'],
    ],
],
```

控制器：`Validator::make($request, 'device.authorize')`。

## 6. 客户端实现要点

框架无关示例：[../assets/client-auth-generic.example.ts](../assets/client-auth-generic.example.ts)

1. **配置**：appkey、appsecret、baseUrl、modulePrefix（如 `/wxapp` 或 `/mobile`）
2. **缓存 auth_code**：key 建议 `authorization_code`；在 `expire` 或本地 TTL 到期前刷新
3. **请求拦截**：GET 在 URL 追加 `_time`；POST 同样追加 query `_time`（与服务端 `$request->input('_time')` 一致）
4. **可选用户 token**：Layer2 时在 Header 加 `Auth-Token`（与 device 签名独立）
5. **下载/上传**：与 JSON 请求相同 Header（Auth-Code + Signature + _time）

## 7. 与微信小程序的关系

| 仅 device.authorize | 完整小程序栈 |
|---------------------|--------------|
| authorize 表 + Repository + Middleware | 上述 + `Weixin` + `admin_wxapp` |
| 任意客户端 HTTP 库 | 另见 [wxapp-auth-stack.md](wxapp-auth-stack.md) |
| 用户登录可自建或用 `auth.admin` | `trylogin` / `login` + openid 绑定 |

**原则**：先确认是否只需 Layer1；多数第三方集成到此为止即可。
