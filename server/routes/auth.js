// Login / logout for shop dashboards and the provider admin console.
import express from 'express';
import { config } from '../config.js';
import { db } from '../db.js';
import {
  verifyPassword, safeEqual, setShopSession, setAdminSession, clearSession, loginLimiter,
} from '../security.js';

export const authRouter = express.Router();
authRouter.use(express.json());

// Shop login: Shop ID (slug) + password -> signed cookie carrying the shop id.
// The same message for an unknown ID and a wrong password, so the login form
// can't be used to discover which Shop IDs exist.
const BAD_LOGIN = 'Wrong Shop ID or password.';

authRouter.post('/shop/login', loginLimiter, (req, res) => {
  const slug = String(req.body?.shopId || '').trim().toLowerCase();
  const shop = db.shopBySlug(slug);
  if (!shop) return res.status(401).json({ error: BAD_LOGIN });

  const hash = shop.auth?.passwordHash;
  if (!hash) {
    // No password configured yet. Allowed only off-production (fresh dev shop).
    if (config.isProd) {
      return res.status(403).json({ error: 'This shop has no password yet. Ask your provider to set one.' });
    }
    setShopSession(res, shop);
    return res.json({ ok: true, shop: { name: shop.name, slug: shop.slug }, note: 'No password set (development).' });
  }

  if (!verifyPassword(req.body?.password || '', hash)) {
    db.logEvent('auth.shop_login_failed', { shopId: shop.id });
    return res.status(401).json({ error: BAD_LOGIN });
  }
  setShopSession(res, shop);
  db.logEvent('auth.shop_login', { shopId: shop.id });
  res.json({ ok: true, shop: { name: shop.name, slug: shop.slug } });
});

authRouter.post('/logout', (_req, res) => {
  clearSession(res, 'shop');
  res.json({ ok: true });
});

// Admin (provider) login: admin key -> cookie.
authRouter.post('/admin/login', loginLimiter, (req, res) => {
  if (!safeEqual(req.body?.key || '', config.adminKey)) {
    return res.status(401).json({ error: 'Wrong admin key.' });
  }
  setAdminSession(res);
  db.logEvent('auth.admin_login', {});
  res.json({ ok: true });
});

authRouter.post('/admin/logout', (_req, res) => {
  clearSession(res, 'admin');
  res.json({ ok: true });
});
