// API for shop-side print agents. Each agent authenticates with ITS shop's
// agent key, so it only ever sees and prints that shop's jobs.
import express from 'express';
import fs from 'node:fs';
import { db } from '../db.js';
import { refund } from '../payments.js';

export const agentRouter = express.Router();

// Auth: the agent key identifies the shop.
agentRouter.use((req, res, next) => {
  const key = req.get('x-agent-key');
  const shop = key ? db.shopByAgentKey(key) : null;
  if (!shop) return res.status(401).json({ error: 'Bad agent key.' });
  req.shop = shop;
  next();
});

// Claim the next job for THIS shop (oldest paid + queued).
agentRouter.get('/jobs/next', (req, res) => {
  const shop = req.shop;
  const queued = db.jobs(shop.id)
    .filter(j => j.payment.status === 'paid' && j.print.status === 'queued')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const job = queued[0];
  if (!job) return res.json({ job: null });

  db.updateJob(job.id, {
    print: { ...job.print, status: 'printing', attempts: job.print.attempts + 1, claimedAt: new Date().toISOString() },
  });
  db.logEvent('job.claimed', { shopId: shop.id, jobId: job.id, attempt: job.print.attempts + 1 });

  res.json({
    job: {
      id: job.id,
      fileUrl: `/api/agent/jobs/${job.id}/file`,
      originalName: job.file.originalName,
      pages: job.file.pages,
      options: job.options,
      shopPaperSize: shop.capabilities.paperSizes[0],
    },
  });
});

// Download the PDF (only for this shop's jobs).
agentRouter.get('/jobs/:id/file', (req, res) => {
  const job = db.job(req.params.id);
  if (!job || job.shopId !== req.shop.id) return res.status(404).json({ error: 'Job not found.' });
  if (!fs.existsSync(job.file.storedPath)) return res.status(410).json({ error: 'File no longer available.' });
  res.setHeader('Content-Type', 'application/pdf');
  fs.createReadStream(job.file.storedPath).pipe(res);
});

// Report the outcome (refund-first policy).
agentRouter.post('/jobs/:id/report', express.json(), async (req, res) => {
  const job = db.job(req.params.id);
  if (!job || job.shopId !== req.shop.id) return res.status(404).json({ error: 'Job not found.' });

  const { result, reason } = req.body || {};

  if (result === 'printed') {
    db.updateJob(job.id, { print: { ...job.print, status: 'printed', error: null, printedAt: new Date().toISOString() } });
    db.logEvent('job.printed', { shopId: job.shopId, jobId: job.id });
    safeUnlink(job.file.storedPath);
    return res.json({ ok: true });
  }

  if (result === 'failed') {
    const recoverable = ['paper_out', 'jam', 'offline'].includes(reason);

    if (recoverable && !req.shop.unattended) {
      db.updateJob(job.id, { print: { ...job.print, status: 'needs_attention', error: reason || 'print_failed' } });
      db.logEvent('job.needs_attention', { shopId: job.shopId, jobId: job.id, reason });
      return res.json({ ok: true, action: 'needs_attention' });
    }

    if (job.payment.status === 'paid') {
      const r = await refund(job);
      db.updateJob(job.id, {
        payment: { ...job.payment, status: 'refunded', refundRef: r.ref, refundedAt: r.at },
        print: { ...job.print, status: 'failed', error: reason || 'print_failed' },
      });
      db.logEvent('job.refunded', { shopId: job.shopId, jobId: job.id, reason, manual: !!r.manual });
      return res.json({ ok: true, action: 'refunded', manual: !!r.manual });
    }

    db.updateJob(job.id, { print: { ...job.print, status: 'failed', error: reason || 'print_failed' } });
    return res.json({ ok: true, action: 'failed' });
  }

  res.status(400).json({ error: "result must be 'printed' or 'failed'." });
});

// Heartbeat -> updates this shop's runtime status.
agentRouter.post('/heartbeat', express.json(), (req, res) => {
  const { printer } = req.body || {};
  db.updateShop(req.shop.id, { runtime: { lastHeartbeat: new Date().toISOString(), printer: printer || {} } });
  res.json({ ok: true });
});

function safeUnlink(p) { try { fs.unlinkSync(p); } catch {} }
