// Student-facing API: what the phone hits after scanning a shop's QR.
// The shop is identified by its slug, passed as ?shop=<slug> (from the QR URL
// ?s=<slug>) or in the job body. Flow:
//   GET /config -> POST /upload -> POST /jobs -> POST /jobs/:id/pay -> poll GET /jobs/:id
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { config } from '../config.js';
import { db, makeId } from '../db.js';
import { computePrice, clampInt } from '../pricing.js';
import { canAcceptJobs, statusMessage } from '../subscription.js';
import { createPayment } from '../payments.js';
import { verifyCallback } from '../jazzcash.js';
import { verifyCallback as verifySafepay, checkTrackerPaid } from '../safepay.js';
import { isOfficeFile, officeToPdf } from '../office.js';
import { uploadLimiter, payLimiter } from '../security.js';

export const phoneRouter = express.Router();
phoneRouter.use(express.json());

fs.mkdirSync(config.uploadsDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, config.uploadsDir),
    filename: (_req, file, cb) => {
      let ext = path.extname(file.originalname || '').toLowerCase();
      if (!/^\.[a-z0-9]{1,8}$/.test(ext)) ext = '.bin';
      cb(null, makeId('file') + ext);
    },
  }),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
});

const pending = new Map(); // fileId -> { path, pages, sizeBytes, createdAt }

// Which shop is this request for? Slug from query/body/header; falls back to the
// first shop so a legacy single-shop QR still works.
function resolveShop(req) {
  const slug = req.query.shop || req.body?.shop || req.get('x-shop');
  if (slug) return db.shopBySlug(String(slug));
  return db.firstShop();
}

// --- shop info the phone UI needs -------------------------------------------
phoneRouter.get('/config', (req, res) => {
  const shop = resolveShop(req);
  if (!shop) return res.status(404).json({ error: 'Shop not found.' });
  const sub = statusMessage(shop);
  res.json({
    shopSlug: shop.slug,
    shopName: shop.name,
    capabilities: shop.capabilities,
    pricing: shop.pricing,
    accepting: sub.status !== 'suspended',
    subscription: { status: sub.status, message: sub.message },
    maxUploadMb: shop.capabilities.maxFileMb,
    paymentMode: shop.payment_account?.provider || 'cash',
  });
});

