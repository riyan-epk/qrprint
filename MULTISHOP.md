# 🏪 Running many shops (multi-tenant)

QRPrint now hosts **many shops on one server**. Each shop has its own QR link,
dashboard login, prices, printer/agent, and subscription. You (the provider)
create and manage them all from the **Provider Console** at `/admin/`.

## The roles

| Who | Where | Logs in with |
|-----|-------|--------------|
| **You (provider)** | `/admin/` | your **ADMIN_KEY** (from `.env`) |
| **Each shopkeeper** | `/dashboard/` | their **Shop ID + password** |
| **Each customer** | `/p/?s=<shopID>` | nothing — just scans that shop's QR |

## Add a new shop (takes 30 seconds)

1. Open `https://print.mystay.live/admin/` and unlock with your admin key.
2. Under **➕ Add a shop**, enter the shop name, a dashboard password (you choose,
   then give it to the shopkeeper), and the monthly fee. Click **Create**.
3. The console shows four things — **give these to the shopkeeper**:
   - **Shop ID** — they type this + the password to log into the dashboard.
   - **Dashboard link** — `…/dashboard/`
   - **Customer link / QR** — `…/p/?s=<shopID>` (print this for their counter).
   - **Agent key** — goes into their print agent's `config.json`.

## Set up that shop's printer (their agent)

On the **shopkeeper's PC** (next to their printer):
1. Copy the `agent/` folder there (or the whole project).
2. `pip install -r requirements.txt`
3. Create `agent/config.json`:
   ```json
   {
     "server_url": "https://print.mystay.live",
     "agent_key": "<THAT SHOP'S agent key from the console>",
     "print_mode": "live",
     "printer_name": null,
     "sumatra_path": "C:\\Tools\\SumatraPDF.exe"
   }
   ```
4. Run `python agent.py`. That agent now prints **only that shop's** jobs.

> The server can be your one machine (via the Cloudflare tunnel) or a VPS. Every
> shop's agent connects to the **same** server URL but with **its own** key.

## Managing shops (Provider Console)

Each shop card lets you:
- **Suspend** / **Reactivate +30d** — the remote lock, per shop.
- **Set password** — reset a shopkeeper's dashboard password.
- **Details** — reveal the agent key, dashboard link, customer link, QR; **Rotate**
  the agent key if it ever leaks.
- **Delete** — remove a shop.

## What each shopkeeper sees

They log into `/dashboard/` with their Shop ID + password and see **only their
own** jobs, earnings, printer status, and settings (prices, capabilities, payout
account, QR). They can't see other shops or the provider controls.

## Notes

- Your original shop is automatically kept as **Shop ID `main`** (its agent key
  is your `.env` `AGENT_KEY`, so your existing agent keeps working).
- Money still flows per shop: **customer → that shop's payout account**;
  **shop → you** (the monthly fee, enforced by the per-shop lock).
- One server, one tunnel/VPS, unlimited shops.
