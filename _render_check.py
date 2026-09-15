"""
渲染冒烟检查:覆盖全部 6 个路由

目的:验证 pywebview 窗口内页面**真的渲染出来了**,而不只是"进程没崩溃"。
白屏 / 图表 0 尺寸 / v-for 渲染 0 项 这三类问题都不会让进程退出,
只能靠真实 DOM 探测发现。(Node 模拟 + 语法检查 + curl 200 都验不出来)

用法:
    python _render_check.py
"""

from __future__ import annotations

import json
import os
import time

import webview

# 用例详情页"变量配置"区会把 {{user_id}} 这类占位符作为【展示内容】渲染给用户,
# 它们不是未编译的模板,判定残留时需排除。
PLACEHOLDERS = {"{{user_id}}", "{{token}}", "{{request_id}}"}

ROUTES = [
    ("#/dashboard",       "仪表盘"),
    ("#/apicases",        "接口用例"),
    ("#/apicases/get-user", "用例详情"),
    ("#/apicases-new",    "新建用例"),
    ("#/testrun",         "测试执行"),
    ("#/testrun-new-suite", "新建套件"),
    ("#/reports",         "测试报告"),
    ("#/report-detail",   "执行详情"),
]

# 单个路由的通用测量
MEASURE_JS = r"""
(function () {
  var secs = Array.prototype.slice
    .call(document.querySelectorAll('section.pomelo-page'))
    .filter(function (el) { return el.offsetWidth > 0; });

  if (secs.length !== 1) {
    return JSON.stringify({ error: 'visible sections = ' + secs.length });
  }
  var sec = secs[0];
  var text = (sec.innerText || '').trim();

  // 找"明显该有内容却完全空"的容器 —— v-for 渲染 0 项的典型特征
  var empties = Array.prototype.slice
    .call(sec.querySelectorAll('div,ul,ol,tbody'))
    .filter(function (el) {
      return el.children.length === 0
          && (el.innerText || '').trim().length === 0
          && el.className && String(el.className).match(/list|grid|body|items|rows|wrap/);
    })
    .map(function (el) { return String(el.className).slice(0, 40); });

  return JSON.stringify({
    textLen:     text.length,
    elements:    sec.querySelectorAll('*').length,
    tableRows:   sec.querySelectorAll('tbody tr').length,
    liCount:     sec.querySelectorAll('li').length,
    canvases:    Array.prototype.slice.call(sec.querySelectorAll('canvas'))
                   .map(function (c) { return c.width + 'x' + c.height; }),
    emptyBoxes:  empties,
    mustache:    (sec.innerHTML.match(/\{\{[^}]{0,40}\}\}/g) || []),
    textHead:    text.replace(/\s+/g, ' ').slice(0, 90)
  });
})()
"""


def measure(win, hash_: str, label: str, wait: float = 2.5) -> dict:
    print(f"  -> 切换 {hash_} ({label})", flush=True)
    win.evaluate_js(f"location.hash = '{hash_}'")
    time.sleep(wait)
    print(f"  <- 探测 {hash_}", flush=True)
    raw = win.evaluate_js(MEASURE_JS)
    try:
        d = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except Exception:
        d = {"parseError": raw}
    d["_label"] = label
    d["_hash"] = hash_
    return d


def canvas_ok(c) -> bool:
    """canvas 必须存在且宽高都 > 0(NO_CANVAS / 0xN 都算失败)"""
    if not c or c == "NO_CANVAS":
        return False
    try:
        w, h = str(c).split("x")
        return int(w) > 0 and int(h) > 0
    except Exception:
        return False


def bootstrap() -> None:
    win = webview.windows[0]
    results = []
    try:
        for hash_, label in ROUTES:
            results.append(measure(win, hash_, label))
    finally:
        win.destroy()

    print("\n" + "=" * 78)
    print("  各路由渲染测量")
    print("=" * 78)
    for r in results:
        print(f"\n--- {r['_label']}  {r['_hash']}")
        if "error" in r or "parseError" in r:
            print(f"    探测失败: {r}")
            continue
        print(f"    文本长度 : {r['textLen']}")
        print(f"    元素总数 : {r['elements']}")
        print(f"    表格行   : {r['tableRows']}      li 数: {r['liCount']}")
        print(f"    canvas   : {r['canvases'] or '无'}")
        print(f"    空容器   : {r['emptyBoxes'] or '无'}")
        print(f"    模板残留 : {r['mustache'] or '无'}")
        print(f"    文本抽样 : {r['textHead']}")

    # ---------------- 判定 ----------------
    print("\n" + "=" * 78)
    print("  判定")
    print("=" * 78)
    by = {r["_hash"]: r for r in results}
    checks = []

    def get(h, k, default=None):
        return by.get(h, {}).get(k, default)

    # 通用:每个路由都必须有可见内容,且无模板残留
    for hash_, label in ROUTES:
        real_must = [m for m in (get(hash_, "mustache") or []) if m not in PLACEHOLDERS]
        checks.append((f"{label}: 内容非空", (get(hash_, "textLen") or 0) > 150))
        checks.append((f"{label}: 无模板残留", not real_must))
        checks.append((f"{label}: 无空容器", not (get(hash_, "emptyBoxes") or [])))

    # 各页关键元素
    checks.append(("仪表盘: 统计卡有值", (get("#/dashboard", "textLen") or 0) > 400))
    checks.append(("仪表盘: 双图表已渲染",
                   len([c for c in (get("#/dashboard", "canvases") or []) if canvas_ok(c)]) >= 2))
    checks.append(("接口用例: 表格有行", (get("#/apicases", "tableRows") or 0) > 0))
    checks.append(("测试报告: 双图表已渲染",
                   len([c for c in (get("#/reports", "canvases") or []) if canvas_ok(c)]) >= 2))
    checks.append(("测试报告: 历史表有行", (get("#/reports", "tableRows") or 0) > 0))
    checks.append(("执行详情: 列表有行", (get("#/report-detail", "tableRows") or 0) > 0))

    for name, ok in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
    failed = [n for n, ok in checks if not ok]
    print(f"\n  结果: {len(checks) - len(failed)}/{len(checks)} 通过")
    if failed:
        print("  未通过:")
        for n in failed:
            print(f"    - {n}")


def main() -> None:
    root = os.path.dirname(os.path.abspath(__file__))
    url = os.path.join(root, "web", "index.html")
    print(f"[渲染检查] 加载 {url}", flush=True)
    webview.create_window("渲染冒烟检查", url=url, width=1440, height=900)
    print("[渲染检查] 窗口已创建,启动事件循环", flush=True)
    webview.start(bootstrap)
    print("[渲染检查] 事件循环已退出", flush=True)


if __name__ == "__main__":
    main()
