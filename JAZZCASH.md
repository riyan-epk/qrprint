# JazzCash — what's left before it can go live

JazzCash is shown as **"Coming soon"** everywhere (dashboard, homepage). Shops
can't switch to it until you set `JAZZCASH_ENABLED=1` in `.env`. Safepay and
Cash are the working payment methods today.

The code in `server/jazzcash.js` builds a hosted-checkout form and verifies the
callback, but it has never been run against a real JazzCash account. Before you
turn it on:

## 1. Things you need from JazzCash

- [ ] A **JazzCash Business / merchant account** for each shop that wants it
      (payments go straight to the shop, like Safepay).
- [ ] **Sandbox credentials** first: Merchant ID, Password, Integrity Salt
      (from the JazzCash sandbox merchant portal).
- [ ] Register your **Return URL** with JazzCash:
      `https://print.mystay.live/api/phone/pay/jazzcash/callback`
- [ ] Sandbox **test wallet numbers / test cards** from the JazzCash docs.
- [ ] After sandbox testing passes, JazzCash's **go-live approval** and the
      live credentials.

## 2. Code changes still needed

- [ ] **Checkout URL.** `buildCheckout` always posts to the *sandbox* URL, and
      it's the REST API endpoint (`.../ApplicationAPI/API/2.0/Purchase/DoTransaction`),
      not the customer-facing hosted page. JazzCash's "Page Redirection" checkout
      posts to `.../CustomerPortal/transactionmanagement/merchantform/` (sandbox
      and live hosts differ). Confirm the exact URL and `pp_Version` against the
      current JazzCash integration guide.
- [ ] **Sandbox / live switch per shop**, like Safepay has (an `environment`
      field in the shop's `payment_account.jazzcash`, and a select in the
      dashboard's JazzCash fields).
- [ ] **Transaction type.** `pp_TxnType` is hard-coded to `MPAY` (card). Decide
      what to offer — `MWALLET` for JazzCash mobile accounts is what most
      customers in Pakistan will expect — or leave it blank so the customer picks
      on JazzCash's page, if your account allows that.
- [ ] **Verify the hash** (`secureHash`) with a real sandbox transaction: field
      order, which empty fields are skipped, and upper/lower case.
- [ ] **Status inquiry.** If the customer closes the page after paying, the
      callback may never arrive. Add a background check with JazzCash's
      *Payment Inquiry* API (the same idea as `sweepSafepay` in `routes/phone.js`).
- [ ] **Response codes.** Only `000` is treated as paid. Map the others
      (e.g. pending/voucher codes such as `124`) to clear messages for the customer.
- [ ] **Refunds.** Refunds are currently manual (the shop returns the money).
      Optionally call JazzCash's refund API instead.

Already done: the CSP allows the JazzCash form to be submitted, and the callback
now checks that the signed result is for **this job's** transaction reference
and full amount (so a receipt from one payment can't be replayed against another
job).

## 3. Test checklist (sandbox)

- [ ] Successful payment → job flips to **paid**, prints, shows on the dashboard.
- [ ] Customer cancels on the JazzCash page → phone shows "Payment cancelled"
      with **Try payment again**.
- [ ] Wrong / tampered callback → job stays unpaid; event `job.pay_failed`.
- [ ] Customer closes the tab after paying → the status inquiry still marks it paid.
- [ ] Then repeat with live credentials and a small real payment.

When all of the above pass, set `JAZZCASH_ENABLED=1` and restart the server.
