// Safepay (getsafepay.com) hosted checkout, PER SHOP. Each shop supplies its own
// Safepay API key + secret, so payments go to that shop.
//
// Flow:
//   1. POST /order/v1/init  { client: apiKey, amount, currency, environment }  -> data.token
//   2. Redirect the customer to the hosted "components" checkout with that token
//   3. Safepay sends the result back to our callback; verify the signature
//      = HMAC-SHA256(tracker, secretKey)
import crypto from 'node:crypto';
import { config } from './config.js';

const API = { sandbox: 'https://sandbox.api.getsafepay.com', production: 'https://api.getsafepay.com' };
const CHECKOUT = { sandbox: 'https://sandbox.api.getsafepay.com/checkout/pay', production: 'https://api.getsafepay.com/checkout/pay' };

// creds = { environment, apiKey, secretKey }
export async function createCheckout(job, shop, creds) {
  const env = creds?.environment === 'production' ? 'production' : 'sandbox';
  if (!creds?.apiKey) return { ok: false, error: 'This shop has not finished its Safepay setup.' };
  if (!config.publicUrl) return { ok: false, error: 'Server PUBLIC_URL is not set (needed for the payment return).' };

  // 1) create a payment token
  let token;
  try {
    const resp = await fetch(API[env] + '/order/v1/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client: creds.apiKey, amount: job.price.amount, currency: 'PKR', environment: env }),
    });
    const data = await resp.json().catch(() => ({}));
    token = data?.data?.token || data?.token;
    if (!resp.ok || !token) {
      return { ok: false, error: 'Safepay could not start the payment: ' + (data?.message || data?.error || resp.status) };
    }
  } catch (e) {
    return { ok: false, error: 'Could not reach Safepay. Check the API key / internet.' };
  }

  // 2) build the hosted-checkout redirect URL
  const base = config.publicUrl.replace(/\/$/, '');
  const url = new URL(CHECKOUT[env]);
  url.searchParams.set('env', env);
  url.searchParams.set('beacon', token);
  url.searchParams.set('source', 'qrprint');
  url.searchParams.set('order_id', job.id);
  url.searchParams.set('redirect_url', base + '/api/phone/pay/safepay/callback');
  url.searchParams.set('cancel_url', base + '/p/?job=' + encodeURIComponent(job.id) + '&pay=failed');

  return { ok: true, redirectUrl: url.toString(), token };
}

// Verify the result Safepay returns. Signature = HMAC-SHA256(tracker, secretKey).
export function verifyCallback(params, secretKey) {
  const tracker = params.tracker || params.Tracker || params.token || '';
  const sig = params.sig || params.signature || params.Signature || '';
  const orderId = params.order_id || params.orderId || params.ppmpf_1 || '';
  if (!tracker || !sig || !secretKey) return { ok: false, orderId, tracker };
  const computed = crypto.createHmac('sha256', secretKey).update(tracker).digest('hex');
  const a = Buffer.from(computed);
  const b = Buffer.from(sig);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok, orderId, tracker };
}
