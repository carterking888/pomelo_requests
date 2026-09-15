"""
Pomelo 接口测试平台 - PyWebView 桌面应用入口

技术栈:
    - PyWebView 5.x  : 桌面窗口容器,封装本地 HTML 资源
    - layui 2.x      : UI 组件库(按钮/表格/表单/标签页等)
    - petite-vue 0.4 : 轻量级响应式数据驱动视图(~6KB)
    - ECharts 5.x    : 测试趋势折线图/通过率环形图/耗时柱状图

启动:
    pip install -r requirements.txt
    python pomelo_app.py            # 默认:内置 HTTP 服务(推荐)
    python pomelo_app.py --file     # 备选:直接 file:// 加载
    python pomelo_app.py --debug    # 开启调试(右键可 Inspect)

资源组织:
    web/index.html       主页面(SPA,内嵌 6 个视图区块,通过 hash 路由切换)
    web/css/app.css      全局样式(紫色主题 / 白底卡片 / 圆角)
    web/vendor/          本地依赖(layui / echarts / petite-vue,离线可用)
    web/js/app.js        petite-vue 主应用 + Hash 路由 + 图表渲染守卫
    web/js/mock.js       mock 数据(可替换为后端接口)
    web/js/pages/*.js    6 个页面组件

说明:
    默认用内置 HTTP 服务而非 file://,原因是部分 WebView 内核对 file://
    协议下的相对路径资源 / 字体加载有限制,HTTP 模式行为与生产部署一致。
"""

from __future__ import annotations

import argparse
import functools
import hashlib
import http.server
import json  # 业务需要:save_json 序列化
import os
import queue  # 局域网模式:执行事件广播给 SSE 订阅者
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error  # 套件执行:http 用例
import urllib.request
import uuid  # Allure 结果:每条用例结果文件的唯一名
import webbrowser  # 顶部「打开浏览器」入口:用系统默认浏览器打开访问地址
from urllib.parse import urlencode, urlparse

try:
    import webview
except ModuleNotFoundError:  # pragma: no cover - 环境缺失时的友好提示
    sys.stderr.write(
        "\n[错误] 缺少依赖 pywebview,桌面窗口无法启动。\n"
        "\n"
        "  请先安装依赖:\n"
        "      pip install -r requirements.txt\n"
        "\n"
        "  或单独安装:\n"
        "      pip install \"pywebview>=5.0,<6.0\"\n"
        "\n"
        "  注意:包名是 pywebview,不是 webview\n"
        "       (PyPI 上的 webview 是另一个无关的废弃包,只有 0.1.x 版本)\n"
        "\n"
        "  若只想先在浏览器中预览界面,可直接打开:\n"
        f"      {os.path.join(os.path.dirname(os.path.abspath(__file__)), 'web', 'index.html')}\n"
        "\n"
    )
    sys.exit(1)


# ============================================================
#  路径解析(兼容 PyInstaller 打包后的 _MEIPASS 临时目录)
# ============================================================
def get_base_dir() -> str:
    return getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))


def get_resource_path(rel: str) -> str:
    return os.path.join(get_base_dir(), rel)


# ============================================================
#  内置静态 HTTP 服务 + 局域网访问
#  ------------------------------------------------------------
#  监听 0.0.0.0(所有网卡),局域网内其他电脑用浏览器打开
#      http://<本机IP>:18080/index.html
#  即可使用(可读写数据、执行用例、看实时日志)。
#
#  远程浏览器没有 pywebview 桥,前端 bridge.js 会把所有
#  window.pywebview.api.xxx 调用转发到 POST /api/rpc,
#  执行日志通过 GET /api/events(SSE) 下发。
# ============================================================
LAN_HOST = "0.0.0.0"        # 绑定所有网卡(含 127.0.0.1)
LAN_PORTS = (18080, 18081)  # 依次尝试的固定端口:18080 被占用就用 18081
LAN_PORT = LAN_PORTS[0]     # 兼容旧引用:首选端口
ALLURE_URL_PREFIX = "/allure"   # Allure 报告挂在主服务子路径(本地/远程同一套地址)

_JS_API = None              # JsApi 实例(供 HTTP RPC 反射调用)
_MAIN_PORT = 0              # 主服务实际监听端口
_EVENT_SUBSCRIBERS: list = []       # SSE 订阅者队列
_EVENT_SUB_LOCK = threading.Lock()
_REMOTE = threading.local()         # 标记"本次调用来自局域网 HTTP 请求"
_RPC_BLOCKED = {"pick_save_path"}   # 需要本机桌面交互的方法,远程拒绝

# ---------------- 平台差异(Windows / macOS) ----------------
# 打包支持 Windows 与 macOS 两端。差异集中在三处:用什么命令打开文件/URL、
# allure 命令行长什么样、便携 JRE 目录结构 —— 都收敛到这几个变量,别散落各处。
IS_WIN = sys.platform.startswith("win")
IS_MAC = sys.platform == "darwin"

# allure 命令行文件名:Windows 是 allure.bat,类 Unix 是无扩展名的 shell 脚本
_ALLURE_BIN_NAMES = (("allure.bat", "allure.cmd", "allure.exe") if IS_WIN
                     else ("allure", "allure.sh"))


