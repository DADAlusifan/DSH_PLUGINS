---
name: h3-shot-adapter
display_name: H3 镜头库适配器
display_name_en: H3 Shot Library Adapter
description: "把「电影级镜头提示词专家」选出的 50 镜库镜头，换轨落地为 MiniMax H3 可直接投喂的成品提示词。负责五个换轨点（语言、占位符、时间码、文体、结构），强制执行 H3 规范的时长与描述粒度约束（单段 4-15 秒、detailed_description 350-500 词），并叠加四条工程纪律（一镜一动词、字符预算、场景词收敛、段间接帧）。内置中文运镜到 H3 运镜三元组的映射表、转场镜与长镜头的 H3 拆并规则、六段式预算经验值、多段装配模板、换轨时最易漏的 H3 硬点清单，以及确定性校验脚本。触发词：H3 提示词、H3 六段式、Ref2VA、镜头库落地 H3、分镜转 H3、H3 适配、MiniMax H3 运镜、H3 时间码、一镜一动词。"
description_zh: "镜头库选镜结果到 MiniMax H3 成品提示词的换轨层。五个换轨点（中译英、占位符转参考标签、秒数转时间码、抽象体转具体视觉、单镜提示词转多镜段落）加 H3 规范的时长与词数约束，再叠加四条工程纪律（一镜一动词、字符预算、场景词收敛、段间接帧）。附运镜映射表、转场镜与长镜头拆并规则、易漏硬点清单与校验脚本。"
description_en: "The handoff layer that lands shots selected from a 50-shot cinematic library into production-ready MiniMax H3 prompts. Covers five handoff points (language, placeholders, timecode, prose register, structure), enforces the H3 spec's duration and description-granularity limits, and layers four engineering disciplines on top (one camera verb per shot, character budget, scene-vocabulary convergence, cross-segment frame handoff). Ships a Chinese-to-H3 camera-movement mapping table, transition-shot and long-take split rules, empirical budgets, a checklist of easily-missed spec hard points, and a deterministic validator."
version: 1.0.0
category: content
agent_created: true
---

# H3 镜头库适配器

## 定位：本技能是「换轨层」

```
创意 / 剧本 / 已有视频
        ↓
① 拆解 + 定叙事功能              ← cinematic-shot-prompt-expert
        ↓
② 查 50 镜库选镜（按功能不按编号）  ← cinematic-shot-prompt-expert
        ↓
③ 换轨：语言 / 占位符 / 时间码 / 文体 / 结构   ← 本技能
        ↓
④ 六段式成品（可直接投喂）         ← 字段语法遵循 h3-prompt-writing
```

**本技能不做选镜创意**（那是上游的活），**也不重复定义六个 section 的字段含义**（那是 h3-prompt-writing 的活）。它只负责中间那段最容易翻车、又最没有现成规范的换轨。

上游技能解决「拍什么」，H3 规范解决「字段长什么样」，**本技能解决「中文镜头模板怎么变成合规的英文 H3 段落」**。

---

## 一、五个换轨点

| # | 维度 | 镜头库口径 | H3 口径 | 动作 |
|---|------|-----------|---------|------|
| 1 | 语言 | 全中文整段 | 除 `<d>` 内对白／唱词／画面可见文字外，**全部英文** | 重写，不是翻译 |
| 2 | 占位符 | `[角色名]`、`[场景：…]` | `<Subject N>`、`<Picture N>`、`<Video N>`、`<Audio N>` | 先建标签表，再套镜 |
| 3 | 时长 | 「时长 5 秒」平铺在句尾 | `[Shot 1]` 无时间码；后续 `[Shot N] At MM:SS.mmm, ...` | 转成严格递增的切点 |
| 4 | 文体 | 抽象、营销体（电影级／极致／张力拉满／毫发毕现） | H3 明确要求 concrete visual and audio details | 换成可拍摄的具体描述 |
| 5 | 结构 | 一镜 = 一条完整提示词 | 一段视频 = **多个** `[Shot]`；超 15 秒 = 多次独立生成 | 从「镜」重排为「段」 |

