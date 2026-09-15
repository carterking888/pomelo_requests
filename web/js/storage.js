/* ============================================================
 *  storage.js — 前端保存到本地 JSON 的统一入口
 *  ------------------------------------------------------------
 *  设计要点:
 *    1. 同时支持两种运行环境:
 *       - pywebview 桌面模式: window.pywebview.api.save_json
 *       - 纯浏览器预览模式:  没有 Python 桥,降级为 in-memory + console
 *    2. 不管哪种后端,调用方拿到的都是同一种 Promise<{ok, path, error, backend}>
 *    3. 失败也要 resolve(不 reject),由调用方根据 ok 字段判断 —— 避免 try/catch
 *       嵌套太深
 *    4. 模块归档(2026-09):所有接口都多带一个 module 参数,对应磁盘上的
 *       data/{category}/{module}/{name}.json。module 传空 → 落回
 *       data/{category}/ 根目录(旧行为,历史数据继续可读)。
 *       module 用的是模块 key(纯 ASCII,由 modules.js 的 djb2 派生),不是中文名。
 *  ------------------------------------------------------------
 *  调用方式:
 *    const r = await window.PomeloStorage.saveJson('cases', '登录测试', {a:1}, 'user');
 *    if (r.ok) console.log('已保存到', r.path);
 *    else toast(r.error, 'error');
 *
 *    // 跨模块全量读取(含未归档的历史平铺数据)
 *    const l = await window.PomeloStorage.listJson('cases', { recursive: true });
 * ========================================================== */

