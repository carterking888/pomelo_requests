/**
 * 渲染 + 交互冒烟检查(jsdom 版,不依赖 GUI 窗口)
 * ------------------------------------------------------------------
 * 为什么需要它:
 *   pywebview 的验证方式依赖真实 GUI 窗口。在无交互会话 / CI / 远程桌面等
 *   环境下,`url=` 方式可能起不来窗口("Main window failed to start"),
 *   此时需要一条不依赖 GUI 的真实 DOM 验证路径。
 *
 * 它能验出什么(静态检查 / Node 模拟验不出的):
 *   - v-for 渲染 0 项(petite-vue 组件没被实例化)
 *   - 模板残留 {{ }}
 *   - v-show 分支缺 DOM
 *   - 筛选器 / 抽屉 / 视图切换 点击后不联动
 *   - 保存链路没走到 pywebview 桥
 *
 * jsdom 的已知局限(已在下面的判定中规避):
 *   - 无排版引擎:offsetWidth 恒为 0 → 用 style.display 判断显隐
 *   - 无 innerText → 用 textContent,并跳过 display:none 的子树
 *   - 无 canvas → echarts 打桩,只验 "init 被调用 N 次"
 *
 * 用法:
 *   NODE_PATH=<workspace>/node_modules node _dom_check.js
 * ================================================================== */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = __dirname;
const WEB = path.join(ROOT, 'web');

/** 用例详情页把 {{user_id}} 这类占位符当【展示内容】渲染,不是未编译模板 */
const PLACEHOLDERS = new Set(['{{user_id}}', '{{token}}', '{{request_id}}']);

/** 注入顺序必须与 index.html 里的 <script> 顺序一致 */
const SCRIPTS = [
  // 'vendor/echarts.min.js',  // jsdom 无 canvas,真实 echarts 无法 init → 用下面的桩替代
  'vendor/layui/layui.js',
  'vendor/petite-vue.iife.js',
  'js/mock.js',
  'js/utils.js',
  'js/modules.js',
  'js/pages/dashboard.js',
  'js/pages/apicases.js',
  'js/pages/apidetail.js',
  'js/pages/testrun.js',
  'js/pages/reports.js',
  'js/pages/reportdetail.js',
  'js/pages/newcase.js',
  'js/pages/newsuite.js',
  'js/storage.js',
  'js/app.js',
];

const ROUTES = [
  ['#/dashboard', '仪表盘'],
  ['#/apicases', '接口用例'],
  ['#/apicases/get-user', '用例详情'],
  ['#/apicases-new', '新建用例'],
  ['#/testrun', '测试执行'],
  ['#/testrun-new-suite', '新建套件'],
  ['#/reports', '测试报告'],
  ['#/report-detail', '执行详情'],
];

/* ============================================================
 *  结果收集
 * ========================================================== */
const checks = [];
const notes = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
}
function note(msg) {
  notes.push(msg);
}

/* ============================================================
 *  启动 jsdom
 * ========================================================== */
function buildDom() {
  let html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  // jsdom 不会去加载本地相对路径的脚本,统一由下面的 inject() 手动注入
  const scriptCount = (html.match(/<script src="[^"]*"[^>]*>\s*<\/script>/g) || []).length;
  html = html.replace(/<script src="[^"]*"[^>]*>\s*<\/script>/g, '');
  note(`已从 index.html 剥离 ${scriptCount} 个 <script src>,改由脚本手动注入`);

  const dom = new JSDOM(html, {
    url: 'http://localhost/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });

  /* petite-vue 扫描时会把指令属性 removeAttribute 掉
     (源码: _e = (e,t) => { const n = e.getAttribute(t);
                           null != n && e.removeAttribute(t); return n })
     所以挂载后 querySelector('[v-model="x"]') 永远选不中。
     这里在【挂载前】把 v-model 表达式 -> 元素 的映射快照下来。
     注意:只适用于不在 v-for 内部的绑定(v-for 的模板元素会被移出 DOM)。 */
  const vmEl = {};
  for (const el of dom.window.document.querySelectorAll('[v-model]')) {
    const exp = el.getAttribute('v-model');
    if (!vmEl[exp]) vmEl[exp] = el;
  }
  dom.window.__vmEl = vmEl;

  /* 同理快照:路由 -> 该路由对应的 <section>。
     v-show 属性挂载后也会被移除,但元素引用始终有效。 */
  const secMap = {};
  for (const el of dom.window.document.querySelectorAll('section.pomelo-page')) {
    const m = (el.getAttribute('v-show') || '').match(/route==='([^']+)'/);
    if (m) secMap[m[1]] = el;
  }
  dom.window.__sections = secMap;

  return dom;
}

/** jsdom 无排版引擎,offsetWidth 恒为 0。
 *  而图表初始化代码用"容器宽度 > 0"来规避隐藏容器,不补这个桩图表永远不 init。 */
function shimLayout(win) {
  const desc = (name, val) =>
    Object.defineProperty(win.HTMLElement.prototype, name, {
      configurable: true,
      get() {
        return isVisible(this) ? val : 0;
      },
    });
  desc('offsetWidth', 800);
  desc('offsetHeight', 300);
  desc('clientWidth', 800);
  desc('clientHeight', 300);
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    const w = isVisible(this) ? 800 : 0;
    const h = isVisible(this) ? 300 : 0;
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON() {} };
  };
}

