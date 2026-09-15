# -*- coding: utf-8 -*-
"""macOS 分支的离线预检(在 Windows 上就能跑)。

为什么需要:PyInstaller 不支持交叉编译,mac 产物只能在 mac 上构建 —— 也就是
说 mac 分支的代码**只有上真 mac 才会第一次执行**。拼错变量名、路径写错、
忘了调 BUNDLE 这类低级故障,要等 CI 跑完或对方机器上才炸,一轮就是十几分钟。

本脚本把 sys.platform 临时改成 'darwin',在没有 mac 的情况下把三条最容易写错
的路径先跑一遍:

  1. exec 一遍 pomelo_tool.spec(把 Analysis/EXE/PYZ/COLLECT/BUNDLE 换成桩),
     断言:mac 下用 cocoa 而不是 winforms、没有 pythonnet 依赖、upx 关掉、
     最后**确实调用了 BUNDLE** 且 name 是 .app;
  2. 以 darwin 身份 import pyd_pack.py,断言 EXT/DIST/APP_PATH 与依赖识别逻辑;
  3. 用 ast 从 setup_pyd.py 里抠出 setup_clang_env 单独执行 —— 不能直接
     import,模块末尾的 setup(...) 会真的触发 cythonize 编译。

用法:  python _mac_dryrun_check.py
"""
import ast
import importlib.util
import os
import sys
import types

ROOT = os.path.dirname(os.path.abspath(__file__))
FAILS = []


def check(name, ok, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + name
          + (("  | " + str(detail)) if detail else ""))
    if not ok:
        FAILS.append(name)


# ============================================================
#  1. spec:mac 分支
# ============================================================
class _Stub:
    """Analysis / EXE / PYZ / COLLECT / BUNDLE 的替身。

    返回值必须"够真":spec 里有 PYZ(a.pure, a.zipped_data) 和
    EXE(pyz, a.scripts, ...),返回字符串会直接 AttributeError。
    """

    def __init__(self, *a, **kw):
        self.pure = []
        self.scripts = []
        self.binaries = []
        self.datas = []
        self.zipfiles = []
        self.zipped_data = []
        self.name = kw.get("name", "")


def run_spec_as_mac():
    captured = {}

    def make(kind):
        def f(*a, **kw):
            captured.setdefault(kind, []).append(kw)
            return _Stub(*a, **kw)
        return f

    spec_path = os.path.join(ROOT, "pomelo_tool.spec")
    src = open(spec_path, encoding="utf-8").read()
    g = {
        "__file__": spec_path,
        "SPECPATH": ROOT,
        "Analysis": make("Analysis"),
        "EXE": make("EXE"),
        "PYZ": make("PYZ"),
        "COLLECT": make("COLLECT"),
        "BUNDLE": make("BUNDLE"),
    }
    real = sys.platform
    sys.platform = "darwin"
    try:
        exec(compile(src, spec_path, "exec"), g)   # noqa: S102
    finally:
        sys.platform = real

    analysis = captured["Analysis"][0]
    hidden = list(analysis.get("hiddenimports") or [])
    excludes = list(analysis.get("excludes") or [])
    exe_kw = captured["EXE"][0]
    coll_kw = captured["COLLECT"][0]

    print("\n[1] pomelo_tool.spec(mac 分支)")
    check("hiddenimports 含 webview.platforms.cocoa",
          "webview.platforms.cocoa" in hidden)
    for pkg in ("objc", "AppKit", "Foundation", "WebKit"):
        check("hiddenimports 含 %s" % pkg, pkg in hidden)
    check("hiddenimports 含 websocket",
          "websocket" in hidden)
    check("hiddenimports 不含 pythonnet/clr",
          not any(m in hidden for m in ("clr", "pythonnet", "clr_loader")),
          [m for m in hidden if m in ("clr", "pythonnet", "clr_loader")])
    check("hiddenimports 不含 winforms/edgechromium",
          not any("winforms" in m or "edgechromium" in m for m in hidden))
    check("excludes 排除了 clr/pythonnet",
          "clr" in excludes and "pythonnet" in excludes)
    check("EXE icon 为 None(mac 不认 .ico)", exe_kw.get("icon") is None,
          exe_kw.get("icon"))
    check("EXE upx=False", exe_kw.get("upx") is False, exe_kw.get("upx"))
    check("COLLECT upx=False", coll_kw.get("upx") is False, coll_kw.get("upx"))
    check("COLLECT name == PomeloTool", coll_kw.get("name") == "PomeloTool",
          coll_kw.get("name"))

    check("BUNDLE 被调用(不调就只有裸可执行文件,双击没反应)",
          len(captured.get("BUNDLE", [])) == 1)
    if captured.get("BUNDLE"):
        b = captured["BUNDLE"][0]
        check("BUNDLE.name 是 .app", str(b.get("name", "")).endswith(".app"),
              b.get("name"))
        check("BUNDLE.bundle_identifier 非空", bool(b.get("bundle_identifier")),
              b.get("bundle_identifier"))
        plist = b.get("info_plist") or {}
        check("info_plist 有 LSMinimumSystemVersion",
              bool(plist.get("LSMinimumSystemVersion")), plist.get("LSMinimumSystemVersion"))


