// Authentication, password hashing, and rate limiting.
// No native dependencies: password hashing uses Node's built-in scrypt, and the
// session cookie is a small HMAC-signed token (no jsonwebtoken/cookie-parser).
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { db } from './db.js';

export const MIN_PASSWORD = 8;

// --- password hashing (scrypt) ----------------------------------------------

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt:')) return false;
  const [, salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Constant-time string compare (for the admin key).
export function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// A short fingerprint of a secret. Stored in the session so that changing the
// password (or the admin key) signs out every existing session.
function fingerprint(secret) {
  return crypto.createHash('sha256').update(String(secret || 'none')).digest('base64url').slice(0, 12);
}

// --- signed session token ----------------------------------------------------

function sign(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const mac = crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

function unsign(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (obj.exp && Date.now() > obj.exp) return null;
    return obj;
  } catch { return null; }
}

// Separate cookies, so logging into the provider console doesn't log a shop
// out in the same browser (and vice versa).
const COOKIES = { shop: 'qrp_session', admin: 'qrp_admin' };
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h

function setCookie(res, role, claims) {
  const token = sign({ ...claims, role, exp: Date.now() + MAX_AGE_MS });
  res.cookie(COOKIES[role], token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,          // require HTTPS in production
    maxAge: MAX_AGE_MS,
    path: '/',
  });
}

export function setShopSession(res, shop) {
  setCookie(res, 'shop', { shopId: shop.id, pv: fingerprint(shop.auth?.passwordHash) });
}

export function setAdminSession(res) {
  setCookie(res, 'admin', { kv: fingerprint(config.adminKey) });
}

export function clearSession(res, role) {
  res.clearCookie(COOKIES[role], { path: '/' });
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      try { return decodeURIComponent(v.join('=')); } catch { return null; }
    }
  }
  return null;
}

// The logged-in shop, or null. The session dies if the shop is deleted or its
// password changes.
export function shopFromSession(req) {
  const s = unsign(readCookie(req, COOKIES.shop));
  if (!s || s.role !== 'shop' || !s.shopId) return null;
  const shop = db.shop(s.shopId);
  if (!shop || s.pv !== fingerprint(shop.auth?.passwordHash)) return null;
  return shop;
}

export function isAdminSession(req) {
  const s = unsign(readCookie(req, COOKIES.admin));
  return !!(s && s.role === 'admin' && s.kv === fingerprint(config.adminKey));
}

// --- policy ------------------------------------------------------------------

// Multi-tenant: the dashboard always requires login, because logging in is how
// we know WHICH shop the user manages. Sets req.shopId for downstream handlers.
export function requireShopAuth(req, res, next) {
  const shop = shopFromSession(req);
  if (shop) {
    req.shopId = shop.id;
    return next();
  }
  return res.status(401).json({ error: 'Login required.', code: 'auth' });
}

export function requireAdmin(req, res, next) {
  // Header key (for API/automation) OR an admin session cookie (for the page).
  const key = req.get('x-admin-key');
  if (key && safeEqual(key, config.adminKey)) return next();
  if (isAdminSession(req)) return next();
  return res.status(401).json({ error: 'Admin auth required.', code: 'auth' });
}

// --- rate limiters -----------------------------------------------------------

const mk = (windowMinutes, max, message) => rateLimit({
  windowMs: windowMinutes * 60 * 1000,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: message },
});

export const loginLimiter = mk(15, 10, 'Too many login attempts. Try again later.');
// Per IP. Generous because a busy shop's customers often share one IP (shop
// WiFi or mobile carrier NAT); still stops a single script from flooding us.
export const uploadLimiter = mk(10, 120, 'Too many uploads. Please slow down.');
export const payLimiter = mk(10, 90, 'Too many payment attempts. Please slow down.');
