# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for Pomelo Tool (onedir, windowed)
# - entry: main.py (tiny forwarder); business logic in pomelo_app.pyd
# - web/  bundled as data  -> _internal/web  (served by built-in http server)
# - data/ NOT bundled: app creates/reads data/ next to the exe at runtime
import os

block_cipher = None

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=[],
    datas=[
        ("web", "web"),
    ],
    hiddenimports=[
        "webview",
        "webview.platforms.edgechromium",
        "webview.platforms.winforms",
        "websocket",
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
    ],
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
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # exe 图标(资源管理器/任务栏/窗口标题栏)
    icon=os.path.join(SPECPATH, "docs", "images", "icon.ico"),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="PomeloTool",
)
