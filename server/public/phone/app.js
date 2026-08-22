// Phone flow: config -> upload -> options+price -> pay -> poll status.
const $ = (id) => document.getElementById(id);

// Which shop? The QR encodes ?s=<slug>. Everything is scoped to this shop.
const SHOP = new URLSearchParams(location.search).get('s') || '';
const shopQuery = SHOP ? ('?shop=' + encodeURIComponent(SHOP)) : '';

const api = (p, opt) => fetch('/api/phone' + p, opt).then(async r => {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
});

let CONFIG = null;
let file = null;      // { fileId, pages, sizeMb }
let currentJob = null;
let poll = null;
let PAY_LABEL = 'Pay & Print';
let lastStatus = null;

const state = { copies: 1, color: false, duplex: 'single', pageRange: '', paperSize: 'A4' };

init();

async function init() {
  try {
    CONFIG = await api('/config' + shopQuery);
  } catch {
    show('uploadView');
    $('uploadErr').textContent = 'Could not reach the print server.';
    $('uploadErr').classList.remove('hidden');
    return;
  }
  $('shopName').textContent = CONFIG.shopName;
  $('maxMb').textContent = CONFIG.maxUploadMb;
  $('priceCur').textContent = CONFIG.pricing.currency;

  // Hide options the shop can't do.
  if (!CONFIG.capabilities.color) $('colorOpt').classList.add('hidden');
  if (!CONFIG.capabilities.duplex) $('duplexOpt').classList.add('hidden');
  buildPaperOptions();

  if (!CONFIG.accepting) {
    show('lockedView');
    $('lockedMsg').textContent = CONFIG.subscription.message || 'This shop is temporarily unavailable.';
    return;
  }
  PAY_LABEL = CONFIG.paymentMode === 'cash' ? 'Send to shop' : 'Pay & Print';
  $('payBtn').textContent = PAY_LABEL;
  wire();
  maybeResume();
}

// If we came back from a payment redirect (?job=…&pay=…), show that job's status.
async function maybeResume() {
  const params = new URLSearchParams(location.search);
  const jobId = params.get('job');
  if (!jobId) return;
  try {
    currentJob = await api(`/jobs/${jobId}`);
    show('statusView');
    startPolling();
    history.replaceState(null, '', location.pathname); // clean the URL
  } catch { /* job gone; stay on upload */ }
}

// Show a paper-size chooser only when the shop stocks more than one size.
function buildPaperOptions() {
  const sizes = (CONFIG.capabilities.paperSizes && CONFIG.capabilities.paperSizes.length)
    ? CONFIG.capabilities.paperSizes : ['A4'];
  state.paperSize = sizes[0];
  if (sizes.length > 1) {
    $('paperSeg').innerHTML = sizes
      .map((s, i) => `<button type="button" class="${i === 0 ? 'active' : ''}" data-val="${s}">${s}</button>`)
      .join('');
    $('paperOpt').classList.remove('hidden');
  }
}

function wire() {
  $('fileInput').addEventListener('change', onFile);
  $('changeFile').addEventListener('click', resetToUpload);
  $('againBtn').addEventListener('click', resetToUpload);

  $('copMinus').addEventListener('click', () => setCopies(state.copies - 1));
  $('copPlus').addEventListener('click', () => setCopies(state.copies + 1));
  $('copies').addEventListener('input', () => setCopies(parseInt($('copies').value, 10)));

  document.querySelectorAll('.segmented').forEach(seg => {
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      seg.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const name = seg.dataset.name;
      const val = btn.dataset.val;
      state[name] = name === 'color' ? val === 'true' : val;
      renderPrice();
    });
  });

  $('pageRange').addEventListener('input', () => { state.pageRange = $('pageRange').value; renderPrice(); });
  $('payBtn').addEventListener('click', payAndPrint);
}

async function onFile() {
  const f = $('fileInput').files[0];
  if (!f) return;
  $('uploadErr').classList.add('hidden');

  const n = f.name.toLowerCase();
  const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.rtf', '.txt'];
  const ok = allowed.some(e => n.endsWith(e));
  if (!ok) return uploadError('Please choose a PDF, Word, Excel, PowerPoint, or image file.');
  if (f.size > CONFIG.maxUploadMb * 1048576) return uploadError(`File is too big. Max ${CONFIG.maxUploadMb} MB.`);

  $('uploadingRow').classList.remove('hidden');
  const fd = new FormData();
  fd.append('file', f);
  try {
    file = await api('/upload' + shopQuery, { method: 'POST', body: fd });
  } catch (e) {
    $('uploadingRow').classList.add('hidden');
    return uploadError(e.message);
  }
  $('uploadingRow').classList.add('hidden');

  $('fcName').textContent = f.name;
  $('fcMeta').textContent = `${file.pages} page${file.pages > 1 ? 's' : ''} · ${file.sizeMb} MB`;
  const sizes = (CONFIG.capabilities.paperSizes && CONFIG.capabilities.paperSizes.length) ? CONFIG.capabilities.paperSizes : ['A4'];
  Object.assign(state, { copies: 1, color: false, duplex: 'single', pageRange: '', paperSize: sizes[0] });
  $('copies').value = 1; $('pageRange').value = '';
  resetSegments();
  show('optionsView');
  renderPrice();
}

function uploadError(msg) {
  $('uploadErr').textContent = msg;
  $('uploadErr').classList.remove('hidden');
  $('fileInput').value = '';
}

function setCopies(n) {
  if (Number.isNaN(n)) n = 1;
  state.copies = Math.min(999, Math.max(1, n));
  $('copies').value = state.copies;
  renderPrice();
}

