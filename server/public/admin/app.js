// Provider console: create and manage all shops. Auth is an httpOnly session
// cookie set at /admin/login; a 401 sends us back there.
const $ = (id) => document.getElementById(id);
const LOGIN = '/admin/login';

const api = (p, opt = {}) => fetch('/api/admin' + p, {
  ...opt, headers: { ...(opt.headers || {}), 'Content-Type': 'application/json' },
}).then(async r => {
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) { location.replace(LOGIN); throw new Error('Signed out'); }
  if (!r.ok) throw new Error(d.error || 'Something went wrong.');
  return d;
});

let SHOPS = [];
let lastKey = '';
const details = new Map();   // shopId -> detail payload, for rows that are expanded

// --- add shop ---
function toggleAdd(open) {
  $('addCard').classList.toggle('hidden', !open);
  if (open) { $('newShopBox').classList.add('hidden'); $('newName').focus(); }
}
$('toggleAdd').addEventListener('click', () => toggleAdd($('addCard').classList.contains('hidden')));
$('cancelAdd').addEventListener('click', () => toggleAdd(false));

$('addBtn').addEventListener('click', async () => {
  $('addErr').classList.add('hidden');
  const name = $('newName').value.trim();
  const password = $('newPass').value;
  if (!name) return showErr('addErr', 'Enter a shop name.');
  if (password.length < 8) return showErr('addErr', 'Password must be at least 8 characters.');
  const btn = $('addBtn');
  btn.disabled = true;
  try {
    const { shop } = await api('/shops', { method: 'POST', body: JSON.stringify({
      name, password, feeMonthly: +$('newFee').value || 1500,
    })});
    $('newName').value = ''; $('newPass').value = '';
    const box = $('newShopBox');
    box.innerHTML = `<h3>${UI.icon('checkCircle')} ${esc(shop.name)} created — give these to the shopkeeper</h3>` +
      kv([
        ['Shop ID (for login)', shop.slug],
        ['Dashboard', shop.dashboardUrl],
        ['Customer link (QR)', shop.phoneUrl],
        ['Agent key (config.json)', shop.agentKey],
      ]);
    box.classList.remove('hidden');
    UI.toast('Shop created');
    refresh();
  } catch (e) { showErr('addErr', e.message); }
  finally { btn.disabled = false; }
});

// --- shops ---
async function refresh() {
  try {
    const { shops } = await api('/shops');
    SHOPS = shops;
    renderStats(shops);
    const key = JSON.stringify(shops);
    if (key !== lastKey) { lastKey = key; renderShops(); }
    loadEvents();
  } catch { /* keep the last view */ }
}

function renderStats(shops) {
  $('kShops').textContent = shops.length;
  $('kOnline').textContent = shops.filter(s => s.agentOnline).length;
  $('kDue').textContent = shops.filter(s => s.subscription.status !== 'active').length;
  $('kMrr').textContent = fmt(shops.filter(s => s.subscription.status !== 'suspended')
    .reduce((n, s) => n + (Number(s.subscription.feeMonthly) || 0), 0));
  $('shopCount').textContent = `${shops.length} shop${shops.length === 1 ? '' : 's'}`;
}

const SUB = { active: ['Active', 'good'], grace: ['Payment due', 'warn'], suspended: ['Paused', 'crit'] };

function renderShops() {
  if (!SHOPS.length) {
    $('shops').innerHTML = `<div class="empty">No shops yet. Use <b>Add shop</b> to create the first one.</div>`;
    return;
  }
  $('shops').innerHTML = SHOPS.map(s => {
    const st = s.subscription.status;
    const [label, tone] = SUB[st] || [st, 'neutral'];
    const until = s.subscription.validUntil ? new Date(s.subscription.validUntil).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const sub = st === 'grace' ? `${s.subscription.daysLeft} day(s) left` : until ? (st === 'active' ? 'Paid until ' : 'Expired ') + until : 'Paused manually';
    const id = esc(s.id);
    return `<div class="shop">
      <div class="shop-top">
        <div>
          <div class="shop-title"><b>${esc(s.name)}</b><span class="badge badge-${tone}">${label}</span></div>
          <div class="shop-meta">
            <span class="mono">ID: ${esc(s.slug)}</span>
            <span><span class="agent-dot${s.agentOnline ? ' on' : ''}"></span>${s.agentOnline ? 'Agent online' : 'Agent offline'}${agentVersionText(s)}</span>
            ${s.agentOnline && s.printer?.issue ? `<span class="warn-txt">Printer: ${esc(s.printer.issue)}</span>` : ''}
            <span>${UI.icon('file')}${s.jobs} job${s.jobs === 1 ? '' : 's'}</span>
            <span>${UI.icon('cash')}${fmt(s.subscription.feeMonthly)} PKR / month</span>
            <span>${UI.icon('clock')}${esc(sub)}</span>
            ${s.hasPassword ? '' : '<span class="warn-txt">No password set</span>'}
          </div>
        </div>
        <div class="shop-actions">
          <button class="btn btn-sm" data-a="activate" data-id="${id}">${st === 'suspended' ? 'Reactivate' : 'Mark paid'} +30 days</button>
          ${st === 'suspended' ? '' : `<button class="btn btn-sm btn-danger" data-a="suspend" data-id="${id}">Suspend</button>`}
          <button class="btn btn-sm" data-a="password" data-id="${id}">Set password</button>
          <button class="btn btn-sm" data-a="details" data-id="${id}">${details.has(s.id) ? 'Hide details' : 'Details'}</button>
        </div>
      </div>
      ${details.has(s.id) ? detailHtml(s.id, details.get(s.id)) : ''}
    </div>`;
  }).join('');
}

