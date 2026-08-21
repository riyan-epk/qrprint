// Authentication, password hashing, and rate limiting.
// No native dependencies: password hashing uses Node's built-in scrypt, and the
// session cookie is a small HMAC-signed token (no jsonwebtoken/cookie-parser).
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { db } from './db.js';

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

const COOKIE = 'qrp_session';
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h

// claims: { role: 'shop', shopId } or { role: 'admin' }
export function setSession(res, claims) {
  const token = sign({ ...claims, exp: Date.now() + MAX_AGE_MS });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,          // require HTTPS in production
    maxAge: MAX_AGE_MS,
    path: '/',
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function session(req) {
  return unsign(readCookie(req, COOKIE));
}

// --- policy ------------------------------------------------------------------

// Multi-tenant: the dashboard always requires login, because logging in is how
// we know WHICH shop the user manages. Sets req.shopId for downstream handlers.
export function requireShopAuth(req, res, next) {
  const s = session(req);
  if (s && s.role === 'shop' && s.shopId && db.shop(s.shopId)) {
    req.shopId = s.shopId;
    return next();
  }
  return res.status(401).json({ error: 'Login required.', code: 'auth' });
}

export function requireAdmin(req, res, next) {
  // Header key (for API/automation) OR an admin session cookie (for the page).
  if (req.get('x-admin-key') === config.adminKey) return next();
  const s = session(req);
  if (s && s.role === 'admin') return next();
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
export const uploadLimiter = mk(10, 40, 'Too many uploads. Please slow down.');
export const payLimiter = mk(10, 30, 'Too many payment attempts. Please slow down.');
