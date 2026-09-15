/* ============================================================
 *  Pomelo 主应用入口
 *  - PetiteVue 0.4.x (IIFE 全局:window.PetiteVue)
 *  - Hash 路由:#/dashboard, #/apicases, #/apicases/<id>, #/testrun, #/reports, #/report-detail
 *  - 各页面组件由 window.{name}Component 定义,数据由 PomeloMock 提供
 *
 *  ⚠ 重要(petite-vue 0.4.1 源码行为):
 *    1) createApp() 的 created() / mounted() 选项【不会被调用】。
 *       petite-vue 只支持 @vue:mounted / @vue:unmounted 事件钩子。
 *       → 子组件必须在 state 对象里直接实例化,挂载后的副作用写在 init() 里,
 *         由 <body @vue:mounted="init()"> 触发。
 *    2) v-cloak 在 walk 时由 _e(el,"v-cloak") 自动移除,无需手动处理。
 * ========================================================== */
(function () {
  const M = window.PomeloMock;

  /* PetiteVue IIFE 提供 createApp / nextTick / reactive 等 */
  if (!window.PetiteVue || typeof window.PetiteVue.createApp !== "function") {
    console.error("[Pomelo] petite-vue 未正确加载,请检查 vendor/petite-vue.iife.js");
    return;
  }
  if (!M) {
    console.error("[Pomelo] mock 数据未加载,请检查 js/mock.js 的引入顺序");
    return;
  }

  /* ---------------- Hash 路由解析 ----------------
   * 固定路由用小写比较;带参数前缀用原 hash 匹配(保留大小写),
   * 避免英文文件名被强转小写后读盘 404。 */
  function resolveRoute() {
    const h = window.location.hash || "";
    const hl = h.toLowerCase();
    if (h === "" || hl === "#/dashboard") return "dashboard";
    if (hl === "#/apicases")             return "apicases";
    if (hl === "#/apicases-new")         return "apicases-new";        // 新建用例
    if (hl === "#/testrun-new-suite")    return "testrun-new-suite";   // 新建套件
    if (hl === "#/testrun")              return "testrun";
    if (hl === "#/reports")              return "reports";
    if (hl.startsWith("#/apicases/"))     return "apicases-detail";
    if (hl.startsWith("#/apicase-view/")) return "apicases-detail";     // 查看(只读)
    if (hl.startsWith("#/testrun-suite-edit/")) return "testrun-new-suite"; // 编辑套件
    if (hl.startsWith("#/testrun-suite-view/")) return "testrun-new-suite"; // 查看套件(只读)
    if (hl.startsWith("#/report-detail")) return "report-detail";
    return "dashboard";
  }

  /* --------------------------------------------------------
   * 图表渲染守卫
   * 页面用 v-show 切换,隐藏时容器尺寸为 0,此时 echarts.init
   * 会得到 0×0 画布。故轮询等待容器获得有效尺寸后再渲染。
   * ------------------------------------------------------ */
  function paintRouteCharts(scope) {
    const specs = {
      dashboard: { probe: "trendChart",  comp: "dashboard" },
      reports:   { probe: "reportDonut", comp: "reports"   },
    };
    const spec = specs[scope.route];
    if (!spec) return;
    const comp = scope[spec.comp];
    if (!comp || typeof comp.renderCharts !== "function") return;

    let tries = 0;
    const timer = setInterval(() => {
      const el = document.getElementById(spec.probe);
      if (el && el.offsetWidth > 0) {
        clearInterval(timer);
        comp.renderCharts();
        return;
      }
      if (++tries > 40) clearInterval(timer);   // 最多等 2s,放弃
    }, 50);
  }

  /* ---------------- 复制到剪贴板(带兼容回退) ----------------
   * ⚠ 局域网地址形如 http://172.17.224.71:18080,不是"安全上下文",
   *   navigator.clipboard 在这种来源下【是 undefined】。所以主路径必须
   *   用 textarea + execCommand,clipboard API 只作为本地时的补充。
   */
  function copyText(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) return true;
    } catch (_) { /* 落到下面的 clipboard 分支 */ }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {});
      return true;
    }
    return false;
  }

  /* ---------------- 应用状态 ----------------
   * 注意:子组件在这里【直接实例化】。
   * 不能放进 created() —— petite-vue 不会调用它。
   */
  const state = {
    /* 顶层共享状态 */
    route: "dashboard",

    /* 各视图子组件实例 */
    dashboard:    window.dashboardComponent(M.dashboard),
    apicases:     window.apicasesComponent(M.apicases),
    apidetail:    window.apidetailComponent(M.apidetail),
    testrun:      window.testrunComponent(M.testrun),
    reports:      window.reportsComponent(M.reports),
    reportdetail: window.reportdetailComponent(M.reportdetail),
    newcase:      window.newcaseComponent(),   // 新建用例表单(无外部数据)
    newsuite:     window.newsuiteComponent(M.testrun),  // 新建套件表单(复用 testrun 的枚举)

    /* ---------------- 顶部「打开浏览器」地址条 ----------------
     * 桌面端点击 → 后端 webbrowser.open 用系统默认浏览器打开;
     * 局域网浏览器点击 → 新标签页打开(远程调用不会在服务器上弹窗口)。
     * display 只显示 IP:PORT,完整地址放在 title(悬浮提示)里,免得挤占头部。
     * 端口由后端按 18080 → 18081 顺序确定,所以地址必须问后端要,不能写死。
     */
    access: {
      ready: false,       // 非 HTTP 模式(如 --file)时保持 false → 整条隐藏
      url: "",            // 完整地址,点击/复制都用它
      display: "",        // 头部显示用:172.17.224.71:18080
      hint: "",           // 悬浮提示
      remote: false,      // 当前页面是否来自局域网浏览器
      copied: false,
      feedback: "",       // 操作后的短暂反馈(已复制/打开失败…)
      feedbackType: "",   // "" | "ok" | "error"

      async init() {
        const api = window.pywebview && window.pywebview.api;
        if (!api || typeof api.get_access_info !== "function") return;
        try {
          const r = await Promise.resolve(api.get_access_info());
          if (!r || r.ok !== true || !r.url) return;
          this.ready = true;
          this.url = r.url;
          this.display = r.display || r.url;
          this.remote = !!r.remote;
          this.hint = "点击用浏览器打开:" + r.url
                    + (this.remote ? "" : "(局域网地址,可发给同事)");
        } catch (_) { /* 拿不到就隐藏入口,不影响其它功能 */ }
      },

      async openBrowser() {
        if (!this.url) return;
        const api = window.pywebview && window.pywebview.api;
        if (!api || typeof api.open_in_browser !== "function") {
          window.open(this.url, "_blank");        // 无桥(纯浏览器预览)直接开标签页
          return;
        }
        try {
          const r = await Promise.resolve(api.open_in_browser(this.url));
          if (r && r.ok === false) {
            this.flash(r.error || "打开浏览器失败", "error");
            return;
          }
          if (r && r.remote) window.open(this.url, "_blank");
          else this.flash("已用默认浏览器打开", "ok");
        } catch (e) {
          this.flash("打开失败: " + ((e && e.message) || e), "error");
        }
      },

      copy() {
        if (!this.url) return;
        this.copied = copyText(this.url);
        this.flash(this.copied ? "已复制到剪贴板" : "复制失败,请手动选中",
                   this.copied ? "ok" : "error");
      },

      /* 短暂反馈后恢复显示地址(反馈文字不长期占位) */
      flash(text, type) {
        this.feedback = text;
        this.feedbackType = type || "";
        if (this._flashTimer) clearTimeout(this._flashTimer);
        this._flashTimer = setTimeout(() => {
          this.feedback = "";
          this.feedbackType = "";
          this.copied = false;
        }, 1800);
      },
    },

    /* ---------------- 方法 ---------------- */
    goTo(hash) {
      if ((window.location.hash || "") !== hash) window.location.hash = hash;
      else this.onHashChange();
    },

    /* 顶部导航:阻止默认跳转,统一走 goTo(保证 hash 未变时也能刷新视图) */
    navigateTo(e) {
      const link = e.target && e.target.closest ? e.target.closest("a[data-route]") : null;
      if (!link) return;
      e.preventDefault();
      this.goTo(link.getAttribute("href"));
    },

    onHashChange() {
      const next = resolveRoute();
      /* 详情页路由带参数(#/apicases/<file>):route 名不变(同为
         apicases-detail)也要重新加载,否则 A→列表→B 会显示 A 的旧数据 */
      /* 仪表盘:每次进入都重读(执行记录/通过率/趋势来自 data/reports,
         跑完套件切回来即是最新) */
      if (next === "dashboard" && this.dashboard && this.dashboard.init)
        this.dashboard.init();
      /* 用例列表:每次进入都重读 data/cases —— 编辑/新建/删除用例后
         切回来看到的总是最新落盘数据(与 reports/testrun 同套路) */
      if (next === "apicases" && this.apicases && this.apicases.init)
        this.apicases.init();
      if (next === "apicases-detail" && this.apidetail && this.apidetail.load)
        this.apidetail.load();
      /* 测试执行/新建套件:每次进入都重读 data,让编辑过的用例、
         套件、环境实时同步(引擎执行时本身按文件回查最新用例) */
      if (next === "testrun" && this.testrun && this.testrun.init &&
          !this.testrun.running)
        this.testrun.init();
      if (next === "testrun-new-suite" && this.newsuite && this.newsuite.init)
        this.newsuite.init();
      /* 报告页/详情页:每次进入都重读 data/reports,
         执行完套件切过来即是最新结果(无论路由是否变化) */
      if (next === "reports" && this.reports && this.reports.init)
        this.reports.init();
      if (next === "report-detail" && this.reportdetail && this.reportdetail.load)
        this.reportdetail.load();
      if (next === this.route) return;
      this.route = next;
      window.PetiteVue.nextTick(() => paintRouteCharts(this));
    },

    /* ---------------- 挂载完成钩子 ----------------
     * 由 <body @vue:mounted="init()"> 调用。
     * 方法内的 this 是响应式 proxy( petite-vue 的 tt() 已 bind ),
     * 因此 this.route = xxx 能正常触发视图更新。
     */
    init() {
      /* ⚠ 关键:window.PomeloApp 必须是【响应式 proxy】,不能是原始 state。
       *
       * petite-vue 内部是 createApp(state) → reactive(proxyRefs(state)),
       * 那个 proxy 并不对外暴露。如果这里挂原始对象,那么 newcase.save()
       * 里 "PomeloApp.apicases.list = ..." 就是直接改 raw target,
       * 不会经过 proxy 的 set 陷阱 → trigger 不触发 → v-for 不重渲。
       * 表现为"数据变了(12 条)但表格还是旧的(10 行)"。
       *
       * 而 init() 由 <body @vue:mounted="init()"> 调用,petite-vue 在
       * apply() 里用 scope 作为 this,所以这里的 this 就是根 scope proxy。
       */
      window.PomeloApp = this;

      /* 初始路由 */
      this.route = resolveRoute();
      /* 直接以详情路由进入(刷新/收藏)时也要加载用例 */
      if (this.route === "apicases-detail" && this.apidetail && this.apidetail.load)
        this.apidetail.load();
      /* 直接以报告详情路由进入时加载对应报告 */
      if (this.route === "report-detail" && this.reportdetail && this.reportdetail.load)
        this.reportdetail.load();

      /* hash 变化监听 */
      window.addEventListener("hashchange", () => this.onHashChange());

      /* 渲染当前路由图表 */
      window.PetiteVue.nextTick(() => paintRouteCharts(this));

      /* (2026-09 02 移除) testrun 的伪日志/伪进度模拟定时器已删 —— 
         进度与日志现在完全由 Python 执行引擎(run_suite)推送的事件驱动,
         前端不再模拟。 */

      /* ------------------------------------------------------------
       * ⚠ 数据初始化必须等 pywebview 桥就绪(2026-09 修):
       * pywebview 在页面加载完成后才异步注入 window.pywebview.api,
       * 并派发 "pywebviewready" 事件;而 @vue:mounted 触发 init() 时
       * 桥通常还不存在 —— 直接调各子组件 init() 会全部读盘失败,
       * 静默回退到写死数据(仪表盘「测试项目」显示假模块的根因之一)。
       * 桥已就绪 → 立即启动;否则等 pywebviewready 事件,
       * 浏览器预览模式(无桥)3s 兜底放行,storage/modules 自会走降级。
       * ---------------------------------------------------------- */
      const startDataInit = () => {
        if (this.apicases  && typeof this.apicases.init  === "function") this.apicases.init();
        if (this.dashboard && typeof this.dashboard.init === "function") this.dashboard.init();
        if (this.newcase   && typeof this.newcase.init   === "function") this.newcase.init();
        if (this.newsuite  && typeof this.newsuite.init  === "function") this.newsuite.init();
        if (this.testrun   && typeof this.testrun.init   === "function") this.testrun.init();
        if (this.reports   && typeof this.reports.init   === "function") this.reports.init();
        /* 顶部访问地址条:端口可能是 18080 或 18081,必须问后端 */
        if (this.access    && typeof this.access.init    === "function") this.access.init();
      };
      const bridgeApi = window.pywebview && window.pywebview.api;
      if (bridgeApi) {
        startDataInit();
      } else {
        let dataStarted = false;
        const startOnce = () => {
          if (dataStarted) return;
          dataStarted = true;
          console.log("[Pomelo] pywebview bridge ready,启动数据加载");
          startDataInit();
        };
        window.addEventListener("pywebviewready", startOnce);
        window.setTimeout(startOnce, 3000);
      }

      console.log("[Pomelo] 初始化完成,当前路由:", this.route);
    },
  };

  /* PetiteVue 0.4:mount() 不传参,扫描整个文档 */
  window.PetiteVue.createApp(state).mount();

  /* 全局暴露,便于控制台调试。
     正常情况下 init() 已经把它换成响应式 proxy 了;这里只是兜底,
     防止 <body> 上没挂 @vue:mounted 时 window.PomeloApp 为 undefined。 */
  if (!window.PomeloApp) window.PomeloApp = state;
})();
