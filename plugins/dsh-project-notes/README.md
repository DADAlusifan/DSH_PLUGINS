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
  渲染器。两者都不用 `dangerouslySetInnerHTML`。
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
- **工作区切换** —— 默认取工作区注册表的**注册顺序**（也就是侧栏顺序）第一条；
  注册了多个工作区时，标题栏会出现下拉框可切换。
- **主题跟随** —— 所有颜色来自 `--dsw-alias-*` 主题变量，样式集中在插件自己注入的
  一张 `<style>` 里，因此自动适配浅色/深色主题，hover/focus/选中态交给 CSS。

## 结构

| 文件 | 作用 |
|---|---|
| `package.json` | 包清单：`dsh.bundle.patch` 声明 bundle，`dsh.client` 声明浏览器端，`exports["./client"]` 指向浏览器产物，`npm test` 跑 Host 单测 |
| `cordis.patch.yml` | bundle 补丁：插入一行 `project-notes` 挂载本包 |
| `index.js` | Host 半入口：声明 `inject`、把路由挂到 `ctx.webServer` |
| `lib/host.js` | Host 半逻辑：配置校验、工作区解析、目录遍历、单文件读取、请求处理（可单测） |
| `client.js` | 浏览器半：`window.__ModuleLoader__.load({ id, factory })`，注册侧栏入口与主面板 |
| `test/` | `node:test` 回归用例（软链逃逸、越界、截断、鉴权等） |
| `README.md` | 本文件 |

## 数据流

浏览器半通过同源 `fetch` 调用 Host 半注册的接口：

| 接口 | 返回 |
|---|---|
| `GET /project-notes/api/state` | `{ workspaces, defaultKey, order, route }`，工作区按注册表顺序 |
| `GET /project-notes/api/notes?workspace=<id\|路径>` | `{ workspace, root, notes, truncated, limit }` |
| `GET /project-notes/api/note?workspace=<id\|路径>&path=<相对路径>` | `{ path, name, text, size, truncated, limitBytes }` |

`workspace` 参数同时接受工作区的持久 id 和目录路径。列表行只有 `path`/`name`/`dir`
—— 遍历不再对每个文件 `stat`，体积随打开笔记的响应一起返回。

### 安全模型

- **鉴权**：路由不是载体自带的受信通道，因此每个请求先过
  `ctx.connection.admit(req)`（与官方 `/api` 通道同一道 Host/Origin 围栏 +
  浏览器鉴权）。取不到 `connection` 服务时直接 503，**不会**以未鉴权方式提供服务。
- **包含判定**：只列/只读**工作区注册表**里登记的目录；路径经
  `ctx.fs.resolve()` 解析后用 `ctx.fs.contains()` 比较 realpath 派生的 target key，
  因此 `..` 穿越和指向工作区外的软链都会被拒。
- **软链**：`ctx.fs.lstat()` 明确拒绝最终目标是软链的路径（即使它指向工作区内），
  与平台自身的文件读取规则一致；遍历时也不会跟随软链目录。
- **读取上限**：用 `ctx.fs.readByteRange()` 只读前 `maxNoteBytes + 1` 字节，不把整个
  文件读进内存；截断时回退到最后一个换行符，并丢弃结尾不完整的 UTF-8 序列，
  所以不会出现半个汉字（U+FFFD）。
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
配置裁剪、注册表顺序（不再按 `updatedAt` 排序）、鉴权拒绝、方法/端点错误、
500 不泄露内部信息。

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
