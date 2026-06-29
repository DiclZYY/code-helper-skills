# Replace navigation and app stack history（应用内栈历史）

本文件为 [SKILL.md](../SKILL.md) 的补充，沉淀 H5 SPA 在微信内置浏览器等环境下的 **replace 导航**机制。

核心：**URL 仍反映当前子页，但浏览器 history 不增长；应用自己维护 `stackHistory` 作为返回链。**

## 1. 为什么需要 replace 导航

在微信内置浏览器中，如果 SPA 每次子页跳转都 `router.push()`，浏览器 history 会持续增长。部分环境下打开页面后底部会出现微信自带的「返回 / 前进」按钮，破坏类原生 App 体验。

replace 导航的目标：

| 目标 | 做法 |
|------|------|
| 不增长浏览器 history | 所有应用内栈跳转使用 `router.replace()` |
| 仍支持页面 URL | 当前页 path/query 由 router 正常维护 |
| 仍支持 App 内返回 | 自维护 `stackHistory` |
| 保持转场语义 | `openStackPage` 压栈前记录当前路由；`goBack` 弹栈后 replace |

## 2. 核心数据结构

### 2.1 StackEntry

```javascript
/** @typedef {{ path: string, query?: Record<string, string>, hash?: string }} StackEntry */
```

只存可还原路由的最小快照：

- `path`
- `query`
- `hash`

不要直接存完整 route 对象，避免响应式对象、matched records、meta 等不可序列化内容混入。

### 2.2 navigation store

```javascript
const state = {
  routeTransitionName: 'fade',
  stackPageTransitionName: '',
  overrideTransitionName: null,
  overrideStackPageTransitionName: null,
  cachedRouteNames: [...defaultCachedRouteNames],
  isMainTabLayerHidden: false,
  refreshOnBack: false,

  // replace 导航下的滚动恢复，比 route.meta 更可靠
  scrollTops: {},

  // 应用内栈历史：配合 router.replace，不写入浏览器 history
  stackHistory: [],

  // openStackPage 待确认压栈；导航成功后再写入 stackHistory
  pendingStackPush: null,
}
```

关键动作：

```javascript
function pushStackEntry(entry) {
  stackHistory.push({
    path: entry.path,
    query: entry.query ? { ...entry.query } : {},
    hash: entry.hash || '',
  })
}

function popStackEntry() {
  return stackHistory.pop() ?? null
}

function peekStackEntry() {
  return stackHistory.length > 0 ? stackHistory[stackHistory.length - 1] : null
}

function resetStack() {
  stackHistory = []
}

function setPendingStackPush(entry) {
  pendingStackPush = entry
    ? { path: entry.path, query: entry.query ? { ...entry.query } : {}, hash: entry.hash || '' }
    : null
}

function commitPendingStackPush() {
  if (pendingStackPush) {
    stackHistory.push(pendingStackPush)
    pendingStackPush = null
  }
}
```

## 3. 导航 API

### 3.1 openStackPage：先记 pending，再 replace

```javascript
const APP_SHELL_PATH = '/'

function snapshotRoute(route) {
  return {
    path: route.path,
    query: { ...route.query },
    hash: route.hash,
  }
}

function openStackPage(to) {
  navigationStore.setPendingStackPush(snapshotRoute(router.currentRoute.value))
  router.replace(to)
}
```

为什么不是直接 `pushStackEntry(currentRoute)`？

- 导航可能被鉴权守卫阻断；
- 导航可能重定向到登录页；
- 导航可能失败；
- 直接 push 会造成 stackHistory 与真实页面不一致。

### 3.2 afterEach：导航成功后提交 pending

```javascript
router.afterEach((to, from, failure) => {
  if (failure) {
    navigationStore.clearPendingStackPush()
    return
  }
  navigationStore.commitPendingStackPush()
})
```

> `pendingStackPush` 是 replace 导航的关键配套机制：它保证「只有真实进入了下一页，才把来源页压入应用内栈」。

### 3.3 goBack：弹应用内栈后 replace

```javascript
function goBack(shouldRefreshOnBack = false, autoTransition = true) {
  if (autoTransition) navigationStore.setOverrideTransition('slide-left')
  if (shouldRefreshOnBack) navigationStore.setRefreshOnBack(true)

  const prev = navigationStore.popStackEntry()
  router.replace(prev ?? { path: APP_SHELL_PATH })
}
```

语义：

| 情况 | 行为 |
|------|------|
| `stackHistory` 有上一页 | `pop` 后 `router.replace(prev)` |
| 栈空 | `router.replace('/')` 回 AppShell |
| 需要刷新上一页 | `setRefreshOnBack(true)`，由页面恢复逻辑消费 |
| 特殊场景已手动设转场 | `autoTransition=false`，避免覆盖 |

### 3.4 closeStack：清空栈并回 AppShell

