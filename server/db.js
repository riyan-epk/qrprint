// Multi-tenant file-backed data store. Holds many shops; each has its own slug
// (used in the QR URL), agent key, dashboard password, prices, capabilities, and
// subscription. Zero native dependencies so `npm install` works anywhere.
// When you outgrow this, swap this one file for Postgres — nothing else in the
// codebase touches the JSON file directly.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

let state = null;

function seed() {
  // First run: create one starter shop. Its agent key = the AGENT_KEY from .env
  // so an existing single-shop agent config keeps working.
  const first = makeShop({ name: 'My Print Shop', agentKey: config.agentKey, slug: 'main' });
  return { shops: [first], jobs: [], events: [] };
}

function makeShop({ name, agentKey, slug, feeMonthly = 1500, passwordHash = null }) {
  const now = Date.now();
  return {
    id: makeId('shop'),
    slug: slug || makeSlug(name),
    name: name || 'Print Shop',
    mode: 'shop',
    unattended: false,
    agentKey: agentKey || randomKey(),
    payment_account: {
      provider: 'cash',                 // 'cash' | 'jazzcash' | 'safepay'
      display: 'Cash at counter',
      jazzcash: { merchantId: '', password: '', integritySalt: '' },
      safepay: { environment: 'sandbox', apiKey: '', secretKey: '' },
    },
    capabilities: { color: false, duplex: true, paperSizes: ['A4'], maxFileMb: config.maxUploadMb },
    pricing: { currency: 'PKR', bwPerPage: 5, colorPerPage: 20 },
    subscription: {
      status: 'active', plan: 'monthly', feeMonthly,
      validUntil: new Date(now + 30 * 864e5).toISOString(),
    },
    auth: { passwordHash },
    runtime: {},
  };
}

export function load() {
  try {
    if (fs.existsSync(config.dbFile)) {
      state = JSON.parse(fs.readFileSync(config.dbFile, 'utf8'));
    } else {
      state = seed();
      persist();
    }
  } catch (err) {
    console.error('DB load failed, starting fresh:', err.message);
    state = seed();
    persist();
  }
  migrate();
  return state;
}

// Backfill fields for shops created by older versions (single-shop era).
function migrate() {
  let changed = false;
  for (const [i, shop] of state.shops.entries()) {
    if (!shop.slug) { shop.slug = i === 0 ? 'main' : makeSlug(shop.name); changed = true; }
    if (!shop.agentKey) { shop.agentKey = i === 0 ? config.agentKey : randomKey(); changed = true; }
    if (!shop.auth) { shop.auth = { passwordHash: null }; changed = true; }
    if (!shop.runtime) { shop.runtime = {}; changed = true; }
    // Upgrade old single-field payment_account to the per-provider structure.
    const pa = shop.payment_account || {};
    if (!pa.jazzcash || !pa.safepay || !['cash', 'jazzcash', 'safepay'].includes(pa.provider)) {
      shop.payment_account = {
        provider: ['jazzcash', 'safepay'].includes(pa.provider) ? pa.provider : 'cash',
        display: pa.display && pa.display !== 'Not connected yet' ? pa.display : 'Cash at counter',
        jazzcash: pa.jazzcash || { merchantId: '', password: '', integritySalt: '' },
        safepay: pa.safepay || { environment: 'sandbox', apiKey: '', secretKey: '' },
      };
      changed = true;
    }
  }
  if (changed) persist();
}

function persist() {
  fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
  const tmp = config.dbFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, config.dbFile);
}

// --- accessors ---------------------------------------------------------------

export const db = {
  save: persist,

  // --- shops ---
  shops() { return state.shops; },
  shop(id) { return state.shops.find(s => s.id === id) || null; },
  shopBySlug(slug) { return state.shops.find(s => s.slug === slug) || null; },
  shopByAgentKey(key) { return state.shops.find(s => s.agentKey === key) || null; },
  firstShop() { return state.shops[0] || null; },

  createShop(opts) {
    // Ensure a unique slug.
    let base = opts.slug || makeSlug(opts.name);
    let slug = base, n = 1;
    while (state.shops.some(s => s.slug === slug)) slug = `${base}${++n}`;
    const shop = makeShop({ ...opts, slug });
    state.shops.push(shop);
    persist();
    return shop;
  },

  updateShop(id, patch) {
    const shop = db.shop(id);
    if (!shop) return null;
    const i = state.shops.indexOf(shop);
    state.shops[i] = deepMerge(shop, patch);
    persist();
    return state.shops[i];
  },

  removeShop(id) {
    const i = state.shops.findIndex(s => s.id === id);
    if (i >= 0) { state.shops.splice(i, 1); persist(); }
  },

  // --- jobs (each carries shopId) ---
  jobs(shopId) {
    return shopId ? state.jobs.filter(j => j.shopId === shopId) : state.jobs;
  },
  job(id) { return state.jobs.find(j => j.id === id) || null; },
  addJob(job) { state.jobs.unshift(job); persist(); return job; },
  updateJob(id, patch) {
    const j = db.job(id);
    if (!j) return null;
    Object.assign(j, patch);
    persist();
    return j;
  },
  removeJob(id) {
    const i = state.jobs.findIndex(j => j.id === id);
    if (i >= 0) { state.jobs.splice(i, 1); persist(); }
  },

  // --- events ---
  logEvent(type, data) {
    state.events.unshift({ at: new Date().toISOString(), type, ...data });
    if (state.events.length > 3000) state.events.length = 3000;
    persist();
  },
  events(limit = 100, shopId = null) {
    const src = shopId ? state.events.filter(e => e.shopId === shopId) : state.events;
    return src.slice(0, limit);
  },
};

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function randomKey() {
  return crypto.randomBytes(24).toString('hex');
}

// Short, URL-safe shop slug from a name, plus a little randomness for uniqueness.
export function makeSlug(name) {
  const base = String(name || 'shop').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'shop';
  return base + Math.random().toString(36).slice(2, 5);
}
