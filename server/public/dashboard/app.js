// Shop dashboard logic.
const $ = (id) => document.getElementById(id);
const api = (p, opt) => fetch('/api/dashboard' + p, opt).then(async r => {
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) { showLogin(); const e = new Error(d.error || 'Login required'); e.status = 401; throw e; }
  if (!r.ok) throw new Error(d.error || 'Error');
  return d;
});

let SHOP_SLUG = '';

// Tabs
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  ['live', 'settings', 'qr'].forEach(name => $('tab-' + name).classList.toggle('hidden', name !== t.dataset.tab));
  if (t.dataset.tab === 'settings') loadSettings();
  if (t.dataset.tab === 'qr') loadQr();
}));

// --- LIVE ---
async function refresh() {
  try {
    const o = await api('/overview');
    SHOP_SLUG = o.shop.slug || '';
    $('shopName').textContent = o.shop.name;
    $('modePill').textContent = 'ID: ' + SHOP_SLUG;
    $('kEarn').textContent = o.earningsToday;
    $('kCur').textContent = o.currency;
    $('kPrints').textContent = o.printsToday;
    $('kQueue').textContent = (o.counts.queued || 0) + (o.counts.printing || 0);
    $('kAttn').textContent = o.counts.needs_attention || 0;

    // subscription banner
    const b = $('subBanner');
    if (o.subscription.status === 'active') { b.classList.add('hidden'); }
    else {
      b.className = 'subbanner ' + o.subscription.status;
      b.textContent = (o.subscription.status === 'suspended' ? '🔒 ' : '⚠️ ') + o.subscription.message;
      b.classList.remove('hidden');
    }

    // printer heartbeat
    const pr = $('printerRow');
    if (o.lastHeartbeat) {
      const p = o.printer || {};
      // "Online" only if it checked in within the last 90 seconds.
      const fresh = (Date.now() - new Date(o.lastHeartbeat).getTime()) < 90 * 1000;
      const online = fresh && p.online !== false;
      pr.innerHTML = `<span class="dot" style="background:${online ? 'var(--good)' : 'var(--crit)'}"></span>` +
        (online
          ? 'Printer online'
          : '<b style="color:var(--crit)">Agent offline — start the print agent</b>') +
        (online && p.paper ? ` · paper: ${p.paper}` : '') +
        ` · last seen ${timeago(o.lastHeartbeat)}`;
    } else {
      pr.innerHTML = `<span class="dot" style="background:var(--muted)"></span>Print agent not connected yet.`;
    }

    const { jobs } = await api('/jobs?limit=50');
    renderJobs(jobs);
  } catch (e) { /* keep last view */ }
}

function renderJobs(jobs) {
  const body = $('jobsBody');
  if (!jobs.length) { body.innerHTML = `<tr><td colspan="6" class="empty">No jobs yet.</td></tr>`; return; }
  body.innerHTML = jobs.map(j => {
    const opt = [`${j.options.copies}×`, j.options.color ? 'Color' : 'B&W',
      j.options.duplex === 'mixed' ? '1+duplex' : j.options.duplex,
      j.options.pageRange ? `p.${j.options.pageRange}` : 'all pages'].join(' · ');
    let actions = '';
    if (j.status === 'awaiting_approval') {
      actions += `<button class="rowbtn" data-action="approve" data-id="${j.id}">✓ Approve</button>`;
      actions += `<button class="rowbtn" data-action="cancel" data-id="${j.id}">Cancel</button>`;
    }
    if (['needs_attention', 'failed'].includes(j.status) && j.payment !== 'refunded') {
      if (j.fileAvailable) actions += `<button class="rowbtn" data-action="reprint" data-id="${j.id}">Reprint</button>`;
      if (j.payment === 'paid') actions += `<button class="rowbtn" data-action="refund" data-id="${j.id}">Refund</button>`;
    }
    return `<tr>
      <td>${time(j.createdAt)}</td>
      <td>${esc(j.file.originalName)}<br><small style="color:var(--muted)">${j.file.pages}p</small></td>
      <td><small>${esc(opt)}</small></td>
      <td>${j.amount} ${j.currency}</td>
      <td><span class="badge b-${j.status}">${label(j.status)}</span></td>
      <td>${actions}</td>
    </tr>`;
  }).join('');
}

// Job action buttons (event delegation — no inline handlers, CSP-safe).
$('jobsBody').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.action === 'reprint') reprintJob(id);
  else if (btn.dataset.action === 'refund') refundJob(id);
  else if (btn.dataset.action === 'approve') approveJob(id);
  else if (btn.dataset.action === 'cancel') cancelJob(id);
});

async function approveJob(id) {
  try { await api(`/jobs/${id}/approve`, { method: 'POST' }); refresh(); } catch (e) { alert(e.message); }
}
async function cancelJob(id) {
  if (!confirm('Cancel this job? It will be removed.')) return;
  try { await api(`/jobs/${id}/cancel`, { method: 'POST' }); refresh(); } catch (e) { alert(e.message); }
}