/* ------------------------------------------------------------
 *  模拟 data/ 目录(跨次启动保留,用于验证"重启后自动加载")
 *    { cases:   { <用例名>: payload },
 *      suites:  { <套件名>: payload },
 *      modules: { modules: { modules: [...] } } }
 * ---------------------------------------------------------- */
const DISK = Object.create(null);

function diskPut(category, name, content) {
  if (!DISK[category]) DISK[category] = Object.create(null);
  DISK[category][name] = content;
}
function diskList(category) {
  const bucket = DISK[category] || {};
  return Object.keys(bucket).map((k) => ({ file_name: `${k}.json`, content: bucket[k] }));
}

/** echarts 打桩:记录 init 调用,验证"图表确实被初始化过" */
function stubEcharts(win) {
  const inits = [];
  const byDom = new Map();
  win.__echartsInits = inits;
  win.echarts = {
    init(el) {
      const rec = { el, id: el && el.id, disposed: false, setOptionCalls: 0, option: null };
      inits.push(rec);
      byDom.set(el, rec);
      const inst = {
        setOption(o) {
          rec.option = o;
          rec.setOptionCalls += 1;
        },
        resize() {},
        dispose() {
          rec.disposed = true;
          byDom.delete(el);
        },
        on() {},
      };
      rec.instance = inst;
      /* getInstanceByDom 要返回"实例"本身(业务代码会对它调 dispose()),
         不能返回记账用的 rec 对象。 */
      return inst;
    },
    getInstanceByDom(el) {
      const rec = byDom.get(el);
      return rec ? rec.instance : null;
    },
  };
}

/** 伪造 pywebview 桥,验证保存链路真的走到了 save_json
 *  - save_json: 写入 DISK(模拟真实落盘),返回 ok
 *  - list_json: 从 DISK 读出 —— 因此"第二次启动"能读到第一次存的东西,
 *    这才是 L3(重启/刷新后自动加载已落盘用例)真正要验证的路径。 */
function stubPywebview(win) {
  win.__saveCalls = [];
  win.__listJsonCalls = [];
  win.__disk = DISK;           // 模块级共享,跨次 boot 保留
  win.pywebview = {
    api: {
      save_json(category, name, content) {
        win.__saveCalls.push({ category, name, content });
        diskPut(category, name, content);
        return {
          ok: true,
          path: `E:/pomelo_requests/data/${category}/${name}.json`,
          bytes: JSON.stringify(content || {}).length,
          category,
          name,
        };
      },
      list_json(category) {
        win.__listJsonCalls.push({ category });
        return { ok: true, items: diskList(category), category };
      },
      delete_json(category, name) {
        return { ok: true, path: `E:/pomelo_requests/data/${category}/${name}.json` };
      },
    },
  };
}

function inject(win, relPath) {
  const code = fs.readFileSync(path.join(WEB, relPath), 'utf8');
  try {
    win.eval(code);
    return null;
  } catch (e) {
    return `${relPath}: ${e.message}`;
  }
}

/** 记录所有 setTimeout 句柄,便于测试结束时清掉被 newcase.save()
 *  留下的"1.5s 后跳回列表"挂起 timer,避免污染下一段测试的可见 section。 */
function hookTimers(win) {
  win.__timers = [];
  const _setTimeout = win.setTimeout.bind(win);
  win.setTimeout = function (fn, ms) {
    const id = _setTimeout(fn, ms);
    win.__timers.push(id);
    return id;
  };
}
function clearPendingTimers(win) {
  if (!win.__timers) return;
  for (const id of win.__timers) try { win.clearTimeout(id); } catch (_) {}
  win.__timers.length = 0;
}

/* ============================================================
 *  DOM 工具(针对 jsdom 无排版引擎做了适配)
 * ========================================================== */
function isVisible(el) {
  let cur = el;
  while (cur && cur.nodeType === 1) {
    if (cur.style && cur.style.display === 'none') return false;
    cur = cur.parentElement;
  }
  return true;
}

/** 近似 innerText:跳过 display:none 的子树 */
function visibleText(el) {
  if (!isVisible(el)) return '';
  let out = '';
  for (const node of el.childNodes) {
    if (node.nodeType === 3) out += node.nodeValue;
    else if (node.nodeType === 1) out += visibleText(node);
  }
  return out;
}

