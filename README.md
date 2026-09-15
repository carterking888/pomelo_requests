# Pomelo 接口测试平台(桌面端)

基于 **PyWebView + layui + petite-vue + ECharts** 的接口测试平台桌面应用,完整复刻 6 个核心页面。

## 页面一览

| # | 路由 | 页面 | 关键内容 |
| - | ---- | ---- | -------- |
| 1 | `#/dashboard` | 仪表盘 | 4 项统计卡 + 7 日执行趋势折线图 + 通过率环形图 + 最近执行记录 + 测试项目列表 |
| 2 | `#/apicases` | 接口用例 | 项目分类 Tab + 搜索/方法/类别筛选 + 表格视图 + 分页器(共 1,286 条) |
| 3 | `#/apicases/get-user` | 用例详情 | 请求配置 / Headers / Params / Body(JSON·Form·Raw) + 右侧断言·变量·标签 |
| 4 | `#/testrun` | 测试执行 | 测试套件列表 + 环境·并发·重试·超时配置 + 实时进度条 + 终端日志(自动滚动) |
| 5 | `#/reports` | 测试报告 | 4 项总览 + 结果分布环形图 + 耗时柱状图 + 失败用例分析 + 报告历史表 |
| 6 | `#/report-detail` | 用例执行详情 | 5 项统计 + 用例执行列表(状态/耗时/失败原因) + 用例详情抽屉 |
| 7 | `#/apicases-new` | 新建用例 | 请求配置 + Headers/Params/Body/断言/变量/标签,保存落盘到 `data/cases/` |
| 8 | `#/testrun-new-suite` | 新建套件 | 名称/项目/环境/并发/重试/超时 + 用例多选,保存落盘到 `data/suites/` |

## 新增内容落盘为本地 JSON

点各页的「新增用例」/「新建套件」会进入对应表单页,保存后按**分类文件夹**写到本地:

```
data/
├── cases/     # 用例,  文件名 = 用例名
└── suites/    # 套件,  文件名 = 套件名
```

- 文件夹**不存在时自动创建**
- 中文文件名正常;`\` `/` `*` `?` 等非法字符替换为 `_`
- 名称留空时自动用时间戳命名(`20260902_012454.json`)
- `category` 只允许 `[A-Za-z0-9_-]`,杜绝路径穿越(`../../evil` → `.._.._evil.json`)
- 浏览器预览模式下没有 Python 桥,自动降级为内存存储 +
  console 输出,调用方拿到的仍是同一种 `{ok, path, error, backend}`

存储层在 `web/js/storage.js`,Python 端桥接是 `pomelo_app.py` 的
`JsApi.save_json()` / `JsApi.get_data_dir()`。

## 启动方式

### 方式一:桌面应用(推荐)

```bash
pip install -r requirements.txt
python pomelo_app.py
```

以 1440×900 窗口启动,无需浏览器。

启动后页面右上角会出现一条**访问地址条**(如 `172.17.224.71:18080`):
点击即用系统默认浏览器打开,右侧「复制」把完整地址复制走发给同事。
鼠标悬浮显示完整 URL。该入口只在起了 HTTP 服务时出现,`--file` 模式下自动隐藏。

> **端口不是写死的**:默认 18080;若 18080 已被占用(比如已经开着一个实例),
> 自动改用 **18081**;两个都被占用才回退到系统随机端口。
> 以**启动日志和页面地址条显示的为准** —— 别在前端或书签里写死 18080。

> **包名注意**:是 `pywebview`,**不是** `webview`。
> PyPI 上的 `webview` 是另一个无关的废弃包(仅 0.1.x),装了它仍会报
> `ModuleNotFoundError: No module named 'webview'`。

已验证环境:

| 组件 | 版本 | 说明 |
|---|---|---|
| Python | 3.12 | 打包产物为 `cp312` ABI,升级解释器要同步重编 |
| pywebview | 6.2.1 | 桌面窗口容器(约束见 `requirements.txt`:必须 `>=6.0,<7.0`) |
| pythonnet | 3.1.0 | pywebview 在 Windows 的依赖,pip 自动安装 |
| websocket-client | 1.6+ | 套件执行引擎的 Socket(WebSocket)长连接客户端 |
| GUI 后端 | `winforms` / `edgechromium` | 均可用;`cef` 需另装 `cefpython3`,非必需 |

### 方式二:浏览器预览

```bash
cd web && python -m http.server 8080
# 打开 http://127.0.0.1:8080
```

依赖已全部本地化到 `web/vendor/`,**离线可用**,无需联网。

## 局域网访问(多人协作)

一台机器启动,同网段的其他人**不用装 Python**,浏览器打开
`http://<你的IP>:18080/index.html` 就能正常使用(读、写、执行都行)。

