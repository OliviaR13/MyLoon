#!/usr/bin/env python3
"""根据 manifest.json 同步 README.md 中的插件数量。

更新三处：顶部徽章、「Loon 插件（N 款）」、「Loon plugins (N)」。
README 的其余内容原样保留。
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
README = ROOT / "README.md"
MANIFEST = ROOT / "manifest.json"


def replace_count(text, pattern, repl, label):
    new, n = re.subn(pattern, repl, text)
    if n == 0:
        print(f"::warning::README 中没有找到「{label}」，该处数量未更新")
    return new


def main():
    n = len(json.loads(MANIFEST.read_text(encoding="utf-8"))["plugins"])
    old = README.read_text(encoding="utf-8")
    text = replace_count(old, r"Plugins-\d+-", f"Plugins-{n}-", "顶部徽章")
    text = replace_count(text, r"Loon 插件（\d+ 款）", f"Loon 插件（{n} 款）", "Loon 插件（N 款）")
    text = replace_count(text, r"Loon plugins \(\d+\)", f"Loon plugins ({n})", "Loon plugins (N)")

    if text != old:
        README.write_text(text, encoding="utf-8")
        print(f"README.md 已更新（{n} 个插件）")
    else:
        print(f"README.md 无变化（{n} 个插件）")


if __name__ == "__main__":
    main()
