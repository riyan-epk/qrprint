# 🚀 QRPrint — Deployment Guide

Two ways to run, both production-ready:

| Mode | Where the server runs | How the phone connects | Best for |
|------|----------------------|------------------------|----------|
| **A. Local** | The shop's own PC/laptop | Phone on the **same WiFi** | First pilot, one shop, zero hosting cost |
| **B. Hybrid** | A cloud server (VPS) | Phone on **its own mobile data** | Real product, many shops, best UX |
| **B-free. Hybrid via tunnel** | Your own PC (no VPS) | Phone on **its own mobile data** | Testing hybrid for free — see **[TUNNEL.md](TUNNEL.md)** |

The **same code** runs both. Start with A to test with your first client, move to B when you're ready.

---

## What you need

- **Node.js 18+** (server) and **Python 3.9+** (print agent).
- A **printer** connected to the shop PC / Raspberry Pi.
- For **live printing**: SumatraPDF (Windows) or CUPS (Linux/Pi).
- For **hybrid (B)**: a cheap VPS + a domain name.
- For **real payments**: JazzCash merchant credentials (yours or the shop's). Until you have them, `mock` payments let you demo the full flow.

---

## MODE A — Local pilot (one PC, same WiFi)

### 1. First-time setup

```bash
npm install
node scripts/setup.mjs --password "choose-a-dashboard-password"
```

`setup` generates strong keys into `.env`. For a purely local pilot you can also
just leave `NODE_ENV=development` in `.env` to keep the dashboard open (no login).

### 2. Start the server

```bash
npm start
```

The console shows the **network URL** (e.g. `http://192.168.1.12:3000`) and the
**agent key**.

### 3. Set up the print agent

```bash
cd agent
pip install -r requirements.txt
copy config.example.json config.json     # macOS/Linux: cp
```

Edit `agent/config.json`:
- `server_url` → the server's network URL (e.g. `http://192.168.1.12:3000`).
- `agent_key` → the key from the server console (or your `.env`).
- `print_mode` → `"dry"` to test safely, `"live"` to actually print.
- Windows: set `sumatra_path` to the SumatraPDF exe. Linux/Pi: ensure `lp` works.

Then:

```bash
python agent.py
```

### 4. Configure the shop

Open `http://localhost:3000/dashboard/` → **Settings**: shop name, prices, what
the printer can do (color/duplex), and the shop's payout account. Print the QR
from the **QR code** tab and stick it on the counter.

### 5. Test

Scan the QR with a phone **on the same WiFi**, upload a PDF, pay (mock), collect
the print. Done.

> ⚠️ Local-mode limits: the phone must be on the shop's WiFi, and online payment
> still needs the shop to have internet. For customers using mobile data, use
> Mode B.

---

## MODE B — Hybrid (cloud + HTTPS, phones use mobile data)

This puts the server on the internet with a real HTTPS address, so any phone can
scan and print from anywhere. The agent at the shop connects out to it.

### 1. Get a VPS + domain

- A small VPS (1 GB RAM is plenty) from any provider.
- A domain, with an **A record** pointing to the VPS IP (e.g.
  `print.yourdomain.com`).

### 2. Put the code on the VPS and configure

```bash
git clone <your-repo>   # or copy the folder up
cd printing
node scripts/setup.mjs --password "dashboard-password" --public-url https://print.yourdomain.com
```

Edit `.env` if needed (keep `NODE_ENV=production`, `TRUST_PROXY=1`).
Edit **`Caddyfile`** — replace `print.yourdomain.com` with your real domain.

### 3. Launch with Docker (automatic HTTPS)

```bash
docker compose up -d
```

Caddy fetches a real Let's Encrypt certificate automatically. Your system is now
live at `https://print.yourdomain.com`.

> No Docker? You can instead run `npm install && npm start` behind Nginx/Caddy
> yourself, or use `pm2 start server/index.js`. Docker is just the easy path.

### 4. Point the shop's agent at the cloud

On the shop's PC/Pi, in `agent/config.json`:
- `server_url` → `https://print.yourdomain.com`
- `agent_key` → the `AGENT_KEY` from the VPS `.env`
- `print_mode` → `live`

Run it as a background service so it survives reboots:
- **Raspberry Pi / Linux:** use `deploy/qrprint-agent.service` (instructions inside).
- **Windows:** put a shortcut to `deploy/run-agent-windows.bat` in the Startup
  folder (`Win+R` → `shell:startup`).

### 5. Configure & test

Same as Mode A step 4–5, but now phones scan using **their own mobile data** — no
shop WiFi needed.

---

## Turning on real JazzCash payments

1. Get JazzCash merchant credentials (Merchant ID, Password, Integrity Salt).
2. In `.env`: set `PAYMENT_PROVIDER=jazzcash` and fill the three `JAZZCASH_*`
   values. Keep the **sandbox** `JAZZCASH_BASE_URL` first.
3. Restart. Test a real sandbox payment end-to-end and confirm the job flips to
   **paid** after the callback.
4. Only then switch `JAZZCASH_BASE_URL` to the live endpoint.

> The integration lives in `server/jazzcash.js`. The hashing/field set follows
> the standard JazzCash spec but **must be verified against your current sandbox
> docs** — treat sandbox testing as required, not optional.

---

## The remote lock (subscription) in production

Open `https://your-domain/admin/`, log in with the **admin key** (`ADMIN_KEY`
from `.env`). Suspend a shop that hasn't paid; **Mark paid** to reactivate
instantly. A grace period keeps a slightly-late shop working (with a warning)
before it locks.

---

## Backups & data

Everything lives under the data directory (`/data` in Docker, `./data` locally):
`db.json` (shops, jobs, subscription) plus `uploads/` and `logs/`. Back up
`db.json` regularly. In Docker it's the `qrprint-data` volume.

See **GO-LIVE.md** for the pre-client checklist.
