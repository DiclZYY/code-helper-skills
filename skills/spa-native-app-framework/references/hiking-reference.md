# Reference: hiking appvue 对照

本文件为 [SKILL.md](../SKILL.md) 的补充。实现 hiking 或类似项目时查阅。

## 通用规范映射（优先读通用文档）

| 通用文档 | hiking 对应文件 |
|----------|----------------|
| [transition-animation.md](transition-animation.md) | `src/styles/page_animation.scss` ≈ [page-transition.template.scss](../assets/page-transition.template.scss)；`src/styles/base.scss` `.sub-page .bg-html` ≈ [stack-page-layout.template.scss](../assets/stack-page-layout.template.scss) |
| [scroll-restore-and-keepalive.md](scroll-restore-and-keepalive.md) | `src/utils/mixin.js`（globalMixin + tabPullList）、`src/utils/router-guard.js`、`src/store/modules/router.js` |

## 文件索引

| 文件 | 职责 |
|------|------|
| `src/App.vue` | 双层壳：`main-page` + `sub-page`，Tab 与 `router-view` |
| `src/router.js` | 路由表、`defaultCachedRouteNames`（导出为 `routerName`）、`meta.nl` |
| `src/utils/router-guard.js` | 鉴权、转场计算、keep-alive 动态添加、主层隐藏 |
| `src/store/modules/app.js` | `pageTransition`、`firstTransition` |
| `src/store/modules/router.js` | 动态 `cached` 数组 |
| `src/store/getters.js` | `pageTransition`、`cachedRoutes` |
| `src/styles/page_animation.scss` | `slide-left` / `slide-right`（规范源） |
| `src/styles/my-mint.scss` | `fade` 过渡 |
| `src/utils/mixin.js` | `goBack()`、`globalMixin` 滚动恢复、`tabPullList` |

## Legacy 命名 → 语义化命名

hiking 现有代码使用旧名；新代码或重构时采用 skill 推荐名：

| Legacy (hiking) | 语义化 (推荐) | 位置 |
|-----------------|---------------|------|
| `selected` | `activatedTab` | App.vue data |
| `pageTransition` | `routeTransitionName` | vuex app + getters |
| `firstTransition` | `overrideTransitionName` | vuex app |
| `setFirstTransion` | `setOverrideTransition` | vuex action（修正拼写） |
| `cachedRoutes` | `cachedRouteNames` | getters / keep-alive include |
| `routerName` | `defaultCachedRouteNames` | router.js export |
| `subTransition` | `isStackToStackNavigation` | App.vue data（路由 watch） |
| `show-sub-page` class | `main-tab-layer--hidden` | CSS + guard |
| `meta.nl` | `meta.requiresLogin` | router.js |

## 路由表结构（hiking）

```text
/                    name: App          → AppShell 占位，Tab 由 App.vue 渲染
/map, /home, /me     → 历史/独立入口（Tab 本身不走这些 URL）
/footpathSelect...   → Home 模块子页
/login, /register    → 公开
/change, /record...  → meta.nl: true 需登录
```

注释约定（router.js L8-9）：

> `meta.nl`（needLogin）为 true 表示需登录；未定义则公开。

迁移建议：逐步改为 `meta.requiresLogin`，守卫判断同步更新。

## 鉴权守卫逻辑（hiking）

```javascript
// router-guard.js L15-30 语义化改写
if (to.meta?.requiresLogin && !store.getters.token) {
  const confirmed = await showLoginConfirm()
  if (confirmed) router.push({ path: '/login' })
  return // 必须 return，否则未登录仍进入目标页
}
```

React 等价：`ProtectedRoute` 或 React Router 6 `loader` 内检查 session。

## 转场决策表（自 router-guard.js）

| 条件 | `routeTransitionName` | 用户感知 |
|------|----------------------|----------|
| `!override` && `to.name === 'App'` && `from.name !== 'Map'` | **`slide-left`** | **回到主页**（路径 A） |
| `!override` && `from.name === 'App'` | **`slide-right`** | 压栈 |
| `!override` && 其他子页间 | **`slide-right`** | 子页前进 |
| `!override` && Map 相关 | 常未赋值；`to Map && query.id>0` → `slide-right` | 地图特例 |
| `override` 且 `from Map` → `App` | **`fade`**（覆盖 override 的 slide-left） | 地图退出主页 |
| `goBack()` 先设 override | **`slide-left`**（路径 B） | 主动返回 |

### 回到主页 vs 压栈（CSS 对照）

| 名称 | enter | leave | 场景 |
|------|-------|-------|------|
| `slide-left` | `slideInLeft`（自左 -100% 入） | `slideOutRight`（向右 100% 出） | 子页 → AppShell |
| `slide-right` | `slideInRight`（自右 100% 入） | `slideOutLeft`（向左 -100% 出） | AppShell → 子页 |

路径 B：`mixin.js` `goBack()` → `setFirstTransion('slide-left')` → `router.go(-1)`。

副作用：

- `slide-right` + `from.name === 'App'` → 500ms 后 `.main-page` 加 `show-sub-page`
- `slide-right` + from 为子页 → `keepRouteAlive(from.name)`
- **`slide-left` + `to.name === 'App'`** → 移除 `show-sub-page`（恢复主 Tab 层）

