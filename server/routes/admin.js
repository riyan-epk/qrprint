// Provider (YOU) console: create and manage all shops. Protected by the admin
// key (header) or an admin session cookie.
import express from 'express';
import { config } from '../config.js';
import { db, randomKey } from '../db.js';
import { effectiveStatus, setSubscription } from '../subscription.js';
import { requireAdmin, hashPassword } from '../security.js';

export const adminRouter = express.Router();
adminRouter.use(express.json());
adminRouter.use(requireAdmin);

function baseUrl() {
  return (config.publicUrl || `http://localhost:${config.port}`).replace(/\/$/, '');
}

function shopSummary(shop) {
  const jobs = db.jobs(shop.id);
  const online = shop.runtime?.lastHeartbeat
    && (Date.now() - new Date(shop.runtime.lastHeartbeat).getTime() < 90 * 1000);
  return {
    id: shop.id,
    slug: shop.slug,
    name: shop.name,
    subscription: { ...effectiveStatus(shop), feeMonthly: shop.subscription.feeMonthly },
    hasPassword: !!shop.auth?.passwordHash,
    agentOnline: !!online,
    jobs: jobs.length,
    phoneUrl: `${baseUrl()}/p/?s=${shop.slug}`,
  };
}

// List all shops.
adminRouter.get('/shops', (_req, res) => {
  res.json({ shops: db.shops().map(shopSummary), baseUrl: baseUrl() });
});

// Full detail for one shop (includes the agent key + QR + login info).
adminRouter.get('/shops/:id', (req, res) => {
  const shop = db.shop(req.params.id);
  if (!shop) return res.status(404).json({ error: 'Shop not found.' });
  res.json({
    ...shopSummary(shop),
    agentKey: shop.agentKey,
    dashboardUrl: `${baseUrl()}/dashboard/`,
    qrUrl: `/api/qr?shop=${shop.slug}`,
  });
});

// Create a new shop. body: { name, password, feeMonthly? }
adminRouter.post('/shops', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Shop name is required.' });
  const feeMonthly = Number(req.body?.feeMonthly) || 1500;
  const password = req.body?.password;

  const shop = db.createShop({
    name, feeMonthly,
    passwordHash: password ? hashPassword(String(password)) : null,
  });
  db.logEvent('shop.created', { shopId: shop.id, slug: shop.slug });

  res.json({
    ok: true,
    shop: {
      ...shopSummary(shop),
      agentKey: shop.agentKey,
      dashboardUrl: `${baseUrl()}/dashboard/`,
    },
  });
});

// Set / reset a shop's dashboard password.
adminRouter.post('/shops/:id/password', (req, res) => {
  const shop = db.shop(req.params.id);
  if (!shop) return res.status(404).json({ error: 'Shop not found.' });
  const password = String(req.body?.password || '');
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  db.updateShop(shop.id, { auth: { passwordHash: hashPassword(password) } });
  db.logEvent('shop.password_set', { shopId: shop.id });
  res.json({ ok: true });
});

// Subscription controls (per shop).
adminRouter.post('/shops/:id/suspend', (req, res) => {
  if (!db.shop(req.params.id)) return res.status(404).json({ error: 'Shop not found.' });
  res.json({ ok: true, subscription: setSubscription(req.params.id, { status: 'suspended' }) });
});
adminRouter.post('/shops/:id/activate', (req, res) => {
  if (!db.shop(req.params.id)) return res.status(404).json({ error: 'Shop not found.' });
  res.json({ ok: true, subscription: setSubscription(req.params.id, { status: 'active', extendDays: req.body?.extendDays }) });
});
adminRouter.post('/shops/:id/plan', (req, res) => {
  const shop = db.shop(req.params.id);
  if (!shop) return res.status(404).json({ error: 'Shop not found.' });
  const sub = setSubscription(req.params.id, {
    status: shop.subscription.status === 'suspended' ? 'suspended' : 'active',
    feeMonthly: typeof req.body?.feeMonthly === 'number' ? req.body.feeMonthly : undefined,
    extendDays: 0,
  });
  res.json({ ok: true, subscription: sub });
});

// Rotate a shop's agent key (if it leaks). Returns the new key.
adminRouter.post('/shops/:id/rotate-agent-key', (req, res) => {
  const shop = db.shop(req.params.id);
  if (!shop) return res.status(404).json({ error: 'Shop not found.' });
  const key = randomKey();
  db.updateShop(shop.id, { agentKey: key });
  db.logEvent('shop.agent_key_rotated', { shopId: shop.id });
  res.json({ ok: true, agentKey: key });
});

// Delete a shop.
adminRouter.delete('/shops/:id', (req, res) => {
  if (!db.shop(req.params.id)) return res.status(404).json({ error: 'Shop not found.' });
  db.removeShop(req.params.id);
  db.logEvent('shop.deleted', { shopId: req.params.id });
  res.json({ ok: true });
});

adminRouter.get('/events', (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
  res.json({ events: db.events(limit) });
});
