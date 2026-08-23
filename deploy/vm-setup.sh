#!/usr/bin/env bash
# One-shot setup for running QRPrint on a Linux VM (co-hosting with other apps).
# Installs Node + LibreOffice + cloudflared, configures the app, and starts it
# as a service plus the Cloudflare tunnel.
#
# Usage (run from inside the cloned repo):
#   sudo bash deploy/vm-setup.sh "<dashboard-password>" "<cloudflare-tunnel-token>"
#
# Works on Ubuntu/Debian (apt) and Oracle Linux/RHEL (dnf).
set -e

PW="${1:-}"
TOKEN="${2:-}"
PUBLIC_URL="${3:-https://print.mystay.live}"

if [ -z "$PW" ] || [ -z "$TOKEN" ]; then
  echo "Usage: sudo bash deploy/vm-setup.sh \"<dashboard-password>\" \"<tunnel-token>\" [public-url]"
  exit 1
fi

# The repo root = parent of this script's folder.
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_USER="${SUDO_USER:-$(whoami)}"
echo ">> Repo: $REPO_DIR   User: $RUN_USER"

# --- package manager -------------------------------------------------------
if command -v apt >/dev/null 2>&1; then
  PM=apt
elif command -v dnf >/dev/null 2>&1; then
  PM=dnf
else
  echo "No apt or dnf found — unsupported distro."; exit 1
fi
echo ">> Package manager: $PM"

echo ">> Installing Node.js, git, LibreOffice ..."
if [ "$PM" = "apt" ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs git libreoffice --no-install-recommends
  apt install -y fonts-liberation || true
else
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
  dnf install -y nodejs git libreoffice
fi

# --- app deps + config -----------------------------------------------------
echo ">> Installing app dependencies ..."
cd "$REPO_DIR"
sudo -u "$RUN_USER" npm install --omit=dev
echo ">> Writing config (.env) ..."
sudo -u "$RUN_USER" node scripts/setup.mjs --public-url "$PUBLIC_URL" --password "$PW"

# --- server service --------------------------------------------------------
echo ">> Installing qrprint-server service ..."
cat >/etc/systemd/system/qrprint-server.service <<UNIT
[Unit]
Description=QRPrint server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$REPO_DIR
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now qrprint-server

# --- cloudflared tunnel ----------------------------------------------------
echo ">> Installing cloudflared ..."
ARCH="$(uname -m)"
case "$ARCH" in
  aarch64|arm64) CF=cloudflared-linux-arm64 ;;
  x86_64|amd64)  CF=cloudflared-linux-amd64 ;;
  *) echo "Unknown arch $ARCH"; exit 1 ;;
esac
curl -L "https://github.com/cloudflare/cloudflared/releases/latest/download/$CF" -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared
cloudflared service install "$TOKEN"

echo ""
echo "=================================================="
echo "  Done. QRPrint is running on this VM."
echo "  Local check:  curl -s http://localhost:3000/api/health"
echo "  Live:         $PUBLIC_URL/p/"
echo "  Now stop the server + tunnel on your PC."
echo "=================================================="
