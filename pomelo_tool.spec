# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for Pomelo Tool (onedir / .app, windowed)
#
# - entry: main.py (tiny forwarder); business logic in pomelo_app.pyd / .so
# - web/  bundled as data  -> _internal/web  (served by built-in http server)
# - data/ NOT bundled: app creates/reads data/ next to the exe at runtime
#
# 平台差异(Windows / macOS)全在本文件里按 IS_MAC 分支,不维护两份 spec:
#   Windows: EdgeChromium/WebView2 + pythonnet(clr/_cffi_backend),产物 .exe
#   macOS  : Cocoa/WKWebView + pyobjc,产物 .app(必须 BUNDLE,否则双击没反应)
import os
import sys

IS_MAC = sys.platform == "darwin"

block_cipher = None

# ---- 运行时依赖:两端是完全不同的两套栈 ----
if IS_MAC:
    # pywebview 按平台动态 import_module('webview.platforms.' + gui),
    # 静态分析扫不到 cocoa 后端,必须显式点名;pyobjc 的 hook 偶尔漏收
    # objc/AppKit 等顶层包,一并列上。
    _runtime_imports = [
        "webview",
        "webview.platforms.cocoa",
        "objc",
        "AppKit",
        "Foundation",
        "WebKit",
        "PyObjCTools",
    ]
    # 环境里装着 pythonnet 时,PyInstaller 会顺着它把一堆 .NET dll 拖进 mac 包
    _extra_excludes = ["clr", "pythonnet", "clr_loader"]
else:
    _runtime_imports = [
        "webview",
        "webview.platforms.edgechromium",
        "webview.platforms.winforms",
        # pywebview winforms 通道:webview -> pythonnet(clr) -> clr_loader -> cffi
        # cffi 的 C 扩展 _cffi_backend 是动态导入,PyInstaller 静态分析追不到,
        # 缺了它打包产物启动即 ModuleNotFoundError: No module named '_cffi_backend'
        "_cffi_backend",
        "cffi",
        "clr",
        "pythonnet",
        "clr_loader",
        "clr_loader.netfx",
        "clr_loader.ffi",
    ]
    _extra_excludes = []

# .app 图标:有 .icns 就用,没有传 None 让 PyInstaller 用默认图标,
# 而不是因为一个不存在的路径直接把打包干挂。
_ICNS = os.path.join(SPECPATH, "docs", "images", "icon.icns")
_MAC_ICON = _ICNS if os.path.isfile(_ICNS) else None

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=[],
    datas=[
        ("web", "web"),
    ],
    hiddenimports=_runtime_imports + [
        "websocket",   # 套件执行引擎的 Socket(WebSocket)长连接客户端
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter",
        "unittest",
        "pydoc_data",
        "_interaction_check",
        "_render_check",
        "_mac_dryrun_check",
    ] + _extra_excludes,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    exclude_binaries=True,
    name="PomeloTool",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # UPX 压的是 PE 文件;Mach-O 上要么没装 upx,要么压了过不了签名校验
    upx=not IS_MAC,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # exe 图标(资源管理器/任务栏/窗口标题栏)。macOS 不认 .ico,
    # .app 的图标走下面 BUNDLE(icon=...)。
    icon=None if IS_MAC else os.path.join(SPECPATH, "docs", "images", "icon.ico"),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=not IS_MAC,
    upx_exclude=[],
    name="PomeloTool",
)

# macOS 必须再包一层 .app:
#   只 COLLECT 出来的是个裸 unix 可执行文件 —— 双击没反应、没有 Dock 图标、
#   Finder 里也认不出是应用。BUNDLE 之后才有 PomeloTool.app。
if IS_MAC:
    app = BUNDLE(
        coll,
        name="PomeloTool.app",
        icon=_MAC_ICON,
        bundle_identifier="com.pomelo.tool",
        info_plist={
            "CFBundleName": "PomeloTool",
            "CFBundleDisplayName": "Pomelo 接口测试平台",
            "CFBundleShortVersionString": os.environ.get("POMELO_VERSION", "1.0.0"),
            "CFBundleVersion": os.environ.get("POMELO_VERSION", "1.0.0"),
            "NSHighResolutionCapable": True,
            "LSMinimumSystemVersion": "11.0",
            # 局域网协作要监听本地端口,系统据此弹"是否允许接受传入连接"
            "NSLocalNetworkUsageDescription":
                "用于让同网段同事通过浏览器访问本机接口测试平台",
        },
    )