**另外两处在换轨时最容易整段漏掉**（镜头库完全没有对应概念）：

- **`summary` 必须以方括号任务类型前缀开头**，如 `[reference generation + keyframe completion]`
- **`non_diegetic_music` 无配乐时写 `N/A`**，不是省略、也不是自己造句

完整硬点见 `references/H3硬点清单.md`。

### 换轨点 1：语言

不是逐字翻译。库内原文为了卖相堆了形容词，直译过去会触发 H3 的「避免抽象词」规则。

- 删：「电影级」「极致」「张力拉满」「尽显」「毫发毕现」「视觉冲击力极强」
- 换：让**摄影机能拍到的东西**顶上去——景别、焦段、光位、材质反应、动作轨迹、时长
- 留：`<d>` 内对白与画面可见文字**原语言保留，逐字不改**

对照示例：

| 库原文 | 直译（错） | 换轨后（对） |
|---|---|---|
| 极近距离拍摄打火机，细节分明，画面降速至0.5倍 | filmed extremely close, details are clear, speed drops to 0.5x | `a tight close-up on the lighter, the worn edges and the tendons standing out on the knuckles; the motion drops into slow motion as the thumb presses and releases` |
| 张力拉满 | the tension is maxed out | （删掉，改由对角线构图与手持微晃承担） |
| 尽显群像的命运暗流 | fully reveals the undercurrent of the group's fate | （删掉，改由俯拍机位与队列几何排列承担） |

### 换轨点 2：占位符

`[角色名]` → `<Subject N>`。规则：

1. **先建标签表，再套镜**。在 `subject_definitions` 里给每个复用内容一条独立定义行。
2. 一个 `<Subject N>` 可以由多个资产共同定义：`<Subject 1> is the woman whose appearance comes from <Picture 1> and whose walking motion comes from <Video 1>.`
3. **只用来定义人物／场景／服装／风格来源的图，不单独开 `<Picture N>` 行**，把它写进对应的 `<Subject N>` 定义里。
4. 图直接充当某镜首帧／关键帧／尾帧／构图锚点时，才开独立 `<Picture N>` 行。
5. 标签一旦分配，六个 section 里含义不变，不得中途改写。

### 换轨点 3：时长

| 库内写法 | H3 写法 |
|---|---|
| `[Shot 1]`（首镜） | `[Shot 1]` —— **不加时间码** |
| 后续镜 | `[Shot 2] At 00:03.500, the camera cuts to...` |
| 时长 5 秒（句尾平铺） | 由**与下一镜切点的时间差**隐式表达，不再写「5 秒」 |

**切点必须严格递增，且不超过本段总时长。**

### 换轨点 4：文体

H3 要求具体。三个改写抓手：

- **材质反应**比形容词值钱：`the watered flagstones squeaking under her feet` 胜过 `dramatic setting`
- **光位**要写清方向与硬柔：`hard warm sunlight from a high left-rear angle, its direction fixed for the whole clip`
- **动作要分节拍**：一次接触拆成「进入—接触—结果」三段，而不是「激烈交手」

镜头库里「运镜速度」「过曝」「焦外虚化」「逆光吞掉细节」这些**本来就是具体描述**，直接留用。

### 换轨点 5：结构

这是最容易漏的一环。库内 50 条**每条都是独立的一镜**；H3 生成单位是**段**。

- 一段 ≤15 秒，通常装 **3–5 个 `[Shot]`**
- 超过 15 秒 → 拆成多段，**每段一次独立生成**，段间用尾帧承接（见 `references/段落装配规则.md`）
- 50 镜库里的转场镜（1/13/23/24/25/26/27）在 H3 里**多数不是独立镜**，见 §四

---

## 二、三道硬闸