def _open_path(target: str) -> None:
    """用系统默认程序打开文件 / 目录 / URL(跨平台)。

    Windows 用 os.startfile(它没有任何进程级副作用);
    macOS 用 open(1),其余类 Unix 用 xdg-open。
    注意 macOS 下不要用 os.startfile —— 该函数在非 Windows 上根本不存在,
    调用即 AttributeError,而这里正是"点报告/点地址条"的必经路径。
    """
    if IS_WIN:
        os.startfile(target)  # noqa: S606
        return
    opener = "open" if IS_MAC else "xdg-open"
    subprocess.Popen([opener, target],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _is_remote_call() -> bool:
    """当前调用是否来自局域网 HTTP 请求(而非桌面窗口桥)"""
    return bool(getattr(_REMOTE, "remote", False))


def _broadcast_event(ev: dict) -> None:
    """把执行事件广播给所有 SSE 订阅者(局域网浏览器)"""
    with _EVENT_SUB_LOCK:
        subs = list(_EVENT_SUBSCRIBERS)
    for q in subs:
        try:
            q.put_nowait(ev)
        except Exception:
            pass  # 队列满/订阅者已断,丢弃该事件即可


def _rpc_dispatch(method: str, args: list) -> dict:
    """把远程 HTTP 调用转给 JsApi 的同名方法(只允许公开方法)"""
    api = _JS_API
    if api is None:
        return {"ok": False, "error": "服务尚未就绪,请稍后重试"}
    if (not isinstance(method, str) or not method
            or method.startswith("_") or method in _RPC_BLOCKED
            or not callable(getattr(JsApi, method, None))):
        return {"ok": False, "error": "不支持的方法: " + str(method)}
    _REMOTE.remote = True
    try:
        return getattr(api, method)(*(args or []))
    except Exception as e:  # 远程调用不能让异常打穿到 HTTP 层
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
    finally:
        _REMOTE.remote = False


def _allure_report_root() -> str:
    """Allure 报告根目录(data/allure-report)"""
    api = _JS_API
    if api is not None:
        return os.path.join(api.get_data_dir(), "allure-report")
    return os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "data", "allure-report")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    """静默版静态文件处理器(不在控制台刷访问日志)

    额外承担三件事:
      1. POST /api/rpc      → 局域网浏览器的桥调用入口
      2. GET  /api/events   → SSE 推送执行日志
      3. GET  /allure/...   → 托管 Allure 报告(本地/远程同一地址)
    """
    protocol_version = "HTTP/1.1"   # SSE 长连接需要 keep-alive

    def log_message(self, fmt: str, *args) -> None:  # noqa: A002
        pass

    def end_headers(self) -> None:
        """禁缓存:SimpleHTTPRequestHandler 不带 Cache-Control,WebView2
        会对 JS/CSS 启发式缓存——改了前端代码后页面仍跑旧脚本(已踩:
        路由修复后编辑同名用例仍打开旧文件)。每次启动都强制回源。"""
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    # ---------------- /allure/ 报告目录映射 ----------------
    def translate_path(self, path: str) -> str:
        p = urlparse(path).path
        if p == ALLURE_URL_PREFIX or p.startswith(ALLURE_URL_PREFIX + "/"):
            rel = p[len(ALLURE_URL_PREFIX):].lstrip("/")
            safe = os.path.normpath(rel).replace("\\", "/")
            if safe in (".", "..") or safe.startswith("../"):
                return os.path.join(self.directory, "__forbidden__")
            return os.path.join(_allure_report_root(), safe.replace("/", os.sep))
        return super().translate_path(path)

    # ---------------- HTTP RPC ----------------
    def _send_json(self, obj: dict, status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception:
            self.close_connection = True   # 对端已断,这条连接不能再复用

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/api/rpc":
            self._send_json({"ok": False, "error": "not found"}, 404)
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n > 0 else b"{}"
            payload = json.loads(raw.decode("utf-8") or "{}")
            method = payload.get("method") or ""
            args = payload.get("args") or []
            if not isinstance(args, list):
                args = [args]
        except Exception as e:
            self._send_json({"ok": False, "error": "请求体解析失败: " + str(e)}, 400)
            return
        self._send_json({"ok": True, "result": _rpc_dispatch(method, args)})

    # ---------------- SSE 事件流 ----------------
    def do_GET(self) -> None:
        if urlparse(self.path).path == "/api/events":
            self._serve_events()
            return
        super().do_GET()

    def _serve_events(self) -> None:
        q: "queue.Queue" = queue.Queue(maxsize=5000)
        with _EVENT_SUB_LOCK:
            _EVENT_SUBSCRIBERS.append(q)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                try:
                    ev = q.get(timeout=15)
                    data = json.dumps(ev, ensure_ascii=False)
                    self.wfile.write(("data: " + data + "\n\n").encode("utf-8"))
                    self.wfile.flush()
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")   # 心跳,防中间设备断流
                    self.wfile.flush()
        except Exception:
            pass  # 客户端关闭/网络中断
        finally:
            with _EVENT_SUB_LOCK:
                if q in _EVENT_SUBSCRIBERS:
                    _EVENT_SUBSCRIBERS.remove(q)
            # SSE 是终结型响应:流结束后连接已不可复用,若继续 keep-alive
            # 读下一个请求行,会在对端已断的 socket 上抛 WinError 10053。
            self.close_connection = True


# 客户端主动断开(关页面/切路由/断网)时 socket 操作会抛这些异常,
# 属于正常现象,不应打印堆栈干扰排查。
_CLIENT_GONE_ERRORS = (
    ConnectionAbortedError,   # WinError 10053 你的主机中的软件中止了一个已建立的连接
    ConnectionResetError,     # WinError 10054 远程主机强迫关闭了一个现有的连接
    BrokenPipeError,          # 写响应时对端已关闭
    TimeoutError,
)


class QuietHTTPServer(http.server.ThreadingHTTPServer):
    """静默版多线程 HTTP 服务

    ThreadingHTTPServer.handle_error 默认 traceback.print_exc(),浏览器
    关页面/断网时控制台会刷一大段 WinError 10053 堆栈。这里把"客户端已
    断开"这类预期异常静默掉,其他异常只打一行摘要,保留可排查性。
    """

    def handle_error(self, request, client_address) -> None:  # noqa: ARG002
        exc = sys.exc_info()[1]
        if isinstance(exc, _CLIENT_GONE_ERRORS):
            return
        sys.stderr.write(
            f"[http] 处理请求异常 {client_address}: "
            f"{exc.__class__.__name__}: {exc}\n"
        )


def find_free_port() -> int:
    """向系统申请一个空闲端口"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def get_lan_ip() -> str:
    """取本机在局域网中的出口 IP(仅用于控制台打印访问地址)"""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))   # UDP 不发包,只为让系统选路由
            return s.getsockname()[0]
    except Exception:
        return ""


def serve_web_dir(port: int) -> QuietHTTPServer:
    """在后台线程启动静态服务,根目录为 web/(绑定所有网卡)"""
    handler = functools.partial(QuietHandler, directory=get_resource_path("web"))
    httpd = QuietHTTPServer((LAN_HOST, port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def _port_in_use(host: str, port: int, timeout: float = 0.35) -> bool:
    """端口是否已被别的进程监听。

    ⚠ 不能用 bind 判断:Windows 上 SO_REUSEADDR 语义与 Unix 不同,允许
      "抢占"已被占用的端口,而 HTTPServer 默认 allow_reuse_address=1 ——
      于是 bind 到占用中的端口照样成功,回退逻辑永远不会触发。
      这里改用 connect 探测:连得上 = 有服务在监听 = 确实被占用。
      自己服务重启时残留的 TIME_WAIT 不会 accept,因此不会误判。
    """
    probe_host = "127.0.0.1" if host in ("", None, "0.0.0.0") else host
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        return s.connect_ex((probe_host, port)) == 0


def _pick_free_port(host: str) -> int:
    """借系统分配一个"真正空闲"的端口(0 表示没找到)。

    不能直接用 serve_web_dir(0):QuietHTTPServer 带 SO_REUSEADDR,Windows
    下系统可能把"已被别的进程占用但允许复用"的端口分给我们,结果是两个
    进程抢同一个端口。这里先用不带 SO_REUSEADDR 的裸 socket 拿端口,再确认
    没人在监听;裸 socket 只 bind 不 listen,不会留下 TIME_WAIT。
    """
    for _ in range(20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((host, 0))
            except OSError:
                return 0
            port = s.getsockname()[1]
        if not _port_in_use(host, port):
            return port
    return 0


def start_web_server(ports=None):
    """依次尝试候选端口(局域网地址稳定可预期),全部被占用才回退随机端口。

    参数:
        ports: None → 用 LAN_PORTS(18080 → 18081);
               传 int → 只试这一个;传序列 → 按顺序逐个试。

    返回:
        (httpd, 实际端口) —— 端口一律以 httpd.server_address[1] 为准。
    """
    if ports is None:
        candidates = list(LAN_PORTS)
    elif isinstance(ports, int):
        candidates = [ports]
    else:
        candidates = [int(p) for p in ports]
    for p in candidates:
        if _port_in_use(LAN_HOST, p):
            continue                       # 已被占用 → 试下一个固定端口
        try:
            return serve_web_dir(p), p
        except OSError:
            continue                       # 竞态:刚被别的进程抢走
    # 兜底:换一个随机空闲端口(别用 serve_web_dir(0) —— 见 _pick_free_port)
    for _ in range(5):
        p = _pick_free_port(LAN_HOST)
        if not p or _port_in_use(LAN_HOST, p):
            continue
        try:
            return serve_web_dir(p), p
        except OSError:
            continue
    httpd = serve_web_dir(0)               # 极端兜底:交给系统
    return httpd, httpd.server_address[1]


# ============================================================
#  Pomelo 协议(移植自旧版工具 libs/PomeloProtocol.py)
#  网关走标准 Pomelo:连接 URL 只到 host,路由在消息体里,
#  连接后先握手(包类型 1 → 2 ACK),按服务端下发间隔发心跳。
# ============================================================
class PomeloProto:
    PKG_HEAD_BYTES = 4

    # Package 类型
    PKG_HANDSHAKE = 1
    PKG_HANDSHAKE_ACK = 2
    PKG_HEARTBEAT = 3
    PKG_DATA = 4
    PKG_KICK = 5

    # Message 类型
    MSG_REQUEST = 0
    MSG_NOTIFY = 1
    MSG_RESPONSE = 2
    MSG_PUSH = 3

    @staticmethod
    def strencode(s):
        if isinstance(s, bytes):
            return s
        return str(s).encode("utf-8")

    @staticmethod
    def strdecode(b):
        if isinstance(b, str):
            return b
        return bytes(b).decode("utf-8", "replace")

    @classmethod
    def pkg_encode(cls, ptype, body=None):
        body = bytes(body or b"")
        n = len(body)
        return bytes([ptype & 0xff,
                      (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]) + body

    @classmethod
    def pkg_decode(cls, buf):
        """一帧 WebSocket 消息可能粘多个包,全部解出;不完整即报错"""
        data = bytes(buf)
        out, off = [], 0
        while off < len(data):
            if off + cls.PKG_HEAD_BYTES > len(data):
                raise ValueError("Pomelo 包头不完整(长度 " + str(len(data)) + ")")
            t = data[off]
            n = (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3]
            off += cls.PKG_HEAD_BYTES
            if off + n > len(data):
                raise ValueError("Pomelo 包体不完整(声明 " + str(n) + " 字节)")
            out.append({"type": t, "body": data[off:off + n]})
            off += n
        return out

    @classmethod
    def msg_encode(cls, req_id, route, msg_bytes):
        """TYPE_REQUEST 帧:flag(0) + varint(id) + route(len+bytes) + body"""
        out = bytearray([0])                      # flag: type=0<<1 | compressRoute=0
        rid = int(req_id or 0)
        while True:                               # id varint(小端 7bit 组)
            b = rid % 128
            rid //= 128
            if rid:
                b |= 0x80
            out.append(b)
            if not rid:
                break
        rb = cls.strencode(route)
        out.append(len(rb) & 0xff)
        out.extend(rb)
        out.extend(bytes(msg_bytes or b""))
        return bytes(out)

    @classmethod
    def msg_decode(cls, buf):
        data = bytes(buf)
        if not data:
            return {"id": 0, "type": 0, "route": "", "body": "", "error": 0}
        flag = data[0]
        off = 1
        mtype = (flag >> 1) & 0x7
        is_err = (flag >> 5) & 0x1
        rid = 0
        if mtype in (cls.MSG_REQUEST, cls.MSG_RESPONSE):     # 有 id
            i = 0
            while True:
                m = data[off]
                off += 1
                rid += (m & 0x7f) << (7 * i)
                i += 1
                if m < 0x80:
                    break
        route = None
        if mtype in (cls.MSG_REQUEST, cls.MSG_NOTIFY, cls.MSG_PUSH):  # 有 route
            rlen = data[off]
            off += 1
            route = cls.strdecode(data[off:off + rlen]) if rlen else ""
            off += rlen
        return {"id": rid, "type": mtype, "route": route,
                "body": cls.strdecode(data[off:]) if off < len(data) else "",
                "error": is_err}


def _ws_connect(url, timeout, headers, log):
    """建立 WebSocket 连接,带 LB 重定向容错。

    公网 LB 常把明文 ws://(80 端口)301 重定向到 https://(443),
    websocket-client 跟随重定向时只认 ws/wss,遇到 https 目标会抛
    "Invalid redirect target 'https://...' / scheme https is invalid"。
    这里捕获后把目标地址 https:// 换成 wss:// 自动重试一次。
    """
    import websocket
    try:
        return websocket.create_connection(url, timeout=max(1, int(timeout or 30)),
                                           header=headers or [])
    except Exception as e:
        msg = str(e)
        # websocket-client 1.9.1+: "Invalid redirect target 'https://...': ..."
        # websocket-client 1.9.0(裸 ValueError,拿不到目标地址): "scheme https is invalid"
        m = re.search(r"Invalid redirect target '([^']+)'", msg)
        if m and m.group(1).lower().startswith("https://"):
            upgraded = "wss://" + m.group(1)[len("https://"):]
        elif re.search(r"scheme https is invalid", msg, re.I):
            upgraded = re.sub(r"^ws://([^/:]+)(?::80)?", r"wss://\1",
                              url, flags=re.I)
        else:
            raise
        log("服务器把 ws:// 重定向到 https://(LB 只收 TLS),已自动升级为 wss:// 重连")
        return websocket.create_connection(upgraded, timeout=max(1, int(timeout or 30)),
                                           header=headers or [])


class PomeloSession:
    """同步版 Pomelo WebSocket 会话(同一套件内长连接复用)。

    生命周期: connect(发握手、等响应、回 ACK) → request(route, msg) → close。
    每次请求前按服务端下发的 heartbeat 间隔补发心跳,保证长连接不断。
    """

    def __init__(self, url, timeout, headers, log):
        try:
            import websocket  # websocket-client
        except ModuleNotFoundError:
            raise RuntimeError("缺少依赖 websocket-client,请执行: pip install websocket-client")
        self.log = log
        self.timeout = max(1, int(timeout or 30))
        self.ws = _ws_connect(url, self.timeout, headers, log)
        self.req_id = 0
        self.heartbeat_interval = 0
        self.last_beat = time.time()
        self._handshake()

    # ---- 包收发 ----
    def _send_pkg(self, ptype, body=None):
        self.ws.send(PomeloProto.pkg_encode(ptype, body))

    def _recv_pkgs(self):
        data = self.ws.recv()
        if isinstance(data, (bytes, bytearray)):
            return PomeloProto.pkg_decode(data)
        raise ValueError("Pomelo 网关返回了非二进制帧(纯文本),地址可能不是 Pomelo 网关")

    # ---- 握手 ----
    # 游戏服为 Pitaya(Pomelo 的 Go 实现),网关校验 user.ts + md5 签名,
    # 盐值与另一个平台(test_backoffice)压测/自动化实现一致。
    _HS_SALT = "e9aaa716186e418abb79890a76a6368a"

    def _handshake(self):
        ts = str(int(time.time() * 1000))
        sign = hashlib.md5((ts + self._HS_SALT + ts).encode()).hexdigest()
        hs = {"sys": {"type": "js-websocket", "version": "0.0.1", "rsa": {}},
              "user": {"ts": ts, "sign": sign}}
        self._send_pkg(PomeloProto.PKG_HANDSHAKE,
                       PomeloProto.strencode(json.dumps(hs, separators=(",", ":"))))
        deadline = time.time() + self.timeout
        while True:
            if time.time() > deadline:
                raise TimeoutError(
                    "Pomelo 握手等待响应超时——连接器接受了 WS 升级但对握手无响应,"
                    "请确认地址是否为该环境的 socket 连接端点")
            self.ws.settimeout(max(0.5, deadline - time.time()))
            try:
                pkgs = self._recv_pkgs()
            except Exception:
                raise
            for p in pkgs:
                if p["type"] == PomeloProto.PKG_HANDSHAKE:
                    info = json.loads(PomeloProto.strdecode(p["body"]) or "{}")
                    if info.get("code") != 200:
                        raise RuntimeError(
                            "Pomelo 握手被拒: code=" + str(info.get("code")) +
                            (" " + str(info.get("message")) if info.get("message") else "") +
                            "(握手体 ts/sign 校验未通过或网关拒绝该连接)")
                    try:
                        self.heartbeat_interval = int(info.get("heartbeat") or 0)
                    except (TypeError, ValueError):
                        self.heartbeat_interval = 0
                    self._send_pkg(PomeloProto.PKG_HANDSHAKE_ACK)
                    self.log("Pomelo 握手成功" +
                             (" (心跳 " + str(self.heartbeat_interval) + "s)"
                              if self.heartbeat_interval else ""))
                    return
                if p["type"] == PomeloProto.PKG_KICK:
                    raise RuntimeError("连接建立即被服务端踢下线(KICK)")

    # ---- 心跳 ----
    def _maybe_heartbeat(self):
        if not self.heartbeat_interval:
            return
        if time.time() - self.last_beat >= max(1.0, self.heartbeat_interval * 0.7):
            self._send_pkg(PomeloProto.PKG_HEARTBEAT)
            self.last_beat = time.time()

    # ---- 请求/响应(同步,按 reqId 匹配) ----
    def request(self, route, msg_dict):
        self._maybe_heartbeat()
        self.req_id += 1
        rid = self.req_id
        payload = PomeloProto.strencode(
            json.dumps(msg_dict if msg_dict is not None else {}, ensure_ascii=False))
        self._send_pkg(PomeloProto.PKG_DATA,
                       PomeloProto.msg_encode(rid, route, payload))
        t0 = time.perf_counter()
        deadline = time.time() + self.timeout
        while True:
            if time.time() > deadline:
                raise TimeoutError("等待响应超时(" + str(self.timeout) + "s): " + route)
            self.ws.settimeout(max(0.5, deadline - time.time()))
            for p in self._recv_pkgs():
                if p["type"] == PomeloProto.PKG_HEARTBEAT:
                    self.last_beat = time.time()
                    continue
                if p["type"] == PomeloProto.PKG_KICK:
                    raise RuntimeError("被服务端踢下线(KICK),会话已失效")
                if p["type"] != PomeloProto.PKG_DATA:
                    continue
                m = PomeloProto.msg_decode(p["body"])
                if m["type"] == PomeloProto.MSG_RESPONSE and m["id"] == rid:
                    return m["body"], int((time.perf_counter() - t0) * 1000)
                # 其他 id 的响应/服务端推送:非本次请求,忽略(日志不刷屏)

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


# ============================================================
#  Python <-> JS 桥接(window.pywebview.api.*)
# ============================================================
class JsApi:
    """暴露给前端的 Python 方法,前端通过 window.pywebview.api.xxx() 调用"""

    # 数据根目录:首次保存时按 category / module 自动创建子目录
    #   data/{category}/{module}/{name}.json   —— 已归档到模块
    #   data/{category}/{name}.json            —— 未归档(历史数据,仍可读)
    DATA_DIR = "data"

    # 目录名(category / module)统一校验:纯 ASCII 字母数字下划线短横线,1~32 位。
    # 前端模块 key 由 djb2 哈希派生("m" + base36),因此中文模块名也满足此约束。
    _SEG_RE = re.compile(r"[A-Za-z0-9_\-]{1,32}")

    def get_data_dir(self) -> str:
        """返回本地数据根目录绝对路径(用于前端展示与调试)。

        打包后(frozen)指到 exe 同级目录 —— data 不打进包,运行时在
        包旁边生成/读写,卸载删包不影响数据;开发态仍在项目根 data/。
        """
        if getattr(sys, "frozen", False):
            base = os.path.dirname(sys.executable)
        else:
            base = os.path.dirname(os.path.abspath(__file__))
        return os.path.abspath(os.path.join(base, self.DATA_DIR))

    # ---------------- 访问地址(页面顶部「打开浏览器」入口) ----------------
    def get_access_info(self) -> dict:
        """返回本服务的访问地址,供页面顶部渲染「打开浏览器」入口。

        返回 {ok, port, local_url, lan_url, url, display, remote};
        port=0(如 --file 模式没有 HTTP 服务)时前端隐藏该入口。
        """
        port = int(_MAIN_PORT or 0)
        remote = _is_remote_call()
        if not port:
            return {"ok": False, "error": "当前非 HTTP 模式,无访问地址",
                    "port": 0, "local_url": "", "lan_url": "",
                    "url": "", "display": "", "remote": remote}
        local_url = f"http://127.0.0.1:{port}/index.html"
        lan_ip = get_lan_ip()
        lan_url = f"http://{lan_ip}:{port}/index.html" if lan_ip else ""
        # 展示优先级:局域网地址(可分享给同事)> 本机地址
        return {
            "ok": True,
            "port": port,
            "local_url": local_url,
            "lan_url": lan_url,
            "url": lan_url or local_url,
            "display": f"{lan_ip}:{port}" if lan_ip else f"127.0.0.1:{port}",
            "remote": remote,
        }

    def open_in_browser(self, url: str = "") -> dict:
        """用系统默认浏览器打开访问地址(页面右上角地址条点击触发)。

        远程(局域网浏览器)调用时【不在服务器上弹浏览器】,只把地址回给
        前端自行开标签页 —— 否则局域网里谁都能在你机器上刷一屏浏览器窗口。
        """
        target = str(url or "").strip()
        if not target:
            target = str(self.get_access_info().get("url") or "")
        if not re.match(r"^https?://", target, re.I):
            return {"ok": False, "error": "仅支持 http/https 地址"}
        if _is_remote_call():
            return {"ok": True, "url": target, "remote": True}
        try:
            webbrowser.open(target)
            return {"ok": True, "url": target, "remote": False}
        except Exception as e:
            return {"ok": False, "error": f"打开浏览器失败: {e}"}

    # ---------- 内部工具:路径分段校验 ----------
    @classmethod
    def _seg(cls, seg) -> str | None:
        """校验必填的单段目录名。合法返回该段,非法返回 None。"""
        s = "" if seg is None else str(seg).strip()
        return s if cls._SEG_RE.fullmatch(s) else None

    @classmethod
    def _opt_seg(cls, seg) -> str | None:
        """校验可选段:空/None 表示"不指定"(返回 ""),非法返回 None。"""
        s = "" if seg is None else str(seg).strip()
        if s == "":
            return ""
        return s if cls._SEG_RE.fullmatch(s) else None

    @staticmethod
    def _safe_file_name(name) -> str:
        """文件名净化:允许中文/空格/点,替换掉会破坏路径的字符,截断 64 字符。"""
        if name is None or not str(name).strip():
            return time.strftime("%Y%m%d_%H%M%S")
        safe = re.sub(r'[\\/:\*\?"<>\|\x00-\x1f]+', "_", str(name).strip())[:64]
        return safe or time.strftime("%Y%m%d_%H%M%S")

    def _resolve_dir(self, category, module=None):
        """把 (category, module) 解析为绝对目录路径。

        返回 (path, error);error 非空时 path 为 None。
        module 为空 → category 根目录(兼容未归档的历史数据)。
        """
        cat = self._seg(category)
        if cat is None:
            return None, f"非法 category: {category!r}"
        mod = self._opt_seg(module)
        if mod is None:
            return None, f"非法 module: {module!r}"
        base = self.get_data_dir()
        return (os.path.join(base, cat, mod) if mod else os.path.join(base, cat)), None

    def save_json(self, category: str, name: str, content, module=None) -> dict:
        """保存 JSON 到 data/{category}/{module}/,自动创建目录。

        参数:
            category: 业务分类,如 'cases' / 'suites'。必须只含字母数字下划线
                      与短横线,避免路径穿越。
            name:     文件名(不含后缀)。为空时按时间戳生成。
            content:  待写入内容,可以是 dict(走 json.dump 走 indent=2)
                      或 str(原样写入)。
            module:   模块目录(可选)。传空 → 落在 category 根目录(旧行为)。
                      前端传的是模块 key(纯 ASCII),不是中文模块名。

        返回:
            {ok, path, error, bytes, category, module, name}
        """
        # 1) 参数校验 + 目录解析(防路径穿越)
        target_dir, err = self._resolve_dir(category, module)
        if err:
            return {"ok": False, "error": err}
        # name 宽松:允许中文/空格/点 等,但替换掉会破坏路径的字符 (/ \ : * ? " < > |)
        safe_name = self._safe_file_name(name)

        # 2) 目录创建
        try:
            os.makedirs(target_dir, exist_ok=True)
        except OSError as e:
            return {"ok": False, "error": f"创建目录失败: {e}"}

        # 3) 内容序列化
        if isinstance(content, str):
            payload = content
        else:
            try:
                payload = json.dumps(content, ensure_ascii=False, indent=2)
            except (TypeError, ValueError) as e:
                return {"ok": False, "error": f"JSON 序列化失败: {e}"}

        # 4) 写盘(UTF-8,带 BOM 不带,便于其他工具读)
        full_path = os.path.join(target_dir, f"{safe_name}.json")
        try:
            with open(full_path, "w", encoding="utf-8", newline="\n") as f:
                f.write(payload)
        except OSError as e:
            return {"ok": False, "error": f"写文件失败: {e}"}

        return {
            "ok": True,
            "path": full_path,
            "bytes": len(payload.encode("utf-8")),
            "category": category,
            "module": self._opt_seg(module) or "",
            "name": safe_name,
        }

    def list_json(self, category: str, module=None, recursive: bool = False) -> dict:
        """读取 data/{category}[/{module}]/*.json,返回 [{file_name, module, content}]。

        用于前端启动时拉取已落盘的用例 / 套件,合并到内存列表(去重)。
        文件名按字母序排;content 解析失败时原样返回字符串。

        参数:
            category:  业务分类,如 'cases'。
            module:    指定模块目录;为空则读 category 根目录。
            recursive: True 时忽略 module,一次性把根目录 + 所有模块子目录
                       全部读出来(每项带 module 字段标明归属,根目录为 "")。

        返回:
            {ok, items: [{file_name, module, content}], error, category, module}
        """
        target_dir, err = self._resolve_dir(category, None if recursive else module)
        if err:
            return {"ok": False, "error": err}
        mod = "" if recursive else (self._opt_seg(module) or "")

        if not os.path.isdir(target_dir):
            return {"ok": True, "items": [], "category": category, "module": mod}

        items = []
        # 先读当前目录(未归档的历史数据)
        items.extend(self._read_dir_json(target_dir, mod))
        # 递归模式:再逐个扫模块子目录(只下探一层,模块不嵌套)
        if recursive:
            for sub in sorted(os.listdir(target_dir)):
                sub_dir = os.path.join(target_dir, sub)
                if not os.path.isdir(sub_dir) or self._seg(sub) is None:
                    continue
                items.extend(self._read_dir_json(sub_dir, sub))

        return {"ok": True, "items": items, "category": category, "module": mod}

    @staticmethod
    def _read_dir_json(target_dir: str, module: str) -> list:
        """读一个目录下的 *.json(不下探),返回 [{file_name, module, content}]。"""
        out = []
        try:
            names = sorted(os.listdir(target_dir))
        except OSError as e:
            print(f"[warn] 列目录失败: {target_dir} - {e}", file=sys.stderr)
            return out
        for fn in names:
            if not fn.lower().endswith(".json"):
                continue
            full = os.path.join(target_dir, fn)
            if not os.path.isfile(full):
                continue
            try:
                with open(full, "r", encoding="utf-8") as f:
                    raw = f.read()
            except OSError as e:
                print(f"[warn] 读取失败: {full} - {e}", file=sys.stderr)
                continue
            try:
                content = json.loads(raw)
            except (TypeError, ValueError):
                content = raw   # 无法解析时原样返回字符串,前端可见 .file_name 自助排查
            out.append({"file_name": fn, "module": module, "content": content})
        return out

    def delete_json(self, category: str, name: str, module=None) -> dict:
        """删除 data/{category}[/{module}]/{name}.json(用于修正误保存 / 行级删除)。

        指定 module 时只删该模块目录下的文件;module 为空时删 category 根目录下的。
        两处都找不到时返 ok=True(幂等),并用 found 字段标明是否真的删掉了。
        """
        if not name or not str(name).strip():
            return {"ok": False, "error": "name 不能为空"}
        safe_name = self._safe_file_name(name)

        # 候选路径:优先给定 module,其次回退 category 根目录(兼容未归档的历史数据)
        candidates = []
        target_dir, err = self._resolve_dir(category, module)
        if err:
            return {"ok": False, "error": err}
        candidates.append(target_dir)
        if self._opt_seg(module):
            root_dir, root_err = self._resolve_dir(category, None)
            if not root_err:
                candidates.append(root_dir)

        for d in candidates:
            full_path = os.path.join(d, f"{safe_name}.json")
            if os.path.isfile(full_path):
                try:
                    os.remove(full_path)
                except OSError as e:
                    return {"ok": False, "error": f"删除失败: {e}"}
                return {"ok": True, "path": full_path, "found": True}

        return {"ok": True, "path": os.path.join(candidates[0], f"{safe_name}.json"),
                "found": False}

    def delete_module_dir(self, category: str, module: str, dry_run: bool = True) -> dict:
        """删除 data/{category}/{module}/ 整个目录。

        破坏性操作,默认 dry_run=True:只统计目录下的文件清单返回给前端,
        供弹窗做二次确认,不动磁盘。前端确认后再以 dry_run=False 调一次。

        返回:
            {ok, exists, dry_run, deleted, dir, files: [...], count, error}
        """
        cat = self._seg(category)
        if cat is None:
            return {"ok": False, "error": f"非法 category: {category!r}"}
        mod = self._seg(module)
        if mod is None:
            # 这里必须给出模块,防止 module 为空时误删整个 category 根目录
            return {"ok": False, "error": f"非法 module: {module!r}"}

        target_dir = os.path.join(self.get_data_dir(), cat, mod)
        base_ret = {"ok": True, "dir": target_dir, "dry_run": bool(dry_run),
                    "category": cat, "module": mod}

        if not os.path.isdir(target_dir):
            # 目录本来就不存在:视为已删除(幂等),前端无需弹二次确认
            return dict(base_ret, exists=False, deleted=False, files=[], count=0)

        files = sorted(
            fn for fn in os.listdir(target_dir)
            if os.path.isfile(os.path.join(target_dir, fn))
        )
        sub_dirs = [
            fn for fn in os.listdir(target_dir)
            if os.path.isdir(os.path.join(target_dir, fn))
        ]
        ret = dict(base_ret, exists=True, files=files, count=len(files))

        if dry_run:
            return dict(ret, deleted=False, sub_dirs=sub_dirs)

        # 真删:只删文件 + 空目录,不递归 rmtree —— 目录里出现了意料之外的子目录
        # 就中止并报错,交给人工确认,避免一条命令带走别的东西。
        if sub_dirs:
            return dict(ret, ok=False, deleted=False, sub_dirs=sub_dirs,
                        error=f"目录下存在子目录 {sub_dirs},为安全起见未执行删除")
        removed = []
        for fn in files:
            full = os.path.join(target_dir, fn)
            try:
                os.remove(full)
            except OSError as e:
                return dict(ret, ok=False, deleted=False, removed=removed,
                            error=f"删除文件失败: {fn} - {e}")
            removed.append(fn)
        try:
            os.rmdir(target_dir)
        except OSError as e:
            return dict(ret, ok=False, deleted=False, removed=removed,
                        error=f"删除目录失败: {e}")
        return dict(ret, deleted=True, removed=removed)

    def pick_save_path(self, default_name: str = "report.zip") -> str:
        """弹出保存文件对话框,返回选中路径(用于导出 Allure 报告)"""
        window = webview.windows[0] if webview.windows else None
        if not window:
            return ""
        result = window.create_file_dialog(
            webview.SAVE_DIALOG,
            directory=os.path.expanduser("~"),
            save_filename=default_name,
        )
        return result if isinstance(result, str) else ""

    def get_app_info(self) -> dict:
        """返回应用元信息,便于前端展示版本号"""
        return {
            "name": "Pomelo 接口测试平台",
            "version": "1.0.0",
            "webRoot": get_resource_path("web"),
            "dataDir": self.get_data_dir(),
        }

    # ============================================================
    #  套件执行引擎(测试执行页「执行跟踪」)
    #  - 按套件内用例顺序串行执行(并发数当前固定 1)
    #  - socket 用例:WebSocket 长连接 —— 同一套件内复用同一条连接,
    #    切换地址时才重连;http 用例:urllib 直连
    #  - 支持 {{var}} 变量替换 / 提取变量(简化 JSONPath) / 断言 / 失败重试
    #  - 停用(state=off)的用例自动跳过
    #  - 过程事件通过 evaluate_js 推送到前端 testrun.onRunEvent 实时渲染
    # ============================================================

    # 执行状态(单任务:同一时间只允许一个套件在跑)
    _run_lock = threading.Lock()
    _run_busy = False
    _run_stop: threading.Event | None = None

    # 断言比较符解析顺序:长的在前,避免 "不等于" 被 "等于" 截断
    _ASSERT_OPS = [
        ("不包含", "not_contains"), ("包含", "contains"),
        ("不等于", "ne"), ("等于", "eq"),
        ("小于等于", "lte"), ("大于等于", "gte"),
        ("小于", "lt"), ("大于", "gt"),
        (">=", "gte"), ("<=", "lte"),
        ("!=", "ne"), ("==", "eq"), ("=", "eq"),
        (">", "gt"), ("<", "lt"),
    ]

    def run_suite(self, suite_file: str, env_key: str = "",
                  retry: int = 0, timeout: int = 60) -> dict:
        """启动一个套件的执行(后台线程,立即返回)。

        参数:
            suite_file: 套件文件名(不含 .json),对应 data/suites/<suite_file>.json
            env_key:    执行环境 key(对应 data/config/envs.json 里的 envs[].key)
            retry:      失败重试次数(0 = 不重试)
            timeout:    单用例超时(秒)

        返回:
            {ok} — ok=False 时带 error(如已有任务在执行)
        """
        with self._run_lock:
            if self._run_busy:
                return {"ok": False, "error": "已有执行任务在进行中,请等待完成或先停止"}
            self._run_busy = True
        self._run_stop = threading.Event()
        threading.Thread(
            target=self._run_suite_worker,
            args=(suite_file, env_key or "", max(0, int(retry or 0)), max(1, int(timeout or 30))),
            daemon=True,
        ).start()
        return {"ok": True}

    def stop_run(self) -> dict:
        """请求停止当前执行(当前用例跑完后不再继续下一条)"""
        if self._run_stop is not None:
            self._run_stop.set()
        return {"ok": True}

    # ---------------- 事件推送 ----------------
    def _push_event(self, ev: dict) -> None:
        """把执行事件推给前端。

        - 桌面窗口:走 pywebview 桥直接 evaluate_js
        - 局域网浏览器:广播到 SSE(/api/events)订阅者
        """
        try:
            win = webview.windows[0] if webview.windows else None
            if win:
                js = ("window.PomeloApp && window.PomeloApp.testrun && "
                      "window.PomeloApp.testrun.onRunEvent(" +
                      json.dumps(ev, ensure_ascii=False) + ");")
                win.evaluate_js(js)
        except Exception:
            pass  # 窗口已关闭等场景,静默
        _broadcast_event(ev)

    # ---------------- 套件 / 用例 / 环境读取 ----------------
    def _read_suite(self, suite_file: str):
        safe = self._safe_file_name(suite_file)
        path = os.path.join(self.get_data_dir(), "suites", safe + ".json")
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.loads(f.read())
        except Exception:
            return None

    def _load_case_by_file(self, file_name: str):
        """在 data/cases/(含模块子目录)里按文件名找用例 payload"""
        target = str(file_name or "").strip()
        if not target:
            return None
        if not target.lower().endswith(".json"):
            target += ".json"
        cases_dir = os.path.join(self.get_data_dir(), "cases")
        if not os.path.isdir(cases_dir):
            return None
        for dirpath, _dirs, files in os.walk(cases_dir):
            if target in files:
                try:
                    with open(os.path.join(dirpath, target), "r", encoding="utf-8") as f:
                        return json.loads(f.read())
                except Exception:
                    return None
        return None

    def _read_envs(self) -> list:
        """读 data/config/envs.json(前端「执行环境」配置,同一份数据)"""
        path = os.path.join(self.get_data_dir(), "config", "envs.json")
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.loads(f.read())
            envs = data.get("envs") if isinstance(data, dict) else data
            if isinstance(envs, list):
                return envs
        except Exception:
            pass
        return []

    # ---------------- 变量替换 / 提取 ----------------
    @staticmethod
    def _render_vars(text: str, vars_map: dict) -> str:
        """把 {{key}} 替换成已提取的变量值;未定义的原样保留"""
        if not text or not vars_map:
            return text
        return re.sub(
            r"\{\{\s*([^{}]+?)\s*\}\}",
            lambda m: str(vars_map.get(m.group(1).strip(), m.group(0))),
            text,
        )

    @staticmethod
    def _extract_path(obj, path: str):
        """简化版 JSONPath:$.data.list.0.name → data/list/0 逐层下钻。
        返回 (value, found)。"""
        clean = str(path or "").strip()
        if clean.startswith("$"):
            clean = clean[1:]
        clean = clean.lstrip(".")
        cur = obj
        parts = [p for p in clean.replace("]", "").replace("[", ".").split(".") if p]
        for part in parts:
            if isinstance(cur, list):
                try:
                    cur = cur[int(part)]
                except (ValueError, IndexError):
                    return None, False
            elif isinstance(cur, dict) and part in cur:
                cur = cur[part]
            else:
                return None, False
        return cur, True

    # ---------------- 断言 ----------------
    @classmethod
    def _parse_assert(cls, value: str):
        """把 "data.name 等于 张三" 拆成 (path, op, expected)"""
        v = str(value or "").strip()
        for op_text, op in cls._ASSERT_OPS:
            idx = v.find(op_text)
            if idx > -1:
                path = v[:idx].strip().lstrip("$").lstrip(".").strip()
                return path, op, v[idx + len(op_text):].strip()
        return "", "eq", v

    @staticmethod
    def _num(x):
        try:
            return float(x)
        except (TypeError, ValueError):
            return None

    def _compare(self, op: str, actual, expected) -> bool:
        if op == "contains":
            return str(expected) in str(actual)
        if op == "not_contains":
            return str(expected) not in str(actual)
        a_num, e_num = self._num(actual), self._num(expected)
        if a_num is not None and e_num is not None:
            a, e = a_num, e_num
        else:
            if op in ("gt", "gte", "lt", "lte"):
                return False
            a, e = str(actual), str(expected)
        if op == "eq":
            return a == e
        if op == "ne":
            return a != e
        if op == "gt":
            return a > e
        if op == "gte":
            return a >= e
        if op == "lt":
            return a < e
        if op == "lte":
            return a <= e
        return False

    _VALID_ASSERT_OPS = {"eq", "ne", "gt", "gte", "lt", "lte",
                         "contains", "not_contains"}

    def _check_assertions(self, case_payload: dict, status_code,
                          resp_text: str, elapsed_ms: int, log,
                          vars_map: dict = None) -> tuple:
        """逐条跑断言。返回 (ok, first_fail_msg, assert_results)。

        断言条目两种形态(兼容):
        - 结构化(新):{type, op, value}  op ∈ eq/ne/gt/gte/lt/lte/contains/not_contains
        - 文本(旧):  {type, value:"data.name 等于 张三"}  从文本里解析比较符
        期望值支持 {{var}} 引用套件内已提取变量。
        assert_results: 逐条断言明细 [{type, disp, expected, actual, ok}],
        供 Allure 结果生成「断言」步骤(显示期望值/实际值)。
        """
        assertions = case_payload.get("assertions") or []
        if not assertions:
            return True, "", []
        assert_results = []
        try:
            resp_json = json.loads(resp_text)
        except (TypeError, ValueError):
            resp_json = None
        vars_map = vars_map or {}
        for a in assertions:
            a = a or {}
            a_type = str(a.get("type") or "")
            raw = str(a.get("value") or "").strip()
            if not raw:
                continue
            # 结构化(新):{type, path, op, value};文本(旧):value 里带"等于/大于"等
            op_s = str(a.get("op") or "").strip()
            has_struct = op_s in self._VALID_ASSERT_OPS
            if has_struct:
                path = str(a.get("path") or "").strip()
                op = op_s
                expected = raw
            else:
                path, op, expected = self._parse_assert(raw)
            expected = str(self._render_vars(str(expected), vars_map))
            disp = (path + " " + op + " " + expected) if (has_struct and path) else expected
            if a_type == "状态码":
                if status_code is None:
                    continue  # socket 用例没有状态码,跳过该断言
                if has_struct and path:
                    # 填了路径:按路径取响应 JSON 字段(业务码)比较;留空才是 HTTP 状态码
                    if resp_json is not None:
                        val, found = self._extract_path(resp_json, path)
                    else:
                        val, found = None, False
                    ok = self._compare(op, val, expected) if found else False
                    actual_txt = self._actual_disp(val if found else None)
                else:
                    ok = self._compare(op, status_code, expected)
                    actual_txt = str(status_code)
            elif a_type == "响应时间":
                # 兼容旧行为:文本形态没写比较符时按"不超过"处理;结构化照选的算
                cmp_op = op if has_struct else ("lte" if op == "eq" else op)
                ok = self._compare(cmp_op, elapsed_ms, expected)
                actual_txt = "%sms" % elapsed_ms
            elif a_type in ("响应头", "Header"):
                continue  # 暂未采集响应头,跳过
            else:  # JSON / JSONPath
                if resp_json is not None:
                    val, found = self._extract_path(resp_json, path)
                else:
                    # 非 JSON 响应:无路径时对全文做比较(配合 包含/等于)
                    val, found = (resp_text, True) if not path else (None, False)
                ok = self._compare(op, val, expected) if found else False
                actual_txt = self._actual_disp(val if found else None)
            if ok:
                log(f"  断言[{a_type or 'JSON'}] {disp} → 通过")
            else:
                log(f"  断言[{a_type or 'JSON'}] {disp} → 失败(实际: {actual_txt})")
            assert_results.append({"type": a_type or "JSON", "disp": disp,
                                   "expected": expected, "actual": actual_txt,
                                   "ok": bool(ok)})
            if not ok:
                return False, (f"断言失败[{a_type or 'JSON'}] {disp}"
                               f"(实际: {actual_txt})"), assert_results
        return True, "", assert_results

    @staticmethod
    def _actual_disp(val) -> str:
        """断言失败时展示实际值,截断到 80 字符。"""
        if val is None:
            return "未取到"
        s = val if isinstance(val, str) else json.dumps(val, ensure_ascii=False)
        return s[:80] + ("..." if len(s) > 80 else "")

    # ---------------- 单用例执行 ----------------
    def _exec_socket(self, case_payload: dict, env, vars_map: dict,
                     holder: dict, timeout: int, log) -> tuple:
        """socket 用例执行。返回 (status_code, resp_text, elapsed_ms, err)

        两种模式:
        - path 以 ws:// / wss:// 开头 → 纯文本模式:直连该地址,原样收发 bodyJson
        - 否则 → Pomelo 协议模式:path 是消息路由(容错剥掉 /conn/ 前缀),
          连接地址 = 环境 BaseURL(无协议前缀自动补 ws://,支持裸 host:port);
          连接后走 Pomelo 握手,响应按 reqId 匹配,长连接套件内复用。
          注意:须直连真实 Pomelo 连接器(如 ws://IP:30310),
          H5 HTTP 网关 /conn 端点对标准握手固定回 code=400
        """
        c = case_payload.get("case") or {}
        raw_path = self._render_vars(str(c.get("path") or ""), vars_map).strip()
        base = str((env or {}).get("baseUrl") or "").strip()

        # ---------- 纯文本模式(完整 ws 地址) ----------
        if raw_path.lower().startswith(("ws://", "wss://")):
            url = raw_path
            if not url.lower().startswith(("ws://", "wss://")):
                return None, "", 0, "socket 地址必须以 ws:// 或 wss:// 开头: " + url
            try:
                import websocket
            except ModuleNotFoundError:
                return None, "", 0, "缺少依赖 websocket-client,请执行: pip install websocket-client"

            ws = holder.get("ws")
            if ws is None or holder.get("url") != url:
                if ws is not None:
                    try:
                        ws.close()
                    except Exception:
                        pass
                    holder["ws"] = None
                log("建立长连接: " + url)
                # 握手头:浏览器 WebSocket 一定带 Origin,很多网关(如 GFE)缺
                # Origin/UA 直接回 400 Bad Request,这里按浏览器惯例补齐;
                # 用例 headers 透传为握手头,可覆盖 UA/Origin 或加 token。
                ws_headers = ["User-Agent: PomeloTestPlatform/1.0"]
                m = re.match(r"^(wss?)://([^/:?]+)", url)
                if m:
                    scheme = "https" if m.group(1) == "wss" else "http"
                    ws_headers.append("Origin: " + scheme + "://" + m.group(2))
                for h in (case_payload.get("headers") or []):
                    if h and str(h.get("key") or "").strip():
                        k = str(h["key"]).strip()
                        v = self._render_vars(str(h.get("value") or ""), vars_map)
                        ws_headers = [x for x in ws_headers
                                      if not x.lower().startswith(k.lower() + ":")]
                        ws_headers.append(k + ": " + v)
                log("握手头: " + ", ".join(ws_headers))
                ws = _ws_connect(url, timeout, ws_headers, log)
                holder["ws"] = ws
                holder["url"] = url

            body = str(case_payload.get("bodyJson") or "").strip()
            send_text = self._render_vars(body if body else raw_path, vars_map)
            log("→ 发送: " + (send_text[:200] or "(空)"))
            ws.settimeout(timeout)
            t0 = time.perf_counter()
            ws.send(send_text)
            resp = ws.recv()
            elapsed_ms = int((time.perf_counter() - t0) * 1000)
            if isinstance(resp, (bytes, bytearray)):
                resp = bytes(resp).decode("utf-8", "replace")
            log("← 收到: " + str(resp)[:200])
            return None, resp, elapsed_ms, None

        # ---------- Pomelo 协议模式 ----------
        if not base:
            return None, "", 0, ("Pomelo 模式需先在执行环境配置 BaseURL"
                                 "(真实连接器写法如 172.17.110.3:30310,无协议前缀自动补 ws://),"
                                 "用例 path 填消息路由如 account.auth.login")
        # BaseURL 容错:无 ws:// / wss:// 前缀自动补 ws://(支持裸 host:port 写法)。
        # 注意:H5 HTTP 网关的 /conn 端点不是标准 Pomelo 连接器(握手固定回 code=400),
        # 须直连真实连接器的纯 host:port。
        if not base.lower().startswith(("ws://", "wss://")):
            base = "ws://" + base
        m = re.match(r"^(wss?)://([^/]+)(/.*)?$", base, re.I)
        if not m:
            return None, "", 0, "环境 BaseURL 无法解析: " + base
        conn_path = (m.group(3) or "").rstrip("/")
        # 用例 path 为消息路由,容错剥掉历史遗留的 /conn/ 前缀
        route = raw_path
        for pre in ("/conn/", "conn/"):
            if route.lower().startswith(pre):
                route = route[len(pre):]
                break
        route = route.lstrip("/")
        if not route:
            return None, "", 0, "用例 path 为空,Pomelo 模式需填消息路由"
        conn_url = m.group(1) + "://" + m.group(2) + conn_path

        sess = holder.get("pomelo")
        if sess is None or holder.get("pomelo_url") != conn_url:
            if sess is not None:
                sess.close()
                holder["pomelo"] = None
            log("建立 Pomelo 长连接: " + conn_url)
            # 握手头(Origin/UA 同文本模式;用例 headers 透传)
            hs_headers = ["User-Agent: PomeloTestPlatform/1.0"]
            ms = re.match(r"^(wss?)://([^/:?]+)", conn_url)
            if ms:
                hs_headers.append("Origin: " +
                                  ("https" if ms.group(1) == "wss" else "http") +
                                  "://" + ms.group(2))
            for h in (case_payload.get("headers") or []):
                if h and str(h.get("key") or "").strip():
                    k = str(h["key"]).strip()
                    v = self._render_vars(str(h.get("value") or ""), vars_map)
                    hs_headers = [x for x in hs_headers
                                  if not x.lower().startswith(k.lower() + ":")]
                    hs_headers.append(k + ": " + v)
            sess = PomeloSession(conn_url, timeout, hs_headers, log)
            holder["pomelo"] = sess
            holder["pomelo_url"] = conn_url

        body = str(case_payload.get("bodyJson") or "").strip()
        if body:
            try:
                msg_dict = json.loads(self._render_vars(body, vars_map))
            except ValueError:
                return None, "", 0, "bodyJson 不是合法 JSON: " + body[:120]
            if not isinstance(msg_dict, dict):
                return None, "", 0, "Pomelo 请求体必须是 JSON 对象(键值对)"
        else:
            msg_dict = {}
        log("→ [" + route + "] " + json.dumps(msg_dict, ensure_ascii=False)[:200])
        resp_text, elapsed_ms = sess.request(route, msg_dict)
        log("← " + str(resp_text)[:200])
        return None, resp_text, elapsed_ms, None

    def _exec_http(self, case_payload: dict, env, vars_map: dict,
                   timeout: int, log) -> tuple:
        """http 用例:urllib 直连。返回 (status_code, resp_text, elapsed_ms, err)"""
        c = case_payload.get("case") or {}
        method = str(c.get("method") or "GET").upper()
        raw_path = self._render_vars(str(c.get("path") or ""), vars_map)
        base = str((env or {}).get("baseUrl") or "").strip()
        url = raw_path
        if base and not raw_path.lower().startswith(("http://", "https://")):
            url = base.rstrip("/") + (raw_path if raw_path.startswith("/") else "/" + raw_path)

        params = [p for p in (case_payload.get("params") or []) if (p or {}).get("key")]
        if params:
            qs = urlencode([
                (self._render_vars(str(p["key"]), vars_map),
                 self._render_vars(str(p.get("value") or ""), vars_map))
                for p in params
            ])
            url += ("&" if "?" in url else "?") + qs

        headers = {}
        for h in (case_payload.get("headers") or []):
            if h and str(h.get("key") or "").strip():
                headers[str(h["key"]).strip()] = self._render_vars(
                    str(h.get("value") or ""), vars_map)

        body = None
        body_json = str(case_payload.get("bodyJson") or "").strip()
        if body_json:
            body = self._render_vars(body_json, vars_map).encode("utf-8")
            headers.setdefault("Content-Type", "application/json")

        req = urllib.request.Request(
            url,
            data=body if method not in ("GET", "HEAD") else None,
            headers=headers,
            method=method,
        )
        log(f"请求: {method} {url}")
        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                status = resp.status
                text = resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            status = e.code
            try:
                text = e.read().decode("utf-8", "replace")
            except Exception:
                text = ""
        except Exception as e:
            return None, "", int((time.perf_counter() - t0) * 1000), f"请求失败: {e}"
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        log(f"响应: HTTP {status} ({elapsed_ms}ms) " + text[:160])
        return status, text, elapsed_ms, None

    def _exec_one_case(self, case_payload: dict, env, vars_map: dict,
                       holder: dict, timeout: int, log) -> tuple:
        """执行单条用例。返回 (status, message, elapsed_ms, detail)

        detail 携带渲染后的实际请求目标/请求体/响应,供 Allure 报告展示
        接口详情(steps + attachments);即使失败也尽量带上请求侧信息。
        """
        c = case_payload.get("case") or {}
        protocol = str(c.get("protocol") or "socket").lower()
        base = str((env or {}).get("baseUrl") or "").strip()
        raw_path = self._render_vars(str(c.get("path") or ""), vars_map).strip()
        req_body = self._render_vars(
            str(case_payload.get("bodyJson") or ""), vars_map).strip()

        # 请求目标(与 _exec_socket/_exec_http 内部寻址规则一致,仅用于展示)
        if protocol == "http":
            method = str(c.get("method") or "GET").upper()
            if raw_path.lower().startswith(("http://", "https://")) or not base:
                target = method + " " + raw_path
            else:
                target = method + " " + base.rstrip("/") + "/" + raw_path.lstrip("/")
        elif raw_path.lower().startswith(("ws://", "wss://")):
            target = raw_path                     # 纯文本 WebSocket 模式
        elif base:
            target = base + "  路由: " + raw_path.lstrip("/")
        else:
            target = raw_path

        detail = {"protocol": protocol, "target": target,
                  "request": req_body, "status_code": "", "response": ""}
        try:
            if protocol == "http":
                status_code, resp_text, elapsed_ms, err = self._exec_http(
                    case_payload, env, vars_map, timeout, log)
            else:
                status_code, resp_text, elapsed_ms, err = self._exec_socket(
                    case_payload, env, vars_map, holder, timeout, log)
        except Exception as e:
            return "failed", f"执行异常: {e}", 0, detail
        detail["status_code"] = "" if status_code is None else str(status_code)
        detail["response"] = str(resp_text or "")[:8000]
        if err:
            return "failed", err, elapsed_ms or 0, detail

        ok, msg, assert_results = self._check_assertions(case_payload,
                                                         status_code,
                                                         resp_text, elapsed_ms,
                                                         log, vars_map)
        detail["assertions"] = assert_results
        if not ok:
            return "failed", msg, elapsed_ms, detail

        # 提取变量:供后续用例 {{var}} 引用(套件内共享)
        for e in (case_payload.get("extract") or []):
            e = e or {}
            name = str(e.get("name") or "").strip()
            expr = str(e.get("expr") or "").strip()
            if not name:
                continue
            try:
                resp_json = json.loads(resp_text)
            except (TypeError, ValueError):
                resp_json = resp_text
            val, found = self._extract_path(resp_json, expr)
            vars_map[name] = val if found else ""
            log(f"  提取变量 {name} = " + (str(val)[:80] if found else "(未命中)"))
        return "passed", "", elapsed_ms, detail

    # ---------------- Allure 结果导出 ----------------
    def _write_allure_results(self, case_results: list, suite_name: str,
                              suite_file: str, env_key: str,
                              total: int, passed: int, failed: int,
                              skipped: int, report_no: str = "") -> str:
        """把一次套件执行写成 Allure 标准结果目录。

        按报告号归档:data/allure-results/<reportNo>/,历史报告各有各的
        结果,点历史行的「Allure」打开的是那一次执行的数据(不再被最近
        一次覆盖)。report_no 为空时回落老布局 data/allure-results/(仅
        兼容保留,正常链路都带报告号)。

        目录内每条用例一个 <uuid>-result.json(Allure 2 规范),外加
        environment.properties 记录本次执行环境。
        返回结果目录绝对路径;失败返回 ""。
        """
        if report_no:
            out_dir = os.path.join(self.get_data_dir(),
                                   "allure-results", str(report_no))
        else:
            out_dir = os.path.join(self.get_data_dir(), "allure-results")
        try:
            os.makedirs(out_dir, exist_ok=True)
            if not report_no:
                # 老布局:清空旧结果,保持"最近一次"语义
                for fn in os.listdir(out_dir):
                    fp = os.path.join(out_dir, fn)
                    if os.path.isfile(fp):
                        try:
                            os.remove(fp)
                        except OSError:
                            pass
        except OSError:
            return ""

        started_ms = int(time.time() * 1000)
        for cr in case_results:
            status = str(cr.get("status") or "unknown")
            message = str(cr.get("message") or "")
            # Allure 语义:断言失败=failed,异常/环境错误=broken
            allure_status = status
            if status == "failed" and ("执行异常" in message
                                       or "用例文件不存在" in message):
                allure_status = "broken"
            fname = str(cr.get("file") or "")
            tc_id = suite_file + "::" + (fname or str(cr.get("name") or ""))
            result_uuid = uuid.uuid4().hex
            c_start = int(cr.get("startMs") or started_ms)
            c_stop = int(cr.get("stopMs") or started_ms)

            # ---- 接口详情:实际请求目标/请求体/响应 写成附件 + 调用步骤 ----
            detail = cr.get("detail") or {}
            target = str(detail.get("target") or "")
            status_code = str(detail.get("status_code") or "")
            req_text = str(detail.get("request") or "")
            resp_text = str(detail.get("response") or "")
            attachments = []

            def _dump_att(att_name: str, ext: str, content: str, mtype: str):
                """把请求/响应内容落成结果目录里的附件文件,供 Allure 展示。"""
                if not content:
                    return
                fn = result_uuid + "-" + ext
                try:
                    with open(os.path.join(out_dir, fn), "w",
                              encoding="utf-8", newline="\n") as f:
                        f.write(content)
                    attachments.append({"name": att_name, "source": fn,
                                        "type": mtype})
                except OSError:
                    pass

            if req_text:
                try:
                    json.loads(req_text)
                    req_type = "application/json"
                except (TypeError, ValueError):
                    req_type = "text/plain"
                _dump_att("请求体", "request.json", req_text, req_type)
            if resp_text:
                try:
                    json.loads(resp_text)
                    resp_pretty = json.dumps(json.loads(resp_text),
                                             ensure_ascii=False, indent=2)
                    resp_type = "application/json"
                except (TypeError, ValueError):
                    resp_pretty, resp_type = resp_text, "text/plain"
                _dump_att("响应体", "response.txt", resp_pretty, resp_type)

            steps = []
            if target or req_text or resp_text:
                steps.append({
                    "name": "接口调用",
                    "status": allure_status,
                    "statusDetails": {"message": message, "trace": ""},
                    "stage": "finished",
                    "start": c_start,
                    "stop": c_stop,
                    "parameters": ([{"name": "地址", "value": target[:300]}]
                                   if target else []),
                    "attachments": [],
                })
            # 断言步骤:每条断言一个 step,期望值/实际值以参数展示
            for ar in (detail.get("assertions") or []):
                a_ok = bool(ar.get("ok"))
                steps.append({
                    "name": ("断言通过: " if a_ok else "断言失败: ")
                            + str(ar.get("disp") or ""),
                    "status": "passed" if a_ok else "failed",
                    "statusDetails": {
                        "message": "" if a_ok else
                        "期望值: %s / 实际值: %s" % (ar.get("expected"),
                                                  ar.get("actual")),
                        "trace": "",
                    },
                    "stage": "finished",
                    "start": c_start,
                    "stop": c_stop,
                    "parameters": [
                        {"name": "期望值", "value": str(ar.get("expected") or "")[:300]},
                        {"name": "实际值", "value": str(ar.get("actual") or "")[:300]},
                    ],
                    "attachments": [],
                })

            parameters = [{"name": "环境", "value": str(env_key or "default")}]
            if str(cr.get("protocol") or ""):
                parameters.append({"name": "协议",
                                   "value": str(cr.get("protocol"))})
            if target:
                parameters.append({"name": "地址", "value": target[:300]})
            if status_code:
                parameters.append({"name": "状态码", "value": status_code})

            result = {
                "uuid": result_uuid,
                "historyId": hashlib.md5(tc_id.encode("utf-8")).hexdigest(),
                "testCaseId": tc_id,
                "name": str(cr.get("name") or "未命名用例"),
                "fullName": suite_name + " / " + str(cr.get("name") or ""),
                "status": allure_status,
                "statusDetails": {"message": message, "trace": ""},
                "stage": "finished",
                "start": c_start,
                "stop": c_stop,
                "labels": [
                    {"name": "suite",       "value": suite_name},
                    {"name": "parentSuite", "value": "Pomelo 接口测试平台"},
                    {"name": "subSuite",    "value": suite_file},
                    {"name": "epic",        "value": "Pomelo 接口测试平台"},
                    {"name": "feature",     "value": suite_name},
                    {"name": "story",       "value": str(cr.get("protocol") or "socket")},
                    {"name": "thread",      "value": "main"},
                    {"name": "host",        "value": socket.gethostname()},
                    {"name": "language",    "value": "python"},
                    {"name": "framework",   "value": "pomelo-requests"},
                    {"name": "severity",    "value": "normal"},
                    {"name": "protocol",    "value": str(cr.get("protocol") or "socket")},
                ],
                "parameters": parameters,
                "links": [],
                "attachments": attachments,
                "steps": steps,
                "description": str(cr.get("path") or ""),
            }
            fp = os.path.join(out_dir, result_uuid + "-result.json")
            try:
                # ensure_ascii=True:全文件纯 ASCII,规避 Allure(Java)在中文
                # Windows 上按 GBK/ISO-8859-1 误读 UTF-8 导致的乱码
                with open(fp, "w", encoding="utf-8", newline="\n") as f:
                    json.dump(result, f, ensure_ascii=True, indent=2)
            except OSError:
                return ""

        # environment.properties:Allure 报告环境面板数据源。
        # Java Properties 固定按 ISO-8859-1 读,非 ASCII 必须 \uXXXX 转义,
        # 否则面板里中文全部变乱码(截图里 Suite=ç»»å½ 的根因)。
        def _props_escape(text: str) -> str:
            out = []
            for ch in str(text):
                o = ord(ch)
                if ch == "\\":
                    out.append("\\\\")
                elif 32 <= o < 127:
                    out.append(ch)
                else:
                    out.append("\\u%04x" % o)
            return "".join(out)

        env_lines = [
            "Environment=" + _props_escape(str(env_key or "default")),
            "Suite=" + _props_escape(suite_name),
            "StartedAt=" + time.strftime("%Y-%m-%d %H:%M:%S"),
            "Total=%d" % total,
            "Passed=%d" % passed,
            "Failed=%d" % failed,
            "Skipped=%d" % skipped,
        ]
        try:
            with open(os.path.join(out_dir, "environment.properties"),
                      "w", encoding="utf-8", newline="\n") as f:
                f.write("\n".join(env_lines) + "\n")
        except OSError:
            pass
        return out_dir

    def open_allure_dir(self, report_no: str = "") -> dict:
        """在资源管理器里打开 Allure 结果目录(报告页按钮)。

        带报告号开 data/allure-results/<reportNo>/;不带则开最近一次
        (结果子目录里最新的一个,没有子目录回落老布局根目录)。
        """
        if _is_remote_call():
            return {"ok": False,
                    "error": "该功能只能在运行本工具的电脑上使用(打开本机文件夹)"}
        root = os.path.join(self.get_data_dir(), "allure-results")
        if report_no and os.path.isdir(os.path.join(root, str(report_no))):
            out_dir = os.path.join(root, str(report_no))
        else:
            subdirs = [d for d in os.listdir(root)
                       if os.path.isdir(os.path.join(root, d))
                       and d != "history"] if os.path.isdir(root) else []
            if subdirs:
                out_dir = os.path.join(root, max(subdirs))
            elif os.path.isdir(root) and any(
                    fn.endswith("-result.json") for fn in os.listdir(root)):
                out_dir = root
            else:
                return {"ok": False, "error": "还没有 Allure 结果:先执行一次套件"}
        try:
            _open_path(out_dir)    # 资源管理器 / Finder
            return {"ok": True, "path": out_dir}
        except Exception as e:
            return {"ok": False, "error": "打开目录失败: " + str(e)}

    # ---------------- Allure HTML 报告 ----------------
    def _find_allure_cli(self) -> str:
        """定位 allure 命令行。Windows 下 which('allure') 可能拿到无扩展名的
        bash 脚本(WinError 193),所以优先找 allure.bat/.cmd,再回落 .exe。

        查找顺序:
        1. 程序目录(打包后 exe/.app 同级)tools/allure-commandline/bin/ 下的
           便携版 —— 目标电脑无需安装 allure、无需配 PATH,解压到包旁边即可;
        2. 系统 PATH(开发机常规安装)。

        平台差异只在文件名:Windows 是 allure.bat/.cmd/.exe,macOS 是无扩展名
        的 shell 脚本 allure。见 _ALLURE_BIN_NAMES。
        """
        # 便携根目录:frozen 时取可执行文件所在目录(macOS 的 .app 里就是
        # Contents/MacOS,与 tools/ 同级);源码态取项目根。
        roots = []
        if getattr(sys, "frozen", False):
            roots.append(os.path.dirname(sys.executable))
        roots.append(os.path.dirname(os.path.abspath(__file__)))
        for root in roots:
            for cand in _ALLURE_BIN_NAMES:
                p = os.path.join(root, "tools", "allure-commandline",
                                 "bin", cand)
                if os.path.isfile(p):
                    return p
        for cand in _ALLURE_BIN_NAMES:
            cli = shutil.which(cand)
            if cli:
                return cli
        # Windows 上 which 可能返回无扩展名的 bash 脚本(WinError 193),
        # 同目录补一个可执行的 .bat/.cmd 再试
        plain = shutil.which("allure")
        if plain and IS_WIN:
            for ext in (".bat", ".cmd", ".exe"):
                if os.path.isfile(plain + ext):
                    return plain + ext
        return plain or ""

    @staticmethod
    def _bundled_jre() -> str:
        """找打包时随身携带的便携 JRE:程序目录(或项目根)tools/jre/。

        allure 命令行本质是 Java 程序,启动脚本先找 JAVA_HOME 再找 PATH 里的
        java。目标电脑什么都没装时,只要打包目录带一份 tools/jre,这里把它
        注入子进程环境即可全自包含。找不到返回 ""(回落系统 Java)。

        两种目录结构都要认 —— 返回的必须是真正的 JAVA_HOME:
        - Windows:<jre>/bin/java.exe
        - macOS:  <jre>/Contents/Home/bin/java(OpenJDK 归档解压后多一层
          Contents/Home,JAVA_HOME 要指到那一层,指 <jre> 本身 java 找不到)
        也兼容被打平的 <jre>/bin/java。
        """
        roots = []
        if getattr(sys, "frozen", False):
            roots.append(os.path.dirname(sys.executable))
        roots.append(os.path.dirname(os.path.abspath(__file__)))
        for root in roots:
            base = os.path.join(root, "tools", "jre")
            for home in (os.path.join(base, "Contents", "Home"), base):
                if (os.path.isfile(os.path.join(home, "bin", "java"))
                        or os.path.isfile(os.path.join(home, "bin", "java.exe"))):
                    return home
        return ""

    def _allure_generate(self, report_no: str = "") -> dict:
        """用 allure CLI 把结果目录生成静态 HTML 报告。

        按报告号归档:data/allure-results/<reportNo> → data/allure-report/<reportNo>;
        report_no 为空回落老布局(最近一次)。生成前把该报告旧 HTML 的
        history/ 拷回结果目录(Allure 惯例),保证趋势图/重试统计累积。
        返回 {ok, path|error}。
        """
        if report_no:
            results_dir = os.path.join(self.get_data_dir(),
                                       "allure-results", str(report_no))
            report_dir = os.path.join(self.get_data_dir(),
                                      "allure-report", str(report_no))
        else:
            results_dir = os.path.join(self.get_data_dir(), "allure-results")
            report_dir = os.path.join(self.get_data_dir(), "allure-report")
        if not os.path.isdir(results_dir) or not any(
                fn.endswith("-result.json") for fn in os.listdir(results_dir)):
            return {"ok": False, "error": "还没有 Allure 结果:先执行一次套件"}
        cli = self._find_allure_cli()
        if not cli:
            return {"ok": False, "error": ("未找到 allure 命令行:请把 allure-commandline "
                                           "解压到程序目录 tools/ 下,或将 allure/bin 加入 PATH")}

        # 趋势历史:旧报告 history → 结果目录(下次 generate 会带入新报告)
        try:
            old_hist = os.path.join(report_dir, "history")
            new_hist = os.path.join(results_dir, "history")
            if os.path.isdir(old_hist):
                shutil.copytree(old_hist, new_hist, dirs_exist_ok=True)
        except Exception:
            pass  # 历史拷贝失败只影响趋势,不阻塞报告生成

        cmd = [cli, "generate", results_dir, "-o", report_dir, "--clean"]
        # .bat/.cmd 不是可执行文件,必须经 cmd 解释器;macOS 的 allure 是
        # 带执行位的 shell 脚本,直接 exec(加 cmd /c 反而会找不到 cmd)
        if IS_WIN and cli.lower().endswith((".bat", ".cmd")):
            cmd = ["cmd", "/c"] + cmd
        # 便携 JRE:打包目录 tools/jre 存在时注入子进程环境,
        # allure.bat 优先读 JAVA_HOME,从而目标电脑零安装也能生成报告
        run_env = os.environ.copy()
        jre = self._bundled_jre()
        if jre:
            run_env["JAVA_HOME"] = jre
            run_env["PATH"] = os.path.join(jre, "bin") + os.pathsep + run_env.get("PATH", "")
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True,
                timeout=180, cwd=self.get_data_dir(), env=run_env,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "allure generate 超时(180s)"}
        except Exception as e:
            return {"ok": False, "error": "allure generate 启动失败: " + str(e)}
        if proc.returncode != 0:
            return {"ok": False,
                    "error": "allure generate 失败: " + (proc.stderr or proc.stdout or "").strip()[:300]}
        return {"ok": True, "path": os.path.join(report_dir, "index.html")}

    def open_allure_report(self, report_no: str = "") -> dict:
        """生成(或刷新)Allure HTML 报告,用本地 HTTP 服务打开。

        ⚠ 不能用 os.startfile(index.html)(file:// 协议):Allure 报告靠 AJAX
        加载 data/*.json,浏览器对 file:// 一律拦 CORS,页面永远 Loading。
        把 data/allure-report 挂到 127.0.0.1 随机端口(daemon 线程,复用),
        打开 http://127.0.0.1:port/<reportNo>/index.html。

        带报告号:生成/打开那一次执行的报告(历史行「Allure」按钮);
        不带:打开最近一次。旧报告(按报告号归档功能上线前生成的)没有
        独立结果目录,明确提示不可回看。
        """
        if report_no:
            res_dir = os.path.join(self.get_data_dir(),
                                   "allure-results", str(report_no))
            if not os.path.isdir(res_dir) or not any(
                    fn.endswith("-result.json")
                    for fn in os.listdir(res_dir)):
                return {"ok": False,
                        "error": "该报告没有可回看的 Allure 结果"
                                 "(归档功能上线前生成的旧报告)"}
        else:
            # 不带报告号 = 打开最近一次:取结果子目录里最大的报告号
            root = os.path.join(self.get_data_dir(), "allure-results")
            subdirs = []
            if os.path.isdir(root):
                subdirs = [d for d in os.listdir(root)
                           if os.path.isdir(os.path.join(root, d))
                           and d != "history"
                           and any(fn.endswith("-result.json") for fn in
                                   os.listdir(os.path.join(root, d)))]
            if subdirs:
                report_no = max(subdirs)
            # 没有子目录则回落老布局根目录(兼容旧数据)
        gen = self._allure_generate(str(report_no or ""))
        if not gen.get("ok"):
            return gen
        rel = ("%s/%s/index.html" % (ALLURE_URL_PREFIX, str(report_no))
               if report_no else (ALLURE_URL_PREFIX + "/index.html"))

        # 局域网浏览器调用:不能在本机弹浏览器,把相对地址交回前端 window.open
        if _is_remote_call():
            return {"ok": True, "url": rel, "remote": True}

        # 桌面窗口调用:开本机默认浏览器(报告由主服务同一端口托管)
        if _MAIN_PORT:
            url = "http://127.0.0.1:%d%s" % (_MAIN_PORT, rel)
            try:
                _open_path(url)    # 默认浏览器打开
                return {"ok": True, "path": url}
            except Exception as e:
                return {"ok": False, "error": "打开浏览器失败: " + str(e) + "(" + url + ")"}

        # 主服务端口未知(异常情况)才回落到独立报告服务
        report_root = os.path.join(self.get_data_dir(), "allure-report")
        try:
            port = self._ensure_allure_server(report_root)
        except Exception as e:
            return {"ok": False, "error": "本地报告服务启动失败: " + str(e)}
        url = ("http://127.0.0.1:%d/%s/index.html" % (port, str(report_no))
               if report_no else
               "http://127.0.0.1:%d/index.html" % port)
        try:
            _open_path(url)        # 默认浏览器打开
            return {"ok": True, "path": url}
        except Exception as e:
            return {"ok": False, "error": "打开浏览器失败: " + str(e) + "(" + url + ")"}

    def _ensure_allure_server(self, report_dir: str) -> int:
        """启动(或复用)托管 Allure 报告根目录的本地静态服务,返回端口。

        docroot 固定为 data/allure-report,各历史报告以子路径
        /<reportNo>/index.html 访问,同一个服务承载全部报告,
        切换报告不用重启。目录变了(异常情况)才重建。
        """
        try:
            os.makedirs(report_dir, exist_ok=True)
        except OSError:
            pass
        httpd = getattr(self, "_allure_httpd", None)
        if httpd is not None:
            alive = getattr(httpd, "socket", None) is not None
            same = getattr(self, "_allure_httpd_dir", "") == report_dir
            if alive and same:
                return httpd.server_address[1]
            try:
                httpd.shutdown()
            except Exception:
                pass
            self._allure_httpd = None
        port = find_free_port()
        handler = functools.partial(http.server.SimpleHTTPRequestHandler,
                                    directory=report_dir)
        httpd = QuietHTTPServer(("127.0.0.1", port), handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self._allure_httpd = httpd
        self._allure_httpd_dir = report_dir
        return port

    # ---------------- 后台执行线程 ----------------
    def _run_suite_worker(self, suite_file: str, env_key: str,
                          retry: int, timeout: int) -> None:
        stopped = False
        total = passed = failed = skipped = 0
        t0 = time.perf_counter()
        started_at = time.strftime("%Y-%m-%d %H:%M:%S")
        case_results = []                    # 供报告落盘的逐用例结果
        sinfo = {}                           # 套件元信息(读盘失败时保底空 dict)
        suite_ok = False                     # 套件是否成功读盘(决定是否落报告)
        holder = {"ws": None, "url": None}   # 套件级长连接
        vars_map = {}                        # 套件内共享的提取变量
        try:
            suite_payload = self._read_suite(suite_file)
            if not suite_payload:
                self._push_event({"type": "error",
                                  "message": f"找不到套件文件: data/suites/{suite_file}.json"})
                return
            sinfo = suite_payload.get("suite") or {}
            suite_ok = True
            refs = suite_payload.get("cases") or []
            env = None
            for e in self._read_envs():
                if str(e.get("key") or "") == str(env_key):
                    env = e
                    break
            total = len(refs)
            self._push_event({"type": "start", "total": total,
                              "suite": sinfo.get("name") or suite_file})
            log = lambda text: self._push_event(
                {"type": "log", "text": "[" + time.strftime("%H:%M:%S") + "] " + str(text)})
            log(f"开始执行套件「{sinfo.get('name') or suite_file}」:"
                f"共 {total} 条用例,环境「{env_key or '默认'}」,重试 {retry} 次,超时 {timeout}s")

            for i, ref in enumerate(refs):
                if self._run_stop is not None and self._run_stop.is_set():
                    stopped = True
                    break
                fname = str((ref or {}).get("file") or "")
                case_payload = self._load_case_by_file(fname)
                name = str((ref or {}).get("name") or fname)
                if not case_payload:
                    failed += 1
                    now_ms = int(time.time() * 1000)
                    log(f"✗ [{i + 1}/{total}] {name} - 用例文件不存在: {fname}")
                    case_results.append({"index": i + 1, "name": name, "path": "",
                                         "protocol": "", "status": "failed",
                                         "elapsedMs": 0, "message": "用例文件不存在",
                                         "file": fname,
                                         "startMs": now_ms, "stopMs": now_ms})
                    self._push_event({"type": "case_result", "index": i + 1, "name": name,
                                      "status": "failed", "elapsed_ms": 0,
                                      "message": "用例文件不存在"})
                    continue
                cinfo = case_payload.get("case") or {}
                name = str(cinfo.get("name") or name)
                if str(cinfo.get("state") or "on") == "off":
                    skipped += 1
                    now_ms = int(time.time() * 1000)
                    log(f"⊙ [{i + 1}/{total}] {name} - 已停用,跳过")
                    case_results.append({"index": i + 1, "name": name,
                                         "path": str(cinfo.get("path") or ""),
                                         "protocol": str(cinfo.get("protocol") or "socket"),
                                         "status": "skipped", "elapsedMs": 0,
                                         "message": "已停用", "file": fname,
                                         "startMs": now_ms, "stopMs": now_ms})
                    self._push_event({"type": "case_result", "index": i + 1, "name": name,
                                      "status": "skipped", "elapsed_ms": 0,
                                      "message": "已停用"})
                    continue

                self._push_event({"type": "case_start", "index": i + 1, "name": name})
                proto = str(cinfo.get("protocol") or "socket").upper()
                log(f"▶ [{i + 1}/{total}] {name} ({proto})")

                status, message, elapsed_ms = "failed", "", 0
                case_detail = {}                       # 接口详情(供 Allure 展示)
                case_t0_ms = int(time.time() * 1000)   # Allure 用例起始时刻
                for attempt in range(1, retry + 2):
                    if self._run_stop is not None and self._run_stop.is_set():
                        stopped = True
                        break
                    if attempt > 1:
                        log(f"  第 {attempt} 次尝试(失败重试)...")
                    status, message, elapsed_ms, case_detail = self._exec_one_case(
                        case_payload, env, vars_map, holder, timeout, log)
                    if status == "passed":
                        break
                case_t1_ms = int(time.time() * 1000)   # Allure 用例结束时刻
                if stopped:
                    break
                if status == "passed":
                    passed += 1
                else:
                    failed += 1
                log(("✓ " if status == "passed" else "✗ ") +
                    f"[{i + 1}/{total}] {name}" +
                    (f" - {message}" if message else "") + f" ({elapsed_ms}ms)")
                case_results.append({"index": i + 1, "name": name,
                                     "path": str(cinfo.get("path") or ""),
                                     "protocol": str(cinfo.get("protocol") or "socket"),
                                     "status": status, "elapsedMs": elapsed_ms,
                                     "message": message, "file": fname,
                                     "detail": case_detail,
                                     "startMs": case_t0_ms, "stopMs": case_t1_ms})
                self._push_event({"type": "case_result", "index": i + 1, "name": name,
                                  "status": status, "elapsed_ms": elapsed_ms,
                                  "message": message})
        finally:
            ws = holder.get("ws")
            if ws is not None:
                try:
                    ws.close()
                except Exception:
                    pass
            elapsed_ms = int((time.perf_counter() - t0) * 1000)
            # 报告落盘:data/reports/<reportNo>.json,前端报告页从这里读真实数据
            # (套件本身读盘失败时不落报告,避免产生空报告)
            report_no = time.strftime("%Y%m%d%H%M%S") if suite_ok else ""
            if suite_ok:
                try:
                    sv = self.save_json("reports", report_no, {
                        "report": {
                            "reportNo": report_no,
                            "suite": sinfo.get("name") or suite_file,
                            "suiteFile": suite_file,
                            "env": env_key,
                            "startedAt": started_at,
                            "finishedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
                            "elapsedMs": elapsed_ms,
                            "total": total, "passed": passed,
                            "failed": failed, "skipped": skipped,
                            "stopped": stopped,
                        },
                        "cases": case_results,
                    })
                    if not (sv and sv.get("ok")):
                        report_no = ""
                        self._push_event({"type": "log",
                                          "text": "[" + time.strftime("%H:%M:%S") + "] "
                                          + "报告落盘失败: " + str((sv or {}).get("error"))})
                except Exception as e:
                    report_no = ""
                    self._push_event({"type": "log",
                                      "text": "[" + time.strftime("%H:%M:%S") + "] "
                                      + "报告落盘异常: " + str(e)})
            # Allure 结果导出:data/allure-results/<reportNo>/(按报告号归档,
            # 历史报告可回看;allure generate 输出 data/allure-report/<reportNo>/)
            if suite_ok and case_results:
                try:
                    allure_dir = self._write_allure_results(
                        case_results, sinfo.get("name") or suite_file,
                        suite_file, env_key, total, passed, failed, skipped,
                        report_no=report_no)
                    if allure_dir:
                        self._push_event({"type": "log",
                                          "text": "[" + time.strftime("%H:%M:%S") + "] "
                                          + "Allure 结果已导出: " + os.path.relpath(allure_dir)})
                        self._push_event({"type": "allure", "dir": allure_dir})
                        # 自动刷新该报告的 HTML(有 allure CLI 才做,失败静默)
                        gen = self._allure_generate(report_no)
                        if gen.get("ok"):
                            self._push_event({"type": "log",
                                              "text": "[" + time.strftime("%H:%M:%S") + "] "
                                              + "Allure HTML 报告已更新(data/allure-report),"
                                              + "报告页「查看 Allure 报告」可打开"})
                        else:
                            self._push_event({"type": "log",
                                              "text": "[" + time.strftime("%H:%M:%S") + "] "
                                              + "Allure HTML 报告未更新: " + str(gen.get("error"))})
                    else:
                        self._push_event({"type": "log",
                                          "text": "[" + time.strftime("%H:%M:%S") + "] "
                                          + "Allure 结果导出失败(目录不可写?)"})
                except Exception as e:
                    self._push_event({"type": "log",
                                      "text": "[" + time.strftime("%H:%M:%S") + "] "
                                      + "Allure 导出异常: " + str(e)})
            self._push_event({"type": "done", "total": total, "passed": passed,
                              "failed": failed, "skipped": skipped,
                              "elapsed_ms": elapsed_ms,
                              "stopped": stopped, "reportNo": report_no})
            with self._run_lock:
                self._run_busy = False


# ============================================================
#  主入口
# ============================================================
def _window_icon() -> str:
    """窗口/任务栏图标。

    - 打包态:exe 已通过 spec 的 icon 参数内嵌图标,pywebview winforms 后端
      会自动从 sys.executable 提取,无需显式指定(返回空串);
    - 开发态:python.exe 没有业务图标,显式指向仓库里的 docs/images/icon.ico。
    - macOS:窗口/Dock 图标来自 .app 内的 icns,build 时由 PyInstaller 处理;
      运行期传 .ico 没有意义(仅 GTK/QT 后端才认 icon 参数),一律返回空串。
    """
    if getattr(sys, "frozen", False) or IS_MAC:
        return ""
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                     "docs", "images", "icon.ico")
    return p if os.path.isfile(p) else ""


def main() -> None:
    parser = argparse.ArgumentParser(description="Pomelo 接口测试平台")
    parser.add_argument(
        "--file", action="store_true",
        help="使用 file:// 直接加载本地 HTML(若 HTTP 模式异常可尝试)",
    )
    parser.add_argument(
        "--debug", action="store_true",
        help="开启调试模式(右键可 Inspect 元素)",
    )
    args = parser.parse_args()

    index_html = get_resource_path(os.path.join("web", "index.html"))
    if not os.path.isfile(index_html):
        print(f"[错误] 未找到入口页面: {index_html}")
        print("       请确认 web/ 目录与 pomelo_app.py 同级")
        sys.exit(1)

    # 选择加载方式
    httpd = None
    if args.file:
        url = index_html
        print(f"[启动] file:// 模式 -> {index_html}")
    else:
        httpd, port = start_web_server()
        url = f"http://127.0.0.1:{port}/index.html"
        print(f"[启动] HTTP 模式 -> {url}")
        if port in LAN_PORTS:
            lan_ip = get_lan_ip()
            if lan_ip:
                print(f"[局域网] 其他电脑浏览器访问 -> http://{lan_ip}:{port}/index.html")
            else:
                print(f"[局域网] 其他电脑浏览器访问 -> http://<本机IP>:{port}/index.html")
            if IS_WIN:
                print("[局域网] 首次使用需放行防火墙(管理员 PowerShell 执行一次):")
                print(f"         netsh advfirewall firewall add rule name=\"PomeloTool {port}\" "
                      f"dir=in action=allow protocol=TCP localport={port}")
            elif IS_MAC:
                # macOS 应用防火墙按「应用」放行,不是按端口。首次被拦时
                # 系统设置里会出现是否允许 PomeloTool 接受连接的弹窗。
                print("[局域网] macOS 若弹出「是否允许 PomeloTool 接受传入网络连接」请选允许;")
                print("         也可在 系统设置 → 网络 → 防火墙 → 选项 里手动放行。")
            if port != LAN_PORTS[0]:
                print(f"[提示] 端口 {LAN_PORTS[0]} 被占用,已改用备用端口 {port}")
        else:
            joined = " / ".join(str(p) for p in LAN_PORTS)
            print(f"[提示] 端口 {joined} 均被占用,已回退随机端口 {port},"
                  f"局域网访问需以此端口为准")

    api = JsApi()
    global _JS_API, _MAIN_PORT
    _JS_API = api                     # 供 HTTP RPC 反射调用
    _MAIN_PORT = (httpd.server_address[1] if httpd else 0)  # Allure 报告地址拼接

    webview.create_window(
        title="Pomelo 接口测试平台",
        url=url,
        js_api=api,
        width=1440,
        height=900,
        min_size=(1200, 720),
        resizable=True,
        background_color="#F5F7FB",
        text_select=True,
    )

    try:
        webview.start(debug=args.debug, icon=_window_icon())
    finally:
        if httpd:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    main()