// --- upload + validate the document -----------------------------------------
phoneRouter.post('/upload', uploadLimiter, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File too large. Max ${config.maxUploadMb} MB.` });
      }
      return res.status(400).json({ error: 'Upload failed. Please try again.' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file received.' });

    const uploaded = req.file.path;                     // uploads/file_xxx.ext
    const ext = path.extname(uploaded).toLowerCase();
    const mime = req.file.mimetype || '';
    const base = path.basename(uploaded, ext);          // file_xxx
    const finalPdf = path.join(config.uploadsDir, base + '.pdf');

    const isPdf = ext === '.pdf' || mime === 'application/pdf';
    const isImg = ['.jpg', '.jpeg', '.png'].includes(ext) || mime === 'image/jpeg' || mime === 'image/png';
    const isOffice = isOfficeFile(ext);

    if (!isPdf && !isImg && !isOffice) {
      safeUnlink(uploaded);
      return res.status(415).json({ error: 'Please upload a PDF, image (JPG/PNG), or Word/Excel/PowerPoint file.' });
    }

    let pages;
    try {
      if (isPdf) {
        const doc = await PDFDocument.load(fs.readFileSync(uploaded), { ignoreEncryption: false });
        pages = doc.getPageCount();
        if (uploaded !== finalPdf) { fs.renameSync(uploaded, finalPdf); }
      } else if (isImg) {
        const pdfBytes = await imageToPdf(fs.readFileSync(uploaded), ext === '.png' || mime === 'image/png');
        fs.writeFileSync(finalPdf, pdfBytes);
        if (uploaded !== finalPdf) safeUnlink(uploaded);
        pages = 1;
      } else {
        // Office document -> LibreOffice converts it to finalPdf (base + .pdf).
        await officeToPdf(uploaded, config.uploadsDir);
        safeUnlink(uploaded);
        const doc = await PDFDocument.load(fs.readFileSync(finalPdf), { ignoreEncryption: true });
        pages = doc.getPageCount();
      }
    } catch (e) {
      safeUnlink(uploaded); safeUnlink(finalPdf);
      if (e.code === 'NO_LIBREOFFICE') {
        return res.status(503).json({ error: 'Word/Office files are not set up on this shop yet. Please upload a PDF or image.' });
      }
      if (isPdf && String(e.message || '').toLowerCase().includes('encrypt')) {
        return res.status(422).json({ error: 'This PDF is password-protected. Please remove the password and try again.' });
      }
      return res.status(422).json({ error: 'Could not read this file. Please try a different one.' });
    }

    if (!pages || pages < 1) {
      safeUnlink(finalPdf);
      return res.status(422).json({ error: 'This file has no pages.' });
    }

    pending.set(base, {
      path: finalPdf, pages, sizeBytes: req.file.size,
      originalName: req.file.originalname, createdAt: Date.now(),
    });
    res.json({ fileId: base, pages, sizeMb: +(req.file.size / 1048576).toFixed(2) });
  });
});

// --- create the job ----------------------------------------------------------
phoneRouter.post('/jobs', (req, res) => {
  const shop = resolveShop(req);
  if (!shop) return res.status(404).json({ error: 'Shop not found.' });

  if (!canAcceptJobs(shop)) {
    return res.status(403).json({ error: statusMessage(shop).message, code: 'suspended' });
  }

  const { fileId, options = {} } = req.body || {};
  const up = pending.get(fileId);
  if (!up) return res.status(410).json({ error: 'Upload expired. Please select the file again.' });

  const opts = normaliseOptions(options, shop);
  const price = computePrice(shop, up.pages, opts);

  const job = {
    id: makeId('job'),
    shopId: shop.id,
    createdAt: new Date().toISOString(),
    file: { storedPath: up.path, originalName: up.originalName, pages: up.pages, sizeBytes: up.sizeBytes },
    options: opts,
    price,
    payment: { status: 'unpaid', provider: null, ref: null, paidAt: null },
    print: { status: 'awaiting_payment', attempts: 0, error: null, printedAt: null },
  };

  pending.delete(fileId);
  db.addJob(job);
  db.logEvent('job.created', { shopId: shop.id, jobId: job.id, amount: price.amount, pages: up.pages });
  res.json(publicJob(job));
});

// --- pay ---------------------------------------------------------------------
phoneRouter.post('/jobs/:id/pay', payLimiter, async (req, res) => {
  const job = db.job(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.payment.status === 'paid') return res.json(publicJob(job));

  const shop = db.shop(job.shopId);
  if (!shop) return res.status(404).json({ error: 'Shop not found.' });
  if (!canAcceptJobs(shop)) {
    return res.status(403).json({ error: statusMessage(shop).message, code: 'suspended' });
  }

  let result;
  try {
    result = await createPayment(job, shop);
  } catch (e) {
    return res.status(502).json({ error: 'Payment service error. Please try again.' });
  }
  if (!result.ok) return res.status(402).json({ error: result.error || 'Payment failed.' });

  // Cash at counter: wait for the shopkeeper to collect payment and approve.
  if (result.mode === 'cash') {
    db.updateJob(job.id, { payment: { ...job.payment, status: 'awaiting_approval', provider: 'cash' } });
    db.logEvent('job.awaiting_cash', { shopId: job.shopId, jobId: job.id, amount: job.price.amount });
    return res.json(publicJob(db.job(job.id)));
  }

  // Hosted checkout (JazzCash) using the shop's own credentials — form POST.
  if (result.redirect) {
    db.updateJob(job.id, { payment: { ...job.payment, provider: result.provider, txnRef: result.txnRef } });
    return res.json({ redirect: true, action: result.action, fields: result.fields });
  }

  // Hosted checkout (Safepay) — simple URL redirect.
  if (result.redirectUrl) {
    db.updateJob(job.id, { payment: { ...job.payment, provider: result.provider, token: result.token } });
    return res.json({ redirectUrl: result.redirectUrl });
  }

  // Instant provider (not used by cash/jazzcash).
  db.updateJob(job.id, {
    payment: { status: 'paid', provider: result.provider, ref: result.ref, paidAt: result.paidAt },
    print: { ...job.print, status: 'queued' },
  });
  db.logEvent('job.paid', { shopId: job.shopId, jobId: job.id, provider: result.provider, amount: job.price.amount });
  res.json(publicJob(db.job(job.id)));
});

// JazzCash callback.
phoneRouter.post('/pay/jazzcash/callback', express.urlencoded({ extended: false }), (req, res) => {
  const jobId = req.body?.ppmpf_1;
  const job = jobId ? db.job(jobId) : null;
  const shop = job ? db.shop(job.shopId) : null;
  const salt = shop?.payment_account?.jazzcash?.integritySalt;
  const v = verifyCallback(req.body || {}, salt);
  if (job && v.ok && v.success && job.payment.status !== 'paid') {
    db.updateJob(job.id, {
      payment: { ...job.payment, status: 'paid', provider: 'jazzcash', ref: v.txnRef, paidAt: new Date().toISOString() },
      print: { ...job.print, status: 'queued' },
    });
    db.logEvent('job.paid', { shopId: job.shopId, jobId: job.id, provider: 'jazzcash', amount: job.price.amount });
  } else if (job && (!v.ok || !v.success)) {
    db.logEvent('job.pay_failed', { shopId: job.shopId, jobId: job.id, code: v.responseCode });
  }
  const status = v.ok && v.success ? 'paid' : 'failed';
  const s = shop?.slug ? `&s=${encodeURIComponent(shop.slug)}` : '';
  res.redirect(`/p/?job=${encodeURIComponent(jobId || '')}&pay=${status}${s}`);
});

// Safepay sends the result here (GET or POST). Verify the signature, mark paid.
phoneRouter.all('/pay/safepay/callback', express.urlencoded({ extended: false }), (req, res) => {
  const params = { ...req.query, ...(req.body || {}) };
  const orderId = params.order_id || params.orderId || '';
  const job = orderId ? db.job(orderId) : null;
  const shop = job ? db.shop(job.shopId) : null;
  const secret = shop?.payment_account?.safepay?.secretKey;
  const v = verifySafepay(params, secret);
  // Log the callback shape so the exact field names are confirmable after the
  // first real payment (values omitted; keys only).
  db.logEvent('safepay.callback', { shopId: job?.shopId, jobId: orderId, keys: Object.keys(params).join(','), verified: v.ok });
  if (job && v.ok && job.payment.status !== 'paid') {
    db.updateJob(job.id, {
      payment: { ...job.payment, status: 'paid', provider: 'safepay', ref: v.tracker, paidAt: new Date().toISOString() },
      print: { ...job.print, status: 'queued' },
    });
    db.logEvent('job.paid', { shopId: job.shopId, jobId: job.id, provider: 'safepay', amount: job.price.amount });
  } else if (job && !v.ok) {
    db.logEvent('job.pay_failed', { shopId: job.shopId, jobId: job.id, provider: 'safepay' });
  }
  const status = v.ok ? 'paid' : 'failed';
  const s = shop?.slug ? `&s=${encodeURIComponent(shop.slug)}` : '';
  res.redirect(`/p/?job=${encodeURIComponent(orderId)}&pay=${status}${s}`);
});

// --- status polling ----------------------------------------------------------
phoneRouter.get('/jobs/:id', async (req, res) => {
  let job = db.job(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  // If it's a Safepay job still unpaid, confirm directly with Safepay.
  if (job.payment.provider === 'safepay' && job.payment.status === 'unpaid' && job.payment.token) {
    await settleSafepay(job);
    job = db.job(req.params.id);
  }
  res.json(publicJob(job));
});

// Ask Safepay whether a job's tracker is paid; if so, mark it paid + queue it.
async function settleSafepay(job) {
  const shop = db.shop(job.shopId);
  const env = shop?.payment_account?.safepay?.environment;
  if (await checkTrackerPaid(job.payment.token, env)) {
    db.updateJob(job.id, {
      payment: { ...job.payment, status: 'paid', ref: job.payment.token, paidAt: new Date().toISOString() },
      print: { ...job.print, status: 'queued' },
    });
    db.logEvent('job.paid', { shopId: job.shopId, jobId: job.id, provider: 'safepay', amount: job.price.amount });
    return true;
  }
  return false;
}

// Background sweep: catch Safepay payments even if the customer never returned
// to the print page (e.g. they closed the tab on Safepay's success screen).
export async function sweepSafepay() {
  const cutoff = Date.now() - 30 * 60 * 1000; // only recent jobs
  for (const job of db.jobs()) {
    if (job.payment.provider === 'safepay' && job.payment.status === 'unpaid'
        && job.payment.token && new Date(job.createdAt).getTime() > cutoff) {
      await settleSafepay(job);
    }
  }
}

// --- helpers -----------------------------------------------------------------

function normaliseOptions(options, shop) {
  const cap = shop.capabilities;
  let duplex = ['single', 'double', 'mixed'].includes(options.duplex) ? options.duplex : 'single';
  if (!cap.duplex) duplex = 'single';
  const color = !!options.color && !!cap.color;
  const paperSize = cap.paperSizes.includes(options.paperSize) ? options.paperSize : cap.paperSizes[0];
  return {
    copies: clampInt(options.copies, 1, 999, 1),
    color, duplex,
    pageRange: typeof options.pageRange === 'string' ? options.pageRange.trim() : '',
    paperSize,
  };
}

function publicJob(job) {
  return {
    id: job.id,
    createdAt: job.createdAt,
    file: { originalName: job.file.originalName, pages: job.file.pages },
    options: job.options,
    price: job.price,
    payment: { status: job.payment.status, ref: job.payment.ref },
    print: { status: job.print.status, error: job.print.error },
    status: overallStatus(job),
  };
}

export function overallStatus(job) {
  if (job.payment.status === 'refunded') return 'refunded';
  if (job.print.status === 'printed') return 'done';
  if (job.print.status === 'failed') return 'failed';
  if (job.print.status === 'needs_attention') return 'needs_attention';
  if (job.print.status === 'printing') return 'printing';
  if (job.payment.status === 'paid') return 'queued';
  if (job.payment.status === 'awaiting_approval') return 'awaiting_approval';
  return 'awaiting_payment';
}

function safeUnlink(p) { try { fs.unlinkSync(p); } catch {} }

// Convert a JPG/PNG image into a single-page A4 PDF, centered and scaled to fit.
async function imageToPdf(bytes, isPng) {
  const doc = await PDFDocument.create();
  const img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const A4 = [595.28, 841.89];
  const page = doc.addPage(A4);
  const margin = 28;
  const maxW = A4[0] - margin * 2, maxH = A4[1] - margin * 2;
  const scale = Math.min(maxW / img.width, maxH / img.height, 1);
  const w = img.width * scale, h = img.height * scale;
  page.drawImage(img, { x: (A4[0] - w) / 2, y: (A4[1] - h) / 2, width: w, height: h });
  return doc.save();
}

// Recover jobs orphaned by an agent that stopped mid-print: if a job has been
// 'printing' too long, re-queue it (or, after enough tries, flag for the shop).
// This is what stops a crashed/closed agent from stranding paid jobs.
export function recoverStalePrints() {
  const staleMs = 4 * 60 * 1000; // 4 minutes with no result = assume the agent died
  const now = Date.now();
  for (const job of db.jobs()) {
    if (job.print.status !== 'printing' || job.payment.status !== 'paid') continue;
    const claimed = new Date(job.print.claimedAt || job.createdAt).getTime();
    if (now - claimed <= staleMs) continue;
    if (job.print.attempts >= 3) {
      db.updateJob(job.id, { print: { ...job.print, status: 'needs_attention', error: 'no_response' } });
      db.logEvent('job.stale_giveup', { shopId: job.shopId, jobId: job.id });
    } else {
      db.updateJob(job.id, { print: { ...job.print, status: 'queued', error: null } });
      db.logEvent('job.requeued_stale', { shopId: job.shopId, jobId: job.id });
    }
  }
}

export function cleanupPending() {
  const ttl = config.unpaidJobTtlMinutes * 60 * 1000;
  const now = Date.now();
  for (const [id, up] of pending) {
    if (now - up.createdAt > ttl) { safeUnlink(up.path); pending.delete(id); }
  }
  for (const job of db.jobs()) {
    if (job.payment.status === 'unpaid' && now - new Date(job.createdAt).getTime() > ttl) {
      safeUnlink(job.file.storedPath);
      db.removeJob(job.id);
    }
  }
}