- 数据读写统一走 `POST /api/rpc` 转给后端同名方法,和桌面端操作的是**同一份 `data/`**;
- 套件执行的实时日志通过 `GET /api/events`(SSE)推送给所有打开的页面;
- Allure 报告挂在主服务的 `/allure/**` 子路径下 —— 地址是相对的,远程浏览器自动解析成
  自己的 host,**服务端不需要去猜本机局域网 IP**(多网卡环境很容易猜错)。

首次使用需要**管理员权限放行防火墙**(只做一次;启动日志会按实际端口打印这条命令):

```bat
netsh advfirewall firewall add rule name="PomeloTool 18080" dir=in action=allow protocol=TCP localport=18080
```

> 如果启动时落到了 18081,规则里的端口要跟着改成 18081(启动日志里会直接给出对应命令)。

### 多人同时用之前,先知道这几条

| 行为 | 情况 |
|---|---|
| 同时打开 / 浏览 / 编辑保存 | ✅ 支持。服务端是 `ThreadingHTTPServer`,每个请求独立线程 |
| 同时执行套件 | ⚠️ **全局单任务**。同一时刻只允许一个套件在跑,第二个人点执行会提示「已有执行任务在进行中,请等待完成或先停止」 |
| 执行日志 | ⚠️ **广播**给所有页面。A 点执行时,B 若停在执行页,也会看到 A 的日志在滚动 |
| 同时改同一条用例/环境 | ⚠️ 后保存覆盖先保存 —— 没有锁,也不是协同编辑。建议约定分工,别多人改同一条 |
| 访问控制 | ⚠️ **无鉴权**。同网段任何人只要知道地址就能读写、执行、删数据,仅限可信内网 |

## 验证(改动后建议跑一次)

```bash
# 首选:不依赖 GUI 窗口,10 秒内跑完
NODE_PATH=<workspace>/node_modules node _dom_check.js   # 渲染+交互,85 项

# 可选:真实 pywebview 窗口(需要能弹窗的会话环境)
python _render_check.py        # 渲染:遍历 8 个路由抓 DOM,30 项检查
python _interaction_check.py   # 交互:筛选/抽屉/导航/视图切换/日志流/进度条,19 项检查
```

> `_dom_check.js` 需要 jsdom(仅开发期依赖,不进运行时):
>
> ```bash
> mkdir -p ~/.workbuddy/binaries/node/workspace \
>   && cd ~/.workbuddy/binaries/node/workspace && npm install jsdom
> ```

