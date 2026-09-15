/* ============================================================
 *  用例执行详情 — 读真实报告 data/reports/<reportNo>.json
 *  - 路由 #/report-detail/<reportNo>,每次进入 load() 重读
 *  - 抽屉内容是 getter 派生,点击用例行即联动
 * ========================================================== */
window.reportdetailComponent = function () {
  const _fmtDur = (ms) => {
    const s = Math.round((Number(ms) || 0) / 1000);
    const m = Math.floor(s / 60);
    return (m < 10 ? "0" : "") + m + ":" + ((s % 60) < 10 ? "0" : "") + (s % 60);
  };

  return {
    reportNo: "",
    suite: "",
    envLabel: "",
    executedAt: "",
    stats: { total: 0, passed: 0, failed: 0, skipped: 0, duration: "00:00" },
    filters: [
      { key: "all",   label: "全量状态" },
      { key: "pass",  label: "通过" },
      { key: "fail",  label: "失败" },
      { key: "skip",  label: "跳过" },
    ],
    activeFilter: "all",
    cases: [],
    activeCase: null,
    caseOpen: false,

    /* 整体结果:有失败即"失败",否则"通过" */
    get failedCount() { return Number(this.stats.failed) || 0; },
    get overallLabel() { return this.failedCount > 0 ? "失败" : "通过"; },

    /* 每次进入详情路由都重读(从历史表点不同行要看到各自的数据) */
    async load() {
      const h = window.location.hash || "";
      const m = h.match(/^#\/report-detail\/(.*)$/i);
      let no = "";
      if (m) { try { no = decodeURIComponent(m[1]); } catch (_) { no = m[1]; } }
      no = String(no).trim();

      this.activeFilter = "all";
      this.activeCase = null;
      this.caseOpen = false;
      this.cases = [];
      this.reportNo = no;
      this.suite = "";
      this.envLabel = "";
      this.executedAt = "";
      this.stats = { total: 0, passed: 0, failed: 0, skipped: 0, duration: "00:00" };
      if (!no) return;

      try {
        const r = await window.PomeloStorage.listJson("reports");
        const hit = ((r && r.ok && Array.isArray(r.items)) ? r.items : [])
          .filter((it) => String(it.file_name || "").replace(/\.json$/i, "") === no)[0];
        if (!hit || !hit.content || !hit.content.report) {
          this.suite = "(报告不存在或已被删除)";
          return;
        }
        const rp = hit.content.report;
        this.suite = rp.suite || "测试套件";
        this.envLabel = rp.env || "-";
        this.executedAt = rp.finishedAt || rp.startedAt || "-";
        const total = Number(rp.total) || 0;
        const passed = Number(rp.passed) || 0;
        const failed = Number(rp.failed) || 0;
        const skipped = Number(rp.skipped) || 0;
        this.stats = { total: total, passed: passed, failed: failed,
                       skipped: skipped, duration: _fmtDur(rp.elapsedMs) };
        this.cases = (Array.isArray(hit.content.cases) ? hit.content.cases : [])
          .map((c, i) => {
            const status = String((c && c.status) || "failed");
            const state = status === "passed" ? "pass"
                        : status === "skipped" ? "skip" : "fail";
            return {
              id: i + 1,
              index: Number(c && c.index) || i + 1,
              name: (c && c.name) || "-",
              state: state,
              stateLabel: state === "pass" ? "通过" : state === "skip" ? "跳过" : "失败",
              dotCls: state === "pass" ? "green" : state === "skip" ? "orange" : "red",
              duration: state === "skip" ? "-" : ((Number(c && c.elapsedMs) || 0) + "ms"),
              path: (String((c && c.protocol) || "").toUpperCase() || "?") + " " + ((c && c.path) || "-"),
              reason: (c && c.message) || "-",
              rawPath: (c && c.path) || "-",
              protocol: (c && c.protocol) || "",
              elapsedMs: Number(c && c.elapsedMs) || 0,
              message: (c && c.message) || "",
            };
          });
      } catch (_) { /* 读盘失败保持空态 */ }
    },

    openCase(id) {
      this.activeCase = id;
      this.caseOpen = true;
    },
    closeCase() { this.caseOpen = false; },

    get filteredCases() {
      const f = this.activeFilter;
      if (!f || f === "all") return this.cases;
      return this.cases.filter((c) => c.state === f);
    },

    /* 抽屉当前用例:getter 派生,点击行即联动 */
    get current() {
      const hit = this.cases.filter((c) => c.id === this.activeCase)[0];
      return hit || {};
    },
    /* 真实报告未抓取请求头,返回空数组(模板按空态隐藏) */
    get currentHeaders() { return []; },
  };
};
