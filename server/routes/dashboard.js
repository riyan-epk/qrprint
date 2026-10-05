// Shop-facing dashboard API. Scoped to the logged-in shop (req.shopId, set by
// requireShopAuth). A shopkeeper only ever sees their own shop.
import express from 'express';
import fs from 'node:fs';
import { config } from '../config.js';
import { db } from '../db.js';
import { effectiveStatus, statusMessage } from '../subscription.js';
import { refund } from '../payments.js';
import { overallStatus } from './phone.js';
import { clampInt } from '../pricing.js';
import { requireShopAuth, verifyPassword, hashPassword, setShopSession, MIN_PASSWORD } from '../security.js';

export const dashboardRouter = express.Router();
dashboardRouter.use(requireShopAuth);

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso), n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

// Payment settings as the browser sees them: secrets are never sent back, only
// whether one is saved. Leaving a secret field blank on save keeps the old one.
function publicPaymentAccount(pa = {}) {
  return {
    provider: pa.provider || 'cash',
    autoApprove: !!pa.autoApprove,
    display: pa.display || 'Cash at counter',
    jazzcash: {
      merchantId: pa.jazzcash?.merchantId || '',
      hasPassword: !!pa.jazzcash?.password,
      hasIntegritySalt: !!pa.jazzcash?.integritySalt,
    },
    safepay: {
      environment: pa.safepay?.environment === 'production' ? 'production' : 'sandbox',
      apiKey: pa.safepay?.apiKey || '',
      hasSecretKey: !!pa.safepay?.secretKey,
    },
  };
}

function publicSettings(shop) {
  return {
    name: shop.name, slug: shop.slug, mode: shop.mode, unattended: shop.unattended,
    capabilities: shop.capabilities, pricing: shop.pricing,
    payment_account: publicPaymentAccount(shop.payment_account),
    features: { jazzcash: config.jazzcashEnabled, safepay: true },
  };
}

// Guard: the job must belong to the logged-in shop.
function ownJob(req, res) {
  const job = db.job(req.params.id);
  if (!job || job.shopId !== req.shopId) { res.status(404).json({ error: 'Job not found.' }); return null; }
  return job;
}

dashboardRouter.get('/overview', (req, res) => {
  const shop = db.shop(req.shopId);
  const jobs = db.jobs(shop.id);

  const paidToday = jobs.filter(j => j.payment.status === 'paid' && isToday(j.payment.paidAt));
  const earningsToday = paidToday.reduce((s, j) => s + j.price.amount, 0);
  const refundedToday = jobs.filter(j => j.payment.status === 'refunded' && isToday(j.payment.paidAt))
    .reduce((s, j) => s + j.price.amount, 0);

  const counts = { queued: 0, printing: 0, needs_attention: 0, done: 0, failed: 0, refunded: 0, awaiting_payment: 0, awaiting_approval: 0 };
  for (const j of jobs) counts[overallStatus(j)] = (counts[overallStatus(j)] || 0) + 1;

  res.json({
    shop: { name: shop.name, slug: shop.slug, mode: shop.mode, unattended: shop.unattended },
    subscription: { ...effectiveStatus(shop), ...statusMessage(shop), feeMonthly: shop.subscription.feeMonthly },
    payment: { provider: shop.payment_account?.provider || 'cash', display: shop.payment_account?.display || '' },
    printer: shop.runtime?.printer || null,
    lastHeartbeat: shop.runtime?.lastHeartbeat || null,
    earningsToday, refundedToday, printsToday: paidToday.length,
    currency: shop.pricing.currency,
    counts,
  });
});

dashboardRouter.get('/jobs', (req, res) => {
  const limit = clampInt(req.query.limit, 1, 200, 50);
  const jobs = db.jobs(req.shopId).slice(0, limit).map(j => ({
    id: j.id,
    createdAt: j.createdAt,
    kind: j.kind || 'doc',
    file: { originalName: j.file.originalName, pages: j.file.contentPages || j.file.pages, items: j.file.items || null },
    options: j.options,
    amount: j.price.amount,
    currency: j.price.currency,
    payment: j.payment.status,
    payAtCounter: !!j.payment.auto,
    print: j.print.status,
    error: j.print.error,
    status: overallStatus(j),
    fileAvailable: !!j.file.storedPath && fs.existsSync(j.file.storedPath),
  }));
  res.json({ jobs });
});

dashboardRouter.post('/jobs/:id/reprint', (req, res) => {
  const job = ownJob(req, res); if (!job) return;
  if (!['needs_attention', 'failed'].includes(job.print.status)) {
    return res.status(409).json({ error: 'Only stuck or failed jobs can be reprinted.' });
  }
  if (job.payment.status === 'refunded') return res.status(409).json({ error: 'This job was already refunded.' });
  if (!job.file.storedPath || !fs.existsSync(job.file.storedPath)) {
    return res.status(410).json({ error: 'The file is no longer available to reprint.' });
  }
  db.updateJob(job.id, { print: { ...job.print, status: 'queued', error: null } });
  db.logEvent('job.reprint', { shopId: job.shopId, jobId: job.id });
  res.json({ ok: true });
});

// Cash mode: shopkeeper collected the money -> approve -> it prints.
dashboardRouter.post('/jobs/:id/approve', (req, res) => {
  const job = ownJob(req, res); if (!job) return;
  if (job.payment.status !== 'awaiting_approval') {
    return res.status(409).json({ error: 'This job is not awaiting counter payment.' });
  }
  db.updateJob(job.id, {
    payment: { ...job.payment, status: 'paid', provider: job.payment.provider || 'cash', ref: 'CASH-' + job.id, paidAt: new Date().toISOString() },
    print: { ...job.print, status: 'queued' },
  });
  db.logEvent('job.cash_approved', { shopId: job.shopId, jobId: job.id, amount: job.price.amount });
  res.json({ ok: true });
});

