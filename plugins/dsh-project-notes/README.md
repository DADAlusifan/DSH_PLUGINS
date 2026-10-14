# 项目笔记 (dsh-project-notes)

一个 DeepSeek Harness（DSH）插件：在左侧边栏增加「项目笔记」入口，列出**工作区**的
Markdown 文件，点击后在主面板中预览内容。

## 功能

- **侧栏入口** —— 注册到 root 作用域的 `sidebar.panellist` 列表槽位，图标是一个便签；
  同一个 id（`project-notes`）同时注册为主线 `main` 键控槽位的键，因此点击图标由
  侧栏自身的行逻辑调用 `ctx.layout.selectPanel('project-notes')` 完成切换。
- **文件列表＝目录树** —— 按 `dir` 还原成目录树：目录行可折叠（带子目录笔记数），逐层缩进，
  子目录在前、本层文件在后，目录名与文件名都按名称排序；标题栏的 `⊟/⊞` 可一键折叠/展开全部。
  笔记数超过 80 时默认全部折叠（先看结构，避免一屏几百行），否则默认展开；**打开某篇笔记时
  会自动展开它所在的目录**。筛选时切换成**扁平结果列表**（每行带所在目录），便于直接扫；
  清空筛选回到树。
- **内容预览** —— 优先使用 DSH 自带的 `@deepseek-ai/dsh-client-ui-primitives` 的
  `MarkdownText`（GFM、TeX 数学、代码高亮），模块表里没有时才退回包内自带的
  渲染器。两者都不用 `dangerouslySetInnerHTML`。`MarkdownText` 的 `labels`
  是必填项（代码围栏的复制按钮、脚注标题都取自它），所以插件按当前 locale
  组装一份并在文案不变时复用同一个对象——`MarkdownText` 以 `labels` 的引用做
  memo，每次渲染新建对象会重建它的组件表。这几个键属于框架 `common` 命名空间
  的公共词表，因此走 `locale.bind` 时由语言包解析，包内只保留无 locale 服务时的兜底。
- **代码块复制按钮** —— 两条渲染路径都提供。平台渲染器走它自己的代码卡片工具栏
  （语言名 + 复制/换行），包内兜底渲染器则自带一个「语言名 + 复制」标题栏，
  两者行为一致：复制围栏正文原文，成功后短暂显示「复制成功」。
  注意可用性判定不能写成 `typeof MarkdownText === 'function'`：`MarkdownText` 是
  `memo(function …)`，而 `React.memo` 返回的是**带标记的对象**（`$$typeof` 为
  `react.memo`）而不是函数，这样的判定会永远为假、静默退回兜底渲染器。
  插件用 `isComponent()` 同时接受函数与 `memo`/`forwardRef`/`lazy` 三种形态。
- **笔记间跳转** —— 预览里的 `[另一篇](./other.md)` 会在面板内打开对应笔记
  （通过 `MarkdownDelegateProvider` 的 `openFile` 委托；本地链接在没有委托时是
  纯文本，不会误触发页面跳转）。
- **文档内锚点 + 大纲** —— 右侧大纲列出文档全部标题（按层级缩进、跟随滚动高亮），
  点一条即滚动到对应标题；正文里的 `[安装](#安装)` 也能点。注意 `MarkdownText`
  本身把「只有 `#锚点` 的目标」当普通文字渲染，所以插件在渲染前把这类链接改写成
  `<当前文件>#L<标题行号>`——这是它确实会渲染成可点控件的形态——再用 `openFile`
  收到的行号滚回去；代码围栏与行内代码里的同样文本不会被改写，指向不存在的标题时
  保持原样（仍是纯文本，不会变成点了没反应的控件）。锚点匹配兼容 `#安装`、
  `#安装-1`（重复标题）与百分号编码，标题文本里的行内标记也会被归一化。
- **工作区切换** —— 工作区列表来自 `useWorkspaces` 标准 prop（按注册表顺序，也就是
  侧栏顺序）；记忆的选择仍然存在时保留它，否则回到第一条。注册了多个工作区时，
  标题栏会出现下拉框可切换；重命名、重排、增删都会就地跟随，不需要刷新。
- **失败可见** —— 文件列表、单篇读取、工作区投影各自持有自己的失败状态：列表遍历
  失败时显示失败原因和「重试」，**不会**被误报成「当前工作区没有 Markdown 文件」；
  工作区注册表为空与注册表读取失败也是两条不同的分支。
- **主题跟随** —— 所有颜色来自 `--dsw-alias-*` 主题变量，样式集中在插件自己注入的
  一张 `<style>` 里，因此自动适配浅色/深色主题，hover/focus/选中态交给 CSS。

## 结构

| 文件 | 作用 |
|---|---|
| `package.json` | 包清单：`dsh.bundle.patch` 声明 bundle，`dsh.client` 声明浏览器端，`exports["./client"]` 指向浏览器产物，`npm test` 跑 Host 单测 |
| `cordis.patch.yml` | bundle 补丁：插入一行 `project-notes` 挂载本包 |
| `index.js` | Host 半入口：声明 `inject`、把三个端点注册成 `ctx.connection.fetch` 的精确路由 |
| `lib/host.js` | Host 半逻辑：配置校验、工作区解析、目录遍历、单文件读取、端点应答（可单测） |
| `client.js` | 浏览器半：`window.__ModuleLoader__.load({ id, factory })`，注册侧栏入口与主面板 |
| `test/host.test.js` | Host 半回归用例（软链逃逸、越界、截断、鉴权等） |
| `test/client.test.js` | 浏览器半接线用例（模块 id、槽位注册、样式归属、locale 绑定） |
| `test/client-panel.test.js` | 浏览器半行为用例：真跑面板组件（带依赖比较的 hook 运行时 + 假 fetch），覆盖 `MarkdownText` 必填 props 与列表失败态 |
| `README.md` | 本文件 |