| 闸 | 红线 | 出处 | 超限怎么办 |
|---|------|------|-----------|
| 单段时长 | ≤ 15 秒 | **H3 规范**（4–15 秒） | 拆段；段间用「本段实际末帧」作为下一段 `<Picture N>` 承接 |
| 单段词数 | `detailed_description` **350–500 词** | **H3 规范** | 按 §五 折算与压缩；先判断是否该拆段 |
| 单段字符 | ≤ 7000 字符 | ⚠️ **非 H3 规范所载**，工程／平台预算 | 按 `references/段落装配规则.md` §三 的压缩顺序砍 |
| 一镜一动词 | 每个 `[Shot]` 只保留**一个主运镜** | ⚠️ **非 H3 规范所载**，来自 50 镜镜头库硬经验 | 多余运镜降级为画质修饰，或删 |

> **出处很重要。** H3 规范本身只约束时长与描述粒度，不限制字符总量，也不限制每镜运镜数。
> 后两条是本技能的**工程纪律**，用于降低模型跑偏概率——与人对齐或写交付文档时要标明。
> H3 规范里的其他硬点（`summary` 任务类型前缀、`N/A` 用法、跨切对白标记、可见文字引号等）
> 见 `references/H3硬点清单.md`。

**一镜一动词的 H3 落地形态**：H3 的运镜表达是「运动类型 + 幅度 + 速度」三元组，写成本镜内的自然英文句子，不要堆在句尾贴标签。

```text
正确：The camera pushes in with small amplitude at slow speed toward the folded letter in her hands.
正确：The camera pans right with large amplitude at fast speed, revealing the open doorway.
错误：push in, pan right, tilt up, large amplitude, fast speed.   ← 三元组被拆成标签堆
错误：pulls out with large amplitude ... then settles into a slow push in   ← 两个主运镜
```

中等幅度与常速通常省略不写。

### 一镜一动词的两类例外

实践中会出现两类「看似多动词、其实是同一动作」的写法。判断标准：**两个动词是同一次手势，还是两个独立状态？**

| 写法 | 判定 | 理由 |
|---|---|---|
| `handheld tracking ... the frame shaking strongly once` | **合规** | Shake 是画质修饰，不是第二个运动类型 |
| `tracks left ... rolling slightly with the rotation` | **合规** | Roll 同上（轻微滚转是跟随旋转的画质） |
| `holds a static shot ... then pushes in` | **违规** | 两个独立状态。删掉 `static shot`，用 `holds wide for one beat, then pushes in` 表达「定一拍」 |
| `trucks right ... a snap push in on the contact` | **违规（可转为合规）** | 命中处快推是第二个运动。改成 `the frame shaking strongly once on the contact`，或改成一个插入切镜 |
| `pulls out ... then settles into a slow push in` | **违规** | 两个方向相反的运动，模型会糊 |

**命中强调（impact punch-in）的标准解法**：不要用第二个运动类型，改用 **震机** 或 **插入切镜**。两者都能保住强调节拍，且不违反一镜一动词。

> 校验脚本默认按严格口径判定运镜。若某条片子**有意**采用两段式运镜，用 `--lenient` 把运镜类问题降级为提示，只保留硬性违规。

---

## 三、工作流

### 第 1 步：问清三件事

不足就不要硬猜：

1. 这段的**叙事功能**（开场定调 / 转场 / 打斗 / 心理外化 / 空间交代 / 收尾留白）
2. **总时长**与要分几段（每段 ≤15 秒）
3. **画幅**与参考资产（哪些图是人物锚点、哪些是首尾帧）

### 第 2 步：取镜

按叙事功能查上游技能的 `references/50镜提示词库.md`，**不按编号背**。备选索引见 `references/镜头功能索引.md`（含该库 6 处已知场景标签缺陷清单）。

给出 3–5 个候选 + 推荐 1 个 + 组合建议。

### 第 3 步：排段（先算账，再写字）

