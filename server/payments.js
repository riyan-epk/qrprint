// Per-shop payments. Each shop chooses its method and supplies its own
// credentials, so money goes to that shop. createPayment inspects the shop's
// payment_account and returns how the phone should proceed.
import { buildCheckout } from './jazzcash.js';
import { createCheckout } from './safepay.js';

// Returns one of:
//   { ok:true, mode:'cash' }                                   -> pay at the counter; shopkeeper approves
//   { ok:true, redirect:true, provider, action, fields, txnRef } -> hosted checkout (JazzCash)
//   { ok:false, error }
export async function createPayment(job, shop) {
  const acct = shop.payment_account || {};
  const method = acct.provider || 'cash';

  if (method === 'cash') {
    return { ok: true, mode: 'cash' };
  }

  if (method === 'jazzcash') {
    const co = buildCheckout(job, shop, acct.jazzcash);
    if (!co.ok) return co;
    return { ok: true, redirect: true, provider: 'jazzcash', action: co.action, fields: co.fields, txnRef: co.txnRef };
  }

  if (method === 'safepay') {
    const co = await createCheckout(job, shop, acct.safepay);
    if (!co.ok) return co;
    return { ok: true, provider: 'safepay', redirectUrl: co.redirectUrl, token: co.token };
  }

  return { ok: false, error: 'No payment method configured for this shop.' };
}

// Refunds. For online providers this would call their refund API; for cash the
// shopkeeper hands the money back. Always leaves a record — never silent loss.
export async function refund(job) {
  const provider = job.payment?.provider || 'cash';
  if (provider === 'mock') {
    return { ok: true, ref: 'REFUND-' + job.id, at: new Date().toISOString() };
  }
  // Cash + (for now) JazzCash: mark refunded; the actual money-back is manual.
  return { ok: true, ref: 'REFUND-' + job.id, at: new Date().toISOString(), manual: true };
}
