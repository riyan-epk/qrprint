# ✅ GO-LIVE Checklist (before testing with a client)

Work top to bottom. Don't skip the payment/refund rows — those are what make or
break trust with a real shopkeeper.

## Security
- [ ] Ran `node scripts/setup.mjs --password "..."` — real random `AGENT_KEY`, `ADMIN_KEY`, `SESSION_SECRET` in `.env`.
- [ ] `NODE_ENV=production` (server refuses to boot with dev keys — that's intended).
- [ ] Dashboard requires login (open `/dashboard/`, confirm the password screen).
- [ ] Admin page needs the admin key (open `/admin/`).
- [ ] Hybrid mode: site loads over **https://** with a valid padlock (Caddy).

## The shop is configured
- [ ] Shop name, prices (B&W / color) set in **Dashboard → Settings**.
- [ ] Printer capabilities correct: color **only** if the printer does color; duplex **only** if it has a duplex unit.
- [ ] Payout account entered (for real payments).
- [ ] QR printed and placed on the counter.

## The printer works
- [ ] Agent running as a service (survives a reboot).
- [ ] `print_mode: live`, correct `printer_name`/`sumatra_path`.
- [ ] Dashboard shows **Printer online** (heartbeat).
- [ ] Test print: single-sided, double-sided, and "1st page single, rest double".
- [ ] Color test (if the shop offers color).

## Payments & refunds (most important)
- [ ] Real payment (JazzCash sandbox → then live) completes and the job flips to **paid**.
- [ ] Money lands in the **shop's** account.
- [ ] Force a failure (turn the printer off): confirm the customer is **refunded** or the job shows **needs attention** and can be reprinted.
- [ ] Paper-out mid-job: confirm it pauses and is reprintable from the dashboard.

## Edge cases (quick sanity)
- [ ] Non-PDF, oversized, and password-protected files are rejected clearly.
- [ ] Suspend the shop from `/admin/`: phone shows "Service paused". Reactivate: works again.

## Operations
- [ ] Know who refills paper/toner and who to call if it breaks.
- [ ] `db.json` backup plan in place.
- [ ] Grace period (`GRACE_DAYS`) set to something fair before a shop is locked.

When every box is ticked, you're ready to run a real customer through it.
