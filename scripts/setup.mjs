// One-time setup: generate strong secrets into .env and (optionally) set the
// shop dashboard password. Safe to re-run — existing values are preserved
// unless you pass --force.
//
// Usage:
//   node scripts/setup.mjs
//   node scripts/setup.mjs --password "your-dashboard-password"
//   node scripts/setup.mjs --public-url https://print.example.com --force
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = path.join(ROOT, '.env');

const args = process.argv.slice(2);
const getArg = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };
const force = args.includes('--force');
const password = getArg('password');
const publicUrl = getArg('public-url');

// Read existing .env (to preserve values on re-run).
const existing = {};
if (fs.existsSync(ENV)) {
  for (const line of fs.readFileSync(ENV, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) existing[m[1]] = m[2];
  }
}

const rand = () => crypto.randomBytes(24).toString('hex');
const keep = (k, dflt) => (existing[k] && !force ? existing[k] : dflt);

const values = {
  NODE_ENV: keep('NODE_ENV', 'production'),
  PORT: keep('PORT', '3000'),
  PUBLIC_URL: publicUrl || keep('PUBLIC_URL', ''),
  TRUST_PROXY: keep('TRUST_PROXY', '1'),
  AGENT_KEY: keep('AGENT_KEY', rand()),
  ADMIN_KEY: keep('ADMIN_KEY', rand()),
  SESSION_SECRET: keep('SESSION_SECRET', rand()),
  PAYMENT_PROVIDER: keep('PAYMENT_PROVIDER', 'mock'),
  MAX_UPLOAD_MB: keep('MAX_UPLOAD_MB', '25'),
  GRACE_DAYS: keep('GRACE_DAYS', '3'),
  // JazzCash (fill when you have credentials)
  JAZZCASH_MERCHANT_ID: keep('JAZZCASH_MERCHANT_ID', ''),
  JAZZCASH_PASSWORD: keep('JAZZCASH_PASSWORD', ''),
  JAZZCASH_INTEGRITY_SALT: keep('JAZZCASH_INTEGRITY_SALT', ''),
};

const body = Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
fs.writeFileSync(ENV, body);
console.log(`✓ Wrote ${ENV}`);

// Optionally set the dashboard password now (works even before first run).
if (password) {
  // Import after .env exists so config picks it up.
  const { db, load } = await import('../server/db.js');
  const { hashPassword } = await import('../server/security.js');
  load();
  db.updateShop({ auth: { passwordHash: hashPassword(password) } });
  console.log('✓ Dashboard password set.');
} else {
  console.log('ℹ  No --password given. Set one before production:');
  console.log('     node scripts/setup.mjs --password "your-password"');
}

console.log('\nGenerated keys (store safely):');
console.log('  AGENT_KEY =', values.AGENT_KEY);
console.log('  ADMIN_KEY =', values.ADMIN_KEY);
console.log('\nPut AGENT_KEY into agent/config.json on the shop machine.');