## 数据流

工作区列表**不走请求**：`main` 槽位的标准 prop `useWorkspaces` 已经把注册表投影
（`items` 按侧栏顺序、`workspaceId` 就是持久 id）交给面板，重命名/重排/增删都会
自动跟随，因此不需要 `/state` 往返，也不会出现陈旧的下拉框。面板只调用自己拥有的
两个端点：

| 接口 | 返回 |
|---|---|
| `GET /api/project-notes/notes?workspace=<id\|路径>` | `{ workspace, root, notes, truncated, limit }` |
| `GET /api/project-notes/note?workspace=<id\|路径>&path=<相对路径>` | `{ path, name, text, size, truncated, limitBytes }` |

（`GET /api/project-notes/state` 仍在 Host 上提供，用于诊断与兼容，
但浏览器半不再调用它。）

`workspace` 参数同时接受工作区的持久 id 和目录路径。列表行只有 `path`/`name`/`dir`
—— 遍历不再对每个文件 `stat`，体积随打开笔记的响应一起返回。

### 安全模型

- **鉴权**：三个端点是 `/api` 共享通道上的**精确 Fetch 路由**
  （`ctx.connection.fetch.register`），连接围栏在分发前就完成 Host/Origin 校验与
  浏览器鉴权，因此插件自己**没有任何准入逻辑**——与官方 `/api/file` 同一条路。
  副作用是插件流量会经过 `connection/request` waterfall（自建 `webServer` 路由
  会绕过它）。取不到 `connection` 服务时插件根本不会加载（`inject` 声明），
  不存在“以未鉴权方式提供服务”的分支。
- **包含判定**：只列/只读**工作区注册表**里登记的目录；路径经
  `ctx.fs.resolve()` 解析后用 `ctx.fs.contains()` 比较 realpath 派生的 target key，
  因此 `..` 穿越和指向工作区外的软链都会被拒。
- **软链**：`ctx.fs.lstat()` 明确拒绝最终目标是软链的路径（即使它指向工作区内），
  与平台自身的文件读取规则一致；遍历时也不会跟随软链目录。
- **读取上限**：用 `ctx.fs.readByteRange()` 只读前 `maxNoteBytes + 1` 字节，不把整个
  文件读进内存；截断时回退到最后一个换行符，并丢弃结尾不完整的 UTF-8 序列，
  所以不会出现半个汉字（U+FFFD）。遍历与单文件读取都接收 `request.signal`，
  客户端断开即停止。
- **错误**：500 只回 `{"error":"internal"}`，绝不回传内部 message（避免泄露主机路径）。

接口是只读的：不写入、不删除任何文件。

### 可选配置

在 `cordis.patch.yml` 的挂载行上加 `config`，字段会被裁剪到安全范围（越界即回落默认值）：

```yaml
- insert:
    - id: project-notes
      name: '@local/dsh-project-notes'
      config:
        extensions: ['.md', '.markdown']
        skipDirectories: ['node_modules', 'dist', 'vendor']
        maxNotes: 2000      # 1 – 20000
        maxDepth: 12        # 0 – 64
        maxNoteBytes: 1048576  # 1 KiB – 16 MiB
```

本包**没有**声明 Config schema（那需要 `@deepseek-ai/schemastery` 依赖），所以 DSH 的
插件配置界面不会列出这些字段，只能手写 YAML。不写 `config` 时使用内置默认值。

## 测试

```text
npm test        # node --test "test/*.test.js"
```

用例覆盖：软链逃逸（工作区外/工作区内两种）、`..` 越界、非 Markdown 与不存在、
超大文件的截断与 UTF-8 边界、空文件、`maxNotes`/`maxDepth`/跳过目录/顺序、
配置裁剪、注册表顺序（不再按 `updatedAt` 排序）、端点/方法错误、HEAD 无正文、
500 不泄露内部信息。

浏览器半分两层：`client.test.js` 只管接线（模块 id、槽位、样式归属、locale 绑定），
`client-panel.test.js` 真跑面板组件——它用一个最小但诚实的 hook 运行时（state 写入
触发重渲染、effect 按依赖比较执行）加假 `fetch`，因此能覆盖「加载 → 选中 → 渲染」
这条链路。它把 primitives 桩做成 `memo` 形态（与真实包一致），所以「可用性判定必须
接受 memo 对象」这条不会被一个假的函数桩掩盖。这几条用例都验证过：把对应修复
回退后它们会失败——`MarkdownText` 的 `labels`、列表失败态、
「工作区列表来自 `useWorkspaces` 而不是自己的请求」、
「`memo` 形态的 `MarkdownText` 必须被选中」、以及「无 primitives 时兜底代码块仍有复制按钮」。

## 生效方式

- 改 `client.js`（浏览器半）→ 约 500ms 内热更新，不用刷新页面；
- 改 `index.js` / `lib/*.js`（Host 半）→ **必须重启 DSH** 才会换到新的模块代际；
- 改 `package.json` / `cordis.patch.yml` → 热生效。

## 安装

```text
plugin_manager { action: "install_bundle", target: "<本目录的绝对路径>" }
```

## 卸载

```text
plugin_manager { action: "remove_bundle", target: "@local/dsh-project-notes" }
```
