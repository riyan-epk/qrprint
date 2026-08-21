// QRPrint server entry point. Serves the three web UIs (phone, dashboard,
// admin) and all APIs. Runs locally (LAN pilot) or in the cloud (hybrid).
import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import QRCode from 'qrcode';
import { config, validateProd } from './config.js';
import { load, db } from './db.js';
import { phoneRouter, cleanupPending, recoverStalePrints, sweepSafepay } from './routes/phone.js';
import { agentRouter } from './routes/agent.js';
import { dashboardRouter } from './routes/dashboard.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { warmup as warmupOffice } from './office.js';

validateProd();   // refuse to boot with insecure defaults in production
load();           // read or seed the database

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1); // correct client IP + secure cookies behind Caddy/Nginx

// Security headers. CSP is tight: scripts/styles from self only (styles allow
// inline because a couple of pages use small <style> blocks). No inline JS.
// The payment provider's origin is allowed as a form target so the hosted
// checkout redirect works.
const formActions = ["'self'"];
try {
  if (config.paymentProvider === 'jazzcash' && config.jazzcash.baseUrl) {
    formActions.push(new URL(config.jazzcash.baseUrl).origin);
  }
} catch {}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: formActions,
      upgradeInsecureRequests: config.isProd ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '256kb' })); // APIs that need it also set their own; this is a safety cap

// Simple access log to a file (and console in dev).
fs.mkdirSync(config.logDir, { recursive: true });
const accessLog = fs.createWriteStream(path.join(config.logDir, 'access.log'), { flags: 'a' });
app.use((req, res, next) => {
  res.on('finish', () => {
    const line = `${new Date().toISOString()} ${req.ip} ${req.method} ${req.originalUrl} ${res.statusCode}\n`;
    accessLog.write(line);
    if (!config.isProd) process.stdout.write('  ' + line);
  });
  next();
});

// Static UIs. Send no-cache so updated HTML/JS/CSS is picked up immediately
// (the app changes often; correctness beats caching a few KB).
const staticOpts = {
  etag: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
};
const pub = path.join(config.root, 'server', 'public');
app.use('/p', express.static(path.join(pub, 'phone'), staticOpts));
app.use('/dashboard', express.static(path.join(pub, 'dashboard'), staticOpts));
app.use('/admin', express.static(path.join(pub, 'admin'), staticOpts));

// APIs.
app.use('/api/auth', authRouter);
app.use('/api/phone', phoneRouter);
app.use('/api/agent', agentRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/admin', adminRouter);

app.get('/api/health', (_req, res) => res.json({ ok: true, env: config.env, time: new Date().toISOString() }));

// The URL the QR encodes = the phone page for a specific shop (?s=<slug>).
// PUBLIC_URL for hybrid, else LAN IP.
function phoneUrl(slug) {
  const base = config.publicUrl || `http://${lanIp()}:${config.port}`;
  const u = `${base.replace(/\/$/, '')}/p/`;
  return slug ? `${u}?s=${encodeURIComponent(slug)}` : u;
}

function qrSlug(req) {
  return req.query.shop || db.firstShop()?.slug || '';
}

app.get('/api/qr', async (req, res) => {
  try {
    const svg = await QRCode.toString(phoneUrl(qrSlug(req)), { type: 'svg', margin: 1, width: 240 });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  } catch { res.status(500).send('QR error'); }
});
app.get('/api/qr/target', (req, res) => res.json({ url: phoneUrl(qrSlug(req)) }));

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html><meta charset="utf8"><title>QRPrint</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{font-family:system-ui;max-width:640px;margin:60px auto;padding:0 20px;line-height:1.7}
    a{display:block;margin:8px 0;font-size:1.1rem}code{background:#eee;padding:2px 6px;border-radius:4px}</style>
    <h1>🖨️ QRPrint (${config.env})</h1>
    <a href="/p/">📱 Phone page (what the QR opens)</a>
    <a href="/dashboard/">🧾 Shop dashboard</a>
    <a href="/admin/">🔒 Provider admin</a>
    <p style="color:#666">QR target: <code>${phoneUrl()}</code></p>`);
});

// 404 + error handler (never leak stack traces in production).
app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, _next) => {
  const line = `${new Date().toISOString()} ERROR ${req.method} ${req.originalUrl} ${err.stack || err}\n`;
  fs.appendFile(path.join(config.logDir, 'error.log'), line, () => {});
  if (!config.isProd) console.error(err);
  res.status(err.status || 500).json({ error: config.isProd ? 'Server error.' : String(err.message || err) });
});

// Periodic cleanup of abandoned uploads / unpaid jobs.
const cleanupTimer = setInterval(cleanupPending, 5 * 60 * 1000);
cleanupTimer.unref();

// Recover jobs stranded by a stopped agent (re-queue stale 'printing' jobs).
const recoverTimer = setInterval(recoverStalePrints, 60 * 1000);
recoverTimer.unref();

// Confirm Safepay payments even if the customer didn't return to the page.
const sweepTimer = setInterval(() => { sweepSafepay().catch(() => {}); }, 20 * 1000);
sweepTimer.unref();

const server = app.listen(config.port, () => {
  const url = config.publicUrl || `http://${lanIp()}:${config.port}`;
  console.log('\n  QRPrint server running  [' + config.env + ']');
  console.log('  ----------------------------------------');
  console.log(`  Local:      http://localhost:${config.port}`);
  console.log(`  Phones use: ${url}   (QR target: ${url}/p/)`);
  console.log(`  Dashboard:  http://localhost:${config.port}/dashboard/`);
  console.log(`  Admin:      http://localhost:${config.port}/admin/`);
  if (!config.isProd) {
    console.log(`  Agent key:  ${config.agentKey}`);
    console.log(`  Admin key:  ${config.adminKey}`);
  }
  console.log(`  Payments:   ${config.paymentProvider}`);
  console.log('  ----------------------------------------\n');
  warmupOffice(); // pre-start LibreOffice so the first Word/Excel upload is fast
});

// Graceful shutdown (so containers/systemd restart cleanly).
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`\n  ${sig} received — shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

function lanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}