1. 按 `references/段落装配规则.md` §一 把每个选定镜折算成 H3 建议时长
2. 累计到 15 秒切成一段，**段尾不要留半镜**
3. 算出每段的切点时间码
4. 按 §二 估字数，超 7000 就先在排段阶段减镜，别写完再砍

### 第 4 步：换轨翻译

逐镜套用 §一 的五个换轨点。**先写 `subject_definitions` 把标签钉死，再写 `detailed_description`**，顺序反了标签一定会飘。

### 第 5 步：声场与配乐

- `overall_soundscape`：全片环境层与物理声（写「贯穿全片」的层次，不写某一镜的事件声）
- `non_diegetic_music`：角色听不到、只有观众能听到的配乐；有则写配器、速度、动态发展
- 同步到某一镜的声音事件、对白，留在 `detailed_description` 里，不要上提

### 第 6 步：跑校验

```bash
"C:/Users/admin/.workbuddy/binaries/python/envs/default/Scripts/python.exe" \
  "<技能目录>/scripts/check_h3_prompt.py" "<你的 H3 提示词文件.md>" [--lenient] [--duration 15]
```

脚本做确定性检查：六段是否齐备、每段字数、时间码是否严格递增且不超段长、是否残留中文占位符、是否出现抽象填充词、标签是否引用未定义、同段是否多主运镜、`retention_analysis` 是否混入 `(Sx)`、`<d>` 是否缺语言标签、是否出现 H3 闭集之外的相机动词。

**校验不通过先改，不要投喂。** 退出码 0 = 通过，1 = 有 FAIL。

---

## 四、转场镜与长镜头的 H3 拆并规则

库里这 9 条**不能直接当一个 `[Shot]` 用**：

| 库镜 | 类型 | H3 处理 |
|---|---|---|
| 1 空镜转场 | 转场 | 可作开场镜，但 1.5 秒过短，拉到 2–4 秒或并入后一镜起幅 |
| 13 焦点转换 | 转场 | **并入本镜**：仅景别／焦点变化时 H3 明确要求优先用运镜，不新起 `[Shot]` |
| 22 蒙太奇 | 剪辑 | 0.5 秒闪切单镜不可执行；拆成 3–5 个 `[Shot]`，每条 0.8–1.2 秒 |
| 23 叠化 / 24 闪白 / 25 黑场 | 转场 | **不是独立镜**，写成镜间过渡语言（cross-dissolve / flash / black），用户明确要求时才用 |
| 26 匹配转场 | 转场 | 两镜配对，**只有配对的后一镜占 `[Shot]` 号** |
| 27 声音转场 | 声画 | 用先声／声画错位实现，配合声场层，不占独立 `[Shot]` 号 |
| 21 长镜头（45 秒） | 剪辑 | 必拆 3–4 段；「一镜到底」的连贯感靠**段间末帧承接**假造 |
| 49 渐显 / 50 渐隐 | 起承转合 | 归入首镜起幅／末镜落幅，各 3–5 秒，不单独占镜 |

**21 号长镜头的接帧写法**：每段末尾用一个明确的定格姿态收尾，把该帧描述写进下一段 `subject_definitions`：

```text
<Picture 3> is the last frame of the previous segment, showing the fighter's rear foot
planted at the edge of the wet flagstones with the torso already turned away from camera.
```

### 插入镜的内联写法

当插入的特写**只是同一空间、同一动作的景别变化**时，不要新起 `[Shot]` 号，在本镜句内写成插入拍：

```text
[Shot 2] ... (S2) drives a knee up into (S1)'s midsection; (S1) bars it with both forearms.
A 0.3-second 100mm macro holds on the knee compressing her forearms before the camera
snaps back to full bodies.
```

依据：H3 规定「若只需改变距离或轻微角度，优先用运镜」。这条写法能把 15 秒里的镜号数压到 4–5 个，同时保住特写节奏。

---

## 五、字数预算

### 5.1 第一约束：规范词数（不是字符数）

H3 规范对 `detailed_description` 的要求是 **350–500 英文单词**，这是**唯一有出处的粒度约束**。

