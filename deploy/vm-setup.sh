#!/usr/bin/env bash
# One-shot setup for running QRPrint on a Linux VM (co-hosting with other apps).
# Installs Node + LibreOffice + cloudflared, configures the app, and starts it
# as a service plus the Cloudflare tunnel.
#
# Usage (run from inside the cloned repo):
#   sudo bash deploy/vm-setup.sh "<cloudflare-tunnel-token>"
#   (optionally add a starter-shop password: ... "<tunnel-token>" "<starter-password>")
#
# You manage shops — each with its OWN dashboard password — later in /admin/.
# Works on Ubuntu/Debian (apt) and Oracle Linux/RHEL (dnf).
set -e

TOKEN="${1:-}"
PW="${2:-}"
PUBLIC_URL="${3:-https://print.mystay.live}"

if [ -z "$TOKEN" ]; then
  echo "Usage: sudo bash deploy/vm-setup.sh \"<cloudflare-tunnel-token>\" [starter-password] [public-url]"
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

echo ">> Installing Node.js + git ..."
if [ "$PM" = "apt" ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs git
else
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
  dnf install -y nodejs git
fi

echo ">> Installing LibreOffice (for Word/Excel) — best effort ..."
if [ "$PM" = "apt" ]; then
  apt install -y libreoffice --no-install-recommends fonts-liberation \
    || echo "WARN: LibreOffice not installed — Word/Excel disabled; PDF/image still work."
else
  # Oracle Linux / RHEL 9 has no meta 'libreoffice' package — use sub-packages.
  dnf install -y libreoffice-writer libreoffice-calc libreoffice-impress \
    || dnf groupinstall -y "Office Suite and Productivity" \
    || echo "WARN: LibreOffice not installed — Word/Excel disabled; PDF/image still work."
fi

# --- app deps + config -----------------------------------------------------
echo ">> Installing app dependencies ..."
cd "$REPO_DIR"
sudo -u "$RUN_USER" npm install --omit=dev
echo ">> Writing config (.env) ..."
if [ -n "$PW" ]; then
  sudo -u "$RUN_USER" node scripts/setup.mjs --public-url "$PUBLIC_URL" --password "$PW"
else
  sudo -u "$RUN_USER" node scripts/setup.mjs --public-url "$PUBLIC_URL"
fi

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
/usr/local/bin/cloudflared service install "$TOKEN"

ADMIN_KEY="$(grep '^ADMIN_KEY=' "$REPO_DIR/.env" | cut -d= -f2)"
echo ""
echo "=================================================="
echo "  Done. QRPrint is running on this VM."
echo "  Live:        $PUBLIC_URL/p/"
echo ""
echo "  NEXT — create your shops:"
echo "  1) Open  $PUBLIC_URL/admin/"
echo "  2) Log in with ADMIN key:  $ADMIN_KEY"
echo "  3) Add each shop -> it gives that shop's ID, password, and agent key."
echo ""
echo "  Then stop the server + tunnel on your PC."
echo "=================================================="
