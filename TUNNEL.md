# 🌩️ Free Hybrid Deploy with Cloudflare Tunnel (no VPS, no cost)

This lets you run the **whole system on your own laptop / the shop PC** and still
give customers a real **https:// link they can open on mobile data** — with
**no VPS, no public IP, no port-forwarding, and no monthly cost**. The only thing
you pay for is the domain you already own.

```
Customer phone (mobile data)
        │  https://print.yourdomain.com
        ▼
Cloudflare edge  (free HTTPS)
        │  encrypted tunnel
        ▼
cloudflared on your PC  ──►  QRPrint server on localhost:3000  ──►  printer
```

There are **two ways**. Start with Option 1 to test in 2 minutes; use Option 2
for a real client demo with your own subdomain.

---

## Before you start

Have the server running locally first, in a terminal:

```bash
npm install
node scripts/setup.mjs --password "your-dashboard-password"
npm start
```

Leave it running. It should say it's on `http://localhost:3000`. Open a **second
terminal** for the tunnel commands below.

Install **cloudflared** (the tunnel program):

- **Windows:**
  ```bash
  winget install --id Cloudflare.cloudflared
  ```
  (or download `cloudflared-windows-amd64.exe` from Cloudflare's GitHub releases,
  rename it to `cloudflared.exe`, and put it in a folder on your PATH.)
- **Raspberry Pi / Linux:**
  ```bash
  curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o cloudflared
  sudo install cloudflared /usr/local/bin/
  ```
- Check it works:
  ```bash
  cloudflared --version
  ```

---

## OPTION 1 — Instant test (no account, no domain) ⚡

Fastest way to test everything. Cloudflare gives you a **random temporary
https URL**. No login, no domain needed.

In the second terminal:

```bash
cloudflared tunnel --url http://localhost:3000
```

It prints a line like:

```
Your quick Tunnel has been created! Visit it at:
https://random-words-here.trycloudflare.com
```

**That URL is now live on the internet.** Test it:

1. So the QR encodes the right address, stop the server and restart it with that
   URL as `PUBLIC_URL`:
   - **Windows (PowerShell):**
     ```bash
     $env:PUBLIC_URL="https://random-words-here.trycloudflare.com"; npm start
     ```
   - **Linux/Mac:**
     ```bash
     PUBLIC_URL="https://random-words-here.trycloudflare.com" npm start
     ```
2. On your **phone (using mobile data, WiFi off)**, open
   `https://random-words-here.trycloudflare.com/p/` — upload a PDF, pay (mock),
   and watch it print. 🎉

> ⚠️ The random URL **changes every time** you restart the tunnel. That's fine
> for testing with mock payments. For a stable link (and JazzCash callbacks), use
> Option 2.

---

## OPTION 2 — Permanent subdomain `print.yourdomain.com` 🏷️

For real client demos. Your own branded, **stable** HTTPS link. One-time setup.

### Step 1 — Move your domain's DNS to Cloudflare (free)

1. Create a free account at **cloudflare.com**.
2. Click **Add a site**, enter your domain (e.g. `yourdomain.com`), pick the
   **Free** plan.
3. Cloudflare shows you **2 nameservers** (like `xyz.ns.cloudflare.com`).
4. Go to **Namecheap → Domain List → Manage → Nameservers**, choose
   **Custom DNS**, and paste Cloudflare's 2 nameservers. Save.
5. Wait for Cloudflare to email you that the domain is **Active** (usually
   minutes, can take a few hours). You keep the domain at Namecheap — only DNS
   moves to Cloudflare.

### Step 2 — Create the tunnel (dashboard method — easiest)

1. In Cloudflare, open **Zero Trust** (left sidebar) → **Networks → Tunnels**.
   (First time it asks you to pick a team name — any name, Free plan.)
2. **Create a tunnel → Cloudflared →** name it `qrprint` → **Save**.
3. It shows an **install command with a long token**. Pick your OS tab and run it
   on the PC that runs the server. For example on Windows it looks like:
   ```bash
   cloudflared service install eyJ...long-token...
   ```
   This installs cloudflared as a background service (auto-starts on boot). To
   just test without installing a service, instead run:
   ```bash
   cloudflared tunnel run --token eyJ...long-token...
   ```
4. Back in the dashboard, on the tunnel's **Public Hostname** tab, click
   **Add a public hostname**:
   - **Subdomain:** `print`
   - **Domain:** `yourdomain.com`
   - **Type:** `HTTP`
   - **URL:** `localhost:3000`
   - **Save**. (Cloudflare creates the DNS record for you automatically.)

### Step 3 — Point the server at the subdomain

Set your public URL and restart the server:

```bash
node scripts/setup.mjs --public-url https://print.yourdomain.com
npm start
```

(`setup` keeps your existing password/keys and just updates `PUBLIC_URL`. Make
sure `.env` has `NODE_ENV=production` and `TRUST_PROXY=1` — setup sets these.)

### Step 4 — Done

`https://print.yourdomain.com` is now your live system, served from your own PC
over Cloudflare's HTTPS. Open `https://print.yourdomain.com/p/` on any phone,
anywhere. Print the QR from **Dashboard → QR code**.

---

## Test each and every thing (full checklist)

With the tunnel up and `PUBLIC_URL` set, run through this from your **phone on
mobile data**:

- [ ] Phone page opens at `https://…/p/` (padlock shows — real HTTPS).
- [ ] Upload a normal PDF → options appear.
- [ ] **Colour** (if enabled) and **paper size** (if >1 stocked) show correctly.
- [ ] **Copies**, **page range** (`1-3,5`), and **1st-single-rest-double** all
      change the price live.
- [ ] Pay (mock) → job prints → phone shows **Printed!**.
- [ ] **Dashboard** (`https://…/dashboard/`) needs your password, then shows the
      earnings + job + **Printer online**.
- [ ] **Fail test:** turn the printer off, print again → you're **refunded** or it
      shows **needs attention** → **Reprint** from the dashboard.
- [ ] **Non-PDF / huge / password-protected** file → rejected with a clear message.
- [ ] **Admin** (`https://…/admin/`) → **Suspend** → phone shows "Service paused"
      → **Mark paid** → works again.
- [ ] (When you have JazzCash sandbox creds) a real sandbox payment flips the job
      to **paid** via the callback — needs Option 2's stable URL.

---

## Keeping it running

- **The two pieces must both be running:** the Node server (`npm start`) and the
  tunnel. If you used `cloudflared service install`, the tunnel auto-starts on
  boot; run the server with `pm2` or the Windows startup folder so it does too.
- **Server on boot (Windows):** create a shortcut to a `.bat` containing
  `cd /d C:\path\to\printing && npm start` and drop it in `shell:startup`.
- **Server on boot (Pi/Linux):** run it with `pm2 start npm --name qrprint -- start`
  then `pm2 save && pm2 startup`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Phone can't open the URL | Is `npm start` still running? Is the tunnel terminal still open / service running? |
| QR shows `localhost` | You didn't set `PUBLIC_URL` to the tunnel URL — restart the server with it. |
| Dashboard login won't stick | Make sure `TRUST_PROXY=1` in `.env` (needed behind Cloudflare). |
| "Active" never comes in Step 1 | Double-check the nameservers at Namecheap exactly match Cloudflare's. |
| Random URL keeps changing | That's Option 1 by design — use Option 2 for a stable subdomain. |

That's it — a real, free, HTTPS hybrid deployment you can put in front of a client
today, all from your own computer.
