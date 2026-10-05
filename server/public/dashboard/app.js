// Shop dashboard logic. The server only serves this page to a signed-in shop;
// if the session ends (expired, password changed elsewhere) any API call
// returns 401 and we go back to the login page.
const $ = (id) => document.getElementById(id);
const LOGIN = '/dashboard/login';

const api = (p, opt) => fetch('/api/dashboard' + p, opt).then(async r => {
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) { location.replace(LOGIN); throw new Error('Signed out'); }
  if (!r.ok) throw new Error(d.error || 'Something went wrong.');
  return d;
});
const postJson = (p, body) => api(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});

let SHOP_SLUG = '';
let FEATURES = { jazzcash: false };
let SAVED_PROVIDER = 'cash';

// --- tabs ---
const TABS = ['overview', 'settings', 'qr'];
function showTab(name) {
  if (!TABS.includes(name)) name = 'overview';
  document.querySelectorAll('.app-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  TABS.forEach(t => $('tab-' + t).classList.toggle('hidden', t !== name));
  if (name === 'settings') loadSettings();
  if (name === 'qr') loadQr();
  if (location.hash.slice(1) !== name) history.replaceState(null, '', name === 'overview' ? location.pathname : '#' + name);
}
document.querySelectorAll('.app-tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

// --- overview (polled) ---
let lastJobsKey = '';
let busy = false;

async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const [o, { jobs }] = await Promise.all([api('/overview'), api('/jobs?limit=50')]);
    renderOverview(o);
    const key = JSON.stringify(jobs);
    if (key !== lastJobsKey) { lastJobsKey = key; renderJobs(jobs); }
    $('liveState').classList.remove('stale');
    $('liveState').lastChild.textContent = 'Live';
  } catch (e) {
    $('liveState').classList.add('stale');
    $('liveState').lastChild.textContent = 'Reconnecting…';
  } finally {
    busy = false;
  }
}

function renderOverview(o) {
  SHOP_SLUG = o.shop.slug || '';
  $('shopName').textContent = o.shop.name;
  $('shopSlug').textContent = SHOP_SLUG ? 'ID: ' + SHOP_SLUG : '';
  $('kEarn').textContent = fmt(o.earningsToday);
  $('kCur').textContent = o.currency;
  $('kPrints').textContent = o.printsToday;
  $('kQueue').textContent = (o.counts.queued || 0) + (o.counts.printing || 0) + (o.counts.awaiting_approval || 0);
  const attn = o.counts.needs_attention || 0;
  $('kAttn').textContent = attn;
  $('kAttnCard').classList.toggle('attn', attn > 0);

  // subscription
  const b = $('subBanner');
  const st = o.subscription.status;
  if (st === 'active') b.classList.add('hidden');
  else {
    b.className = 'alert ' + (st === 'suspended' ? 'alert-crit' : 'alert-warn');
    b.innerHTML = UI.icon(st === 'suspended' ? 'lock' : 'alert') +
      `<div><strong>${st === 'suspended' ? 'Service paused' : 'Payment due'}</strong> — ${esc(o.subscription.message)}</div>`;
  }

  // printer agent heartbeat: "online" only if it checked in within 90 s
  const pill = $('printerPill');
  let text;
  if (!o.lastHeartbeat) {
    pill.className = 'printer-pill';
    text = 'Print agent not connected';
  } else {
    const p = o.printer || {};
    const fresh = (Date.now() - new Date(o.lastHeartbeat).getTime()) < 90 * 1000;
    const online = fresh && p.online !== false;
    // Agent v2 also reports printer problems (no paper, jam, …) and its name.
    pill.className = 'printer-pill ' + (!online ? 'offline' : p.issue ? 'warn' : 'online');
    text = !fresh ? 'Print agent offline · seen ' + timeago(o.lastHeartbeat)
      : p.online === false ? 'Printer offline' + (p.name ? ' · ' + p.name : '')
      : p.issue ? 'Printer: ' + p.issue
      : 'Printer online' + (p.name ? ' · ' + p.name : '');
  }
  $('printerText').textContent = text;
  pill.title = text;
}

const STATUS = {
  done: ['Printed', 'good'],
  queued: ['Queued', 'info'],
  printing: ['Printing', 'info'],
  needs_attention: ['Needs attention', 'warn'],
  failed: ['Failed', 'crit'],
  refunded: ['Refunded', 'neutral'],
  awaiting_payment: ['Unpaid', 'neutral'],
  awaiting_approval: ['Awaiting cash', 'warn'],
};

