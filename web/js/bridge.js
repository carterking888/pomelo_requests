/* ============================================================
 *  bridge.js — 局域网访问的桥接层
 *  ------------------------------------------------------------
 *  背景:
 *    桌面窗口里前端靠 window.pywebview.api 调用 Python(JsApi)。
 *    局域网其他电脑用浏览器打开时**没有这个桥**,若不处理,storage.js
 *    会静默降级成"内存模式"——界面能看,但读不到真实数据、执行也没反应。
 *
 *  做法:
 *    非本机访问(location.hostname 不是 127.0.0.1/localhost)时,在这里
 *    伪造一个 window.pywebview.api,把任意方法调用转发到 POST /api/rpc;
 *    执行日志则通过 GET /api/events(SSE)接收,转投给 testrun.onRunEvent。
 *    这样上层所有既有代码(含 PomeloStorage)无需任何改动。
 *
 *  注意:
 *    - 本机(桌面窗口)直接返回,等真正的 pywebview 桥注入,绝不覆盖;
 *    - 本机浏览器打开 http://127.0.0.1:<port> 也走原逻辑(内存降级)。
 * ========================================================== */

(function (root) {
  "use strict";

  var host = (root.location && root.location.hostname) || "";
  var isLocal = (host === "127.0.0.1" || host === "localhost"
                 || host === "::1" || host === "[::1]");
  if (isLocal) return;   // 桌面窗口:保持 pywebview 原生桥

  /* ---------- HTTP RPC:替代 pywebview.api ---------- */
  function rpc(method, args) {
    return fetch("/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: method, args: args || [] }),
    }).then(function (resp) {
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return resp.json();
    }).then(function (data) {
      if (!data || data.ok !== true)
        throw new Error((data && data.error) || "调用失败");
      return data.result;
    });
  }

  /* 任意方法名都返回一个转发的函数(具体支持与否由服务端判定) */
  var apiProxy = new Proxy({}, {
    get: function (_target, name) {
      if (typeof name !== "string") return undefined;
      return function () {
        return rpc(name, Array.prototype.slice.call(arguments));
      };
    },
  });

  root.pywebview = { api: apiProxy, __lanRpc: true };
  root.PomeloLanMode = true;

  /* ---------- SSE:接收执行日志 ---------- */
  function connectEvents() {
    var es;
    try {
      es = new EventSource("/api/events");
    } catch (e) {
      return;
    }
    es.onmessage = function (msg) {
      var ev;
      try {
        ev = JSON.parse(msg.data);
      } catch (e) {
        return;
      }
      var app = root.PomeloApp;
      if (app && app.testrun && typeof app.testrun.onRunEvent === "function") {
        try {
          app.testrun.onRunEvent(ev);
        } catch (e) { /* 单条事件渲染异常不影响后续 */ }
      }
    };
    /* 断线由 EventSource 自动重连,这里不需要处理 */
  }

  if (root.document && root.document.readyState === "loading")
    root.document.addEventListener("DOMContentLoaded", connectEvents);
  else
    connectEvents();

  if (root.console && root.console.info)
    root.console.info("[局域网模式] 已启用 HTTP 桥接,数据读写与执行均走本机服务");
})(window);
