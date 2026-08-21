# ☁️ Always-On Free Server — Oracle Cloud (no VPS bill, PC can be off)

Goal: run QRPrint on a free Oracle Linux server 24/7. We **reuse your existing
Cloudflare tunnel**, so `print.mystay.live` keeps working — it just points to the
cloud instead of your PC. No ports to open, no DNS changes.

Time: ~30–45 minutes, once.

---

## PART 1 — Create the free server

1. Sign up at **oracle.com/cloud/free** (needs email + a card for identity check —
   the **Always Free** resources are never charged).
2. In the console: **Menu → Compute → Instances → Create instance**.
3. Settings:
   - **Name:** `qrprint`
   - **Image:** Canonical **Ubuntu 24.04**
   - **Shape:** click *Change shape* → **Ampere (ARM)** → `VM.Standard.A1.Flex`,
     set **2 OCPU / 12 GB** (still Always Free). If ARM is "out of capacity",
     use `VM.Standard.E2.1.Micro` (AMD, 1 GB, also Always Free).
   - **SSH keys:** choose **Generate a key pair for me** and **Download the
     private key** (save it, e.g. `qrprint.key`). You need it to log in.
4. Click **Create**. When it's running, copy the **Public IP address**.

---

## PART 2 — Log in to the server

On your **PC** (PowerShell), from the folder where you saved the key:

```bash
icacls qrprint.key /inheritance:r /grant:r "%USERNAME%:R"
ssh -i qrprint.key ubuntu@YOUR_PUBLIC_IP
```

(Type `yes` the first time.) You're now on the server. Update it:

```bash
sudo apt update && sudo apt -y upgrade
```

---

## PART 3 — Install what the server needs

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git unzip

# LibreOffice (for Word/Excel/PowerPoint printing)
sudo apt install -y libreoffice --no-install-recommends fonts-liberation
```

Check: `node --version` and `soffice --version` should both print versions.

---

## PART 4 — Put the app on the server

On your **PC** (PowerShell, in the `printing` folder), make a source zip
(without the big/local folders):

```bash
Compress-Archive -Path server,scripts,package.json,package-lock.json,deploy -DestinationPath qrprint-src.zip -Force
```

Upload it to the server:

```bash
scp -i qrprint.key qrprint-src.zip ubuntu@YOUR_PUBLIC_IP:~/
```

Back **on the server**:

```bash
mkdir -p ~/printing && unzip -o ~/qrprint-src.zip -d ~/printing
cd ~/printing
npm install --omit=dev
```

---

## PART 5 — Configure (secrets + your domain)

**Important:** reuse your EXISTING keys so your shops' agents keep working. On
your PC, open `.env` and note `AGENT_KEY`, `ADMIN_KEY`, `SESSION_SECRET`.
Actually simplest — copy your whole `.env` up:

```bash
# on your PC
scp -i qrprint.key .env ubuntu@YOUR_PUBLIC_IP:~/printing/.env
```

Also copy your existing shops/jobs so nothing is lost:

```bash
# on your PC (if you want to keep current shops)
Compress-Archive -Path data -DestinationPath data.zip -Force
scp -i qrprint.key data.zip ubuntu@YOUR_PUBLIC_IP:~/printing/
# then on the server:
cd ~/printing && unzip -o data.zip
```

Make sure `.env` has `PUBLIC_URL=https://print.mystay.live` and
`NODE_ENV=production` and `TRUST_PROXY=1` (it already should).

---

## PART 6 — Run the server as a service (auto-starts, auto-restarts)

On the **server**:

```bash
sudo cp ~/printing/deploy/qrprint-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qrprint-server
systemctl status qrprint-server --no-pager   # should say "active (running)"
```

Quick local check:

```bash
curl -s http://localhost:3000/api/health
```

---

## PART 7 — Move the Cloudflare tunnel to the server

Install cloudflared (pick the line matching your shape):

```bash
# ARM (Ampere) instance:
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o cloudflared
# --- OR --- AMD (E2.1.Micro) instance:
# curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared

sudo install cloudflared /usr/local/bin/
cloudflared --version
```

Run your tunnel here using the **same token** from before (Cloudflare → Networks
→ Tunnels → your tunnel → the `--token …` value):

```bash
sudo cloudflared service install YOUR_TUNNEL_TOKEN
systemctl status cloudflared --no-pager   # should be active
```

Now `print.mystay.live` is served from the cloud server.

---

## PART 8 — Turn off your PC

1. On your **PC**, stop the old copies: close the server window and the tunnel
   window (or stop the cloudflared service if you installed it there).
2. **Turn your PC off.**
3. On your phone, open `https://print.mystay.live/p/` — it still works. 🎉

Your shops' `qrprint-agent.exe` keep connecting to the same address — nothing
changes on their side.

---

## Everyday admin

- **Update the app after a code change — ONE command** from your PC (in the
  `printing` folder):
  ```
  .\deploy\push.ps1 -Ip YOUR_SERVER_IP
  ```
  It zips the code, uploads it, and restarts the server. Your shops/jobs (`data/`)
  and `.env` on the server are left untouched. (First time, allow SSH when asked.)
- **No redeploy needed** for adding shops, changing prices, suspending, or any
  day-to-day action — those happen live in the dashboard/admin.
- **Server logs:** `journalctl -u qrprint-server -f`
- **Backups:** copy `~/printing/data/db.json` somewhere safe regularly.
- **It reboots automatically** and both services come back on their own.

## Costs
Ampere Always Free = **$0/month**, forever, as long as you stay within the free
shape (2 OCPU / 12 GB is inside it). No surprise bills.