function renderJobs(jobs) {
  const body = $('jobsBody');
  if (!jobs.length) {
    body.innerHTML = `<tr><td colspan="6" class="empty"><div class="empty-ic">${UI.icon('file')}</div>
      <b>No jobs yet</b>Jobs appear here as soon as a customer sends a document.</td></tr>`;
    return;
  }
  body.innerHTML = jobs.map(j => {
    const o = j.options;
    const sides = j.kind && j.kind !== 'doc' ? '' : o.duplex === 'mixed' ? '1st single, rest double' : o.duplex === 'double' ? 'Double-sided' : 'Single-sided';
    const opt = [`${o.copies} ${o.copies > 1 ? 'copies' : 'copy'}`, o.color ? 'Colour' : 'B&W', sides,
      o.pageRange ? `pages ${o.pageRange}` : ''].filter(Boolean).join(' · ');
    const [label, tone] = STATUS[j.status] || [j.status, 'neutral'];
    let actions = '';
    if (j.status === 'awaiting_approval') {
      actions += `<button class="btn btn-sm btn-primary" data-action="approve" data-id="${esc(j.id)}">${UI.icon('check')} Approve</button>`;
      actions += `<button class="btn btn-sm" data-action="cancel" data-id="${esc(j.id)}">Cancel</button>`;
    }
    if (['needs_attention', 'failed'].includes(j.status) && j.payment !== 'refunded') {
      if (j.fileAvailable) actions += `<button class="btn btn-sm" data-action="reprint" data-id="${esc(j.id)}">${UI.icon('refresh')} Reprint</button>`;
      if (j.payment === 'paid') actions += `<button class="btn btn-sm btn-danger" data-action="refund" data-id="${esc(j.id)}">Refund</button>`;
    }
    const due = j.payAtCounter && j.payment === 'paid' && j.status !== 'refunded' ? '<span class="due">cash due</span>' : '';
    return `<tr>
      <td class="time" data-label="Time">${time(j.createdAt)}</td>
      <td class="doc-cell"><div class="doc" title="${esc(docTitle(j))}">${esc(j.file.originalName)}</div><div class="sub">${j.file.pages} page${j.file.pages > 1 ? 's' : ''}${j.file.items && j.file.items.length > 1 ? ` · ${j.file.items.length} files` : ''}${KIND[j.kind] ? ' · ' + KIND[j.kind] : ''}${j.error && j.status !== 'refunded' ? ' · ' + esc(reason(j.error)) : ''}</div></td>
      <td class="sub" data-label="Options">${esc(opt)}</td>
      <td class="amt" data-label="Amount">${fmt(j.amount)} ${esc(j.currency)}${due}</td>
      <td data-label="Status"><span class="badge badge-${tone}">${label}</span></td>
      <td class="actions">${actions}</td>
    </tr>`;
  }).join('');
}

const KIND = { idcard: 'actual size', passport: 'actual size' };
// Hovering a multi-file job lists its files.
function docTitle(j) {
  const it = j.file.items;
  return it && it.length > 1 ? it.map(f => `${f.name} (${f.pages}p)`).join(', ') : j.file.originalName;
}

// Job action buttons (event delegation — no inline handlers, CSP-safe).
$('jobsBody').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { id, action } = btn.dataset;
  ({ approve: approveJob, cancel: cancelJob, reprint: reprintJob, refund: refundJob })[action]?.(id, btn);
});

async function jobAction(btn, fn) {
  btn.disabled = true;
  try { await fn(); lastJobsKey = ''; await refresh(); }
  finally { btn.disabled = false; }
}

