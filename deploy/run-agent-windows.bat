@echo off
REM Windows print agent launcher with auto-restart.
REM Put a shortcut to this file in the Startup folder (Win+R -> shell:startup)
REM so the agent runs whenever the shop PC boots.

cd /d "%~dp0..\agent"
:loop
echo Starting QRPrint agent...
python -u agent.py
echo Agent stopped. Restarting in 5 seconds... (close this window to stop)
timeout /t 5 /nobreak >nul
goto loop