(function (root) {
  // in-memory 降级:浏览器预览模式下,保存的 JSON 暂存在这里,
  // 用 window.PomeloStorage._memory[category] 数组查看
  const _memory = {};  // { cases: [ {name, module, content, savedAt} ], suites: [...] }

  // 目录段净化:与 pomelo_app.py 的 _SEG_RE 保持一致(A-Za-z0-9_-,1~32 位)。
  // 非法 → 返回 "",等价于"不归档,落 category 根目录"。
  function _seg(v) {
    const s = String(v == null ? "" : v).trim();
    if (!s) return "";
    return /^[A-Za-z0-9_\-]{1,32}$/.test(s) ? s : "";
  }

  /**
   * 统一调用 pywebview 桥。
   *
   * ⚠ 关键坑(2026-09 修):pywebview 4.x 之后 window.pywebview.api.* 返回的是
   *   Promise,不是 dict。本文件早期注释写反了("pywebview 把 dict 直接 return"),
   *   导致 `if (ret && ret.ok)` 里 ret 是 Promise、ret.ok 恒 undefined,
   *   所有读盘/写盘一律被判为失败 —— 前端因此回退到写死数据。
   *   实装版本 pywebview 6.2.1。
   *
   * Promise.resolve() 对「同步 dict」和「Promise」两种返回都成立,
   * 因此这个包装不绑定具体 pywebview 版本。
   */
  function _callBridge(fn, thisArg) {
    const args = Array.prototype.slice.call(arguments, 2);
    return Promise.resolve(fn.apply(thisArg, args));
  }

  /**
   * 保存 JSON。category 必须是 ASCII,内部再做一次保险;name 与 content 任意。
   * @param {string} category  'cases' | 'suites' | 自定义
   * @param {string} name      文件名(后缀 .json 自动补);空则用时间戳
   * @param {object|string} content 任意可序列化对象
   * @param {string=} module   模块 key(可选)。空 → 落 category 根目录
   * @returns {Promise<{ok:boolean, path?:string, error?:string, backend:string}>}
   */
  async function saveJson(category, name, content, module) {
    const mod = _seg(module);

    // 1) 桥存在 → 走 Python 端(真实落盘)
    const api = root.pywebview && root.pywebview.api;
    if (api && typeof api.save_json === "function") {
      try {
        const ret = await _callBridge(api.save_json, api,
                                      category || "", name || "", content, mod);
        if (ret && ret.ok) {
          return { ok: true, path: ret.path, bytes: ret.bytes,
                   category: ret.category, module: ret.module || "",
                   name: ret.name, backend: "pywebview" };
        }
        return { ok: false, error: (ret && ret.error) || "未知错误",
                 backend: "pywebview" };
      } catch (e) {
        // pywebview 桥本身抛异常(打包/权限问题)
        return { ok: false, error: "pywebview 桥异常: " + (e && e.message),
                 backend: "pywebview" };
      }
    }

    // 2) 降级:浏览器预览,只放内存 + 打日志
    const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
    const safeName = (String(name || "").trim() || "untitled_" + ts)
                      .replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_");
    const key = String(category || "default");
    _memory[key] = _memory[key] || [];
    _memory[key].push({
      name: safeName + ".json",
      module: mod,          // 内存态也记归属模块,保证 listJson 能按模块过滤
      content: content,
      savedAt: new Date().toISOString(),
    });
    // 同步给控制台,方便开发期复制
    try {
      const payload = typeof content === "string"
        ? content
        : JSON.stringify(content, null, 2);
      const where = key + "/" + (mod ? mod + "/" : "") + safeName;
      console.log("[PomeloStorage] 降级保存 (浏览器预览,未真实落盘) ->", where);
      console.log(payload);
    } catch (_) { /* 序列化失败但不影响 in-memory 记录 */ }

    return { ok: true,
             path: "(memory) " + key + "/" + (mod ? mod + "/" : "") + safeName + ".json",
             bytes: 0, category: key, module: mod,
             name: safeName, backend: "memory" };
  }

  /**
   * 仅供调试/演示:返回当前内存里保存过的所有项
   */
  function listMemory() { return _memory; }

  /**
   * 列出已落盘的 JSON。
   *   listJson('cases')                        → 只读 data/cases/*.json(未归档的历史平铺数据)
   *   listJson('cases', {module:'user'})       → 只读 data/cases/user/*.json
   *   listJson('cases', {recursive:true})      → 读根目录 + 所有一层子目录(全量,推荐)
   *
   * @param {string} category  'cases' / 'suites' / 'modules' 等
   * @param {{module?:string, recursive?:boolean}=} opts
   * @returns {Promise<{ok, items:[{file_name, module, content}], error, backend}>}
   */
  async function listJson(category, opts) {
    const mod = _seg(opts && opts.module);
    const recursive = !!(opts && opts.recursive);

    const api = root.pywebview && root.pywebview.api;
    // 1) 桥存在:走 Python 端 list_json,真实读盘
    if (api && typeof api.list_json === "function") {
      try {
        const ret = await _callBridge(api.list_json, api,
                                      category || "", mod, recursive);
        if (ret && ret.ok) {
          return { ok: true, items: ret.items || [],
                   category: ret.category, module: ret.module || "",
                   recursive: recursive, backend: "pywebview" };
        }
        return { ok: false, error: (ret && ret.error) || "未知错误",
                 backend: "pywebview" };
      } catch (e) {
        return { ok: false, error: "pywebview 桥异常: " + (e && e.message),
                 backend: "pywebview" };
      }
    }

    // 2) 浏览器降级:从 in-memory 取(saveJson 写过的所有项)。
    //    注:这是浏览器预览模式,不持久化,跨刷新会丢;真数据请用 pywebview。
    let bucket = (category && _memory[category]) || [];
    // recursive=true → 不过滤(等价于全量);否则按 module 精确匹配(空 = 未归档项)
    if (!recursive) bucket = bucket.filter((b) => (b.module || "") === mod);
    return {
      ok: true,
      items: bucket.map((b) => ({
        file_name: b.name,
        module: b.module || "",
        content: b.content,
      })),
      category: category,
      module: mod,
      recursive: recursive,
      backend: "memory",
    };
  }

  /**
   * 删除 data/{category}/{module}/{name}.json。
   * 用于行级删除 / 误保存修正。name 不存在时返 ok=true 且 found=false(幂等)。
   * module 传空 → 只找 category 根目录;module 非空 → 先找模块目录,
   * 未命中再回落根目录(兼容归档前保存的历史用例)。
   */
  async function deleteJson(category, name, module) {
    const mod = _seg(module);

    const api = root.pywebview && root.pywebview.api;
    if (api && typeof api.delete_json === "function") {
      try {
        const ret = await _callBridge(api.delete_json, api,
                                     category || "", name || "", mod);
        if (ret && ret.ok) {
          return { ok: true, path: ret.path, found: !!ret.found,
                   backend: "pywebview" };
        }
        return { ok: false, error: (ret && ret.error) || "未知错误",
                 backend: "pywebview" };
      } catch (e) {
        return { ok: false, error: "pywebview 桥异常: " + (e && e.message),
                 backend: "pywebview" };
      }
    }

    // 浏览器降级:从 in-memory 删除(同名不限模块,内存态不需要那么讲究)
    const bucket = (category && _memory[category]) || [];
    const idx = bucket.findIndex((b) => b.name === (name || "") + ".json");
    if (idx > -1) bucket.splice(idx, 1);
    return { ok: true, found: idx > -1, backend: "memory" };
  }

  /**
   * 删除整个模块目录 data/{category}/{module}/ 及其下的 *.json。
   *
   * 两阶段协议(破坏性操作,默认只算不删):
   *   1) dryRun=true (默认) → 只返回将被删除的清单 {files, count},磁盘不动
   *   2) dryRun=false       → 真删。若目录里有意外子目录,直接 ok=false 中止,
   *                           并把 sub_dirs 回传,交人工判断(不做递归 rmtree)
   *
   * @param {string} category
   * @param {string} module   模块 key,必填且必须合法(空值会被 Python 端拒绝)
   * @param {boolean=} dryRun 默认 true
   * @returns {Promise<{ok, exists, dry_run, deleted, dir, files, count, sub_dirs?, error?, backend}>}
   */
  async function deleteModuleDir(category, module, dryRun) {
    const mod = _seg(module);
    const dry = dryRun === undefined ? true : !!dryRun;

    const api = root.pywebview && root.pywebview.api;
    if (api && typeof api.delete_module_dir === "function") {
      try {
        const ret = await _callBridge(api.delete_module_dir, api,
                                     category || "", mod, dry);
        if (ret && ret.ok) {
          return { ok: true, exists: !!ret.exists, dry_run: !!ret.dry_run,
                   deleted: !!ret.deleted, dir: ret.dir,
                   files: ret.files || [], count: ret.count || 0,
                   sub_dirs: ret.sub_dirs || [], removed: ret.removed || [],
                   category: ret.category, module: ret.module,
                   backend: "pywebview" };
        }
        return { ok: false, error: (ret && ret.error) || "未知错误",
                 sub_dirs: (ret && ret.sub_dirs) || [],
                 backend: "pywebview" };
      } catch (e) {
        return { ok: false, error: "pywebview 桥异常: " + (e && e.message),
                 backend: "pywebview" };
      }
    }

    // 浏览器降级:内存态没有真实目录,按 module 字段清一遍即可
    const bucket = (category && _memory[category]) || [];
    const hit = bucket.filter((b) => (b.module || "") === mod && mod);
    const files = hit.map((b) => b.name);
    if (!dry && mod) {
      _memory[category] = bucket.filter((b) => (b.module || "") !== mod);
    }
    return { ok: true, exists: files.length > 0, dry_run: dry,
             deleted: !dry && !!mod, dir: "(memory) " + category + "/" + mod,
             files: files, count: files.length, sub_dirs: [],
             category: category, module: mod, backend: "memory" };
  }

  root.PomeloStorage = {
    saveJson: saveJson,
    listJson: listJson,
    deleteJson: deleteJson,
    deleteModuleDir: deleteModuleDir,
    listMemory: listMemory,
  };
})(window);