function approveJob(id, btn) {
  return jobAction(btn, async () => {
    try { await api(`/jobs/${id}/approve`, { method: 'POST' }); UI.toast('Approved — printing now'); }
    catch (e) { UI.alert({ title: 'Could not approve', message: e.message, icon: 'crit' }); }
  });
}
async function cancelJob(id, btn) {
  const ok = await UI.confirm({ title: 'Cancel this job?', message: 'It will be removed from the queue and the file deleted.', icon: 'warn', okText: 'Cancel job', cancelText: 'Keep', danger: true });
  if (!ok) return;
  return jobAction(btn, async () => {
    try { await api(`/jobs/${id}/cancel`, { method: 'POST' }); UI.toast('Job cancelled', 'warn'); }
    catch (e) { UI.alert({ title: 'Could not cancel', message: e.message, icon: 'crit' }); }
  });
}
function reprintJob(id, btn) {
  return jobAction(btn, async () => {
    try { await api(`/jobs/${id}/reprint`, { method: 'POST' }); UI.toast('Sent to the printer again'); }
    catch (e) { UI.alert({ title: 'Could not reprint', message: e.message, icon: 'crit' }); }
  });
}
async function refundJob(id, btn) {
  const ok = await UI.confirm({ title: 'Refund this job?', message: 'The job is marked refunded and can no longer be reprinted. This cannot be undone.', icon: 'warn', okText: 'Refund', danger: true });
  if (!ok) return;
  return jobAction(btn, async () => {
    try {
      const r = await api(`/jobs/${id}/refund`, { method: 'POST' });
      if (r.manual) UI.alert({ title: 'Marked as refunded', message: 'Now return the money to the customer (cash, or from your payment account) to complete the refund.', icon: 'good' });
      else UI.toast('Refunded');
    } catch (e) { UI.alert({ title: 'Could not refund', message: e.message, icon: 'crit' }); }
  });
}

// --- settings ---
async function loadSettings() {
  let s;
  try { s = await api('/settings'); } catch (e) { return; }
  FEATURES = s.features || FEATURES;
  $('setName').value = s.name;
  $('setMode').value = s.mode;
  $('capColor').checked = s.capabilities.color;
  $('capDuplex').checked = s.capabilities.duplex;
  $('capMax').value = s.capabilities.maxFileMb;
  document.querySelectorAll('.paperSize').forEach(cb => {
    cb.checked = (s.capabilities.paperSizes || ['A4']).includes(cb.value);
  });
  $('prBw').value = s.pricing.bwPerPage;
  $('prColor').value = s.pricing.colorPerPage;

  const pa = s.payment_account || {};
  SAVED_PROVIDER = pa.provider || 'cash';
  // JazzCash is selectable only once it's switched on server-side (or if this
  // shop already uses it).
  const jcAvailable = FEATURES.jazzcash || SAVED_PROVIDER === 'jazzcash';
  const jcRadio = document.querySelector('input[name="payProvider"][value="jazzcash"]');
  jcRadio.disabled = !jcAvailable;
  $('jcOpt').classList.toggle('disabled', !jcAvailable);
  $('jcSoon').classList.toggle('hidden', FEATURES.jazzcash);

  const radio = document.querySelector(`input[name="payProvider"][value="${SAVED_PROVIDER}"]`);
  if (radio) radio.checked = true;
  $('cashAuto').checked = !!pa.autoApprove;
  $('spEnv').value = pa.safepay?.environment || 'sandbox';
  $('spKey').value = pa.safepay?.apiKey || '';
  $('spSecret').value = '';
  $('spSecret').placeholder = pa.safepay?.hasSecretKey ? 'Saved — leave blank to keep' : '';
  $('jcMerchant').value = pa.jazzcash?.merchantId || '';
  $('jcPassword').value = '';
  $('jcPassword').placeholder = pa.jazzcash?.hasPassword ? 'Saved — leave blank to keep' : '';
  $('jcSalt').value = '';
  $('jcSalt').placeholder = pa.jazzcash?.hasIntegritySalt ? 'Saved — leave blank to keep' : '';
  togglePayFields();
}

function provider() {
  return document.querySelector('input[name="payProvider"]:checked')?.value || 'cash';
}

function togglePayFields() {
  const p = provider();
  document.querySelectorAll('.pay-opt').forEach(o => o.classList.toggle('selected', o.querySelector('input').checked));
  $('cashFields').classList.toggle('hidden', p !== 'cash');
  $('cashNoteManual').classList.toggle('hidden', $('cashAuto').checked);
  $('cashNoteAuto').classList.toggle('hidden', !$('cashAuto').checked);
  $('safepayFields').classList.toggle('hidden', p !== 'safepay');
  $('jazzcashFields').classList.toggle('hidden', p !== 'jazzcash');
}
document.querySelectorAll('input[name="payProvider"]').forEach(r => r.addEventListener('change', togglePayFields));
$('cashAuto').addEventListener('change', togglePayFields);

