# 🖨️ Shopkeeper Setup (give this to each shop)

Your provider created your shop and gave you:
- **Shop ID** and **password** — to log into your dashboard.
- An **Agent key** — a long code the printer program needs.
- Your **customer QR link** — `https://print.mystay.live/p/?s=<your-shop-id>`.

You only need to set up the small **print agent** on the PC connected to your
printer. About 2 minutes, nothing to install.

---

## Step 1 — Get the agent folder
Your provider sends you **`qrprint-agent-windows.zip`**. Right-click it →
**Extract All**, and put the **`QRPrint-Agent`** folder somewhere permanent,
e.g. `C:\QRPrint` (not Downloads, not a USB stick). It contains
`qrprint-agent.exe`, `SumatraPDF.exe` and `README-FIRST.txt`.

## Step 2 — Make your printer the default
Turn the printer on. In Windows: **Settings → Bluetooth & devices → Printers &
scanners →** your printer **→ Set as default**.

## Step 3 — Run the agent and paste your key
Double-click **`qrprint-agent.exe`**. (If Windows says *"Windows protected your
PC"*, click **More info → Run anyway**.) Paste your **agent key** and press
Enter — it checks the key and shows your shop's name. When it asks
*"Start automatically when this PC turns on?"*, press Enter for **Yes**.

## Step 4 — Leave it running
The window says *"Waiting for paid jobs."* That's your printer live. Minimise
it, but don't close it. To print a test page, run `qrprint-agent.exe --test`.

> Your agent key works on **one** computer. If you move the agent to a new PC,
> ask your provider to **Unlink PC** first.
>
> On Linux / Raspberry Pi, or to run from source, see the `agent/` folder
> (`setup-agent.bat` / `python agent.py`).

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
- choose how customers pay. With **Cash at counter**, tick **Auto-approve** if you
  don't want to tap *Approve* for every job: jobs print straight away and show
  **cash due** — collect the money when the customer picks up,
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
