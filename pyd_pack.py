# -*- coding: utf-8 -*-
"""pyd obfuscation pack flow (run AFTER setup_pyd.py build_ext --inplace):
1. temporarily rename pomelo_app.py -> pomelo_app.py.src so PyInstaller
   packs only the compiled .pyd, never the source
2. run PyInstaller (pomelo_tool.spec)
3. verify: pomelo_app.*.pyd present in _internal, no pomelo_app.py leaked
4. restore source
5. copy portable allure-commandline + JRE into dist/PomeloTool/tools/
   so the target PC needs NO install of java/allure

Step 5 is a HARD requirement: missing/incomplete portable deps abort the build
(REQUIRE_BUNDLE=0 downgrades to a warning; SKIP_JRE=1 opts out of the JRE).
Dry-run the dep check alone with:  python pyd_pack.py --check-deps

data/ is never touched: the app reads/creates data/ next to the exe.
"""
import glob
import os
import shutil
import subprocess
import sys

SRC_SUFFIX = ".py.src"

# ---- source module that gets cythonized (keep in sync with setup_pyd.py) ----
COMPILED = ["pomelo_app.py"]

# ---- portable runtime to bundle (ASCII paths only) ----
# 默认走开发机上的固定路径;CI 里由环境变量覆盖(workflow 会把压缩包下到
# runner 的临时目录再解压,本地路径在 runner 上并不存在)。
#   $env:ALLURE_SRC = "<解压后的 allure-commandline 目录>"
#   $env:JRE_SRC    = "<解压后的 jre 目录>"
ALLURE_SRC = os.environ.get("ALLURE_SRC") or r"C:\software\allure-2.32.0"
# Adoptium JRE 17 (126M, allure 2.32 verified): unpack from the official zip,
# do NOT use the old 231M JDK8 jre
JRE_SRC = os.environ.get("JRE_SRC") or r"C:\software\java\jre-17"
DIST = os.path.join("dist", "PomeloTool")

# 目标机零安装 = Allure(28M) + JRE 17(126M) 必须真的随包发出去。
# 缺任一项都属于「能启动、点报告才炸」的隐性故障,所以默认硬失败;
# 只有显式声明才降级:
#   REQUIRE_BUNDLE=0  缺依赖只警告,照常出包(产物不自包含)
#   SKIP_JRE=1        明确不要 JRE(目标机自备 Java)
REQUIRE_BUNDLE = os.environ.get("REQUIRE_BUNDLE", "1") != "0"


def sh(cmd):
    print("+", " ".join(cmd))
    r = subprocess.run(cmd)
    if r.returncode != 0:
        sys.exit("[FAIL] exit code %d: %s" % (r.returncode, " ".join(cmd)))


def has_allure(d):
    """allure-commandline 装好的标志:bin/allure.bat"""
    return os.path.isfile(os.path.join(d, "bin", "allure.bat"))