$('saveSettings').addEventListener('click', async () => {
  const msg = $('saveMsg');
  const paperSizes = [...document.querySelectorAll('.paperSize:checked')].map(cb => cb.value);
  if (!paperSizes.length) { setMsg(msg, 'Choose at least one paper size.', true); return; }
  if (provider() === 'safepay' && !$('spKey').value.trim()) {
    setMsg(msg, 'Enter your Safepay API key.', true); $('spKey').focus(); return;
  }
  const payload = {
    name: $('setName').value,
    mode: $('setMode').value,
    capabilities: {
      color: $('capColor').checked,
      duplex: $('capDuplex').checked,
      maxFileMb: +$('capMax').value,
      paperSizes,
    },
    pricing: { bwPerPage: +$('prBw').value, colorPerPage: +$('prColor').value },
    payment_account: {
      provider: provider(),
      autoApprove: $('cashAuto').checked,
      jazzcash: { merchantId: $('jcMerchant').value, password: $('jcPassword').value, integritySalt: $('jcSalt').value },
      safepay: { environment: $('spEnv').value, apiKey: $('spKey').value, secretKey: $('spSecret').value },
    },
  };
  const btn = $('saveSettings');
  btn.disabled = true;
  try {
    await postJson('/settings', payload);
    setMsg(msg, 'Changes saved');
    UI.toast('Settings saved');
    loadSettings();
    refresh();
  } catch (e) { setMsg(msg, e.message, true); }
  finally { btn.disabled = false; }
});

// --- change password ---
$('changePwBtn').addEventListener('click', async () => {
  const cur = $('pwCurrent').value, nw = $('pwNew').value, cf = $('pwConfirm').value;
  const msg = $('pwMsg');
  if (nw.length < 8) { setMsg(msg, 'New password must be at least 8 characters.', true); return; }
  if (nw !== cf) { setMsg(msg, 'New passwords do not match.', true); return; }
  const btn = $('changePwBtn');
  btn.disabled = true;
  try {
    await postJson('/change-password', { currentPassword: cur, newPassword: nw });
    setMsg(msg, 'Password updated');
    UI.toast('Password updated');
    $('pwCurrent').value = $('pwNew').value = $('pwConfirm').value = '';
  } catch (e) { setMsg(msg, e.message, true); }
  finally { btn.disabled = false; }
});

function setMsg(el, text, isErr) {
  el.textContent = text;
  el.classList.toggle('err', !!isErr);
  clearTimeout(el._t);
  if (!isErr) el._t = setTimeout(() => { el.textContent = ''; }, 3000);
}

// --- QR ---
async function loadQr() {
  await ready; // need this shop's slug first
  const q = SHOP_SLUG ? 'shop=' + encodeURIComponent(SHOP_SLUG) : '';
  $('qrImg').src = `/api/qr?${q}`;
  $('qrShop').textContent = $('shopName').textContent;
  try {
    const { url } = await fetch(`/api/qr/target?${q}`).then(r => r.json());
    $('qrUrl').textContent = url;
  } catch {}
}
$('copyUrl').addEventListener('click', async () => {
  const url = $('qrUrl').textContent;
  try { await navigator.clipboard.writeText(url); UI.toast('Link copied'); }
  catch { UI.alert({ title: 'Your customer link', message: url }); }
});
$('printQr').addEventListener('click', () => window.print());

// --- helpers ---
const REASONS = { paper_out: 'out of paper', jam: 'paper jam', offline: 'printer offline', no_response: 'printer agent stopped', print_error: 'print error', refunded_by_shop: 'refunded' };
function reason(r) { return REASONS[r] || String(r).replace(/_/g, ' '); }
function fmt(n) { return Number(n || 0).toLocaleString('en-PK', { maximumFractionDigits: 2 }); }
function time(iso) {
  const d = new Date(iso);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? t : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ', ' + t;
}
function timeago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// --- sign out ---
$('logoutBtn').addEventListener('click', async () => {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
  location.replace(LOGIN);
});

// --- boot ---
$('todayLabel').textContent = new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
const ready = refresh();
showTab(location.hash.slice(1));
// Poll every 3 s while the tab is visible; catch up immediately when it returns.
setInterval(() => { if (!document.hidden) refresh(); }, 3000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
