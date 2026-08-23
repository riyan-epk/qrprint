#!/usr/bin/env bash
# Auto-deploy: pulls from GitHub and restarts ONLY if there's a new commit.
# Designed to run from ROOT cron so `systemctl restart` needs no password.
#
# Install (once):
#   sudo crontab -e
#   # then add this line (adjust the path/user if different):
#   */5 * * * * bash /home/opc/printing/deploy/auto-update.sh >> /var/log/qrprint-deploy.log 2>&1
#
# Edit these two if your username/path differ:
REPO="/home/opc/printing"
OWNER="opc"

cd "$REPO" || exit 0
git config --global --add safe.directory "$REPO" 2>/dev/null || true

before=$(sudo -u "$OWNER" git rev-parse HEAD 2>/dev/null)
sudo -u "$OWNER" git pull --ff-only >/dev/null 2>&1 || exit 0
after=$(sudo -u "$OWNER" git rev-parse HEAD 2>/dev/null)

[ "$before" = "$after" ] && exit 0   # nothing new

sudo -u "$OWNER" npm install --omit=dev >/dev/null 2>&1
systemctl restart qrprint-server
echo "$(date '+%F %T') deployed $after"
