# 发送到输入框 (dsh-send-to-input)

一个 DeepSeek Harness（DSH）插件：在**右侧栏文档预览的标题栏**加两个按钮，把选中的内容或
整篇文件一键送进对话输入框。

> 为什么不是右键菜单？选中文字后弹出的那个「复制」气泡是 **Electron 的原生菜单**，DSH 的
> 界面里没有任何选择菜单的实现，插件没有扩展点。整个槽位目录里可扩展的菜单只有
> `sidebar.right.tab.menu.item`（标签页「…」菜单）和 `sidebar.workspaces.session.menu.item`
> （会话菜单）两个。所以这里走的是官方槽位 + 快捷键。

## 功能

- **发送选中内容** —— 预览里选中的文字（含所选文件的路径）包成一个带语言标记的围栏代码块，
  直接写进输入框；留在草稿里，不会自动发送。
- **发送整篇文件** —— 通过会话作用域的 `remote.workspaceFiles.read` 分页读完整个文件（最多
  40000 字符、12 页，超出部分截断并提示），同样包成围栏代码块。
- **快捷键** —— `Ctrl/Cmd + Alt + I` 发送当前记住的选中内容，不需要先点按钮，也不需要右键。
- **不会把草稿发回给自己** —— 输入框里的选中内容被显式排除；此时按钮不会把上一次的预览选区
  发出去，而是提示「请先选中内容」。

## 实现要点

| 关注点 | 做法 |
|---|---|
| 落座位置 | `sidebar.right.tab.document.actions`（会话作用域 list 槽位，官方「在应用中打开」按钮也在这一格），`id: send-to-input` |
| 拿到输入框 | 槽位的标准 prop `inputActions: InputActions`。**它不是服务**，根 hook 只有 sessions/panelInfo/workspaces/resource 四个，所以快捷键处理器复用组件发布的最新句柄 |
| 写入草稿 | `const span = inputActions.captureInsertion()` 与 `inputActions.insertText(text, span)` 必须**同一时刻**调用：span 里带着草稿版本号，版本不符（或正在提交）时 `insertText` 返回 `false` |
| 选区 | 点击按钮可能让浏览器丢掉选区，所以 `selectionchange` 时缓存最后一次可用选区；同时区分「没有选区」和「选区在输入框里」两种情况 |
| 读整篇文件 | 组件拿不到 `ctx`（它是 `apply` 的参数），因此读取函数通过槽位注册的 `inject` 注入成 prop —— 与 `inputActions` 同样的通道 |
| 热重载 | 样式表用「声明归属者」的写法：重载时复用同一个 `<style>` 并重写内容，disposer 只在自己仍是归属者时移除，前任不会删掉后继刚写的样式 |
| Host 半 | 故意是空实现（`index.js`）。没有 Host 逻辑：写草稿走槽位 prop，读文件走 Host 已经守护好的 API |

## 结构

| 文件 | 作用 |
|---|---|
| `package.json` | 包清单：`dsh.bundle.patch` 声明 bundle，`dsh.client` 声明浏览器端与加载顺序 |
| `cordis.patch.yml` | bundle 补丁：插入一行 `send-to-input` 挂载本包 |
| `index.js` | Host 半入口：空实现（本插件没有 Host 面） |
| `client.js` | 浏览器端全部逻辑：样式、选区追踪、标题栏动作、快捷键 |
| `test/client.test.js` | 9 个 `node:test` 用例：注册契约、快捷键、选区投递、输入框排除、分页读文件、读取失败、样式归属 |

## 安装

```bash
dsh plugin install /path/to/dsh-send-to-input
```

或在 DSH 里用插件管理安装该目录（本地路径即可）。

这是**纯客户端**插件：装好后刷新页面就能用（客户端模块热重载），
不需要重启 DSH —— 不过**新 bundle 行第一次生效**仍以插件管理器的结果为准。

## 使用

1. 在右侧栏打开任意文件的预览（官方「文件」标签页点一个文件，或代码/文本/Markdown 预览均可）。
2. 选中想要的内容 → 点标题栏的「发送」图标（或按 `Ctrl/Cmd + Alt + I`）。
3. 想整篇发过去，点旁边的「文件」图标。

## 已知边界

- 只在**文件预览**的标题栏出现；没有打开预览时快捷键会提示「请先打开文件预览」。
- 二进制/非文本文件（图片、PDF 等）走 `read` 会失败，按钮会提示「这个文件不是文本，无法发送」而不是发半截内容。
- 读取失败按 Host 的真实错误码分别提示：文件不存在（可能已被移动或删除）、不是文本、文件太大、
  不是普通文件；无法识别的错误码会把原码一起显示出来，例如「读取文件失败（gateway/bad-request）」。
  所以**预览里打开的文件被移动/删除后**，点「发送整篇文件」会看到「文件不存在」——关掉重新打开预览即可。
- 单个文件最多发送 40000 字符，超出会截断并提示。
- 按钮外观跟随 `--dsw-alias-*` 主题变量；图标来自 `@deepseek-ai/dsh-client-ui-primitives`，
  模块表里没有时退回一个文字箭头。

## 测试

```bash
npm test                       # 12 个用例，无需浏览器
```

端到端（jsdom + 真实 React、真实选区、真实点击）用临时脚本验证，不随包提交。
