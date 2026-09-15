#!/usr/bin/env bash
# ============================================================
#  Pomelo Tool — macOS 一键打包(build_pyd.bat 的 mac 版)
#
#    ./build_mac.sh
#
#  流程:
#    0. 检查 Xcode 命令行工具 + 判断架构
#    1. 下载便携 allure-commandline / JRE 17 到 build_tools/(已存在则跳过)
#    2. 装 Python 依赖(+ cython / pyinstaller)
#    3. Cython 编译 pomelo_app.py -> .so
#    4. PyInstaller 打包(源码不入包)+ 捆绑 allure/jre + ad-hoc 签名
#    5. 布局校验 + zip -y 与 dmg 两种分发包
#
#  可选环境变量:
#    SKIP_JRE=1        不捆绑 JRE(目标机必须自装 Java)
#    REQUIRE_BUNDLE=0  缺依赖只告警,照常出包(产物不自包含)
#    SKIP_SIGN=1       跳过 ad-hoc 签名(仅调试;arm64 上产物将无法启动)
#    NO_ZIP=1          不生成 zip
#    NO_DMG=1          不生成 dmg
#    POMELO_VERSION=x.y.z  写进 Info.plist 的版本号
#    ALLURE_SRC / JRE_SRC  指定已下载好的依赖目录,跳过下载
# ============================================================
set -euo pipefail

cd "$(dirname "$0")"

ALLURE_VER="${ALLURE_VER:-2.32.0}"
BUILD_TOOLS="build_tools"
DIST_APP="dist/PomeloTool.app"
OUT_ZIP="PomeloTool_macOS_$(date +%Y%m%d).zip"
OUT_DMG="PomeloTool_macOS_$(date +%Y%m%d).dmg"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\n[FAIL] %s\n' "$*" >&2; exit 1; }

# ---------- 0. 环境 ----------
say "[0/5] 检查构建环境"
[ "$(uname -s)" = "Darwin" ] || die "本脚本只能在 macOS 上跑(PyInstaller 不支持交叉编译)"
ARCH="$(uname -m)"
# ⚠ Adoptium 的下载路径用的是 aarch64 / x64,不是 uname 的 arm64 / x86_64
case "$ARCH" in
  arm64)  JRE_ARCH=aarch64 ;;
  x86_64) JRE_ARCH=x64 ;;
  *)      die "未识别的架构: $ARCH" ;;
esac
echo "[OK] 系统 macOS / 架构 $ARCH (Adoptium 记为 $JRE_ARCH)"

xcode-select -p >/dev/null 2>&1 || die "缺少 Xcode 命令行工具,先执行: xcode-select --install"
echo "[OK] Xcode 命令行工具: $(xcode-select -p)"

command -v python3 >/dev/null 2>&1 || die "找不到 python3"
PY="$(command -v python3)"
echo "[OK] Python: $PY ($($PY -V 2>&1))"

# 便携依赖源目录(可用环境变量覆盖)
ALLURE_SRC="${ALLURE_SRC:-$PWD/$BUILD_TOOLS/allure-commandline}"
JRE_SRC="${JRE_SRC:-$PWD/$BUILD_TOOLS/jre}"
export ALLURE_SRC JRE_SRC

# ---------- 1. 下载便携依赖 ----------
say "[1/5] 准备便携依赖(Allure $ALLURE_VER + JRE 17)"
mkdir -p "$BUILD_TOOLS"

if [ ! -f "$ALLURE_SRC/bin/allure" ]; then
  echo "下载 Allure ($ARCH 通用的 unix 版)..."
  curl -fL --retry 3 -o "$BUILD_TOOLS/allure.tgz" \
    "https://github.com/allure-framework/allure2/releases/download/$ALLURE_VER/allure-$ALLURE_VER.tgz"
  rm -rf "$BUILD_TOOLS/allure_raw"
  mkdir -p "$BUILD_TOOLS/allure_raw"
  # tgz 解压后是一层 allure-<ver>/ 目录,把它挪成 pyd_pack.py 期望的名字
  tar -xzf "$BUILD_TOOLS/allure.tgz" -C "$BUILD_TOOLS/allure_raw"
  mv "$BUILD_TOOLS/allure_raw/allure-$ALLURE_VER" "$ALLURE_SRC"
  chmod +x "$ALLURE_SRC/bin/allure"
