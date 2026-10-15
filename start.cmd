@echo off
rem ============================================================
rem  Launcher for the DSH session editor GUI.
rem
rem  KEEP THIS FILE PURE ASCII. cmd.exe reads .cmd files using the
rem  console code page (936/GBK on Chinese Windows), so UTF-8 text
rem  here gets decoded into garbage and executed as commands.
rem  All human-readable output lives in start.ps1 instead.
rem ============================================================
setlocal
cd /d "%~dp0"

rem Switch the console to UTF-8 so Node's Chinese output renders correctly.
chcp 65001 >nul 2>nul

set "PS_EXE=pwsh.exe"
where pwsh.exe >nul 2>nul
if errorlevel 1 set "PS_EXE=powershell.exe"

"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
  echo.
  echo The editor exited with code %EXITCODE%.
  echo If a port conflict was reported, try:  start.cmd --port=4320
  echo.
  pause
)
endlocal & exit /b %EXITCODE%
