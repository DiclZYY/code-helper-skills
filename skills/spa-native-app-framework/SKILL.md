---
name: spa-native-app-framework
description: >-
  Designs SPA shells mimicking native apps: tab shell + stack overlay, stack
  transition CSS (slide-left/right per page_animation spec), scroll restore on
  pop, dynamic keep-alive when pushing A to B. Route guards, auth meta.
  Vue2/Vue3 and React. Use for mobile-like SPA, list-detail navigation, Cordova/H5.
---

# SPA Native App Framework

框架无关的「Web SPA 模拟原生 App」整体设计。Vue2 为参考实现；**Vue3** 见 [Vue3 兼容性](#vue3-兼容性)；React 见各节的 **React 映射**。

- 通用机制详解：[references/transition-animation.md](references/transition-animation.md)、[references/scroll-restore-and-keepalive.md](references/scroll-restore-and-keepalive.md)
- hiking 样例对照：[references/hiking-reference.md](references/hiking-reference.md)
- 可复制 SCSS：[assets/page-transition.template.scss](assets/page-transition.template.scss)、[assets/stack-page-layout.template.scss](assets/stack-page-layout.template.scss)

## When to use

**适用：**

- 底部 Tab 主页 + Push 子页（详情、表单、设置）
- 需要 slide 转场、返回保留列表滚动/状态
- 混合应用（Cordova / Capacitor）全屏壳层
- 路由表需区分公开页与需登录页

**不适用：**

- 纯后台管理、无 Tab 的单栈站点
- 每个 Tab 独立 URL 且需 SEO 的站点（宜用多入口或 SSR）

## Core pattern

```mermaid
flowchart TB
  subgraph shell ["AppShell 全屏根"]
    mainTabLayer["MainTabLayer 主 Tab 层"]
    stackOverlayLayer["StackOverlayLayer 子页叠层 absolute z-index 高"]
  end
  mainTabLayer --> tabState["activatedTab 本地状态 非路由"]
  mainTabLayer --> tabBar["TabBar"]
  stackOverlayLayer --> routeOutlet["Router Outlet + Transition"]
  navGuard["Navigation Guard"] --> transitionStore["routeTransitionName + stackPageTransitionName"]
  transitionStore --> routeOutlet
  pushNav["navigate 子路由"] --> stackOverlayLayer
  tabNav["切换 activatedTab"] --> mainTabLayer
```

### 双轨导航

| 层 | 职责 | 导航方式 |
|----|------|----------|
| **MainTabLayer** | 3~5 个 Tab 根视图常驻 | `activatedTab`，**不**改 URL |
| **StackOverlayLayer** | 详情/表单等子页 | 路由器 `push` / `pop`，URL 反映子页 |

根路由仅占位：`{ path: '/', name: 'AppShell' }`。子页叠层在 `pathname !== '/'`（或等价条件）时显示。

### 语义化命名约定

实现时统一使用下列名称（勿用 `selected`、`nl` 等缩写）：

| 概念 | 推荐名称 | 避免 |
|------|----------|------|
| 当前激活的 Tab id | `activatedTab` | `selected`, `tab` |
| 子页叠层是否可见 | `isStackOverlayVisible` | 仅靠隐式路由 |
| 路由转场 CSS 名（外层叠层） | `routeTransitionName` | `pageTransition` |
| 栈内 router-view 转场名（内层） | `stackPageTransitionName` | 与外层共用同名 |
| 一次性覆盖转场 | `overrideTransitionName` | `firstTransition` |
| keep-alive 路由名列表 | `cachedRouteNames` | `cachedRoutes` |
| 主 Tab 层是否隐藏 | `isMainTabLayerHidden` | `show-sub-page` 类名可保留为 CSS |
| 懒加载 Tab 组件表 | `lazyTabComponents` | `MapComp` |
| 路由需登录 | `meta.requiresLogin` | `nl`, `needLogin` 缩写 |
| 是否子页间切换 | `isStackToStackNavigation` | `subTransition` |

## Implementation checklist

### 1. 路由表（Route table）

```javascript
// 默认缓存的列表页（组件名 === 路由 name）
export const defaultCachedRouteNames = ['ProductList', 'OrderList']

export const routes = [
  // 壳层占位：不渲染 Tab 内容，仅标记「在主页」
  { path: '/', name: 'AppShell' },

  // 公开子页
  { path: '/login', name: 'Login', component: () => import('./pages/Login') },
  { path: '/product/:id', name: 'ProductDetail', component: () => import('./pages/ProductDetail') },

  // 需登录子页 — meta.requiresLogin: true
  { path: '/profile', name: 'Profile', component: () => import('./pages/Profile'),
    meta: { requiresLogin: true } },
  { path: '/orders', name: 'OrderList', component: () => import('./pages/OrderList'),
    meta: { requiresLogin: true } },
]
```

规则：

- `AppShell` 路由无 component 或空组件，Tab 内容由 App 壳直接挂载
- 子页路由 **不要** 与 Tab id 混用同一路径
- 列表页需要返回保态：加入 `defaultCachedRouteNames`，且 **组件 `name` 与路由 `name` 一致**

### 2. 导航守卫（Auth + transition + cache）

守卫顺序建议：

1. **鉴权**：`requiresLogin` 且无 token → 弹窗/跳转登录，`return` 阻断
2. **转场名**：计算 `routeTransitionName`（外层）与 `stackPageTransitionName`（内层，见 [双层 transition 分工](#双层-transition-分工)）；`overrideTransitionName` 优先且用后清空
3. **叠层 DOM**：前进时延迟隐藏 MainTabLayer；返回 AppShell 时恢复
4. **动态缓存**：`slide-right` 且 from 非 AppShell → `addCachedRouteName(from.name)`
5. `next()` / `return true` 前将两个转场名写入全局状态供壳层 `<transition>` 使用

```javascript
// Vue Router 2 — 鉴权片段（语义化 meta）
router.beforeEach(async (to, from, next) => {
  const isAuthenticated = !!store.getters.authToken

  if (to.meta?.requiresLogin && !isAuthenticated) {
    const goLogin = await confirmLoginDialog() // 项目 UI
    if (goLogin) router.push({ path: '/login' })
    return // 阻断导航
  }

  let routeTransitionName = store.state.overrideTransitionName
  if (!routeTransitionName) {
    if (to.name === 'AppShell') routeTransitionName = 'slide-left'
    else if (from.name === 'AppShell') routeTransitionName = 'slide-right'
    else routeTransitionName = 'slide-right'
  } else {
    store.commit('CLEAR_OVERRIDE_TRANSITION')
  }

  applyMainTabLayerVisibility(routeTransitionName, to, from)
  if (routeTransitionName === 'slide-right' && from.name && from.name !== 'AppShell') {
    store.dispatch('addCachedRouteName', from.name)
  }

  store.commit('SET_ROUTE_TRANSITION', routeTransitionName)
  store.commit('SET_STACK_PAGE_TRANSITION', resolveStackPageTransitionName(routeTransitionName, to, from))
  next()
})

function resolveStackPageTransitionName(routeTransitionName, to, from) {
  if (from.name === 'AppShell') return ''   // 压栈：内层无动画，避免与外层双重 slide
  if (to.name === 'AppShell') return 'fade' // 回主页：内层淡出，避免内容随外层 slide 瞬间消失
  return routeTransitionName                 // 栈内 A↔B：内层 slide
}
```

**React 映射：** `react-router` v6 用 `<BrowserRouter>` + 自定义 `useNavigationGuard` 或在 layout 内 `useEffect` 监听 `location`；鉴权用 `<ProtectedRoute requiresLogin />` 或 loader 内 `redirect('/login')`。转场用 `framer-motion` 的 `AnimatePresence` + 全局 context 存 `routeTransitionName`。

### 3. App 壳模板（Vue2）

Tab UI 可替换 Mint UI / Vant / 自研；结构不变。

```vue
<template>
  <div id="app-shell">
    <!-- MainTabLayer -->
    <div class="main-tab-layer" :class="{ 'main-tab-layer--hidden': isMainTabLayerHidden }">
      <mt-tab-container v-model="activatedTab">
        <mt-tab-container-item id="Home"><home /></mt-tab-container-item>
        <mt-tab-container-item id="Discover"><discover /></mt-tab-container-item>
        <mt-tab-container-item id="Profile"><profile-tab /></mt-tab-container-item>
      </mt-tab-container>
      <mt-tabbar v-model="activatedTab">...</mt-tabbar>
    </div>

    <!-- StackOverlayLayer — 双层 transition，绑定不同 name（见下） -->
    <!-- 外层 routeTransitionName：AppShell ↔ 子叠层 进出场 -->
    <transition :name="routeTransitionName">
      <div v-show="isStackOverlayVisible" class="stack-overlay-layer">
        <!-- 内层 stackPageTransitionName：叠层内子路由 A↔B；与 AppShell 交界时无 slide / fade -->
        <transition :name="stackPageTransitionName">
          <keep-alive :include="cachedRouteNames">
            <router-view />
          </keep-alive>
        </transition>
      </div>
    </transition>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

export default {
  data() {
    return {
      activatedTab: 'Home',
      lazyTabComponents: {} // 按需: lazyTabComponents.Map = MapView
    }
  },
  computed: {
    ...mapGetters(['routeTransitionName', 'stackPageTransitionName', 'cachedRouteNames']),
    isStackOverlayVisible() {
      return this.$route.path !== '/'
    }
  },
  methods: {
  }
}
</script>
```

```scss
#app-shell { width: 100%; height: 100%; overflow: hidden; }
.main-tab-layer { height: 100%; width: 100%; overflow: hidden; }
.main-tab-layer--hidden { display: none; } // 或由守卫在 slide-right 后 500ms 添加
.stack-overlay-layer {
  position: absolute; z-index: 3; top: 0; left: 0; right: 0; height: 100%;
  overflow: hidden;
  overscroll-behavior: contain; // 子页滚到顶/底时不把滚动链传到 body 或 MainTabLayer
}
```

**双层 transition 分工：**

两层 `<transition>` **职责不同，且应绑定不同的 `name`**。若内外层共用同一 `routeTransitionName`，会在 AppShell ↔ 子页边界出现 **双重 slide**（压栈时叠层与页面各滑一次），或回主页时 **内层内容瞬间消失**（外层 slide 时内层无 leave 过渡）。

| 层 | 绑定 | 触发场景 | 动画对象 |
|----|------|----------|----------|
| **外层** | `routeTransitionName` | `AppShell`（`/`）↔ 任意子路由 | 整个 `.stack-overlay-layer` 容器 slide 进出场 |
| **内层** | `stackPageTransitionName` | 叠层 **内部** 子路由切换 | `router-view` 页面组件根 |

**内层 `stackPageTransitionName` 决策（守卫内计算，写入 store）：**

| from | to | `routeTransitionName`（外层） | `stackPageTransitionName`（内层） | 用户感知 |
|------|-----|------------------------------|-----------------------------------|----------|
| `AppShell` | 子页 | `slide-right` | `''`（空，无动画） | 仅叠层自右滑入，页面内容随容器同步出现 |
| 子页 | `AppShell` | `slide-left` | `fade` | 叠层向右滑出；内层子页 **opacity 淡出**，避免内容硬切 |
| 子页 | 子页 | `slide-right` / `slide-left` | 同外层 slide 名 | 栈内两页并行横滑 |
| 任意 | 任意 | `overrideTransitionName` | 按上表规则派生 | `goBack()` 仍先设 `slide-left` |

```javascript
function resolveStackPageTransitionName(routeTransitionName, to, from) {
  if (from.name === 'AppShell') return ''
  if (to.name === 'AppShell') return 'fade'
  return routeTransitionName
}
```

Vue 3 中 `name` 为空字符串时 Transition **不应用**命名 class（等价于无动画）。`fade` 时长与 slide 一致（0.5s），与外层并行。

外层配合 **`v-show`**（勿用 `v-if`）：回到 `/` 时仅隐藏叠层，保留 DOM，配合 `keep-alive` 避免高频子页每次从 Tab 进入都整栈重载。

**动画期间路由根绝对定位（转场必备）：** 内层并行 enter/leave 时两棵页面根须同坐标系横滑。推荐在转场 SCSS 为 `{name}-enter-active` / `{name}-leave-active` 设 `position: absolute !important`（已写入 [page-transition.template.scss](assets/page-transition.template.scss)），对任意 `router-view` 根生效；常态布局可另见 [stack-page-layout.template.scss](assets/stack-page-layout.template.scss)。

**叠层滚动隔离：** `overflow: hidden` + `overscroll-behavior: contain`（iOS 支持有限，见 Optional extensions）。

**React 映射：**

```tsx
// AppShell.tsx — 概念结构
const [activatedTab, setActivatedTab] = useState('Home')
const { routeTransitionName, cachedRouteNames } = useShellStore()
const location = useLocation()
const isStackOverlayVisible = location.pathname !== '/'

return (
  <div id="app-shell">
    <div className={cn('main-tab-layer', isMainTabLayerHidden && 'main-tab-layer--hidden')}>
      <TabBar activeKey={activatedTab} onChange={setActivatedTab} />
      <TabPanels activeKey={activatedTab}>{/* Home | Discover | Profile */}</TabPanels>
    </div>
    <AnimatePresence mode="wait">
      {isStackOverlayVisible && (
        <motion.div className="stack-overlay-layer" /* variants from routeTransitionName */>
          <Routes>{/* stack routes */}</Routes>
        </motion.div>
      )}
    </AnimatePresence>
  </div>
)
```

### 4. 全局状态（Vuex 示例）

```javascript
// store/modules/navigation.js
const state = {
  routeTransitionName: 'fade',
  stackPageTransitionName: '',
  overrideTransitionName: null,
  cachedRouteNames: [...defaultCachedRouteNames]
}
// actions: setRouteTransition, setStackPageTransitionName, setOverrideTransition(clear after use)
// actions: addCachedRouteName, removeCachedRouteName
```

### 5. 返回与前进 API

```javascript
// mixin / composable: useStackNavigation
function goBack(shouldRefreshOnBack = false) {
  store.dispatch('setOverrideTransition', 'slide-left')
  if (shouldRefreshOnBack) store.dispatch('setRefreshOnBack', true)
  router.go(-1)
}

function openStackPage(path) {
  router.push(path) // 守卫自动 slide-right
}
```

**React：** `useNavigate(-1)` 前 `setOverrideTransition('slide-left')`。

### 6. 转场 CSS

**必须** 引入 [assets/page-transition.template.scss](assets/page-transition.template.scss)（或等效实现），类名/时长/translate 与 [references/transition-animation.md](references/transition-animation.md) 一致。禁止自造 transition 名或改 enter/leave 方向。

## 子栈导航三大机制（通用）

子页 A↔B 除壳层与守卫外，框架级能力如下（实现任一 SPA 栈导航时 **三项齐备**）。

### 机制一：转场动画（`routeTransitionName` + `stackPageTransitionName` + SCSS）

| 导航 | 外层 `routeTransitionName` | 内层 `stackPageTransitionName` | 用户感知 |
|------|---------------------------|-------------------------------|----------|
| 压栈 AppShell→B | `slide-right` | `''` | 叠层自右入；内层无二次 slide |
| 出栈 B→AppShell | `slide-left` | `fade` | 叠层向右出；子页淡出 |
| 栈内 A→B | `slide-right` | `slide-right` | 两页并行横滑 |
| 栈内 B→A | `slide-left` | `slide-left` | 两页并行横滑 |

- 守卫写入 store → 壳层 **外层** `:name="routeTransitionName"`、**内层** `:name="stackPageTransitionName"`
- **内层**栈间切换：并行 enter+leave + 转场 class 上 `position:absolute !important` → 约 0.5s 两页同坐标系横滑
- 返回务必 `goBack()`：`setOverrideTransition('slide-left')` 再 `router.go(-1)`，否则 B→A 可能误用 `slide-right`

详表、keyframes、双页并列原理：[references/transition-animation.md](references/transition-animation.md)

### 机制二：动态 keep-alive（A→B 缓存 A）

1. `defaultCachedRouteNames` 初始化 `cachedRouteNames`
2. 压栈且 `from.name !== 'AppShell'` → `addCachedRouteName(from.name)`
3. `<keep-alive :include="cachedRouteNames">`；组件 `name` === 路由 `name`
4. 返回时 A 走 `activated`，不重建列表 data / Tab

详流程：[references/scroll-restore-and-keepalive.md](references/scroll-restore-and-keepalive.md#1-动态-keep-aliveab-时缓存-a)

### 机制三：滚动位置恢复（B→A）

1. **离开 A**：`beforeRouteLeave` 将 `scrollContainerSelector` 对应元素的 `scrollTop` 写入 `from.meta.scrollTop`（列表页常非默认选择器）
2. **回到 A**：`activated` 中在 `cachedRouteNames` 含 A 且非刷新时写回 `scrollTop`，然后清零 meta
3. 与 keep-alive 正交：数据靠实例缓存，滚动靠 meta

详流程与 mixin 骨架：[references/scroll-restore-and-keepalive.md](references/scroll-restore-and-keepalive.md#2-滚动位置恢复ba)

### 守卫决策简表

| from | to | `routeTransitionName`（外层） | `stackPageTransitionName`（内层） |
|------|-----|------------------------------|-----------------------------------|
| `AppShell` | 子页 | `slide-right` | `''` |
| 子页 | 子页 | `slide-right`（压栈默认） | `slide-right` |
| 子页 | `AppShell` | `slide-left` | `fade` |
| 任意 | 任意 | `overrideTransitionName` | 按 `resolveStackPageTransitionName` 派生 |

压栈：`slide-right` + from 子页 → `addCachedRouteName(from.name)`；+ from AppShell → 延迟隐藏 MainTabLayer。

## Keep-alive contract（摘要）

1. `include` 项为路由 **name** 字符串；组件 `name` 必须一致
2. **A→B 压栈** 时动态 `addCachedRouteName(from.name)`（见机制二）
3. `defaultCachedRouteNames` 不可被 `removeCachedRouteName` 移除
4. React：`react-activation` 或自管 cache Map

## Auth route design

| meta | 含义 |
|------|------|
| `requiresLogin: true` | 无 token 阻断，引导登录 |
| `requiresLogin: false` | 显式公开（可选，与未定义同效） |
| 未定义 | 公开访问 |

登录成功后跳回 `redirect` query 或默认 `AppShell`。

**React ProtectedRoute 骨架：**

```tsx
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const token = useAuthToken()
  const location = useLocation()
  if (!token) return <Navigate to="/login" state={{ from: location }} replace />
  return <>{children}</>
}
```

## Anti-patterns

- 内外层 `<transition>` 共用同一 `routeTransitionName` → AppShell 边界双重 slide 或回主页内容硬切
- 用 `/home`、`/me` 路由驱动 Tab 切换 → Tab 状态丢失、转场错乱
- Tab 页与子页共用同一路由 name
- `include` 与组件 `name` 不一致导致缓存失效
- 守卫未 `return` 阻断未登录导航
- 仅在子组件内算转场、壳层无统一 `routeTransitionName`
- React 中在 Tab 层再套一层 `<Routes>` 导致双 outlet 竞争

## Optional extensions

- **子页滚动穿透（尤其 iOS）**：叠层必备 `overscroll-behavior: contain`；子页内容区单独 `overflow-y: auto` + 固定高度；iOS 可试 `overscroll-behavior-y: none`、滚动容器全屏 fixed，或边界 `touchmove` 条件 `preventDefault`
- **重 Tab 懒加载**：首次 `activatedTab === 'Map'` 再赋值 `lazyTabComponents.Map`
- **右滑返回**：触摸结束后 `setOverrideTransition('slide-left')` + `goBack()`
- **安全区 TabBar**：`padding-bottom: env(safe-area-inset-bottom)`
- **状态栏**：壳层 watch `statusBarTheme`，转场 delay 300ms 再改原生 StatusBar
- **统计**：Tab 切换手动上报；子页在守卫 `onPageStart/End`

## Vue3 兼容性

本模式依赖的能力在 Vue3 **均未删除**，但用法有破坏性变更。按下列对照改造后，skill 中的守卫、命名、双轨导航逻辑**可直接复用**。

### 仍可用（语义不变）

| 能力 | Vue2 | Vue3 |
|------|------|------|
| `<keep-alive :include="string[]">` | ✓ | ✓ |
| `<transition :name="routeTransitionName">` | ✓ | ✓（需配合 `key` / 动态组件） |
| 全局 `beforeEach` 写 `routeTransitionName` | Vue Router 3 | Vue Router 4（返回值风格见下） |
| 组件 `name` 供 include 匹配 | `export default { name }` | `<script setup>` 需 `defineOptions({ name })`（3.3+） |
| Vuex 存转场状态 | ✓ | Vuex 4 或 **Pinia**（推荐新项目） |

### 必须改写的点

**1. `<router-view>` 不能单独作为 `<transition>` 的直接子节点**

Vue3 中异步路由组件需通过 slot 取出再包 transition + keep-alive：

```vue
<!-- StackOverlayLayer — Vue3 / Vue Router 4 -->
<transition :name="routeTransitionName">
  <div v-show="isStackOverlayVisible" class="stack-overlay-layer">
    <router-view v-slot="{ Component, route }">
      <transition :name="stackPageTransitionName">
        <keep-alive :include="cachedRouteNames">
          <component
            :is="Component"
            v-if="Component"
            :key="route.name ?? route.path"
            class="stack-page"
          />
        </keep-alive>
      </transition>
    </router-view>
  </div>
</transition>
```

双层 `<transition>` 在 Vue3 保留：**外层** `routeTransitionName` 管叠层容器；**内层** `stackPageTransitionName` 管栈内路由切换（与 AppShell 交界时为空或 `fade`，见 [双层 transition 分工](#双层-transition-分工)）。内层必须 `v-slot` + `<component :is>` + `:key`。

**2. Vue Router 4 导航守卫**

`next()` 在 Vue Router 4 中已标记废弃，推荐：

```javascript
router.beforeEach(async (to, from) => {
  if (to.meta?.requiresLogin && !authToken.value) {
    const ok = await confirmLogin()
    return ok ? { path: '/login' } : false  // false = 取消导航
  }
  const routeTransitionName = resolveTransition(to, from)
  const stackPageTransitionName = resolveStackPageTransitionName(routeTransitionName, to, from)
  navigationStore.setRouteTransition(routeTransitionName)
  navigationStore.setStackPageTransitionName(stackPageTransitionName)
  applyMainTabLayerVisibility(routeTransitionName, to, from)
  return true
})
```

返回主页时仍设 `slide-left`；`goBack()` 仍先 `setOverrideTransition('slide-left')` 再 `router.back()`。

**3. `<script setup>` 与 keep-alive `include`**

Vue3 单文件组件默认无 `name`，`:include="['OrderList']"` 不生效。任选其一：

```javascript
// Vue 3.3+
defineOptions({ name: 'OrderList' })
```

或对列表页保留 Options API 的 `name` 字段。`<script setup>` 下**没有** Vue2 的隐式 name 推断。

**4. 已移除、与本模式无关的 Vue2 API**

以下删除**不影响**本 shell 设计：`$on`/`$off`、`filters`、`.sync`（改用 `v-model:prop`）、`$children`。不要在这些已删 API 上构建 Tab/栈导航。

**5. UI 与入口**

- Mint UI `mt-tab-container` 面向 Vue2；Vue3 项目用 Vant 4、NutUI 等，**只替换 Tab 组件**，`activatedTab` + 双轨导航不变。
- 应用入口：`createApp(App).use(router).use(pinia).mount('#app')`。

### Vue2 → Vue3 壳层对照

| 项目 | Vue2 | Vue3 |
|------|------|------|
| 叠层 router-view | `<keep-alive><router-view/></keep-alive>` | `v-slot` + `<component :is>` + `:key` |
| 双层 transition | 外 `routeTransitionName` / 内 `stackPageTransitionName` | 相同 |
| 守卫 | `next()` | `return true / false / route` |
| 状态 | Vuex 3 | Pinia 或 Vuex 4 |
| 返回动画 | `setOverrideTransition('slide-left')` | 相同 |
| 回到主页 | 外 `slide-left` + 内 `fade` | 相同 |

## Vue → React quick map

| Vue2 / Vue3 | React |
|------|-------|
| `activatedTab` + Tab 容器 | `useState` + Tab UI 库 |
| `router-view` / `v-slot` in overlay | `<Routes>` in overlay `div` |
| `keep-alive :include` | cache Map / `react-activation` |
| `router.beforeEach` | `ProtectedRoute` + layout `useEffect` |
| Vuex/Pinia `routeTransitionName` + `stackPageTransitionName` | Context / Zustand |
| `<transition :name>` | `framer-motion` / `react-transition-group` |
| `meta.requiresLogin` | route handle `requiresAuth` 或 wrapper |
| 回到主页 `slide-left` | 同上命名，exit 动画向右滑出 |

## Additional resources

- [references/transition-animation.md](references/transition-animation.md) — 转场 CSS 规范、双页滑动原理、守卫设定
- [references/scroll-restore-and-keepalive.md](references/scroll-restore-and-keepalive.md) — 动态 keep-alive、滚动恢复、检查清单
- [assets/page-transition.template.scss](assets/page-transition.template.scss) — slide keyframes
- [assets/stack-page-layout.template.scss](assets/stack-page-layout.template.scss) — 叠层内页面根 absolute 布局
- [references/hiking-reference.md](references/hiking-reference.md) — hiking 样例、legacy 命名、LineList 案例