按实测英文比例（1 词 ≈ 5.85 字符）折算：

| 口径 | 对应区间 |
|---|---|
| 规范下限 350 词 | ≈ 2050 字符 |
| 规范上限 500 词 | ≈ 2930 字符 |
| 5 镜均分 500 词 | **≤ 100 词／镜** |
| 5 镜均分 350 词 | 70 词／镜 |

### 5.2 实测分布（作为工程预算参考）

下表是已验证的 15 秒五镜段实测值。**注意：`detailed_description` 一栏实测已越出规范的 350–500 词区间**，属工程上的超投；引用时不要把它当规范值。

| section | 实测字符 | 对应词数 | 与规范对照 |
|---|---|---|---|
| `subject_definitions` | 900–1300 | — | 规范未限 |
| `summary` | 400–500 | — | 规范：1 短段 |
| `retention_analysis` | 440–590 | — | 规范：每个标签一行 |
| `detailed_description` | 3300–3700 | **570–623** | ⚠️ **超出规范上限约 14–25%** |
| `overall_soundscape` | 240–300 | — | 规范：1–4 句 |
| `non_diegetic_music` | 170–260 | — | 规范：1–3 句 |
| **合计** | **5900–6400** | | |

### 5.3 定预算的顺序

1. **先看词数**：`detailed_description` 目标 350–500 词。超了先判断「是不是该拆段」，而不是急着删字
2. **再看字符**：项目/平台若另有输入上限（如 7000 字符），按 §5.2 的分布反推余量
3. 六段固定开销（除 `detailed_description` 外）实测 ≈ **2000–2600 字符**
4. 按此推算：7000 字符预算下，`detailed_description` 余量 ≈ 4600 字符（≈ 780 词）——**远宽于规范的 500 词上限，说明这台预算的真正瓶颈是词数，不是字符数**

**结论：约束优先级是「词数 > 字符数」。** 先满足 350–500 词，再考虑段内镜数与细节密度。

压缩顺序见 `references/段落装配规则.md` §三。

---

## 六、收敛与约束

### 场景词收敛（同片必须统一成一套）

同一片子的场景词先定表，再套镜头模板，否则模型串场。库里原文的场景词互相冲突（古寺／旧公寓／废墟／赛博城市／沙漠混着来），**必须整段改写**，不能只替换名词。

同一套场景词汇要在**每一条 `detailed_description` 里重复同一组名词**，不要换同义词。示例：全片固定用 `daytime market street` / `banner pole` / `stall trestle` / `bamboo baskets` / `hard warm sunlight`，不要一会儿 `market` 一会儿 `bazaar`。

### 背景人群／群众演员约束

需要「人流涌动的街道」这类环境人群，又必须保证主角唯一时，用**环境层**写法，并在每一段 `detailed_description` 重复同一句约束：

```text
only the two fighters are in sharp focus and only they perform any action — the crowd stays a soft,
unreadable blur at the frame edges and in the background, never entering the central action area,
never touching either fighter, and never resolving into a recognisable face
```

四个约束点缺一不可：**虚化层 → 不做动作 → 不进入中央区 → 不成可辨认的脸**。

若生成的画面里人群过实，**优先加强这一句**，不要去调运镜。

---

## 七、交付自检

**结构层（以 `h3-prompt-writing` 为准，详见 `references/H3硬点清单.md`）**