// The newest agent this server was built for. Older agents still work but
// can't print ID cards / passport photos at exact size or report printer problems.
const LATEST_AGENT = '2.0.0';
function agentVersionText(s) {
  if (s.agentVersion) return ` · v${esc(s.agentVersion)}${verLess(s.agentVersion, LATEST_AGENT) ? ' <span class="warn-txt">(update)</span>' : ''}`;
  return s.agentOnline ? ' · <span class="warn-txt">old version — update</span>' : '';
}
function verLess(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); }
  return false;
}

function detailHtml(id, d) {
  const pc = d.pcLinked
    ? `Linked${d.pcLinkedAt ? ' since ' + new Date(d.pcLinkedAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : ''}${d.agentOs ? ' · ' + d.agentOs : ''}`
    : 'Not linked yet — the first PC that runs the agent with this key gets linked';
  return `<div class="shop-detail">
    ${kv([
      ['Shop ID (for login)', d.slug],
      ['Dashboard', d.dashboardUrl],
      ['Customer link (QR)', d.phoneUrl],
      ['Agent key', d.agentKey],
    ])}
    <p class="pc-line">${UI.icon('lock')} <b>Agent PC:</b> ${esc(pc)}</p>
    <div class="shop-actions">
      <a class="btn btn-sm" href="${esc(d.qrUrl)}" target="_blank" rel="noopener">${UI.icon('qr')} Open QR</a>
      ${d.pcLinked ? `<button class="btn btn-sm" data-a="unlink" data-id="${esc(id)}">${UI.icon('refresh')} Unlink PC</button>` : ''}
      <button class="btn btn-sm" data-a="rotate" data-id="${esc(id)}">${UI.icon('key')} Rotate agent key</button>
      <button class="btn btn-sm btn-danger" data-a="delete" data-id="${esc(id)}">${UI.icon('trash')} Delete shop</button>
    </div>
  </div>`;
}

function kv(rows) {
  return `<dl class="kv">${rows.map(([k, v]) =>
    `<dt>${esc(k)}</dt><dd><code title="${esc(v)}">${esc(v)}</code></dd><button class="btn btn-sm" data-copy="${esc(v)}" type="button">${UI.icon('copy')} Copy</button>`
  ).join('')}</dl>`;
}