async function reprintJob(id) {
  try { await api(`/jobs/${id}/reprint`, { method: 'POST' }); refresh(); } catch (e) { alert(e.message); }
}
async function refundJob(id) {
  if (!confirm('Refund this job? This cannot be undone.')) return;
  try { const r = await api(`/jobs/${id}/refund`, { method: 'POST' }); refresh(); if (r.manual) alert('Marked refunded. Complete the actual refund in your payment app.'); }
  catch (e) { alert(e.message); }
}

// --- SETTINGS ---
async function loadSettings() {
  const s = await api('/settings');
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
  $('payProvider').value = pa.provider || 'cash';
  $('jcMerchant').value = pa.jazzcash?.merchantId || '';
  $('jcPassword').value = pa.jazzcash?.password || '';
  $('jcSalt').value = pa.jazzcash?.integritySalt || '';
  $('spEnv').value = pa.safepay?.environment || 'sandbox';
  $('spKey').value = pa.safepay?.apiKey || '';
  $('spSecret').value = pa.safepay?.secretKey || '';
  togglePayFields();
}

function togglePayFields() {
  const p = $('payProvider').value;
  $('cashNote').classList.toggle('hidden', p !== 'cash');
  $('jazzcashFields').classList.toggle('hidden', p !== 'jazzcash');
  $('safepayFields').classList.toggle('hidden', p !== 'safepay');
}
$('payProvider').addEventListener('change', togglePayFields);

$('saveSettings').addEventListener('click', async () => {
  const payload = {
    name: $('setName').value,
    mode: $('setMode').value,
    capabilities: {
      color: $('capColor').checked,
      duplex: $('capDuplex').checked,
      maxFileMb: +$('capMax').value,
      paperSizes: [...document.querySelectorAll('.paperSize:checked')].map(cb => cb.value),
    },
    pricing: { bwPerPage: +$('prBw').value, colorPerPage: +$('prColor').value },
    payment_account: {
      provider: $('payProvider').value,
      jazzcash: { merchantId: $('jcMerchant').value, password: $('jcPassword').value, integritySalt: $('jcSalt').value },
      safepay: { environment: $('spEnv').value, apiKey: $('spKey').value, secretKey: $('spSecret').value },
    },
  };
  try {
    await api('/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    $('saveMsg').textContent = 'Saved ✓';
    setTimeout(() => $('saveMsg').textContent = '', 2500);
    refresh();
  } catch (e) { $('saveMsg').style.color = 'var(--crit)'; $('saveMsg').textContent = e.message; }
});

// --- change password ---
$('changePwBtn').addEventListener('click', async () => {
  const cur = $('pwCurrent').value, nw = $('pwNew').value, cf = $('pwConfirm').value;
  const msg = $('pwMsg');
  msg.style.color = 'var(--crit)';
  if (nw.length < 4) { msg.textContent = 'New password must be at least 4 characters.'; return; }
  if (nw !== cf) { msg.textContent = 'New passwords do not match.'; return; }
  try {
    await api('/change-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: cur, newPassword: nw }),
    });
    msg.style.color = 'var(--good)';
    msg.textContent = 'Password updated ✓';
    $('pwCurrent').value = $('pwNew').value = $('pwConfirm').value = '';
    setTimeout(() => msg.textContent = '', 3000);
  } catch (e) { msg.style.color = 'var(--crit)'; msg.textContent = e.message; }
});

// --- QR ---
async function loadQr() {
  const q = SHOP_SLUG ? ('shop=' + encodeURIComponent(SHOP_SLUG) + '&') : '';
  $('qrImg').src = `/api/qr?${q}ts=` + Date.now();
  try { const { url } = await fetch(`/api/qr/target?${q}`).then(r => r.json()); $('qrUrl').textContent = url; } catch {}
}

// --- helpers ---
function label(s) { return ({ needs_attention: 'needs attention', awaiting_payment: 'unpaid', awaiting_approval: 'awaiting cash' }[s] || s).replace('_', ' '); }
function time(iso) { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function timeago(iso) { const s = (Date.now() - new Date(iso)) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; return Math.floor(s / 3600) + 'h ago'; }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// --- auth / boot ---
function showLogin() {
  $('loginGate').classList.remove('hidden');
  $('shell').classList.add('hidden');
}
function hideLogin() {
  $('loginGate').classList.add('hidden');
  $('shell').classList.remove('hidden');
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginErr').classList.add('hidden');
  try {
    const r = await fetch('/api/auth/shop/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopId: $('loginShop').value.trim(), password: $('loginPw').value }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Login failed');
    $('loginPw').value = '';
    hideLogin();
    boot();
  } catch (err) {
    $('loginErr').textContent = err.message;
    $('loginErr').classList.remove('hidden');
  }
});

$('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.reload();
});

$('printQr').addEventListener('click', () => window.print());

let started = false;
function boot() {
  if (started) return;
  started = true;
  refresh();
  setInterval(refresh, 3000);
}

// Decide whether to show the login gate first.
(async () => {
  try {
    const me = await fetch('/api/auth/me').then(r => r.json());
    if (!me.dashboardAuthRequired) { hideLogin(); boot(); return; }
    // Auth required: probe one guarded call. If it works, we're already in.
    const r = await fetch('/api/dashboard/overview');
    if (r.ok) { hideLogin(); boot(); } else { showLogin(); }
  } catch { showLogin(); }
})();
