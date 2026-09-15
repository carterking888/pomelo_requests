# -*- coding: utf-8 -*-
"""Cython compile business modules (run: python setup_pyd.py build_ext --inplace)

pomelo_app.py -> pomelo_app.*.pyd (Windows) / pomelo_app.*.so (macOS)
                 (source code never enters the package)
main.py stays as .py (it is the exe entry, a single-line forwarder with no secrets).

Windows 走 MSVC,由 build_pyd.bat 预先注入 INCLUDE/LIB(无需 VS 开发者命令行);
macOS 走 clang,由下面的 setup_clang_env() 补编译目标与架构参数。
"""
import os
import platform
import sys

from Cython.Build import cythonize
from setuptools import setup

MODULES = ["pomelo_app.py"]


def setup_clang_env() -> None:
    """macOS 编译环境准备(仅 darwin 生效,其它平台直接返回)。

    1. ``MACOSX_DEPLOYMENT_TARGET`` —— 不设时 clang 取 SDK 默认目标,
       arm64 上低于 11.0 会直接报错,其它情况也会刷一屏 deployment target 警告。
    2. ``ARCHFLAGS`` —— 官方 universal2 的 Python 默认按 x86_64 + arm64
       双架构编译,慢一倍;而且只要某个依赖不是 universal,链接期就报
       "file is universal but does not contain a(n) arm64|x86_64 slice"。
       本工具按机器架构分发,锁当前架构最省事。

    两者都用 setdefault,已显式设过的环境变量优先(比如要发 universal2 时)。
    """
    if sys.platform != "darwin":
        return
    machine = platform.machine() or "arm64"
    os.environ.setdefault("MACOSX_DEPLOYMENT_TARGET",
                          "11.0" if machine == "arm64" else "10.13")
    os.environ.setdefault("ARCHFLAGS", "-arch " + machine)


setup_clang_env()

setup(
    name="pomelo_pyd",
    ext_modules=cythonize(
        MODULES,
        compiler_directives={"language_level": "3"},
    ),
)
