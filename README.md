# DSH 插件与技能目录

这个文件夹专门存放我自己的 DeepSeek Harness 扩展。**两个子文件夹 = 两类东西：**

```
DSH_PLUGINS\
├── plugins\    # 插件（Host 半 + 浏览器半），一个子文件夹 = 一个插件
└── skills\     # 技能（SKILL.md），一个子文件夹 = 一个技能
```

放在这里的原因：插件源码不能放在工作区里（工作区删了/移了插件就废了），
也不能放在 `~\.dsh` 下面（那是 profile 的领地，`node_modules` 会被 pnpm 重写、
`remove_bundle` 会清理，DSH 的插件规范明确禁止在 `$DSH_HOME` 下建包）。

## 现有插件

| 文件夹 | 包名 | 作用 |
|---|---|---|
| `plugins\dsh-project-notes\` | `@local/dsh-project-notes` | 侧栏「项目笔记」入口，列出并预览当前工作区的 Markdown 文件 |
| `plugins\dsh-send-to-input\` | `@local/dsh-send-to-input` | 把右侧文档预览里选中的内容（或整篇文件）一键送进对话输入框 |

已安装进 `desktop` profile：`node_modules\@local\*` 是指向本目录的符号链接，**这里就是唯一源码**。

## 现有技能

技能不需要安装包，只要被 DSH 的 skill 根目录扫到即可。本目录通过一个目录联接（junction）
直接挂到用户级 skill 根：

```
C:\Users\admin\.dsh\skills  --(Junction)-->  E:\DSH_PLUGINS\skills
```

| 技能 | 作用 |
|---|---|
| `cinematic-shot-prompt-expert` | 电影级镜头提示词专家：视频拆解 + 50 镜镜头库 + 多模型适配 |
| `h3-prompt-writing` | MiniMax H3 提示词写法（T2VA / I2VA / FL2VA / L2VA / Ref2VA） |
| `h3-shot-adapter` | H3 分镜适配 |
| `minimax-h3-prompt` | MiniMax H3 提示词 |
| `novel-to-video-pipeline` | 小说转视频流水线 |
| `seedance-prompt-optimizer` | Seedance 提示词优化 |
| `seedream5-pro-character-sheet` | Seedream 5 Pro 角色设定图提示词 |

## 常用操作

安装插件（把绝对路径交给 plugin_manager，它会跑 pnpm 并在 profile 里建符号链接）：

```
plugin_manager { action: "install_bundle", target: "E:\DSH_PLUGINS\plugins\<插件文件夹>" }
```

卸载插件：

```
plugin_manager { action: "remove_bundle", target: "<包名>" }
```

重建技能联接（换机器后、或 `.dsh\skills` 被清掉时；需要先确认目标目录为空）：

```powershell
Remove-Item 'C:\Users\admin\.dsh\skills' -Force          # 仅在确认为空时
New-Item -ItemType Junction -Path 'C:\Users\admin\.dsh\skills' -Target 'E:\DSH_PLUGINS\skills'
```

## 改动生效规则

| 改什么 | 怎么生效 |
|---|---|
| `skills\*\SKILL.md` 正文 | 立即生效（每次加载都重读文件） |
| `skills\*\SKILL.md` frontmatter / 增删技能 | 下一次模型步骤刷新目录，不用重启 |
| 插件 `client.js`（浏览器半） | 约 500ms 内自动热更新，**不用刷新页面** |
| 插件 `index.js`（Host 半） | 需要重启 DSH 才能换到新的模块代际 |
| 插件 `package.json` / `cordis.patch.yml` | 热生效 |

## 技能格式要点

- 发现深度只有**一层**：`<根>\<名字>\SKILL.md` 或 `<根>\<名字>.md`，嵌套的 `**/SKILL.md` 不会被发现。
- frontmatter **必须**有 `name`（kebab-case）和 `description`（纯文本，模型目录读的就是它）。
  只有 `description_zh` / `description_en` 会被**静默丢弃**（只在日志里 warn）。
- 扩展字段（`display_name`、`version`、`license` 等）会被忽略，留着无害。
- 会让技能整条被丢弃的写法：`disableModelInvocation` / `modelInvocable` / `userInvocable`
  这三个驼峰键（必须用 `disable-model-invocation` / `user-invocable`）。
- skill 根目录优先级（rank 小者优先）：`<项目>\.dsh\skills`(100) → `<项目>\.agents\skills`(200) →
  `customSkillDirs`(300) → `~\.dsh\skills`(400) → `~\.agents\skills`(500)。重名时高优先级胜出。
- 依赖的插件行：`include:skill`（注册表，默认开）、`include:skill-filesystem`（本地发现，**本机已启用**）、
  `include:tool-skill`（模型的 `skill` 工具）。`include:skill-badge` 仍是关的（只是 UI 角标）。

## 远程仓库

本文件夹同时是一个 Git 仓库，远程为 <https://github.com/DADAlusifan/DSH_PLUGINS>（公开仓），
默认分支 `main` 已跟踪 `origin/main`。

```
git add -A
git commit -m "feat: 说明这次改了什么"
git push          # 已设置 upstream，无需再写 origin main
```

换一台机器恢复全部插件与技能：

```
git clone https://github.com/DADAlusifan/DSH_PLUGINS.git E:\DSH_PLUGINS
# 然后按上面的「安装插件」逐个装，再重建技能联接
```

注意：**这是公开仓库**，别把密钥、token、个人路径之外的敏感信息提交进去。

## 新建一个插件

最小四件套（照 DSH 自带的 `cordis-plugin-development` 技能模板）：

```
plugins\my-plugin\
├── package.json      # dsh.bundle.patch + 可选的 dsh.client
├── cordis.patch.yml  # - insert: [{id: xxx, name: '@local/xxx'}]
├── index.js          # Host 半：export function apply(ctx) {}
└── client.js         # 浏览器半（可选）：window.__ModuleLoader__.load({id, factory})
```

包名建议用 `@local/<名字>`，避免和 registry 上的包重名。

## 注意事项

- 因为是符号链接/联接安装，**这里就是唯一的源码**，别再复制一份到别处，否则会改错文件。
- 备份这个文件夹 == 备份所有插件和技能；它本身是 Git 仓库，`git push` 到远程即完成备份。
- 想让插件彻底独立于这个目录，可以 `pnpm pack` 打成 tarball 再安装（代价：失去热重载）。
