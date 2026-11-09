// Login / logout for shop dashboards and the provider admin console.
import express from 'express';
import { config } from '../config.js';
import { db } from '../db.js';
import {
  verifyPasswordAsync, safeEqual, setShopSession, setAdminSession, clearSession, loginLimiter,
  shopLoginFailures, adminKeyFailures, clientKey,
} from '../security.js';

export const authRouter = express.Router();
authRouter.use(express.json());

// Shop login: Shop ID (slug) + password -> signed cookie carrying the shop id.
// The same message for an unknown ID and a wrong password, so the login form
// can't be used to discover which Shop IDs exist.
const BAD_LOGIN = 'Wrong Shop ID or password.';

authRouter.post('/shop/login', loginLimiter, async (req, res) => {
  const slug = String(req.body?.shopId || '').trim().toLowerCase();
  const shop = db.shopBySlug(slug);
  if (!shop) return res.status(401).json({ error: BAD_LOGIN });

  // Shop IDs are printed on every QR, so the password is the only secret: after 10
  // wrong ones in 15 minutes this shop's login rests for 15 minutes, whoever asks.
  const locked = shopLoginFailures.lockedFor(shop.id);
  if (locked) {
    return res.status(429).json({ error: `Too many wrong passwords for this shop. Please wait ${locked} minute${locked === 1 ? '' : 's'}, or ask your provider to reset it.` });
  }

  const hash = shop.auth?.passwordHash;
  if (!hash) {
    // No password configured yet. Allowed only off-production (fresh dev shop).
    if (config.isProd) {
      return res.status(403).json({ error: 'This shop has no password yet. Ask your provider to set one.' });
    }
    setShopSession(res, shop);
    return res.json({ ok: true, shop: { name: shop.name, slug: shop.slug }, note: 'No password set (development).' });
  }

  if (!(await verifyPasswordAsync(req.body?.password || '', hash))) {
    shopLoginFailures.failed(shop.id);
    db.logEvent('auth.shop_login_failed', { shopId: shop.id });
    return res.status(401).json({ error: BAD_LOGIN });
  }
  shopLoginFailures.succeeded(shop.id);
  setShopSession(res, shop);
  db.logEvent('auth.shop_login', { shopId: shop.id });
  res.json({ ok: true, shop: { name: shop.name, slug: shop.slug } });
});

authRouter.post('/logout', (req, res) => {
  clearSession(res, 'shop', req);
  res.json({ ok: true });
});

// Admin (provider) login: admin key -> cookie. Wrong keys count against the
// caller's network, shared with the x-admin-key header (see requireAdmin).
authRouter.post('/admin/login', loginLimiter, (req, res) => {
  const who = clientKey(req);
  if (adminKeyFailures.lockedFor(who)) {
    return res.status(429).json({ error: 'Too many wrong admin keys. Try again later.' });
  }
  if (!safeEqual(req.body?.key || '', config.adminKey)) {
    adminKeyFailures.failed(who);
    return res.status(401).json({ error: 'Wrong admin key.' });
  }
  adminKeyFailures.succeeded(who);
  setAdminSession(res);
  db.logEvent('auth.admin_login', {});
  res.json({ ok: true });
});

authRouter.post('/admin/logout', (req, res) => {
  clearSession(res, 'admin', req);
  res.json({ ok: true });
});
