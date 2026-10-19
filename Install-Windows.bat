@echo off
setlocal
if not exist "%~dp0Installers\launch_windows.ps1" (
  echo Download and extract the COMPLETE ZIP, not this BAT alone.
  echo Keep this BAT beside __init__.py and the Installers folder.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Installers\launch_windows.ps1"
set "MUSE_RESULT=%ERRORLEVEL%"
pause
exit /b %MUSE_RESULT%