function resetSegments() {
  document.querySelectorAll('.segmented').forEach(seg => {
    const btns = seg.querySelectorAll('button');
    btns.forEach((b, i) => b.classList.toggle('active', i === 0));
  });
}

// Client-side price estimate (server recomputes authoritatively).
function renderPrice() {
  if (!file) return;
  const pages = parseRange(state.pageRange, file.pages);
  const perPage = (state.color && CONFIG.capabilities.color)
    ? CONFIG.pricing.colorPerPage : CONFIG.pricing.bwPerPage;
  const sheets = pages.length * state.copies;
  const amount = sheets * perPage;
  $('priceAmount').textContent = amount;
  $('priceDetail').textContent =
    `${pages.length} page${pages.length > 1 ? 's' : ''} × ${state.copies} cop${state.copies > 1 ? 'ies' : 'y'} · ${state.color ? 'Color' : 'B&W'}`;
}

function parseRange(range, total) {
  const all = () => Array.from({ length: total }, (_, i) => i + 1);
  const t = (range || '').trim();
  if (!t || /^all$/i.test(t)) return all();
  const set = new Set();
  for (const partRaw of t.split(',')) {
    const p = partRaw.trim(); if (!p) continue;
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) { let a = +m[1], b = +m[2]; if (a > b)[a, b] = [b, a]; for (let x = a; x <= b; x++) if (x >= 1 && x <= total) set.add(x); }
    else if (/^\d+$/.test(p)) { const x = +p; if (x >= 1 && x <= total) set.add(x); }
    else return all();
  }
  return set.size ? [...set].sort((a, b) => a - b) : all();
}

async function payAndPrint() {
  $('jobErr').classList.add('hidden');
  $('payBtn').disabled = true;
  $('payBtn').textContent = 'Please wait…';
  try {
    currentJob = await api('/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: file.fileId, options: state, shop: SHOP }),
    });
    const pay = await api(`/jobs/${currentJob.id}/pay`, { method: 'POST' });

    // Redirect provider (JazzCash): auto-submit a form to the hosted checkout.
    if (pay.redirect) {
      const f = document.createElement('form');
      f.method = 'POST';
      f.action = pay.action;
      for (const [k, v] of Object.entries(pay.fields)) {
        const input = document.createElement('input');
        input.type = 'hidden'; input.name = k; input.value = v;
        f.appendChild(input);
      }
      document.body.appendChild(f);
      f.submit();
      return;
    }

    // Redirect provider (Safepay): go to the hosted checkout URL.
    if (pay.redirectUrl) {
      window.location.href = pay.redirectUrl;
      return;
    }

    // Instant provider (mock): already paid.
    currentJob = pay;
    show('statusView');
    startPolling();
  } catch (e) {
    $('jobErr').textContent = e.message;
    $('jobErr').classList.remove('hidden');
  } finally {
    $('payBtn').disabled = false;
    $('payBtn').textContent = PAY_LABEL;
  }
}

function startPolling() {
  renderStatus(currentJob);
  clearInterval(poll);
  poll = setInterval(async () => {
    try {
      const j = await api(`/jobs/${currentJob.id}`);
      currentJob = j;
      renderStatus(j);
      if (['done', 'failed', 'refunded'].includes(j.status)) clearInterval(poll);
    } catch {}
  }, 2000);
}

function renderStatus(j) {
  const map = {
    awaiting_payment: ['⏳', 'Waiting for payment', ''],
    awaiting_approval: ['🧾', 'Pay at the counter', 'Show this screen to the shopkeeper and pay. They will release your print.'],
    queued: ['🖨️', 'In the print queue', 'Your document will print in a moment.'],
    printing: ['🖨️', 'Printing now', 'Please collect your pages at the counter.'],
    done: ['✅', 'Printed!', 'Collect your pages at the counter.'],
    needs_attention: ['⚠️', 'Hold on', 'The shop is attending to the printer. You will not be charged if it can’t print.'],
    failed: ['❌', 'Could not print', 'Sorry — please ask the shopkeeper.'],
    refunded: ['💸', 'Refunded', 'The print failed, so your payment was refunded.'],
  };
  const [icon, title, msg] = map[j.status] || ['⏳', 'Working…', ''];
  $('stIcon').textContent = icon;
  $('stTitle').textContent = title;
  $('stMsg').textContent = msg;

  // Animate + notify only when the status actually changes.
  if (j.status !== lastStatus) {
    const ic = $('stIcon');
    ic.classList.remove('pop'); void ic.offsetWidth; ic.classList.add('pop');
    if (window.UI) {
      if (j.status === 'done') UI.toast('Printed! Collect your pages 🎉', 'good');
      else if (j.status === 'refunded') UI.toast('Refunded — the print could not complete', 'warn');
      else if (j.status === 'failed') UI.toast('Could not print — please ask the shopkeeper', 'crit');
    }
    lastStatus = j.status;
  }
  $('stMeta').innerHTML = `
    <div><span>Document</span><span>${escapeHtml(j.file.originalName)}</span></div>
    <div><span>Pages</span><span>${j.price.totalPagesPrinted} printed</span></div>
    <div><span>Amount</span><span>${j.price.amount} ${j.price.currency}</span></div>
    <div><span>Reference</span><span>${j.payment.ref || '—'}</span></div>`;
}

function resetToUpload() {
  clearInterval(poll);
  file = null; currentJob = null; lastStatus = null;
  $('fileInput').value = '';
  $('uploadErr').classList.add('hidden');
  show('uploadView');
}

function show(view) {
  ['uploadView', 'optionsView', 'statusView', 'lockedView'].forEach(v => $(v).classList.add('hidden'));
  $(view).classList.remove('hidden');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
