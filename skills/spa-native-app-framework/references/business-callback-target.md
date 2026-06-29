# Business callback target（业务结果回跳与全屏能力组件）

本文件为 [SKILL.md](../SKILL.md) 的补充，用于沉淀「扫码 / 选图 / 选人 / 地图选点 / 文件选择」等业务能力的回调模式。核心原则：**能力组件只负责采集结果，业务页面决定结果用途**。

## 1. 为什么不要把扫码做成中间路由

H5 SPA 常见反模式：所有扫码入口都 `push('/scan')`，扫码页再根据来源决定：

- 回退到上一个业务页并带回 query；
- 或跳到 `/scan-result` 展示结果；
- 或在结果页重新扫码后刷新当前页；
- 取消时回到哪个页面。

这会让扫码页同时承担「扫码能力 + 路由编排 + 返回栈修正 + 业务结果分发」四种职责，容易出现：

| 问题 | 表现 |
|------|------|
| 返回栈复杂 | `/scan` 作为中间页进入栈，成功、取消、重新扫码都要手动 pop / replace |
| 业务耦合 | 扫码页需要知道调用方要 query 回填还是跳结果页 |
| 取消语义不一致 | 从结果页重新扫码取消后，可能误返回上一业务页而不是留在结果页 |
| 非安全环境兼容难 | file/capture 取消时机与路由返回耦合，容易残留全屏页 |

推荐模式：**扫码做成全屏能力组件，由业务页面调用。**

```mermaid
flowchart LR
  TabButton[首页扫码按钮] --> Scanner[FullScreenScanner]
  QuickRegister[快捷登记页] --> Scanner
  ScanResult[扫码结果页重新扫码] --> Scanner
  Scanner -->|success text| Caller[调用页面]
  Scanner -->|cancel| Caller
  Caller -->|决定| CurrentPage[当前页处理]
  Caller -->|决定| ResultRoute[/scan-result?code=...]
```

## 2. 推荐架构：能力组件 + 调用方编排

### 2.1 职责划分

| 层 | 职责 | 不应承担 |
|----|------|----------|
| `FullScreenScanner` | 打开全屏 UI、启动摄像头或 file/capture、识别码值、释放资源、抛事件 | 不判断业务来源、不操作业务路由、不查询业务接口 |
| 首页 / Tab 入口 | 打开组件；成功后进入结果页 | 不进入 `/scan` 中间路由 |
| 业务页 | 打开组件；成功后当前页处理，如搜索/选中/填表 | 不依赖 `scanReturnTarget` |
| 结果页 | 打开组件重新扫码；成功后刷新当前结果和 URL | 不 replace 到 `/scan` |
| `/scan` 路由（可选） | 兼容旧入口的壳页 | 新业务不应继续依赖 |

### 2.2 事件契约

```vue
<FullScreenScanner
  v-model:visible="scannerVisible"
  @success="handleScanSuccess"
  @cancel="handleScanCancel"
  @error="handleScanError"
/>
```

| 事件 | 触发时机 | 调用方行为 |
|------|----------|------------|
| `update:visible` | 组件需要关闭全屏 UI | 同步隐藏组件 |
| `success(text)` | 识别到二维码/条码文本 | 当前页处理或跳结果页 |
| `cancel` | 用户关闭、file/capture 取消、无文件返回 | 停留调用页面 |
| `error(error)` | 摄像头启动失败、图片解析异常等非预期错误 | 可提示或上报 |

> 实践建议：关闭时先 `emit('update:visible', false)` / `emit('cancel')`，再做资源清理，让父页面尽早隐藏全屏层。尤其 file/capture 模式下，系统拍照组件收起后应同步消失，避免残留黑屏。

## 3. FullScreenScanner 组件实现要点

### 3.1 模板骨架

```vue
<template>
  <Teleport to="body">
    <transition name="fullscreen-scanner-fade-in">
      <div v-if="visible" class="fullscreen-scanner">
        <video v-show="isCameraMode" ref="videoRef" autoplay muted playsinline />
        <div class="fullscreen-scanner__frame" @click="onFrameClick">...</div>
        <input
          v-show="false"
          ref="fileInput"
          type="file"
          accept="image/*"
          capture="environment"
          @change="onFileChange"
          @cancel="onFileInputCancel"
        />
      </div>
    </transition>
  </Teleport>
</template>
```

关键点：

