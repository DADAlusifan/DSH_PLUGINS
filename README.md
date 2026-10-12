# DSH 插件目录

这个文件夹专门存放我自己的 DeepSeek Harness 插件。**一个子文件夹 = 一个插件。**

放在这里的原因：插件源码不能放在工作区里（工作区删了/移了插件就废了），
也不能放在 `~\.dsh` 下面（那是 profile 的领地，`node_modules` 会被 pnpm 重写、
`remove_bundle` 会清理，DSH 的插件规范明确禁止在 `$DSH_HOME` 下建包）。

## 现有插件

| 文件夹 | 包名 | 作用 |
|---|---|---|
| `dsh-project-notes\` | `@local/dsh-project-notes` | 侧栏「项目笔记」入口，列出并预览当前工作区的 Markdown 文件 |

## 常用操作

安装（把绝对路径交给 plugin_manager，它会跑 pnpm 并在 profile 里建符号链接）：

```
plugin_manager { action: "install_bundle", target: "D:\\dsh-plugins\\<插件文件夹>" }
```

卸载：

```
plugin_manager { action: "remove_bundle", target: "<包名>" }
```

改动生效规则：

- 改 `client.js`（浏览器半）→ 约 500ms 内自动热更新，**不用刷新页面**
- 改 `index.js`（Host 半）→ 需要重启 DSH 才能换到新的模块代际
- 改 `package.json` / `cordis.patch.yml` → 热生效

## 新建一个插件

最小四件套（照 DSH 自带的 `cordis-plugin-development` 技能模板）：

```
my-plugin\
├── package.json      # dsh.bundle.patch + 可选的 dsh.client
├── cordis.patch.yml  # - insert: [{id: xxx, name: '@local/xxx'}]
├── index.js          # Host 半：export function apply(ctx) {}
└── client.js         # 浏览器半（可选）：window.__ModuleLoader__.load({id, factory})
```

包名建议用 `@local/<名字>`，避免和 registry 上的包重名。

## 注意事项

- 因为是符号链接安装，**这里就是唯一的源码**，别再复制一份到别处，否则会改错文件。
- 备份这个文件夹 == 备份所有插件。
- 想让插件彻底独立于这个目录，可以 `pnpm pack` 打成 tarball 再安装（代价：失去热重载）。