// Cash mode: customer didn't pay / changed mind -> cancel and delete.
dashboardRouter.post('/jobs/:id/cancel', (req, res) => {
  const job = ownJob(req, res); if (!job) return;
  if (job.payment.status !== 'awaiting_approval') {
    return res.status(409).json({ error: 'Only counter-payment jobs can be cancelled.' });
  }
  try { fs.unlinkSync(job.file.storedPath); } catch {}
  db.removeJob(job.id);
  db.logEvent('job.cash_cancelled', { shopId: job.shopId, jobId: job.id });
  res.json({ ok: true });
});

dashboardRouter.post('/jobs/:id/refund', async (req, res) => {
  const job = ownJob(req, res); if (!job) return;
  if (job.payment.status !== 'paid') return res.status(409).json({ error: 'Only a paid job can be refunded.' });
  const r = await refund(job);
  // Refunded jobs can't be reprinted, so the file isn't needed any more.
  try { if (job.file.storedPath) fs.unlinkSync(job.file.storedPath); } catch {}
  db.updateJob(job.id, {
    file: { ...job.file, storedPath: null },
    payment: { ...job.payment, status: 'refunded', refundRef: r.ref, refundedAt: r.at },
    print: { ...job.print, status: 'failed', error: 'refunded_by_shop' },
  });
  db.logEvent('job.refunded', { shopId: job.shopId, jobId: job.id, by: 'shop', manual: !!r.manual });
  res.json({ ok: true, manual: !!r.manual });
});

// Shopkeeper changes their own password.
dashboardRouter.post('/change-password', (req, res) => {
  const shop = db.shop(req.shopId);
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < MIN_PASSWORD) {
    return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD} characters.` });
  }
  const hash = shop.auth?.passwordHash;
  if (hash && !verifyPassword(currentPassword || '', hash)) {
    return res.status(401).json({ error: 'Current password is wrong.' });
  }
  const updated = db.updateShop(shop.id, { auth: { passwordHash: hashPassword(String(newPassword)) } });
  // Other devices are signed out by the new password; keep this one signed in.
  setShopSession(res, updated);
  db.logEvent('shop.password_changed', { shopId: shop.id });
  res.json({ ok: true });
});

dashboardRouter.get('/settings', (req, res) => {
  res.json(publicSettings(db.shop(req.shopId)));
});

dashboardRouter.post('/settings', (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim().slice(0, 60);

  if (b.capabilities) {
    const sizes = Array.isArray(b.capabilities.paperSizes)
      ? b.capabilities.paperSizes.filter(s => ['A4', 'Letter', 'Legal'].includes(s)) : [];
    patch.capabilities = {
      color: !!b.capabilities.color,
      duplex: !!b.capabilities.duplex,
      paperSizes: sizes.length ? sizes : ['A4'],
      maxFileMb: clampInt(b.capabilities.maxFileMb, 1, 100, 25),
    };
  }
  if (b.pricing) {
    patch.pricing = {
      currency: 'PKR',
      bwPerPage: Math.max(0, Number(b.pricing.bwPerPage) || 0),
      colorPerPage: Math.max(0, Number(b.pricing.colorPerPage) || 0),
    };
  }
  if (b.payment_account) {
    const pa = b.payment_account;
    const cur = db.shop(req.shopId).payment_account || {};
    const provider = ['cash', 'jazzcash', 'safepay'].includes(pa.provider) ? pa.provider : 'cash';
    if (provider === 'jazzcash' && !config.jazzcashEnabled && cur.provider !== 'jazzcash') {
      return res.status(400).json({ error: 'JazzCash online payments are coming soon. Please use Safepay or Cash for now.' });
    }
    const s = (v, max = 128) => String(v ?? '').trim().slice(0, max);
    // Secrets: blank means "keep what's saved".
    const secret = (v, saved) => s(v) || saved || '';
    patch.payment_account = {
      provider,
      // Cash only: print without waiting for the shopkeeper to tap Approve.
      autoApprove: !!pa.autoApprove,
      display: provider === 'cash' ? 'Cash at counter'
        : (s(pa.display, 80) || (provider === 'jazzcash' ? 'JazzCash' : 'Safepay')),
      jazzcash: {
        merchantId: s(pa.jazzcash?.merchantId ?? cur.jazzcash?.merchantId, 64),
        password: secret(pa.jazzcash?.password, cur.jazzcash?.password),
        integritySalt: secret(pa.jazzcash?.integritySalt, cur.jazzcash?.integritySalt),
      },
      safepay: {
        environment: pa.safepay?.environment === 'production' ? 'production' : 'sandbox',
        apiKey: s(pa.safepay?.apiKey ?? cur.safepay?.apiKey),
        secretKey: secret(pa.safepay?.secretKey, cur.safepay?.secretKey),
      },
    };
    if (provider === 'safepay' && !patch.payment_account.safepay.apiKey) {
      return res.status(400).json({ error: 'Enter your Safepay API key to accept online payments.' });
    }
  }
  if (b.mode === 'shop' || b.mode === 'kiosk') { patch.mode = b.mode; patch.unattended = b.mode === 'kiosk'; }

  const shop = db.updateShop(req.shopId, patch);
  db.logEvent('settings.updated', { shopId: req.shopId, keys: Object.keys(patch) });
  res.json({ ok: true, settings: publicSettings(shop) });
});