def has_jre(d):
    """便携 JRE 装好的标志:bin/java.exe"""
    return os.path.isfile(os.path.join(d, "bin", "java.exe"))


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

    光有 java.exe 文件不算数:缺 dll、被 MOTW 拦、架构不对,都要到
    真正启动时才暴露。先跑通一次,出包即验证。
    """
    try:
        p = subprocess.run([java_exe, "-version"], capture_output=True, text=True,
                           timeout=90,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        lines = (p.stderr or p.stdout or "").strip().splitlines()
        return p.returncode == 0, (lines[0].strip() if lines else "")
    except Exception as e:
        return False, str(e)


def preflight():
    """只检查便携依赖的【源目录】是否就绪,不碰 dist。

    打包前先跑,避免 cython + pyinstaller 白跑十分钟才报缺依赖。
    返回问题列表(空 = 就绪)。
    """
    skip_jre = os.environ.get("SKIP_JRE", "") == "1"
    problems = []
    if not os.path.isdir(ALLURE_SRC):
        problems.append("Allure 源目录不存在: %s" % ALLURE_SRC)
    elif not has_allure(ALLURE_SRC):
        problems.append("Allure 源目录缺 bin/allure.bat: %s" % ALLURE_SRC)
    else:
        print("[check] allure OK  %.1f MB  %s" % (dir_mb(ALLURE_SRC), ALLURE_SRC))
    if skip_jre:
        print("[check] SKIP_JRE=1 -> 跳过 JRE 检查")
    elif not os.path.isdir(JRE_SRC):
        problems.append("JRE 源目录不存在: %s" % JRE_SRC)
    elif not has_jre(JRE_SRC):
        problems.append("JRE 源目录缺 bin/java.exe: %s" % JRE_SRC)
    else:
        ok, ver = verify_java(os.path.join(JRE_SRC, "bin", "java.exe"))
        if ok:
            print("[check] jre OK  %.1f MB  %s" % (dir_mb(JRE_SRC), JRE_SRC))
            print("[check]        " + ver)
        else:
            problems.append("便携 JRE 无法运行: %s" % ver)
    return problems


def copy_tree(src, dst):
    """把便携依赖拷进 dist。目录已存在且关键文件齐全时跳过(重复打包快)。"""
    if os.path.isdir(dst) and not os.environ.get("FORCE_COPY"):
        print("[pack] already exists, skip copy:", dst)
        return
    print("[pack] copying", src, "->", dst, "(this may take a while)")
    shutil.copytree(src, dst, dirs_exist_ok=True)


def main():
    skip_jre = os.environ.get("SKIP_JRE", "") == "1"

    # --check-deps:只验便携依赖,不构建(CI / 出包前自检用)
    if "--check-deps" in sys.argv:
        print("[check] ALLURE_SRC = %s" % ALLURE_SRC)
        print("[check] JRE_SRC    = %s" % JRE_SRC)
        problems = preflight()
        if problems:
            for p in problems:
                print("   - " + p)
            sys.exit("[FAIL] 便携依赖未就绪,无法产出「目标机零安装」的包")
        print("[OK] 便携依赖就绪,可以打包")
        return

    # 0. compiled pyd must exist
    for src in COMPILED:
        if not glob.glob(src[:-3] + ".*.pyd"):
            sys.exit("[FAIL] missing .pyd for %s, run: python setup_pyd.py "
                     "build_ext --inplace" % src)

    renamed = []
    try:
        # 1. hide .py sources
        for src in COMPILED:
            os.rename(src, src + SRC_SUFFIX)
            renamed.append(src)
        print("[pyd] staged %d source file(s)" % len(renamed))

        # 2. PyInstaller
        sh([sys.executable, "-m", "PyInstaller", "--noconfirm",
            "pomelo_tool.spec"])

        # 3. verify output
        internal = os.path.join(DIST, "_internal")
        exe = os.path.join(DIST, "PomeloTool.exe")
        if not os.path.isfile(exe):
            sys.exit("[FAIL] missing " + exe)
        pyds = glob.glob(os.path.join(internal, "pomelo_app.*.pyd"))
        if not pyds:
            sys.exit("[FAIL] pomelo_app pyd NOT bundled into _internal")
        leaked = [s for s in COMPILED
                  if os.path.isfile(os.path.join(internal, s))]
        if leaked:
            sys.exit("[FAIL] source leaked into package: %s" % leaked)
        if not os.path.isdir(os.path.join(internal, "web")):
            sys.exit("[FAIL] web/ NOT bundled into _internal")
        print("[pyd] verify OK: pyd bundled, no source leak, web/ bundled")
    finally:
        # 4. restore sources
        for src in renamed:
            if os.path.exists(src + SRC_SUFFIX):
                os.rename(src + SRC_SUFFIX, src)
        print("[pyd] restored %d source file(s)" % len(renamed))

    # 5. portable allure + jre next to the exe —— 目标机零安装的前提
    tools = os.path.join(DIST, "tools")
    os.makedirs(tools, exist_ok=True)
    allure_dst = os.path.join(tools, "allure-commandline")
    jre_dst = os.path.join(tools, "jre")
    # 源目录检查复用 --check-deps 那一套,避免两处逻辑漂移
    print("[pack] ---- 便携依赖检查 ----")
    problems = preflight()

    # --- 5a. Allure CLI 拷进 dist 并复验 ---
    if os.path.isdir(ALLURE_SRC) and has_allure(ALLURE_SRC):
        if not has_allure(allure_dst):
            copy_tree(ALLURE_SRC, allure_dst)
        if has_allure(allure_dst):
            print("[pack] allure -> dist  %.1f MB" % dir_mb(allure_dst))
        else:
            problems.append("Allure 拷贝后仍缺 bin/allure.bat: %s" % allure_dst)

    # --- 5b. 便携 JRE 拷进 dist 并复验 ---
    if skip_jre:
        print("[pack] SKIP_JRE=1 -> 不捆绑 JRE(目标机必须自装 Java)")
    elif os.path.isdir(JRE_SRC) and has_jre(JRE_SRC):
        if not has_jre(jre_dst):
            copy_tree(JRE_SRC, jre_dst)
        java_exe = os.path.join(jre_dst, "bin", "java.exe")
        if has_jre(jre_dst):
            ok, ver = verify_java(java_exe)
            if ok:
                print("[pack] jre OK  %.1f MB -> %s" % (dir_mb(jre_dst), jre_dst))
                print("[pack]    " + ver)
            else:
                problems.append("便携 JRE 无法运行(%s): %s" % (java_exe, ver))
        else:
            problems.append("JRE 拷贝后仍缺 bin/java.exe: %s" % jre_dst)

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

    print("[pyd] DONE: %s" % DIST)


if __name__ == "__main__":
    main()
