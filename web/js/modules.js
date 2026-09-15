/* ============================================================
 *  modules.js — 项目模块管理(顶部 tab 的"所属项目" 与 仪表盘"测试项目")
 *  ------------------------------------------------------------
 *    模块数据 schema(持久化):
 *      { modules: [{name, key, icon, color, cases?, status?, createdAt}] }
 *
 *    数据落盘:
 *      - pywebview 桌面模式 → data/modules/modules.json
 *      - 浏览器预览模式     → localStorage["pomelo.modules"]
 *
 *    去重规则:
 *      同名(name)视为同一个模块,add() 重名返 ok=false。
 *    key 派生:
 *      - 若模块名命中 DEFAULT_MODULES,沿用其 key。
 *      - 否则基于 name 做 hash 截短,确保稳定可读。
 * ========================================================== */
(function (root) {
  const DEFAULT_MODULES = root.PomeloUtils ? root.PomeloUtils.DEFAULT_MODULES : [];
  const STORAGE_KEY = "pomelo.modules";
  const CATEGORY = "modules";
  const FILE_NAME = "modules";   // 落到 data/modules/modules.json
  const CATEGORY_CASES = "cases";  // 用例归档根目录:data/cases/{module_key}/

  /* ---------- key 派生 ---------- */
  function _hashKey(name) {
    const s = String(name || "");
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h) + s.charCodeAt(i);
    return "m" + (h >>> 0).toString(36);
  }

  function _pickKey(name, existing) {
    const hit = DEFAULT_MODULES.find((d) => d.name === name);
    if (hit) return hit.key;
    const dup = (existing || []).find((m) => m.name === name && m.key);
    if (dup) return dup.key;
    return _hashKey(name);
  }

  function _pickIcon(name, existing) {
    const hit = DEFAULT_MODULES.find((d) => d.name === name);
    if (hit) return hit.icon;
    const dup = (existing || []).find((m) => m.name === name && m.icon);
    if (dup) return dup.icon;
    return "layui-icon-template";
  }

  function _pickColor(name, existing) {
    const hit = DEFAULT_MODULES.find((d) => d.name === name);
    if (hit) return hit.color;
    const dup = (existing || []).find((m) => m.name === name && m.color);
    if (dup) return dup.color;
    return "linear-gradient(135deg,#64748b,#0ea5e9)";
  }

  function _isValidName(name) {
    return !!(name && String(name).trim().length && String(name).trim().length <= 32);
  }

  /* ---------- 后端:pywebview 模式 ---------- */

  /**
   * ⚠ 关键坑(2026-09 修):pywebview 4.x 之后 window.pywebview.api.* 返回的是
   *   Promise,不是 dict。本文件早期写法直接 `const ret = api.list_json(...)`,
   *   于是 `if (ret && ret.ok)` 里 ret 是 Promise、ret.ok 恒 undefined,
   *   读盘一律被判失败 → list() 回退到写死的 DEFAULT_MODULES,
   *   页面上「测试项目」永远显示 5 个假模块。实装版本 pywebview 6.2.1。
   *
   * Promise.resolve() 对「同步 dict」和「Promise」两种返回都成立,
   * 因此这个包装不绑定具体 pywebview 版本。
   */
  function _callBridge(fn, thisArg) {
    const args = Array.prototype.slice.call(arguments, 2);
    return Promise.resolve(fn.apply(thisArg, args));
  }

  async function _listFromPywebview() {
    const api = root.pywebview && root.pywebview.api;
    if (!api || typeof api.list_json !== "function") return null;
    try {
      const ret = await _callBridge(api.list_json, api, CATEGORY);
      if (ret && ret.ok) {
        const items = ret.items || [];
        // data/modules/modules.json 是单文件,内容形如 {modules: [...]}
        const idx = items.find((it) => it.file_name === FILE_NAME + ".json");
        if (idx && idx.content && Array.isArray(idx.content.modules)) {
          return idx.content.modules.slice();
        }
        return [];
      }
    } catch (_) { /* fallthrough */ }
    return null;
  }

  async function _saveToPywebview(modules) {
    const api = root.pywebview && root.pywebview.api;
    if (!api || typeof api.save_json !== "function") return null;
    try {
      // 同上:必须 await,否则 ret 是 Promise、ret.ok 恒 undefined,
      // 后端其实已经写盘成功,前端却一律报「保存失败」。
      const ret = await _callBridge(api.save_json, api, CATEGORY, FILE_NAME, {
        modules: modules,
      });
      if (ret && ret.ok) return { ok: true, path: ret.path };
      return { ok: false, error: (ret && ret.error) || "保存失败" };
    } catch (e) {
      return { ok: false, error: "pywebview 桥异常: " + (e && e.message) };
    }
  }

  /* ---------- 降级:localStorage ---------- */
  function _listFromLocalStorage() {
    try {
      const raw = root.localStorage && root.localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }

  function _saveToLocalStorage(modules) {
    try {
      if (root.localStorage) {
        root.localStorage.setItem(STORAGE_KEY, JSON.stringify(modules));
        return { ok: true };
      }
      return { ok: false, error: "localStorage 不可用" };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /* ---------- 对外 API ---------- */

  /**
   * 取得当前模块列表。
   * 回退链:
   *   1) pywebview 读盘成功 → 磁盘说了算(空列表就是空,不兜底)
   *   2) localStorage 中有 → 走它(浏览器模式)
   *   3) 返回 [] —— 干净环境(无 data/)显示空态,不再兜底写死的
   *      DEFAULT_MODULES(2026-09-04 改:打包产物首启必须是无数据的
   *      空环境,5 个假模块会误导用户以为数据没清掉)
   */
  async function list() {
    const py = await _listFromPywebview();
    if (Array.isArray(py)) return py;
    const ls = _listFromLocalStorage();
    if (ls.length) return ls;
    return [];
  }

  /**
   * 追加一个模块(同名返回 ok=false)。
   * 不做 trim 前先校验,避免空字符串。
   * @param {string} name
   * @param {Partial<ModuleMeta>=} meta  可选携带额外字段(icon/color)
   * @returns {Promise<{ok, modules, error?, backend, path?}>}
   */
  async function add(name, meta) {
    const clean = String(name || "").trim();
    if (!_isValidName(clean))
      return { ok: false, error: "模块名称不能为空或超过 32 字符" };

    const cur = await list();
    if (cur.some((m) => m.name === clean))
      return { ok: false, error: "模块已存在: " + clean, modules: cur };

    const item = {
      name: clean,
      key:  _pickKey(clean, cur),
      icon: (meta && meta.icon) || _pickIcon(clean, cur),
      color: (meta && meta.color) || _pickColor(clean, cur),
      cases: (meta && meta.cases) || 0,
      status: (meta && meta.status) || "normal",
      statusLabel: (meta && meta.statusLabel) || "● 正常",
      createdAt: new Date().toISOString(),
    };
    const next = cur.concat([item]);

    // 1) 优先 pywebview
    const pyRet = await _saveToPywebview(next);
    if (pyRet && pyRet.ok)
      return { ok: true, modules: next, backend: "pywebview", path: pyRet.path };
    if (pyRet && !pyRet.ok && root.pywebview && root.pywebview.api)
      // pywebview 模式但保存失败:不静默降级,直接报
      return { ok: false, error: pyRet.error, modules: cur };

    // 2) 浏览器降级
    const lsRet = _saveToLocalStorage(next);
    if (lsRet.ok)
      return { ok: true, modules: next, backend: "localStorage" };
    return { ok: false, error: lsRet.error || "localStorage 写入失败", modules: cur };
  }

  /**
   * 用新列表覆盖(用于 init 时的同步)。modules 为 null/[] 视为忽略。
   */
  async function save(modules) {
    if (!Array.isArray(modules)) return { ok: false, error: "modules 必须为数组" };

    const py = await _saveToPywebview(modules);
    if (py && py.ok)
      return { ok: true, modules, backend: "pywebview", path: py.path };
    if (py && !py.ok && root.pywebview && root.pywebview.api)
      return { ok: false, error: py.error };

    const ls = _saveToLocalStorage(modules);
    if (ls.ok)
      return { ok: true, modules, backend: "localStorage" };
    return { ok: false, error: ls.error };
  }

  /**
   * 删除一个模块(按 name 定位,内部换算成 key 去删目录)。
   *
   * 两段式:必须先 dryRun 拿清单给人看,再 dryRun:false 真删。
   *   第一次: remove("支付中心", {withCases:true})            → 只回清单,磁盘不动
   *   第二次: remove("支付中心", {withCases:true, dryRun:false}) → 真删目录 + 落盘新列表
   *
   * 关键约束:只有 dryRun === false 才会把剔除后的列表 save() 落盘。
   * 预览阶段绝不动 modules.json,避免"看了一眼清单模块就没了"。
   *
   * @param {string} name  模块显示名(不是 key)
   * @param {{withCases?: boolean, dryRun?: boolean}=} opts
   *        withCases 为 true 时连带删除 data/cases/{key}/ 整个目录
   * @returns {Promise<{ok, modules, key?, files?, count?, dry_run, error?, backend?}>}
   */
  async function remove(name, opts) {
    const clean = String(name || "").trim();
    if (!clean) return { ok: false, error: "模块名称不能为空", dry_run: true };

    const o = opts || {};
    const dry = o.dryRun === undefined ? true : !!o.dryRun;
    const withCases = !!o.withCases;

    const cur = await list();
    const hit = cur.filter((m) => m.name === clean)[0];
    if (!hit)
      return { ok: false, error: "模块不存在: " + clean, modules: cur, dry_run: dry };

    const key = String(hit.key || "");
    let files = [];
    let count = 0;
    let dirInfo = "";

    /* 1) 用例目录:预览取清单,真删才落地 */
    if (withCases && key && root.PomeloStorage &&
        typeof root.PomeloStorage.deleteModuleDir === "function") {
      const d = await root.PomeloStorage.deleteModuleDir(CATEGORY_CASES, key, dry);
      if (d && !d.ok)
        return {
          ok: false,
          error: d.error || "删除用例目录失败",
          modules: cur,
          key: key,
          sub_dirs: d.sub_dirs || [],
          dry_run: dry,
        };
      files = (d && d.files) || [];
      count = (d && d.count) || 0;
      dirInfo = (d && d.dir) || "";
    }

    /* 2) 预览到此为止 — 模块列表原样返回,调用方拿 files/count 去弹窗 */
    if (dry)
      return {
        ok: true, dry_run: true, modules: cur,
        key: key, files: files, count: count, dir: dirInfo,
      };

    /* 3) 真删:剔除后落盘 */
    const next = cur.filter((m) => m.name !== clean);
    const ret = await save(next);
    if (!ret || !ret.ok)
      return {
        ok: false,
        error: (ret && ret.error) || "模块列表写入失败",
        modules: cur, key: key, dry_run: false,
      };

    return {
      ok: true, dry_run: false, modules: next,
      key: key, files: files, count: count, dir: dirInfo,
      backend: ret.backend,
    };
  }

  /**
   * 修改模块名(改名保留 key/icon/color/createdAt,落盘新列表)。
   * ⚠ key 不变 → data/cases/{key}/ 目录位置不动,只改显示名;
   *   用例内容里的 case.project、套件 suite.project 由调用方(apicases)级联更新。
   * @param {string} oldName 原模块显示名
   * @param {string} newName 新模块显示名
   * @returns {Promise<{ok, modules, key?, oldName?, newName?, error?}>}
   */
  async function rename(oldName, newName) {
    const old = String(oldName || "").trim();
    const clean = String(newName || "").trim();
    if (!old) return { ok: false, error: "缺少原模块名" };
    if (!_isValidName(clean))
      return { ok: false, error: "模块名称不能为空或超过 32 字符" };
    if (clean === old) return { ok: true, modules: await list(), key: "", unchanged: true };

    const cur = await list();
    const hit = cur.filter((m) => m.name === old)[0];
    if (!hit) return { ok: false, error: "模块不存在: " + old };
    if (cur.some((m) => m.name === clean))
      return { ok: false, error: "已存在同名模块: " + clean };

    /* 不改入参对象,构造新列表(petite-vue 赋新数组才触发重渲) */
    const next = cur.map((m) =>
      m.name === old ? Object.assign({}, m, { name: clean }) : m);
    const ret = await save(next);
    if (!ret || !ret.ok)
      return { ok: false, error: (ret && ret.error) || "模块列表写入失败" };
    return { ok: true, modules: next, key: hit.key, oldName: old, newName: clean,
             backend: ret.backend };
  }

  root.PomeloModules = {
    list: list,
    add: add,
    save: save,
    remove: remove,
    rename: rename,
    DEFAULT_MODULES: DEFAULT_MODULES,
  };
})(window);
