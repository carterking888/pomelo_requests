/* ============================================================
 *  newcase — 新建用例表单
 *  ------------------------------------------------------------
 *  关键设计:
 *    1. 所有字段双向绑定到单一 `form` 对象,save() 时一次性序列化为 JSON
 *    2. headers/params/assertions/vars 是数组,支持 add/remove
 *    3. 状态机 `status`:
 *         'idle'      初始
 *         'saving'    正在保存(显示 loading,禁用按钮)
 *         'ok'        保存成功(显示绿色 toast,2s 后跳回列表)
 *         'error'     保存失败(显示红色 toast,可重试)
 *    4. 不弹原生 confirm —— 用 form.dirty 标记判断"有未保存改动",
 *       在用户点取消/离开时弹模态确认
 *    5. 保存成功后:
 *         - 把用例 push 到 PomeloApp.apicases.list(立刻可见,不依赖刷新)
 *         - 如果选了未知的 project,自动同步到模块列表(顶部 tab 新增)
 * ========================================================== */
window.newcaseComponent = function () {
  return {
    /* ---------- 业务字段 ---------- */
    form: {
      name: "",
      protocol: "socket", // 协议模式:socket(当前唯一实现) / http(预留)
      method: "GET",      // 仅 http 模式使用;socket 模式保存时空串
      path: "",
      project: "",        // 由 init() 从 apicases.modules 派生第一个
      desc: "",
      state: "on",
      tags: [],
    },
    headers:    [{ key: "", value: "" }],
    params:     [],
    bodyTab:    "json",
    bodyJson:   "",
    assertions: [],
    vars:       [],
    extracts:   [],   // 提取变量:[{name, expr}] — 从上一接口响应提取

    /* ---------- 状态机 ---------- */
    status:  "idle",
    message: "",
    saving:  false,

    dirty: false,
    confirmLeave: false,

    /* ---------- 枚举 ---------- */
    methods:      ["GET", "POST", "PUT", "DELETE"],
    assertTypes: [
      { type: "状态码",   cls: "status" },
      { type: "JSON",    cls: "json"   },
      { type: "响应时间", cls: "time"   },
      { type: "响应头",   cls: "header" },
    ],

    /* ---------- 项目下拉(普通数据字段,不再用 getter) ----------
     * ⚠ 坑(2026-09 修):原来写 get projects() { 读 window.PomeloApp.apicases.modules },
     *   但 getter 首次求值发生在【挂载时】,那一刻 PomeloApp 还没被 init() 赋值 →
     *   返回 [] 且没有建立任何响应式依赖 → 之后 modules 加载完也永远不会触发它重算,
     *   下拉框永远空。列表页 tabs 正常是因为它们读自己组件 proxy 上的 modules。
     *   改为普通字段,由 apicases 加载完模块后调 syncProjects() 推过来。 */
    projects: [],

    /* apicases 在模块加载/新建/删除后调用,同步选项与默认选中项 */
    syncProjects(mods) {
      const names = (Array.isArray(mods) ? mods : [])
        .map((m) => m && m.name).filter(Boolean);
      this.projects = names;
      if (!this.form.project && names.length) this.form.project = names[0];
      /* 当前选中项已被删除 → 回落第一项 */
      if (this.form.project && names.length && names.indexOf(this.form.project) < 0)
        this.form.project = names[0];
    },

    /* init:桥就绪后立刻调,此刻 modules 多半还没加载完;
       选项的真正填充靠 syncProjects(由 apicases.init 推送) */
    init() {
      const app = window.PomeloApp;
      const mods = (app && app.apicases && app.apicases.modules) || [];
      if (mods.length) this.syncProjects(mods);
    },

    /* 接口路径占位符随协议模式切换(模板里不写三元,坑 5) */
    get pathPlaceholder() {
      return this.form.protocol === "http"
        ? "/api/v1/users/{id}"
        : "ws://host:port 或 Pomelo 路由,如 /connector.enter";
    },

    /* socket 模式下方法下拉不渲染,路径 input 要独占整行:
       .input-group 默认 grid 110px+1fr,input 会掉进 110px 的第一列
       → 「地址框太短」。加修饰类把网格切 1fr。 */
    get pathSoloCls() {
      return this.form.protocol === "socket" ? "input-group--solo" : "";
    },

    /* ===========================================================
     *  行操作
     * ========================================================== */
    markDirty() { this.dirty = true; },

    /* ---------- 传参 JSON 校验 ----------
     * 点「校验」按钮时对 bodyJson 做语法检查:
     *   - 合法 → 绿色提示(顶层键/元素个数)
     *   - 非法 → 红色提示 + 浏览器原始报错(定位到行列)
     * 注意:{{var}} 占位符在引号内是合法 JSON,不影响校验;
     *   变量在执行时由引擎按环境替换。 */
    jsonCheckMsg: "",
    jsonCheckOk: false,
    validateBodyJson() {
      const raw = String(this.bodyJson || "").trim();
      if (!raw) {
        this.jsonCheckOk = false;
        this.jsonCheckMsg = "JSON 为空,请先填写请求 Body";
        return;
      }
      try {
        const obj = JSON.parse(raw);
        let extra = "(顶层为 " + typeof obj + ")";
        if (Array.isArray(obj)) extra = "(顶层数组," + obj.length + " 个元素)";
        else if (obj !== null && typeof obj === "object")
          extra = "(顶层 " + Object.keys(obj).length + " 个键)";
        this.jsonCheckOk = true;
        this.jsonCheckMsg = "✓ JSON 合法" + extra + ";{{变量}} 在执行时按环境替换";
      } catch (e) {
        this.jsonCheckOk = false;
        this.jsonCheckMsg = "✗ JSON 非法: " + e.message;
      }
    },

    addHeader()  { this.headers.push({ key: "", value: "" }); this.markDirty(); },
    removeHeader(i) { this.headers.splice(i, 1); this.markDirty(); },

    addParam()   { this.params.push({ key: "", value: "" }); this.markDirty(); },
    removeParam(i) { this.params.splice(i, 1); this.markDirty(); },

    addAssertion() {
      this.assertions.push({ type: "状态码", cls: "status", op: "eq", value: "" });
      this.markDirty();
    },
    /* 断言类型切换:op 不属于新类型时回落默认(状态码才有大于等于这些) */
    onAssertTypeChange(a) {
      window.PomeloUtils.normalizeAssertOp(a);
      this.markDirty();
    },
    /* 当前断言类型可选的比较符(模板不写复杂表达式) */
    opsOf(a) { return window.PomeloUtils.opsOfAssertType(a.type); },
    removeAssertion(i) { this.assertions.splice(i, 1); this.markDirty(); },

    addVar() {
      this.vars.push({ key: "", display: "", hint: "新建变量", cls: "draft" });
      this.markDirty();
    },
    removeVar(i) { this.vars.splice(i, 1); this.markDirty(); },

    /* 提取变量:从上一个接口的响应中提取值存为变量 */
    addExtract() {
      this.extracts.push({ name: "", expr: "" });
      this.markDirty();
    },
    removeExtract(i) { this.extracts.splice(i, 1); this.markDirty(); },

    addTag(text) {
      const t = (text || "").trim();
      if (!t) return;
      if (this.form.tags.indexOf(t) > -1) return;
      this.form.tags.push(t);
      this.markDirty();
    },
    removeTag(t) {
      this.form.tags = this.form.tags.filter((x) => x !== t);
      this.markDirty();
    },

    /* 标签输入框统一走方法(原来内联多语句表达式不可靠) */
    tagInput(e) {
      const el = e && e.target;
      if (!el) return;
      this.addTag(el.value);
      el.value = "";
    },
    /* 保存前兜底:输入框里打了字但没按回车的,一并收进来 */
    flushTagInput() {
      const el = document.getElementById("newcase-tag-input");
      if (el && String(el.value || "").trim()) {
        this.addTag(el.value);
        el.value = "";
      }
    },

    /* ===========================================================
     *  表单重置:保存成功跳回列表时、再次进入新建页时调用,
     *  避免"上一次填的内容还在"。
     *  ⚠ 不动 status/message —— 保存成功的 toast 还要显示 1.5s
     * ========================================================== */
    resetForm() {
      this.form = {
        name: "",
        protocol: "socket",
        method: "GET",
        path: "",
        project: (this.projects && this.projects[0]) || "",
        desc: "",
        state: "on",
        tags: [],
      };
      this.headers = [{ key: "", value: "" }];
      this.params = [];
      this.bodyTab = "json";
      this.bodyJson = "";
      this.assertions = [];
      this.vars = [];
      this.extracts = [];
      this.dirty = false;
      const el = document.getElementById("newcase-tag-input");
      if (el) el.value = "";
    },

    /* ===========================================================
     *  离开确认
     * ========================================================== */
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
      window.location.hash = this._pendingHash || "#/apicases";
    },
    confirmLeaveNo() { this.confirmLeave = false; },

    /* ===========================================================
     *  保存
     * ========================================================== */
    async save() {
      // 0) 输入框里没按回车的标签先收进来
      this.flushTagInput();

      // 1) 基础校验
      if (!this.form.name.trim()) {
        this.status = "error";
        this.message = "请填写用例名称";
        return;
      }
      if (!this.form.path.trim()) {
        this.status = "error";
        this.message = "请填写接口路径";
        return;
      }

      this.status = "saving";
      this.message = "正在保存...";
      this.saving = true;

      // 2) 组装 JSON —— 清洗空行
      const isHttp = this.form.protocol === "http";
      const payload = {
        case: {
          name:   this.form.name.trim(),
          /* 协议模式:socket(当前唯一实现)/ http(预留,UI 已可切换)。
             socket 模式没有请求方法,method 落空串 */
          protocol: this.form.protocol,
          method: isHttp ? this.form.method : "",
          path:   this.form.path.trim(),
          project: this.form.project,
          desc:   this.form.desc.trim(),
          state:  this.form.state,
          tags:   this.form.tags.slice(),
        },
        /* 预留字段:HTTP 协议用例的专属配置(url/headers/...)。
           socket 用例恒为 null,后续支持 http 时再填结构,避免改 schema */
        http: null,
        headers:    this.headers.filter((h) => h.key.trim()).map((h) => ({
                       key:   h.key.trim(),
                       value: h.value,
                     })),
        params:     this.params.filter((p) => p.key.trim()).map((p) => ({
                       key:   p.key.trim(),
                       value: p.value,
                     })),
        bodyTab:    this.bodyTab,
        bodyJson:   this.bodyJson,
        assertions: this.assertions
          .filter((a) => String(a.value || "").trim())
          .map((a) => ({
            type: a.type,
            path: String(a.path || "").trim(),
            op:   a.op || window.PomeloUtils.defaultOpOfAssertType(a.type),
            value: String(a.value).trim(),
          })),
        vars:       this.vars.filter((v) => v.key.trim()).map((v) => ({
                       key:     v.key.trim(),
                       display: "{{" + v.key.trim() + "}}",
                       hint:    v.hint,
                       cls:     v.cls,
                     })),
        /* 提取变量:从上一个接口的响应中提取值,供后续用例引用。
           expr 支持 JSONPath(如 $.data.token)或自定义提取规则 */
        extract:    this.extracts.filter((e) => e.name.trim()).map((e) => ({
                       name:   e.name.trim(),
                       expr:   e.expr.trim(),
                       source: "上一接口响应",
                     })),
        createdAt:  new Date().toISOString(),
      };

      // 3) 定归档目录 —— 用例落到 data/cases/{module_key}/*.json
      //    name→key 的映射在 modules.js 里是私有的(_pickKey 未导出),所以只能
      //    从已登记的模块列表里按显示名反查 key。
      //    ⚠ 顺序很关键:先登记模块、再存用例。否则一个全新模块名第一次保存时
      //    列表里还没有它,key 取不到,用例会掉到 data/cases/ 根目录,要等第二次
      //    保存才归档。查不到 key 就传 ""(storage 退回 category 根目录),
      //    不阻塞保存。
      const proj = String(payload.case.project || "").trim();
      let modKey = "";
      let syncedModules = null;
      try {
        const ac = window.PomeloApp && window.PomeloApp.apicases;
        let hit = ((ac && ac.modules) || []).filter((m) => m.name === proj)[0];
        if (!hit && proj) {
          const rm = await window.PomeloModules.add(proj);
          if (rm && rm.ok && rm.modules) {
            syncedModules = rm.modules;
            hit = rm.modules.filter((m) => m.name === proj)[0];
          }
        }
        if (hit) modKey = hit.key || "";
      } catch (_) { /* 归档失败不算致命,退回根目录 */ }

      // 3.5) 同目录标题查重 —— 用例文件名 = 标题,同模块下重复会覆盖旧用例。
      //      读全量(含模块子目录),同 module key 下文件名或用例名撞车即拦截。
      try {
        const all = await window.PomeloStorage.listJson("cases", { recursive: true });
        const items = (all && all.ok && Array.isArray(all.items)) ? all.items : [];
        const newTitle = payload.case.name.trim();
        const dup = items.filter((it) => {
          if (String(it.module || "") !== modKey) return false;
          const fn = String(it.file_name || "").replace(/\.json$/i, "");
          const c = (it.content && it.content.case) || {};
          return fn === newTitle || String(c.name || "").trim() === newTitle;
        })[0];
        if (dup) {
          this.status = "error";
          this.saving = false;
          this.message = "保存失败:当前模块「" + (proj || "未归档") + "」下已存在同名用例「"
            + newTitle + "」,请换一个标题";
          return;
        }
      } catch (_) { /* 查重读盘失败不阻塞保存,保持旧行为 */ }

      // 4) 调存储
      let saved;
      try {
        saved = await window.PomeloStorage.saveJson(
          "cases",
          payload.case.name,
          payload,
          modKey
        );
      } catch (e) {
        this.status = "error";
        this.message = "保存异常: " + e.message;
        this.saving = false;
        return;
      }

      if (!saved || !saved.ok) {
        this.status = "error";
        this.message = "保存失败: " + ((saved && saved.error) || "未知错误")
                     + (saved && saved.backend === "memory"
                        ? " (浏览器预览未落盘,请用 pywebview 启动)"
                        : "");
        this.saving = false;
        return;
      }

      // 5) 保存成功 — 立即把这条用例插回活跃列表
      //    注:PetiteVue 0.4 的 reactive 不跟踪 push/splice 等数组方法,
      //    必须用赋值新数组才能触发 v-for 重渲。
      try {
        const app = window.PomeloApp;
        const apicases = app && app.apicases;
        if (apicases) {
          const maxId = (apicases.list || []).reduce(
            (m, c) => Math.max(m, Number(c.id) || 0), 0);
          apicases.list = apicases.list.concat([
            window.PomeloUtils.toListItem(payload, maxId + 1),
          ]);

          // 新模块已在第 3 步登记过 → 这里只负责把顶部 tab 刷新
          if (syncedModules) {
            apicases.modules = syncedModules.slice();
            this.syncProjects(syncedModules);   // 自己的下拉也同步上
          }
        }
      } catch (_) { /* 不影响保存成功的提示 */ }

      this.status = "ok";
      this.message = "已保存到 " + saved.path;
      this.dirty = false;
      this.saving = false;

      // 1.5s 后跳回列表,跳的同时清空表单(下次进来是干净页面)
      setTimeout(() => {
        window.location.hash = "#/apicases";
        this.resetForm();
      }, 1500);
    },
  };
};
