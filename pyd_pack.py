# -*- coding: utf-8 -*-
"""pyd obfuscation pack flow (run AFTER setup_pyd.py build_ext --inplace):
1. temporarily rename pomelo_app.py -> pomelo_app.py.src so PyInstaller
   packs only the compiled binary, never the source
2. run PyInstaller (pomelo_tool.spec)
3. verify: pomelo_app.*.pyd|.so present in the bundle, no pomelo_app.py leaked
4. restore source
5. copy portable allure-commandline + JRE next to the executable
   so the target machine needs NO install of java/allure
6. (macOS only) ad-hoc codesign — arm64 上未签名的 Mach-O 根本起不来

Step 5 is a HARD requirement: missing/incomplete portable deps abort the build
(REQUIRE_BUNDLE=0 downgrades to a warning; SKIP_JRE=1 opts out of the JRE).
Dry-run the dep check alone with:  python pyd_pack.py --check-deps

Windows / macOS 共用本脚本,平台差异只有三处:编译产物扩展名、产物目录布局、
签名与可执行位。分别由 EXT / DIST / sign_app() 承接。

data/ is never touched: the app reads/creates data/ next to the executable.
"""
import glob
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
IS_MAC = sys.platform == "darwin"

SRC_SUFFIX = ".py.src"
APP_NAME = "PomeloTool"

# ---- source module that gets cythonized (keep in sync with setup_pyd.py) ----
COMPILED = ["pomelo_app.py"]

# ---- 编译产物扩展名(Cython 在 Windows 出 .pyd、在 macOS 出 .so) ----
EXT = "so" if IS_MAC else "pyd"

# ---- 产物目录 ----
# Windows: dist/PomeloTool/            (exe 与 _internal 同级)
# macOS  : dist/PomeloTool.app/Contents/MacOS/  (BUNDLE 之后可执行文件在这,
#          便携依赖也必须放它旁边 —— 运行时按 dirname(sys.executable) 找 tools/)
DIST = (os.path.join("dist", APP_NAME + ".app", "Contents", "MacOS") if IS_MAC
        else os.path.join("dist", APP_NAME))
APP_PATH = os.path.join("dist", APP_NAME + ".app") if IS_MAC else DIST

# ---- 校验时的搜索根 ----
# macOS 的 .app 是分层的:可执行文件在 Contents/MacOS,而 PyInstaller 把
# Python 扩展(.so)与数据(web/)放进 Contents/Frameworks(部分版本是
# Contents/Resources)。只搜 Contents/MacOS 会误报「未打进包」——
# 打包其实成功了,是校验找错了地方。所以校验一律以整个 .app 为根。
SEARCH_ROOT = APP_PATH if IS_MAC else DIST

# ---- 便携依赖(allure / jre)在包内的位置 ----
# ⚠ macOS 上**绝不能放 Contents/MacOS/**。
# codesign 把该目录当作「可执行代码专区」:里面任何文件 —— 哪怕权限是 644
# 的纯文本(比如 JRE 的 `release`)—— 都会被要求是**已签名的代码对象**,
# 于是签外层时报 `code object is not signed at all`
# + `In subcomponent: .../Contents/Home/release`,整个打包失败。
# 放到 bundle 的资源区 Contents/Resources/ 就只当普通资源看待。
# (Android Studio 把自带 JBR 放在 Contents/jbr,同理。)
TOOLS_REL = (os.path.join("Contents", "Resources", "tools") if IS_MAC
             else "tools")

# ---- portable runtime to bundle ----
# Windows 开发机是固定路径;macOS 走 build_mac.sh 下载到的 build_tools/;
# CI 两种情况都由 ALLURE_SRC / JRE_SRC 环境变量注入(优先级最高)。
#   ALLURE_SRC = "<解压后的 allure-commandline 目录>"
#   JRE_SRC    = "<解压后的 jre 目录>"
_DEF_ALLURE = (os.path.join(ROOT, "build_tools", "allure-commandline") if IS_MAC
               else r"C:\software\allure-2.32.0")
_DEF_JRE = (os.path.join(ROOT, "build_tools", "jre") if IS_MAC
            else r"C:\software\java\jre-17")
ALLURE_SRC = os.environ.get("ALLURE_SRC") or _DEF_ALLURE
# Adoptium JRE 17 (126M, allure 2.32 verified): unpack from the official
# archive, do NOT use the old 231M JDK8 jre
JRE_SRC = os.environ.get("JRE_SRC") or _DEF_JRE