> **为什么两个都要跑**
>
> - 语法检查、Node 层 mock 校验、curl 资源 200 **都验不出渲染问题**。曾出现
>   "三样全绿但页面是空壳"(petite-vue 的 `created()` / `mounted()` 实际不会被调用,
>   导致所有 `v-for` 静默渲染 0 项)。
> - **渲染全绿也不代表交互能用**。曾出现"三个筛选器全是摆设"(`v-for` 直接绑原始数组,
>   点击只改按钮高亮)和"抽屉点了内容不联动"(详情数据是静态快照),
>   静态检查一个都发现不了。
> - 交互检查里"卡片视图"一项是针对真实缺陷补的:视图切换按钮只有表格容器有 DOM,
>   卡片视图**整个没有对应元素**,点切换后列表空白。这类"缺 DOM"问题
>   静态扫描同样看不出来,只能点一下看有没有东西。
>
> **优先用 `_dom_check.js`**。pywebview 那两个脚本会真的弹窗口,在远程桌面、
> 无交互会话、CI 里可能起不来窗口(报 `Main window failed to start`),
> 此时它们不可用。`_dom_check.js` 用 jsdom 加载同一份
> `index.html` + 同一套脚本,跑真实的 petite-vue,不依赖 GUI。
>
> **注意**:`_render_check.py` 的"空容器"检查会把类名含
> `list|grid|body|items|rows|wrap` 且无子节点、无文本的容器判为异常 —— 给数据
> 补齐空态占位时要记得,不要让容器空着(已用 `hasTags` + `无标签` 占位修掉一例)。
>
> **写 jsdom 检查脚本的三个坑**(都踩过):
>
> 1. **petite-vue 会 `removeAttribute` 掉所有指令属性**(源码里的 `_e()`)。
>    挂载后 `querySelector('[v-model="x"]')` **永远选不中**。
>    解决办法:在注入脚本【之前】快照一份 `v-model 表达式 → 元素` 的映射
>    (只对不在 `v-for` 里的绑定有效,`v-for` 的模板元素会被移出 DOM)。
> 2. **jsdom 没有排版引擎,`offsetWidth` 恒为 0**。图表初始化代码用
>    "容器宽度 > 0" 规避隐藏容器,不补 `offsetWidth` 的桩,图表永远不会 init。
> 3. **`textContent` 与 Chrome `innerText` 语义不同**:Chrome 对
>    `display:none` 元素会把 `innerText` 退化成 `textContent`,所以"空容器"判定
>    要用 `textContent`,否则会把隐藏视图里有内容的容器误判成空容器。
>
> 抓真实 DOM 才能发现前者,模拟点击才能发现后者。

## 目录结构

```
pomelo_requests/
├── pomelo_app.py               # 主入口:窗口 + 内置 HTTP 服务 + JsApi 桥 + 执行引擎
├── main.py                     # 打包入口(仅一行转发,业务逻辑在 pomelo_app.pyd)
├── requirements.txt
├── setup_pyd.py                # Cython:pomelo_app.py -> .pyd
├── pyd_pack.py                 # PyInstaller 打包 + 捆绑 allure/jre
├── pomelo_tool.spec            # PyInstaller 配置(exe 图标 / hiddenimports)
├── build_pyd.bat               # 本地一键打包
├── fix_and_check.bat           # 首启自检:解除 Web 标记 + 检查 .NET 版本
├── docs/images/                # 图标 + 截图
├── .github/workflows/          # CI 出包流水线
├── README.md
└── web/
    ├── index.html              # SPA 主页,内嵌各视图(用 v-show 切换)
    ├── css/app.css             # 全局样式(紫色主题 / 白底卡片 / 圆角 16)
    ├── vendor/                 # 本地依赖(离线可用)
    │   ├── echarts.min.js
    │   ├── petite-vue.iife.js
    │   └── layui/{css,font,layui.js}
    └── js/
        ├── bridge.js           # 局域网模式的桥:伪造 window.pywebview.api + SSE
        ├── app.js              # petite-vue 主应用 + Hash 路由 + 图表渲染守卫
        ├── modules.js          # 项目模块读写
        ├── storage.js          # 统一落盘入口(桥 / 内存降级)
        ├── mock.js             # mock 数据(可替换为后端接口)
        └── pages/              # 页面组件(每页一个文件)
            ├── dashboard.js    ├── apicases.js    ├── apidetail.js
            ├── testrun.js      ├── reports.js     ├── reportdetail.js
            ├── newcase.js      └── newsuite.js
```

## 技术要点与约定

### 数据约定
响应统一为 `{ code, result: { data, total } }`(见 README 底部"对接真实后端")。

### 三个易踩的坑(本项目已规避)

1. **petite-vue 的 `mount()` 不传参**
   `createApp(...).mount()` 不带选择器,它会扫描整个文档。传选择器会导致挂载失败。

2. **子组件方法内的 `this` 不是 root scope**
   各页面组件对象挂在 root scope 下(如 `this.dashboard`),其方法内的 `this` 是组件自身,
   **访问不到 `this.$refs`**。故图表容器统一用 `document.getElementById(id)` 取。

3. **`v-show` 隐藏时容器尺寸为 0**
   ECharts 在 `display:none` 的容器上 init 会得到 0×0 画布。
   `app.js` 中的 `paintRouteCharts()` 会轮询等待容器 `offsetWidth > 0` 后再渲染(最多 2s)。

