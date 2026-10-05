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
import { phoneRouter, autoCleanup, recoverStalePrints, sweepSafepay } from './routes/phone.js';
import { agentRouter } from './routes/agent.js';
import { dashboardRouter } from './routes/dashboard.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { warmup as warmupOffice } from './office.js';
import { shopFromSession, isAdminSession } from './security.js';

validateProd();   // refuse to boot with insecure defaults in production
load();           // read or seed the database

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1); // correct client IP + secure cookies behind Caddy/Nginx

// Security headers. CSP is tight: scripts from self only (no inline JS);
// styles from self + Google Fonts (inline allowed for small style attributes).
// JazzCash's hosted checkout is a form POST, so its origins are allowed as form
// targets (Safepay is a plain redirect and needs nothing here).
const formActions = ["'self'", 'https://sandbox.jazzcash.com.pk', 'https://payments.jazzcash.com.pk'];
try {
  if (config.jazzcash.baseUrl) formActions.push(new URL(config.jazzcash.baseUrl).origin);
} catch {}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],      // blob: = photo previews on the phone
      workerSrc: ["'self'"],                       // pdf.js page previews
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: [...new Set(formActions)],
      upgradeInsecureRequests: config.isProd ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '256kb' })); // APIs that need it also set their own; this is a safety cap

// Simple access log to a file (and console in dev). Routine polling (agents
// asking for jobs, phones checking status) isn't logged, and the file rotates
// at 10 MB keeping one old copy, so it can't fill the disk.
fs.mkdirSync(config.logDir, { recursive: true });
const ACCESS_LOG = path.join(config.logDir, 'access.log');
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const QUIET = /^\/api\/agent\/(jobs\/next|heartbeat|jobs\/[^/]+\/progress)$|^\/api\/phone\/jobs\/[^/]+$/;
let accessLog = fs.createWriteStream(ACCESS_LOG, { flags: 'a' });
let logBytes = fs.existsSync(ACCESS_LOG) ? fs.statSync(ACCESS_LOG).size : 0;
app.use((req, res, next) => {
  res.on('finish', () => {
    if (QUIET.test(req.path) && res.statusCode < 400) return;
    const line = `${new Date().toISOString()} ${req.ip} ${req.method} ${req.originalUrl} ${res.statusCode}\n`;
    accessLog.write(line);
    if (!config.isProd) process.stdout.write('  ' + line);
    logBytes += line.length;
    if (logBytes > MAX_LOG_BYTES) {
      accessLog.end();
      try { fs.renameSync(ACCESS_LOG, ACCESS_LOG + '.1'); } catch {}
      accessLog = fs.createWriteStream(ACCESS_LOG, { flags: 'a' });
      logBytes = 0;
    }
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

// HTML pages served by the server (not express.static) get {{VARS}} filled in,
// so contact details are configured once (CONTACT_EMAIL / CONTACT_WHATSAPP).
const escHtml = (v) => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function sendPage(res, file, next) {
  fs.readFile(path.isAbsolute(file) ? file : path.join(pub, file), 'utf8', (err, html) => {
    if (err) return next ? next(err) : res.status(500).end();
    const vars = {
      CONTACT_EMAIL: config.contact.email,
      CONTACT_WHATSAPP: config.contact.whatsapp,
      WHATSAPP_LINK: 'https://wa.me/' + config.contact.whatsapp.replace(/\D/g, ''),
      YEAR: new Date().getFullYear(),
    };
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? escHtml(vars[k]) : m)));
  });
}

// Protected pages are decided on the server: a logged-out visitor gets the
// login page straight away (never a flash of the dashboard first), and a
// logged-in one skips the login page.
app.get(['/dashboard/', '/dashboard/index.html'], (req, res) => {
  if (!shopFromSession(req)) return res.redirect(302, '/dashboard/login');
  sendPage(res, 'dashboard/index.html');
});
app.get(['/dashboard/login', '/dashboard/login.html'], (req, res) => {
  if (shopFromSession(req)) return res.redirect(302, '/dashboard/');
  sendPage(res, 'dashboard/login.html');
});
app.get(['/admin/', '/admin/index.html'], (req, res) => {
  if (!isAdminSession(req)) return res.redirect(302, '/admin/login');
  sendPage(res, 'admin/index.html');
});
app.get(['/admin/login', '/admin/login.html'], (req, res) => {
  if (isAdminSession(req)) return res.redirect(302, '/admin/');
  sendPage(res, 'admin/login.html');
});

app.use('/shared', express.static(path.join(pub, 'shared'), staticOpts));
app.use('/site', express.static(path.join(pub, 'site'), staticOpts));
// Third-party browser files in versioned folders (e.g. /vendor/pdfjs-6.4.299/),
// so they can be cached for a long time.
app.use('/vendor', express.static(path.join(pub, 'vendor'), { immutable: true, maxAge: '365d' }));
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

// Public homepage.
app.get('/', (_req, res, next) => sendPage(res, path.join(config.root, 'server', 'views', 'home.html'), next));

// 404 + error handler (never leak stack traces in production).
app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, _next) => {
  const line = `${new Date().toISOString()} ERROR ${req.method} ${req.originalUrl} ${err.stack || err}\n`;
  fs.appendFile(path.join(config.logDir, 'error.log'), line, () => {});
  if (!config.isProd) console.error(err);
  res.status(err.status || 500).json({ error: config.isProd ? 'Server error.' : String(err.message || err) });
});

// Auto-delete old files and job records (also once at startup).
autoCleanup();
const cleanupTimer = setInterval(autoCleanup, 5 * 60 * 1000);
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