fi
[ -f "$ALLURE_SRC/bin/allure" ] || die "Allure 就位失败: $ALLURE_SRC/bin/allure"
echo "[OK] Allure -> $ALLURE_SRC"

if [ "${SKIP_JRE:-}" = "1" ]; then
  echo "[WARN] SKIP_JRE=1:不捆绑 JRE,目标机必须自装 Java"
elif [ ! -f "$JRE_SRC/Contents/Home/bin/java" ] && [ ! -f "$JRE_SRC/bin/java" ]; then
  echo "下载 JRE 17 (Adoptium, mac/$JRE_ARCH)..."
  curl -fL --retry 3 -o "$BUILD_TOOLS/jre.tar.gz" \
    "https://api.adoptium.net/v3/binary/latest/17/ga/mac/$JRE_ARCH/jre/hotspot/normal/eclipse"
  rm -rf "$BUILD_TOOLS/jre_raw"
  mkdir -p "$BUILD_TOOLS/jre_raw"
  tar -xzf "$BUILD_TOOLS/jre.tar.gz" -C "$BUILD_TOOLS/jre_raw"
  # 解压后是 jdk-17.x.y+z-jre/,里面才是 Contents/Home/bin/java
  inner="$(find "$BUILD_TOOLS/jre_raw" -maxdepth 1 -mindepth 1 -type d | head -1)"
  [ -n "$inner" ] || die "JRE 解压后没有顶层目录"
  mv "$inner" "$JRE_SRC"
fi
if [ "${SKIP_JRE:-}" != "1" ]; then
  # Adoptium 的 mac 归档解压后固定是 <jre>/Contents/Home/bin/java;
  # 两种布局 pyd_pack.py 都认,这里只用来看"下全了没有"
  if [ -f "$JRE_SRC/Contents/Home/bin/java" ] || [ -f "$JRE_SRC/bin/java" ]; then
    echo "[OK] JRE   -> $JRE_SRC"
  else
    die "JRE 就位失败(找不到 bin/java): $JRE_SRC"
  fi
fi

# ---------- 2. 依赖预检(与 pyd_pack.py 共用同一套逻辑) ----------
say "[2/5] 校验便携依赖"
"$PY" pyd_pack.py --check-deps

# ---------- 3. Python 依赖 + Cython 编译 ----------
say "[3/5] 安装依赖并编译核心逻辑"
"$PY" -m pip install -q --upgrade pip
"$PY" -m pip install -q -r requirements.txt "cython>=3.0" "pyinstaller>=6.0" setuptools wheel
"$PY" setup_pyd.py build_ext --inplace
SO_FILE="$(ls -1 pomelo_app.*.so 2>/dev/null | head -1 || true)"
[ -n "$SO_FILE" ] || die "Cython 未产出 pomelo_app.*.so"
echo "[OK] $SO_FILE"

# ---------- 4. 打包 ----------
say "[4/5] PyInstaller 打包 + 捆绑 allure/jre + 签名"
"$PY" pyd_pack.py

# ---------- 5. 布局校验 ----------
say "[5/5] 校验产物布局"
MACOS_DIR="$DIST_APP/Contents/MacOS"
# 便携依赖在资源区,不在 Contents/MacOS —— 后者是 codesign 的「可执行代码
# 专区」,放进去会被要求逐个文件签名(JRE 的纯文本 release 也不例外),
# 外层 .app 直接签不过。详见 pyd_pack.py 的 TOOLS_REL。
TOOLS_DIR="$DIST_APP/Contents/Resources/tools"
CHK_ERR=""
[ -f "$MACOS_DIR/PomeloTool" ] || CHK_ERR="PomeloTool 可执行文件"
[ -f "$TOOLS_DIR/allure-commandline/bin/allure" ] || CHK_ERR="便携 allure-commandline"
if [ "${SKIP_JRE:-}" != "1" ]; then
  [ -f "$TOOLS_DIR/jre/Contents/Home/bin/java" ] || CHK_ERR="便携 JRE"
fi
# 反过来确认没有误放进 MacOS —— 放进去签名必挂,早失败比 CI 上再发现好
if [ -e "$MACOS_DIR/tools" ]; then
  die "tools/ 不能放在 Contents/MacOS(会导致代码签名失败),应在 Contents/Resources"
