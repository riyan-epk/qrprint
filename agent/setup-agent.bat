@echo off
setlocal
cd /d "%~dp0"
echo ==================================================
echo    QRPrint Print Agent - one-time setup
echo ==================================================
echo.

REM 1) Real Python? (The Microsoft Store placeholder FAILS this check, which is
REM    what we want - it is not a usable Python.)
python --version >nul 2>&1
if errorlevel 1 goto need_python
for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PYVER=%%v
if "%PYVER%"=="" goto need_python
echo Found Python %PYVER%.
goto have_python

:need_python
echo Python is not installed. Installing it now via winget...
winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
echo.
echo ==================================================
echo  Python was installed. Now:
echo   1) CLOSE this window.
echo   2) Double-click setup-agent.bat AGAIN.
echo.
echo  If running it again STILL says "Python was not found",
echo  turn off the Windows placeholder:
echo    Settings ^> Apps ^> Advanced app settings ^>
echo    App execution aliases ^> turn OFF python.exe and python3.exe
echo  then run setup-agent.bat again.
echo ==================================================
pause
exit /b

:have_python
echo Installing SumatraPDF (for printing)...
winget install -e --id SumatraPDF.SumatraPDF --accept-source-agreements --accept-package-agreements

echo Installing Python packages...
python -m pip install -r requirements.txt
if errorlevel 1 (
  echo.
  echo *** Package install FAILED. Fix Python, then run setup-agent.bat again. ***
  pause
  exit /b
)

if not exist config.json (
  copy config.example.json config.json >nul
  echo Created config.json.
)

echo.
echo ==================================================
echo  SETUP DONE. Two steps left:
echo   1) Open config.json (right-click - Edit) and paste
echo      your AGENT KEY into "agent_key".
echo   2) Double-click run-agent.bat to start printing.
echo ==================================================
echo.
pause
