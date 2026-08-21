// Shop-facing dashboard API. Scoped to the logged-in shop (req.shopId, set by
// requireShopAuth). A shopkeeper only ever sees their own shop.
import express from 'express';
import fs from 'node:fs';
import { db } from '../db.js';
import { effectiveStatus, statusMessage } from '../subscription.js';
import { refund } from '../payments.js';
import { overallStatus } from './phone.js';
import { clampInt } from '../pricing.js';
import { requireShopAuth, verifyPassword, hashPassword } from '../security.js';

export const dashboardRouter = express.Router();
dashboardRouter.use(requireShopAuth);

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso), n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
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
    payment_account: shop.payment_account,
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
    file: { originalName: j.file.originalName, pages: j.file.pages },
    options: j.options,
    amount: j.price.amount,
    currency: j.price.currency,
    payment: j.payment.status,
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
  db.updateJob(job.id, {
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
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters.' });
  }
  const hash = shop.auth?.passwordHash;
  if (hash && !verifyPassword(currentPassword || '', hash)) {
    return res.status(401).json({ error: 'Current password is wrong.' });
  }
  db.updateShop(shop.id, { auth: { passwordHash: hashPassword(String(newPassword)) } });
  db.logEvent('shop.password_changed', { shopId: shop.id });
  res.json({ ok: true });
});

dashboardRouter.get('/settings', (req, res) => {
  const shop = db.shop(req.shopId);
  res.json({
    name: shop.name, slug: shop.slug, mode: shop.mode, unattended: shop.unattended,
    capabilities: shop.capabilities, pricing: shop.pricing, payment_account: shop.payment_account,
  });
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
    const provider = ['cash', 'jazzcash', 'safepay'].includes(pa.provider) ? pa.provider : 'cash';
    const cur = db.shop(req.shopId).payment_account || {};
    const s = (v, fallback, max = 128) => String(v ?? fallback ?? '').trim().slice(0, max);
    patch.payment_account = {
      provider,
      display: provider === 'cash' ? 'Cash at counter'
        : (s(pa.display, '', 80) || (provider === 'jazzcash' ? 'JazzCash' : 'Safepay')),
      jazzcash: {
        merchantId: s(pa.jazzcash?.merchantId, cur.jazzcash?.merchantId, 64),
        password: s(pa.jazzcash?.password, cur.jazzcash?.password),
        integritySalt: s(pa.jazzcash?.integritySalt, cur.jazzcash?.integritySalt),
      },
      safepay: {
        environment: pa.safepay?.environment === 'production' ? 'production' : 'sandbox',
        apiKey: s(pa.safepay?.apiKey, cur.safepay?.apiKey),
        secretKey: s(pa.safepay?.secretKey, cur.safepay?.secretKey),
      },
    };
  }
  if (b.mode === 'shop' || b.mode === 'kiosk') { patch.mode = b.mode; patch.unattended = b.mode === 'kiosk'; }

  const shop = db.updateShop(req.shopId, patch);
  db.logEvent('settings.updated', { shopId: req.shopId, keys: Object.keys(patch) });
  res.json({ ok: true, settings: {
    name: shop.name, slug: shop.slug, mode: shop.mode, unattended: shop.unattended,
    capabilities: shop.capabilities, pricing: shop.pricing, payment_account: shop.payment_account,
  }});
});