# ============================================================
#  2. pyd_pack.py:以 darwin 身份加载
# ============================================================
def load_pyd_pack_as_mac():
    path = os.path.join(ROOT, "pyd_pack.py")
    spec = importlib.util.spec_from_file_location("pyd_pack_mac_under_test", path)
    mod = importlib.util.module_from_spec(spec)
    real = sys.platform
    sys.platform = "darwin"
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.platform = real
    return mod


def check_pyd_pack(mod):
    print("\n[2] pyd_pack.py(mac 分支)")
    check("EXT == 'so'", mod.EXT == "so", mod.EXT)
    check("IS_MAC 为真", mod.IS_MAC is True)
    check("DIST 指向 .app/Contents/MacOS",
          mod.DIST.replace("\\", "/").endswith("PomeloTool.app/Contents/MacOS"),
          mod.DIST)
    check("APP_PATH 是 .app",
          mod.APP_PATH.replace("\\", "/").endswith("PomeloTool.app"), mod.APP_PATH)
    check("allure 候选名是无扩展名脚本",
          "allure" in mod.ALLURE_BIN_NAMES
          and not any(n.endswith(".bat") for n in mod.ALLURE_BIN_NAMES),
          mod.ALLURE_BIN_NAMES)
    check("默认 ALLURE_SRC 落在 build_tools/",
          "build_tools" in mod.ALLURE_SRC.replace("\\", "/"), mod.ALLURE_SRC)

    # 依赖识别:合成两种 mac 目录布局
    tmp = os.path.join(ROOT, ".workbuddy", "tmp", "_mac_layout_probe")
    allure_d = os.path.join(tmp, "allure-commandline", "bin")
    jre_std = os.path.join(tmp, "jre_std", "Contents", "Home", "bin")
    jre_flat = os.path.join(tmp, "jre_flat", "bin")
    for d in (allure_d, jre_std, jre_flat):
        os.makedirs(d, exist_ok=True)
    open(os.path.join(allure_d, "allure"), "w").close()
    open(os.path.join(jre_std, "java"), "w").close()
    open(os.path.join(jre_flat, "java"), "w").close()

    check("mac:识别 bin/allure",
          mod.has_allure(os.path.join(tmp, "allure-commandline")))
    check("mac:不把 bin/allure.bat 当作存在",
          not mod.has_allure(os.path.join(tmp, "allure-commandline", "bin")))
    check("mac:识别 <jre>/Contents/Home/bin/java",
          mod.has_jre(os.path.join(tmp, "jre_std")))
    check("mac:JAVA_HOME 指向 Contents/Home(指错层 java 找不到)",
          mod.java_home(os.path.join(tmp, "jre_std"))
          .replace("\\", "/").endswith("jre_std/Contents/Home"),
          mod.java_home(os.path.join(tmp, "jre_std")))
    check("mac:兼容被打平的 <jre>/bin/java",
          mod.has_jre(os.path.join(tmp, "jre_flat")))


