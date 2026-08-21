@echo off
cd /d "%~dp0"
title QRPrint Print Agent
:loop
python -u agent.py
echo.
echo Agent stopped. Restarting in 5 seconds... (close this window to stop)
timeout /t 5 /nobreak >nul
goto loop
