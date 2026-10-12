#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""check_storyboard.py — 分镜提示词一体式校验脚本（"四把尺子"）

用于校验"每章一份"的视频分镜提示词文件是否符合规范：
  1. 密度   每拍 <=3 件事（末帧交代句不计；引号内台词不拆件事数）
  2. 超线   每拍台词 <=18 字
  3. 结构   视频节数=段数；①—⑤各出现段数次；末帧行数=段数；路线行数=段数；
            文件名秒数/段数 与 标题行一致
  4. 服装词 禁用词命中（声明行自动跳过、引号/粗体引用自动豁免）

台词双口径说明：
  - 完整句口径（FAIL 条件）：只统计"以句末标点结尾"或"紧跟动词+冒号"的引文
    （对齐全量返工验收口径：保证没有"一整句挤在一拍"）。
  - 全量口径（默认 WARN，--strict 时升级为 FAIL）：统计拍内全部口语引文合计
    （含半截句；自动排除心声/内白、跳过舞台指示类引用），
    ——这是"说出口的字数"的物理上限，建议人工复核超线项。

服装词双级别：
  - 生成层（FAIL）：## 视频 N 节内的命中——直接投喂层，必须为 0。
  - 说明层（WARN）：导语/路线表/节标题等处的命中——多为原文引用与戏眼描述，人工确认。

用法：
  python check_storyboard.py <文件或目录> [...]
  python check_storyboard.py ./视频提示词
  python check_storyboard.py SC101_*.md --beats

可选参数：
  --glob PATTERN       目录扫描模式（默认 SC*.md）
  --beats              打印每拍明细（事数/台词/心声）
  --summary            只输出汇总
  --strict             全量台词口径超线升级为 FAIL
  --max-beat-events N  每拍事数上限（默认 3）
  --max-line-chars N   每拍台词字数上限（默认 18）
  --outfit-extra S     追加服装禁用词（逗号分隔）

