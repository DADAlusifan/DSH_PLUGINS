# 项目笔记 (dsh-project-notes)

一个 DeepSeek Harness（DSH）插件：在左侧边栏增加「项目笔记」入口，列出**当前工作区**的
Markdown 文件，点击后在主面板中预览内容。

## 功能

- **侧栏入口** —— 注册到 root 作用域的 `sidebar.panellist` 列表槽位，图标是一个便签；
  同一个 id（`project-notes`）同时注册为主线 `main` 键控槽位的键，因此点击图标由
  侧栏自身的行逻辑调用 `ctx.layout.selectPanel('project-notes')` 完成切换。
- **文件列表** —— 左侧列出工作区内所有 `.md` / `.markdown` / `.mdx` 文件，按目录分组，
  支持关键字筛选，显示文件数量。
- **内容预览** —— 右侧渲染选中文件的 Markdown（标题、列表、引用、代码块、表格、
  行内强调与链接）。不引入任何第三方 Markdown 依赖，全部用 `React.createElement` 构建，
  不使用 `dangerouslySetInnerHTML`。
- **工作区切换** —— 「当前工作区」取工作区注册表中 `updatedAt` 最新的一条；注册了多个
  工作区时，标题栏会出现下拉框可切换。
- **主题跟随** —— 所有颜色来自 `--dsw-alias-*` 主题变量，因此自动适配浅色/深色主题。

## 结构

| 文件 | 作用 |
|---|---|
| `package.json` | 包清单：`dsh.bundle.patch` 声明这是一个 bundle，`dsh.client` 声明浏览器端，`exports["./client"]` 指向浏览器产物 |
| `cordis.patch.yml` | bundle 补丁：插入一行 `project-notes` 挂载本包 |
| `index.js` | Host 半：在 `ctx.webServer` 上注册只读 HTTP API `/project-notes/api/*` |
| `client.js` | 浏览器半：`window.__ModuleLoader__.load({ id, factory })`，注册侧栏入口与主面板 |
| `README.md` | 本文件 |

## 数据流

浏览器半通过同源 `fetch` 调用 Host 半注册的接口：

| 接口 | 返回 |
|---|---|
| `GET /project-notes/api/state` | 已注册工作区列表（按最近更新排序）与默认工作区 |
| `GET /project-notes/api/notes?workspace=<路径>` | 工作区内的 Markdown 文件清单 |
| `GET /project-notes/api/note?workspace=<路径>&path=<相对路径>` | 单个文件的内容（上限 512 KB） |

Host 半只读取**工作区注册表**（`ctx.workspaceRegistry`）中登记的目录，并且在读取前
再次校验解析后的绝对路径仍位于该工作区根目录内，因此不存在目录穿越。
接口是只读的：不写入、不删除任何文件。

列表遍历会跳过 `node_modules`、`dist`、`build` 等目录以及所有以 `.` 开头的目录，
深度上限 8 层、条数上限 800 个、单文件 512 KB。

## 安装

```text
plugin_manager { action: "install_bundle", target: "<本目录的绝对路径>" }
```

安装会把本包加入当前 profile 的 `package.json`（`dsh.profile.bundles`）并写入
`cordis.patch.yml`，桌面版 profile 是 live profile，因此安装后立即生效（`application: applied`）。

## 卸载

```text
plugin_manager { action: "remove_bundle", target: "@local/dsh-project-notes" }
```