# allure 命令行文件名:Windows 是 allure.bat,macOS/Linux 是无扩展名 shell 脚本
ALLURE_BIN_NAMES = ("allure.bat", "allure.cmd", "allure.exe") if not IS_MAC \
    else ("allure", "allure.sh")

# 目标机零安装 = Allure(28M) + JRE 17(126M) 必须真的随包发出去。
# 缺任一项都属于「能启动、点报告才炸」的隐性故障,所以默认硬失败;
# 只有显式声明才降级:
#   REQUIRE_BUNDLE=0  缺依赖只警告,照常出包(产物不自包含)
#   SKIP_JRE=1        明确不要 JRE(目标机自备 Java)
REQUIRE_BUNDLE = os.environ.get("REQUIRE_BUNDLE", "1") != "0"
SIGN = os.environ.get("SKIP_SIGN", "") != "1"


def sh(cmd, **kw):
    print("+", " ".join(str(c) for c in cmd))
    r = subprocess.run(cmd, **kw)
    return r


def sh_ok(cmd):
    r = sh(cmd)
    if r.returncode != 0:
        sys.exit("[FAIL] exit code %d: %s" % (r.returncode, " ".join(cmd)))
    return r


# ---------------- 便携依赖识别(两端目录结构不同) ----------------

def allure_bin(d):
    """返回 d 里的 allure 可执行文件路径,没有返回 ""。"""
    for name in ALLURE_BIN_NAMES:
        p = os.path.join(d, "bin", name)
        if os.path.isfile(p):
            return p
    return ""


def java_home(d):
    """返回 d 里真正的 JAVA_HOME,没有返回 ""。

    macOS 的 OpenJDK 归档解压后多一层 Contents/Home,而且 JAVA_HOME 必须指到
    那一层(指 <jre> 本身的话 java 找不到);Windows 的 JRE 就是扁平的 bin/。
    """
    for home in (os.path.join(d, "Contents", "Home"), d):
        for name in ("java", "java.exe"):
            if os.path.isfile(os.path.join(home, "bin", name)):
                return home
    return ""


def java_bin(d):
    home = java_home(d)
    if not home:
        return ""
    for name in ("java", "java.exe"):
        p = os.path.join(home, "bin", name)
        if os.path.isfile(p):
            return p
    return ""


def has_allure(d):
    return bool(allure_bin(d))


def has_jre(d):
    return bool(java_home(d))