// --- actions (event delegation, CSP-safe) ---
document.addEventListener('click', async (e) => {
  const copy = e.target.closest('button[data-copy]');
  if (copy) {
    try { await navigator.clipboard.writeText(copy.dataset.copy); UI.toast('Copied'); }
    catch { UI.alert({ title: 'Copy this', message: copy.dataset.copy }); }
    return;
  }
  const btn = e.target.closest('button[data-a]');
  if (!btn) return;
  const id = btn.dataset.id, a = btn.dataset.a;
  const shop = SHOPS.find(s => s.id === id);
  try {
    if (a === 'suspend') {
      const ok = await UI.confirm({ title: `Suspend ${shop?.name || 'this shop'}?`, message: 'Customers will see "Service paused" and no new jobs are accepted until you reactivate. Their settings and history are kept.', icon: 'warn', okText: 'Suspend', danger: true });
      if (!ok) return;
      await api(`/shops/${id}/suspend`, { method: 'POST' }); UI.toast('Shop suspended', 'warn');
    } else if (a === 'activate') {
      await api(`/shops/${id}/activate`, { method: 'POST', body: JSON.stringify({ extendDays: 30 }) });
      UI.toast('Subscription extended by 30 days');
    } else if (a === 'password') {
      const pw = await UI.prompt({ title: 'Set dashboard password', message: `New password for ${shop?.name || 'this shop'} (at least 8 characters). Their other sessions will be signed out.`, input: { placeholder: 'New password' } });
      if (pw === null) return;
      if (pw.length < 8) { UI.alert({ title: 'Too short', message: 'Password must be at least 8 characters.', icon: 'warn' }); return; }
      await api(`/shops/${id}/password`, { method: 'POST', body: JSON.stringify({ password: pw }) }); UI.toast('Password updated');
    } else if (a === 'details') {
      if (details.has(id)) details.delete(id);
      else details.set(id, await api(`/shops/${id}`));
      renderShops();
      return;
    } else if (a === 'unlink') {
      const ok = await UI.confirm({ title: 'Unlink the agent PC?', message: 'Do this when the shop moves the agent to a new computer. The next PC that runs the agent with this key becomes the linked one.', icon: 'warn', okText: 'Unlink PC' });
      if (!ok) return;
      await api(`/shops/${id}/unlink-pc`, { method: 'POST' });
      details.set(id, await api(`/shops/${id}`));
      renderShops();
      UI.toast('PC unlinked');
      return;
    } else if (a === 'rotate') {
      const ok = await UI.confirm({ title: 'Rotate the agent key?', message: 'The old key stops working immediately and the PC link is cleared. The shop must enter the new key in the agent (run qrprint-agent.exe --setup).', icon: 'warn', okText: 'Rotate key' });
      if (!ok) return;
      await api(`/shops/${id}/rotate-agent-key`, { method: 'POST' });
      details.set(id, await api(`/shops/${id}`));
      renderShops();
      UI.toast('New agent key created');
      return;
    } else if (a === 'delete') {
      const ok = await UI.confirm({ title: `Delete ${shop?.name || 'this shop'}?`, message: 'The shop, its login and its QR link stop working. This cannot be undone.', icon: 'crit', okText: 'Delete shop', danger: true });
      if (!ok) return;
      await api(`/shops/${id}`, { method: 'DELETE' });
      details.delete(id);
      UI.toast('Shop deleted', 'warn');
    } else return;
    lastKey = '';
    refresh();
  } catch (err) { UI.alert({ title: 'Something went wrong', message: err.message, icon: 'crit' }); }
});

// --- activity ---
const EVENTS = {
  'job.created': 'Job created', 'job.paid': 'Paid online', 'job.cash_approved': 'Cash approved',
  'job.cash_auto_approved': 'Cash job printed (auto-approve)', 'job.awaiting_cash': 'Waiting for cash',
  'job.printed': 'Printed', 'job.refunded': 'Refunded', 'job.needs_attention': 'Needs attention',
  'job.reprint': 'Reprint', 'job.cash_cancelled': 'Cash job cancelled', 'job.pay_failed': 'Payment failed',
  'job.stale_giveup': 'Agent stopped responding', 'job.requeued_stale': 'Job re-queued', 'job.approval_expired': 'Cash job expired',
  'shop.created': 'Shop created', 'shop.deleted': 'Shop deleted', 'shop.password_set': 'Password set by provider',
  'shop.password_changed': 'Password changed by shop', 'shop.agent_key_rotated': 'Agent key rotated',
  'subscription.change': 'Subscription changed', 'settings.updated': 'Settings updated',
  'auth.shop_login': 'Shop signed in', 'auth.shop_login_failed': 'Failed sign-in attempt', 'auth.admin_login': 'Provider signed in',
  'safepay.callback': 'Safepay callback',
  'agent.pc_linked': 'Agent linked to a PC', 'agent.other_pc_blocked': 'Agent key used on another PC — blocked',
  'shop.pc_unlinked': 'Agent PC unlinked',
};

async function loadEvents() {
  try {
    const { events } = await api('/events?limit=50');
    const names = Object.fromEntries(SHOPS.map(s => [s.id, s.name]));
    $('events').innerHTML = events.filter(e => e.type !== 'job.claimed').slice(0, 40).map(e => {
      const label = EVENTS[e.type] || e.type.replace(/[._]/g, ' ');
      const shop = e.shopId ? (names[e.shopId] || 'Deleted shop') : '';
      const extra = e.amount ? ` · ${fmt(e.amount)} PKR` : '';
      return `<li><time>${new Date(e.at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time>
        <span>${esc(label)}${extra}${shop ? ` <span class="ev-shop">· ${esc(shop)}</span>` : ''}</span></li>`;
    }).join('') || '<li><span class="muted">No activity yet.</span></li>';
  } catch {}
}

// --- sign out ---
$('logoutBtn').addEventListener('click', async () => {
  try { await fetch('/api/auth/admin/logout', { method: 'POST' }); } catch {}
  location.replace(LOGIN);
});

function showErr(id, msg) { $(id).textContent = msg; $(id).classList.remove('hidden'); }
function fmt(n) { return Number(n || 0).toLocaleString('en-PK', { maximumFractionDigits: 2 }); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 5000);