### 模板约定
模板中**不做** `Math.*` / 嵌套三元 / 字符串拼接等复杂表达式——所有展示字段
(`absTrend`、`trendIcon`、`stateLabel`、`dotCls`、`methodCls`、`statusLabel`、`rateCls` 等)
均在 `mock.js` 中预先映射好,模板只做 `{{ field }}` 简单输出。

## 对接真实后端

把 `web/js/mock.js` 替换为接口请求即可,例如:

```js
// 替换 window.PomeloMock 为:
window.PomeloMock = await fetch("/api/dashboard/overview").then(r => r.json());
// 响应:{ code: 0, result: { data: {...}, total: 0 } }
```

## 打包

### 本地一键打包(推荐)

需要 C++ 编译环境(MSVC),会把业务代码 Cython 编译成二进制后再打包:

```bat
build_pyd.bat
```

流程:`查便携依赖 → 装依赖 → pomelo_app.py 编译为 .pyd → PyInstaller 打包(源码不入包) → 捆绑便携 Allure + JRE → 布局校验 → 自动压 zip`。

- 产物目录 `dist\PomeloTool\`,分发包 `PomeloTool_YYYYMMDD.zip`(设 `NO_ZIP=1` 可跳过压缩)
- `data/` **不会**被打进包,应用运行时在 exe 旁边自建

#### 便携依赖是硬要求(Allure + JRE)

发行包要保证**目标电脑不装 Java、不装 Allure 也能出报告**,所以这两样必须随包发出去。
打包默认**硬失败**:缺任一项直接中止,不会产出"能启动、点报告才报未找到 allure"的残缺包。

| 变量 | 默认值 | 作用 |
|---|---|---|
| `ALLURE_SRC` | `C:\software\allure-2.32.0` | Allure 命令行源目录(需含 `bin\allure.bat`) |
| `JRE_SRC` | `C:\software\java\jre-17` | 便携 JRE 源目录(需含 `bin\java.exe`) |
| `SKIP_JRE=1` | 关 | 明确**不**捆绑 JRE(目标机必须自装 Java) |
| `REQUIRE_BUNDLE=0` | 关 | 缺依赖只告警、照常出包(**产物不自包含**,仅调试用) |
| `FORCE_COPY=1` | 关 | 强制重拷 allure/jre(dist 里已有也重来) |

打包前可以单独自检依赖,不触发构建:

```bat
python pyd_pack.py --check-deps
```

它会检查两个源目录结构、把源目录体积打出来、并**真跑一次 `java -version`**
(只有 `java.exe` 文件不代表能启动:缺 dll / 被 MOTW / 架构不对都要到运行时才炸)。

> 捆绑的是 **JRE 17(约 126MB)**,不是 JDK —— Allure 只需要 Java 运行时,
> 用 JRE 能比旧版 JDK8 的 231MB 省下近一半体积。
> 打包完成后 `tools\` 目录合计约 **152MB**(28MB Allure + 125MB JRE),这是包体的大头。

### CI 打包

见 `.github/workflows/release.yml`:push 到 `master` 自动取最新 tag 的 patch +1 出版本号,
在 `windows-latest` 上装依赖 → 下载便携 Allure/JRE → Cython 编译 → PyInstaller 打包 →
布局与源码泄露校验 → 出 `PomeloTool_v<版本>_win64.zip` 并挂到 Release;手动打 `v*` tag 则发正式版。

> ⚠ 仓库当前托管在 **Gitee**,GitHub Actions 只在 GitHub 执行。要跑这份 workflow
> 需先把仓库镜像到 GitHub,或在 Gitee Go 里按同样思路重写一份流水线。

### 仅调试用的单文件写法

不加密源码、不带 Allure,只适合临时验证:

```bash
pyinstaller --onefile --noconsole --add-data "web;web" pomelo_app.py
```

## 可扩展点

`pomelo_app.py` 中可暴露 `js_api`,将 Python 函数注入 `window.pywebview.api`,用于:

- 读写本地文件(导出 Allure 报告)
- 调用系统通知(任务完成提醒)
- 执行真正的 HTTP 请求(绕过浏览器 CORS 限制)
