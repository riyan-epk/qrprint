// API for shop-side print agents. Each agent authenticates with ITS shop's
// agent key, so it only ever sees and prints that shop's jobs.
import express from 'express';
import fs from 'node:fs';
import { db } from '../db.js';
import { refund } from '../payments.js';

export const agentRouter = express.Router();

// Auth: the agent key identifies the shop.
//
// PC lock: agents v2+ send a machine fingerprint (x-agent-machine). The first
// PC to connect with a shop's key is remembered, and the key then only works
// on that PC — so a copied or leaked key can't be used elsewhere to pull the
// shop's customer documents. The provider can unlink it in the console (or
// rotate the key) when the shop changes computers.
const MACHINE_RE = /^[a-f0-9]{16,64}$/;
const lastMismatchLog = new Map();   // shopId -> time, so a stray agent can't flood the event log

agentRouter.use((req, res, next) => {
  const key = req.get('x-agent-key');
  const shop = key ? db.shopByAgentKey(key) : null;
  if (!shop) return res.status(401).json({ error: 'Bad agent key.' });

  const machine = String(req.get('x-agent-machine') || '').toLowerCase();
  const bound = shop.runtime?.machineId;
  if (bound) {
    if (machine !== bound) {
      const now = Date.now();
      if (now - (lastMismatchLog.get(shop.id) || 0) > 10 * 60 * 1000) {
        lastMismatchLog.set(shop.id, now);
        db.logEvent('agent.other_pc_blocked', { shopId: shop.id });
      }
      return res.status(409).json({ error: 'This agent key is linked to another computer.', code: 'other_pc' });
    }
  } else if (MACHINE_RE.test(machine)) {
    db.updateShop(shop.id, { runtime: { machineId: machine, machineLinkedAt: new Date().toISOString() } });
    db.logEvent('agent.pc_linked', { shopId: shop.id });
  }
  req.shop = db.shop(shop.id);
  next();
});

// Lets the agent confirm its key (and show the shop name) during setup.
agentRouter.get('/whoami', (req, res) => {
  res.json({ shop: { name: req.shop.name, slug: req.shop.slug } });
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
    print: { ...job.print, status: 'printing', attempts: job.print.attempts + 1, claimedAt: new Date().toISOString(), pingAt: null },
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

// Keep-alive while a job prints, so a big/slow job isn't mistaken for a stopped
// agent and re-queued (which would print it twice). See recoverStalePrints.
agentRouter.post('/jobs/:id/progress', (req, res) => {
  const job = db.job(req.params.id);
  if (!job || job.shopId !== req.shop.id) return res.status(404).json({ error: 'Job not found.' });
  if (job.print.status !== 'printing') return res.json({ ok: false, status: job.print.status });
  db.updateJob(job.id, { print: { ...job.print, pingAt: new Date().toISOString() } });
  res.json({ ok: true });
});

// Report the outcome (refund-first policy).
agentRouter.post('/jobs/:id/report', express.json(), async (req, res) => {
  const job = db.job(req.params.id);
  if (!job || job.shopId !== req.shop.id) return res.status(404).json({ error: 'Job not found.' });

  const { result, reason } = req.body || {};

  if (result === 'printed') {
    // Printed -> delete the customer's file right away (privacy).
    safeUnlink(job.file.storedPath);
    db.updateJob(job.id, {
      file: { ...job.file, storedPath: null },
      print: { ...job.print, status: 'printed', error: null, printedAt: new Date().toISOString() },
    });
    db.logEvent('job.printed', { shopId: job.shopId, jobId: job.id });
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
      // Refunded jobs can't be reprinted, so the file isn't needed any more.
      safeUnlink(job.file.storedPath);
      db.updateJob(job.id, {
        file: { ...job.file, storedPath: null },
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

// Heartbeat -> updates this shop's runtime status. Every field is written
// explicitly (null when absent) so a cleared printer problem doesn't linger.
const clip = (v, n = 80) => (v == null ? null : String(v).slice(0, n));
agentRouter.post('/heartbeat', express.json(), (req, res) => {
  const { printer = {}, agent = {} } = req.body || {};
  db.updateShop(req.shop.id, { runtime: {
    lastHeartbeat: new Date().toISOString(),
    printer: { online: printer.online !== false, name: clip(printer.name), issue: clip(printer.issue, 40) },
    agent: { version: clip(agent.version, 20), os: clip(agent.os, 40) },
  } });
  res.json({ ok: true });
});

function safeUnlink(p) { try { fs.unlinkSync(p); } catch {} }
