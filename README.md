# 🖨️ QRPrint — Self-Service QR Printing (V1)

Scan a QR → upload a PDF → pay → it prints. Sold to print shops as software,
built to become your own unattended kiosk later (same code, one config switch).

**V1 runs entirely on one computer with no cloud account and no cost.** Perfect
for a first pilot in a real shop.

> **Deploying for a real client?** See **[DEPLOY.md](DEPLOY.md)** (local + hybrid
> cloud, step by step) and **[GO-LIVE.md](GO-LIVE.md)** (pre-client checklist).
> Quick production setup: `npm install && node scripts/setup.mjs --password "..." && npm start`.
>
> **No VPS, no cost?** **[TUNNEL.md](TUNNEL.md)** shows how to give customers a real
> HTTPS link (`https://print.yourdomain.com`) served from your own laptop, free, via
> Cloudflare Tunnel — the cheapest way to demo the hybrid setup to a client.
>
> **Want it always-on for free (PC can be off)?** **[ORACLE.md](ORACLE.md)** — run it
> on a free Oracle Cloud Linux server 24/7, reusing your Cloudflare tunnel.
>
> **Many shops?** The system is **multi-tenant** — one server hosts unlimited shops,
> each with its own QR, dashboard login, prices, agent, and subscription. Create and
> manage them in the Provider Console at `/admin/`. See **[MULTISHOP.md](MULTISHOP.md)**.

---

## What's inside

```
printing/
├── server/            Node.js server + web UIs (phone, dashboard, admin)
│   ├── index.js       entry point
│   ├── config.js      all settings (env-overridable)
│   ├── db.js          local JSON data store (swap for Postgres later)
│   ├── pricing.js     price + page-range logic
│   ├── subscription.js the remote lock (active / grace / suspended)
│   ├── payments.js    mock + JazzCash stub (pluggable)
│   ├── routes/        phone, agent, dashboard, admin APIs
│   └── public/        phone / dashboard / admin web pages
└── agent/             Python print agent (runs next to the printer)
    ├── agent.py       polls for paid jobs, prints, reports back
    ├── pdftools.py    page-range extract + mixed single/double split
    └── printer.py     Windows (SumatraPDF) / Linux (CUPS) / dry-run
```

---

## Quick start (test on one laptop, no printer needed)

### 1. Start the server

```bash
npm install
npm start
```

The console prints the URLs and the **agent key** / **admin key**. Open:

- **Phone page** (the QR target): `http://localhost:3000/p/`
- **Shop dashboard:** `http://localhost:3000/dashboard/`
- **Provider admin:** `http://localhost:3000/admin/`

Payments default to `mock` (always succeeds), so you can run the whole flow now.

### 2. Start the print agent (in another terminal)

```bash
cd agent
pip install -r requirements.txt
cp config.example.json config.json     # Windows: copy config.example.json config.json
python agent.py
```

It starts in **dry-run** mode — it *logs* what it would print instead of using a
real printer, so you can test everything safely.

### 3. Try it

1. Open the phone page, upload any PDF, pick options, tap **Pay & Print**.
2. Watch the agent terminal print a `[dry-run]` line.
3. The phone shows **Printed!**; the dashboard shows the earnings and job.

---

## Turn on real printing

Edit `agent/config.json`:

- Set `"print_mode": "live"`.
- **Windows:** download portable **SumatraPDF**, set `"sumatra_path"` to its full
  path. Leave `"printer_name": null` to use the default printer.
- **Linux / Raspberry Pi:** make sure CUPS is set up (`lp` works), optionally set
  `"printer_name"` to your CUPS queue.

## Turn on real payments

Set `PAYMENT_PROVIDER=jazzcash` and implement the two TODOs in
`server/payments.js` with your (or the shop's) JazzCash credentials. Until then,
keep `mock` for testing. The shop connects its payout account under
**Dashboard → Settings → Your payout account**.

---

## The remote lock (subscription)

Open **/admin/**, enter the admin key from the server console:

- **Suspend** — the shop's phone page shows "Service paused"; no new jobs. Their
  files and settings are untouched.
- **Mark paid · +30 days** — unlocks instantly.
- A **grace period** (default 3 days) keeps a slightly-late shop working with a
  warning before it locks. Change with `GRACE_DAYS`.

Two money flows: **per-print money → the shop's account**; **monthly
subscription → you** (enforced by this lock).

---

## Configuration (environment variables)

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `3000` | Server port |
| `AGENT_KEY` | `dev-agent-key` | Must match the agent's config |
| `ADMIN_KEY` | `dev-admin-key` | Unlocks the admin page |
| `PAYMENT_PROVIDER` | `mock` | `mock` or `jazzcash` |
| `MAX_UPLOAD_MB` | `25` | Upload size limit |
| `GRACE_DAYS` | `3` | Subscription grace period |
| `PUBLIC_URL` | (LAN IP) | Public base URL for the QR (for cloud/hybrid later) |

---

## Supported upload formats

- **PDF** — printed directly.
- **Images** (JPG/PNG) — auto-converted to an A4 PDF.
- **Office** (Word/Excel/PowerPoint, `.odt/.rtf/.txt`) — converted via **LibreOffice**.
  Install it once on the server PC:
  `winget install -e --id TheDocumentFoundation.LibreOffice` (Windows) or your
  package manager (`libreoffice`) on Linux. Without it, Office uploads return a
  clear message; PDF and images still work.

## Edge cases already handled

- Non-PDF / oversized / corrupt / **password-protected** PDFs → clear rejection.
- **Paid but didn't print** → auto-refund (kiosk / unrecoverable) or
  "needs attention" for the shopkeeper to reprint or refund.
- Paper-out / jam → job paused, shown on the dashboard, reprintable.
- Options the printer can't do (color / duplex) → hidden from the customer.
- Abandoned uploads and unpaid jobs → auto-deleted after 30 min.
- Files deleted right after successful printing (privacy).

## Production hardening (built in)

- **Auth:** shop dashboard login (scrypt-hashed password, signed session cookie);
  provider admin gated by key or cookie.
- **Refuses insecure boot:** in `NODE_ENV=production` the server won't start with
  default keys / missing secrets.
- **Security headers** (Helmet + CSP, no inline JS), **rate limiting** on upload /
  pay / login, upload size caps, JSON body caps.
- **Automatic HTTPS** via Caddy (`docker compose up -d`), reverse-proxy aware.
- **Graceful shutdown**, access/error logs, container healthcheck.
- **Real payments** scaffolding: JazzCash hosted-checkout + callback verification
  (`server/jazzcash.js`) — mock stays the tested default until you add credentials.
- **Agent as a service:** systemd unit (Pi/Linux) + auto-restart `.bat` (Windows),
  with reconnect backoff.

## Roadmap (from the plan)

- **V1 (this):** PDF, A4, B&W+color, copies, range, single/double/mixed, refund.
- **V2:** Word/image → PDF, Easypaisa, low paper/toner alerts, cloud/hybrid mode.
- **V3:** kiosk mode (`mode: kiosk`), remote monitoring, auto-recovery.
