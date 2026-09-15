/* ============================================================
 *  测试执行页面
 *  - 套件列表:只显示测试套件,读 data/suites/*.json(不再把用例当套件)
 *  - 执行环境:读 data/config/envs.json,可「+ 添加」持久化(可配置)
 *  - 并发数:固定 1(页面已隐藏该行),用例按套件顺序串行执行
 *  - 进度/日志:完全由 Python 执行引擎(pywebview 桥 run_suite)推送的
 *    事件驱动,不再有任何模拟定时器;socket 用例走 WebSocket 长连接
 *  注:本组件对象挂载在 root scope 下,petite-vue 不会自动调用其 mounted(),
 *     启动逻辑由 app.js 的 init() 在桥就绪后显式调用。
 * ========================================================== */
window.testrunComponent = function () {
  /* 默认执行环境(仅当 data/config/envs.json 不存在或为空时兜底) */
  const DEFAULT_ENVS = [
    { key: "test", label: "测试环境",   color: "#3b82f6", baseUrl: "" },
    { key: "pre",  label: "预发布环境", color: "#f59e0b", baseUrl: "" },
    { key: "prod", label: "生产环境",   color: "#ef4444", baseUrl: "" },
  ];
  const ENV_COLORS = ["#3b82f6", "#f59e0b", "#ef4444", "#10b981", "#8b5cf6", "#06b6d4", "#ec4899"];

  return {
    /* ---- 套件列表(读 data/suites) ---- */
    suites: [],
    suiteCount: 0,
    keyword: "",
    /* activeFile = 套件文件名(不含 .json),执行时传给 Python */
    activeFile: "",

    /* ---- 执行配置 ----
       concurrency 固定 1(页面隐藏;引擎按串行执行) */
    envs: DEFAULT_ENVS.slice(),
    env: "test",
    concurrency: 1,
    retries: [
      { value: 0, label: "不要试" },
      { value: 1, label: "重试 1 次" },
      { value: 2, label: "重试 2 次" },
      { value: 3, label: "重试 3 次" },
    ],
    timeouts: [
      { value: 30,  label: "30 秒" },
      { value: 60,  label: "60 秒" },
      { value: 120, label: "120 秒" },
    ],
    retry: 0,
    timeout: 60,

    /* ---- 运行态(由 Python 推送的事件驱动) ---- */
    running: false,
    statusText: "空闲",
    progress: {
      total: 0, done: 0, percent: 0,
      passed: 0, failed: 0, skipped: 0,
      duration: "00:00",
    },
    logLines: [],
    _durTimer: null,

    /* ===========================================================
     *  派生
     * ========================================================== */
    get filteredSuites() {
      const kw = String(this.keyword || "").trim().toLowerCase();
      if (!kw) return this.suites;
      return this.suites.filter((s) =>
        String(s.name).toLowerCase().indexOf(kw) > -1 ||
        String(s.module).toLowerCase().indexOf(kw) > -1);
    },

    get activeName() {
      const hit = this.suites.filter((s) => s.file === this.activeFile)[0];
      return hit ? hit.name : "未选择套件";
    },

    logText() {
      return this.logLines.join("\n");
    },

    /* ===========================================================
     *  初始化(由 app.js 在桥就绪后调用)
     * ========================================================== */
    async init() {
      await this.loadEnvs();
      try {
        const r = await window.PomeloStorage.listJson("suites", { recursive: true });
        const items = (r && r.ok && Array.isArray(r.items)) ? r.items : [];
        this.suites = items.map((it, idx) => {
          const s = window.PomeloUtils.toSuiteItem(it.content, idx + 1);
          /* 执行/选中都用真实文件名定位 */
          s.file = String(it.file_name || "").replace(/\.json$/i, "");
          return s;
        });
        this.suiteCount = this.suites.length;
        if (!this.activeFile && this.suites.length) this.activeFile = this.suites[0].file;
      } catch (_) {
        this.suites = [];
        this.suiteCount = 0;
      }
      console.log("[testrun] init 完成,套件 " + this.suiteCount + " 个");
    },

    /* ---- 执行环境:读 data/config/envs.json(与新建套件页同源) ---- */
    async loadEnvs() {
      try {
        const r = await window.PomeloStorage.listJson("config", { recursive: true });
        const hit = ((r && r.ok && r.items) || []).filter((it) =>
          String(it.file_name || "").toLowerCase() === "envs.json")[0];
        const envs = hit && hit.content && Array.isArray(hit.content.envs)
          ? hit.content.envs : null;
        if (envs && envs.length) {
          this.envs = envs.map((e, i) => ({
            key: String(e.key || e.label || ("env" + i)),
            label: String(e.label || e.key || ("环境" + i)),
            color: String(e.color || ENV_COLORS[i % ENV_COLORS.length]),
            baseUrl: String(e.baseUrl || ""),
          }));
        }
        if (!this.envs.some((e) => e.key === this.env)) this.env = this.envs[0].key;
      } catch (_) { /* 保持默认 */ }
    },

    /* ---- 新增执行环境(弹窗输入,立即持久化到 data/config/envs.json) ----
       baseUrl 后续也可以直接改 data/config/envs.json 文件 */
    async addEnv() {
      const name = String(window.prompt("环境名称(如:dev1)") || "").trim();
      if (!name) return;
      if (this.envs.some((e) => e.label === name || e.key === name)) return;
      const baseUrl = String(window.prompt(
        "环境 BaseURL(http:// 或 ws:// 前缀,可留空)\n留空可在 data/config/envs.json 里补填", ""
      ) || "").trim();
      this.envs = this.envs.concat([{
        key: name,
        label: name,
        color: ENV_COLORS[this.envs.length % ENV_COLORS.length],
        baseUrl: baseUrl,
      }]);
      this.env = name;
      try {
        await window.PomeloStorage.saveJson("config", "envs", { envs: this.envs });
        this.pushLog("[配置] 新增执行环境: " + name + (baseUrl ? " → " + baseUrl : ""));
      } catch (_) { /* 内存生效,落盘失败不影响本次使用 */ }
    },

    /* ---- 修改执行环境(✎ 标记,改名/BaseURL 后持久化) ----
       key 是内部标识保持不变,只更新 label/baseUrl,
       避免已保存套件里引用的 env 值失效 */
    async editEnv(key) {
      const hit = this.envs.filter((e) => e.key === key)[0];
      if (!hit) return;
      const name = String(window.prompt("环境名称", hit.label) || "").trim();
      if (!name) return;
      if (this.envs.some((e) => e.key !== key && e.label === name)) {
        window.alert("已存在同名环境「" + name + "」"); return;
      }
      const baseUrl = String(window.prompt(
        "环境 BaseURL(http:// 或 ws:// 前缀,可留空)", hit.baseUrl || ""
      ) || "").trim();
      this.envs = this.envs.map((e) => e.key === key
        ? { key: e.key, label: name, color: e.color, baseUrl: baseUrl }
        : e);
      try {
        await window.PomeloStorage.saveJson("config", "envs", { envs: this.envs });
        this.pushLog("[配置] 修改执行环境: " + name + (baseUrl ? " → " + baseUrl : "(未填 BaseURL)"));
      } catch (_) { /* 内存已生效,落盘失败不影响本次使用 */ }
    },

    /* ---- 删除执行环境(× 标记,确认后从 data/config/envs.json 移除) ----
       约束:执行中不可删;至少保留 1 个环境;删的是当前环境则回落到第一个 */
    async removeEnv(key) {
      if (this.running) { window.alert("执行中不能删除环境,请先停止执行"); return; }
      if (this.envs.length <= 1) { window.alert("至少保留一个执行环境"); return; }
      const hit = this.envs.filter((e) => e.key === key)[0];
      if (!hit) return;
      if (!window.confirm('删除执行环境「' + hit.label + '」?\n该操作会写入 data/config/envs.json,不可恢复')) return;
      this.envs = this.envs.filter((e) => e.key !== key);
      if (this.env === key) this.env = this.envs[0].key;
      try {
        await window.PomeloStorage.saveJson("config", "envs", { envs: this.envs });
        this.pushLog("[配置] 删除执行环境: " + hit.label);
      } catch (_) { /* 内存已生效,落盘失败不影响本次使用 */ }
    },

    /* ---- 删除测试套件(行内 × 标记,确认后删 data/suites/<file>.json) ----
       约束:执行中不可删;删的是当前选中套件则回落到第一个 */
    async removeSuite(file) {
      if (this.running) { window.alert("执行中不能删除套件,请先停止执行"); return; }
      const hit = this.suites.filter((s) => s.file === file)[0];
      if (!hit) return;
      if (!window.confirm('删除测试套件「' + hit.name + '」?\n将删除 data/suites/ 下的套件文件,不可恢复')) return;
      try {
        const api = window.pywebview && window.pywebview.api;
        if (api && typeof api.delete_json === "function") {
          const r = await api.delete_json("suites", file);
          if (!r || !r.ok) {
            window.alert("删除失败: " + ((r && r.error) || "未知错误"));
            return;
          }
        }
      } catch (_) { /* 桥异常时按内存态处理 */ }
      this.suites = this.suites.filter((s) => s.file !== file);
      this.suiteCount = this.suites.length;
      if (this.activeFile === file)
        this.activeFile = this.suites.length ? this.suites[0].file : "";
      this.pushLog("[配置] 删除测试套件: " + hit.name);
    },

    selectSuite(file) {
      if (this.running) return;   // 执行中不许切换
      this.activeFile = file;
    },

    /* ===========================================================
     *  执行控制:调 Python 引擎(run_suite 后台线程),过程事件
     *  由 onRunEvent 接收;不再有任何前端模拟
     * ========================================================== */
    async runSuite() {
      if (this.running || !this.activeFile) return;
      const api = window.pywebview && window.pywebview.api;
      if (!api || typeof api.run_suite !== "function") {
        this.pushLog("[错误] 执行引擎不可用(请在 pywebview 桌面端运行)");
        return;
      }
      this.running = true;
      this.statusText = "执行中";
      this.logLines = [];
      try {
        const r = await api.run_suite(this.activeFile, this.env, this.retry, this.timeout);
        if (!r || !r.ok) {
          this.running = false;
          this.statusText = "空闲";
          this.pushLog("[错误] " + ((r && r.error) || "启动执行失败"));
        }
      } catch (e) {
        this.running = false;
        this.statusText = "空闲";
        this.pushLog("[错误] " + (e && e.message ? e.message : e));
      }
    },

    async stopRun() {
      const api = window.pywebview && window.pywebview.api;
      if (api && typeof api.stop_run === "function") {
        try { await api.stop_run(); } catch (_) { /* 忽略 */ }
      }
    },

    /* ===========================================================
     *  Python 引擎事件入口(pomelo_app.py _push_event 调到这里)
     *  事件:type = start / log / case_start / case_result / done / error
     * ========================================================== */
    onRunEvent(ev) {
      if (!ev || !ev.type) return;
      const p = this.progress;

      if (ev.type === "start") {
        this.running = true;
        this.statusText = "执行中";
        p.total = Number(ev.total) || 0;
        p.done = 0; p.percent = 0;
        p.passed = 0; p.failed = 0; p.skipped = 0;
        p.duration = "00:00";
        this._startDur();

      } else if (ev.type === "log") {
        this.pushLog(ev.text);

      } else if (ev.type === "case_start") {
        /* 日志由 Python 的 log 事件推,这里只做状态占位 */

      } else if (ev.type === "case_result") {
        p.done += 1;
        if (ev.status === "passed")       p.passed += 1;
        else if (ev.status === "skipped") p.skipped += 1;
        else                              p.failed += 1;
        p.percent = p.total > 0
          ? Math.min(100, Math.round((p.done / p.total) * 1000) / 10)
          : 0;

      } else if (ev.type === "done") {
        this.running = false;
        this.statusText = ev.stopped ? "已停止" : "已完成";
        this._stopDur();
        if (ev.reportNo)
          this.pushLog("[报告] 已生成 #" + ev.reportNo + ",可在「测试报告」页查看");

      } else if (ev.type === "error") {
        this.running = false;
        this.statusText = "空闲";
        this.pushLog("[错误] " + (ev.message || ""));
      }
    },

    /* ---- 日志(数组方法 push 不被 petite-vue 0.4 跟踪,必须赋新数组) ---- */
    pushLog(line) {
      let arr = this.logLines.concat([String(line)]);
      if (arr.length > 500) arr = arr.slice(arr.length - 500);
      this.logLines = arr;
    },

    /* ---- 已耗时计时器(只在执行期间跑) ---- */
    _startDur() {
      this._stopDur();
      let secs = 0;
      this._durTimer = setInterval(() => {
        secs += 1;
        const m = String(Math.floor(secs / 60)).padStart(2, "0");
        const s = String(secs % 60).padStart(2, "0");
        this.progress.duration = m + ":" + s;
      }, 1000);
    },
    _stopDur() {
      if (this._durTimer) { clearInterval(this._durTimer); this._durTimer = null; }
    },
  };
};
