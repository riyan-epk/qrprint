@echo off
REM ============================================================================
REM  QRPrint one-click launcher — starts Server + Tunnel + Print Agent.
REM  Double-click this file to start everything. Each part opens in its own
REM  window; close a window to stop that part.
REM ============================================================================

cd /d "%~dp0"

REM ---------------------------------------------------------------------------
REM  EDIT THIS ONCE: paste your Cloudflare tunnel token between the quotes.
REM  (Get it from Cloudflare -> Networks -> Tunnels -> your tunnel -> the
REM   "cloudflared ... run --token XXXX" command. Copy just the XXXX part.)
REM
REM  If you installed cloudflared as a Windows SERVICE, LEAVE THIS BLANK.
REM ---------------------------------------------------------------------------
set "TUNNEL_TOKEN="

echo.
echo   Starting QRPrint...
echo   --------------------------------------------------

REM 1) The server
start "QRPrint Server" cmd /k "cd /d %~dp0 && npm start"

REM 2) The Cloudflare tunnel (only if a token was provided above)
if not "%TUNNEL_TOKEN%"=="" (
  echo   - launching Cloudflare tunnel
  start "Cloudflare Tunnel" cmd /k "cloudflared tunnel run --token %TUNNEL_TOKEN%"
) else (
  echo   - tunnel token blank: assuming cloudflared runs as a service
)

REM 3) The print agent (give the server a couple of seconds first)
timeout /t 3 /nobreak >nul
start "Print Agent" cmd /k "cd /d %~dp0agent && python -u agent.py"

echo.
echo   All parts launched in separate windows:
echo     * QRPrint Server
echo     * Cloudflare Tunnel   (if token set / else service)
echo     * Print Agent
echo.
echo   Your live link:  https://print.mystay.live/p/
echo   Dashboard:       https://print.mystay.live/dashboard/
echo.
echo   Close a window to stop that part. You can close THIS window now.
echo   --------------------------------------------------
timeout /t 8 >nul