fi
# data/ 要在整个 .app 里找 —— PyInstaller 会把它塞进 Contents/Frameworks,
# 只查 Contents/MacOS 会漏检。tools/ 内(JRE/allure 自带的数据目录)不算,
# 用 -prune 跳过,避免误报。
DATA_LEAK="$(find "$DIST_APP" -path '*/tools' -prune -o \
             -type d -name 'data' -print -quit)"
if [ -n "$DATA_LEAK" ]; then
  die "data/ 不该被打进包(应用运行时在可执行文件旁自建): $DATA_LEAK"
fi
if [ -n "$CHK_ERR" ]; then
  die "产物布局校验失败,缺少: $CHK_ERR"
fi

# 源码泄露 / 核心编译产物是否真的进包。
# 用 find -print -quit 而不是 `find | grep -q` —— 后者 grep 命中即退出会给
# find 发 SIGPIPE,配合 pipefail 整条管道返回失败,检查会静默失效。
LEAK="$(find "$DIST_APP" -name 'pomelo_app.py' -print -quit)"
if [ -n "$LEAK" ]; then
  die "源码泄露进包: $LEAK"
fi
CORE="$(find "$DIST_APP" -name 'pomelo_app.*.so' -print -quit)"
if [ -z "$CORE" ]; then
  die "核心 pomelo_app.*.so 未打进包"
fi
echo "[OK] 核心编译产物: $(basename "$CORE")"

TOOLS_MB=$(du -sm "$TOOLS_DIR" 2>/dev/null | cut -f1 || echo "?")
APP_MB=$(du -sm "$DIST_APP" 2>/dev/null | cut -f1 || echo "?")
echo "[OK] 便携依赖 ${TOOLS_MB}MB | .app 合计 ${APP_MB}MB"
echo "[OK] 架构 $ARCH(只能在与本机同架构的 mac 上运行)"

# ---------- zip ----------
if [ "${NO_ZIP:-}" = "1" ]; then
  echo "[skip] NO_ZIP=1,未压缩"
else
  # -y 必须带:.app 内部靠符号链接组织框架,丢了软链解压后直接起不来
  rm -f "$OUT_ZIP"
  ( cd dist && zip -qry "../$OUT_ZIP" "PomeloTool.app" )
  echo "[OK] 分发包: $PWD/$OUT_ZIP ($(du -sh "$OUT_ZIP" | cut -f1))"
fi

# ---------- dmg ----------
# dmg 是 mac 用户习惯的分发形式:挂载后把 .app 拖进 Applications 即可。
# 里面放一个 Applications 软链作为拖拽落点。
if [ "${NO_DMG:-}" = "1" ]; then
  echo "[skip] NO_DMG=1,未生成 dmg"
elif ! command -v hdiutil >/dev/null 2>&1; then
  echo "[skip] 没有 hdiutil(非 macOS),跳过 dmg"
else
  STAGE="build_dmg"
  rm -rf "$STAGE" "$OUT_DMG"
  mkdir -p "$STAGE"
  cp -R "$DIST_APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  # UDZO = 压缩只读镜像,等价于 hdiutil 的"压缩"选项
  hdiutil create -volname "PomeloTool" -srcfolder "$STAGE" \
    -ov -format UDZO "$OUT_DMG" >/dev/null
  rm -rf "$STAGE"
  echo "[OK] dmg: $PWD/$OUT_DMG ($(du -sh "$OUT_DMG" | cut -f1))"
fi

cat <<EOF

============================================
 构建完成: $DIST_APP
 zip     : $OUT_ZIP
 dmg     : $OUT_DMG(挂载后把 PomeloTool 拖进 Applications)

 拷贝到别的 mac 上运行前:
   装 dmg: 双击挂载 -> 拖进 Applications -> 首次右键"打开"
   用 zip: unzip -q $OUT_ZIP && xattr -cr PomeloTool.app && open PomeloTool.app
 网上下载/IM 传输过的包会带隔离标记,不清掉会被系统拦下。
 首次启动若提示是否允许接受传入连接,选"允许"LAN 模式才能用。
============================================
EOF