function norm(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function sections(win) {
  return Array.from(win.document.querySelectorAll('section.pomelo-page'));
}

function visibleSections(win) {
  return sections(win).filter(isVisible);
}

function tick(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function goto(win, hash, ms = 150) {
  win.location.hash = hash;
  await tick(ms);
}

function findByText(win, selector, text) {
  return Array.from(win.document.querySelectorAll(selector)).find((el) =>
    norm(el.textContent).includes(text)
  );
}

/** 模拟用户输入:v-model 绑的是 value,靠 input/change 事件回写 */
function setInput(win, el, value) {
  if (!el) return false;
  el.value = value;
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
  return true;
}

/* ============================================================
 *  渲染检查
 * ========================================================== */
function probeRoute(win) {
  const secs = visibleSections(win);
  if (secs.length !== 1) return { error: `可见 section = ${secs.length}` };
  const sec = secs[0];
  const text = norm(visibleText(sec));

  /* 空容器判定用 textContent 而不是可见文本:
     Chrome 的 innerText 对 display:none 元素会退化成 textContent,
     所以隐藏视图里的元素也要按 textContent 判,否则会把"隐藏但有内容"
     的容器误判成空容器。*/
  const empties = Array.from(sec.querySelectorAll('div,ul,ol,tbody'))
    .filter(
      (el) =>
        el.children.length === 0 &&
        norm(el.textContent).length === 0 &&
        el.className &&
        /list|grid|body|items|rows|wrap/.test(String(el.className))
    )
    .map((el) => String(el.className).slice(0, 40));

  return {
    textLen: text.length,
    elements: sec.querySelectorAll('*').length,
    tableRows: sec.querySelectorAll('tbody tr').length,
    inputs: sec.querySelectorAll('input,select,textarea').length,
    liCount: sec.querySelectorAll('li').length,
    empties,
    mustache: (sec.innerHTML.match(/\{\{[^}]{0,40}\}\}/g) || []),
    head: text.slice(0, 70),
  };
}

async function runRenderChecks(win) {
  const by = {};
  for (const [hash, label] of ROUTES) {
    await goto(win, hash);
    const r = probeRoute(win);
    by[hash] = r;
    if (r.error) {
      check(`${label}: 恰好一个可见视图`, false, r.error);
      continue;
    }
    const realMust = r.mustache.filter((m) => !PLACEHOLDERS.has(m));
    check(`${label}: 恰好一个可见视图`, true, `${r.elements} 个元素`);
    check(`${label}: 内容非空`, r.textLen > 150, `textLen=${r.textLen}`);
    check(`${label}: 无模板残留`, realMust.length === 0, realMust.join(',') || '无');
    check(`${label}: 无空容器`, r.empties.length === 0, r.empties.join(' | ') || '无');
  }

  // 各页关键元素
  check('仪表盘: 内容充分', (by['#/dashboard'].textLen || 0) > 400, `textLen=${by['#/dashboard'].textLen}`);
  check(
    '仪表盘: 双图表已初始化',
    win.__echartsInits.filter((r) => r.setOptionCalls > 0).length >= 2,
    `init=${win.__echartsInits.length}`
  );
  check('接口用例: 表格有行', (by['#/apicases'].tableRows || 0) > 0, `rows=${by['#/apicases'].tableRows}`);
  check('测试报告: 历史表有行', (by['#/reports'].tableRows || 0) > 0, `rows=${by['#/reports'].tableRows}`);
  check('执行详情: 列表有行', (by['#/report-detail'].tableRows || 0) > 0, `rows=${by['#/report-detail'].tableRows}`);
  check('新建用例: 表单字段齐全', (by['#/apicases-new'].inputs || 0) >= 5, `inputs=${by['#/apicases-new'].inputs}`);
  check('新建套件: 表单字段齐全', (by['#/testrun-new-suite'].inputs || 0) >= 3, `inputs=${by['#/testrun-new-suite'].inputs}`);
}

/* ============================================================
 *  交互检查
 * ========================================================== */
/** 当前可见视图里的表格行数(排除"没有匹配的用例"这类空态行) */
function rows(win) {
  const secs = visibleSections(win);
  if (secs.length !== 1) return -1;
  return Array.from(secs[0].querySelectorAll('tbody tr')).filter((tr) => tr.children.length > 1).length;
}

async function runInteractionChecks(win) {
  const doc = win.document;
  const rowsIn = () => rows(win);
  const vm = (exp) => (win.__vmEl && win.__vmEl[exp]) || null;

  // 1. 顶部 4 个 tab:逐个点,验路由 + 视图 + 高亮三者都跟上
  await goto(win, '#/dashboard');
  const tabs = Array.from(doc.querySelectorAll('.pomelo-nav a[data-route]'));
  check('顶部 tab: 找到 4 个', tabs.length === 4, `${tabs.length} 个`);
  for (const tab of tabs) {
    const route = tab.getAttribute('data-route');
    const href = tab.getAttribute('href');
    tab.click();
    await tick(220);
    const okHash = win.location.hash === href;
    const okRoute = win.PomeloApp.route === route;
    const sec = win.__sections[route];
    const okView = !!sec && isVisible(sec) && visibleSections(win).length === 1;
    const okActive = tab.classList.contains('is-active');
    const othersActive = tabs.filter((t) => t !== tab && t.classList.contains('is-active')).length;
    check(
      `顶部 tab「${norm(tab.textContent)}」: 点击后视图切换`,
      okHash && okRoute && okView,
      `hash=${okHash} route=${okRoute}(${win.PomeloApp.route}) 视图=${okView}`
    );
    check(
      `顶部 tab「${norm(tab.textContent)}」: 高亮唯一`,
      okActive && othersActive === 0,
      `自身高亮=${okActive} 其他高亮=${othersActive}`
    );
  }
  // 从最后一个 tab 点回第一个,验反向也能切
  if (tabs.length === 4) {
    tabs[0].click();
    await tick(220);
    check('顶部 tab: 可从末位切回首位', win.PomeloApp.route === 'dashboard', `route=${win.PomeloApp.route}`);
  }

  // 2~4. 搜索
  await goto(win, '#/apicases');
  const baseRows = rowsIn();
  const kwInput = vm('apicases.keyword');
  check('接口用例: 搜索框存在', !!kwInput, kwInput ? '' : '预挂载快照里没有 apicases.keyword');
  if (kwInput) {
    setInput(win, kwInput, 'user');
    await tick(150);
    const hit = rowsIn();
    check('搜索: 输入关键词能过滤', hit > 0 && hit < baseRows, `${baseRows} -> ${hit}`);
    setInput(win, kwInput, '');
    await tick(150);
    check('搜索: 清空能还原', rowsIn() === baseRows, `-> ${rowsIn()}`);
  }

  // 5. Tab 筛选
  const tabBtns = Array.from(doc.querySelectorAll('.tab-bar button'));
  check('分类 Tab: 按钮存在', tabBtns.length >= 2, `${tabBtns.length} 个`);
  if (tabBtns.length >= 2) {
    tabBtns[1].click();
    await tick(150);
    const hit = rowsIn();
    check('分类 Tab: 点击能过滤', hit > 0 && hit < baseRows, `${baseRows} -> ${hit}`);
    tabBtns[0].click();
    await tick(150);
    check('分类 Tab: 可还原', rowsIn() === baseRows, `-> ${rowsIn()}`);
  }

  // 6. 视图切换(曾经的真实 bug:卡片视图完全没有 DOM)
  const gridBtn = doc.querySelector('.view-toggle button:nth-child(2)');
  const tableBtn = doc.querySelector('.view-toggle button:nth-child(1)');
  if (gridBtn && tableBtn) {
    const gridSel = 'section.pomelo-page .case-grid';
    gridBtn.click();
    await tick(150);
    const gridEl = doc.querySelector(gridSel);
    const cards = doc.querySelectorAll('.case-grid__card').length;
    const gridVisible = gridEl ? isVisible(gridEl) : false;
    const tableHidden = !isVisible(doc.querySelector('.table-card'));
    check('视图切换: 表格 -> 卡片', gridVisible && cards > 0 && tableHidden,
      `gridVisible=${gridVisible} cards=${cards} tableHidden=${tableHidden}`);
    check('视图切换: 卡片数与表格行数一致', cards === rowsIn(), `cards=${cards} rows=${rowsIn()}`);
    tableBtn.click();
    await tick(150);
    const backGridHidden = !isVisible(doc.querySelector(gridSel));
    const backTableShown = isVisible(doc.querySelector('.table-card'));
    check('视图切换: 卡片 -> 表格', backGridHidden && backTableShown,
      `gridHidden=${backGridHidden} tableShown=${backTableShown}`);
  } else {
    check('视图切换: 切换按钮存在', false, '找不到 .view-toggle button');
  }

  // 7~8. 报告详情:状态筛选 + 抽屉
  await goto(win, '#/report-detail');
  const rdBase = rowsIn();
  const pills = Array.from(doc.querySelectorAll('.filter-pills button'));
  check('报告详情: 筛选按钮存在', pills.length >= 2, `${pills.length} 个`);
  if (pills.length >= 2) {
    pills[1].click();
    await tick(150);
    const hit = rowsIn();
    check('报告详情: 状态筛选生效', hit > 0 && hit < rdBase, `${rdBase} -> ${hit}`);
    pills[0].click();
    await tick(150);
    check('报告详情: 筛选可还原', rowsIn() === rdBase, `-> ${rowsIn()}`);
  }

  const trs = () => Array.from(visibleSections(win)[0].querySelectorAll('tbody tr'))
                        .filter((tr) => tr.children.length > 1);
  const firstRow = trs()[0];
  if (firstRow) {
    check('抽屉: 默认关闭', !win.PomeloApp.reportdetail.caseOpen, `caseOpen=${win.PomeloApp.reportdetail.caseOpen}`);
    firstRow.click();
    await tick(150);
    const opened = win.PomeloApp.reportdetail.caseOpen;
    const title1 = win.PomeloApp.reportdetail.current && win.PomeloApp.reportdetail.current.name;
    check('抽屉: 点行能打开', opened, `caseOpen=${opened} 当前=${title1}`);

    const secondRow = trs()[1];
    if (secondRow) {
      secondRow.click();
      await tick(150);
      const title2 = win.PomeloApp.reportdetail.current && win.PomeloApp.reportdetail.current.name;
      check('抽屉: 切换行内容联动', title1 !== title2, `${title1} -> ${title2}`);
    }
    const closeBtn = doc.querySelector('.drawer-panel__head .icon-btn');
    check('抽屉: 关闭按钮存在', !!closeBtn);
    if (closeBtn) { closeBtn.click(); await tick(150); }
    check('抽屉: 可关闭', !win.PomeloApp.reportdetail.caseOpen, `caseOpen=${win.PomeloApp.reportdetail.caseOpen}`);
  } else {
    check('报告详情: 表格有可点击行', false, '找不到 tbody tr');
  }

  // 9~10. 测试执行:日志流 + 进度条
  await goto(win, '#/testrun');
  const l1 = (win.PomeloApp.testrun.logLines || []).length;
  const p1 = win.PomeloApp.testrun.progress.percent;
  await tick(2600);   // 日志 1500ms 一跳,进度 800ms 一跳
  const l2 = (win.PomeloApp.testrun.logLines || []).length;
  const p2 = win.PomeloApp.testrun.progress.percent;
  check('测试执行: 日志流在增长', l2 > l1, `${l1} -> ${l2} 行`);
  check('测试执行: 进度在推进', p2 > p1, `${p1}% -> ${p2}%`);

  // 11. 新建用例 -> 保存 -> 走 pywebview 桥
  await goto(win, '#/apicases-new');
  const nameInput = vm('newcase.form.name');
  const pathInput = vm('newcase.form.path');
  check('新建用例: 名称/路径输入框存在', !!nameInput && !!pathInput,
    `name=${!!nameInput} path=${!!pathInput}`);
  const callsBefore = win.__saveCalls.length;
  setInput(win, nameInput, 'jsdom_冒烟用例');
  setInput(win, pathInput, '/api/v1/smoke');
  await tick(80);
  const saveBtn = findByText(win, 'button', '保存用例');
  check('新建用例: 保存按钮存在', !!saveBtn);
  if (saveBtn) {
    saveBtn.click();
    await tick(300);
    const calls = win.__saveCalls;
    check('新建用例: 保存走到 pywebview 桥', calls.length === callsBefore + 1, `调用数=${calls.length}`);
    const last = calls[calls.length - 1];
    check('新建用例: 落盘 category=cases', last && last.category === 'cases', `category=${last && last.category}`);
    check('新建用例: 文件名取自用例名', last && last.name === 'jsdom_冒烟用例', `name=${last && last.name}`);
    check('新建用例: payload 含 method/path',
      last && last.content && last.content.case && last.content.case.path === '/api/v1/smoke',
      last ? JSON.stringify(last.content.case) : '无');
    check('新建用例: 状态机置为 ok', win.PomeloApp.newcase.status === 'ok', `status=${win.PomeloApp.newcase.status} msg=${win.PomeloApp.newcase.message}`);
    const toast = doc.querySelector('.toast.is-ok');
    check('新建用例: 成功 toast 出现', !!toast && isVisible(toast), toast ? norm(visibleText(toast)) : '无');
  }
  clearPendingTimers(win);   // 掐掉"1.5s 后自动跳回列表",避免跳走污染下一段

  // 12. 新建套件 -> 保存
  await goto(win, '#/testrun-new-suite');
  const suiteName = vm('newsuite.form.name');
  check('新建套件: 名称输入框存在', !!suiteName);
  const sBefore = win.__saveCalls.length;
  setInput(win, suiteName, 'jsdom_冒烟套件');
  await tick(80);
  const suiteBtn = findByText(win, 'button', '保存套件');
  check('新建套件: 保存按钮存在', !!suiteBtn);
  if (suiteBtn) {
    suiteBtn.click();
    await tick(300);
    const last = win.__saveCalls[win.__saveCalls.length - 1];
    check('新建套件: 保存走到 pywebview 桥', win.__saveCalls.length === sBefore + 1, `调用数=${win.__saveCalls.length}`);
    check('新建套件: 落盘 category=suites', last && last.category === 'suites', `category=${last && last.category}`);
    check('新建套件: 状态机置为 ok', win.PomeloApp.newsuite.status === 'ok', `status=${win.PomeloApp.newsuite.status}`);
  }
  clearPendingTimers(win);

  /* ============================================================
   *  L1 — 保存后立刻刷新活跃列表 (治"保存失败但文件写入成功")
   * ========================================================== */
  await goto(win, '#/apicases');
  const listBefore = win.PomeloApp.apicases.list.length;
  const savedNamesBefore = new Set(win.PomeloApp.apicases.list.map((c) => c.name));
  check('L1 准备: 起始列表行数 > 0', listBefore > 0, `起始 ${listBefore} 行`);

  await goto(win, '#/apicases-new');
  const L1name = vm('newcase.form.name');
  const L1path = vm('newcase.form.path');
  setInput(win, L1name, 'L1_立即可见用例');
  setInput(win, L1path, '/api/v1/l1');
  await tick(80);
  const L1btn = findByText(win, 'button', '保存用例');
  L1btn && L1btn.click();
  await tick(200);
  /* 这里不要等 1.5s 跳回,我们要看"在跳回之前"活跃 list 是否已经多了这条 */
  const listMid = win.PomeloApp.apicases.list.length;
  check(
    'L1: 保存中 apicases.list 实时增加 1 条 (无需跳转)',
    listMid === listBefore + 1,
    `${listBefore} -> ${listMid}`
  );
  const newRow = win.PomeloApp.apicases.list[win.PomeloApp.apicases.list.length - 1];
  check(
    'L1: 新插入行字段对齐 (name/method/path)',
    newRow && newRow.name === 'L1_立即可见用例' && newRow.method === 'GET' && newRow.path === '/api/v1/l1',
    newRow ? `${newRow.name}/${newRow.method}/${newRow.path}` : '无'
  );

  /* 清掉 save() 挂起的 1.5s 跳转 timer,自己控制回列表的时机 */
  clearPendingTimers(win);
  await goto(win, '#/apicases', 250);
  await tick(250);                   // 给 v-for 重新求值 + DOM patch 多一点时间
  const visibleNames = Array.from(visibleSections(win)[0].querySelectorAll('tbody tr'))
    .map((tr) => norm(tr.textContent));
  check(
    'L1: 跳回列表后 L1_立即可见用例 已显示',
    visibleNames.some((t) => t.includes('L1_立即可见用例')),
    `表格 ${visibleNames.length} 行,首列样本: ${visibleNames[0] ? visibleNames[0].slice(0, 50) : '无'}`
  );
  /* 长度口径校验:DOM 行数 ≈ apicases.list.length */
  const listLenAfterJump = win.PomeloApp.apicases.list.length;
  check(
    'L1: 表格行数与 list.length 对齐',
    visibleNames.length === listLenAfterJump,
    `DOM=${visibleNames.length} list=${listLenAfterJump}`
  );
  if (visibleNames.length !== listLenAfterJump) {
    note(`[L1 诊断] hash=${win.location.hash} route=${win.PomeloApp.route} ` +
      `activeTab=${win.PomeloApp.apicases.activeTab} ` +
      `可见 section=${visibleSections(win).length} ` +
      `全表 tbody=${win.document.querySelectorAll('tbody tr').length} ` +
      `filtered=${(win.PomeloApp.apicases.filteredList || []).length}`);
  }

  /* ============================================================
   *  L2 — 仪表盘 "+ 新建模块" 弹窗 + 顶部 tab 同步增加
   * ========================================================== */
  await goto(win, '#/dashboard');
  const beforeMods = win.PomeloApp.apicases.modules.length;
  const beforeTabs = win.PomeloApp.apicases.tabs.length;
  const beforeDash = win.PomeloApp.dashboard.projects.length;

  const newBtn = findByText(win, '.card__more', '+ 新建');
  check('L2: 仪表盘"+ 新建"链接存在', !!newBtn);
  check('L2 准备: 初始模块数 = 5', beforeMods === 5, `当前 ${beforeMods}`);

  newBtn.click();
  await tick(120);
  const modalShown = win.PomeloApp.dashboard.showNewModule;
  check('L2: 点击后弹窗打开 (showNewModule=true)', modalShown === true,
    `showNewModule=${modalShown}`);

  const nameEl = doc.querySelector('#newModuleName');
  check('L2: 弹窗里 #newModuleName 输入框存在', !!nameEl);
  setInput(win, nameEl, '数据中心');
  await tick(60);
  const confirmBtn = findByText(win, '.modal__actions button.btn-primary', '保存');
  check('L2: 弹窗底部"保存"按钮存在', !!confirmBtn);
  confirmBtn.click();
  await tick(250);

  /* ★ 验证三条联动链 */
  const afterMods = win.PomeloApp.apicases.modules.length;
  const afterTabs = win.PomeloApp.apicases.tabs.length;
  const afterDash = win.PomeloApp.dashboard.projects.length;
  check(
    'L2: apicases.modules 增 1',
    afterMods === beforeMods + 1,
    `${beforeMods} -> ${afterMods}`
  );
  check(
    'L2: apicases.tabs 增 1 (全部 + 5 默认 + 数据中心 = 7)',
    afterTabs === beforeTabs + 1,
    `${beforeTabs} -> ${afterTabs}`
  );
  check(
    'L2: dashboard.projects 增 1',
    afterDash === beforeDash + 1,
    `${beforeDash} -> ${afterDash}`
  );
  check(
    'L2: 新模块名出现在 tabs/getter',
    win.PomeloApp.apicases.tabs.some((t) => t.label === '数据中心'),
    win.PomeloApp.apicases.tabs.map((t) => t.label).join('|')
  );
  const diskMods = (win.__disk.modules || {}).modules || {};
  check(
    'L2: 数据中心已同步到底层 save_json(modules)',
    diskMods.modules && diskMods.modules.some((m) => m.name === '数据中心'),
    diskMods.modules
      ? diskMods.modules.map((m) => m.name).join('|')
      : '未落盘'
  );

  /* 切到 #/apicases,确认新 tab 渲染并可点击 */
  await goto(win, '#/apicases');
  await tick(400);                     // vue v-for 重渲多耗一拍
  const newTabBtn = Array.from(doc.querySelectorAll('.tab-bar button'))
    .find((b) => norm(b.textContent) === '数据中心');
  check('L2: 顶部 tab"数据中心"已渲染', !!newTabBtn, newTabBtn ? '' : '未找到');
  /* 点这个 tab,期望:列表立即只剩 project="数据中心" 的用例(本次应仍空) */
  const listAtTabSwitch = win.PomeloApp.apicases.list.length;
  if (newTabBtn) {
    newTabBtn.click();
    await tick(120);
    const filteredAfter = win.PomeloApp.apicases.filteredList.length;
    check(
      'L2: 点击"数据中心"tab 列表正确过滤(无用例→0)',
      filteredAfter === 0,
      `起始 ${listAtTabSwitch} -> 过滤后 ${filteredAfter}`
    );
  }

  /* 弹窗边界:空名拦截 */
  newBtn.click();
  await tick(80);
  const emptyBtn = findByText(win, '.modal__actions button.btn-primary', '保存');
  emptyBtn.click();
  await tick(80);
  const stillOpen = win.PomeloApp.dashboard.showNewModule === true;
  const errShown = !!win.PomeloApp.dashboard.newModuleErr;
  check(
    'L2: 空名不关闭弹窗 + 显示错误',
    stillOpen && errShown,
    `stillOpen=${stillOpen} err="${win.PomeloApp.dashboard.newModuleErr}"`
  );
  /* 关闭弹窗 */
  const cancelBtn = findByText(win, '.modal__actions button.btn-ghost', '取消');
  cancelBtn.click();
  await tick(80);
  check('L2: 取消按钮关闭弹窗', win.PomeloApp.dashboard.showNewModule === false,
    `showNewModule=${win.PomeloApp.dashboard.showNewModule}`);

  /* ============================================================
   *  L3 — newcase.save() 选未知 project 时,自动 PomeloModules.add
   * ========================================================== */
  await goto(win, '#/apicases-new');
  const modsBefore3 = win.PomeloApp.apicases.modules.length;
  const L3name = vm('newcase.form.name');
  const L3path = vm('newcase.form.path');
  setInput(win, L3name, 'L3_营销中心用例');
  setInput(win, L3path, '/api/v1/marketing');
  /* 直接改 form.project 到一个全新的名(模拟用户改了 select 选项) */
  win.PomeloApp.newcase.form.project = '营销中心';
  await tick(40);
  const L3btn = findByText(win, 'button', '保存用例');
  L3btn.click();
  await tick(200);
  const modsAfter3 = win.PomeloApp.apicases.modules.length;
  check(
    'L3: 选了未注册的 project 后自动追加模块',
    modsAfter3 === modsBefore3 + 1,
    `${modsBefore3} -> ${modsAfter3}`
  );
  check(
    'L3: 新模块名为"营销中心"',
    win.PomeloApp.apicases.modules.some((m) => m.name === '营销中心'),
    win.PomeloApp.apicases.modules.map((m) => m.name).join('|')
  );
}

/* ============================================================
 *  main
 * ========================================================== */
/** 启动一次应用,返回 { win, failures, optionalFailures }。
 *  第二次调用即"模拟重启":DISK 是模块级变量,内容保留,
 *  而 window / Vue 实例 / localStorage 全是新的 —— 这正是 L3 要验的路径。 */
function boot() {
  const dom = buildDom();
  const win = dom.window;

  stubEcharts(win);
  stubPywebview(win);
  shimLayout(win);
  hookTimers(win);

  /* layui 在 jsdom 里必然报错:它靠自己的 <script src> 标签定位资源路径,
     而这里没有 <script src>(被剥离后手动注入)。
     项目只用到 layui 的图标字体(CSS),没有任何 JS API 调用,所以允许失败。 */
  const OPTIONAL = new Set(['vendor/layui/layui.js']);

  const failures = [];
  const optionalFailures = [];
  for (const rel of SCRIPTS) {
    const err = inject(win, rel);
    if (!err) continue;
    (OPTIONAL.has(rel) ? optionalFailures : failures).push(err);
  }
  return { win, failures, optionalFailures };
}

/* ============================================================
 *  L3-restart — 冷启动(全新 window + 全新 Vue 实例,只有 data/ 保留)
 * ========================================================== */
async function runRestartChecks() {
  const { win } = boot();
  await tick(400);   // 等 init() 里两个 await 完成: PomeloModules.list / listJson('cases')

  const app = win.PomeloApp;
  check('L3重启: 冷启动后 PomeloApp 已挂载', !!app, typeof app);
  if (!app) { win.close(); return; }

  const names = (app.apicases.list || []).map((c) => c.name);
  check(
    'L3重启: 已落盘的用例被自动加载进列表',
    names.includes('jsdom_冒烟用例') && names.includes('L1_立即可见用例'),
    `共 ${names.length} 条,尾部: ${names.slice(-3).join('|')}`
  );

  const modNames = (app.apicases.modules || []).map((m) => m.name);
  check(
    'L3重启: 已落盘的模块被自动加载(含新建的数据中心/营销中心)',
    modNames.includes('数据中心') && modNames.includes('营销中心'),
    modNames.join('|')
  );

  check(
    'L3重启: 顶部 tab 由模块派生(全部用例 + N 个模块)',
    app.apicases.tabs.length === modNames.length + 1,
    `tabs=${app.apicases.tabs.length} modules=${modNames.length}`
  );

  check(
    'L3重启: 新建用例下拉跟随模块列表',
    (app.newcase.projects || []).includes('数据中心'),
    (app.newcase.projects || []).join('|')
  );

  /* DOM 层也确认渲染出来了(不只是内存里有) */
  win.location.hash = '#/apicases';
  await tick(300);
  const rows = Array.from(visibleSections(win)[0].querySelectorAll('tbody tr'))
    .map((tr) => norm(tr.textContent));
  check(
    'L3重启: 表格真的渲染出已加载的用例',
    rows.some((t) => t.includes('jsdom_冒烟用例')),
    `${rows.length} 行,首行: ${rows[0] ? rows[0].slice(0, 40) : '无'}`
  );

  clearPendingTimers(win);
  win.close();
}

(async function main() {
  const { win, failures, optionalFailures } = boot();

  check('核心脚本注入无异常', failures.length === 0, failures.join(' | ') || '无');
  if (optionalFailures.length) {
    note(`可选依赖注入失败(jsdom 下预期内,不影响功能): ${optionalFailures.join(' | ')}`);
  }
  if (failures.length) {
    note('注意:核心脚本注入失败会导致后续检查大面积不成立');
  }

  check('petite-vue 已加载', typeof win.PetiteVue === 'object' && !!win.PetiteVue.createApp);
  check('PomeloApp 已挂载', !!win.PomeloApp, typeof win.PomeloApp);
  if (win.PomeloApp) {
    const comps = ['dashboard', 'apicases', 'apidetail', 'testrun', 'reports', 'reportdetail', 'newcase', 'newsuite'];
    const missing = comps.filter((c) => !win.PomeloApp[c]);
    check('8 个子组件全部实例化', missing.length === 0, missing.join(',') || '无缺失');
  }

  await tick(300); // 等 init() / $nextTick(图表)

  await runRenderChecks(win);
  await runInteractionChecks(win);

  /* 冷启动(模拟重启/刷新):只有 data/ 目录保留 */
  await runRestartChecks();

  /* ---------------- 输出 ---------------- */
  console.log('\n' + '='.repeat(78));
  console.log('  jsdom 渲染 + 交互冒烟检查');
  console.log('='.repeat(78));
  if (notes.length) {
    console.log('\n  说明:');
    for (const n of notes) console.log('    - ' + n);
  }
  console.log('\n  判定:');
  for (const c of checks) {
    console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`);
  }
  const bad = checks.filter((c) => !c.ok);
  console.log(`\n  结果: ${checks.length - bad.length}/${checks.length} 通过`);
  if (bad.length) {
    console.log('\n  未通过:');
    for (const c of bad) console.log(`    - ${c.name}  ${c.detail || ''}`);
  }

  win.close();
  process.exit(bad.length ? 1 : 0);
})().catch((e) => {
  console.error('脚本自身异常:', e);
  process.exit(3);
});
