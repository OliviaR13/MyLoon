#!/usr/bin/env python3
"""根据 manifest.json 同步 README.md 中的插件表与数量。

只改动 README 里用标记包起来的区域，其余内容原样保留：
  <!-- PLUGINS_ZH:START --> ... <!-- PLUGINS_ZH:END -->
  <!-- PLUGINS_EN:START --> ... <!-- PLUGINS_EN:END -->
并更新三处数量：顶部徽章、「Loon 插件（N 款）」、「Loon plugins (N)」。
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
README = ROOT / "README.md"
MANIFEST = ROOT / "manifest.json"
I18N = ROOT / ".github" / "plugins-i18n.json"

# 分类的显示顺序与英文名；不在表里的分类排在最后，英文沿用原文
CATEGORY_ORDER = ["代理分流", "IP 属地", "登录修复", "功能增强"]
CATEGORY_EN = {
    "代理分流": "Proxy routing",
    "IP 属地": "IP attribution",
    "登录修复": "Sign-in repair",
    "功能增强": "Enhancement",
    "其他": "Other",
}


def warn(msg):
    print(f"::warning::{msg}")


def cell(text):
    return str(text).replace("|", "\\|").replace("\n", " ").strip()


def first_sentence(text):
    """#!desc 往往很长（含安装提示），表格里只取第一句。"""
    return re.split(r"(?<=[。！？])", text.strip(), maxsplit=1)[0].rstrip("。")


def sort_key(p):
    first = (p.get("tags") or [p["category"]])[0]
    rank = CATEGORY_ORDER.index(first) if first in CATEGORY_ORDER else len(CATEGORY_ORDER)
    return (rank, first, p["id"].lower())


def replace_block(text, name, body):
    pattern = re.compile(rf"(<!-- {name}:START -->\n).*?(\n<!-- {name}:END -->)", re.DOTALL)
    if not pattern.search(text):
        sys.exit(f"README.md 缺少标记 <!-- {name}:START --> / <!-- {name}:END -->")
    return pattern.sub(lambda m: m.group(1) + body + m.group(2), text, count=1)


def replace_count(text, pattern, repl, label):
    new, n = re.subn(pattern, repl, text)
    if n == 0:
        warn(f"README 中没有找到「{label}」，数量未更新")
    return new


def main():
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    plugins = sorted(manifest["plugins"], key=sort_key)
    i18n = json.loads(I18N.read_text(encoding="utf-8")) if I18N.exists() else {}

    zh_rows = ["| 插件 | 分类 | 说明 |", "|---|---|---|"]
    en_rows = ["| Plugin | Category | Description |", "|---|---|---|"]

    for p in plugins:
        o = i18n.get(p["id"], {})
        link = p["file"]
        tags = p.get("tags") or [p["category"]]

        zh_name = o.get("zh_name") or p["name"]
        zh_desc = o.get("zh_desc") or first_sentence(p["description"])
        zh_rows.append(f"| [{cell(zh_name)}]({link}) | {cell(' · '.join(tags))} | {cell(zh_desc)} |")

        en_name = o.get("en_name")
        en_desc = o.get("en_desc")
        if not en_name or not en_desc:
            warn(f"{p['id']}：缺少英文文案，请在 .github/plugins-i18n.json 中补充 en_name / en_desc")
        en_cats = " · ".join(CATEGORY_EN.get(t, t) for t in tags)
        en_rows.append(f"| [{cell(en_name or zh_name)}]({link}) | {cell(en_cats)} | {cell(en_desc or zh_desc)} |")

    n = len(plugins)
    text = README.read_text(encoding="utf-8")
    text = replace_block(text, "PLUGINS_ZH", "\n".join(zh_rows))
    text = replace_block(text, "PLUGINS_EN", "\n".join(en_rows))
    text = replace_count(text, r"Plugins-\d+-", f"Plugins-{n}-", "顶部徽章")
    text = replace_count(text, r"Loon 插件（\d+ 款）", f"Loon 插件（{n} 款）", "Loon 插件（N 款）")
    text = replace_count(text, r"Loon plugins \(\d+\)", f"Loon plugins ({n})", "Loon plugins (N)")

    if text != README.read_text(encoding="utf-8"):
        README.write_text(text, encoding="utf-8")
        print(f"README.md 已更新（{n} 个插件）")
    else:
        print(f"README.md 无变化（{n} 个插件）")


if __name__ == "__main__":
    main()
