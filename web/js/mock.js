/* ============================================================
 *  Pomelo Mock 数据中心
 *  - 所有页面所需的静态数据均在此文件提供
 *  - 真实场景下替换为 fetch('/api/...') 即可,API 约定:
 *      { code: 0, result: { data: [...], total: 123 } }
 * ========================================================== */
window.PomeloMock = (function () {

  /* ---------- 通用工具 ---------- */
  const today = new Date();
  const fmtDate = (d = new Date()) => {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const minAgo = (n) => fmtDate(new Date(Date.now() - n * 60 * 1000));

  /* ============================================================
   *  1) 仪表盘
   *  注:模板中不做 Math 运算 / 三元比较(避免 with(scope) 求值歧义),
   *     故预先计算 absTrend(绝对值)、trendDir(up/down)、trendIcon(箭头图标)。
   * ========================================================== */
  const rawStats = [
    { label: "测试项目",    value: 8,      trend: 12.5, sub: "较上月增长 1 个项目",
      icon: "layui-icon-template",  bg: "linear-gradient(135deg,#6366f1,#8b5cf6)" },
    { label: "接口用例",    value: "1,286", trend:  8.3, sub: "覆盖 8 个测试项目",
      icon: "layui-icon-link",      bg: "linear-gradient(135deg,#06b6d4,#3b82f6)" },
    { label: "本周执行次数", value: "3,842", trend: 32.1, sub: "较上周增长 715 次",
      icon: "layui-icon-play",      bg: "linear-gradient(135deg,#10b981,#22c55e)" },
    { label: "测试通过率",  value: "96.8%", trend:  2.1, sub: "本周 3,718 / 3,842 通过",
      icon: "layui-icon-ok-circle", bg: "linear-gradient(135deg,#f59e0b,#ef4444)" },
  ];
  const dashboard = {
    stats: rawStats.map((s) => Object.assign({}, s, {
      absTrend:  Math.abs(s.trend),
      trendDir:  s.trend > 0 ? "up" : "down",
      trendIcon: s.trend > 0 ? "layui-icon-up" : "layui-icon-down",
    })),
    trend: {
      categories: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
      passed:   [740, 780, 690, 820, 760, 810, 850],
      failed:   [120, 195, 100, 230, 110, 200, 290],
      skipped:  [60,  85,  50,  120, 70,  100, 130],
    },
    rate: { passed: 3718, failed: 86, skipped: 38, percent: 96.8 },
    // icon: 由 status 预映射(模板中不做嵌套三元)
    runs: [
      { id: 1, title: "用户服务接口全量回归", reportNo: "202401115",
        env: "测试环境", executor: "张伟",
        total: 250, passed: 245, failed: 3, skipped: 2,
        duration: "2 分钟", status: "pass", icon: "layui-icon-ok" },
      { id: 2, title: "订单服务接口冒烟测试", reportNo: "202401114",
        env: "订单中心", executor: "李娜",
        total: 137, passed: 128, failed: 8, skipped: 1,
        duration: "35 分钟", status: "fail", icon: "layui-icon-close" },
      { id: 3, title: "支付网关接口全量回归", reportNo: "202401113",
        env: "支付中心", executor: "王强",
        total: 194, passed: 189, failed: 0, skipped: 5,
        duration: "1 小时", status: "pass", icon: "layui-icon-ok" },
      { id: 4, title: "商品服务接口冒烟测试", reportNo: "202401112",
        env: "商品中心", executor: "赵敏",
        total: 98, passed: 96, failed: 2, skipped: 0,
        duration: "3 小时", status: "fail", icon: "layui-icon-close" },
      { id: 5, title: "库存服务接口全量回归", reportNo: "202401111",
        env: "库存中心", executor: "张伟",
        total: 160, passed: 156, failed: 1, skipped: 3,
        duration: "昨天 18:30", status: "skip", icon: "layui-icon-pause" },
    ],
    projects: [
      { id: 1, name: "用户中心",   cases: 250,  status: "normal", statusLabel: "● 正常", icon: "layui-icon-user",  bg: "linear-gradient(135deg,#6366f1,#8b5cf6)" },
      { id: 2, name: "订单中心",   cases: 188,  status: "danger", statusLabel: "● 危险", icon: "layui-icon-cart",  bg: "linear-gradient(135deg,#ef4444,#f59e0b)" },
      { id: 3, name: "支付中心",   cases: 194,  status: "normal", statusLabel: "● 正常", icon: "layui-icon-rmb",   bg: "linear-gradient(135deg,#10b981,#06b6d4)" },
      { id: 4, name: "商品中心",   cases: 98,   status: "danger", statusLabel: "● 危险", icon: "layui-icon-gift",  bg: "linear-gradient(135deg,#f59e0b,#ef4444)" },
      { id: 5, name: "库存中心",   cases: 160,  status: "normal", statusLabel: "● 正常", icon: "layui-icon-template-1", bg: "linear-gradient(135deg,#ec4899,#8b5cf6)" },
      { id: 6, name: "营销中心",   cases: 124,  status: "normal", statusLabel: "● 正常", icon: "layui-icon-notice", bg: "linear-gradient(135deg,#3b82f6,#8b5cf6)" },
      { id: 7, name: "会员中心",   cases: 76,   status: "warn", statusLabel: "● 异常",   icon: "layui-icon-diamond", bg: "linear-gradient(135deg,#06b6d4,#10b981)" },
      { id: 8, name: "数据中心",   cases: 196,  status: "normal", statusLabel: "● 正常", icon: "layui-icon-database",bg:"linear-gradient(135deg,#64748b,#0ea5e9)" },
    ],
  };

  /* ============================================================
   *  2) 接口用例
   * ========================================================== */
  const apicases = {
    tabs: [
      { key: "all",     label: "全部用例" },
      { key: "user",    label: "用户中心" },
      { key: "order",   label: "订单中心" },
      { key: "pay",     label: "支付中心" },
      { key: "goods",   label: "商品中心" },
      { key: "stock",   label: "库存中心" },
    ],
    // dotCls / methodCls: 由 state、method 预映射(模板中不做三元)
    list: [
      { id: 1, name: "获取用户信息",     method: "GET",    path: "/api/v1/users/{id}",        project: "用户中心", tags: [{text:"核心",cls:"tag-core"},{text:"常服",cls:"tag-norm"}], state: "on", stateLabel: "已启用",  dotCls: "green", methodCls: "m-get",    updated: "2024-01-15 14:30" },
      { id: 2, name: "创建用户",         method: "POST",   path: "/api/v1/users",             project: "用户中心", tags: [{text:"核心",cls:"tag-core"}], state: "on", stateLabel: "已启用", dotCls: "green", methodCls: "m-post",   updated: "2024-01-15 13:45" },
      { id: 3, name: "更新用户信息",     method: "PUT",    path: "/api/v1/users/{id}",        project: "用户中心", tags: [{text:"核心",cls:"tag-core"},{text:"删除",cls:"tag-danger"}], state: "on", stateLabel: "已启用", dotCls: "green", methodCls: "m-put",    updated: "2024-01-14 18:20" },
      { id: 4, name: "删除用户",         method: "DELETE", path: "/api/v1/users/{id}",        project: "用户中心", tags: [], state: "draft", stateLabel: "草稿", dotCls: "gray",  methodCls: "m-delete", updated: "2024-01-14 16:10" },
      { id: 5, name: "创建订单",         method: "POST",   path: "/api/v1/orders",            project: "订单中心", tags: [{text:"核心",cls:"tag-core"},{text:"常服",cls:"tag-norm"}], state: "on", stateLabel: "已启用", dotCls: "green", methodCls: "m-post",   updated: "2024-01-14 15:30" },
      { id: 6, name: "查询订单列表",     method: "GET",    path: "/api/v1/orders?status=all", project: "订单中心", tags: [{text:"常服",cls:"tag-norm"}], state: "on", stateLabel: "已启用", dotCls: "green", methodCls: "m-get",    updated: "2024-01-13 11:20" },
      { id: 7, name: "发起支付",         method: "POST",   path: "/api/v1/payments",          project: "支付中心", tags: [{text:"核心",cls:"tag-core"}], state: "on", stateLabel: "已启用", dotCls: "green", methodCls: "m-post",   updated: "2024-01-13 10:45" },
      { id: 8, name: "查询支付状态",     method: "GET",    path: "/api/v1/payments/{id}?status", project: "支付中心", tags: [{text:"删除",cls:"tag-danger"}], state: "on", stateLabel: "已启用", dotCls: "green", methodCls: "m-get",    updated: "2024-01-12 17:30" },
      { id: 9, name: "添加商品到购物车", method: "POST",   path: "/api/v1/cart/items",        project: "商品中心", tags: [{text:"常服",cls:"tag-norm"}], state: "on", stateLabel: "已启用", dotCls: "green", methodCls: "m-post",   updated: "2024-01-12 14:15" },
      { id:10, name: "查询商品详情",     method: "GET",    path: "/api/v1/products/{id}",     project: "商品中心", tags: [{text:"核心",cls:"tag-core"}], state: "on", stateLabel: "已启用", dotCls: "green", methodCls: "m-get",    updated: "2024-01-11 16:40" },
    ],
  };

  /* ============================================================
   *  3) 用例详情(获取用户信息)
   * ========================================================== */
  const apidetail = {
    case: {
      name: "获取用户信息", method: "GET", path: "/api/v1/users/{id}",
      project: "用户中心",
      desc: "验证通过用户 ID 获取用户基本信息的接口功能,包括正常返回、用户不存在、参数错误等场景。",
    },
    headers: [
      { key: "Content-Type",  value: "application/json" },
      { key: "Authorization", value: "Bearer {{token}}" },
      { key: "X-Request-Id",  value: "{{request_id}}" },
    ],
    params: [
      { key: "include", value: "profile,address" },
      { key: "fields",  value: "id,name,email,phone" },
    ],
    bodyJson: `{
  "id": "{{user_id}}",
  "include": ["profile", "address"]
}`,
    bodyTab: "json",
    assertions: [
      { type: "状态码",   cls: "status",  value: "等于 200" },
      { type: "JSON",    cls: "json",    value: 'data.name 等于 "张三"' },
      { type: "响应时间", cls: "time",    value: "小于 500ms" },
      { type: "响应头",   cls: "header",  value: "Content-Type 必须为 json" },
    ],
    // display 预拼好 {{xxx}} 字面量,避免在模板 mustache 内再嵌套 {{ }}
    vars: [
      { key: "user_id",    display: "{{user_id}}",    hint: "从登录接口中提取",   cls: "ok" },
      { key: "token",      display: "{{token}}",      hint: "从登录接口中提取",   cls: "ok" },
      { key: "request_id", display: "{{request_id}}", hint: "随机生成的请求 ID",  cls: "ok" },
    ],
  };

  /* ============================================================
   *  4) 测试执行
   * ========================================================== */
  const testrun = {
    suites: [
      { id: 1, name: "用户服务全量回归", cases: 250, module: "用户中心", elapsed: "2 分钟前", state: "on", stateLabel: "通过", icon: "layui-icon-user",  iconCls: "user" },
      { id: 2, name: "订单服务冒烟测试", cases: 137, module: "订单中心", elapsed: "35 分钟前", state: "draft", stateLabel: "失败", icon: "layui-icon-cart",  iconCls: "cart" },
      { id: 3, name: "支付网关全量回归", cases: 194, module: "支付中心", elapsed: "1 小时前", state: "on", stateLabel: "通过", icon: "layui-icon-rmb",   iconCls: "pay" },
      { id: 4, name: "商品服务冒烟测试", cases: 98,  module: "商品中心", elapsed: "3 小时前", state: "on", stateLabel: "通过", icon: "layui-icon-gift",  iconCls: "goods" },
      { id: 5, name: "库存服务全量回归", cases: 160, module: "库存中心", elapsed: "昨天 18:30", state: "skip", stateLabel: "跳过", icon: "layui-icon-template-1", iconCls: "stock" },
      { id: 6, name: "全链路核心流程",  cases: 85,  module: "营销中心", elapsed: "昨天 18:00", state: "on", stateLabel: "通过", icon: "layui-icon-link",  iconCls: "core" },
    ],
    envs: [
      { key: "test",  label: "测试环境",   color: "#3b82f6" },
      { key: "pre",   label: "预发布环境", color: "#f59e0b" },
      { key: "prod",  label: "生产环境",   color: "#ef4444" },
    ],
    retries: [
      { value: 0, label: "不要试" },
      { value: 1, label: "重试 1 次" },
      { value: 2, label: "重试 2 次" },
      { value: 3, label: "重试 3 次" },
    ],
    timeouts: [
      { value: 30, label: "30 秒" },
      { value: 60, label: "60 秒" },
      { value: 120, label: "120 秒" },
    ],
    activeSuite: 1,
    env: "test", concurrency: 10, retry: 1, timeout: 60,
    progress: {
      done: 156, total: 250, percent: 62.4,
      passed: 148, failed: 5, skipped: 3,
      duration: "02:45",
    },
    logs: [
      "[14:12:05] ▶ test_get_user_info - 通过 (128ms)",
      "[14:12:06] ✓ test_create_user - 通过 (256ms)",
      "[14:12:08] ✗ test_update_user - 失败 (312ms) - 断言失败:期望 200,实际 500",
      "[14:12:10] ✓ test_delete_user - 通过 (98ms)",
      "[14:12:12] ✓ test_get_user_list - 通过 (145ms)",
      "[14:12:12] ⊙ test_login_user - 执行中...",
    ],
  };

  /* ============================================================
   *  5) 测试报告
   * ========================================================== */
  const reports = {
    summary: {
      total: 250, passed: 245, failed: 3, skipped: 2,
      duration: "04:32",
      passRate: 98.0, failRate: 1.2,
    },
    failures: [
      { id: 1, name: "test_update_user",          reason: "断言失败:期望 200,实际 500" },
      { id: 2, name: "test_delete_user",          reason: "请求超时:超过 60s" },
      { id: 3, name: "test_get_user_list",        reason: "JSON 解析失败:响应格式异常" },
    ],
    // dotCls: 状态圆点颜色 | rateCls: 通过率文字配色(均由 state 预映射)
    history: [
      { id: 1, name: "用户服务全量回归 #202401115", module: "用户服务全量回归", state: "pass", stateLabel: "通过", stateIcon: "pass", dotCls: "green", rateCls: "rate--ok",   passRate: 98.0, duration: "04:32", executedAt: "2024-01-15 14:30" },
      { id: 2, name: "订单服务冒烟测试 #202401115", module: "订单服务冒烟测试", state: "fail", stateLabel: "失败", stateIcon: "fail", dotCls: "red",   rateCls: "rate--warn", passRate: 93.4, duration: "03:18", executedAt: "2024-01-15 13:45" },
      { id: 3, name: "支付网关全量回归 #202401115", module: "支付网关全量回归", state: "pass", stateLabel: "通过", stateIcon: "pass", dotCls: "green", rateCls: "rate--ok",   passRate: 97.4, duration: "03:45", executedAt: "2024-01-15 12:30" },
      { id: 4, name: "商品服务冒烟测试 #202401115", module: "商品服务冒烟测试", state: "pass", stateLabel: "通过", stateIcon: "pass", dotCls: "green", rateCls: "rate--ok",   passRate: 98.0, duration: "02:15", executedAt: "2024-01-15 11:00" },
      { id: 5, name: "库存服务全量回归 #202401114", module: "库存服务全量回归", state: "fail", stateLabel: "失败", stateIcon: "warn", dotCls: "red",   rateCls: "rate--warn", passRate: 97.5, duration: "03:02", executedAt: "2024-01-14 18:30" },
      { id: 6, name: "订单服务全量回归 #202401114", module: "订单服务全量回归", state: "pass", stateLabel: "通过", stateIcon: "pass", dotCls: "green", rateCls: "rate--ok",   passRate: 96.2, duration: "05:18", executedAt: "2024-01-14 16:45" },
      { id: 7, name: "支付网关冒烟测试 #202401114", module: "支付网关冒烟测试", state: "pass", stateLabel: "通过", stateIcon: "pass", dotCls: "green", rateCls: "rate--ok",   passRate: 99.1, duration: "01:55", executedAt: "2024-01-14 15:20" },
    ],
  };

  /* ============================================================
   *  6) 用例执行详情
   * ========================================================== */
  const reportdetail = {
    reportNo: "202401115",
    stats: { total: 250, passed: 245, failed: 3, skipped: 2, duration: "04:32" },
    filters: [
      { key: "all",   label: "全量状态" },
      { key: "pass",  label: "通过" },
      { key: "fail",  label: "失败" },
      { key: "skip",  label: "跳过" },
    ],
    activeFilter: "all",
    cases: [
      { id: 1, name: "test_get_user_info",     state: "pass", stateLabel: "通过", duration: "128ms", path: "GET /api/v1/users/{id}",    reason: "-",                dotCls: "green" },
      { id: 2, name: "test_create_user",       state: "pass", stateLabel: "通过", duration: "256ms", path: "POST /api/v1/users",       reason: "-",                dotCls: "green" },
      { id: 3, name: "test_update_user",       state: "fail", stateLabel: "失败", duration: "312ms", path: "PUT /api/v1/users/{id}",    reason: "断言失败:期望 200,实际 500", dotCls: "red" },
      { id: 4, name: "test_delete_user",       state: "fail", stateLabel: "失败", duration: "60.2s", path: "DELETE /api/v1/users/{id}", reason: "请求超时:超过 60s", dotCls: "red" },
      { id: 5, name: "test_get_user_list",     state: "fail", stateLabel: "失败", duration: "145ms", path: "GET /api/v1/users",         reason: "JSON 解析失败:响应格式异常", dotCls: "red" },
      { id: 6, name: "test_login_user",        state: "pass", stateLabel: "通过", duration: "98ms",  path: "POST /api/v1/auth/login",   reason: "-",                dotCls: "green" },
      { id: 7, name: "test_logout_user",       state: "pass", stateLabel: "通过", duration: "76ms",  path: "POST /api/v1/auth/logout",  reason: "-",                dotCls: "green" },
      { id: 8, name: "test_get_user_profile",  state: "pass", stateLabel: "通过", duration: "112ms", path: "GET /api/v1/users/{id}/profile", reason: "-",          dotCls: "green" },
      { id: 9, name: "test_update_user_profile",state:"pass", stateLabel: "通过", duration: "189ms", path: "PUT /api/v1/users/{id}/profile", reason: "-",          dotCls: "green" },
      { id:10, name: "test_get_user_address",  state: "skip", stateLabel: "跳过", duration: "-",     path: "GET /api/v1/users/{id}/address", reason: "依赖用例未跑", dotCls: "orange" },
    ],
    activeCase: 3,
    /* 抽屉默认关闭,由 reportdetail.openCase() 打开。
       注意:下面的 current 只是【首屏兜底快照】,组件里的 current 是 getter,
       会按 activeCase 从 cases 里实时取值,点击用例行才会真正联动。 */
    caseOpen: false,
    current: {
      name: "test_update_user", method: "PUT /api/v1/users/{id}",
      duration: "耗时 312ms", executedAt: "2024-01-15 14:22:08",
      detail: '期待值 {"code": 500, "message": "Internal Server Error"}',
      headers: [
        { key: "Content-Type",  value: "application/json" },
        { key: "Authorization", value: "Bearer eyJhbGciOiJIUzI1N..." },
        { key: "X-Request-Id",  value: "87fab28c-9d4e-5f8a-7b8c-5d8ccf2a5b4c" },
      ],
    },
  };

  /* ---------- 暴露 ---------- */
  return { dashboard, apicases, apidetail, testrun, reports, reportdetail };
})();
