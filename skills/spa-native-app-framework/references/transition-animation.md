# Stack transition animation（通用规范）

本文件为 [SKILL.md](../SKILL.md) 的补充。新项目 **必须** 按此规范实现子页转场 CSS，与路由守卫写入的 `routeTransitionName` 严格一致。

可复制文件：

- 转场 keyframes：[../assets/page-transition.template.scss](../assets/page-transition.template.scss)
- 页面根绝对定位：[../assets/stack-page-layout.template.scss](../assets/stack-page-layout.template.scss)

## 1. 双层 transition 分工（参考壳层）

子页叠层推荐 **两层** `<transition :name="routeTransitionName">`，职责不同，**不要合并为一层**：

```vue
<!-- 外层：框架壳 ↔ 子路由叠层的进出场 -->
<transition :name="routeTransitionName">
  <div v-show="isStackOverlayVisible" class="stack-overlay-layer">
    <!-- 内层：叠层内子路由之间的切换（A↔B、列表↔详情） -->
    <transition :name="routeTransitionName">
      <keep-alive :include="cachedRouteNames">
        <router-view />
      </keep-alive>
    </transition>
  </div>
</transition>
```

| 层级 | 触发场景 | 动画对象 | 与缓存的关系 |
|------|----------|----------|--------------|
| **外层** | `AppShell`（`/`）↔ 任意子路由 | 整个 `.stack-overlay-layer` 容器进出场 | 配合 **`v-show`**（非 `v-if`）：离开 Tab 根时仅隐藏叠层，**不销毁**叠层 DOM；高频子页在 `keep-alive` 内保留实例，避免每次从 Tab 进入都重新挂载整条子栈 |
| **内层** | 子路由 ↔ 子路由（压栈/出栈） | `router-view` 渲染的页面组件根 | `keep-alive` 缓存列表等；`transition` 并行 enter/leave 产生两页滑动 |

`isStackOverlayVisible` 通常为 `$route.path !== '/'`。

外层用 `v-show` 的原因：从 Tab 再次进入同一子路由时，叠层容器与已缓存子页可快速恢复；`v-if` 会拆掉整棵子栈 DOM，与「高频子页」体验相悖。

## 2. 动画期间路由根节点必须脱离文档流（关键）

并行 enter/leave 时，**约 0.5s 内 DOM 上同时存在两个路由页面根节点**。若二者为默认文档流（`position: static`），会上下叠摞，**无法**形成横向「两页并列滑动」。

### 2.1 推荐（更通用）：在转场 class 上设 `absolute`

内层 `<transition :name="routeTransitionName">`（包 `router-view` 的那层）在动画进行时会为路由组件根节点挂上 `{name}-enter-active` / `{name}-leave-active`。**直接在转场 SCSS 中统一绝对定位**，不依赖每个页面是否写了 `.bg-html`：

```scss
// 已写入 page-transition.template.scss
.slide-left-enter-active,
.slide-left-leave-active,
.slide-right-enter-active,
.slide-right-leave-active {
  position: absolute !important;
  top: 0;
  left: 0;
  right: 0;
  width: 100%;
  min-height: 100%;
}
```

- 作用于 **router-view 输出的组件根元素**（transition 的直接动画目标）
- `!important` 用于压过页面内其它 `position` 定义，**仅在动画类存续期间**生效
- 动画结束后 class 移除，布局回到页面自身样式

**父级前提：** `.stack-overlay-layer` 为 `position:absolute; height:100%; overflow:hidden`，作为绝对定位 containing block。

### 2.2 补充（非动画态布局 / 滚动）

转场 class 只覆盖约 0.5s；页面**常态**仍建议顶层包裹绝对定位或满高，以统一滚动与叠层布局（尤其 Tab 内 `.bg-common` 为 `relative`、叠层内为 `absolute` 的区分）：

```scss
.stack-overlay-layer {
  .page-root, .bg-html {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    overflow-y: auto;
    transform: translate3d(0, 0, 0);
  }
}
```

模板：[../assets/stack-page-layout.template.scss](../assets/stack-page-layout.template.scss)  
参考（hiking）：`src/styles/base.scss` `.sub-page .bg-html` / `.bg-common`

**二者关系：** §2.1 保证**任意**子路由在切换动画中可并列横滑；§2.2 保证静止时滚动区域与壳层一致。可只用 §2.1，但生产项目常两者并存。

## 3. 类名与 keyframes 契约（严格）

Vue 2 会根据 `name` 自动加 `{name}-enter`、`{name}-enter-active`、`{name}-leave-active` 等类：

| `routeTransitionName` | enter 初始类 | enter-active | leave-active | 离开终点 |
|----------------------|--------------|--------------|--------------|----------|
| `slide-left` | `opacity:0; translate3d(-100%,0,0)` | `slideInLeft` **0.5s** | `slideOutRight` **0.5s** | `translate3d(100%,0,0)` + `visibility:hidden` |
| `slide-right` | `opacity:0; translate3d(100%,0,0)` | `slideInRight` **0.5s** | `slideOutLeft` **0.5s** | `translate3d(-100%,0,0)` + `visibility:hidden` |

统一：**`translate3d`** + **`0.5s`**。完整 keyframes 见 [page-transition.template.scss](../assets/page-transition.template.scss)。

### 导航语义

| 用户操作 | `routeTransitionName` |
|----------|----------------------|
| 压栈 A→B | `slide-right` |
| 出栈 B→A | `slide-left` |
| 特殊全屏页退出 | `fade`（可选） |

## 4. 守卫如何设定 `routeTransitionName`

```javascript
if (overrideTransitionName) {
  transition = overrideTransitionName
  clearOverrideTransition()
} else if (to.name === 'AppShell') {
  transition = 'slide-left'
} else if (from.name === 'AppShell') {
  transition = 'slide-right'
} else {
  transition = 'slide-right'
}
```

- `goBack()` 必须先 `setOverrideTransition('slide-left')` 再 `router.go(-1)`
- `slide-right` 且 from 子页 → `addCachedRouteName(from.name)`

## 5. 为何看到「两个页面并列滑动」

```mermaid
sequenceDiagram
  participant Outer as outerTransition
  participant Inner as innerTransition
  participant PageA
  participant PageB

  Note over Outer: 仅 AppShell↔子路由时动画叠层容器
  Inner->>PageA: slide-right-leave-active
  Inner->>PageB: slide-right-enter-active
  Note over PageA,PageB: 两棵 absolute 页面根并行 translate3d
  Inner->>PageA: leave 结束移除 A 的过渡 DOM
```

- 内层 `<transition>` 默认**并行** enter/leave
- `keep-alive` 保留离开页实例；过渡 DOM 由 transition 管理
- **页面根 `absolute`** 是两页同屏横滑的前提（见 §2）

## 6. fade 扩展

```scss
.fade-enter-active, .fade-leave-active { transition: opacity 0.5s; }
.fade-enter, .fade-leave-active { opacity: 0; }
```

## 7. React 映射

- 双层：外层 AnimatePresence 控制 stack 显隐；内层控制 route 切换
- 每个 stack 页面根：`position: absolute; inset: 0`
- `framer-motion` 并行 exit/enter 模拟 slide-left/right
