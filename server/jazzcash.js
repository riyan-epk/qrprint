// JazzCash "Page" (hosted checkout), PER SHOP. Each shop supplies its own
// merchant credentials (Merchant ID, Password, Integrity Salt), so payments go
// to that shop's own JazzCash merchant account.
//
// ⚠️ The hashing/field set follows the standard JazzCash spec but MUST be
// verified against a live sandbox before going live.
import crypto from 'node:crypto';
import { config } from './config.js';

const SANDBOX_URL = 'https://sandbox.jazzcash.com.pk/ApplicationAPI/API/2.0/Purchase/DoTransaction';

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// HMAC-SHA256 keyed by the integrity salt over salt + every non-empty pp_/ppmpf_
// value, sorted by field name, joined with '&'.
export function secureHash(fields, integritySalt) {
  const keys = Object.keys(fields)
    .filter(k => k.startsWith('pp_') || k.startsWith('ppmpf_'))
    .filter(k => fields[k] !== '' && fields[k] != null)
    .sort();
  const message = integritySalt + '&' + keys.map(k => fields[k]).join('&');
  return crypto.createHmac('sha256', integritySalt).update(message).digest('hex').toUpperCase();
}

// creds = { merchantId, password, integritySalt }
export function buildCheckout(job, shop, creds, now = new Date()) {
  if (!creds?.merchantId || !creds?.password || !creds?.integritySalt) {
    return { ok: false, error: 'This shop has not finished its JazzCash setup.' };
  }
  const txnRef = 'T' + now.getTime() + Math.floor(Math.random() * 1000);
  const expiry = new Date(now.getTime() + 60 * 60 * 1000);

  const fields = {
    pp_Version: '2.0',
    pp_TxnType: 'MPAY',
    pp_Language: 'EN',
    pp_MerchantID: creds.merchantId,
    pp_SubMerchantID: '',
    pp_Password: creds.password,
    pp_BankID: '',
    pp_ProductID: '',
    pp_TxnRefNo: txnRef,
    pp_Amount: String(Math.round(job.price.amount * 100)), // paisa
    pp_TxnCurrency: 'PKR',
    pp_TxnDateTime: stamp(now),
    pp_BillReference: job.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20),
    pp_Description: `Print ${job.price.totalPagesPrinted} pages`,
    pp_TxnExpiryDateTime: stamp(expiry),
    pp_ReturnURL: config.publicUrl.replace(/\/$/, '') + '/api/phone/pay/jazzcash/callback',
    ppmpf_1: job.id,
  };
  fields.pp_SecureHash = secureHash(fields, creds.integritySalt);

  return { ok: true, action: SANDBOX_URL, fields, txnRef };
}

// Validate the callback using the shop's integrity salt.
export function verifyCallback(body, integritySalt) {
  const received = body.pp_SecureHash;
  const expected = integritySalt ? secureHash(body, integritySalt) : '';
  const valid = received && expected && received.toUpperCase() === expected;
  return {
    ok: valid,
    success: valid && body.pp_ResponseCode === '000',
    txnRef: body.pp_TxnRefNo,
    jobId: body.ppmpf_1,
    responseCode: body.pp_ResponseCode,
    message: body.pp_ResponseMessage,
  };
}
