// Login / logout for shop dashboards and the provider admin console.
import express from 'express';
import { config } from '../config.js';
import { db } from '../db.js';
import { verifyPassword, setSession, clearSession, loginLimiter } from '../security.js';

export const authRouter = express.Router();
authRouter.use(express.json());

// The dashboard always shows a login (that's how we know which shop it is).
authRouter.get('/me', (_req, res) => {
  res.json({ multiTenant: true, dashboardAuthRequired: true });
});

// Shop login: Shop ID (slug) + password -> signed cookie carrying the shop id.
authRouter.post('/shop/login', loginLimiter, (req, res) => {
  const slug = String(req.body?.shopId || '').trim();
  const shop = db.shopBySlug(slug);
  if (!shop) return res.status(401).json({ error: 'Unknown Shop ID.' });

  const hash = shop.auth?.passwordHash;
  if (!hash) {
    // No password configured yet. Allowed only off-production (fresh dev shop).
    if (config.isProd) {
      return res.status(403).json({ error: 'This shop has no password set. Ask the provider to set one.' });
    }
    setSession(res, { role: 'shop', shopId: shop.id });
    return res.json({ ok: true, shop: { name: shop.name, slug: shop.slug }, note: 'No password set (development).' });
  }

  if (!verifyPassword(req.body?.password || '', hash)) {
    return res.status(401).json({ error: 'Wrong password.' });
  }
  setSession(res, { role: 'shop', shopId: shop.id });
  db.logEvent('auth.shop_login', { shopId: shop.id });
  res.json({ ok: true, shop: { name: shop.name, slug: shop.slug } });
});

// Admin (provider) login: admin key -> cookie.
authRouter.post('/admin/login', loginLimiter, (req, res) => {
  if ((req.body?.key || '') !== config.adminKey) {
    return res.status(401).json({ error: 'Wrong admin key.' });
  }
  setSession(res, { role: 'admin' });
  res.json({ ok: true });
});

authRouter.post('/logout', (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});