无第三方依赖；输出 UTF-8 中文报告；存在 FAIL 时退出码为 1。
"""

import argparse
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------- 常量

# 服装禁用词表（部位 + 衣料；可按项目用 --outfit-extra 追加）
DEFAULT_OUTFIT_WORDS = [
    "袖口", "衣袖", "长袖", "广袖", "双袖", "衣袂", "衣料", "衣袍",
    "袍角", "袍摆", "下摆", "裙裾", "裙摆", "纱料", "披帛", "衣襟",
    "襟口", "领口", "领缘", "腰封", "纱衣", "罗裙", "华服", "亵衣",
    "春光", "纱裙", "衣裙", "衣裳", "服饰", "衣摆", "衫裙", "短襦",
    "长裙",
]

# 声明行：命中即跳过服装词统计（这些行本身在罗列禁用词）
SKIP_LINE_RE = re.compile(r"不描述|不得出现|禁用|严禁|自检|以参考图为准|零命中|不写")

# 引用剥离（原文台词/引用文字豁免服装词）：引号、书名号、粗体
REF_STRIP_RES = [
    re.compile(r"「[^「」]*」"),
    re.compile(r"《[^《》]*》"),
    re.compile(r"\*\*[^*]*\*\*"),
]

# 心声/内白标记（其后的引文不计入口语）
INNER_MARKERS = ("心声", "内心音", "内白", "心底", "念头", "嘴唇不动", "画外")

# "引文前窗口以 动词+可选冒号 结尾"→ 视为说出口的完整句
VERB_RE = re.compile(
    r"(道|说|问|喊|念|答|嘱|提醒|续|自语|传音|低语|开口|称|赞|叹|笑|应"
    r"|嘱咐|嘀咕|吩咐|宣布|呵斥|冷笑|轻声道)[：:]?\s*$"
)
# 句末标点
END_PUNCT_RE = re.compile(r"[。！？…～?!]$")

# 拍点行： > **0–3s：** 正文
# 兼容：时间码后带括号说明（如 `**0–3s（意象一）：**`）、`**0–3s：正文**` 包裹变体
BEAT_RE = re.compile(
    r"^\s*>\s*\*\*\s*\d+\s*[–\-—~]\s*\d+\s*s\s*[^：:]{0,20}[：:]\s*(?:\*\*)?\s*(.*)$"
)
# 文件名规格： _90秒6段
FNAME_RE = re.compile(r"_(\d+)秒(\d+)段")
# 标题行规格： # SC108｜…（90 秒｜6 段 × 15 秒｜…）
TITLE_RE = re.compile(r"^#\s*SC\d+.*?（\s*(\d+)\s*秒\s*[｜|]\s*(\d+)\s*段", re.M)

CIRCLED = ["①", "②", "③", "④", "⑤"]


# ---------------------------------------------------------------- 工具


def read_text(path: Path) -> str:
    """读取文本（兼容 UTF-8 BOM，多重 BOM 一并剥除）。"""
    return path.read_text(encoding="utf-8-sig", errors="replace").lstrip("\ufeff")


def cjk_count(s: str) -> int:
    """统计字数：CJK 字符 + 字母数字（不计标点/空白）。"""
    return len(re.findall(r"\w", s))


def strip_refs(line: str) -> str:
    """剥离引用性文字（引号/书名号/粗体），直到稳定。"""
    prev = None
    s = line
    while s != prev:
        prev = s
        for rx in REF_STRIP_RES:
            s = rx.sub("", s)
    return s


def parse_beats(text: str):
    """提取全部拍点行。返回 [(行号, 正文), ...]"""
    beats = []
    for i, line in enumerate(text.splitlines(), 1):
        m = BEAT_RE.match(line)
        if m:
            beats.append((i, m.group(1)))
    return beats


def beat_event_count(body: str) -> int:
    """每拍事数：剥离引号内台词后，按 [。；] 断句，丢弃 <=3 字的碎片；
    "（…不计…）"类注释豁免；含"末帧"的末帧交代句减 1。"""
    body = re.sub(r"「[^「」]*」", "X", body)
    body = re.sub(r"《[^《》]*》", "X", body)
    parts = [p for p in re.split(r"[。；]", body) if len(p.strip()) > 3]
    parts = [p for p in parts
             if not ("不计" in p and ("件事" in p or "事数" in p or "计数" in p))]
    n = len(parts)
    if "末帧" in body:
        n = max(1, n - 1)
    return n


def analyze_quotes(body: str):
    """分析一拍行的引文。
    返回 (完整句口径字数, 全量口语字数, 心声字数)。
    类别判定：引文间文本含心声标记 -> inner；仅标点（连排引文）-> 继承；
    否则 -> spoken。
    """
    full = allc = inner_total = 0
    last_kind = "spoken"
    pos = 0
    for m in re.finditer(r"「([^「」]*)」", body):
        start, q = m.start(), m.group(1)
        between = body[pos:start]
        pos = m.end()
        if any(mk in between for mk in INNER_MARKERS):
            kind = "inner"
        elif re.sub(r"\W+", "", between) == "":
            kind = last_kind
        else:
            kind = "spoken"
        last_kind = kind
        n = cjk_count(q)
        if kind == "inner":
            inner_total += n
            continue
        allc += n
        ctx = body[max(0, start - 18):start]
        if END_PUNCT_RE.search(q) or VERB_RE.search(ctx):
            full += n
    return full, allc, inner_total


def section_slice(text: str, *keywords: str) -> str:
    """截取标题含任一关键词的 '## 小节' 内容（到下一个 ## 或文末）。"""
    hits = list(re.finditer(r"^##\s*(.+?)\s*$", text, re.M))
    for idx, m in enumerate(hits):
        if any(k in m.group(1) for k in keywords):
            start = m.end()
            end = hits[idx + 1].start() if idx + 1 < len(hits) else len(text)
            return text[start:end]
    return ""


def table_data_rows(block: str) -> int:
    """通用表格数据行计数（总 | 行 减 表头与分隔行），用于格式变体 fallback。"""
    rows = [ln for ln in block.splitlines() if ln.strip().startswith("|")]
    if not rows:
        return 0
    data = 0
    for ln in rows:
        if re.match(r"^\s*\|[\s:|\-—]+\|\s*$", ln):  # 分隔行
            continue
        data += 1
    return max(0, data - 1)


def build_gen_ranges(lines):
    """构建"生成层"行号区间：每个 '## 视频' 标题行之后，到下一节标题前。
    返回 [(start, end), ...]（不含节标题行本身）。"""
    ranges = []
    start = None
    for i, ln in enumerate(lines, 1):
        if re.match(r"^##\s*视频", ln):
            start = i + 1
            continue
        if start is not None and re.match(r"^##\s", ln):
            ranges.append((start, i - 1))
            start = None
    if start is not None:
        ranges.append((start, len(lines)))
    return ranges


