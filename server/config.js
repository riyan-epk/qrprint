// Central configuration. Everything is overridable by environment variables so
// the same code runs on a laptop (local pilot) or a cloud server (hybrid).
// In production we REFUSE to start with insecure defaults — see validateProd().
import 'dotenv/config';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DEV_AGENT_KEY = 'dev-agent-key';
const DEV_ADMIN_KEY = 'dev-admin-key';

export const config = {
  root: ROOT,
  env: process.env.NODE_ENV || 'development',
  get isProd() { return this.env === 'production'; },

  port: Number(process.env.PORT || 3000),

  // Public base URL. In hybrid/cloud this is your https domain; the QR encodes
  // it and payment callbacks use it. Local mode auto-detects the LAN IP.
  publicUrl: process.env.PUBLIC_URL || '',

  // Behind a reverse proxy (Caddy/Nginx) so req.protocol/secure are correct.
  trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',

  // Data location. JSON store + uploaded files. Created automatically.
  dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
  get dbFile() { return path.join(this.dataDir, 'db.json'); },
  get uploadsDir() { return path.join(this.dataDir, 'uploads'); },
  get logDir() { return path.join(this.dataDir, 'logs'); },

  // Secrets. Dev defaults are printed at startup; production must override them.
  agentKey: process.env.AGENT_KEY || DEV_AGENT_KEY,
  adminKey: process.env.ADMIN_KEY || DEV_ADMIN_KEY,
  // Used to sign the shop login cookie. Random per-process fallback in dev.
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),

  // Limits / policy.
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 25),
  unpaidJobTtlMinutes: Number(process.env.UNPAID_TTL_MIN || 30),
  graceDays: Number(process.env.GRACE_DAYS || 3),

  // Payment provider: 'mock' (offline, always succeeds) or 'jazzcash'.
  paymentProvider: process.env.PAYMENT_PROVIDER || 'mock',
  jazzcash: {
    merchantId: process.env.JAZZCASH_MERCHANT_ID || '',
    password: process.env.JAZZCASH_PASSWORD || '',
    integritySalt: process.env.JAZZCASH_INTEGRITY_SALT || '',
    // Sandbox vs live base URL.
    baseUrl: process.env.JAZZCASH_BASE_URL
      || 'https://sandbox.jazzcash.com.pk/ApplicationAPI/API/2.0/Purchase/DoTransaction',
    returnPath: '/api/phone/pay/jazzcash/callback',
  },

  // The dev keys, exposed so startup validation can detect them.
  _devKeys: { DEV_AGENT_KEY, DEV_ADMIN_KEY },
};

// Fail fast in production if anything is left at an insecure default.
export function validateProd() {
  if (!config.isProd) return;
  const problems = [];
  if (config.agentKey === DEV_AGENT_KEY) problems.push('AGENT_KEY is still the dev default');
  if (config.adminKey === DEV_ADMIN_KEY) problems.push('ADMIN_KEY is still the dev default');
  if (!process.env.SESSION_SECRET) problems.push('SESSION_SECRET is not set');
  if (!config.publicUrl) problems.push('PUBLIC_URL is not set (needed for the QR + payment callbacks)');
  if (config.paymentProvider === 'jazzcash') {
    if (!config.jazzcash.merchantId) problems.push('JAZZCASH_MERCHANT_ID is not set');
    if (!config.jazzcash.integritySalt) problems.push('JAZZCASH_INTEGRITY_SALT is not set');
  }
  if (problems.length) {
    console.error('\n  ✗ Refusing to start in production with insecure config:\n');
    for (const p of problems) console.error('    - ' + p);
    console.error('\n  Fix these in your .env (run `npm run setup` to generate secrets), then restart.\n');
    process.exit(1);
  }
}
