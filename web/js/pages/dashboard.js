/* ============================================================
 *  仪表盘组件(注册到 PetiteVue 全局)
 *  ------------------------------------------------------------
 *  数据源(全部来自 data/ 配置,绝不写死任何数值):
 *    - 接口用例  → PomeloStorage.listJson('cases',  {recursive:true})
 *    - 测试套件  → PomeloStorage.listJson('suites', {recursive:true})
 *    - Mock 服务 → PomeloStorage.listJson('mocks',  {recursive:true})
 *    - 测试模块  → PomeloModules.list()
 *    - 执行记录  → data/runs/(当前未落盘,恒为空 → 显示「暂无执行记录」)
 *
 *  空态约定(2026-09 调整):
 *    - 统计卡:无数据 → 数字显示 0,卡片不隐藏
 *    - 分布图(趋势/通过率):无数据 → 样式全保留(坐标轴/网格/环形),
 *      只是数值为 0,不整体替换成「暂无数据」文本
 *    - 项目卡/执行列表:无数据 → 显示空态提示
 *
 *  ⚠ mockData 参数仅保留签名兼容(app.js 仍传 M.dashboard),
 *    本组件显示的全部数值均来自 storage,不读取 mockData。
 * ========================================================== */
window.dashboardComponent = function (mockData) {
  /* 本组件对象挂在 root scope 下,方法内的 this 是组件自身而非 root scope,
     因此不依赖 this.$refs,统一用 DOM id 取容器。 */
  const getChart = (id) => {
    if (!window.echarts) return null;
    const el = document.getElementById(id);
    if (!el) return null;
    const exist = window.echarts.getInstanceByDom(el);
    if (exist) exist.dispose();
    return window.echarts.init(el);
  };

  /* 毫秒 → "mm:ss"(与 reports.js 同款;缺失会让 init 抛 ReferenceError 被
     catch 吞掉,整页数据清零 —— 2026-09-04 仪表盘全零的根因) */
  const _fmtDur = (ms) => {
    const s = Math.round((Number(ms) || 0) / 1000);
    const m = Math.floor(s / 60);
    return (m < 10 ? "0" : "") + m + ":" + ((s % 60) < 10 ? "0" : "") + (s % 60);
  };

  // 统计卡只描述"展示什么",数值在 init() 里从真实数据算,不写死。
  // 图标用内联 SVG(Feather 线性风格):本地 layui 字体缺 server/app 等
  // 字形会渲染成方块(□),SVG 不依赖字体,任何环境都能画出来。
  const svgIcon = (inner) =>
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"'
    + ' stroke="currentColor" stroke-width="2" stroke-linecap="round"'
    + ' stroke-linejoin="round" aria-hidden="true">' + inner + "</svg>";
  const STAT_DEFS = [
    { key: "cases",   label: "接口用例", bg: "linear-gradient(135deg,#6366f1,#818cf8)",
      icon: svgIcon('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>') },                     // 代码尖括号
    { key: "suites",  label: "测试套件", bg: "linear-gradient(135deg,#0ea5e9,#38bdf8)",
      icon: svgIcon('<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>') }, // 层叠
    { key: "modules", label: "测试模块", bg: "linear-gradient(135deg,#10b981,#34d399)",
      icon: svgIcon('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>') }, // 四宫格
    { key: "mocks",   label: "Mock 服务", bg: "linear-gradient(135deg,#f59e0b,#fbbf24)",
      icon: svgIcon('<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>') },                  // 服务器
  ];

  // 项目卡图标:按模块顺序轮换(同样走 SVG,规避字体缺字形)
  const PROJ_ICONS = [
    svgIcon('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),                        // 文件夹
    svgIcon('<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>'), // 标签
    svgIcon('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>'), // 立方体
    svgIcon('<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'), // 地球
  ];
  const projIcon = (i) => PROJ_ICONS[i % PROJ_ICONS.length];

  return {
    /* ---- 数据(初始为空态,init() 后由 data/ 填充) ---- */
    cases:    [],
    suites:   [],
    mocks:    [],
    modules:  [],
    runs:     [],
    stats:    [],
    projects: [],
    trend:    { categories: [], passed: [], failed: [], skipped: [] },
    rate:     { passed: 0, failed: 0, skipped: 0, percent: 0 },
    hasRunData: false,
    loading:  true,

    /* 趋势图时间范围(天):7/15/30,页头下拉切换 */
    rangeDays: 7,
    rangeOpen: false,
    _reports: [],   /* init 时缓存原始报告,切换范围时免重读盘 */

    /* 新建模块弹窗 */
    showNewModule: false,
    newModuleName: "",
    newModuleErr:  "",

    renderCharts() {
      this.renderTrend();
      this.renderRate();
    },

    /* ---- 趋势图时间范围切换 ---- */
    toggleRange() { this.rangeOpen = !this.rangeOpen; },
    setRangeDays(n) {
      this.rangeDays = n;
      this.rangeOpen = false;
      this.computeTrend();
      this.renderTrend();
    },

    /* 按当前 rangeDays 重算趋势日桶(用 _reports 缓存,不重读盘) */
    computeTrend() {
      const n = Number(this.rangeDays) || 7;
      const days = [];
      const dayKey = (d) => String(d.getMonth() + 1).padStart(2, "0")
        + "-" + String(d.getDate()).padStart(2, "0");
      const now = new Date();
      for (let i = n - 1; i >= 0; i--) {
        days.push(dayKey(new Date(now.getTime() - i * 86400000)));
      }
      const buckets = {};   // "MM-DD" → {passed, failed, skipped}
      days.forEach((k) => { buckets[k] = { passed: 0, failed: 0, skipped: 0 }; });
      (this._reports || []).forEach((rp) => {
        const t = String((rp.report.finishedAt || rp.report.startedAt || ""))
          .replace(" ", "T");
        const d = new Date(t);
        if (isNaN(d.getTime())) return;
        const k = dayKey(d);
        if (!buckets[k]) return;
        buckets[k].passed  += Number(rp.report.passed)  || 0;
        buckets[k].failed  += Number(rp.report.failed)  || 0;
        buckets[k].skipped += Number(rp.report.skipped) || 0;
      });
      this.trend = {
        categories: days,
        passed:  days.map((k) => buckets[k].passed),
        failed:  days.map((k) => buckets[k].failed),
        skipped: days.map((k) => buckets[k].skipped),
      };
    },

    /* 测试执行趋势(折线) — 无数据时样式全保留,数值为 0(空线贴底) */
    renderTrend() {
      const chart = getChart("trendChart");
      if (!chart) return;
      const t = this.trend;
      const categories = (t.categories && t.categories.length)
        ? t.categories.slice()
        : (function () {
            const days = [];
            const now = new Date();
            const n = Number(this.rangeDays) || 7;
            for (let i = n - 1; i >= 0; i--) {
              const d = new Date(now.getTime() - i * 86400000);
              days.push(String(d.getMonth() + 1).padStart(2, "0") + "-"
                + String(d.getDate()).padStart(2, "0"));
            }
            return days;
          }).call(this);
      chart.setOption({
        grid: { left: 30, right: 18, top: 18, bottom: 28 },
        tooltip: { trigger: "axis" },
        xAxis: { type: "category", boundaryGap: false, data: categories, axisLine: { lineStyle: { color: "#e5e7eb" } }, axisLabel: { color: "#94a3b8" } },
        yAxis: { type: "value", minInterval: 1, axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: "#f1f5f9" } }, axisLabel: { color: "#94a3b8" } },
        series: [
          { name: "通过", type: "line", smooth: true, symbolSize: 8, itemStyle: { color: "#6366f1" }, lineStyle: { width: 3 }, areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [ { offset: 0, color: "rgba(99,102,241,.35)" }, { offset: 1, color: "rgba(99,102,241,.02)" } ] } }, data: t.passed && t.passed.length ? t.passed : categories.map(() => 0) },
          { name: "失败", type: "line", smooth: true, symbolSize: 6, itemStyle: { color: "#ef4444" }, lineStyle: { width: 2 }, data: t.failed && t.failed.length ? t.failed : categories.map(() => 0) },
          { name: "跳过", type: "line", smooth: true, symbolSize: 6, itemStyle: { color: "#f59e0b" }, lineStyle: { width: 2 }, data: t.skipped && t.skipped.length ? t.skipped : categories.map(() => 0) },
        ],
      });
      if (!window.__pomeloDashResizeBound) {
        window.__pomeloDashResizeBound = true;
        window.addEventListener("resize", () => window.PomeloApp && window.PomeloApp.dashboard && window.PomeloApp.dashboard.renderCharts());
      }
    },

    /* 测试通过率(环形) — 无数据时保留灰底占位环,中心显示 0% */
    renderRate() {
      const chart = getChart("rateChart");
      if (!chart) return;
      const r = this.rate;
      chart.setOption({
        series: [{
          type: "pie", radius: ["72%", "92%"], avoidLabelOverlap: false,
          label: { show: false }, labelLine: { show: false },
          silent: true,
          data: this.hasRunData ? [
            { value: r.passed,  itemStyle: { color: "#6366f1" } },
            { value: r.failed,  itemStyle: { color: "#ef4444" } },
            { value: r.skipped, itemStyle: { color: "#f59e0b" } },
          ] : [
            { value: 1, itemStyle: { color: "#f1f5f9" } },
          ],
        }],
        graphic: [{
          type: "text", left: "center", top: "42%",
          style: { text: `${r.percent}%`, fill: "#1e293b", fontSize: 26, fontWeight: "bold", textAlign: "center" },
        }, {
          type: "text", left: "center", top: "58%",
          style: { text: "通过率", fill: "#94a3b8", fontSize: 12, textAlign: "center" },
        }],
      });
      if (!window.__pomeloDashResizeBound) {
        window.__pomeloDashResizeBound = true;
        window.addEventListener("resize", () => window.PomeloApp && window.PomeloApp.dashboard && window.PomeloApp.dashboard.renderCharts());
      }
    },

    /* ============================================================
     * init(由 app.init() 显式调)
     *   并发读取 data/ 真实数据,派生所有统计与图表数据源。
     *   任一项无数据 → 显示 0 / 暂无数据,不抛错、不回退写死数值。
     * ========================================================== */
    async init() {
      try {
        const [c, s, m, mods, rps] = await Promise.all([
          window.PomeloStorage.listJson("cases",  { recursive: true }),
          window.PomeloStorage.listJson("suites", { recursive: true }),
          window.PomeloStorage.listJson("mocks",  { recursive: true }),
          window.PomeloModules.list(),
          /* 执行记录/通过率/趋势 = data/reports 真实执行报告 */
          window.PomeloStorage.listJson("reports"),
        ]);

        this.cases   = (c    && c.ok    && Array.isArray(c.items))    ? c.items    : [];
        this.suites  = (s    && s.ok    && Array.isArray(s.items))    ? s.items    : [];
        this.mocks   = (m    && m.ok    && Array.isArray(m.items))    ? m.items    : [];
        this.modules = Array.isArray(mods) ? mods : [];
        const reports = (rps && rps.ok && Array.isArray(rps.items))
          ? rps.items
              .map((it) => it && it.content)
              .filter((ct) => ct && ct.report && ct.report.reportNo)
              .sort((a, b) => String(b.report.reportNo)
                .localeCompare(String(a.report.reportNo)))
          : [];

        /* 统计卡:数值来自真实数据,无则 0 */
        this.stats = STAT_DEFS.map((d) => ({
          label: d.label, icon: d.icon, bg: d.bg,
          value: (this[d.key] || []).length,
        }));

        /* 测试项目卡:来自模块列表;用例数按 data/cases/ 真实归类。
           已归档文件按 it.module(模块 key)计数;未归档文件 module 为空,
           回落 content.case.project(模块名) → 通过 name 映射到 key。 */
        const nameToKey = {};
        this.modules.forEach((mod) => { nameToKey[mod.name] = mod.key; });
        const caseByModule = {};
        this.cases.forEach((it) => {
          let k = it.module || "";
          if (!k) {
            try {
              const proj = it.content && it.content.case && it.content.case.project;
              if (proj) k = nameToKey[proj] || "";
            } catch (_) { /* 内容结构异常时跳过该文件 */ }
          }
          if (k) caseByModule[k] = (caseByModule[k] || 0) + 1;
        });
        this.projects = this.modules.map((mod, i) => ({
          id:          mod.key,
          name:        mod.name,
          cases:       caseByModule[mod.key] || 0,
          status:      mod.status || "normal",
          statusLabel: mod.statusLabel || "● 正常",
          icon:        projIcon(i),
          bg:          mod.color || "linear-gradient(135deg,#64748b,#0ea5e9)",
        }));

        /* ---- 执行记录:最近 5 份报告(data/reports) ---- */
        this.runs = reports.slice(0, 5).map((rp, i) => {
          const r = rp.report;
          const failed = Number(r.failed) || 0;
          return {
            id: i + 1,
            title: r.suite || "测试套件",
            reportNo: r.reportNo,
            env: r.env || "default",
            status: failed > 0 ? "fail" : "pass",
            icon: failed > 0 ? "layui-icon-close" : "layui-icon-ok",
            total: Number(r.total) || 0,
            passed: Number(r.passed) || 0,
            failed: failed,
            skipped: Number(r.skipped) || 0,
            duration: _fmtDur(r.elapsedMs),
          };
        });

        /* ---- 通过率 + 趋势:按报告聚合 ---- */
        const agg = { passed: 0, failed: 0, skipped: 0 };
        reports.forEach((rp) => {
          const r = rp.report;
          agg.passed  += Number(r.passed)  || 0;
          agg.failed  += Number(r.failed)  || 0;
          agg.skipped += Number(r.skipped) || 0;
        });
        const sum = agg.passed + agg.failed + agg.skipped;
        this.hasRunData = sum > 0;
        this.rate = {
          passed: agg.passed, failed: agg.failed, skipped: agg.skipped,
          percent: sum ? Math.round((agg.passed / sum) * 100) : 0,
        };

        /* ---- 趋势:缓存原始报告,按当前 rangeDays 落日桶 ---- */
        this._reports = reports;
        this.computeTrend();
      } catch (e) {
        console.error("[Pomelo] 仪表盘数据加载失败:", e);
        this.stats = STAT_DEFS.map((d) => ({ label: d.label, icon: d.icon, bg: d.bg, value: 0 }));
        this.projects = [];
        this.runs = [];
        this.hasRunData = false;
      } finally {
        this.loading = false;
        /* 数据就绪后无条件重绘一次(空态也画:坐标轴/网格/灰环全保留,数值为 0) */
        window.PetiteVue.nextTick(() => this.renderCharts());
      }
    },

    /* ============================================================
     * 新建模块交互
     * ========================================================== */
    openNewModule() {
      this.newModuleName = "";
      this.newModuleErr = "";
      this.showNewModule = true;
      /* ⚠ $nextTick 只挂在【根 scope】上(createApp 里 t.scope.$nextTick=he),
         子组件的 proxy(dashboard)拿不到,必须用全局的 PetiteVue.nextTick。 */
      window.PetiteVue.nextTick(() => {
        const el = document.getElementById("newModuleName");
        if (el) el.focus();
      });
    },
    closeNewModule() {
      this.showNewModule = false;
      this.newModuleName = "";
      this.newModuleErr = "";
    },
    async confirmNewModule() {
      const name = String(this.newModuleName || "").trim();
      if (!name) {
        this.newModuleErr = "请输入模块名称";
        return;
      }
      if (name.length > 32) {
        this.newModuleErr = "模块名不要超过 32 字符";
        return;
      }

      const r = await window.PomeloModules.add(name);
      if (!r || !r.ok) {
        this.newModuleErr = (r && r.error) || "新建失败";
        return;
      }
      // 同步到仪表盘:模块列表、项目卡与「测试模块」统计卡一起刷新
      // (新模块用例数恒为 0;stats 必须用 STAT_DEFS 重算,
      //  只改 this.modules 不会自动反映到 stats 数组上)
      this.modules = r.modules.slice();
      this.projects = r.modules.map((m, i) => ({
        id:          m.key,
        name:        m.name,
        cases:       m.cases || 0,
        status:      m.status || "normal",
        statusLabel: m.statusLabel || "● 正常",
        icon:        projIcon(i),
        bg:          m.color || "linear-gradient(135deg,#64748b,#0ea5e9)",
      }));
      this.stats = STAT_DEFS.map((d) => ({
        label: d.label, icon: d.icon, bg: d.bg,
        value: (this[d.key] || []).length,
      }));
      // 同步到 apicases.modules(顶部 tab 与下拉共享)
      const app = window.PomeloApp;
      if (app && app.apicases) app.apicases.modules = r.modules.slice();

      this.closeNewModule();
    },
  };
};
