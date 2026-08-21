// The remote lock, per shop. Each shop pays YOU monthly; this decides whether
// its self-service accepts new jobs. Kind by design: active -> grace (still
// works, with a warning) -> suspended (locked). Reactivation is instant.
import { config } from './config.js';
import { db } from './db.js';

// Effective status from validUntil + any manual override.
export function effectiveStatus(shop) {
  const sub = shop.subscription;
  if (sub.status === 'suspended') return { status: 'suspended', reason: 'manual' };

  const now = Date.now();
  const validUntil = new Date(sub.validUntil).getTime();
  const graceEnds = validUntil + config.graceDays * 864e5;

  if (now <= validUntil) return { status: 'active', reason: 'paid', validUntil: sub.validUntil };
  if (now <= graceEnds) {
    const daysLeft = Math.ceil((graceEnds - now) / 864e5);
    return { status: 'grace', reason: 'overdue', daysLeft, validUntil: sub.validUntil };
  }
  return { status: 'suspended', reason: 'lapsed', validUntil: sub.validUntil };
}

export function canAcceptJobs(shop) {
  return effectiveStatus(shop).status !== 'suspended';
}

export function statusMessage(shop) {
  const s = effectiveStatus(shop);
  if (s.status === 'active') return { ...s, message: '' };
  if (s.status === 'grace') {
    return { ...s, message: `Payment due. Service continues for ${s.daysLeft} more day(s) — please renew.` };
  }
  return { ...s, message: 'Service is paused. Please contact the provider to reactivate.' };
}

// Provider actions (the kill-switch) for a specific shop.
export function setSubscription(shopId, { status, extendDays, feeMonthly, plan }) {
  const shop = db.shop(shopId);
  if (!shop) return null;
  const sub = { ...shop.subscription };

  if (typeof feeMonthly === 'number') sub.feeMonthly = feeMonthly;
  if (plan) sub.plan = plan;

  if (status === 'suspended') {
    sub.status = 'suspended';
  } else if (status === 'active') {
    sub.status = 'active';
    const base = Math.max(Date.now(), new Date(sub.validUntil).getTime());
    const days = Number(extendDays == null ? 30 : extendDays);
    sub.validUntil = new Date(base + days * 864e5).toISOString();
  }

  db.updateShop(shopId, { subscription: sub });
  db.logEvent('subscription.change', { shopId, status: sub.status, validUntil: sub.validUntil });
  return effectiveStatus(db.shop(shopId));
}
