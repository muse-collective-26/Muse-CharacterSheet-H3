@echo off
setlocal
cd /d "%~dp0"
for %%I in ("%~dp0..\..\..") do set "MUSE_COMFY=%%~fI"
if not exist "%MUSE_COMFY%\main.py" goto badroot
set "MUSE_PY=%MUSE_COMFY%\..\python_embeded\python.exe"
if exist "%MUSE_PY%" goto found
set "MUSE_PY=%MUSE_COMFY%\.venv\Scripts\python.exe"
if exist "%MUSE_PY%" goto found
echo Enter the full path to THIS ComfyUI environment's python.exe, without quotes.
set /p "MUSE_PY=Python: "
if not exist "%MUSE_PY%" goto badpython
:found
"%MUSE_PY%" "%~dp0install_dependencies.py" --comfyui "%MUSE_COMFY%" --enhanced
if errorlevel 1 goto failed
echo.
echo Close ComfyUI before continuing. No model weights will be downloaded.
choice /C YN /N /M "Install the listed node packages and Python dependencies? [Y/N]: "
if errorlevel 2 goto cancelled
"%MUSE_PY%" "%~dp0install_dependencies.py" --comfyui "%MUSE_COMFY%" --enhanced --install
if errorlevel 1 goto failed
echo Setup finished. See INSTALLATION.md for models and the separate DLSS runtime.
pause
exit /b 0
:badroot
echo Place this package under ComfyUI\custom_nodes\Muse-CharacterSheet-H3 first.
goto failed
:badpython
echo Python was not found. Use the interpreter belonging to your ComfyUI installation.
:failed
echo Setup did not finish. Review the error above. Do not replace your PyTorch build blindly.
pause
exit /b 1
:cancelled
echo Cancelled. No installation was requested.
pause
exit /b 0