- `Teleport to="body"`：避免受业务页 overflow、z-index、transform 影响。
- `v-if="visible"`：关闭后销毁全屏层和隐藏 input。
- `playsinline`：iOS Safari / 微信 WebView 下避免 video 自动全屏播放。
- `capture="environment"`：非安全上下文中尽量打开后置相机；不同浏览器可能仍打开相册，业务上需接受。
- `@cancel`：现代浏览器在文件选择器取消时触发，可比 `focus` 兜底更及时。

### 3.2 安全上下文与扫码模式

```javascript
function isSecureContextLike() {
  return window.isSecureContext
    || location.protocol === 'https:'
    || location.hostname === 'localhost'
    || location.hostname === '127.0.0.1'
}
```

| 环境 | 推荐模式 | 原因 |
|------|----------|------|
| HTTPS / localhost / 127.0.0.1 | `getUserMedia` 实时摄像头 | 浏览器允许摄像头流 |
| 普通 HTTP 真机 | file/capture | `getUserMedia` 通常不可用 |
| 用户拒绝摄像头权限 | 提示检查权限 / 重试 | 不应静默黑屏 |

### 3.3 实时摄像头扫码

实现要求：

- 使用 ZXing 等库的 `decodeFromVideoDevice()`。
- 首次启动优先后置摄像头；手动切换时按 `currentDeviceIndex` 循环，不要每次重新强制选择后置摄像头。
- 成功识别后立即停止扫码并释放 stream。
- 对 `NotFoundException` / `ChecksumException` / `FormatException` 等常规识别失败保持静默。
- 同内容短时间重复识别需防抖，如 3 秒内忽略。

```javascript
function handleScanResult(text) {
  stopScan(true)
  stopFilePickerWatch()
  emit('success', text)
  emit('update:visible', false)
}
```

### 3.4 file/capture 模式

file 模式是 H5 真机 HTTP 环境的关键兜底，不能省略。

推荐识别链路：

1. `input.click()` 打开系统拍照 / 相册；
2. `onFileChange` 拿到文件；
3. `URL.createObjectURL(file)` 加载为 `Image`；
4. 先尝试 `decodeFromImageElement(img)`；
5. 再绘制到 canvas 解码；
6. 再做多组阈值黑白增强（如 `80,100,120,140,160,180,200`）后继续解码；
7. 失败则保留全屏组件并提示「未识别到二维码/条码，请重新拍照」，让用户点击取景框再次触发。

```javascript
const decodeImage = async (img) => {
  try {
    return await codeReader.decodeFromImageElement(img)
  } catch (err) {
    if (!isExpectedScanError(err)) throw err
  }

  const originalResult = tryDecode(() => codeReader.decodeFromCanvas(createDecodeCanvas(img)))
  if (originalResult) return originalResult

  for (const threshold of [80, 100, 120, 140, 160, 180, 200]) {
    const result = tryDecode(() => codeReader.decodeFromCanvas(createDecodeCanvas(img, threshold)))
    if (result) return result
  }

  return null
}
```

### 3.5 file/capture 取消及时响应

移动端取消系统拍照组件时，常见问题是：系统 UI 已收起，但 Web 全屏扫码组件还残留一会儿。优化原则：**一旦知道用户取消，就先通知父组件隐藏 UI，再清理内部资源。**

```javascript
const closeScanner = (emitCancel = false) => {
  emit('update:visible', false)
  if (emitCancel) emit('cancel')
  stopFilePickerWatch()
  stopScan(true)
}
```

取消检测建议组合：

```javascript
<input type="file" @change="onFileChange" @cancel="onFileInputCancel" />
```

```javascript
const onFileInputCancel = () => closeScanner(true)

const scheduleFileCancelCheck = () => {
  if (!filePickerActive) return
  clearTimeout(filePickerTimer)
  filePickerTimer = setTimeout(() => {
    if (filePickerActive && !fileInput.value?.files?.length) {
      closeScanner(true)
    }
  }, 80)
}
```

| 机制 | 用途 | 注意 |
|------|------|------|
| `input cancel` | 文件选择器取消的最快路径 | 兼容性较新，仍需兜底 |
| `window focus` | 系统 UI 收起后页面重新聚焦 | 不同 WebView 时机不同 |
| `visibilitychange` | 页面从系统相机返回前台 | 某些浏览器比 focus 更可靠 |
| 短延迟兜底（约 80ms） | 等待 input.files 状态稳定 | 不要用 500ms+，会造成残留感 |

### 3.6 入场 fade-in，退出无动画

全屏能力组件不是 Stack 路由页面，建议使用组件内局部 transition：