```javascript
function closeStack(transitionName = 'slide-left') {
  navigationStore.resetStack()
  navigationStore.setOverrideTransition(transitionName)
  router.replace(APP_SHELL_PATH)
}
```

适用：登录完成、业务流程完成、强制回首页。

## 4. 路由守卫配套

replace 导航并不改变转场守卫的职责：

1. 鉴权；
2. 计算 `routeTransitionName` / `stackPageTransitionName`；
3. 控制 `MainTabLayer` 显隐；
4. 同步 keep-alive；
5. afterEach 提交 pending stack。

```javascript
router.beforeEach(async (to, from) => {
  if (to.meta?.requiresLogin && !token) {
    return { path: '/login', query: { redirect: to.fullPath }, replace: true }
  }

  const routeTransitionName = resolveTransitionName(to, from, navigationStore)
  const stackPageTransitionName = resolveStackPageTransitionName(routeTransitionName, to, from, navigationStore)

  applyMainTabLayerVisibility(routeTransitionName, to, from, navigationStore)
  syncKeepAliveCache(routeTransitionName, to, from, navigationStore)

  navigationStore.setRouteTransition(routeTransitionName)
  navigationStore.setStackPageTransitionName(stackPageTransitionName)
  return true
})
```

### 4.1 legacy tab path 重定向

历史书签如 `/home`、`/profile` 应重定向到 AppShell，并清理应用内栈：

```javascript
const LEGACY_TAB_PATHS = { '/home': 'Home', '/profile': 'Profile' }

router.beforeEach((to) => {
  const legacyTab = LEGACY_TAB_PATHS[to.path]
  if (legacyTab) {
    navigationStore.setActivatedTab(legacyTab)
    navigationStore.resetStack()
    return { path: '/', replace: true }
  }
})
```

## 5. 与浏览器 back 的关系

replace 导航的设计目标是：**应用内返回不要依赖浏览器 back。**

| 操作 | 推荐实现 |
|------|----------|
| 顶栏返回 | `goBack()` |
| 悬浮返回按钮 | `goBack()` |
| 业务完成回首页 | `closeStack()` |
| Android 物理返回 / 浏览器 back | 可选监听后转为 `goBack()`，但不要作为主返回链 |
| 微信底部前进/后退 | 通过 `router.replace()` 避免 history 增长，从源头减少出现 |

## 6. 与 keep-alive 的关系

replace 导航下，`from` / `to` 仍然正常进入 router guard，因此 keep-alive 仍可按转场语义工作：

```javascript
function syncKeepAliveCache(routeTransitionName, to, from, navigationStore) {
  const isBack = routeTransitionName === 'slide-left'
  if (isBack) return

  if (from.meta?.keepAlive && from.name && from.name !== 'AppShell') {
    navigationStore.addCachedRouteName(from.name)
  }
}
```

注意：

- 不要用浏览器 history length 判断前进/后退；replace 导航下它不可靠。
- 用 `routeTransitionName` / `stackHistory` 表达导航语义。
- 压栈动作由 `openStackPage()` 显式触发，普通 `router.replace()` 不应偷偷压栈。

## 7. 与业务回调的关系

扫码、选图等全屏能力组件化后，成功/取消通常不需要压栈：

- 当前页弹出组件：不改 URL，不改 `stackHistory`；
- 成功后如需进结果页：调用方 `openStackPage({ path: '/scan-result', query })`；
- 取消：只关闭组件。

旧中间路由兼容壳如果仍要回填业务页，可用 `peekStackEntry()` / `popStackEntry()`，但新业务不建议继续扩展这种模式。

## 8. React 映射

React Router 同样可使用 replace 导航：

```tsx
function openStackPage(to: To) {
  setPendingStackPush(snapshotLocation(location))
  navigate(to, { replace: true })
}

function goBack() {
  setOverrideTransition('slide-left')
  const prev = popStackEntry()
  navigate(prev ?? '/', { replace: true })
}
```

状态可放在 Zustand / Redux / context。`afterEach` 可用监听 location 变化的 effect + navigation result 封装实现；关键仍是「pending 成功后提交」。

## 9. 检查清单

- [ ] 应用内子页跳转是否统一走 `openStackPage()`？
- [ ] `openStackPage()` 是否先写 `pendingStackPush`，再 `router.replace()`？
- [ ] `router.afterEach` 是否在成功后 `commitPendingStackPush()`，失败时清理 pending？
- [ ] `goBack()` 是否 `popStackEntry()` 后 `router.replace(prev ?? '/')`？
- [ ] `closeStack()` 是否 `resetStack()` 后 replace 回 AppShell？
- [ ] 是否避免裸用 `router.push()` / `router.go(-1)` 作为应用内主导航？
- [ ] legacy tab path 是否 replace 到 `/` 并 resetStack？
- [ ] keep-alive 是否不依赖浏览器 history，而用 routeTransitionName/from.meta 判断？
- [ ] 滚动恢复是否使用 store 记录，而不是只依赖 `route.meta`？