- [ ] 六个 section 齐备且顺序正确：`subject_definitions` → `summary` → `retention_analysis` → `detailed_description` → `overall_soundscape` → `non_diegetic_music`
- [ ] `summary` 以方括号任务类型前缀开头，多类型用 ` + ` 组合且不重复
- [ ] `summary` 里未引入新标签
- [ ] `detailed_description` 落在 350–500 词
- [ ] `overall_soundscape` 为 1–4 句，且未重复对白／唱段／diegetic music
- [ ] `non_diegetic_music` 为 1–3 句；**无配乐时写 `N/A`**
- [ ] 画面可见文字用英文双引号包住、原文逐字未译
- [ ] 跨切对白标了 `<scenetrans>`，被截断的对白标了 `<cutoff>`
- [ ] `[Shot 1]` 无时间码；后续切点严格递增
- [ ] `<d>` 内对白为原语言、逐字未改，且每个发声源有稳定 `(Sx)`
- [ ] `retention_analysis` 里不写 `(Sx)`，且每个标签一行
- [ ] 无未定义即引用的参考标签
- [ ] 每段 ≤15 秒

**换轨层（本技能的工程纪律）**

- [ ] 每个 `[Shot]` 只有一个主运镜，且写成「运动类型 + 幅度 + 速度」自然句
- [ ] 布光镜（40–48）除 44／47 外全部是 `Static`，未加运镜
- [ ] 氛围镜（32–39）单段内不超过 2 条，且各压到 4 秒内
- [ ] 无残留 `[角色名]`、`[场景：…]`
- [ ] 全片场景词为同一套，无同义词漂移
- [ ] 若项目另有字符上限，未超
- [ ] 跑过 `scripts/check_h3_prompt.py`

---

## 八、与其他技能的分工

**结构权威在 `h3-prompt-writing`。** 六个 section 的字段含义、标签规则、时间码语法、对白语法、
`summary` 任务类型前缀、声场两字段的句数与 `N/A` 规则，一律**以它的 references 为准**。
本技能只引用、不重定义；两者说法不一致时以它为准，并回头修本技能。

| 技能 | 职责 | 边界 |
|---|---|---|
| `cinematic-shot-prompt-expert` | 拆解、定功能、选镜、给出镜头组合 | 只管「拍什么」，输出仍是中文单镜提示词 |
| `h3-prompt-writing` | **结构权威**：六段式字段、标签规则、时间码、对白与声场语法 | 只管「字段长什么样」，不管镜头从哪来，也不管镜头库怎么用 |
| **本技能** | 把中文单镜选镜结果换轨成合规英文段落，并施加镜头库的工程纪律 | 不做选镜创意，**不重定义任何字段**；引入的四条工程纪律（一镜一动词／字符预算／场景词收敛／段间接帧）**非 H3 规范所载**，见 `references/H3硬点清单.md` §十 |
| `character-consistency-prompt` | 人物外貌锚点与出图提示词 | 管静态图阶段，不管 H3 段落装配 |
| `script-to-storyboard` | 剧本转分镜表（14 项字段、无 BGM、0.6–0.7 秒/帧） | 影视分镜口径，与本技能有 3 处冲突，见 `references/段落装配规则.md` §五 |

**可以同时激活。** 两个技能的触发词高度重叠（都含「H3 提示词／六段式」），但层次不同：
一个给结构，一个给换轨。同时命中时按「结构问题问 `h3-prompt-writing`，选镜与落地问本技能」分流。

---

## 参考资料

| 文件 | 内容 |
|---|---|
| `references/H3硬点清单.md` | 换轨时最容易漏的 H3 规范硬点：`summary` 任务类型前缀、词数、声场 `N/A` 规则、跨切对白标记、可见文字引号、各模式关键帧口径；并附「本技能引入的非规范纪律」出处表 |
| `references/换轨映射表.md` | 中文运镜词到 H3 运镜三元组的逐词映射、景别／焦段／光位对照、文体改写前后对照 |
| `references/段落装配规则.md` | 时长折算表、切点计算、字数压缩顺序、段间接帧模板、与其他技能的冲突处理 |
| `references/镜头功能索引.md` | 50 镜按叙事功能的检索索引、7 处已知素材缺陷、适合 H3 的镜头组合配方 |
| `scripts/check_h3_prompt.py` | 确定性校验脚本（六段齐备／词数／字符／时间码／占位符／抽象词／标签引用／主运镜数／`summary` 前缀／声场 `N/A`） |