def outfit_check(text: str, words):
    """服装词命中：分生成层（FAIL）与说明层（WARN）。
    跳过声明行；剥离引用后再匹配。返回 (gen_hits, doc_hits)。"""
    lines = text.splitlines()
    gen_ranges = build_gen_ranges(lines)
    gen_hits, doc_hits = [], []
    for i, ln in enumerate(lines, 1):
        if SKIP_LINE_RE.search(ln):
            continue
        narr = strip_refs(ln)
        hit = [w for w in words if w in narr]
        if not hit:
            continue
        rec = (i, hit)
        if any(a <= i <= b for a, b in gen_ranges):
            gen_hits.append(rec)
        else:
            doc_hits.append(rec)
    return gen_hits, doc_hits


# ---------------------------------------------------------------- 单份校验


def check_one(path: Path, args):
    """校验一份文件，返回 (errors, warns, stats)。"""
    text = read_text(path)
    errors, warns = [], []
    stats = {}

    # --- 段数：文件名 → 标题 ---
    fm = FNAME_RE.search(path.stem)
    tm = TITLE_RE.search(text)
    seg = None
    f_sec = f_seg = None
    if fm:
        f_sec, f_seg = int(fm.group(1)), int(fm.group(2))
        stats["文件名"] = f"{f_sec}秒{f_seg}段"
        seg = f_seg
    else:
        errors.append("文件名不含 `<秒数>秒<段数>段` 规格")
    if tm:
        t_sec, t_seg = int(tm.group(1)), int(tm.group(2))
        stats["标题"] = f"{t_sec}秒{t_seg}段"
        if f_seg is not None and (f_sec, f_seg) != (t_sec, t_seg):
            errors.append(f"文件名规格({f_sec}秒{f_seg}段) 与标题({t_sec}秒{t_seg}段) 不一致")
        if seg is None:
            seg = t_seg
    else:
        errors.append("标题行不符合 `# SCxxx｜…（N 秒｜M 段 × 15 秒｜…）` 格式")

    # --- 拍点：密度 / 台词 ---
    beats = parse_beats(text)
    if seg:
        stats["拍数"] = len(beats)
        if len(beats) != seg * 5:
            warns.append(f"拍点数 {len(beats)} ≠ 段数×5 = {seg * 5}（若有合拍写法请人工确认）")

    over_events, over_full, over_all = [], [], []
    total_ev, max_ev = 0, 0
    detail = []
    for lineno, body in beats:
        ev = beat_event_count(body)
        full, allc, inner = analyze_quotes(body)
        total_ev += ev
        max_ev = max(max_ev, ev)
        if ev > args.max_beat_events:
            over_events.append((lineno, ev))
        if full > args.max_line_chars:
            over_full.append((lineno, full))
        if allc > args.max_line_chars:
            over_all.append((lineno, allc))
        detail.append((lineno, ev, full, allc, inner))

    stats["总事数"] = total_ev
    stats["最大事数"] = max_ev
    stats["超3的拍"] = len(over_events)
    stats["台词超线(完整句)"] = len(over_full)
    stats["台词超线(全量)"] = len(over_all)
    if seg:
        need = -(-total_ev // 12)  # ceil(总事数 / 2.4 / 5)
        stats["建议段数"] = need
    if over_events:
        errors.append(
            f"密度超载：{len(over_events)} 拍 >{args.max_beat_events} 件事 "
            + "、".join(f"L{l}({n}件)" for l, n in over_events[:8])
        )
    if over_full:
        errors.append(
            f"台词超线(完整句口径)：{len(over_full)} 拍 >{args.max_line_chars} 字 "
            + "、".join(f"L{l}({n}字)" for l, n in over_full[:8])
        )
    if over_all:
        msg = (
            f"全量口径（含半截句、已排除心声）：{len(over_all)} 拍 >{args.max_line_chars} 字 "
            + "、".join(f"L{l}({n}字)" for l, n in over_all[:8])
        )
        if args.strict:
            errors.append(msg + "（--strict）")
        else:
            warns.append(msg + " —— 建议人工复核舞台指示/拆句")

    # --- 结构 ---
    vids = re.findall(r"^##\s*视频\s*(\d+)", text, re.M)
    if seg and len(vids) != seg:
        errors.append(f"视频节数 {len(vids)} ≠ 段数 {seg}")
    for c in CIRCLED:
        n = len(re.findall(r"^\*\*" + c, text, re.M))
        if seg and n != seg:
            errors.append(f"「{c}」块数 {n} ≠ 段数 {seg}")

    route_block = section_slice(text, "路线")
    if route_block:
        n = len(re.findall(r"^\|\s*\d+(?:[（(]\d+s[）)])?\s*\|", route_block, re.M))
        if n == 0:
            n = table_data_rows(route_block)
        if seg and n != seg:
            errors.append(f"分镜路线表行数 {n} ≠ 段数 {seg}")
    else:
        errors.append("缺少「路线」小节（分镜路线表）")

    if not section_slice(text, "上传顺序"):
        errors.append("缺少「## 上传顺序」小节")

    tail_block = section_slice(text, "末帧交接")
    if tail_block:
        n = len(re.findall(r"^\|\s*(?:段|视频)\s*\d", tail_block, re.M))
        if n == 0:
            n = table_data_rows(tail_block)
        if seg and n != seg:
            errors.append(f"末帧交接表行数 {n} ≠ 段数 {seg}")
    else:
        errors.append("缺少「## 末帧交接」小节")

    # --- 服装词 ---
    gen_hits, doc_hits = outfit_check(text, args.outfit_words)
    stats["服装(生成层)"] = len({l for l, _ in gen_hits})
    stats["服装(说明层)"] = len({l for l, _ in doc_hits})
    if gen_hits:
        detail_s = "、".join(f"L{l}:{'/'.join(ws)}" for l, ws in gen_hits[:10])
        errors.append(f"生成层服装禁用词命中 {len(gen_hits)} 行：{detail_s}")
    if doc_hits:
        detail_s = "、".join(f"L{l}:{'/'.join(ws)}" for l, ws in doc_hits[:10])
        warns.append(f"说明层服装词 {len(doc_hits)} 行（引用/戏眼，请确认）：{detail_s}")

    stats["明细"] = detail
    return errors, warns, stats


# ---------------------------------------------------------------- 主流程


def main():
    ap = argparse.ArgumentParser(description="分镜提示词一体式校验（四把尺子）")
    ap.add_argument("paths", nargs="+", help="待校验的文件或目录")
    ap.add_argument("--glob", default="SC*.md", help="目录扫描模式（默认 SC*.md）")
    ap.add_argument("--beats", action="store_true", help="打印每拍明细")
    ap.add_argument("--summary", action="store_true", help="只输出汇总")
    ap.add_argument("--strict", action="store_true",
                    help="全量台词口径超线升级为 FAIL")
    ap.add_argument("--max-beat-events", type=int, default=3)
    ap.add_argument("--max-line-chars", type=int, default=18)
    ap.add_argument("--outfit-extra", default="", help="追加服装词（逗号分隔）")
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    args.outfit_words = DEFAULT_OUTFIT_WORDS + [
        w.strip() for w in args.outfit_extra.split(",") if w.strip()
    ]

    files = []
    for p in args.paths:
        path = Path(p)
        if path.is_dir():
            files.extend(sorted(path.glob(args.glob)))
        elif path.is_file():
            files.append(path)
        else:
            print(f"[跳过] 不存在：{p}")
    if not files:
        print("未找到待校验文件。")
        return 1

    n_pass = n_fail = 0
    for f in files:
        errors, warns, stats = check_one(f, args)
        ok = not errors
        n_pass += ok
        n_fail += (not ok)
        if not args.summary:
            print(f"\n== {f.name} ==")
            for k in ("文件名", "标题", "拍数", "总事数", "最大事数",
                      "超3的拍", "台词超线(完整句)", "台词超线(全量)",
                      "建议段数", "服装(生成层)", "服装(说明层)"):
                if k in stats:
                    print(f"  {k}: {stats[k]}")
            if args.beats:
                for lineno, ev, full, allc, inner in stats.get("明细", []):
                    extra = f"  心声{inner}字" if inner else ""
                    print(f"    L{lineno:<5} 事{ev}  台词{full}/{allc}{extra}")
            for w in warns:
                print(f"  [WARN] {w}")
            for e in errors:
                print(f"  [FAIL] {e}")
            print("  结果:", "PASS" if ok else "FAIL")

    print(f"\n===== 汇总：{len(files)} 份，PASS {n_pass}，FAIL {n_fail} =====")
    return 0 if n_fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
