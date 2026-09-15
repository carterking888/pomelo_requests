"""
交互冒烟检查

目的:验证筛选 / 抽屉 / 路由跳转 / 日志流 / 进度条这些【交互】真的生效。
渲染静态内容没问题 ≠ 交互能用 —— 本项目曾出现"三个筛选器全是摆设"
(v-for 直接绑原始数组,筛选状态只改了按钮高亮)和"抽屉点开了内容不联动"
(current 是静态快照)这类问题,静态渲染检查完全发现不了。

用法:
    python _interaction_check.py
"""

from __future__ import annotations

import json
import os
import time

import webview

# ---------- 通用 JS 片段 ----------
VISIBLE = """
(function () {
  var secs = Array.prototype.slice.call(document.querySelectorAll('section.pomelo-page'))
    .filter(function (e) { return e.offsetWidth > 0; });
  return secs[0] || null;
})()
"""

# 可见 section 内的表格数据行(排除"空态"那一行)
ROWS_JS = """
(function () {
  var sec = (function () {
    return Array.prototype.slice.call(document.querySelectorAll('section.pomelo-page'))
      .filter(function (e) { return e.offsetWidth > 0; })[0];
  })();
  if (!sec) return JSON.stringify({ error: 'no visible section' });
  var trs = Array.prototype.slice.call(sec.querySelectorAll('tbody tr'));
  var emptyRow = trs.filter(function (tr) { return tr.querySelector('td[colspan]'); }).length;
  return JSON.stringify({
    rows: trs.length - emptyRow,
    emptyState: emptyRow > 0,
    pager: (sec.querySelector('.pager .muted') || {}).textContent || null
  });
})()
"""


def run(win, js: str):
    raw = win.evaluate_js(js)
    try:
        return json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return {"parseError": raw}


def goto(win, hash_: str, wait: float = 1.6):
    win.evaluate_js(f"location.hash = '{hash_}'")
    time.sleep(wait)


def rows(win):
    return run(win, ROWS_JS)


def click_by_text(win, text: str, scope: str = "document") -> int:
    """点击文案完全匹配(text.trim())的 button"""
    js = f"""
    (function () {{
      var root = {scope};
      var btns = Array.prototype.slice.call(root.querySelectorAll('button'))
        .filter(function (b) {{ return b.textContent.trim() === {json.dumps(text, ensure_ascii=False)}; }});
      if (btns[0]) btns[0].click();
      return JSON.stringify({{ clicked: btns.length }});
    }})()
    """
    return run(win, js)


def click_sel(win, selector: str):
    """按选择器点击(用于没有文字、只有图标的按钮)"""
    js = f"""
    (function () {{
      var el = document.querySelector({json.dumps(selector)});
      if (!el) return JSON.stringify({{ found: false }});
      el.click();
      return JSON.stringify({{ found: true }});
    }})()
    """
    return run(win, js)


def set_input(win, selector: str, value: str):
    js = f"""
    (function () {{
      var el = document.querySelector({json.dumps(selector)});
      if (!el) return JSON.stringify({{ found: false }});
      el.value = {json.dumps(value, ensure_ascii=False)};
      el.dispatchEvent(new Event('input', {{ bubbles: true }}));
      return JSON.stringify({{ found: true }});
    }})()
    """
    return run(win, js)


def drawer_state(win):
    js = """
    (function () {
      var d = document.querySelector('.drawer-panel');
      if (!d) return JSON.stringify({ found: false });
      return JSON.stringify({
        found: true,
        open: d.offsetWidth > 0,
        title: ((d.querySelector('.case-detail__title') || {}).textContent || '').trim()
      });
    })()
    """
    return run(win, js)


def click_row(win, idx: int):
    js = f"""
    (function () {{
      var sec = Array.prototype.slice.call(document.querySelectorAll('section.pomelo-page'))
        .filter(function (e) {{ return e.offsetWidth > 0; }})[0];
      var trs = Array.prototype.slice.call(sec.querySelectorAll('tbody tr'))
        .filter(function (tr) {{ return !tr.querySelector('td[colspan]'); }});
      if (!trs[{idx}]) return JSON.stringify({{ clicked: false }});
      trs[{idx}].click();
      return JSON.stringify({{ clicked: true, name: (trs[{idx}].textContent || '').trim().slice(0, 40) }});
    }})()
    """
    return run(win, js)


