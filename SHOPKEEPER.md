# 🖨️ Shopkeeper Setup (give this to each shop)

Your provider created your shop and gave you:
- **Shop ID** and **password** — to log into your dashboard.
- An **Agent key** — a long code the printer program needs.
- Your **customer QR link** — `https://print.mystay.live/p/?s=<your-shop-id>`.

You only need to set up the small **print agent** on the PC connected to your
printer. About 5 minutes.

---

## Step 1 — Get the agent folder
Your provider will send you a folder called **`agent`** (by USB or WhatsApp/email).
Put it somewhere easy, e.g. `C:\qrprint-agent`.

## Step 2 — Run the setup (installs everything)
Open the `agent` folder and **double-click `setup-agent.bat`**.

It automatically installs:
- **Python** (if missing — if it installs Python, just run `setup-agent.bat` again),
- **SumatraPDF** (used to print),
- the small Python packages the agent needs.

If Windows asks for permission during the winget installs, click **Yes**.

## Step 3 — Paste your agent key
In the `agent` folder, right-click **`config.json` → Edit**. Set your agent key:
```json
{
  "server_url": "https://print.mystay.live",
  "agent_key": "PASTE-YOUR-AGENT-KEY-HERE",
  "print_mode": "live"
}
```
Save the file.

## Step 4 — Start printing
Double-click **`run-agent.bat`**. A window opens and says *"Waiting for paid
jobs."* Leave it open — that's the printer program running.

> Tip: put a shortcut to `run-agent.bat` in your Startup folder
> (press `Win+R`, type `shell:startup`, drag a shortcut there) so it starts
> automatically whenever the PC turns on.

## Step 5 — Test a real print
1. Make sure your printer is on and set as the **default printer** in Windows.
2. On a phone, scan your **QR** (or open your customer link).
3. Upload a PDF, choose options, and pay.
4. A real page should come out of your printer, and it appears in your dashboard.

---

## Your dashboard
Open **`https://print.mystay.live/dashboard/`**, log in with your **Shop ID +
password**. There you can:
- watch jobs and today's earnings,
- set your **prices** and what your printer can do (colour / double-sided),
- connect your **payout account**,
- **change your password** (Settings → Change password),
- print your **QR** (QR code tab).

## If a print fails
- **Paper out / jam:** fix it, then click **Reprint** on that job in your dashboard.
- A job that truly can't print **refunds the customer automatically** — you never
  keep money for a page that didn't come out.

## Troubleshooting
| Problem | Fix |
|---|---|
| Agent window closes instantly | Run `setup-agent.bat` again; make sure Python installed. |
| "Bad agent key" | Re-check `agent_key` in `config.json` matches what your provider gave you. |
| Nothing prints | Is `run-agent.bat` running? Is the printer on and set as default? |
| Wrong printer | Put the exact printer name in `"printer_name"` in `config.json`. |
