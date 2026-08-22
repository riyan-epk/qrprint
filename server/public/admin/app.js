// Provider console: create and manage all shops. The admin key is kept only in
// memory for this tab and sent as a header on every call.
const $ = (id) => document.getElementById(id);
let KEY = '';

const api = (p, opt = {}) => fetch('/api/admin' + p, {
  ...opt, headers: { ...(opt.headers || {}), 'x-admin-key': KEY, 'Content-Type': 'application/json' },
}).then(async r => {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Error');
  return d;
});

// --- login ---
$('loginBtn').addEventListener('click', async () => {
  KEY = $('key').value.trim();
  $('loginErr').classList.add('hidden');
  try {
    await api('/shops');
    $('loginPanel').classList.add('hidden');
    $('console').classList.remove('hidden');
    refresh();
    setInterval(refresh, 5000);
  } catch (e) {
    $('loginErr').textContent = e.message;
    $('loginErr').classList.remove('hidden');
  }
});
$('key').addEventListener('keydown', e => { if (e.key === 'Enter') $('loginBtn').click(); });

// --- add shop ---
$('addBtn').addEventListener('click', async () => {
  $('addErr').classList.add('hidden');
  const name = $('newName').value.trim();
  if (!name) { showErr('addErr', 'Enter a shop name.'); return; }
  try {
    const { shop } = await api('/shops', { method: 'POST', body: JSON.stringify({
      name, password: $('newPass').value, feeMonthly: +$('newFee').value || 1500,
    })});
    $('newName').value = ''; $('newPass').value = '';
    const box = $('newShopBox');
    box.innerHTML = `<div><b>✅ Shop created — give these to the shopkeeper:</b></div>
      <div>Shop ID (for dashboard login): <code>${shop.slug}</code></div>
      <div>Dashboard: <code>${shop.dashboardUrl}</code></div>
      <div>Their QR / customer link: <code>${shop.phoneUrl}</code></div>
      <div>Agent key (for their print agent's config.json): <code>${shop.agentKey}</code></div>`;
    box.classList.remove('hidden');
    refresh();
    if (window.UI) UI.toast('Shop created', 'good');
  } catch (e) { showErr('addErr', e.message); }
});

// --- render shops ---
async function refresh() {
  try {
    const { shops } = await api('/shops');
    $('shopCount').textContent = shops.length;
    $('shops').innerHTML = shops.map(renderShop).join('') || '<p style="color:var(--muted)">No shops yet.</p>';
    loadEvents();
  } catch (e) { /* keep view */ }
}

function renderShop(s) {
  const st = s.subscription.status;
  const online = s.agentOnline;
  return `<div class="shop" data-id="${s.id}">
    <div class="shop-top">
      <div>
        <span class="shop-name">${esc(s.name)}</span>
        <span class="pill ${st}">${st}</span>
        <div class="shop-id">ID: ${s.slug} · fee ${s.subscription.feeMonthly} PKR/mo</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:.8rem"><span class="dot" style="background:${online ? 'var(--good)' : 'var(--muted)'}"></span>${online ? 'agent online' : 'agent offline'}</div>
        <div class="shop-id">${s.jobs} jobs</div>
      </div>
    </div>
    <div class="shop-meta">Customer link: <a href="${s.phoneUrl}" target="_blank" rel="noopener">${s.phoneUrl}</a>${s.hasPassword ? '' : ' · <span style="color:var(--warn)">no password set</span>'}</div>
    <div class="shop-actions">
      ${st === 'suspended'
        ? `<button class="btn good" data-a="activate" data-id="${s.id}">Reactivate +30d</button>`
        : `<button class="btn crit" data-a="suspend" data-id="${s.id}">Suspend</button>
           <button class="btn good" data-a="activate" data-id="${s.id}">Mark paid +30d</button>`}
      <button class="btn" data-a="password" data-id="${s.id}">Set password</button>
      <button class="btn" data-a="details" data-id="${s.id}">Details</button>
      <button class="btn" data-a="delete" data-id="${s.id}">Delete</button>
    </div>
    <div class="detail hidden" id="det-${s.id}"></div>
  </div>`;
}

// --- shop actions (event delegation, CSP-safe) ---
$('shops').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-a]');
  if (!btn) return;
  const id = btn.dataset.id, a = btn.dataset.a;
  try {
    if (a === 'suspend') {
      const ok = await UI.confirm({ title: 'Suspend this shop?', message: 'Their self-service stops accepting new jobs until you reactivate.', icon: 'warn', okText: 'Suspend', danger: true });
      if (!ok) return;
      await api(`/shops/${id}/suspend`, { method: 'POST' }); UI.toast('Shop suspended', 'warn'); refresh();
    }
    else if (a === 'activate') { await api(`/shops/${id}/activate`, { method: 'POST', body: JSON.stringify({ extendDays: 30 }) }); UI.toast('Reactivated · +30 days', 'good'); refresh(); }
    else if (a === 'password') {
      const pw = await UI.prompt({ title: 'Set dashboard password', message: 'Give this to the shopkeeper (min 4 characters).', input: { placeholder: 'New password' } });
      if (pw && pw.length >= 4) { await api(`/shops/${id}/password`, { method: 'POST', body: JSON.stringify({ password: pw }) }); UI.toast('Password updated', 'good'); refresh(); }
      else if (pw !== null) UI.alert({ title: 'Too short', message: 'Password must be at least 4 characters.', icon: 'warn' });
    }
    else if (a === 'delete') {
      const ok = await UI.confirm({ title: 'Delete this shop?', message: 'This cannot be undone.', icon: 'crit', okText: 'Delete', danger: true });
      if (ok) { await api(`/shops/${id}`, { method: 'DELETE' }); UI.toast('Shop deleted', 'warn'); refresh(); }
    }
    else if (a === 'details') {
      const d = await api(`/shops/${id}`);
      const box = $('det-' + id);
      box.innerHTML = `
        <div>Shop ID (dashboard login): <code>${d.slug}</code></div>
        <div>Dashboard: <code>${d.dashboardUrl}</code></div>
        <div>Customer link: <code>${d.phoneUrl}</code></div>
        <div>Agent key: <code>${d.agentKey}</code>
          <button class="btn" data-a="rotate" data-id="${id}">Rotate key</button></div>
        <div>QR: <a href="${d.qrUrl}" target="_blank" rel="noopener">open QR image</a></div>`;
      box.classList.toggle('hidden');
    }
    else if (a === 'rotate') {
      const ok = await UI.confirm({ title: 'Rotate the agent key?', message: 'The old key stops working — you must update the shop’s agent config with the new key.', icon: 'warn', okText: 'Rotate' });
      if (ok) {
        const r = await api(`/shops/${id}/rotate-agent-key`, { method: 'POST' });
        await UI.alert({ title: 'New agent key', message: r.agentKey, icon: 'good', okText: 'Copy is manual — OK' });
        refresh();
      }
    }
  } catch (err) { UI.alert({ title: 'Something went wrong', message: err.message, icon: 'crit' }); }
});

async function loadEvents() {
  try {
    const { events } = await api('/events?limit=40');
    $('events').innerHTML = events.map(e =>
      `<div>${new Date(e.at).toLocaleString()} · ${e.type}${e.slug ? ' · ' + e.slug : ''}${e.shopId ? ' · ' + e.shopId : ''}${e.amount ? ' · ' + e.amount : ''}</div>`
    ).join('') || '<div>No activity yet.</div>';
  } catch {}
}

function showErr(id, msg) { $(id).textContent = msg; $(id).classList.remove('hidden'); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
