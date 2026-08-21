# One-command deploy from your PC to the server.
# Usage (from the printing folder):
#   .\deploy\push.ps1 -Ip YOUR_SERVER_IP
# Optional: -Key path\to\qrprint.key   -User ubuntu
#
# It zips the code, uploads it, and restarts the server. Your data (shops/jobs)
# and .env on the server are NOT touched.
param(
  [Parameter(Mandatory = $true)][string]$Ip,
  [string]$Key = "qrprint.key",
  [string]$User = "ubuntu"
)

$ErrorActionPreference = "Stop"

Write-Host "Packing code..."
Compress-Archive -Path server, scripts, package.json, package-lock.json, deploy `
  -DestinationPath qrprint-src.zip -Force

Write-Host "Uploading to $Ip..."
scp -i $Key qrprint-src.zip "${User}@${Ip}:~/"

Write-Host "Applying on server..."
ssh -i $Key "${User}@${Ip}" "bash ~/printing/deploy/update.sh"

Write-Host "Done. https://print.mystay.live is updated."