```scss
.fullscreen-scanner-fade-in-enter-active {
  transition: opacity 1.6s ease;
  will-change: opacity;
}

.fullscreen-scanner-fade-in-enter-from {
  opacity: 0;
}

.fullscreen-scanner-fade-in-enter-to,
.fullscreen-scanner-fade-in-leave-from,
.fullscreen-scanner-fade-in-leave-to {
  opacity: 1;
}
```

- 进入：柔和淡入，降低摄像头启动和黑屏突兀感。
- 退出：不设置 `leave-active`，关闭时立即消失，尤其适合 file/capture 取消场景。

## 4. 调用方模式

### 4.1 首页扫码：成功进入结果页

```javascript
const scannerVisible = ref(false)

function onScanClick() {
  scannerVisible.value = true
}

function onScanSuccess(text) {
  openStackPage({ path: '/scan-result', query: { code: encodeScanCode(text) } })
}
```

### 4.2 业务页扫码：当前页处理

```javascript
function openScanner() {
  scannerVisible.value = true
}

async function handleScanSuccess(text) {
  const boxNo = extractArchiveBoxNo(text)
  keyword.value = boxNo
  selectedBox.value = null
  await searchBoxes(boxNo, true)
}
```

### 4.3 结果页重新扫码：原地刷新

```javascript
function scanAgain() {
  scannerVisible.value = true
}

async function handleScanAgainSuccess(text) {
  scanCode.value = text
  candidateList.value = []
  selectedBox.value = null
  router.replace({ path: route.path, query: { ...route.query, code: encodeScanCode(text) } })
  await fetchBoxInfo(text)
}
```

取消时不做路由操作，自然停留当前结果页。

### 4.4 旧 `/scan` 路由兼容壳

若历史入口较多，可保留 `/scan` 路由，但只作为兼容壳：

```vue
<template>
  <StackPage fullscreen :showBack="false">
    <FullScreenScanner v-model:visible="scannerVisible" @success="handleScanSuccess" @cancel="closeScan" />
  </StackPage>
</template>
```

- 新业务入口不再跳 `/scan`。
- 旧入口若存在 `scanReturnTarget`，可继续按旧逻辑回填。
- 无返回目标时，成功默认跳 `/scan-result?code=...`。

## 5. 公共扫码工具

扫码编码和业务字段提取应集中维护，避免调用方重复实现。

```javascript
export const encodeScanCode = (text) => btoa(encodeURIComponent(text || ''))

export const decodeScanCode = (encoded) => {
  try {
    return decodeURIComponent(atob(encoded || ''))
  } catch (e) {
    return encoded || ''
  }
}

export const extractArchiveBoxNo = (text) => {
  try {
    const data = JSON.parse(text)
    if (data && typeof data === 'object' && data['档案箱号']) {
      return String(data['档案箱号']).trim()
    }
  } catch (e) {
    // 非 JSON，直接按原文搜索
  }
  return String(text || '').trim()
}
```

> URL query 只适合中短文本。若二维码内容可能很长，应改为 session storage / store 临时传递，再在 URL 里放短 key。

## 6. 适用到其它业务能力

同一模式可复用到：

| 能力 | 组件事件结果 | 调用方处理 |
|------|--------------|------------|
| 扫码 | `success(text)` | 搜索、填表、跳结果页 |
| 选图 / 拍照 | `success(files)` | 上传、OCR、预览 |
| 选人 | `success(userIds)` | 回填表单、过滤列表 |
| 地图选点 | `success({ lng, lat, address })` | 当前页回填、提交接口 |
| NFC / 蓝牙读取 | `success(payload)` | 当前页解析或跳详情 |

原则不变：**能力组件不认识业务页面，业务页面不依赖中间路由回跳。**

## 7. 检查清单

实现扫码/选图等业务能力时：

- [ ] 能力是否可做成全屏组件，而不是中间路由？
- [ ] 组件是否只 emit 结果，不直接操作业务路由？
- [ ] 首页、业务页、结果页是否分别在调用方决定成功后的行为？
- [ ] 取消时是否停留调用页面，不修改 stackHistory？
- [ ] 非安全 HTTP 环境是否有 file/capture 兜底？
- [ ] file/capture 取消是否监听了 `cancel` + `focus` + `visibilitychange`？
- [ ] 关闭时是否先 emit 隐藏，再清理资源？
- [ ] 实时摄像头关闭/成功/卸载时是否释放 stream？
- [ ] 编码、解码、业务字段提取是否集中在公共工具？
- [ ] 如保留旧路由，是否仅作为兼容壳，新入口不再依赖？
