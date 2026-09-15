# -*- coding: utf-8 -*-
"""打包入口:仅一行转发,业务逻辑在 pomelo_app(Cython 编译为 .pyd 后源码不入包)。"""
from pomelo_app import main

if __name__ == "__main__":
    main()
