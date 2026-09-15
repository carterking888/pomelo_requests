@echo off
setlocal
cd /d "%~dp0"

REM ============================================
REM  Pomelo Tool pyd obfuscated build
REM  1. deps from requirements.txt (+ cython / pyinstaller)
REM  2. cythonize pomelo_app.py -> .pyd   (setup_pyd.py)
REM  3. pyinstaller pack, no .py inside   (pyd_pack.py)
REM  4. bundle portable allure-commandline(28M) + jre17(126M) into
REM     dist\PomeloTool\tools\  -> target PC needs NO java / NO allure
REM  Notes:
REM   - data/ is NOT bundled; the app creates data\ next to the exe
REM   - ALLURE_SRC / JRE_SRC : override the portable deps source dirs
REM   - SKIP_JRE=1      : do NOT bundle jre (target PC must have java)
REM   - REQUIRE_BUNDLE=0: warn instead of failing when deps are missing
REM   - FORCE_COPY=1    : re-copy allure/jre even if dist already has them
REM   - bundled jre is a 126M JRE 17, NOT the old 231M jdk8 jre
REM ============================================

set "PY=C:\software\Python\python.exe"
if not exist "%PY%" (
    echo [WARN] %PY% not found, fallback to PATH python
    set "PY=python"
)

REM UPX compresses dlls/pyd (optional, smaller output)
if exist "D:\upx-5.0.2-win64\upx.exe" set "PATH=D:\upx-5.0.2-win64;%PATH%"

REM ---- MSVC/SDK env (same as vcvars64, so no VS dev prompt needed) ----
set "MSVC_DIR=C:\software\Microsoft Visual Studio18\VC\Tools\MSVC\14.51.36231"
set "SDK_DIR=C:\Program Files (x86)\Windows Kits\10"
set "SDK_VER=10.0.26100.0"
if exist "%MSVC_DIR%\bin\HostX64\x64\cl.exe" (
    set "INCLUDE=%MSVC_DIR%\include;%SDK_DIR%\Include\%SDK_VER%\ucrt;%SDK_DIR%\Include\%SDK_VER%\um;%SDK_DIR%\Include\%SDK_VER%\shared;%SDK_DIR%\Include\%SDK_VER%\winrt"
    set "LIB=%MSVC_DIR%\lib\x64;%SDK_DIR%\Lib\%SDK_VER%\ucrt\x64;%SDK_DIR%\Lib\%SDK_VER%\um\x64"
    set "PATH=%SDK_DIR%\bin\%SDK_VER%\x64;%MSVC_DIR%\bin\HostX64\x64;%PATH%"
) else (
    echo [WARN] MSVC not found at %MSVC_DIR%, cython step may fail
)

REM ---- portable deps preflight: fail fast, before cython + pyinstaller ----
REM      (otherwise a missing allure/jre only surfaces 10 min later)
REM      same check the CI uses: pyd_pack.py --check-deps
if not defined ALLURE_SRC set "ALLURE_SRC=C:\software\allure-2.32.0"
if not defined JRE_SRC    set "JRE_SRC=C:\software\java\jre-17"
echo.
echo [0/3] Check portable deps (allure / jre) ...
"%PY%" pyd_pack.py --check-deps
if errorlevel 1 (
    echo [FAIL] portable deps not ready, see messages above
    echo        ALLURE_SRC / JRE_SRC can override the source dirs
    pause
    exit /b 1
)

echo.
echo [1/3] Install dependencies ...
"%PY%" -m pip install -r requirements.txt
if errorlevel 1 ( echo [FAIL] pip install error & pause & exit /b 1 )
"%PY%" -m pip show cython >nul 2>&1 || "%PY%" -m pip install cython
"%PY%" -m PyInstaller --version >nul 2>&1 || "%PY%" -m pip install pyinstaller

echo.
echo [2/3] Cython compile pomelo_app.py -^> .pyd ...
"%PY%" setup_pyd.py build_ext --inplace
if errorlevel 1 ( echo [FAIL] cython build error & pause & exit /b 1 )

echo.
echo [3/3] PyInstaller pack (pyd only) + bundle allure/jre ...
"%PY%" pyd_pack.py
if errorlevel 1 ( echo [FAIL] pack error & pause & exit /b 1 )

REM ---- final layout checks ----
set "CHK_ERR="
if not exist "dist\PomeloTool\PomeloTool.exe" set "CHK_ERR=exe"
if not exist "dist\PomeloTool\_internal\web\index.html" set "CHK_ERR=web resources"
if not exist "dist\PomeloTool\tools\allure-commandline\bin\allure.bat" set "CHK_ERR=allure-commandline"
if not "%SKIP_JRE%"=="1" if not exist "dist\PomeloTool\tools\jre\bin\java.exe" set "CHK_ERR=portable jre"
if defined CHK_ERR (
    echo [FAIL] final layout check, missing: %CHK_ERR%
    echo        the package would start but fail when opening an Allure report
    pause
    exit /b 1
)
if exist "dist\PomeloTool\data" (
    echo [FAIL] data\ must NOT be bundled, found dist\PomeloTool\data
    pause
    exit /b 1
)
if "%SKIP_JRE%"=="1" (
    echo [WARN] SKIP_JRE=1 - no portable jre, target PC needs java installed
) else (
    echo [OK] portable jre bundled
)
powershell -NoProfile -Command "$t=(Get-ChildItem -Recurse -File 'dist\PomeloTool\tools' -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum/1MB; $a=(Get-ChildItem -Recurse -File 'dist\PomeloTool' -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum/1MB; Write-Host ('[OK] tools ' + [math]::Round($t,1) + ' MB | package ' + [math]::Round($a,1) + ' MB')"

REM ---- first-run helper: unblock MOTW + check .NET on target PC ----
copy /y "%~dp0fix_and_check.bat" "dist\PomeloTool\fix_and_check.bat" >nul
if exist "dist\PomeloTool\fix_and_check.bat" (
    echo [OK] fix_and_check.bat copied into package
) else (
    echo [WARN] fix_and_check.bat missing, target PC may hit MOTW block
)

REM ---- zip package for distribution (set NO_ZIP=1 to skip) ----
if defined NO_ZIP goto :skipzip
echo.
echo [zip] Create distribution zip ...
powershell -NoProfile -Command "$d = Get-Date -Format yyyyMMdd; $z = 'PomeloTool_' + $d + '.zip'; if (Test-Path $z) { Remove-Item $z -Force }; Compress-Archive -Path 'dist\PomeloTool' -DestinationPath $z -Force; Write-Host ('[OK] created ' + $z)"
if errorlevel 1 ( echo [FAIL] zip error & pause & exit /b 1 )
:skipzip

echo.
echo ============================================
echo  Build OK: dist\PomeloTool\PomeloTool.exe
echo  Ship whole dist\PomeloTool folder, keep _internal and tools
echo  Data lives in dist\PomeloTool\data (created at runtime)
echo ============================================
pause