## App.vue 结构要点

```text
.main-page
  mt-tab-container[v-model=selected]   → 改为 activatedTab
    item Map:  <component :is="MapComp" />  → lazyTabComponents.Map
    item Home / Me: 静态组件
  mt-tabbar[v-model=selected]

.sub-page / .stack-overlay-layer
  position absolute; z-index 3; overflow hidden
  overscroll-behavior: contain
  外层 transition + v-show     ← AppShell↔叠层；v-show 保留叠层 DOM，利于高频子页
  内层 transition → keep-alive → router-view   ← 子路由 A↔B
  .sub-page .bg-html / .bg-common → position absolute（并行动画时两页根同坐标系横滑）
```

## keep-alive 默认列表（hiking router.js L12）

`Scheme`, `ServiceList`, `ScenicSpotList`, `FootpathSelect`, `LineList`, `ConsultList`

动态添加：`store/modules/router.js` → `SET_CACHE` / `keepRouteAlive`。

## SCSS 壳层要点（App.vue）

| 选择器 | 关键样式 | 作用 |
|--------|----------|------|
| `#app` / `#app-shell` | `overflow: hidden` | 整页不随内容撑开滚动 |
| `.main-page` / `.main-tab-layer` | `overflow: hidden` | Tab 层不溢出 |
| `.sub-page` / `.stack-overlay-layer` | `overflow: hidden` + **`overscroll-behavior: contain`** | 子页滚到顶/底时不链式带动底层（iOS Safari 支持有限，见 SKILL Optional extensions） |

## SCSS 转场要点

详见 [transition-animation.md](transition-animation.md)。hiking 源文件：`src/styles/page_animation.scss`。

## Example: LineList → LinesDetails

| 步骤 | 行为 |
|------|------|
| 进入详情 | `router-link` → `/linesDetails`；guard `slide-right`；`keepRouteAlive('LineList')` |
| 列表状态 | `LineList` 在 `routerName` 默认缓存；`tabs[].data`、`activeIndex` 由 keep-alive 保留 |
| 滚动 | `tabPullList` 设 `ccmxScrollContainer: '.bg-common.PBottom-none .bar_content'`；离开写 `meta.scrollTop` |
| 返回 | `CcHeader` → `goBack()` → `slide-left` → `activated` 恢复滚动 |

组件 `name: 'LineList'` 必须与路由 `name: 'LineList'` 一致。

## hiking 特有（可选，非框架必需）

| 特性 | 说明 |
|------|------|
| BaiduMobStat | Tab 在 App.vue watch `activatedTab`；子页在 guard |
| Cordova StatusBar | App.vue watch `statusBar`，delay 300ms |
| Map 懒加载 | `activatedTab === 'Map'` 时 `MapComp = Mapview` |
| `meta.nl: false` | 显式标记公开（如 Fault、Feedback） |

## React 项目落地检查单

- [ ] `AppShell` 路由 `/` 不渲染 Tab 内容在 Routes 内
- [ ] `activatedTab` state 与 URL 解耦
- [ ] Stack 路由嵌套在 `stack-overlay-layer` 的 `<Routes>`
- [ ] `requiresLogin` 在 route config 或 wrapper 统一处理
- [ ] 转场状态放 Context，layout 读取 `routeTransitionName`
- [ ] 列表保态：自管 cache 或 `react-activation`，key=routeName

## Vue3 迁移（保证 skill 生效）

### 未删除、逻辑可原样搬移

- 双轨导航、`activatedTab`、`routeTransitionName` / `slide-left` 回主页 / `slide-right` 压栈
- `beforeEach` 内鉴权、`requiresLogin`、`keep-alive`、动态 `cachedRouteNames`
- `goBack()` 先 `setOverrideTransition('slide-left')` 再 `router.back()`

### 破坏性变更（必须改代码，非改设计理念）

| Vue2 写法 | Vue3 要求 |
|-----------|-----------|
| `<transition><router-view/></transition>` | `<router-view v-slot="{ Component, route }">` + `<component :is="Component" :key="route.fullPath">` |
| `router.beforeEach((to,from,next)=>{ next() })` | 优先 `return true \| false \| { path }`（Vue Router 4） |
| SFC 仅 `<script setup>` 无 name | `defineOptions({ name: 'RouteName' })` 否则 `include` 失效 |
| `new Vue({ router, store })` | `createApp().use(router).use(pinia)` |

### Vue3 仍可用但与 Vue2 行为差异

- **Transition**：类名规则与 Vue2 的 `name` 模式兼容；单根子节点要求更严，用 `:key="route.fullPath"` 避免复用错误实例。
- **keep-alive**：与 `<component :is>` 联用；max、exclude、include 均保留。
- **Teleport / Fragment**：叠层 `stack-overlay-layer` 仍建议单根 div，不要把 transition 直接包在 Fragment 上。

### 已删除 API（本 shell 不应依赖）

`$on`/`$off`、`$children`、`filters`、inline-template、`.native` 修饰符（Vue3 合并进 attrs）。

### React Router 6

仍推荐「Tab 非路由 + overlay Routes」；layout route 嵌套易导致双 outlet，与 Vue 壳层同构即可。