# ============================================================
#  3. setup_pyd.py:setup_clang_env
# ============================================================
def check_setup_clang_env():
    print("\n[3] setup_pyd.py: setup_clang_env()")
    path = os.path.join(ROOT, "setup_pyd.py")
    tree = ast.parse(open(path, encoding="utf-8").read())
    fn = next((n for n in tree.body
               if isinstance(n, ast.FunctionDef) and n.name == "setup_clang_env"),
              None)
    if fn is None:
        check("从 setup_pyd.py 里抠出 setup_clang_env", False, "函数不存在")
        return
    mod = ast.Module(body=[fn], type_ignores=[])
    ns = {"os": os, "platform": _FakePlatform, "sys": sys}
    # 从 setup_pyd.py 里抠出函数单独 exec —— 不能直接 import 整个模块,
    # 末尾的 setup(...) 会真的触发 cythonize + 编译
    real_platform = sys.platform
    real_machine = _FakePlatform.machine
    try:
        exec(compile(ast.fix_missing_locations(mod), path, "exec"), ns)  # noqa: S102
        fn_impl = ns["setup_clang_env"]

        # (a) 非 darwin 不动环境
        sys.platform = "win32"
        os.environ.pop("MACOSX_DEPLOYMENT_TARGET", None)
        os.environ.pop("ARCHFLAGS", None)
        fn_impl()
        check("非 darwin 不设置 MACOSX_DEPLOYMENT_TARGET",
              "MACOSX_DEPLOYMENT_TARGET" not in os.environ)
        check("非 darwin 不设置 ARCHFLAGS", "ARCHFLAGS" not in os.environ)

        # (b) arm64
        sys.platform = "darwin"
        _FakePlatform.machine = staticmethod(lambda: "arm64")
        os.environ.pop("MACOSX_DEPLOYMENT_TARGET", None)
        os.environ.pop("ARCHFLAGS", None)
        fn_impl()
        check("arm64 -> MACOSX_DEPLOYMENT_TARGET=11.0",
              os.environ.get("MACOSX_DEPLOYMENT_TARGET") == "11.0",
              os.environ.get("MACOSX_DEPLOYMENT_TARGET"))
        check("arm64 -> ARCHFLAGS=-arch arm64",
              os.environ.get("ARCHFLAGS") == "-arch arm64",
              os.environ.get("ARCHFLAGS"))

        # (c) x86_64
        _FakePlatform.machine = staticmethod(lambda: "x86_64")
        os.environ.pop("MACOSX_DEPLOYMENT_TARGET", None)
        os.environ.pop("ARCHFLAGS", None)
        fn_impl()
        check("x86_64 -> MACOSX_DEPLOYMENT_TARGET=10.13",
              os.environ.get("MACOSX_DEPLOYMENT_TARGET") == "10.13",
              os.environ.get("MACOSX_DEPLOYMENT_TARGET"))
        check("x86_64 -> ARCHFLAGS=-arch x86_64",
              os.environ.get("ARCHFLAGS") == "-arch x86_64",
              os.environ.get("ARCHFLAGS"))

        # (d) 已显式设置时不能覆盖(要发 universal2 时靠这个)
        os.environ["ARCHFLAGS"] = "-arch arm64 -arch x86_64"
        fn_impl()
        check("已设置的 ARCHFLAGS 不被覆盖",
              os.environ.get("ARCHFLAGS") == "-arch arm64 -arch x86_64",
              os.environ.get("ARCHFLAGS"))
    finally:
        sys.platform = real_platform
        _FakePlatform.machine = real_machine
        for k in ("MACOSX_DEPLOYMENT_TARGET", "ARCHFLAGS"):
            os.environ.pop(k, None)


class _FakePlatform:
    """setup_clang_env 只用到 platform.machine(),替身避免真读机器架构"""
    machine = staticmethod(lambda: "arm64")


# ============================================================
#  4. build_mac.sh 静态门禁
# ============================================================
def check_build_script():
    print("\n[4] build_mac.sh")
    p = os.path.join(ROOT, "build_mac.sh")
    if not os.path.isfile(p):
        check("build_mac.sh 存在", False, p)
        return
    check("build_mac.sh 存在", True)
    s = open(p, encoding="utf-8").read()
    check("带 zip -y(.app 内的软链丢了就起不来)", "zip -qry" in s)
    check("调用 --check-deps(与 pyd_pack 同一套依赖校验)",
          "--check-deps" in s)
    check("按架构选 JRE(aarch64/x64)", "aarch64" in s and "x64" in s)
    check("说明需要 xattr -cr", "xattr -cr" in s)


def main():
    print("=" * 66)
    print("macOS 分支 dry-run 预检(在 Windows 上模拟 darwin)")
    print("=" * 66)
    run_spec_as_mac()
    check_pyd_pack(load_pyd_pack_as_mac())
    check_setup_clang_env()
    check_build_script()

    print("\n" + "=" * 66)
    if FAILS:
        print("FAILED: %d 项" % len(FAILS))
        for f in FAILS:
            print("   - " + f)
        sys.exit(1)
    print("ALL PASS: mac 分支的关键路径在本地已校验"
          "(真实 .app 仍需在 mac / CI 上构建)")
    print("=" * 66)


if __name__ == "__main__":
    main()
