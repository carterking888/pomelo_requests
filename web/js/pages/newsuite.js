/* ============================================================
 *  newsuite — 新建套件表单
 *  ------------------------------------------------------------
 *  字段:
 *    name        套件名称(必填)
 *    project     所属项目
 *    env         执行环境(读 data/config/envs.json,与测试执行页同源)
 *    concurrency 固定 1(与执行页一致,引擎串行)
 *    retry       失败重试次数
 *    timeout     超时时间(秒)
 *    caseIds     选中的用例 id(候选列表的行内序号)
 *
 *  数据流:
 *    - 候选用例读 data/cases/*.json 真实落盘数据(不写死)
 *    - envs 读 data/config/envs.json(testrun.loadEnvs 同一份配置)
 *    - projects 由 apicases._syncProjectsToForms 推送(坑 8.1,不用 getter)
 *    - 保存:落 data/suites/<套件名>.json,cases 存真实文件引用
 *      {file, name},执行引擎按 file 回查完整用例 payload
 * ========================================================== */
window.newsuiteComponent = function (testrunMock) {
  return {
    /* 页面模式:create=新建 / edit=编辑 / view=查看(只读) */
    mode:     "create",
    editFile: "",        // 编辑/查看的套件文件名(不含 .json)
    origName: "",        // 编辑前原套件名(改名保存后删旧文件用)

    get readonly() { return this.mode === "view"; },
    get modeLabel() {
      return this.mode === "edit" ? "编辑套件"
           : this.mode === "view" ? "查看套件" : "新建套件";
    },
    get modeTitle() {
      return this.mode === "edit" ? "编辑测试套件"
           : this.mode === "view" ? "查看测试套件" : "新建测试套件";
    },

    /* 表单数据 */
    form: {
      name:        "",
      project:     "",        // 由 syncProjects 推送默认值
      env:         "test",
      concurrency: 1,         // 固定 1,页面不提供修改入口
      retry:       1,
      timeout:     60,
      caseIds:     [],
    },

    /* 新建模式:复位表单 */
    _resetForm() {
      this.form.name = "";
      this.form.env = (this.envs.length ? this.envs[0].key : "test");
      this.form.retry = 1;
      this.form.timeout = 60;
      this.form.caseIds = [];
      this.editFile = "";
      this.origName = "";
      this.dirty = false;
      this.status = "idle";
      this.message = "";
    },

    /* 枚举 */
    envs: (testrunMock && testrunMock.envs) ? testrunMock.envs.slice() : [],
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

    /* 用例候选列表(读 data/cases 真实用例,init 填充) */
    candidateCases: [],

    /* 项目下拉(普通数据字段;由 apicases._syncProjectsToForms 推送) */
    projects: [],
    syncProjects(mods) {
      const names = (Array.isArray(mods) ? mods : [])
        .map((m) => m && m.name).filter(Boolean);
      this.projects = names;
      if (!this.form.project && names.length) this.form.project = names[0];
      if (this.form.project && names.length && names.indexOf(this.form.project) < 0)
        this.form.project = names[0];
    },

    /* 按当前 hash 识别页面模式:
     *   #/testrun-new-suite              → 新建
     *   #/testrun-suite-edit/<file>      → 编辑
     *   #/testrun-suite-view/<file>      → 查看(只读) */
    loadFromRoute() {
      const h = window.location.hash || "";
      const mEdit = h.match(/^#\/testrun-suite-edit\/(.*)$/i);
      const mView = h.match(/^#\/testrun-suite-view\/(.*)$/i);
      const m = mEdit || mView;
      if (!m) { this.mode = "create"; this._resetForm(); return ""; }
      this.mode = mEdit ? "edit" : "view";
      let name = "";
      try { name = decodeURIComponent(m[1]); } catch (_) { name = m[1]; }
      this.editFile = String(name).trim();
      return this.editFile;
    },

    /* init:同步 project 默认值 + 读环境配置 + 读用例候选 */
    async init() {
      const app = window.PomeloApp;
      const file = this.loadFromRoute();
      const mods = (app && app.apicases && app.apicases.modules) || [];
      if (mods.length) this.syncProjects(mods);

      /* 环境配置与测试执行页同源:data/config/envs.json */
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
            color: String(e.color || ""),
            baseUrl: String(e.baseUrl || ""),
          }));
        }
        if (this.envs.length && !this.envs.some((e) => e.key === this.form.env))
          this.form.env = this.envs[0].key;
      } catch (_) { /* 保持默认 */ }

      /* 用例候选:读 data/cases 真实落盘用例 */
      try {
        const r2 = await window.PomeloStorage.listJson("cases", { recursive: true });
        const items = (r2 && r2.ok && Array.isArray(r2.items)) ? r2.items : [];
        this.candidateCases = items.map((it, idx) => {
          const c = window.PomeloUtils.toListItem(it.content, idx + 1);
          return {
            id: c.id,
            name: c.name,
            method: c.method,        // socket 用例为 SOCKET
            path: c.path,
            project: c.project,
            /* 执行引擎按 file 回查完整 payload */
            file: String(it.file_name || "").replace(/\.json$/i, ""),
          };
        });
      } catch (_) { this.candidateCases = []; }

      /* 编辑/查看模式:读套件内容回填表单 */
      if (this.mode !== "create") await this._loadSuite(file || this.editFile);
      console.log("[newsuite] init 完成,mode=" + this.mode +
        ",候选用例 " + this.candidateCases.length + " 条");
    },

    /* 编辑/查看:按文件名读套件,回填表单(找不到回落新建模式) */
    async _loadSuite(file) {
      if (!file) { this.mode = "create"; this._resetForm(); return; }
      try {
        const r = await window.PomeloStorage.listJson("suites", { recursive: true });
        const items = (r && r.ok && Array.isArray(r.items)) ? r.items : [];
        const hit = items.filter((it) =>
          String(it.file_name || "").replace(/\.json$/i, "") === file)[0];
        if (!hit) {
          window.alert("未找到套件文件「" + file + "」,可能已被删除");
          this.mode = "create"; this._resetForm(); return;
        }
        const s = (hit.content && hit.content.suite) || {};
        this.origName = s.name || file;
        this.editFile = file;
        this.form.name = s.name || "";
        this.form.project = s.project || this.form.project;
        this.form.env = s.env || this.form.env;
        this.form.retry = Number(s.retry) || 0;
        this.form.timeout = Number(s.timeout) || 60;
        /* 套件内存的是 [{file,name}],按套件保存时的顺序映射回候选列表 id
         * (执行引擎按数组顺序串行执行,顺序不能被候选列表顺序覆盖) */
        const files = (Array.isArray(hit.content && hit.content.cases)
          ? hit.content.cases : []).map((c) => c && c.file);
        const idByFile = {};
        this.candidateCases.forEach((c) => { idByFile[c.file] = c.id; });
        this.form.caseIds = files
          .map((f) => idByFile[f])
          .filter((x) => x !== undefined);
        this.dirty = false;
        this.status = "idle";
        this.message = "";
      } catch (_) { /* 读盘失败保持新建模式 */ }
    },

    /* 状态机 */
    status:  "idle",
    message: "",
    saving:  false,
    dirty:   false,
    confirmLeave: false,
    _pendingHash:  "",

    markDirty() { this.dirty = true; },

    /* 候选用例(全部展示,项目列可见;项目下拉只影响套件归属) */
    get filteredCandidates() {
      return this.candidateCases;
    },

    toggleCase(id) {
      if (this.readonly) return;
      const idx = this.form.caseIds.indexOf(id);
      if (idx > -1) this.form.caseIds.splice(idx, 1);
      else this.form.caseIds.push(id);
      this.markDirty();
    },

    isCaseSelected(id) { return this.form.caseIds.indexOf(id) > -1; },

    /* 已选用例(按 caseIds 顺序 = 执行顺序),执行顺序面板渲染用 */
    get selectedCases() {
      return this.form.caseIds
        .map((id) => this.candidateCases.filter((c) => c.id === id)[0])
        .filter(Boolean);
    },

    /* 调整执行顺序:dir=-1 上移 / 1 下移
     * 注:PetiteVue 0.4 数组方法不跟踪,必须赋值新数组触发重渲 */
    moveCase(id, dir) {
      if (this.readonly) return;
      const ids = this.form.caseIds.slice();
      const i = ids.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ids.length) return;
      ids[i] = ids[j]; ids[j] = id;
      this.form.caseIds = ids;
      this.markDirty();
    },

    /* 从执行顺序面板移除一条用例 */
    removeCase(id) {
      if (this.readonly) return;
      this.form.caseIds = this.form.caseIds.filter((x) => x !== id);
      this.markDirty();
    },

    /* 离开确认 */
    requestLeave(goHash) {
      if (this.dirty && this.status !== "ok") {
        this._pendingHash = goHash;
        this.confirmLeave = true;
      } else {
        window.location.hash = goHash;
      }
    },
    confirmLeaveYes() {
      this.confirmLeave = false;
      this.dirty = false;
      window.location.hash = this._pendingHash || "#/testrun";
    },
    confirmLeaveNo() { this.confirmLeave = false; },

    async save() {
      if (this.readonly) return;   // 查看模式不可保存
      if (!this.form.name.trim()) {
        this.status = "error";
        this.message = "请填写套件名称";
        return;
      }
      if (!this.form.caseIds.length) {
        this.status = "error";
        this.message = "请至少选择一条用例";
        return;
      }
      this.status = "saving";
      this.message = "正在保存...";
      this.saving = true;

      /* 选中的用例 → 真实文件引用(执行引擎按 file 回查 payload)
       * 顺序 = caseIds 顺序 = 执行顺序面板展示的顺序,不可被候选列表顺序覆盖 */
      const byId = {};
      this.candidateCases.forEach((c) => { byId[c.id] = c; });
      const chosen = this.form.caseIds
        .map((id) => byId[id])
        .filter(Boolean)
        .map((c) => ({ file: c.file, name: c.name }));

      const payload = {
        suite: {
          name:        this.form.name.trim(),
          project:     this.form.project,
          env:         this.form.env,
          concurrency: 1,           // 固定 1
          retry:       this.form.retry,
          timeout:     this.form.timeout,
        },
        cases:     chosen,
        caseCount: chosen.length,
        createdAt: new Date().toISOString(),
      };

      let saved;
      try {
        saved = await window.PomeloStorage.saveJson(
          "suites",
          payload.suite.name,
          payload
        );
      } catch (e) {
        this.status = "error";
        this.message = "保存异常: " + e.message;
        this.saving = false;
        return;
      }

      if (!saved || !saved.ok) {
        this.status = "error";
        this.message = "保存失败: " + ((saved && saved.error) || "未知错误");
        this.saving = false;
        return;
      }

      // 编辑模式且改了名 → 删掉旧文件(套件文件名 = 套件名)
      if (this.mode === "edit" && this.editFile &&
          this.editFile !== payload.suite.name) {
        try {
          await window.PomeloStorage.deleteJson("suites", this.editFile);
          console.log("[newsuite] 套件改名: " + this.editFile + " → " + payload.suite.name);
        } catch (_) { /* 旧文件清理失败不影响保存结果 */ }
      }

      // 保存成功 → 立刻插入到活跃 suites + 按需新建模块
      // 注:PetiteVue 0.4 的 reactive 不跟踪 push/splice 等数组方法,
      // 必须用赋值新数组才能触发 v-for 重渲。
      // 编辑模式不插(返回 testrun 时 init() 会从磁盘重读,避免重复行)
      if (this.mode === "create") {
        try {
          const app = window.PomeloApp;
          const testrun = app && app.testrun;
          if (testrun && Array.isArray(testrun.suites)) {
            const maxId = testrun.suites.reduce(
              (m, s) => Math.max(m, Number(s.id) || 0), 0);
            const item = window.PomeloUtils.toSuiteItem(payload, maxId + 1);
            /* 执行/选中按真实文件名定位 */
            item.file = String(saved.name || payload.suite.name);
            testrun.suites = testrun.suites.concat([item]);
            testrun.suiteCount = testrun.suites.length;
          }
        } catch (_) { /* 不影响保存提示 */ }
      }
      const proj = payload.suite.project;
      try {
        const app = window.PomeloApp;
        const apicases = app && app.apicases;
        if (proj && apicases && apicases.modules && !apicases.modules.some((m) => m.name === proj)) {
          const r = await window.PomeloModules.add(proj);
          if (r && r.ok && r.modules) apicases.modules = r.modules.slice();
        }
      } catch (_) { /* 不影响保存提示 */ }

      this.status = "ok";
      this.message = "已保存到 " + saved.path;
      this.dirty = false;
      this.saving = false;
      setTimeout(() => {
        window.location.hash = "#/testrun";
        /* 表单复位,下次进来是干净页面 */
        this.form.name = "";
        this.form.caseIds = [];
        this.status = "idle";
      }, 1500);
    },
  };
};
