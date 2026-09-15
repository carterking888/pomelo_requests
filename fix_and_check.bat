@echo off
REM ============================================================
REM  Run this ONCE after extracting the zip, before PomeloTool.exe
REM  Fix 1: remove Mark-of-the-Web from all extracted files
REM  Fix 2: check .NET Framework version (pythonnet needs 4.7.2+)
REM ============================================================
cd /d "%~dp0"

echo [1/2] Removing Mark-of-the-Web from all files...
powershell -NoProfile -Command "Get-ChildItem -Recurse | Unblock-File"
echo       Done.

echo [2/2] Checking .NET Framework version...
set NETREL=0
for /f "tokens=2*" %%a in ('reg query "HKLM\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full" /v Release 2^>nul') do set NETREL=%%b
if "%NETREL%"=="0" (
    echo       .NET Framework 4.x NOT found - please install .NET Framework 4.8 Runtime.
) else (
    echo       Release = %NETREL%  ^(4.7.2 = 461808, 4.8 = 528040^)
    if %NETREL% LSS 461808 (
        echo       TOO OLD - please install .NET Framework 4.8 Runtime.
    ) else (
        echo       OK.
    )
)

echo.
echo All done. Now run PomeloTool.exe
echo If it still fails, screenshot this window and send it back.
pause