def dir_mb(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for fn in files:
            try:
                total += os.path.getsize(os.path.join(root, fn))
            except OSError:
                pass
    return total / 1024.0 / 1024.0


def verify_java(java_exe):
    """真跑一次 java -version。

    光有 java 文件不算数:缺 dll、被安全标记拦、架构不对(把 x64 的 JRE 装到
    arm64 机器上),都要到真正启动时才暴露。先跑通一次,出包即验证。
    """
    try:
        p = subprocess.run([java_exe, "-version"], capture_output=True, text=True,
                           timeout=90,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        lines = (p.stderr or p.stdout or "").strip().splitlines()
        return p.returncode == 0, (lines[0].strip() if lines else "")
    except Exception as e:
        return False, str(e)


def ensure_exec_bits(root):
    """macOS:给可执行文件补 +x(拷贝/解压过程偶尔会丢执行位)。

    allure 是 shell 脚本、java 是二进制,没有执行位就是"找不到命令"。
    """
    if not IS_MAC:
        return
    fixed = 0
    for rel in ("bin", os.path.join("Contents", "Home", "bin")):
        d = os.path.join(root, rel)
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            p = os.path.join(d, fn)
            if os.path.isfile(p) and not os.access(p, os.X_OK):
                try:
                    os.chmod(p, 0o755)
                    fixed += 1
                except OSError:
                    pass
    if fixed:
        print("[pack] chmod +x: %d file(s) in %s" % (fixed, root))


def preflight():
    """只检查便携依赖的【源目录】是否就绪,不碰 dist。

    打包前先跑,避免 cython + pyinstaller 白跑十分钟才报缺依赖。
    返回问题列表(空 = 就绪)。
    """
    skip_jre = os.environ.get("SKIP_JRE", "") == "1"
    problems = []
    want_allure = "/".join(("bin", ALLURE_BIN_NAMES[0]))
    if not os.path.isdir(ALLURE_SRC):
        problems.append("Allure 源目录不存在: %s" % ALLURE_SRC)
    elif not has_allure(ALLURE_SRC):
        problems.append("Allure 源目录缺 %s: %s" % (want_allure, ALLURE_SRC))
    else:
        print("[check] allure OK  %.1f MB  %s" % (dir_mb(ALLURE_SRC), ALLURE_SRC))
    if skip_jre:
        print("[check] SKIP_JRE=1 -> 跳过 JRE 检查")
    elif not os.path.isdir(JRE_SRC):
        problems.append("JRE 源目录不存在: %s" % JRE_SRC)
    elif not has_jre(JRE_SRC):
        problems.append("JRE 源目录里找不到 bin/java(.exe): %s" % JRE_SRC)
    else:
        ok, ver = verify_java(java_bin(JRE_SRC))
        if ok:
            print("[check] jre OK  %.1f MB  %s" % (dir_mb(JRE_SRC), JRE_SRC))
            print("[check]        " + ver)
        else:
            problems.append("便携 JRE 无法运行: %s" % ver)
    return problems


def copy_tree(src, dst):
    """把便携依赖拷进产物目录。已存在且关键文件齐全时跳过(重复打包快)。"""
    if os.path.isdir(dst) and not os.environ.get("FORCE_COPY"):
        print("[pack] already exists, skip copy:", dst)
        return
    print("[pack] copying", src, "->", dst, "(this may take a while)")
    shutil.copytree(src, dst, dirs_exist_ok=True)


# ---------------- 产物校验 ----------------

def _find(root, pattern):
    """在打包目录里递归找文件。

    不写死 _internal / Contents/Frameworks 这类路径 —— 它们在 PyInstaller
    各版本、各平台之间改过好几次,写死就是给自己埋雷。
    """
    if not os.path.isdir(root):
        return []
    return glob.glob(os.path.join(root, "**", pattern), recursive=True)


def verify_output():
    """校验 PyInstaller 产物:可执行文件在、编译产物进了包、源码没泄露、web 资源在。

    注意:可执行文件按 DIST 找(mac 下是 Contents/MacOS),但编译产物与数据
    要按 SEARCH_ROOT(整个 .app)找 —— macOS 上它们不在 MacOS 目录里。
    """
    exe = os.path.join(DIST, APP_NAME + ("" if IS_MAC else ".exe"))
    if not os.path.isfile(exe):
        sys.exit("[FAIL] missing executable: " + exe)

    compiled = _find(SEARCH_ROOT, "pomelo_app.*." + EXT)
    if not compiled:
        sys.exit("[FAIL] pomelo_app.%s NOT bundled into the package" % EXT)

    leaked = _find(SEARCH_ROOT, "pomelo_app.py")
    if leaked:
        sys.exit("[FAIL] source leaked into package: %s" % leaked)

    if not _find(SEARCH_ROOT, os.path.join("web", "index.html")):
        sys.exit("[FAIL] web/ NOT bundled into the package")

    print("[pyd] verify OK: %s bundled, no source leak, web/ bundled"
          % os.path.basename(compiled[0]))
    return compiled[0]


# ---------------- macOS 专属:签名 ----------------

# Mach-O 魔数:用来判断"这个文件是不是需要签名的可执行体"。
# 不能只看扩展名 —— JRE 的 bin/java、Python.framework 的主二进制
# (Versions/3.12/Python)都没有扩展名,漏签它们正是外层 .app 签名失败的原因。
_MACHO_MAGICS = (
    b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe",   # MH_MAGIC(_64),小端
    b"\xfe\xed\xfa\xcf", b"\xfe\xed\xfa\xce",   # MH_MAGIC(_64),大端
    b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca",   # 胖二进制(fat)
)


def _is_macho(path):
    try:
        with open(path, "rb") as fh:
            return fh.read(4) in _MACHO_MAGICS
    except OSError:
        return False


def _sign_one(path):
    """ad-hoc 签单个文件 / bundle,失败时打印 codesign 的真实报错。

    原来是直接继承子进程输出,失败只有一句 "exit code 1",根本看不出是
    哪个嵌套对象签名无效 —— 排查只能靠猜(上一次就是这么卡住的)。
    """
    r = subprocess.run(["codesign", "--force", "-s", "-", path],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print("[sign]   FAIL %s" % path)
        for line in (r.stderr or r.stdout or "").strip().splitlines()[:4]:
            print("[sign]        " + line)
        return False
    return True


def _collect_codes(root, skip_tools=False):
    """收集待签名对象:叶子 Mach-O 与嵌套 bundle。

    符号链接一律跳过 —— 跟在软链上签名会落到真实文件上,既重复又容易
    踩进 JRE 内部。
    """
    machos, bundles = [], []
    for dirpath, dirnames, filenames in os.walk(root):
        if skip_tools and (os.sep + "tools" + os.sep) in (dirpath + os.sep):
            dirnames[:] = []
            continue
        dirnames[:] = [d for d in dirnames
                       if not os.path.islink(os.path.join(dirpath, d))]
        for d in dirnames:
            if d.endswith(".framework"):
                bundles.append(os.path.join(dirpath, d))
        for fn in filenames:
            p = os.path.join(dirpath, fn)
            if os.path.islink(p) or not os.path.isfile(p):
                continue
            if _is_macho(p):
                machos.append(p)
    return machos, bundles


def _sign_tree(skip_tools=False):
    """自内向外签一遍,返回外层 .app 是否签成功。"""
    machos, bundles = _collect_codes(APP_PATH, skip_tools)
    ok = sum(1 for p in machos if _sign_one(p))
    print("[sign] Mach-O %d/%d%s"
          % (ok, len(machos), "(跳过 tools/)" if skip_tools else "(含 tools/)"))
    # framework 内部文件被改动后它自己的封条就失效了,必须整体重签,
    # 而且一定要在叶子之后 —— 顺序反了等于白签。
    for b in sorted(bundles, key=len, reverse=True):
        _sign_one(b)
    if bundles:
        print("[sign] nested bundle %d" % len(bundles))
    return _sign_one(APP_PATH)


def sign_app():
    """ad-hoc 签名 .app(自内向外)。

    为什么必须做:Apple Silicon 上**未签名的 Mach-O 根本不会被加载**,双击就是
    一句"无法打开"。这不是为了美观,是能不能跑的前提。

    为什么不用 `codesign --deep`:--deep 会把嵌套二进制的签名选项一起抹掉,
    JRE 里 java 依赖的 JIT 相关 entitlements 会丢,反而起不来。

    顺序是关键(踩过):**叶子 Mach-O → framework → 外层 .app**。
    只签 .so 远远不够 —— ① frameworks/Python.framework 的内部文件被改后,
    它自己的封条失效,必须把它当整体重签;② framework 主二进制没有扩展名,
    按 `*.so` 找会漏掉。两者任一遗漏,签外层时都会报嵌套代码无效。
    """
    if not IS_MAC or not SIGN:
        return
    if not shutil.which("codesign"):
        print("[WARN] 没找到 codesign:先 `xcode-select --install`,"
              "否则 arm64 上产物无法启动")
        return

    # 下载/解压带来的隔离标记会让 Gatekeeper 直接拦下,先清掉
    sh(["xattr", "-cr", APP_PATH])

    # 第一轮:不碰 tools/ —— JRE 出厂签名完好时没必要动它
    print("[sign] ---- pass 1: 包内自建代码 ----")
    if _sign_tree(skip_tools=True):
        print("[sign] ad-hoc 签名完成")
    else:
        # 第二轮:连 tools/ 一起重签。出厂签名有缺失或失效时,只有统一
        # 重签才能让外层通过。ad-hoc 且不启用 hardened runtime,
        # java 的 JIT 不受限,仍可正常启动。
        print("[sign] pass 1 未通过 -> 全量重签(含 tools/)")
        if not _sign_tree(skip_tools=False):
            sys.exit("[FAIL] .app 签名失败,原因见上方 codesign 输出")

    r = sh(["codesign", "--verify", "--verbose=2", APP_PATH])
    if r.returncode == 0:
        print("[sign] codesign verify OK")
    else:
        print("[WARN] codesign verify 未通过,产物可能无法在目标机启动")


def main():
    skip_jre = os.environ.get("SKIP_JRE", "") == "1"

    # --check-deps:只验便携依赖,不构建(CI / 出包前自检用)
    if "--check-deps" in sys.argv:
        print("[check] platform   = %s" % ("macOS" if IS_MAC else "Windows"))
        print("[check] ALLURE_SRC = %s" % ALLURE_SRC)
        print("[check] JRE_SRC    = %s" % JRE_SRC)
        problems = preflight()
        if problems:
            for p in problems:
                print("   - " + p)
            sys.exit("[FAIL] 便携依赖未就绪,无法产出「目标机零安装」的包")
        print("[OK] 便携依赖就绪,可以打包")
        return

    # 0. compiled binary must exist
    for src in COMPILED:
        if not glob.glob(src[:-3] + ".*." + EXT):
            sys.exit("[FAIL] missing .%s for %s, run: python setup_pyd.py "
                     "build_ext --inplace" % (EXT, src))

    renamed = []
    try:
        # 1. hide .py sources
        for src in COMPILED:
            os.rename(src, src + SRC_SUFFIX)
            renamed.append(src)
        print("[pyd] staged %d source file(s)" % len(renamed))

        # 2. PyInstaller
        sh_ok([sys.executable, "-m", "PyInstaller", "--noconfirm",
               "pomelo_tool.spec"])

        # 3. verify output
        verify_output()
    finally:
        # 4. restore sources
        for src in renamed:
            if os.path.exists(src + SRC_SUFFIX):
                os.rename(src + SRC_SUFFIX, src)
        print("[pyd] restored %d source file(s)" % len(renamed))

    # 5. portable allure + jre —— 目标机零安装的前提
    #    位置见 TOOLS_REL:mac 必须在 Contents/Resources/(放 MacOS 里会导致
    #    代码签名失败,原因见常量处的注释)
    tools = os.path.join(APP_PATH, TOOLS_REL)
    os.makedirs(tools, exist_ok=True)
    allure_dst = os.path.join(tools, "allure-commandline")
    jre_dst = os.path.join(tools, "jre")
    # 源目录检查复用 --check-deps 那一套,避免两处逻辑漂移
    print("[pack] ---- 便携依赖检查 ----")
    problems = preflight()

    # --- 5a. Allure CLI 拷进产物并复验 ---
    if os.path.isdir(ALLURE_SRC) and has_allure(ALLURE_SRC):
        if not has_allure(allure_dst):
            copy_tree(ALLURE_SRC, allure_dst)
        if has_allure(allure_dst):
            ensure_exec_bits(allure_dst)
            print("[pack] allure -> dist  %.1f MB" % dir_mb(allure_dst))
        else:
            problems.append("Allure 拷贝后仍缺 %s: %s"
                            % ("/".join(("bin", ALLURE_BIN_NAMES[0])), allure_dst))

    # --- 5b. 便携 JRE 拷进产物并复验 ---
    if skip_jre:
        print("[pack] SKIP_JRE=1 -> 不捆绑 JRE(目标机必须自装 Java)")
    elif os.path.isdir(JRE_SRC) and has_jre(JRE_SRC):
        if not has_jre(jre_dst):
            copy_tree(JRE_SRC, jre_dst)
        jb = java_bin(jre_dst)
        if jb:
            ensure_exec_bits(jre_dst)
            ok, ver = verify_java(jb)
            if ok:
                print("[pack] jre OK  %.1f MB -> %s" % (dir_mb(jre_dst), jre_dst))
                print("[pack]    " + ver)
            else:
                problems.append("便携 JRE 无法运行(%s): %s" % (jb, ver))
        else:
            problems.append("JRE 拷贝后仍找不到 bin/java(.exe): %s" % jre_dst)

    # --- 5c. 结论:不自包含就别说打包成功 ---
    if problems:
        print("")
        print("[BUNDLE-FAIL] 便携依赖不完整,目标机将无法生成 Allure 报告:")
        for p in problems:
            print("   - " + p)
        if REQUIRE_BUNDLE:
            sys.exit("[FAIL] 打包中止。修好上述路径,或用 "
                     "ALLURE_SRC/JRE_SRC 指定正确目录;"
                     "确实要出不含依赖的包时设 REQUIRE_BUNDLE=0")
        print("[WARN] REQUIRE_BUNDLE=0 -> 继续出包,但产物不自包含")
    else:
        print("[pack] tools 合计 %.1f MB(解压后包体量级)" % dir_mb(tools))

    # 6. macOS 签名(必须在拷完 tools 之后 —— 后加文件会让签名失效)
    sign_app()

    print("[pyd] DONE: %s" % APP_PATH)


if __name__ == "__main__":
    main()
