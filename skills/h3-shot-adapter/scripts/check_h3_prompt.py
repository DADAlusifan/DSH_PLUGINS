#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
check_h3_prompt.py — MiniMax H3 提示词确定性校验器

用法:
    python check_h3_prompt.py <文件路径> [--duration 15] [--max-chars 7000] [--lenient] [--json]

检查项（分两层）:

  【H3 规范层】权威定义在 h3-prompt-writing 的 references/
    [FAIL] 六个 section 是否齐备且顺序正确
    [FAIL] summary 是否以方括号任务类型前缀开头、类型是否合法且不重复
    [FAIL] overall_soundscape 是否混入对白／说话人
    [FAIL] 时间码是否严格递增、是否超出段长、首镜是否误带时间码
    [FAIL] 是否残留中文占位符 [角色名] / [场景：...]
    [FAIL] 是否引用了未定义的参考标签
    [FAIL] retention_analysis 里是否出现 (Sx)
    [FAIL] <d> 块是否缺少语言标签、是否未闭合
    [WARN] detailed_description 词数是否落在规范的 350-500 词
    [WARN] overall_soundscape / non_diegetic_music 句数与非 N/A 用法

  【换轨工程层】本技能引入，非 H3 规范所载
    [FAIL] 单段字符数是否超过工程预算（默认 7000，可用 --max-chars 改）
    [FAIL] 单个 [Shot] 内是否出现多个主运镜
    [WARN] 抽象填充词、H3 闭集之外的相机动词、medium 幅度速度、氛围镜／布光镜配额

