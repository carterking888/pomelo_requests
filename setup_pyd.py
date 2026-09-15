# -*- coding: utf-8 -*-
"""Cython compile business modules to .pyd (run: python setup_pyd.py build_ext --inplace)

pomelo_app.py -> pomelo_app.*.pyd  (source code never enters the package)
main.py stays as .py (it is the exe entry, a single-line forwarder with no secrets).
"""
from Cython.Build import cythonize
from setuptools import setup

MODULES = ["pomelo_app.py"]

setup(
    name="pomelo_pyd",
    ext_modules=cythonize(
        MODULES,
        compiler_directives={"language_level": "3"},
    ),
)