def bootstrap():
    win = webview.windows[0]
    checks = []
    try:
        # ---------- 1. 顶部导航点击(navigateTo) ----------
        goto(win, "#/dashboard")
        win.evaluate_js("""
          (function(){ var a = document.querySelector('nav.pomelo-nav a[data-route=\\"reports\\"]');
                       if (a) a.click(); })()
        """)
        time.sleep(1.6)
        d = run(win, """
        (function () {
          return JSON.stringify({
            hash: location.hash,
            activeNav: ((document.querySelector('nav.pomelo-nav a.is-active')||{}).textContent||'').trim(),
            visibleIdx: Array.prototype.slice.call(document.querySelectorAll('section.pomelo-page'))
              .findIndex(function(e){ return e.offsetWidth > 0; })
          });
        })()
        """)
        checks.append(("导航点击 → 切到测试报告", d.get("hash") == "#/reports" and d.get("visibleIdx") == 4))
        checks.append(("导航高亮跟随", "测试报告" in (d.get("activeNav") or "")))

        # ---------- 2. 用例页:关键词搜索 ----------
        goto(win, "#/apicases")
        base = rows(win)
        set_input(win, 'input[placeholder*="搜索用例"]', "订单")
        time.sleep(0.8)
        hit = rows(win)
        checks.append((f"搜索'订单' → 行数减少({base.get('rows')}→{hit.get('rows')})",
                       0 < (hit.get("rows") or 0) < (base.get("rows") or 0)))

        set_input(win, 'input[placeholder*="搜索用例"]', "")
        time.sleep(0.8)
        back = rows(win)
        checks.append(("清空搜索 → 行数还原", back.get("rows") == base.get("rows")))

        # ---------- 3. 用例页:分类 Tab ----------
        click_by_text(win, "用户中心")
        time.sleep(0.8)
        tab = rows(win)
        checks.append((f"Tab'用户中心' → 过滤生效({base.get('rows')}→{tab.get('rows')})",
                       0 < (tab.get("rows") or 0) < (base.get("rows") or 0)))

        click_by_text(win, "全部用例")
        time.sleep(0.8)
        checks.append(("Tab'全部用例' → 还原", rows(win).get("rows") == base.get("rows")))

        # ---------- 4. 空态 ----------
        set_input(win, 'input[placeholder*="搜索用例"]', "zzzzz")
        time.sleep(0.8)
        empty = rows(win)
        checks.append(("无结果 → 显示空态", empty.get("rows") == 0 and empty.get("emptyState") is True))
        set_input(win, 'input[placeholder*="搜索用例"]', "")
        time.sleep(0.8)

        # ---------- 4b. 视图切换:表格 ↔ 卡片 ----------
        # 切换按钮是纯图标没有文字,按选择器点(.view-toggle 内第 1 个=表格,第 2 个=卡片)
        click_sel(win, ".view-toggle button:nth-child(2)")
        time.sleep(0.9)
        g = run(win, """
        (function () {
          var grid = document.querySelector('.case-grid');
          var table = document.querySelector('.table-card');
          var cards = Array.prototype.slice.call(document.querySelectorAll('.case-grid__card'))
            .filter(function (e) { return e.offsetWidth > 0; });
          return JSON.stringify({
            gridVisible: grid ? grid.offsetWidth > 0 : false,
            cards: cards.length,
            firstCardText: (cards[0] ? cards[0].innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 50),
            tableVisible: table ? table.offsetWidth > 0 : false
          });
        })()
        """)
        checks.append(("切到卡片视图 → 卡片显示且表格隐藏",
                       g.get("gridVisible") is True and g.get("cards") > 0
                       and g.get("tableVisible") is False))
        checks.append((f"卡片数({g.get('cards')}) == 表格行数({base.get('rows')})",
                       g.get("cards") == base.get("rows")))

        click_sel(win, ".view-toggle button:nth-child(1)")
        time.sleep(0.9)
        t = run(win, """
        (function () {
          var grid = document.querySelector('.case-grid');
          var table = document.querySelector('.table-card');
          return JSON.stringify({
            gridVisible: grid ? grid.offsetWidth > 0 : false,
            tableVisible: table ? table.offsetWidth > 0 : false
          });
        })()
        """)
        checks.append(("切回表格视图 → 表格显示且卡片隐藏",
                       t.get("tableVisible") is True and t.get("gridVisible") is False))

        # ---------- 5. 执行详情:状态筛选 ----------
        goto(win, "#/report-detail")
        allc = rows(win)
        click_by_text(win, "失败")
        time.sleep(0.8)
        failed = rows(win)
        checks.append((f"筛选'失败' → 行数减少({allc.get('rows')}→{failed.get('rows')})",
                       0 < (failed.get("rows") or 0) < (allc.get("rows") or 0)))
        click_by_text(win, "全量状态")
        time.sleep(0.8)
        checks.append(("筛选'全量状态' → 还原", rows(win).get("rows") == allc.get("rows")))

        # ---------- 6. 抽屉 ----------
        init_drawer = drawer_state(win)
        checks.append(("抽屉默认关闭", init_drawer.get("open") is False))

        click_row(win, 0)
        time.sleep(0.8)
        d1 = drawer_state(win)
        checks.append(("点击用例行 → 抽屉打开", d1.get("open") is True))

        click_row(win, 1)
        time.sleep(0.8)
        d2 = drawer_state(win)
        checks.append((f"切换用例 → 抽屉内容联动({d1.get('title')} → {d2.get('title')})",
                       bool(d2.get("title")) and d2.get("title") != d1.get("title")))

        win.evaluate_js("document.querySelector('.drawer-panel .icon-btn').click()")
        time.sleep(0.8)
        d3 = drawer_state(win)
        checks.append(("点击关闭 → 抽屉关闭", d3.get("open") is False))

        # ---------- 7. 测试执行:日志流 + 进度 ----------
        goto(win, "#/testrun", wait=2.0)

        def log_len():
            return run(win, """
            (function () {
              // 必须精确匹配:文档里还有个更早的 <pre class="json-block">
              // 写 '.terminal__body, pre' 会按文档顺序命中它(内容是固定 JSON,永不变化)
              var pre = document.querySelector('.terminal__body');
              if (!pre) return JSON.stringify({ found: false });
              return JSON.stringify({ found: true, lines: (pre.textContent||'').split('\\n').filter(function(s){return s.trim();}).length });
            })()
            """)

        def percent():
            return run(win, """
            (function () {
              var el = document.querySelector('.prog-percent');
              return JSON.stringify({ percent: el ? parseFloat(el.textContent) : null,
                                      done: ((document.querySelector('.progress-meta span')||{}).textContent||'').trim() });
            })()
            """)

        l1 = log_len()
        p1 = percent()
        time.sleep(4.0)
        l2 = log_len()
        p2 = percent()
        checks.append((f"日志流持续增长({l1.get('lines')}→{l2.get('lines')})",
                       (l2.get("lines") or 0) > (l1.get("lines") or 0)))
        checks.append((f"进度条推进({p1.get('percent')}% → {p2.get('percent')}%)",
                       (p2.get("percent") or 0) > (p1.get("percent") or 0)))

        # ---------- 8. 用例详情:Body 标签页 ----------
        goto(win, "#/apicases/get-user")
        before = run(win, """
        (function () {
          var b = Array.prototype.slice.call(document.querySelectorAll('.body-tabs button'))
            .filter(function(x){ return x.className.indexOf('is-active')>-1; })[0];
          return JSON.stringify({ active: b ? b.textContent.trim() : null });
        })()
        """)
        click_by_text(win, "Form")
        time.sleep(0.8)
        after = run(win, """
        (function () {
          var b = Array.prototype.slice.call(document.querySelectorAll('.body-tabs button'))
            .filter(function(x){ return x.className.indexOf('is-active')>-1; })[0];
          return JSON.stringify({ active: b ? b.textContent.trim() : null });
        })()
        """)
        checks.append((f"Body 标签切换({before.get('active')} → {after.get('active')})",
                       after.get("active") == "Form"))

    finally:
        win.destroy()

    print("\n" + "=" * 70)
    print("  交互检查")
    print("=" * 70)
    for name, ok in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
    failed = [n for n, ok in checks if not ok]
    print(f"\n  结果: {len(checks) - len(failed)}/{len(checks)} 通过")
    if failed:
        print("  未通过:")
        for n in failed:
            print(f"    - {n}")


def main():
    root = os.path.dirname(os.path.abspath(__file__))
    url = os.path.join(root, "web", "index.html")
    print(f"[交互检查] 加载 {url}")
    webview.create_window("交互冒烟检查", url=url, width=1440, height=900)
    webview.start(bootstrap)


if __name__ == "__main__":
    main()
