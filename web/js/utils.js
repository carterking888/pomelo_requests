/* ============================================================
 *  utils.js — 前端公用工具
 *  ------------------------------------------------------------
 *    toListItem(payload, newId)
 *      把 newcase 保存的 payload 翻成 apicases.list 用的列表项。
 *      模板上需要的派生字段(methodCls / dotCls / stateLabel / hasTags /
 *      updated)在这里补齐,避免 v-show / v-for 里再嵌套表达式。
 * ========================================================== */
(function (root) {
  /* 默认模块列表(用于没有任何持久化数据时的兜底,
     数据来源本身建议通过 PomeloModules 接口注入) */
  const DEFAULT_MODULES = [
    { name: "用户中心", key: "user",  icon: "layui-icon-user",         color: "linear-gradient(135deg,#6366f1,#8b5cf6)" },
    { name: "订单中心", key: "order", icon: "layui-icon-cart",         color: "linear-gradient(135deg,#ef4444,#f59e0b)" },
    { name: "支付中心", key: "pay",   icon: "layui-icon-rmb",          color: "linear-gradient(135deg,#10b981,#06b6d4)" },
    { name: "商品中心", key: "goods", icon: "layui-icon-gift",         color: "linear-gradient(135deg,#f59e0b,#ef4444)" },
    { name: "库存中心", key: "stock", icon: "layui-icon-template-1",   color: "linear-gradient(135deg,#ec4899,#8b5cf6)" },
  ];

  function _methodCls(method) {
    const m = String(method || "get").toLowerCase();
    return "m-" + m;   // m-get / m-post / m-put / m-delete
  }

  function _tagToObj(t) {
    if (!t) return null;
    if (typeof t === "string") return { text: t, cls: "tag-norm" };
    if (typeof t === "object" && t.text) return { text: String(t.text), cls: t.cls || "tag-norm" };
    return null;
  }

  function _fmtUpdated(createdAt) {
    const src = createdAt || new Date().toISOString();
    const d = new Date(src);
    if (isNaN(d.getTime())) return src.substring(0, 16).replace("T", " ");
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /**
   * 把 newcase.save 的 payload 转成 apicases.list 项。
   *
   * payload 形如:
   *   { case: {name, method, path, project, desc, state, tags},
   *     headers, params, bodyTab, bodyJson, assertions, vars, createdAt }
   */
  function toListItem(payload, newId) {
    const c = (payload && payload.case) || {};
    const state = c.state || "on";
    const tags = (Array.isArray(c.tags) ? c.tags : []).map(_tagToObj).filter(Boolean);
    /* 协议:socket 用例没有请求方法,方法列统一显示 SOCKET;
       老数据没存 protocol 时也按 socket(平台当前只做 socket) */
    const proto = c.protocol || "socket";
    const method = proto === "socket" ? "SOCKET" : (c.method || "GET");
    return {
      id: newId,
      name: c.name || "(未命名)",
      method: method,
      /* 协议:当前仅 socket;http 用例暂不实现,字段先预留 */
      protocol: proto,
      path: c.path || "",
      project: c.project || "",
      desc: c.desc || "",
      tags: tags,
      hasTags: tags.length > 0,
      state: state,
      /* on=已启用 / off=已停用 / draft=草稿(历史数据) */
      stateLabel: state === "draft" ? "草稿"
                : state === "off"   ? "已停用" : "已启用",
      dotCls: state === "draft" ? "gray"
            : state === "off"   ? "gray"  : "green",
      methodCls: proto === "socket" ? "m-socket" : _methodCls(method),
      /* 文件名默认值(= 用例名):读盘路径由 apicases.init 用真实 file_name 覆盖 */
      file: c.name || "",
      updated: _fmtUpdated(payload.createdAt),
    };
  }

  /**
   * 把 newsuite.save 的 payload 转成 suite 列表项(测试执行页用)。
   * payload 形如:
   *   { suite: {name, project, env, concurrency, retry, timeout},
   *     cases: [{file, name}], caseCount, createdAt }
   */
  function toSuiteItem(payload, newId) {
    const s = (payload && payload.suite) || {};
    const cases = Array.isArray(payload && payload.cases)
      ? payload.cases.length
      : (payload && payload.caseCount) || 0;
    return {
      id: newId,
      name: s.name || "(未命名)",
      cases: cases,
      module: s.project || "",
      env: s.env || "test",
      concurrency: s.concurrency || 1,
      retry: s.retry || 0,
      timeout: s.timeout || 60,
      /* 套件文件名默认 = 套件名;读盘路径由 testrun.init 用真实 file_name 覆盖 */
      file: s.name || "",
      elapsed: _fmtUpdated(payload.createdAt),
      state: "on",
      stateLabel: "就绪",
      icon: "layui-icon-form",
      iconCls: "draft",
    };
  }

  /* 断言比较符(op 值与后端 _compare 对齐)。
     每种断言类型可选的运算符不同:数值型用大小比较,文本型用包含。 */
  const ASSERT_OPS = {
    "状态码":  [
      ["等于", "eq"], ["不等于", "ne"], ["大于", "gt"],
      ["大于等于", "gte"], ["小于", "lt"], ["小于等于", "lte"],
    ],
    "响应时间": [
      ["小于等于", "lte"], ["小于", "lt"], ["大于", "gt"],
      ["大于等于", "gte"], ["等于", "eq"],
    ],
    "JSON":    [
      ["等于", "eq"], ["不等于", "ne"],
      ["包含", "contains"], ["不包含", "not_contains"],
    ],
    "响应头":  [["等于", "eq"], ["包含", "contains"]],
  };

  function opsOfAssertType(type) {
    return ASSERT_OPS[type] || ASSERT_OPS["JSON"];
  }
  function defaultOpOfAssertType(type) {
    return opsOfAssertType(type)[0][1];
  }
  /* 类型切换后校正 op:原 op 不在新类型的可选列表里就回落默认值 */
  function normalizeAssertOp(a) {
    const legal = opsOfAssertType(a.type).some(([, v]) => v === a.op);
    if (!legal) a.op = defaultOpOfAssertType(a.type);
    return a;
  }

  root.PomeloUtils = {
    toListItem: toListItem,
    toSuiteItem: toSuiteItem,
    DEFAULT_MODULES: DEFAULT_MODULES,
    opsOfAssertType: opsOfAssertType,
    defaultOpOfAssertType: defaultOpOfAssertType,
    normalizeAssertOp: normalizeAssertOp,
  };
})(window);
