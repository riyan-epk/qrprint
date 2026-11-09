// Authentication, password hashing, and rate limiting.
// No native dependencies: password hashing uses Node's built-in scrypt, and the
// session cookie is a small HMAC-signed token (no jsonwebtoken/cookie-parser).
import crypto from 'node:crypto';
import net from 'node:net';
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

// The same check off the main thread, for the sign-in forms: a burst of guesses
// must not freeze the server for everyone else while each one is worked out.
export function verifyPasswordAsync(pw, stored) {
  if (!stored || !stored.startsWith('scrypt:')) return Promise.resolve(false);
  const [, salt, hash] = stored.split(':');
  return new Promise((resolve) => {
    crypto.scrypt(String(pw), salt, 64, (err, key) => {
      if (err) return resolve(false);
      const a = Buffer.from(hash, 'hex');
      resolve(a.length === key.length && crypto.timingSafeEqual(a, key));
    });
  });
}

// --- who is asking ------------------------------------------------------------

// A home or phone network gets a whole /64 block of IPv6 addresses, so the block
// counts as one visitor. Otherwise a guesser could switch address on every try
// and never reach a limit.
export function clientKey(req) {
  let ip = String(req.ip || '');
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (!net.isIPv6(ip)) return ip || 'unknown';
  const [head, tail] = ip.split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const groups = tail === undefined ? a : [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b];
  return groups.slice(0, 4).map((g) => parseInt(g || '0', 16).toString(16)).join(':') + '::/64';
}

// Wrong passwords or keys, counted per account (or per network for the admin
// key). After `max` misses in `windowMs` the door stays shut for `windowMs`,
// even for the right one, so guessing from many addresses gets nowhere.
// One server process holds the counts.
export class FailureCounter {
  constructor(max = 10, windowMs = 15 * 60 * 1000) {
    this.max = max; this.windowMs = windowMs; this.entries = new Map();
  }
  // Minutes left on the lock, or 0 when open.
  lockedFor(key) {
    const e = this.entries.get(key);
    if (!e || !e.until) return 0;
    const left = e.until - Date.now();
    if (left <= 0) { this.entries.delete(key); return 0; }
    return Math.ceil(left / 60000);
  }
  failed(key) {
    const now = Date.now();
    if (this.entries.size > 20000) {
      for (const [k, e] of this.entries) if ((!e.until || e.until < now) && now - e.since > this.windowMs) this.entries.delete(k);
    }
    let e = this.entries.get(key);
    if (!e || now - e.since > this.windowMs) e = { n: 0, since: now, until: 0 };
    e.n += 1;
    if (e.n >= this.max) { e.until = now + this.windowMs; e.n = 0; e.since = now; }
    this.entries.set(key, e);
  }
  succeeded(key) { this.entries.delete(key); }
}

export const shopLoginFailures = new FailureCounter();
export const adminKeyFailures = new FailureCounter();

// Constant-time string compare (for the admin key).
export function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// A short fingerprint of a secret. Stored in the session so that changing the
// password (or the admin key) signs out every existing session. Keyed with the
// session secret, so the fingerprint in a cookie says nothing about the secret.
function fingerprint(secret) {
  return crypto.createHmac('sha256', config.sessionSecret).update(String(secret || 'none')).digest('base64url').slice(0, 16);
}

// Sessions ended with "Log out" before their 12 hours were up. Kept until they
// would have run out anyway (in memory: a restart clears it, which is rare).
const loggedOut = new Map();   // token mac -> expiry (ms)
function forget(mac, exp) {
  const now = Date.now();
  if (loggedOut.size > 5000) for (const [m, e] of loggedOut) if (e < now) loggedOut.delete(m);
  loggedOut.set(mac, exp || now + MAX_AGE_MS);
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
  if (loggedOut.has(mac)) return null;
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

// Log out: the cookie goes, and the session itself stops working, so a copy of it
// (another tab, a shared PC, a stolen cookie) is no good either.
export function clearSession(res, role, req) {
  const token = req ? readCookie(req, COOKIES[role]) : null;
  const s = token ? unsign(token) : null;
  if (s) forget(token.split('.')[1], s.exp);
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
  // Wrong header keys count like wrong logins, so the key can't be guessed by
  // sending request after request.
  const key = req.get('x-admin-key');
  if (key) {
    const who = clientKey(req);
    if (adminKeyFailures.lockedFor(who)) return res.status(429).json({ error: 'Too many wrong admin keys. Try again later.' });
    if (safeEqual(key, config.adminKey)) return next();
    adminKeyFailures.failed(who);
    return res.status(401).json({ error: 'Admin auth required.', code: 'auth' });
  }
  if (isAdminSession(req)) return next();
  return res.status(401).json({ error: 'Admin auth required.', code: 'auth' });
}

// --- rate limiters -----------------------------------------------------------

const mk = (windowMinutes, max, message) => rateLimit({
  windowMs: windowMinutes * 60 * 1000,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientKey,
  message: { error: message },
});

export const loginLimiter = mk(15, 10, 'Too many login attempts. Try again later.');
// Per IP. Generous because a busy shop's customers often share one IP (shop
// WiFi or mobile carrier NAT); still stops a single script from flooding us.
export const uploadLimiter = mk(10, 120, 'Too many uploads. Please slow down.');
export const payLimiter = mk(10, 90, 'Too many payment attempts. Please slow down.');
