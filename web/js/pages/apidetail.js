/* ============================================================
 *  接口用例详情 / 编辑 / 查看
 *  - 数据来源:data/cases/*.json。
 *      #/apicases/<file>      → 编辑模式(字段与「新建用例」页一致)
 *      #/apicase-view/<file>  → 查看模式(只读锁定,不能修改)
 *    由 app.js 在路由变为 apicases-detail 时调 load()(route 名相同
 *    但 hash 参数变了也要重新加载,详见 app.js onHashChange)。
 *  - 查看模式的只读锁定由 CSS(.page-readonly)统一处理:
 *    禁用输入、隐藏行级增删按钮与保存按钮。
 *  - ⚠ mockData 参数仅保留签名兼容(app.js 仍传 M.apidetail),不读取。
 * ========================================================== */
window.apidetailComponent = function (mockData) {
  return {
    loading: false,
    notFound: false,
    readonly: false,       // true = 查看模式(三点菜单「查看」进入)
    fileName: "",          // 用例文件名(不含 .json),保存时写回同名文件
    modKey: "",            // 读盘时记下的归档子目录(= 模块 key)
    createdAt: "",         // 保留原创建时间,保存时不覆盖

    case: { name: "", protocol: "socket", method: "GET", path: "",
            project: "", desc: "", state: "on", tags: [] },
    headers: [], params: [], bodyTab: "json", bodyJson: "",
    assertions: [], vars: [], extracts: [], tags: [],
    projectOptions: [],    // load 时一次性从 apicases.modules 取真实模块名

    /* 保存状态机(与 newcase 一致):idle / saving / ok / error */
    status: "idle",
    message: "",
    saving: false,

    /* 枚举(与 newcase 一致) */
    methods: ["GET", "POST", "PUT", "DELETE"],
    assertTypes: [
      { type: "状态码",   cls: "status" },
      { type: "JSON",    cls: "json"   },
      { type: "响应时间", cls: "time"   },
      { type: "响应头",   cls: "header" },
    ],

    /* ---- 展示预映射(模板不写三元,坑 5) ---- */
    get methodLabel() {
      return (this.case.protocol || "socket") === "socket"
        ? "SOCKET" : (this.case.method || "GET");
    },
    get methodCls() {
      return (this.case.protocol || "socket") === "socket"
        ? "socket" : String(this.case.method || "get").toLowerCase();
    },
    get stateLabel() {
      const s = this.case.state;
      return s === "off" ? "已停用" : (s === "draft" ? "草稿" : "已启用");
    },
    get dotCls() {
      const s = this.case.state;
      return s === "on" ? "green" : "gray";
    },

    /* 接口路径占位符随协议切换(同 newcase) */
    get pathPlaceholder() {
      return this.case.protocol === "http"
        ? "/api/v1/users/{id}"
        : "ws://host:port 或 Pomelo 路由,如 /connector.enter";
    },
    /* socket 模式方法下拉不渲染,路径 input 独占整行(同 newcase) */
    get pathSoloCls() {
      return this.case.protocol === "socket" ? "input-group--solo" : "";
    },

    /* 查看模式右上角「编辑」按钮的目标路由(带目录,同名用例不串) */
    get editHash() {
      return "#/apicases/" + encodeURIComponent(this.modKey || "")
        + "/" + encodeURIComponent(this.fileName || "");
    },

    /* ============================================================
     * 按当前 hash 加载用例:
     *   #/apicases/<模块key>/<file> → 编辑;#/apicase-view/<模块key>/<file> → 查看(只读)
     *   兼容旧格式 #/apicases/<file>(不带目录,命中第一份同名文件)
     * ========================================================== */
    async load() {
      const hash = window.location.hash || "";
      const mView = hash.match(/^#\/apicase-view\/(.*)$/i);
      const mEdit = hash.match(/^#\/apicases\/(.*)$/i);
      const m = mView || mEdit;
      this.readonly = !!mView;
      const raw = m ? m[1] : "";
      /* 两段式:<模块key>/<file>(file 已 encodeURIComponent,"/"不会出现在
         文件名里);单段为旧格式,modKey 置 null 表示不按目录过滤 */
      const segs = raw.split("/");
      let modKey = null, name = "";
      try {
        if (segs.length >= 2) {
          modKey = decodeURIComponent(segs[0]);
          name = decodeURIComponent(segs.slice(1).join("/"));
        } else {
          name = decodeURIComponent(raw);
        }
      } catch (_) {
        if (segs.length >= 2) { modKey = segs[0]; name = segs.slice(1).join("/"); }
        else name = raw;
      }
      name = String(name).trim();
      if (!name) { this.notFound = true; return; }

      this.loading = true;
      try {
        const r = await window.PomeloStorage.listJson("cases", { recursive: true });
        const items = (r && r.ok && Array.isArray(r.items)) ? r.items : [];
        const byName = items.filter((it) =>
          String(it.file_name || "").replace(/\.json$/i, "") === name);
        /* 优先按目录精确定位(同名用例只在该目录里找);带目录但没命中时
           不回落到其他目录——打开错内容比打不开更糟 */
        const hit = (modKey !== null
          ? byName.filter((it) => String(it.module || "") === modKey)[0]
          : byName[0]);
        if (!hit) { this.notFound = true; return; }
        this._apply(hit.file_name, hit.module || "", hit.content || {});
      } finally {
        this.loading = false;
      }
    },

    /* payload(与 newcase.save 落盘结构一致)→ 页面状态 */
    _apply(fileName, modKey, payload) {
      const c = payload.case || {};
      this.fileName = String(fileName || "").replace(/\.json$/i, "");
      this.modKey = modKey;
      this.createdAt = payload.createdAt || "";
      this.case = {
        name: c.name || "", protocol: c.protocol || "socket",
        method: c.method || "GET", path: c.path || "",
        project: c.project || "", desc: c.desc || "",
        state: c.state || "on", tags: (c.tags || []).slice(),
      };
      this.headers = (payload.headers || []).map((h) =>
        ({ key: h.key || "", value: h.value || "" }));
      this.params = (payload.params || []).map((p) =>
        ({ key: p.key || "", value: p.value || "" }));
      this.bodyTab = payload.bodyTab || "json";
      this.bodyJson = payload.bodyJson || "";
      this.assertions = (payload.assertions || []).map((a) => {
        const row = { type: a.type || "JSON", value: a.value || "",
                      cls: this._clsOf(a.type), path: a.path || "" };
        /* op 缺失或不在该类型可选列表时回落默认(旧数据没有 op 字段) */
        const legal = window.PomeloUtils.opsOfAssertType(row.type)
          .some(([, v]) => v === a.op);
        row.op = legal ? a.op : window.PomeloUtils.defaultOpOfAssertType(row.type);
        return row;
      });
      this.vars = (payload.vars || []).map((v) =>
        ({ key: v.key || "", display: v.display || ("{{" + (v.key || "") + "}}"),
           hint: v.hint || "", cls: v.cls || "draft" }));
      this.extracts = (payload.extract || []).map((e) =>
        ({ name: e.name || "", expr: e.expr || "" }));
      this.tags = (c.tags || []).map((t) => ({ text: String(t) }));
      this.notFound = false;

      /* 项目下拉选项:走 syncProjects 推送式填充(勿在此一次性读
         PomeloApp.apicases.modules — 重启/刷新后直接停在编辑页时,
         apicases.init 还没加载完模块,一次性读取拿到的是 [],之后
         模块加载完也不会再更新 → 下拉恒空) */
      this.syncProjects(
        ((window.PomeloApp && window.PomeloApp.apicases
          && window.PomeloApp.apicases.modules) || []));
    },

    /* apicases 在模块加载/新建/改名/删除后调用,推送最新模块名。
       当前用例的项目不在列表里(如模块被删)时保留原值,避免 v-model 静默清空 */
    syncProjects(mods) {
      const names = (Array.isArray(mods) ? mods : [])
        .map((m) => m && m.name).filter(Boolean);
      this.projectOptions = names.slice();
      if (this.case.project && names.indexOf(this.case.project) < 0)
        this.projectOptions.unshift(this.case.project);
    },

    _clsOf(type) {
      if (type === "状态码")   return "status";
      if (type === "响应时间") return "time";
      if (type === "响应头")   return "header";
      if (type === "Header")   return "header";
      return "json";
    },

    /* ---- 行级增删 ---- */
    addHeader()    { if (!this.readonly) this.headers.push({ key: "", value: "" }); },
    rmHeader(i)    { if (!this.readonly) this.headers.splice(i, 1); },
    addParam()     { if (!this.readonly) this.params.push({ key: "", value: "" }); },
    rmParam(i)     { if (!this.readonly) this.params.splice(i, 1); },
    addAssertion() {
      if (!this.readonly)
        this.assertions.push({ type: "状态码", cls: "status", op: "eq", value: "" });
    },
    /* 断言类型切换:op 不属于新类型时回落默认(状态码才有大于等于这些) */
    onAssertTypeChange(a) { window.PomeloUtils.normalizeAssertOp(a); },
    /* 当前断言类型可选的比较符(模板不写复杂表达式) */
    opsOf(a) { return window.PomeloUtils.opsOfAssertType(a.type); },
    rmAssertion(i) { if (!this.readonly) this.assertions.splice(i, 1); },
    addVar() {
      if (!this.readonly)
        this.vars.push({ key: "", display: "", hint: "", cls: "draft" });
    },
    rmVar(i)       { if (!this.readonly) this.vars.splice(i, 1); },
    addExtract()   { if (!this.readonly) this.extracts.push({ name: "", expr: "" }); },
    rmExtract(i)   { if (!this.readonly) this.extracts.splice(i, 1); },
    addTag(t) {
      if (this.readonly) return;
      const s = String(t || "").trim();
      if (!s || this.tags.some((x) => x.text === s)) return;
      this.tags.push({ text: s });
    },
    rmTag(t) { if (!this.readonly) this.tags = this.tags.filter((x) => x.text !== t); },

    /* 标签输入框(与 newcase 一致,回车添加) */
    tagInput(e) {
      const el = e && e.target;
      if (!el) return;
      this.addTag(el.value);
      el.value = "";
    },
    flushTagInput() {
      const el = document.getElementById("apidetail-tag-input");
      if (el && String(el.value || "").trim()) {
        this.addTag(el.value);
        el.value = "";
      }
    },

    /* ---- 保存:写回同一文件(payload 结构与 newcase.save 对齐) ----
     * 带状态机:按钮禁用(saving) + 底部 toast(ok/error),不再静默。
     * 成功后 1.2s 返回列表(与 newcase 一致),列表由 onHashChange 重读。 */
    async saveCase() {
      if (this.readonly) {
        this.status = "error";
        this.message = "查看模式不可修改";
        return { ok: false, error: this.message };
      }
      this.flushTagInput();
      if (!this.fileName) {
        this.status = "error";
        this.message = "未加载用例,请返回列表重新进入";
        return { ok: false, error: this.message };
      }
      if (!String(this.case.name || "").trim()) {
        this.status = "error";
        this.message = "请填写用例名称";
        return { ok: false, error: this.message };
      }

      this.status = "saving";
      this.message = "正在保存...";
      this.saving = true;

      const app = window.PomeloApp;
      const mods = (app && app.apicases && app.apicases.modules) || [];
      const hit = mods.filter((m) => m.name === this.case.project)[0];
      const modKey = hit ? hit.key : this.modKey;
      const payload = {
        case: {
          name: this.case.name,
          protocol: this.case.protocol || "socket",
          method: this.case.protocol === "http" ? this.case.method : "",
          path: this.case.path, project: this.case.project,
          desc: this.case.desc, state: this.case.state,
          tags: this.tags.map((t) => t.text),
        },
        http: null,
        headers: this.headers.filter((h) => h.key.trim()),
        params:  this.params.filter((p) => p.key.trim()),
        bodyTab: this.bodyTab, bodyJson: this.bodyJson,
        assertions: this.assertions
          .filter((a) => String(a.value || "").trim())
          .map((a) => ({
            type: a.type,
            path: String(a.path || "").trim(),
            op:   a.op || window.PomeloUtils.defaultOpOfAssertType(a.type),
            value: String(a.value).trim(),
          })),
        vars: this.vars.filter((v) => v.key.trim()).map((v) => ({
          key: v.key.trim(), display: "{{" + v.key.trim() + "}}",
          hint: v.hint, cls: v.cls,
        })),
        extract: this.extracts.filter((e) => e.name.trim()).map((e) => ({
          name: e.name.trim(), expr: e.expr.trim(), source: "上一接口响应",
        })),
      };
      if (this.createdAt) payload.createdAt = this.createdAt;

      /* 所属项目变更 → 移动语义:旧模块目录里的同名文件必须删掉,
       * 否则递归 listJson 会把两份都读出来(用户看到的是"复制"而非"移动")。
       * modKey 是 load() 时记下的原归档目录;套件按 file 名引用用例,
       * 文件名不变所以套件引用不受影响。 */
      const origModKey = this.modKey || "";

      /* 归属目录查重(文件名=用例标题,同名文件落盘即覆盖,必须拦):
       * - 「自身」= 原目录(origModKey)里同文件名那份,只有留在原目录时才排除;
       * - 目标目录(modKey)里文件名或用例名撞车 → 一律拦截,不允许覆盖。
       * 跨模块移动时目标目录的同名用例因此不再被静默覆盖。
       * 查重读盘失败不阻塞保存。 */
      try {
        const all = await window.PomeloStorage.listJson("cases", { recursive: true });
        const items = (all && all.ok && Array.isArray(all.items)) ? all.items : [];
        const newTitle = String(this.case.name || "").trim();
        const dup = items.filter((it) => {
          const fn = String(it.file_name || "").replace(/\.json$/i, "");
          const itMod = String(it.module || "");
          if (fn === this.fileName && itMod === origModKey) return false; // 自身(仅原目录内)
          if (itMod !== (modKey || "")) return false;                     // 只看目标目录
          const c = (it.content && it.content.case) || {};
          return fn === newTitle || String(c.name || "").trim() === newTitle;
        })[0];
        if (dup) {
          this.status = "error";
          const modName = (hit && hit.name) || this.case.project || "目标目录";
          this.message = (origModKey === (modKey || "")
            ? "当前目录下已存在同名用例「" + newTitle + "」,请换一个标题"
            : "目标目录「" + modName + "」下已存在同名用例「" + newTitle + "」,不能覆盖,请换标题或换目录");
          this.saving = false;
          return { ok: false, error: this.message };
        }
      } catch (_) { /* 查重失败保持旧行为 */ }

      let r;
      try {
        r = await window.PomeloStorage.saveJson(
          "cases", this.fileName, payload, modKey);
      } catch (e) {
        this.status = "error";
        this.message = "保存异常: " + (e && e.message || e);
        this.saving = false;
        return { ok: false, error: this.message };
      }
      if (!r || !r.ok) {
        this.status = "error";
        this.message = "保存失败: " + ((r && r.error) || "未知错误")
          + (r && r.backend === "memory"
             ? " (浏览器预览未落盘,请用 pywebview 启动)" : "");
        this.saving = false;
        return r || { ok: false };
      }

      if ((origModKey || "") !== (modKey || "")) {
        const del = await window.PomeloStorage.deleteJson(
          "cases", this.fileName, origModKey);
        if (del && del.ok && !del.found) {
          console.warn("[apidetail] 移动用例:旧文件未找到(" +
            origModKey + "/" + this.fileName + "),可能已不在原目录");
        } else if (del && !del.ok) {
          console.warn("[apidetail] 移动用例:删除旧文件失败:" +
            (del.error || ""));
        }
        /* 更新归档目录记录,避免下次保存重复删旧位置 */
        this.modKey = modKey;
      }

      /* 保存成功 → toast + 1.2s 后返回列表;
         列表新鲜度由 app.js onHashChange 进入 apicases 时重读保证 */
      this.status = "ok";
      this.message = "用例已保存" +
        ((origModKey || "") !== (modKey || "") ? "(已移动到 " + this.case.project + ")" : "");
      this.saving = false;
      setTimeout(() => {
        /* 用户在 1.2s 内手动离开(切了路由)就不强拉 */
        if ((window.location.hash || "").match(/^#\/(apicases|apicase-view)\//i))
          window.location.hash = "#/apicases";
        this.status = "idle";
        this.message = "";
      }, 1200);
      return r;
    },
  };
};
