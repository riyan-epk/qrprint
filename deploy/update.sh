#!/usr/bin/env bash
# Runs ON the server. Applies a freshly uploaded qrprint-src.zip and restarts.
# Called automatically by deploy/push.ps1 from your PC.
set -e
cd ~/printing
echo "Applying update..."
unzip -o ~/qrprint-src.zip -d ~/printing >/dev/null
npm install --omit=dev >/dev/null 2>&1 || npm install --omit=dev
sudo systemctl restart qrprint-server
sleep 2
if curl -s http://localhost:3000/api/health >/dev/null; then
  echo "✓ Updated and running."
else
  echo "! Server not responding — check: journalctl -u qrprint-server -n 50"
fi
