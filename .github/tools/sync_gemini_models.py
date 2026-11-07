#!/usr/bin/env python3
"""每天同步 Google Gemini 可用模型，更新 Siri to Gemini 插件「模型」下拉选项。

- 数据来源：Gemini API  GET /v1beta/models（需要仓库 Secret：GEMINI_API_KEY）
- 只保留：支持 generateContent、名字以 gemini- 开头、版本 >= 2.5 的文本/多模态对话模型
- 排除：tts / image / live / audio / transcribe / embedding / 带日期的快照 / 实验版等；正式版已出时不再保留同名 -preview
- 稳定排序：已有选项保持原顺序（第一个是默认值），新模型追加在末尾，下线的模型移除
- 出错或数据异常时不改动任何文件（退出码 0），不会把下拉清空
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

PLUGIN = Path("plugin/qianwen_gemini.plugin")
API = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000"

EXCLUDE = re.compile(
    r"(embedding|tts|image|live|audio|robotics|computer-use|learnlm|exp|vision|aqa|imagen|veo|"
    r"nano|banana|deep-research|customtools|dialog|native|thinking-|antigravity|"
    r"transcribe|speech|translat|moderation)",
    re.I,
)
DATED = re.compile(r"(-\d{3}$|-\d{4}$|-\d{2}-\d{4}$|-\d{2}-\d{2}$)")  # -001 / -0827 / -09-2025 / -03-25
LATEST_ALIASES = {"gemini-flash-latest", "gemini-flash-lite-latest", "gemini-pro-latest"}
MIN_VERSION = (2, 5)
MAX_OPTIONS = 20


def fetch_models():
    src = os.environ.get("MODELS_JSON")  # 测试用：直接读本地 JSON
    if src:
        return json.loads(Path(src).read_text(encoding="utf-8")).get("models", [])
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        print("::notice::未设置 GEMINI_API_KEY，跳过模型同步")
        return None
    req = urllib.request.Request(API, headers={"x-goog-api-key": key})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8")).get("models", [])
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        print(f"::warning::获取模型列表失败，保持原样：{e}")
        return None


def version_of(name):
    m = re.match(r"gemini-(\d+)(?:\.(\d+))?-", name)
    return (int(m.group(1)), int(m.group(2) or 0)) if m else None


def pick(models):
    out = []
    for m in models:
        name = str(m.get("name", "")).replace("models/", "")
        if not name.startswith("gemini-"):
            continue
        if "generateContent" not in (m.get("supportedGenerationMethods") or []):
            continue
        if EXCLUDE.search(name) or DATED.search(name):
            continue
        if name in LATEST_ALIASES:
            out.append(name)
            continue
        v = version_of(name)
        if v and v >= MIN_VERSION:
            out.append(name)
    out = set(out)
    # 正式版已发布时，去掉同名的 -preview 版本（如 gemini-3.1-flash-lite-preview）
    out = {n for n in out if not (n.endswith("-preview") and n[: -len("-preview")] in out)}
    return sorted(out)


def parse_current(text):
    m = re.search(r'^(MODEL = select,)((?:"[^"]+",)+)(tag=.*)$', text, re.M)
    if not m:
        sys.exit("::error::找不到 MODEL 下拉行，插件格式可能已变化")
    return m, re.findall(r'"([^"]+)"', m.group(2))


def main():
    models = fetch_models()
    if models is None:
        return
    fresh = pick(models)
    print("可用模型（过滤后）：", fresh)
    if len(fresh) < 3:
        print("::warning::过滤后模型太少，疑似数据异常，保持原样")
        return

    text = PLUGIN.read_text(encoding="utf-8")
    m, current = parse_current(text)

    kept = [x for x in current if x in fresh]      # 保持原顺序，移除已下线
    added = [x for x in fresh if x not in kept]    # 新模型按字母序追加
    new = (kept + added)[:MAX_OPTIONS]
    if not new:
        print("::warning::结果为空，保持原样")
        return
    if new == current:
        print("下拉选项无变化")
        return

    removed = [x for x in current if x not in new]
    print("新增：", [x for x in new if x not in current], "移除：", removed)

    line = m.group(1) + "".join(f'"{x}",' for x in new) + m.group(3)
    text = text[: m.start()] + line + text[m.end():]

    # 版本号 patch +1，日期改为今天（UTC+8）
    today = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")
    text = re.sub(r"^(#!date = ).*$", lambda mm: mm.group(1) + today, text, flags=re.M)

    def bump(mm):
        a, b, c = mm.group(2).split(".")
        return f"{mm.group(1)}{a}.{b}.{int(c) + 1}"

    text = re.sub(r"^(#!version = )(\d+\.\d+\.\d+)", bump, text, flags=re.M)
    PLUGIN.write_text(text, encoding="utf-8")
    print("已更新", PLUGIN)


if __name__ == "__main__":
    main()
