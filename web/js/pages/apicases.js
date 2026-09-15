/* ============================================================
 *  接口用例列表
 *  - 项目分类 Tab + 关键词筛选 + 表格/卡片视图切换 + 分页
 *
 *  注:petite-vue 没有 computed,派生数据用 getter 实现。
 *      getter 里的 this 是响应式 proxy(通过 proxy 访问时 Reflect.get 会传
 *      receiver),因此内部访问 list/keyword/activeTab 能正常建立依赖,
 *      任一变化都会让用到 filteredList 的 v-for 重新渲染。
 *  注:列表数据只来自 data/cases/*.json,展示字段(hasTags/methodCls/
 *      stateLabel/updated 等)由 PomeloUtils.toListItem 统一预映射。
 * ========================================================== */

window.apicasesComponent = function (mockData) {
  /* ⚠ mockData 参数仅保留签名兼容(app.js 仍传 M.apicases),不读取 mockData。
     用例列表只来自 data/cases/*.json(init() 填充),不再保留任何写死用例。 */
  return {
    /* 运行时派生字段(不要在 mockData 里找;由 init() 填) */
    modules: [],          // [{name, key, icon, color, cases?, status?}]
    activeTab: "all",
    keyword: "",
    view: "table",
    list: [],

    /* ---- 工具栏筛选下拉(请求方法 / 标签) ----
       menuOpen      当前展开的筛选菜单(""=关闭 / "method" / "tag")
       filterMethod  选中的请求方法(""=全部)
       filterTag     选中的标签(""=全部) */
    menuOpen: "",
    filterMethod: "",
    filterTag: "",

    /* ---- 弹窗:新建模块(与 dashboard 同名字段,两处互不干扰) ---- */
    showNewModule: false,
    newModuleName: "",
    newModuleErr: "",

    /* ---- 行级「三个点」菜单 ----
       menuFor       当前展开菜单的用例 id(0=全部关闭)
       confirmDelId  处于「确认删除」二次确认态的用例 id(0=无)
       rowBusy       行级复制/删除进行中,防重复点击 */
    menuFor: 0,
    confirmDelId: 0,
    rowBusy: false,

    /* ---- 弹窗:删除模块(两段式 — 先 dry_run 出清单,再二次确认) ----
       delModuleName  待删模块名
       delModuleKey   待删模块 key(= data/cases/{key}/ 目录名)
       delModuleFiles 该目录下将被删除的文件名清单(dry_run 返回)
       delModuleCount 文件条数
       delModuleDir   目录路径(纯展示,内存降级时形如 "(memory) cases/user")
       delModuleErr   错误提示
       delBusy        真删进行中,防重复点击 */
    showDelModule: false,
    delModuleName: "",
    delModuleKey: "",
    delModuleFiles: [],
    delModuleCount: 0,
    delModuleDir: "",
    delModuleErr: "",
    delBusy: false,

    /* ---- 弹窗:修改模块(改名保留 key,级联更新用例/套件里的项目名) ---- */
    showRenameModule: false,
    renameModuleOld: "",     // 原模块名(打开弹窗时锁定)
    renameModuleName: "",    // 输入框(预填原名)
    renameModuleErr: "",
    renameBusy: false,

    /* ============================================================
     * 派生:tabs
     *  - 顶部 tab 永远以 "all" 打头,然后跟每个模块一项
     *  - 名字重复就去重(防止重名模块出两个 tab)
     * ========================================================== */
    get tabs() {
      const seen = { all: true };
      const arr = [{ key: "all", label: "全部用例" }];
      (this.modules || []).forEach((m) => {
        if (seen[m.key]) return;
        seen[m.key] = true;
        arr.push({ key: m.key, label: m.name });
      });
      return arr;
    },

    /* 派生:tab key → 项目名(供 filteredList 按 module 过滤) */
    get _tabProject() {
      const map = { all: null };
      (this.modules || []).forEach((m) => { map[m.key] = m.name; });
      return map;
    },

    /* 过滤后的列表:关键词(名称/路径/项目) + 分类 Tab + 方法/标签筛选 */
    get filteredList() {
      const kw = String(this.keyword || "").trim().toLowerCase();
      const proj = this._tabProject[this.activeTab];

      return this.list.filter((c) => {
        if (proj && c.project !== proj) return false;
        if (this.filterMethod && String(c.method || "") !== this.filterMethod) return false;
        if (this.filterTag
            && !(c.tags || []).some((t) => t && t.text === this.filterTag)) return false;
        if (!kw) return true;
        return String(c.name).toLowerCase().indexOf(kw) > -1
            || String(c.path).toLowerCase().indexOf(kw) > -1
            || String(c.project).toLowerCase().indexOf(kw) > -1;
      });
    },

    /* ---- 筛选下拉:选项从列表真实数据里取,不写死 ---- */
    get methodOptions() {
      const seen = {};
      const arr = [];
      (this.list || []).forEach((c) => {
        const m = String(c.method || "").trim();
        if (m && !seen[m]) { seen[m] = true; arr.push(m); }
      });
      return arr;
    },
    get tagOptions() {
      const seen = {};
      const arr = [];
      (this.list || []).forEach((c) =>
        (c.tags || []).forEach((t) => {
          if (t && t.text && !seen[t.text]) { seen[t.text] = true; arr.push(t.text); }
        }));
      return arr;
    },
    /* 按钮文案预映射(模板不写三元,坑 5) */
    get methodBtnLabel() {
      return this.filterMethod ? ("请求方法:" + this.filterMethod) : "请求方法";
    },
    get tagBtnLabel() {
      return this.filterTag ? ("标签:" + this.filterTag) : "标签";
    },

    toggleFilterMenu(kind) {
      this.menuOpen = this.menuOpen === kind ? "" : kind;
    },
    pickMethod(m) {
      this.filterMethod = m || "";
      this.menuOpen = "";
      this.page = 1;
    },
    pickTag(t) {
      this.filterTag = t || "";
      this.menuOpen = "";
      this.page = 1;
    },

    /* 过滤后的条数(供分页/统计展示) */
    get total() {
      return this.filteredList.length;
    },

    /* ============================================================
     * 分页(每页 10 条,前端分页)
     *  - page 从 1 起;过滤条件变化时由调用方重置为 1
     *  - 删除/复制导致列表变短时,safePage 自动收敛,不会切到空页
     * ========================================================== */
    page: 1,
    pageSize: 10,
    get totalPages() {
      return Math.max(1, Math.ceil(this.total / this.pageSize));
    },
    get safePage() {
      return Math.min(this.page, this.totalPages);
    },
    get pagedList() {
      const p = this.safePage;
      return this.filteredList.slice((p - 1) * this.pageSize, p * this.pageSize);
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
      const p = Math.min(Math.max(1, Number(n) || 1), this.totalPages);
      this.page = p;
    },

    /* ============================================================
     * 初始化(由 app.init() 显式触发 — petite-vue 不会自动调生命周期)
     *  - 拉模块列表(PomeloModules 内部自管兜底,这里不再二次回退)
     *  - 拉 data/cases/*.json 已保存用例,列表整体来自磁盘,不合并 mock
     * ========================================================== */
    async init() {
      // 1) 加载模块
      try {
        const mods = await window.PomeloModules.list();
        this.modules = Array.isArray(mods) ? mods.slice() : [];
      } catch (_) {
        this.modules = [];
      }
      /* 模块加载完,推送给新建用例/新建套件的项目下拉(它们自己读不到时机) */
      this._syncProjectsToForms();

      // 2) 加载已保存用例 —— 只读 data/,列表初始为空,读不到就显示空态
      try {
        /* recursive:true — 用例已按模块归档到 data/cases/{module_key}/,
           不下探一层子目录就只能读到历史平铺的那几个文件 */
        const r = await window.PomeloStorage.listJson("cases", { recursive: true });
        if (r && r.ok && Array.isArray(r.items)) {
          this.list = r.items.map((it, idx) => {
            const item = window.PomeloUtils.toListItem(it.content, idx + 1);
            /* 行级菜单(复制/删除)需要:真实文件名、归档子目录名(=模块 key)、
               原始 payload(复制时深拷贝用) */
            item.file = String(it.file_name || "").replace(/\.json$/i, "");
            item.module = it.module || "";
            item.payload = it.content;
            return item;
          });
        }
      } catch (_) { /* 静默:首屏不阻塞 */ }

      /* 全局 click 关闭行级菜单(只绑一次;箭头函数捕获的 this 是组件 proxy,
         写 menuFor 走 set 陷阱,能正常触发视图更新) */
      if (!this._menuBound) {
        this._menuBound = true;
        document.addEventListener("click", () => {
          if (this.menuFor || this.confirmDelId || this.menuOpen) this.closeMenu();
        });
      }

      console.log("[apicases] init 完成,模块 " + this.modules.length
                  + " 个,用例 " + this.list.length + " 条");
    },

    /* ============================================================
     * 把模块名同步到 newcase / newsuite 的项目下拉。
     * ⚠ 必须由这里主动推送,不能让表单用 getter 读 PomeloApp.apicases.modules —
     *   表单 getter 首次求值发生在挂载时,PomeloApp 尚未赋值,拉不到任何
     *   响应式依赖,之后模块加载完也永远不会更新 → 下拉框恒空(已踩坑)。
     * ========================================================== */
    _syncProjectsToForms() {
      const app = window.PomeloApp;
      if (!app) return;
      if (app.newcase  && typeof app.newcase.syncProjects  === "function")
        app.newcase.syncProjects(this.modules);
      if (app.newsuite && typeof app.newsuite.syncProjects === "function")
        app.newsuite.syncProjects(this.modules);
      /* 编辑/查看用例页也推送:直接停在详情页初始化时,load() 跑在模块
         加载完之前,projectOptions 拿到的是空数组,靠这里补填 */
      if (app.apidetail && typeof app.apidetail.syncProjects === "function")
        app.apidetail.syncProjects(this.modules);
    },

    /* ============================================================
     * 动态新建模块(由仪表盘的"+ 新建" 或 newcase save 触发)
     * - 仅在 modules 里没有同名模块时调用 PomeloModules.add
     * - 成功 → modules 刷新,tabs getter 自动更新
     * ========================================================== */
    async addModule(name) {
      const clean = String(name || "").trim();
      if (!clean) return { ok: false, error: "模块名不能为空" };
      if (this.modules.some((m) => m.name === clean))
        return { ok: true, modules: this.modules };   // 已是已知模块,no-op

      const r = await window.PomeloModules.add(clean);
      if (r && r.ok) {
        /* .slice() — 赋新数组,别把 modules.js 内部那份引用直接挂上来 */
        this.modules = (r.modules || []).slice();
        this._syncProjectsToForms();
        return { ok: true, modules: this.modules, backend: r.backend };
      }
      return { ok: false, error: (r && r.error) || "新建模块失败" };
    },

    /* ============================================================
     * 新建模块弹窗(Tab 条右侧入口)
     *  - DOM 复用 index.html 那套 modal;字段名与 dashboard 相同,但两个
     *    组件各是独立 proxy,模板前缀不同(apicases. / dashboard.),互不干扰
     * ========================================================== */
    openNewModule() {
      this.newModuleName = "";
      this.newModuleErr = "";
      this.showNewModule = true;
      /* ⚠ $nextTick 只挂在【根 scope】上,子组件的 proxy 拿不到,
         必须用全局的 PetiteVue.nextTick。 */
      window.PetiteVue.nextTick(() => {
        /* ⚠ id 必须是 apicases 专属的那个:仪表盘弹窗里也有一个同结构 input
           (index.html 176 行那份),两者 id 撞名会导致聚焦错元素。 */
        const el = document.getElementById("apicasesNewModuleName");
        if (el) el.focus();
      });
    },

    closeNewModule() {
      this.showNewModule = false;
      this.newModuleName = "";
      this.newModuleErr = "";
    },

    /* ============================================================
     * 修改模块(改名)弹窗
     *  - rename 只改显示名,key/目录不动
     *  - 级联:data/cases 下 case.project、data/suites 下 suite.project
     *    引用旧项目名的用例/套件,全部改写为新名
     * ========================================================== */
    openRenameModule(name) {
      const clean = String(name || "").trim();
      if (!clean) return;
      this.renameModuleOld = clean;
      this.renameModuleName = clean;
      this.renameModuleErr = "";
      this.showRenameModule = true;
      window.PetiteVue.nextTick(() => {
        const el = document.getElementById("apicasesRenameModuleName");
        if (el) { el.focus(); el.select && el.select(); }
      });
    },

    closeRenameModule() {
      this.showRenameModule = false;
      this.renameModuleOld = "";
      this.renameModuleName = "";
      this.renameModuleErr = "";
      this.renameBusy = false;
    },

    async confirmRenameModule() {
      const oldName = this.renameModuleOld;
      const newName = String(this.renameModuleName || "").trim();
      if (!oldName) { this.renameModuleErr = "缺少原模块名"; return; }
      if (!newName) { this.renameModuleErr = "请输入模块名称"; return; }
      if (newName.length > 32) { this.renameModuleErr = "模块名不要超过 32 字符"; return; }
      if (newName === oldName) { this.closeRenameModule(); return; }

      this.renameBusy = true;
      this.renameModuleErr = "";

      /* 1) 改模块列表(同名拦截在 rename 内部) */
      const r = await window.PomeloModules.rename(oldName, newName);
      if (!r || !r.ok) {
        this.renameModuleErr = (r && r.error) || "改名失败";
        this.renameBusy = false;
        return;
      }

      /* 2) 级联改用例:data/cases/** 里 case.project === 旧名 的文件 */
      let caseHits = 0, suiteHits = 0;
      try {
        const lr = await window.PomeloStorage.listJson("cases", { recursive: true });
        for (const it of ((lr && lr.ok && lr.items) || [])) {
          const c = it.content || {};
          if (c.case && String(c.case.project || "") === oldName) {
            c.case.project = newName;
            const f = String(it.file_name || "").replace(/\.json$/i, "");
            const sv = await window.PomeloStorage.saveJson("cases", f, c, it.module);
            if (sv && sv.ok) {
              caseHits++;
              /* 内存列表同步改,免去整表重读 */
              this.list.forEach((row) => {
                if (row.file === f && row.project === oldName) {
                  row.project = newName;
                  if (row.payload && row.payload.case) row.payload.case.project = newName;
                }
              });
            }
          }
        }
      } catch (_) { /* 用例级联失败不阻断,下面汇总提示 */ }

      /* 3) 级联改套件:data/suites/*.json 里 suite.project === 旧名 */
      try {
        const ls = await window.PomeloStorage.listJson("suites");
        for (const it of ((ls && ls.ok && ls.items) || [])) {
          const ct = it.content || {};
          if (ct.suite && String(ct.suite.project || "") === oldName) {
            ct.suite.project = newName;
            const f = String(it.file_name || "").replace(/\.json$/i, "");
            const sv = await window.PomeloStorage.saveJson("suites", f, ct);
            if (sv && sv.ok) suiteHits++;
          }
        }
      } catch (_) { /* 同上 */ }

      /* 4) 刷新本组件与仪表盘的模块列表 + 表单下拉 */
      this.modules = (r.modules || []).slice();
      this._syncProjectsToForms();
      try {
        const app = window.PomeloApp;
        const dash = app && app.dashboard;
        if (dash && Array.isArray(dash.modules))
          dash.modules = dash.modules.map((m) =>
            m && m.name === oldName ? Object.assign({}, m, { name: newName }) : m);
      } catch (_) { /* 仪表盘不在场就跳过 */ }

      this.closeRenameModule();
      console.log("[apicases] 模块改名: " + oldName + " → " + newName +
                  ",级联用例 " + caseHits + " 个,套件 " + suiteHits + " 个");
    },

    /* 复用本组件的 addModule — 它已含"同名 no-op"判断与 .slice() 赋值。
       dashboard 那边直调 PomeloModules.add 是因为它还要 map 出 projects。 */
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
      const r = await this.addModule(name);
      if (!r || !r.ok) {
        this.newModuleErr = (r && r.error) || "新建失败";
        return;
      }
      this.closeNewModule();
    },
    /* ============================================================
     * 行级「三个点」菜单(操作列)
     *  - 复制:深拷贝原 payload → 名称加 -copy 后缀去重 → 落盘 + 列表追加
     *  - 删除:两段确认 — 第一次点只进「确认删除」态,再点才真删
     *  - 菜单由 document 全局 click 关闭(init 里绑一次)
     * ========================================================== */
    toggleMenu(id) {
      if (this.menuFor === id) { this.menuFor = 0; return; }
      this.menuFor = id;
      this.confirmDelId = 0;
    },
    closeMenu() {
      this.menuFor = 0;
      this.confirmDelId = 0;
      this.menuOpen = "";   // 工具栏筛选下拉也一并收起
    },
    /* 查看/编辑用例 → 详情页。路由带目录:#/apicases/<模块key>/<file> ——
       不同目录下允许同名用例,只传文件名会命中第一份(打开错的那份)。
       早期写死 goTo('#/apicases/get-user'),详情页因此永远是同一份 mock 数据 */
    viewCase(id) {
      const src = this.list.filter((c) => c.id === id)[0];
      if (!src) return;
      this.closeMenu();
      const file = src.file || src.name;
      if (!file) return;
      const app = window.PomeloApp;
      if (app && app.goTo) app.goTo("#/apicases/" + encodeURIComponent(src.module || "")
        + "/" + encodeURIComponent(file));
    },
    /* 三点菜单「查看」→ 只读详情页(#/apicase-view/<模块key>/<file>),页面不可修改 */
    viewCaseOnly(id) {
      const src = this.list.filter((c) => c.id === id)[0];
      if (!src) return;
      this.closeMenu();
      const file = src.file || src.name;
      if (!file) return;
      const app = window.PomeloApp;
      if (app && app.goTo) app.goTo("#/apicase-view/" + encodeURIComponent(src.module || "")
        + "/" + encodeURIComponent(file));
    },
    async copyCase(id) {
      if (this.rowBusy) return;
      const src = this.list.filter((c) => c.id === id)[0];
      if (!src) return;
      this.rowBusy = true;
      try {
        /* 原 payload:读盘时已挂在列表项上;新建后未刷新的项没有,
           就按文件名从磁盘找一遍 */
        let payload = src.payload;
        if (!payload) {
          const r = await window.PomeloStorage.listJson("cases", { recursive: true });
          const hit = (r && r.ok ? r.items : []).filter((it) =>
            (it.file_name || "") === (src.file || "") + ".json")[0];
          payload = hit && hit.content;
        }
        if (!payload || !payload.case) {
          console.warn("[apicases] 复制失败:找不到原始用例数据");
          return;
        }

        /* 名称去重:test001 → test001-copy / test001-copy2 ... */
        const base = String(payload.case.name || "case") + "-copy";
        let newName = base, n = 2;
        while (this.list.some((c) => c.name === newName)) newName = base + (n++);

        const clone = JSON.parse(JSON.stringify(payload));
        clone.case.name = newName;
        if (!clone.createdAt) clone.createdAt = new Date().toISOString();

        /* 模块 key 反查(查不到传 "",storage 落 category 根目录) */
        const proj = String(clone.case.project || "").trim();
        const hit = (this.modules || []).filter((m) => m.name === proj)[0];
        const modKey = hit ? hit.key : "";

        const saved = await window.PomeloStorage.saveJson(
          "cases", newName, clone, modKey);
        if (!saved || !saved.ok) {
          console.warn("[apicases] 复制保存失败:" +
                       ((saved && saved.error) || ""));
          return;
        }

        const maxId = this.list.reduce(
          (m, c) => Math.max(m, Number(c.id) || 0), 0);
        const item = window.PomeloUtils.toListItem(clone, maxId + 1);
        item.file = newName;
        item.module = modKey;
        item.payload = clone;
        this.list = this.list.concat([item]);   // 赋新数组,确保 v-for 重跑
        this.closeMenu();
      } finally {
        this.rowBusy = false;
      }
    },
    askRemoveCase(id) {
      /* 两段确认:第一次点「删除」只进确认态(按钮变「确认删除」),
         再点同一个才真删;点别处/换菜单即复位 */
      if (this.confirmDelId === id) { this.removeCase(id); return; }
      this.confirmDelId = id;
    },
    async removeCase(id) {
      if (this.rowBusy) return;
      const src = this.list.filter((c) => c.id === id)[0];
      if (!src) return;
      this.rowBusy = true;
      try {
        /* 优先用读盘时记下的真实子目录(src.module),没有再按项目名反查;
           都没有传 "" — deleteJson 会先找模块目录、再回落 category 根目录 */
        const proj = String(src.project || "").trim();
        const hit = (this.modules || []).filter((m) => m.name === proj)[0];
        const modKey = src.module || (hit ? hit.key : "");
        const r = await window.PomeloStorage.deleteJson(
          "cases", src.file, modKey);
        if (!r || !r.ok) {
          console.warn("[apicases] 删除失败:" + ((r && r.error) || ""));
          return;
        }
        this.list = this.list.filter((c) => c.id !== id);
        this.closeMenu();
      } finally {
        this.rowBusy = false;
      }
    },

    /* ============================================================
     * 删除模块弹窗(两段式)
     *  第一段 openDelModule  → remove(name, {withCases:true}) 默认 dryRun,
     *                          磁盘与 modules.json 都不动,只取文件清单
     *  第二段 confirmDelModule → dryRun:false 才真删
     * ========================================================== */
    async openDelModule(name) {
      const clean = String(name || "").trim();
      if (!clean) return;

      /* 先把弹窗摆出来(桥调用可能有几十 ms 延迟),清单随后填 */
      this.delModuleName = clean;
      this.delModuleKey = "";
      this.delModuleFiles = [];
      this.delModuleCount = 0;
      this.delModuleDir = "";
      this.delModuleErr = "";
      this.delBusy = false;
      this.showDelModule = true;

      const r = await window.PomeloModules.remove(clean, { withCases: true });
      if (!r || !r.ok) {
        let msg = (r && r.error) || "预览失败";
        if (r && r.sub_dirs && r.sub_dirs.length)
          msg += "(目录下存在子目录,已中止:" + r.sub_dirs.join("、") + ")";
        this.delModuleErr = msg;
        return;
      }
      /* ⚠ 预览分支的 r.modules 是【未剔除】的 cur,绝不能覆盖 this.modules */
      this.delModuleKey = r.key || "";
      this.delModuleFiles = (r.files || []).slice();
      this.delModuleCount = Number(r.count) || 0;
      this.delModuleDir = r.dir || "";
    },

    closeDelModule() {
      this.showDelModule = false;
      this.delModuleName = "";
      this.delModuleKey = "";
      this.delModuleFiles = [];
      this.delModuleCount = 0;
      this.delModuleDir = "";
      this.delModuleErr = "";
      this.delBusy = false;
    },
    /* 第二段:真删。dryRun:false → modules.json 落盘 + 目录内文件逐个 os.remove
       + os.rmdir。失败不回滚(可能出现"文件已删、模块还在列表"的中间态),
       所以出错时把 r.error 留在弹窗里,让用户看到再决定重试。 */
    async confirmDelModule() {
      if (this.delBusy) return;              // 防重复点击
      const name = this.delModuleName;
      if (!name) return;

      this.delBusy = true;
      this.delModuleErr = "";
      try {
        const r = await window.PomeloModules.remove(name, {
          withCases: true,
          dryRun: false,
        });
        if (!r || !r.ok) {
          let msg = (r && r.error) || "删除失败";
          if (r && r.sub_dirs && r.sub_dirs.length)
            msg += "(目录下存在子目录,已中止:" + r.sub_dirs.join("、") + ")";
          this.delModuleErr = msg;
          return;
        }
        /* 只有 dry_run:false 的成功分支,r.modules 才是剔除后的 next */
        this.modules = (r.modules || []).slice();
        this._syncProjectsToForms();
        /* 该模块的用例也从内存列表里摘掉 — 赋新数组,确保 v-for 重跑 */
        this.list = this.list.filter((c) => c.project !== name);
        /* 当前停留在被删的 tab 上就回落到"全部用例" */
        if (this.delModuleKey && this.activeTab === this.delModuleKey)
          this.activeTab = "all";
        this.closeDelModule();
      } catch (e) {
        this.delModuleErr = "删除异常:" + (e && e.message ? e.message : e);
      } finally {
        this.delBusy = false;
      }
    },
  };
};
