#!/usr/bin/env bash
# Manual redeploy on the VM after code changes are pushed to GitHub.
# Run from anywhere:  bash ~/printing/deploy/update-vm.sh
set -e
cd "$(dirname "$0")/.."
echo ">> Pulling latest code ..."
git pull --ff-only
echo ">> Installing dependencies ..."
npm install --omit=dev
echo ">> Restarting the service ..."
sudo systemctl restart qrprint-server
sleep 2
if curl -s http://localhost:3000/api/health >/dev/null; then
  echo "✓ Updated and running."
else
  echo "! Not responding — check: journalctl -u qrprint-server -n 40"
fi