只依赖标准库。
"""

import argparse
import json
import os
import re
import sys

# ---------------------------------------------------------------- 常量

SECTIONS = [
    "subject_definitions",
    "summary",
    "retention_analysis",
    "detailed_description",
    "overall_soundscape",
    "non_diegetic_music",
]

SECTION_RE = re.compile(
    r"(?m)^(\s*)(%s)\s*:" % "|".join(SECTIONS)
)

MAX_CHARS = 7000
MAX_SHOT_SECONDS = 15

# 参考标签
LABEL_RE = re.compile(r"<(Subject|Picture|Video|Audio)\s+(\d+)>")

# [Shot N]
SHOT_RE = re.compile(r"\[Shot\s+(\d+)\]")

# summary 的任务类型前缀（H3 规范）
TASK_TYPES = {
    "keyframe completion",
    "reference generation",
    "video editing",
    "video continuation",
    "audio reuse",
    "audio reference",
}

# 英文词计数
WORD_RE = re.compile(r"[A-Za-z][A-Za-z'\u2019-]*")

# At MM:SS.mmm
TIMECODE_RE = re.compile(r"At\s+(\d{2}):(\d{2})\.(\d{3})")

# 残留占位符
PLACEHOLDER_PATTERNS = [
    (re.compile(r"\[角色名\]"), "[角色名]"),
    (re.compile(r"\[场景[：:]"), "[场景：...]"),
    (re.compile(r"\[主体\d*\]"), "[主体N]"),
    (re.compile(r"\[场景名\]"), "[场景名]"),
    (re.compile(r"\[name\]", re.I), "[name]"),
    (re.compile(r"\[character\]", re.I), "[character]"),
    (re.compile(r"\[scene[：:]?"), "[scene...]"),
    (re.compile(r"\{[^}\n]{0,20}(角色|场景|主体)[^}\n]{0,20}\}"), "{角色/场景/主体}"),
]

# H3 闭集运镜类型
MOTION_PATTERNS = [
    ("Zoom In/Out", re.compile(r"\bzooms?(?:ing)?\s+(?:in|out)\b", re.I)),
    ("Push In", re.compile(r"\bpush(?:es|ing)?\s+in\b", re.I)),
    ("Pull Out", re.compile(r"\bpull(?:s|ing)?\s+out\b", re.I)),
    ("Pan", re.compile(r"\bpan(?:s|ning)?\s+(?:left|right)\b", re.I)),
    ("Truck", re.compile(r"\btruck(?:s|king)?\s+(?:left|right)\b", re.I)),
    ("Tilt", re.compile(r"\btilt(?:s|ing)?\s+(?:up|down)\b", re.I)),
    ("Pedestal", re.compile(r"\bpedestal(?:s|ing)?\s+(?:up|down)\b", re.I)),
    ("Arc", re.compile(r"\barc(?:s|ing)\s+(?:shot|right|left|around|over|half|clockwise|counterclockwise|wide)\b", re.I)),
    # 跟拍的几种写法：tracking shot / handheld tracking medium full shot / a fast lateral track
    # 但不抓插入镜里的 "a close-up that tracks along the trails"
    ("Tracking", re.compile(r"\btracking\b|\b(?:lateral|sideways|slow|fast)\s+tracks?\b|\bthe\s+camera\s+tracks?\b", re.I)),
    ("Static", re.compile(r"\bstatic\s+shot\b", re.I)),
    ("Shake", re.compile(r"\bshak(?:e|es|ing)\s+(?:slightly|strongly)\b", re.I)),
    ("POV", re.compile(r"\bp\.?o\.?v\.?\b", re.I)),
    ("Roll", re.compile(r"\broll(?:s|ing)?\s+(?:slightly|clockwise|counterclockwise)\b", re.I)),
    # 实拍口语里的"命中处快推"，在 H3 里没有独立词，实质是 Push In
    ("Push In", re.compile(r"\b(?:punch(?:es|ing)?|snap(?:s|ping)?)\s+in\b", re.I)),
]

# 一镜一动词里，可作画质修饰与运动类型共存的项
MOTION_MODIFIERS = {"Shake", "Roll"}

# H3 闭集之外的相机动词（信息性提示，非硬伤）
NON_H3_CAMERA_RE = re.compile(
    r"\bthe camera\s+(widens|narrows|follows|drifts|snaps|rises|lifts|opens|"
    r"releases|settles|swings|drops|walks|locks)\b",
    re.I,
)

# 「先定住、再运动」写法（属两段式运镜，需人工判断是否保留）
HOLD_THEN_MOVE_RE = re.compile(
    r"\b(?:holds?|holds\s+the\s+look|stays?|remains?|settles?)\b[^.]{0,60}?"
    r"\bthen\s+(?:pushes?|pulls?|pans?|trucks?|tilts?|pedestals?|arcs?|rolls?|"
    r"tracks?|cuts?|widens?|snaps?|punch(?:es|ing)?)\b",
    re.I,
)

# 抽象填充词（只在 detailed_description 的 [Shot] 块内检查）
ABSTRACT_CN = [
    "电影级", "极致", "张力拉满", "张力十足", "尽显", "凸显", "毫发毕现",
    "视觉冲击", "行云流水", "凄美", "唯美", "意境悠远", "余音绕梁",
    "如火如荼", "美轮美奂", "震撼", "惊艳", "氛围感拉满", "燃爆", "炸裂",
]
ABSTRACT_EN = [
    "perfectly", "extremely", "stunning", "breathtaking", "epic",
    "beautiful", "amazing", "incredible", "awe-inspiring", "masterpiece",
]

# 氛围镜与布光镜的功能词（用于配额检查）
ATMOSPHERE_HINTS = re.compile(
    r"\b(?:mist|fog|smoke|rain|snow|candle|moonlight|sunset|sunrise|reflection)\b",
    re.I,
)
LIGHTING_HINTS = re.compile(
    r"\b(?:Rembrandt|butterfly shadow|ring-shaped catchlight|split exactly down the bridge|"
    r"rim of backlight|45-degree side light|flat frontal light|vertical shaft of light)\b",
    re.I,
)


# ---------------------------------------------------------------- 工具

def strip_ansi(s):
    return re.sub(r"\x1b\[[0-9;]*m", "", s)


class Report:
    def __init__(self):
        self.items = []   # (level, where, message)

    def fail(self, where, msg):
        self.items.append(("FAIL", where, msg))

    def warn(self, where, msg):
        self.items.append(("WARN", where, msg))

    def ok(self, where, msg):
        self.items.append(("OK", where, msg))

    @property
    def fails(self):
        return [i for i in self.items if i[0] == "FAIL"]

    @property
    def warns(self):
        return [i for i in self.items if i[0] == "WARN"]


def tc_to_seconds(m):
    return int(m.group(1)) * 60 + int(m.group(2)) + int(m.group(3)) / 1000.0


def parse_blocks(text):
    """切出待检查的提示词块。优先取围栏代码块；没有则整文件当一块。"""
    blocks = re.findall(r"```[a-zA-Z0-9_-]*\n(.*?)```", text, re.S)
    if blocks:
        return [b for b in blocks if b.strip()]
    return [text]


def split_sections(block):
    """返回 [(name, start, end), ...]，按出现位置排序。"""
    hits = []
    for m in SECTION_RE.finditer(block):
        hits.append((m.group(2), m.start(), m.end()))
    if not hits:
        return []
    out = []
    for i, (name, s, e) in enumerate(hits):
        end = hits[i + 1][1] if i + 1 < len(hits) else len(block)
        out.append((name, s, end))
    return out


# ---------------------------------------------------------------- 单项检查

def check_sections(block, rep, tag):
    """六段齐备 + 顺序正确。返回 {name: text}"""
    secs = split_sections(block)
    names = [n for n, _, _ in secs]
    if not names:
        rep.fail(tag, "找不到任何 section 标题（六段式可能写成了别的形式）")
        return {}

    missing = [s for s in SECTIONS if s not in names]
    if missing:
        rep.fail(tag, "缺少 section: " + ", ".join(missing))

    # 去重后检查顺序
    seen = []
    for n in names:
        if n not in seen:
            seen.append(n)
    expected = [s for s in SECTIONS if s in seen]
    if seen != expected:
        rep.fail(tag, "section 顺序错误。实际: %s ｜ 期望: %s" % (" → ".join(seen), " → ".join(expected)))
    elif not missing:
        rep.ok(tag, "六段齐备且顺序正确")

    if len(seen) != len(names):
        dup = [n for n in set(names) if names.count(n) > 1]
        rep.warn(tag, "section 标题重复出现: " + ", ".join(sorted(dup)))

    out = {}
    for name, s, e in secs:
        if name not in out:
            out[name] = block[s:e]
    return out


def check_length(block, secs, rep, tag):
    total = len(block)
    detail = ""
    if secs:
        sizes = {k: len(v) for k, v in secs.items()}
        detail = " ｜ " + " / ".join(
            "%s %d" % (k.replace("_", " "), sizes[k]) for k in SECTIONS if k in sizes
        )
    if total > MAX_CHARS:
        rep.fail(tag, "总字符 %d 超过工程预算 %d（+%d）。注意：这不是 H3 规范的限制，"
                      "H3 规范只约束描述词数（350-500 词）%s"
                 % (total, MAX_CHARS, total - MAX_CHARS, detail))
    elif total > MAX_CHARS * 0.97:
        rep.warn(tag, "总字符 %d，逼近工程预算 %d（余量仅 %d）%s"
                 % (total, MAX_CHARS, MAX_CHARS - total, detail))
    else:
        rep.ok(tag, "总字符 %d / %d（工程预算）%s" % (total, MAX_CHARS, detail))

    if "detailed_description" in secs:
        dd = len(secs["detailed_description"])
        if dd > 4600:
            rep.warn(tag, "detailed_description 占 %d 字符，超过按 7000 预算推算的余量约 4600" % dd)


def check_shots(secs, rep, tag, duration, lvl="FAIL"):
    dd = secs.get("detailed_description")
    if not dd:
        return
    matches = list(SHOT_RE.finditer(dd))
    if not matches:
        rep.fail(tag, "detailed_description 里没有 [Shot N] 标记")
        return

    nums = [int(m.group(1)) for m in matches]
    expect = list(range(1, len(nums) + 1))
    if nums != expect:
        rep.fail(tag, "[Shot N] 编号不连续。实际: %s" % nums)

    shots = []
    for i, m in enumerate(matches):
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(dd)
        shots.append((nums[i], dd[start:end]))

    # 首镜不得带时间码
    tc_first = TIMECODE_RE.search(shots[0][1])
    if tc_first:
        rep.fail(tag, "[Shot 1] 不应带时间码（发现 %s）" % tc_first.group(0))

    # 后续镜时间码严格递增
    prev = -1.0
    times = []
    for idx, (n, chunk) in enumerate(shots):
        if idx == 0:
            times.append(0.0)
            continue
        m = TIMECODE_RE.search(chunk)
        if not m:
            rep.fail(tag, "[Shot %d] 缺少切点时间码（应为 'At MM:SS.mmm, ...'）" % n)
            times.append(None)
            continue
        t = tc_to_seconds(m)
        times.append(t)
        # 时间码应出现在本镜开头
        if m.start() > 120:
            rep.warn(tag, "[Shot %d] 的时间码出现在第 %d 字符处，应紧跟镜号" % (n, m.start()))
        if t <= prev:
            rep.fail(tag, "[Shot %d] 时间码 %s 未严格大于上一镜（%.3f 秒）" % (n, m.group(0), prev))
        prev = t
        if t >= duration:
            rep.fail(tag, "[Shot %d] 时间码 %s 已达/超过段长 %d 秒" % (n, m.group(0), duration))

    valid = [t for t in times if t is not None]
    if valid and max(valid) < duration:
        rep.ok(tag, "%d 个 [Shot]，切点 %s，段长 %d 秒内" % (
            len(matches), ", ".join("%.3f" % t for t in valid[1:]) if len(valid) > 1 else "（无后续镜）", duration))

    if len(matches) > 6:
        rep.warn(tag, "单段 %d 个 [Shot]，偏多。5 镜封顶是安全线（700 字符/镜）" % len(matches))

    # 单镜多主运镜
    # 口径：Shake / Roll 是画质修饰，可与运动类型共存（如 handheld tracking + shake）；
    #       Static 与任何运动类型互斥；两个不同的运动类型共存 = 一镜多动词。
    for n, chunk in shots:
        found = []
        for name, pat in MOTION_PATTERNS:
            if pat.search(chunk) and name not in found:
                found.append(name)
        moving = [f for f in found if f not in MOTION_MODIFIERS and f != "Static"]
        mods = [f for f in found if f in MOTION_MODIFIERS]

        def report(level, msg):
            (rep.fail if level == "FAIL" else rep.warn)(tag, msg)

        if "Static" in found and moving:
            report(lvl, "[Shot %d] 同时出现 Static 与 %s，自相矛盾（一镜一动词）"
                   % (n, " + ".join(moving)))
        elif len(moving) > 1:
            report(lvl, "[Shot %d] 出现 %d 个主运镜（%s），违反一镜一动词。"
                   "修法二选一：删掉次运镜；或把次运镜改成震机（画质修饰）／插入切镜"
                   % (n, len(moving), " + ".join(moving)))
        elif len(moving) == 1 and mods:
            rep.ok(tag, "[Shot %d] %s 作主运镜 + %s 作画质修饰，合规"
                   % (n, moving[0], "/".join(mods)))

        if HOLD_THEN_MOVE_RE.search(chunk) and len(moving) <= 1:
            # 说明：`hold` / `stay` / `settle` 不是 H3 运镜类型，只是节拍词。
            # 「定一拍 → 再运动」里主运镜只有一个，**不违反一镜一动词**，故只作提示，
            # 不随 --lenient 降级——它在两种口径下都只是 advisory。
            rep.warn(tag, "[Shot %d] 用了「先定住、再运动」的两段式表述；主运镜只有一个，"
                          "合规，仅提示确认节奏是否符合预期" % n)

    # H3 闭集之外的相机动词（信息性）
    outside = sorted(set(m.lower() for m in NON_H3_CAMERA_RE.findall(dd)))
    if outside:
        rep.warn(tag, "出现 H3 闭集之外的相机动词: the camera %s。H3 运镜表只有 "
                      "Zoom/Push/Pull/Pan/Truck/Tilt/Pedestal/Arc/Tracking/Static/Shake/POV/Roll"
                      % ", ".join(outside))

    # medium / normal 幅度速度（H3 建议省略，非硬伤）
    med = len(re.findall(r"\b(?:at\s+medium\s+speed|with\s+medium\s+amplitude)\b", dd, re.I))
    if med:
        rep.warn(tag, "发现 %d 处 medium 幅度/速度修饰。H3 规定中幅与常速通常省略（默认值），可精简" % med)

    # 插入镜节奏：以 "N-second" 形式描述的内联插入
    inserts = re.findall(r"\b(\d+(?:\.\d+)?)-second\b", dd)
    if inserts:
        rep.ok(tag, "内联插入镜 %d 处（时长 %s 秒）" % (len(inserts), ", ".join(inserts)))


def check_placeholders(block, rep, tag):
    hits = []
    for pat, label in PLACEHOLDER_PATTERNS:
        if pat.search(block):
            hits.append(label)
    if hits:
        rep.fail(tag, "残留未替换的占位符: " + ", ".join(sorted(set(hits))))
    else:
        rep.ok(tag, "无残留占位符")


def check_labels(secs, rep, tag):
    if not secs:
        return
    defined = set()
    if "subject_definitions" in secs:
        for m in LABEL_RE.finditer(secs["subject_definitions"]):
            defined.add(m.group(0))
    else:
        rep.warn(tag, "没有 subject_definitions，无法校验参考标签")

    used = set()
    where = {}
    for name in SECTIONS:
        if name == "subject_definitions" or name not in secs:
            continue
        for m in LABEL_RE.finditer(secs[name]):
            used.add(m.group(0))
            where.setdefault(m.group(0), set()).add(name)

    undef = sorted(used - defined)
    if undef:
        for lbl in undef:
            rep.fail(tag, "引用了未定义的参考标签 %s（出现在 %s）" % (lbl, ", ".join(sorted(where[lbl]))))
    elif used:
        rep.ok(tag, "参考标签自洽：定义 %d 个，引用 %d 个" % (len(defined), len(used)))

    # 定义了但从未引用
    # 注意：按 H3 规则，仅用于定义人物/场景/服装/风格的图，应当被**内引**在 <Subject N> 定义里，
    # 不单独开条目、也不需要进 retention_analysis。所以只对「独立条目」（形如 `<X N>` is ...）
    # 做未引用提示，避免把正确写法误报。
    standalone_names = set(re.findall(r"`?<((?:Subject|Picture|Video|Audio)\s+\d+)>`?\s+is\b",
                                      secs.get("subject_definitions", "")))
    unused = sorted(lbl for lbl in (defined - used)
                    if lbl.strip("<>").strip() in standalone_names)
    if unused:
        rep.warn(tag, "独立定义了但正文未引用: " + ", ".join(unused))

    # retention_analysis 里不得写 (Sx)
    if "retention_analysis" in secs:
        sp = re.findall(r"\(S\d+(?:,S\d+)*\)", secs["retention_analysis"])
        if sp:
            rep.fail(tag, "retention_analysis 里不应出现说话人 ID: " + ", ".join(sorted(set(sp))))


def check_dialogue(secs, rep, tag):
    dd = secs.get("detailed_description", "")
    if not dd:
        return
    blocks = re.findall(r"<d>(.*?)</d>", dd, re.S)
    bad = [b for b in blocks if not b.lstrip().startswith("[")]
    if bad:
        rep.fail(tag, "%d 处 <d> 块缺少语言标签（应为 <d>[Language] ...</d>）" % len(bad))
    elif blocks:
        langs = sorted(set(re.findall(r"<d>\[([^\]]+)\]", dd)))
        rep.ok(tag, "对白 %d 处，语言标签: %s" % (len(blocks), ", ".join(langs)))

    # 说话人 ID
    speakers = re.findall(r"\((S\d+)(?:,S\d+)*\)", dd)
    if blocks and not speakers:
        rep.fail(tag, "有 <d> 对白但找不到任何 (Sx) 说话人 ID")
    elif speakers:
        rep.ok(tag, "说话人 ID: " + ", ".join(sorted(set(speakers), key=lambda s: int(s[1:]))))

    # 未闭合的 <d>
    if dd.count("<d>") != dd.count("</d>"):
        rep.fail(tag, "<d> 与 </d> 数量不匹配（%d / %d）" % (dd.count("<d>"), dd.count("</d>")))


def check_abstract(secs, rep, tag):
    dd = secs.get("detailed_description")
    if not dd:
        return
    hits = []
    for w in ABSTRACT_CN:
        if w in dd:
            hits.append(w)
    low = dd.lower()
    for w in ABSTRACT_EN:
        if re.search(r"\b%s\b" % re.escape(w), low):
            hits.append(w)
    if hits:
        rep.warn(tag, "detailed_description 内出现抽象填充词: " + ", ".join(sorted(set(hits)))
                  + "（H3 要求具体视听细节，建议删除并用景别/光位/材质顶替）")
    else:
        rep.ok(tag, "未发现抽象填充词")


def check_quota(secs, rep, tag):
    dd = secs.get("detailed_description")
    if not dd:
        return
    atmos = len(ATMOSPHERE_HINTS.findall(dd))
    light = len(LIGHTING_HINTS.findall(dd))
    if atmos > 4:
        rep.warn(tag, "氛围类描述出现 %d 处，单段偏多（氛围镜连续不超过 2 条）" % atmos)
    if light > 3:
        rep.warn(tag, "布光类描述出现 %d 处，单段偏多（布光镜单段不超过 2 条）" % light)


# ---------------------------------------------------------------- 主流程

def check_spec(secs, rep, tag, lvl):
    """H3 规范硬点检查。权威定义在 h3-prompt-writing 的 references/。"""
    # --- summary 必须以方括号任务类型前缀开头 ---
    if "summary" in secs:
        body = secs["summary"].split(":", 1)[-1]
        m = re.match(r"\s*\[([^\]]+)\]", body)
        if not m:
            rep.fail(tag, "summary 未以方括号任务类型前缀开头。应为 [keyframe completion] / "
                          "[reference generation] / [video editing] / [video continuation] / "
                          "[audio reuse] / [audio reference]，多类型用 ` + ` 组合")
        else:
            types = [x.strip() for x in m.group(1).split("+")]
            bad = [x for x in types if x not in TASK_TYPES]
            dup = sorted(set(x for x in types if types.count(x) > 1))
            if bad:
                rep.fail(tag, "summary 任务类型含未知值: " + ", ".join(bad))
            elif dup:
                rep.fail(tag, "summary 任务类型重复出现: " + ", ".join(dup))
            else:
                rep.ok(tag, "summary 任务类型前缀: [%s]" % " + ".join(types))
            if re.search(r"<(?:Subject|Picture|Video|Audio)\s+\d+>", m.group(0)):
                rep.warn(tag, "任务类型前缀方括号内不应包含参考标签")

    # --- detailed_description 词数（规范：350-500 英文单词） ---
    dd = secs.get("detailed_description")
    if dd:
        words = len(WORD_RE.findall(dd))
        if words > 500:
            rep.warn(tag, "detailed_description %d 词，超出规范区间 350-500（+%d）。"
                          "规范豁免：对话密集内容以说满对白时间线优先；视频剪辑类不受此限"
                          % (words, words - 500))
        elif words < 350:
            rep.warn(tag, "detailed_description %d 词，低于规范区间 350-500（-%d）" % (words, 350 - words))
        else:
            rep.ok(tag, "detailed_description %d 词，落在规范区间 350-500" % words)

    # --- 声场两字段：句数与 N/A ---
    for field, lo, hi, na_rule in (
        ("overall_soundscape", 1, 4, "only_silence"),
        ("non_diegetic_music", 1, 3, "no_music"),
    ):
        if field not in secs:
            continue
        body = secs[field].split(":", 1)[-1].strip()
        if body.upper() == "N/A":
            if na_rule == "no_music":
                rep.ok(tag, "%s: N/A（无配乐时的规定写法）" % field)
            else:
                rep.warn(tag, "%s 写了 N/A。规范只在**用户明确要求全片完全静音**时才用 N/A" % field)
            continue
        if not body:
            rep.fail(tag, "%s 为空。应为 1-%d 句，或按规范写规定值" % (field, hi))
            continue
        n = len([s for s in re.split(r"(?<=[.!?])\s+", body) if s.strip()])
        if n > hi:
            rep.warn(tag, "%s 约 %d 句，超出规范建议的 1-%d 句" % (field, n, hi))
        elif n < lo:
            rep.warn(tag, "%s 不足 %d 句" % (field, lo))
        else:
            rep.ok(tag, "%s 约 %d 句，符合 1-%d 句" % (field, n, hi))
        if field == "overall_soundscape" and ("<d>" in body or "(S" in body):
            rep.fail(tag, "overall_soundscape 里重复了对白／说话人。对白与 diegetic 音乐应只留在 "
                          "detailed_description")

    # --- 可见文字与跨切对白标记（信息性） ---
    if dd:
        if re.search(r'"[^"\n]*[\u4e00-\u9fff][^"\n]*"', dd):
            rep.ok(tag, "画面可见中文文字已用英文双引号包住")
        elif "read" not in dd.lower():
            pass
        if "<scenetrans>" in dd and not re.search(
                r"continue|carry|carries|remains audible|across the (?:cut|transition)", dd, re.I):
            rep.warn(tag, "用了 <scenetrans> 但未见跨切延续的明确表述")


def check_block(block, idx, rep, duration, lvl="FAIL"):
    tag = "第 %d 块" % (idx + 1)
    if not block.strip():
        return
    secs = check_sections(block, rep, tag)
    check_length(block, secs, rep, tag)
    check_spec(secs, rep, tag, lvl)
    check_shots(secs, rep, tag, duration, lvl)
    check_placeholders(block, rep, tag)
    check_labels(secs, rep, tag)
    check_dialogue(secs, rep, tag)
    check_abstract(secs, rep, tag)
    check_quota(secs, rep, tag)


def main():
    global MAX_CHARS
    ap = argparse.ArgumentParser(
        description="MiniMax H3 提示词确定性校验器。结构层以 h3-prompt-writing 规范为准，"
                    "运镜与字符预算为本技能引入的工程纪律（非 H3 规范）。")
    ap.add_argument("path", help="H3 提示词文件（.md / .txt）")
    ap.add_argument("--duration", type=float, default=MAX_SHOT_SECONDS,
                    help="单段时长上限（秒），默认 15。这是 H3 规范值")
    ap.add_argument("--max-chars", type=int, default=MAX_CHARS,
                    help="单段字符工程预算，默认 %d。**非 H3 规范所载**，按实际平台输入上限调整"
                         % MAX_CHARS)
    ap.add_argument("--json", action="store_true", help="以 JSON 输出")
    ap.add_argument("--lenient", action="store_true",
                    help="把运镜类问题降级为 WARN（当项目有意采用两段式运镜时使用）")
    args = ap.parse_args()
    MAX_CHARS = args.max_chars

    if not os.path.isfile(args.path):
        print("找不到文件: %s" % args.path, file=sys.stderr)
        sys.exit(2)

    with open(args.path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()

    blocks = parse_blocks(text)
    rep = Report()
    lvl = "WARN" if args.lenient else "FAIL"
    for i, b in enumerate(blocks):
        check_block(b, i, rep, args.duration, lvl)

    if not blocks or all(not b.strip() for b in blocks):
        rep.fail("文件", "没有可检查的内容")

    if args.json:
        print(json.dumps({
            "file": args.path,
            "blocks": len(blocks),
            "fails": [{"where": w, "message": m} for _, w, m in rep.fails],
            "warns": [{"where": w, "message": m} for _, w, m in rep.warns],
            "passed": len(rep.fails) == 0,
        }, ensure_ascii=False, indent=2))
    else:
        print("=" * 72)
        print("H3 提示词校验  %s" % args.path)
        print("块数 %d ｜ 单段上限 %g 秒（规范）｜ 字符预算 %d（工程，非规范）"
              % (len(blocks), args.duration, MAX_CHARS))
        print("=" * 72)
        cur = None
        for level, where, msg in rep.items:
            if where != cur:
                print("\n[%s]" % where)
                cur = where
            mark = {"FAIL": "  x ", "WARN": "  ! ", "OK": "  . "}[level]
            print("%s%s" % (mark, msg))
        print()
        print("-" * 72)
        print("结果: FAIL %d ｜ WARN %d ｜ %s"
              % (len(rep.fails), len(rep.warns),
                 "通过，可以投喂" if not rep.fails else "未通过，先修再投喂"))
        print("-" * 72)

    sys.exit(1 if rep.fails else 0)


if __name__ == "__main__":
    main()
