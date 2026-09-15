# -*- coding: utf-8 -*-
"""Render README_CSDN.md to a self-contained HTML with base64-embedded images."""
import base64
import io
import os
import re

import markdown

ROOT = r"D:\python_tools\auto_tools\pomelo_requests"
MD_PATH = os.path.join(ROOT, "README_CSDN.md")
OUT_PATH = os.path.join(ROOT, "README_CSDN.html")
IMG_DIR = os.path.join(ROOT, "docs", "images")

with io.open(MD_PATH, encoding="utf-8") as f:
    md_text = f.read()

html_body = markdown.markdown(
    md_text,
    extensions=["tables", "fenced_code", "sane_lists"],
)


def embed(m):
    alt, rel = m.group(1), m.group(2)
    path = os.path.join(ROOT, rel.replace("/", os.sep))
    if not os.path.isfile(path):
        return m.group(0)
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    return '<img src="data:image/png;base64,%s" alt="%s" style="max-width:100%%;border:1px solid #e5e6eb;border-radius:6px;margin:12px 0"/>' % (b64, alt)


html_body = re.sub(r'<img alt="([^"]*)" src="([^"]+)"\s*/?>', embed, html_body)

page_template = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Pomelo 接口测试平台 - CSDN 发布稿</title>
<style>
body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:920px;margin:0 auto;padding:32px 24px;color:#24292f;line-height:1.75;background:#fff;}
h1{font-size:1.9em;border-bottom:2px solid #6c6cf5;padding-bottom:10px;}
h2{font-size:1.4em;margin-top:2em;border-left:4px solid #6c6cf5;padding-left:10px;}
h3{font-size:1.15em;}
blockquote{margin:0;padding:10px 16px;background:#f6f7fa;border-left:4px solid #c9c9f5;color:#555;border-radius:0 6px 6px 0;}
code{background:#f0f1f3;padding:2px 6px;border-radius:4px;font-size:.9em;}
pre{background:#1e1e2e;color:#cdd6f4;padding:14px 16px;border-radius:8px;overflow-x:auto;}
pre code{background:none;color:inherit;padding:0;}
table{border-collapse:collapse;width:100%;margin:14px 0;}
th,td{border:1px solid #dfe1e5;padding:8px 12px;text-align:left;}
th{background:#f6f7fa;}
tr:nth-child(even) td{background:#fafbfc;}
li{margin:4px 0;}
hr{border:none;border-top:1px solid #e5e6eb;margin:2em 0;}
</style>
</head>
<body>
__BODY__
</body>
</html>"""

page = page_template.replace("__BODY__", html_body)

with io.open(OUT_PATH, "w", encoding="utf-8") as f:
    f.write(page)

n_img = page.count("data:image/png;base64,")
print("OK:", OUT_PATH)
print("embedded images:", n_img)
