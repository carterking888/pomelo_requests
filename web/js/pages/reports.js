/* ============================================================
 *  测试报告 — 全部来自真实执行结果(data/reports/*.json)
 *  - 执行引擎(run_suite)每跑完一次套件就落一份报告:
 *      { report: {reportNo, suite, env, startedAt, finishedAt,
 *                 elapsedMs, total, passed, failed, skipped, stopped},
 *        cases:  [{index, name, path, protocol, status, elapsedMs, message}] }
 *  - 统计卡/环形图/失败分析 = 最新一份报告;报告历史 = 全部报告倒序
 *  - 没有任何报告时展示零值与空态,不再有写死数据
 * ========================================================== */
window.reportsComponent = function () {
  /* 同 dashboard:组件挂在 root scope 下,方法内 this 非 root scope,
     统一用 DOM id 取容器,并避免 echarts 重复 init。 */
  const getChart = (id) => {
    if (!window.echarts) return null;
    const el = document.getElementById(id);
    if (!el) return null;
    const exist = window.echarts.getInstanceByDom(el);
    if (exist) exist.dispose();
    return window.echarts.init(el);
  };

  /* 毫秒 → "mm:ss" */
  const _fmtDur = (ms) => {
    const s = Math.round((Number(ms) || 0) / 1000);
    const m = Math.floor(s / 60);
    return (m < 10 ? "0" : "") + m + ":" + ((s % 60) < 10 ? "0" : "") + (s % 60);
  };
  const _rate = (passed, total) =>
    total ? Math.round((passed / total) * 1000) / 10 : 0;

  return {
    summary: { total: 0, passed: 0, failed: 0, skipped: 0,
               duration: "00:00", passRate: 0, failRate: 0 },
    failures: [],   // 最新报告的失败用例 [{id, name, reason}]
    history: [],    // 全部报告倒序 [{id, reportNo, name, module, state, ...}]
    _latestCases: [],

    /* ============================================================
     * 历史表分页(每页 10 条,前端分页,与 apicases 同一套 pager 样式)
     * ========================================================== */
    page: 1,
    pageSize: 10,
    get total() {
      return this.history.length;
    },
    get totalPages() {
      return Math.max(1, Math.ceil(this.total / this.pageSize));
    },
    get safePage() {
      return Math.min(this.page, this.totalPages);
    },
    get pagedHistory() {
      const p = this.safePage;
      return this.history.slice((p - 1) * this.pageSize, p * this.pageSize);
    },
    /* 分页条展示数据全部在这里算好,模板不做表达式运算(坑 5) */
    get pageInfo() {
      const total = this.total;
      const pageCount = this.totalPages;
      const cur = this.safePage;
      const from = total === 0 ? 0 : (cur - 1) * this.pageSize + 1;
      const to = Math.min(total, cur * this.pageSize);
      /* 页码窗口:≤7 页全显;否则 首页 … 当前±1 … 尾页 */
      const pages = [];
      const add = (n) => pages.push({ k: "p" + n, n: n, label: String(n), ell: false });
      const ell = () => pages.push({ k: "e" + pages.length, n: 0, label: "...", ell: true });
      if (pageCount <= 7) {
        for (let i = 1; i <= pageCount; i++) add(i);
      } else {
        add(1);
        if (cur > 3) ell();
        for (let i = Math.max(2, cur - 1); i <= Math.min(pageCount - 1, cur + 1); i++) add(i);
        if (cur < pageCount - 2) ell();
        add(pageCount);
      }
      return { total: total, from: from, to: to, pageCount: pageCount, cur: cur, pages: pages };
    },
    goPage(n) {
      if (n >= 1 && n <= this.totalPages) this.page = n;
    },

    /* 生成并打开 Allure HTML 报告(默认浏览器)。
       带报告号:打开那一次执行的历史报告(历史行「Allure」按钮);
       不带:打开最近一次。每次点击都会重新 generate。 */
    async openAllureReport(reportNo) {
      const api = window.pywebview && window.pywebview.api;
      if (!api || typeof api.open_allure_report !== "function") {
        window.alert("仅在桌面应用内可用(浏览器预览模式无文件系统)");
        return;
      }
      const r = await Promise.resolve(
        api.open_allure_report(reportNo ? String(reportNo) : ""));
      if (!r || !r.ok) { window.alert((r && r.error) || "打开失败"); return; }
      /* 局域网模式:服务端无法在本机弹浏览器,改成在当前浏览器新标签打开 */
      if (r.url) window.open(r.url, "_blank");
    },

    /* 打开 data/allure-results 目录(资源管理器) */
    async openAllureDir() {
      const api = window.pywebview && window.pywebview.api;
      if (!api || typeof api.open_allure_dir !== "function") {
        window.alert("仅在桌面应用内可用(浏览器预览模式无文件系统)");
        return;
      }
      const r = await Promise.resolve(api.open_allure_dir());
      if (!r || !r.ok) window.alert((r && r.error) || "打开失败");
    },

    /* 每次进入报告页都重读 data/reports(执行完套件切过来即是新数据) */
    async init() {
      let reports = [];
      try {
        const r = await window.PomeloStorage.listJson("reports");
        const items = (r && r.ok && Array.isArray(r.items)) ? r.items : [];
        reports = items
          .map((it) => it && it.content)
          .filter((c) => c && c.report && c.report.reportNo)
          .sort((a, b) => String(b.report.reportNo)
            .localeCompare(String(a.report.reportNo)));
      } catch (_) { reports = []; }

      /* 历史表:全部报告 */
      this.history = reports.map((c, idx) => {
        const rp = c.report;
        const total = Number(rp.total) || 0;
        const passed = Number(rp.passed) || 0;
        const failed = Number(rp.failed) || 0;
        const rate = _rate(passed, total);
        const isFail = failed > 0;
        return {
          id: idx + 1,
          reportNo: rp.reportNo,
          name: (rp.suite || "测试套件") + " #" + rp.reportNo,
          module: rp.suite || "-",
          state: isFail ? "fail" : "pass",
          stateLabel: isFail ? "失败" : "通过",
          stateIcon: isFail ? "fail" : "pass",
          dotCls: isFail ? "red" : "green",
          rateCls: rate >= 95 ? "rate--ok" : (rate >= 80 ? "rate--warn" : "rate--bad"),
          passRate: rate,
          duration: _fmtDur(rp.elapsedMs),
          executedAt: rp.finishedAt || rp.startedAt || "-",
        };
      });

      /* 数据重读后页码归位(新执行进来永远先看第一页最新报告) */
      this.page = 1;

      /* 统计卡/环形图/失败分析 = 最新报告 */
      const latest = reports[0];
      if (latest) {
        const rp = latest.report;
        const total = Number(rp.total) || 0;
        const passed = Number(rp.passed) || 0;
        const failed = Number(rp.failed) || 0;
        const skipped = Number(rp.skipped) || 0;
        this.summary = {
          total: total, passed: passed, failed: failed, skipped: skipped,
          duration: _fmtDur(rp.elapsedMs),
          passRate: _rate(passed, total),
          failRate: _rate(failed, total),
        };
        this._latestCases = Array.isArray(latest.cases) ? latest.cases : [];
        this.failures = this._latestCases
          .filter((c) => c && c.status === "failed")
          .map((c, i) => ({ id: i + 1, name: c.name || "-", reason: c.message || "-" }));
      } else {
        this.summary = { total: 0, passed: 0, failed: 0, skipped: 0,
                         duration: "00:00", passRate: 0, failRate: 0 };
        this._latestCases = [];
        this.failures = [];
      }

      this._scheduleRender();
    },

    /* 图表渲染守卫:页面用 v-show 切换,容器可能还是 0 尺寸,
       轮询等可见后再画(与 app.js paintRouteCharts 同套路,这里自带一份,
       保证 init 晚于路由切换到达时也能补画)。 */
    _scheduleRender() {
      let tries = 0;
      const timer = setInterval(() => {
        const el = document.getElementById("reportDonut");
        if (el && el.offsetWidth > 0) {
          clearInterval(timer);
          this.renderCharts();
          return;
        }
        if (++tries > 40) clearInterval(timer);
      }, 50);
    },

    renderCharts() {
      this.renderDonut();
      this.renderBars();
    },

    /* 执行结果分布(环形),数据 = 最新报告 */
    renderDonut() {
      const chart = getChart("reportDonut");
      if (!chart) return;
      const r = this.summary;
      chart.setOption({
        series: [{
          type: "pie", radius: ["70%", "90%"], avoidLabelOverlap: false,
          label: { show: false }, labelLine: { show: false },
          data: [
            { value: r.passed,  itemStyle: { color: "#10b981" } },
            { value: r.failed,  itemStyle: { color: "#ef4444" } },
            { value: r.skipped, itemStyle: { color: "#f59e0b" } },
          ],
        }],
        graphic: [
          { type: "text", left: "center", top: "40%",
            style: { text: `${r.passRate}%`, fill: "#10b981", fontSize: 32, fontWeight: "bold", textAlign: "center" } },
          { type: "text", left: "center", top: "58%",
            style: { text: "通过率", fill: "#94a3b8", fontSize: 12, textAlign: "center" } },
        ],
      });
      window.addEventListener("resize", () => chart.resize());
    },

    /* 执行耗时分布(柱状),桶 = 最新报告各用例真实耗时 */
    renderBars() {
      const chart = getChart("durationChart");
      if (!chart) return;
      const buckets = [0, 0, 0, 0, 0, 0];   // <100ms <500ms <1s <2s <5s >=5s
      (this._latestCases || []).forEach((c) => {
        const ms = Number(c && c.elapsedMs) || 0;
        if (ms < 100) buckets[0]++;
        else if (ms < 500) buckets[1]++;
        else if (ms < 1000) buckets[2]++;
        else if (ms < 2000) buckets[3]++;
        else if (ms < 5000) buckets[4]++;
        else buckets[5]++;
      });
      chart.setOption({
        grid: { left: 30, right: 18, top: 14, bottom: 30 },
        tooltip: { trigger: "axis" },
        xAxis: {
          type: "category", data: ["<100ms", "<500ms", "<1s", "<2s", "<5s", ">5s"],
          axisLine: { lineStyle: { color: "#e5e7eb" } },
          axisLabel: { color: "#94a3b8", fontSize: 11 },
        },
        yAxis: {
          type: "value", minInterval: 1,
          axisLine: { show: false }, axisTick: { show: false },
          splitLine: { lineStyle: { color: "#f1f5f9" } },
          axisLabel: { color: "#94a3b8" },
        },
        series: [{
          type: "bar", barWidth: 26,
          itemStyle: {
            color: (params) => ["#6366f1", "#818cf8", "#a78bfa", "#8b5cf6", "#c084fc", "#ef4444"][params.dataIndex],
            borderRadius: [6, 6, 0, 0],
          },
          data: buckets,
        }],
      });
      window.addEventListener("resize", () => chart.resize());
    },
  };
};
