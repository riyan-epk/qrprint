// Phone flow: choose (documents / ID card / passport photos) -> files + options
// + price -> pay -> live status.
const $ = (id) => document.getElementById(id);

// Which shop? The QR encodes ?s=<slug>. Everything is scoped to this shop.
const SHOP = new URLSearchParams(location.search).get('s') || '';
const shopQuery = SHOP ? ('?shop=' + encodeURIComponent(SHOP)) : '';
const HOME_URL = location.pathname + (SHOP ? '?s=' + encodeURIComponent(SHOP) : '');
const JOB_KEY = 'qrp_job_' + SHOP;   // lets a refresh bring the customer back to their job

const api = (p, opt) => fetch('/api/phone' + p, opt).then(async r => {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
});

const OFFICE = ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf', '.txt'];
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif', '.bmp'];
const FINAL = ['done', 'failed', 'refunded'];
const MAX_FILES = 20;
const PARALLEL_UPLOADS = 3;
// Crop shapes, output at 300 dpi.
const CARD = { aspect: 85.6 / 54, w: 1012, h: 638 };
const PHOTO = { aspect: 35 / 45, w: 413, h: 531 };
const SLOT_NAME = { front: 'Front side', back: 'Back side', photo: 'Your photo' };

let CONFIG = null;
let mode = 'doc';            // 'doc' | 'idcard' | 'passport'
let items = [];              // documents: { key, name, type, file, status, progress, fileId, pages, sel, thumb, error }
let seq = 0;
let activeUploads = 0;
const slots = { front: null, back: null, photo: null };   // { src: File, blob: Blob, url }
let photoCount = 8;

let currentJob = null;
let poll = null;
let PAY_LABEL = 'Pay & print';
let lastStatus = null;
let payIssue = '';           // 'cancelled' | 'failed' after returning from checkout
let waitingSince = 0;

const state = { copies: 1, color: false, duplex: 'single', paperSize: 'A4' };

init();

async function init() {
  try {
    CONFIG = await api('/config' + shopQuery);
  } catch {
    show('startView');
    showErr('startErr', 'Could not reach the print server. Check your internet connection and try again.');
    return;
  }
  $('shopName').textContent = CONFIG.shopName;
  document.title = 'Print at ' + CONFIG.shopName;
  $('maxMb').textContent = CONFIG.maxUploadMb;
  $('priceCur').textContent = CONFIG.pricing.currency;
  if (!CONFIG.capabilities.color) $('colorOpt').classList.add('hidden');
  buildPaperOptions();

  if (!CONFIG.accepting) {
    show('lockedView');
    $('steps').classList.add('hidden');
    $('lockedMsg').textContent = CONFIG.subscription.message || 'This shop is temporarily unavailable.';
    return;
  }
  PAY_LABEL = CONFIG.paymentMode !== 'cash' ? 'Pay & print'
    : CONFIG.cashAutoApprove ? 'Print now' : 'Send to shop';
  $('payBtn').textContent = PAY_LABEL;
  wire();
  maybeResume();
}

// Back from a payment page (?job=…&pay=…), or a refresh mid-job: show that job.
async function maybeResume() {
  const params = new URLSearchParams(location.search);
  let jobId = params.get('job');
  payIssue = ['cancelled', 'failed'].includes(params.get('pay')) ? params.get('pay') : '';
  if (jobId) store('set', jobId); else jobId = store('get');
  history.replaceState(null, '', HOME_URL); // clean the URL, keep the shop
  if (!jobId) return;
  try {
    currentJob = await api(`/jobs/${encodeURIComponent(jobId)}`);
    if (FINAL.includes(currentJob.status) && !params.get('job')) { store('clear'); return; }
    show('statusView');
    startPolling();
  } catch { store('clear'); }
}

function buildPaperOptions() {
  const sizes = paperSizes();
  state.paperSize = sizes[0];
  if (sizes.length > 1) {
    $('paperSeg').innerHTML = sizes
      .map((s, i) => `<button type="button" class="${i === 0 ? 'active' : ''}" data-val="${esc(s)}">${esc(s)}</button>`)
      .join('');
    $('paperOpt').classList.remove('hidden');
  }
}
function paperSizes() {
  const s = CONFIG.capabilities.paperSizes;
  return s && s.length ? s : ['A4'];
}

function wire() {
  $('svcDocs').addEventListener('click', () => { $('docInput').value = ''; $('docInput').click(); });
  $('svcId').addEventListener('click', () => startLayout('idcard'));
  $('svcPhoto').addEventListener('click', () => startLayout('passport'));
  $('docInput').addEventListener('change', () => addFiles($('docInput').files));
  $('addMore').addEventListener('click', () => { $('docInput').value = ''; $('docInput').click(); });
  $('photoInput').addEventListener('change', onPhotoChosen);
  $('backToStart').addEventListener('click', backToStart);
  $('againBtn').addEventListener('click', resetToStart);
  $('retryPay').addEventListener('click', retryPayment);
  $('payBtn').addEventListener('click', payAndPrint);
  $('fileList').addEventListener('click', onFileAction);
  ['front', 'back', 'photo'].forEach(name => $('slot-' + name).addEventListener('click', onSlotAction));

  // Drag & drop documents anywhere on the page (when opened on a computer).
  const sheet = $('sheet');
  const canDrop = () => !$('startView').classList.contains('hidden') || (!$('optionsView').classList.contains('hidden') && mode === 'doc');
  document.addEventListener('dragover', (e) => { if (!canDrop()) return; e.preventDefault(); sheet.classList.add('drag'); });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) sheet.classList.remove('drag'); });
  document.addEventListener('drop', (e) => {
    sheet.classList.remove('drag');
    if (!canDrop()) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  });

  $('copMinus').addEventListener('click', () => setCopies(state.copies - 1));
  $('copPlus').addEventListener('click', () => setCopies(state.copies + 1));
  $('copies').addEventListener('input', () => setCopies(parseInt($('copies').value, 10), true));
  $('copies').addEventListener('blur', () => setCopies(parseInt($('copies').value, 10)));

  document.querySelectorAll('.segmented').forEach(seg => {
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      seg.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const name = seg.dataset.name, val = btn.dataset.val;
      if (name === 'photoCount') photoCount = Number(val);
      else state[name] = name === 'color' ? val === 'true' : val;
      renderPrice();
    });
  });

  wireEditor();
  wireCropper();
}

// =============================================================================
// Modes
// =============================================================================

function startLayout(kind) {
  mode = kind;
  // Photos look best in colour; ID card copies keep whatever was chosen.
  if (kind === 'passport' && CONFIG.capabilities.color) setSegment('color', 'true');
  show('optionsView');
  renderMode();
  renderSlots();
  renderPrice();
}

function renderMode() {
  $('docsPanel').classList.toggle('hidden', mode !== 'doc');
  $('idPanel').classList.toggle('hidden', mode !== 'idcard');
  $('photoPanel').classList.toggle('hidden', mode !== 'passport');
  $('duplexOpt').classList.toggle('hidden', mode !== 'doc' || !CONFIG.capabilities.duplex);
  $('copiesLabel').textContent = mode === 'passport' ? 'Sheets' : 'Copies';
}

function setSegment(name, val) {
  const seg = document.querySelector(`.segmented[data-name="${name}"]`);
  seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.val === String(val)));
  state[name] = name === 'color' ? String(val) === 'true' : val;
}

async function backToStart() {
  const hasWork = items.length || slots.front || slots.back || slots.photo;
  if (hasWork) {
    const ok = await UI.confirm({ title: 'Start over?', message: 'The files and photos you added will be removed.', icon: 'warn', okText: 'Start over', cancelText: 'Keep editing' });
    if (!ok) return;
  }
  resetToStart();
}

function resetToStart() {
  clearInterval(poll);
  store('clear');
  items.forEach(releaseItem);
  items = [];
  for (const k of Object.keys(slots)) { if (slots[k]) URL.revokeObjectURL(slots[k].url); slots[k] = null; }
  currentJob = null; lastStatus = null; payIssue = '';
  mode = 'doc';
  state.copies = 1; $('copies').value = 1;
  setSegment('color', 'false');
  setSegment('duplex', 'single');
  $('startErr').classList.add('hidden');
  $('jobErr').classList.add('hidden');
  show('startView');
}

// =============================================================================
// Documents: add, upload, list
// =============================================================================

function fileType(f) {
  const n = f.name.toLowerCase();
  if (n.endsWith('.pdf') || f.type === 'application/pdf') return 'pdf';
  if (OFFICE.some(e => n.endsWith(e))) return 'office';
  if (f.type.startsWith('image/') || IMAGE_EXT.some(e => n.endsWith(e))) return 'image';
  return null;
}

function addFiles(list) {
  const files = [...(list || [])];
  if (!files.length) return;
  $('startErr').classList.add('hidden');
  mode = 'doc';
  let skipped = 0;
  for (const f of files) {
    if (items.length >= MAX_FILES) { skipped++; continue; }
    const type = fileType(f);
    const item = { key: ++seq, name: f.name, type, file: f, status: 'queued', progress: 0, fileId: null, pages: 0, sel: null, thumb: null, error: '' };
    if (!type) { item.status = 'error'; item.error = 'This type of file can’t be printed.'; }
    else if (type !== 'image' && f.size > CONFIG.maxUploadMb * 1048576) { item.status = 'error'; item.error = `Too big — the limit is ${CONFIG.maxUploadMb} MB.`; }
    items.push(item);
  }
  if (skipped) UI.toast(`You can add up to ${MAX_FILES} files at a time`, 'warn');
  show('optionsView');
  renderMode();
  renderItems();
  renderPrice();
  pumpUploads();
}

function pumpUploads() {
  while (activeUploads < PARALLEL_UPLOADS) {
    const next = items.find(i => i.status === 'queued');
    if (!next) break;
    uploadItem(next);
  }
}

async function uploadItem(item) {
  item.status = 'uploading';
  activeUploads++;
  renderItems();
  try {
    let f = item.file;
    // Photos are re-encoded on the phone: smaller uploads on mobile data, and
    // formats like HEIC/WEBP become a JPG the server can print.
    if (item.type === 'image') {
      f = await compressImage(f, 3000);
      item.thumb = URL.createObjectURL(f);
    }
    if (f.size > CONFIG.maxUploadMb * 1048576) throw new Error(`Too big — the limit is ${CONFIG.maxUploadMb} MB.`);
    const r = await uploadWithProgress('/api/phone/upload' + shopQuery, f, (p) => setProgress(item, p));
    if (!items.includes(item)) return;          // removed while uploading
    Object.assign(item, { status: 'ready', fileId: r.fileId, pages: r.pages, sel: null });
    if (item.type !== 'image') makeThumb(item);
  } catch (e) {
    item.status = 'error';
    item.error = e.message || 'Upload failed.';
  } finally {
    activeUploads--;
    renderItems();
    renderPrice();
    pumpUploads();
  }
}

function uploadWithProgress(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let d = {};
      try { d = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(d);
      else reject(new Error(d.error || 'Upload failed. Please try again.'));
    };
    xhr.onerror = () => reject(new Error('Upload failed — check your internet connection.'));
    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  });
}

function setProgress(item, p) {
  item.progress = p;
  const row = $('fileList').querySelector(`[data-key="${item.key}"]`);
  if (!row) return;
  const bar = row.querySelector('.file-progress');
  const meta = row.querySelector('.file-meta');
  if (!bar || !meta) return;
  if (p >= 1) {
    bar.classList.add('indet');
    meta.textContent = item.type === 'office' ? 'Converting to PDF…' : 'Reading pages…';
  } else {
    bar.firstElementChild.style.width = Math.round(p * 100) + '%';
    meta.textContent = `Uploading… ${Math.round(p * 100)}%`;
  }
}

function selCount(item) {
  return item.sel ? item.sel.filter(p => p.on).length : item.pages;
}
function isEdited(item) {
  return !!item.sel && item.sel.some(p => !p.on || p.rotate);
}

function renderItems() {
  const list = $('fileList');
  const n = items.length;
  $('docsCount').textContent = n ? `${n} file${n > 1 ? 's' : ''}` : '';
  if (!n) { list.innerHTML = ''; return; }
  list.innerHTML = items.map((it, i) => {
    let meta, actions = '';
    if (it.status === 'error') meta = `<div class="file-meta err">${esc(it.error)}</div>`;
    else if (it.status !== 'ready') {
      const p = Math.round(it.progress * 100);
      const label = it.status === 'queued' ? 'Waiting to upload…'
        : p >= 100 ? (it.type === 'office' ? 'Converting to PDF…' : 'Reading pages…') : `Uploading… ${p}%`;
      meta = `<div class="file-meta">${label}</div><div class="file-progress${p >= 100 ? ' indet' : ''}"><span></span></div>`;
    } else {
      const c = selCount(it);
      const pagesTxt = it.sel && c !== it.pages ? `${c} of ${it.pages} pages` : `${it.pages} page${it.pages > 1 ? 's' : ''}`;
      const rotated = it.sel && it.sel.some(p => p.on && p.rotate);
      meta = `<div class="file-meta">${pagesTxt}${isEdited(it) ? ` · <span class="edited">${rotated ? 'edited' : 'pages chosen'}</span>` : ''}</div>`;
      actions += it.type === 'image'
        ? `<button class="btn btn-sm" data-act="edit" type="button">${UI.icon('rotate')} Rotate</button>`
        : `<button class="btn btn-sm" data-act="edit" type="button">${UI.icon('sliders')} Edit pages</button>`;
    }
    actions += '<span class="grow"></span>';
    if (n > 1) {
      actions += `<button class="icon-btn" data-act="up" type="button" aria-label="Move up"${i === 0 ? ' disabled' : ''}>${UI.icon('chevUp')}</button>`;
      actions += `<button class="icon-btn" data-act="down" type="button" aria-label="Move down"${i === n - 1 ? ' disabled' : ''}>${UI.icon('chevDown')}</button>`;
    }
    actions += `<button class="icon-btn danger" data-act="remove" type="button" aria-label="Remove ${esc(it.name)}">${UI.icon('trash')}</button>`;
    return `<li class="file${it.status === 'error' ? ' err' : ''}" data-key="${it.key}">
      <div class="file-thumb">${it.thumb ? `<img src="${esc(it.thumb)}" alt="">` : UI.icon(it.type === 'image' ? 'image' : 'file')}</div>
      <div class="file-body"><div class="file-name" title="${esc(it.name)}">${esc(it.name)}</div>${meta}</div>
      <div class="file-actions">${actions}</div>
    </li>`;
  }).join('');
  // What innerHTML can't carry: progress widths, rotations, page previews.
  items.forEach(it => {
    const row = list.querySelector(`[data-key="${it.key}"]`);
    const bar = row.querySelector('.file-progress span');
    if (bar) bar.style.width = Math.round(it.progress * 100) + '%';
    const thumb = row.querySelector('.file-thumb');
    if (it.thumbCanvas) { thumb.innerHTML = ''; thumb.appendChild(it.thumbCanvas); }
    const rot = it.sel?.find(p => p.on)?.rotate || 0;
    const el = thumb.firstElementChild;
    if (el && (el.tagName === 'IMG' || el.tagName === 'CANVAS')) el.style.transform = rot ? `rotate(${rot}deg)` : '';
  });
}

function onFileAction(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const key = Number(btn.closest('[data-key]').dataset.key);
  const i = items.findIndex(it => it.key === key);
  if (i < 0) return;
  const act = btn.dataset.act;
  if (act === 'remove') {
    releaseItem(items[i]);
    items.splice(i, 1);
    if (!items.length) { resetToStart(); return; }
  } else if (act === 'up' && i > 0) {
    [items[i - 1], items[i]] = [items[i], items[i - 1]];
  } else if (act === 'down' && i < items.length - 1) {
    [items[i + 1], items[i]] = [items[i], items[i + 1]];
  } else if (act === 'edit') {
    openEditor(items[i]);
    return;
  }
  renderItems();
  renderPrice();
}

function releaseItem(it) {
  if (it.thumb) URL.revokeObjectURL(it.thumb);
  if (it.pdf) { try { it.pdf.destroy(); } catch {} }
}

// =============================================================================
// Images: decode + re-encode on the phone
// =============================================================================

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This picture can’t be opened. Please use a JPG or PNG photo.')); };
    img.src = url;
  });
}

// Image -> canvas with a white background (so transparent PNGs print white),
// scaled down to maxSide. Browsers apply the photo's EXIF rotation here.
function imageToCanvas(img, maxSide) {
  const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * s));
  c.height = Math.max(1, Math.round(img.naturalHeight * s));
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function canvasToJpeg(c, quality = 0.9) {
  return new Promise((resolve, reject) => c.toBlob(b => b ? resolve(b) : reject(new Error('Could not process this picture.')), 'image/jpeg', quality));
}

async function compressImage(file, maxSide) {
  const blob = await canvasToJpeg(imageToCanvas(await loadImage(file), maxSide));
  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
  return new File([blob], name, { type: 'image/jpeg' });
}

// =============================================================================
// Page previews (pdf.js, loaded only when needed)
// =============================================================================

let pdfjs = null;
function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = import('/vendor/pdfjs-6.4.299/pdf.min.mjs')
      .then(lib => { lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs-6.4.299/pdf.worker.min.mjs'; return lib; })
      .catch(() => null);   // old browser: previews are skipped, everything else works
  }
  return pdfjs;
}

async function pdfFor(item) {
  if (item.pdf) return item.pdf;
  if (item.pdfFailed) return null;
  const lib = await loadPdfjs();
  if (!lib) return null;
  try {
    const data = item.type === 'pdf'
      ? await item.file.arrayBuffer()
      : await fetch('/api/phone/files/' + encodeURIComponent(item.fileId)).then(r => { if (!r.ok) throw new Error(); return r.arrayBuffer(); });
    item.pdf = await lib.getDocument({ data, isEvalSupported: false }).promise;
    return item.pdf;
  } catch {
    item.pdfFailed = true;
    return null;
  }
}

async function renderPage(item, n, canvas, cssWidth) {
  const pdf = await pdfFor(item);
  if (!pdf) return false;
  try {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (cssWidth * Math.min(2, window.devicePixelRatio || 1)) / base.width });
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    return true;
  } catch { return false; }
}

async function makeThumb(item) {
  const c = document.createElement('canvas');
  if (await renderPage(item, 1, c, 52) && items.includes(item)) {
    item.thumbCanvas = c;
    renderItems();
  }
}

// =============================================================================
// Page editor: choose pages, rotate
// =============================================================================

let edItem = null;
let edDraft = null;
let edObserver = null;

function wireEditor() {
  $('edBack').addEventListener('click', closeEditor);
  $('edDone').addEventListener('click', commitEditor);
  $('edRotateAll').addEventListener('click', () => {
    edDraft.forEach(p => { p.rotate = (p.rotate + 90) % 360; });
    edDraft.forEach((p, i) => paintTile(i));
  });
  document.querySelectorAll('.ed-tools [data-sel]').forEach(b => b.addEventListener('click', () => {
    const how = b.dataset.sel;
    edDraft.forEach(p => { p.on = how === 'all' || (how === 'odd' && p.n % 2 === 1) || (how === 'even' && p.n % 2 === 0); });
    edDraft.forEach((p, i) => paintTile(i));
    edCount();
  }));
  $('edGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const i = Number(btn.closest('.pg').dataset.i);
    // A single picture can only be rotated, never "skipped".
    if (btn.dataset.act === 'toggle' && edDraft.length > 1) edDraft[i].on = !edDraft[i].on;
    else if (btn.dataset.act === 'rotate') edDraft[i].rotate = (edDraft[i].rotate + 90) % 360;
    paintTile(i);
    edCount();
  });
}

function openEditor(item) {
  edItem = item;
  const base = item.sel || Array.from({ length: item.pages }, (_, k) => ({ n: k + 1, rotate: 0, on: true }));
  edDraft = base.map(p => ({ ...p }));
  $('edTitle').textContent = item.name;
  const single = item.pages === 1;
  document.querySelector('.ed-tools').classList.toggle('hidden', single);
  document.querySelector('.ed-help').classList.toggle('hidden', single);

  const grid = $('edGrid');
  grid.innerHTML = edDraft.map((p, i) => `<div class="pg" data-i="${i}">
      <button class="pg-face" data-act="toggle" type="button" aria-label="Page ${p.n}">
        <span class="pg-paper"><span class="pg-big">${p.n}</span></span>
        ${single ? '' : `<span class="pg-check">${UI.icon('check')}</span>`}
      </button>
      <div class="pg-foot"><span>${single ? 'Rotate' : 'Page ' + p.n}</span>
        <button class="icon-btn pg-rot" data-act="rotate" type="button" aria-label="Rotate page ${p.n}">${UI.icon('rotate')}</button></div>
    </div>`).join('');
  grid.classList.toggle('single', single);
  edDraft.forEach((p, i) => paintTile(i));
  edCount();

  // Pictures: show the photo itself. Documents: draw pages as they scroll into view.
  edObserver?.disconnect();
  if (item.type === 'image' && item.thumb) {
    const img = new Image();
    img.src = item.thumb;
    img.alt = '';
    const paper = grid.querySelector('.pg-paper');
    paper.innerHTML = '';
    paper.appendChild(img);
    paintTile(0);
  } else {
    edObserver = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        edObserver.unobserve(en.target);
        drawTile(item, Number(en.target.dataset.i));
      }
    }, { root: grid, rootMargin: '300px' });
    grid.querySelectorAll('.pg').forEach(el => edObserver.observe(el));
  }
  $('editor').classList.remove('hidden');
  document.body.classList.add('modal-open');
  grid.scrollTop = 0;
}

async function drawTile(item, i) {
  const c = document.createElement('canvas');
  if (!(await renderPage(item, edDraft[i].n, c, 140)) || edItem !== item) return;
  const paper = $('edGrid').querySelector(`.pg[data-i="${i}"] .pg-paper`);
  if (!paper) return;
  paper.innerHTML = '';
  paper.appendChild(c);
  paintTile(i);
}

function paintTile(i) {
  const tile = $('edGrid').querySelector(`.pg[data-i="${i}"]`);
  if (!tile) return;
  const p = edDraft[i];
  tile.classList.toggle('on', p.on);
  tile.querySelector('.pg-face').setAttribute('aria-pressed', String(p.on));
  const el = tile.querySelector('.pg-paper').firstElementChild;
  // A sideways page is shrunk so it still fits the tile.
  if (el && !el.classList.contains('pg-big')) el.style.transform = p.rotate ? `rotate(${p.rotate}deg)${p.rotate % 180 ? ' scale(.76)' : ''}` : '';
}

function edCount() {
  const on = edDraft.filter(p => p.on).length;
  $('edSub').textContent = edItem.pages === 1 ? 'Tap rotate to turn it' : `${on} of ${edDraft.length} pages selected`;
}

function commitEditor() {
  if (!edDraft.some(p => p.on)) {
    UI.alert({ title: 'No pages selected', message: 'Choose at least one page, or remove this file from the list.', icon: 'warn' });
    return;
  }
  edItem.sel = edDraft.some(p => !p.on || p.rotate) ? edDraft : null;
  closeEditor();
  renderItems();
  renderPrice();
}

function closeEditor() {
  edObserver?.disconnect();
  $('editor').classList.add('hidden');
  document.body.classList.remove('modal-open');
  $('edGrid').innerHTML = '';
  edItem = null; edDraft = null;
}

// =============================================================================
// ID card + passport photo slots
// =============================================================================

let pickingSlot = null;

function renderSlots() {
  for (const name of ['front', 'back', 'photo']) {
    const s = slots[name];
    $('slot-' + name).innerHTML = s
      ? `<span class="slot-cap">${esc(SLOT_NAME[name])}</span>
         <div class="slot-img"><img src="${esc(s.url)}" alt="${esc(SLOT_NAME[name])}"></div>
         <div class="slot-actions">
           <button class="btn btn-sm" data-adjust="${name}" type="button">Adjust</button>
           <button class="btn btn-sm" data-pick="${name}" type="button">Retake</button>
         </div>`
      : `<button class="slot-empty" data-pick="${name}" type="button">${UI.icon('camera')}<b>${esc(SLOT_NAME[name])}</b><small>Take or choose a photo</small></button>`;
  }
}

function onSlotAction(e) {
  const pick = e.target.closest('[data-pick]');
  const adjust = e.target.closest('[data-adjust]');
  if (pick) {
    pickingSlot = pick.dataset.pick;
    $('photoInput').value = '';
    $('photoInput').click();
  } else if (adjust) {
    cropInto(adjust.dataset.adjust, slots[adjust.dataset.adjust].src);
  }
}

function onPhotoChosen() {
  const f = $('photoInput').files[0];
  if (f && pickingSlot) cropInto(pickingSlot, f);
}

async function cropInto(name, file) {
  const spec = name === 'photo' ? PHOTO : CARD;
  let blob;
  try {
    blob = await openCropper(file, {
      ...spec,
      face: name === 'photo',
      title: name === 'photo' ? 'Line up your photo' : `${SLOT_NAME[name]} of the card`,
      sub: name === 'photo' ? 'Fit your face inside the oval' : 'Drag and zoom so the card fills the frame',
    });
  } catch (err) {
    UI.alert({ title: 'Can’t open this picture', message: err.message, icon: 'crit' });
    return;
  }
  if (!blob) return;
  if (slots[name]) URL.revokeObjectURL(slots[name].url);
  slots[name] = { src: file, blob, url: URL.createObjectURL(blob) };
  renderSlots();
  renderPrice();
}

// =============================================================================
// Cropper: fixed frame, the photo moves underneath (drag, pinch, wheel, slider)
// =============================================================================

const cr = { src: null, frame: null, tx: 0, ty: 0, base: 1, zoom: 1, spec: null, resolve: null, pointers: new Map(), pinch: null };

function wireCropper() {
  const stage = $('crStage');
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    cr.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    cr.pinch = null;
  });
  stage.addEventListener('pointermove', (e) => {
    const prev = cr.pointers.get(e.pointerId);
    if (!prev || !cr.src) return;
    const now = { x: e.clientX, y: e.clientY };
    cr.pointers.set(e.pointerId, now);
    if (cr.pointers.size === 1) {
      cr.tx += now.x - prev.x;
      cr.ty += now.y - prev.y;
      crClamp(); crApply();
    } else if (cr.pointers.size === 2) {
      const [a, b] = [...cr.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const rect = stage.getBoundingClientRect();
      const mid = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
      if (cr.pinch) {
        cr.tx += mid.x - cr.pinch.mid.x;
        cr.ty += mid.y - cr.pinch.mid.y;
        crZoomTo(cr.zoom * dist / cr.pinch.dist, mid.x, mid.y);
      }
      cr.pinch = { dist, mid };
    }
  });
  const up = (e) => { cr.pointers.delete(e.pointerId); cr.pinch = null; };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    crZoomTo(cr.zoom * (1 - e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });
  $('crZoom').addEventListener('input', () => {
    const f = cr.frame;
    crZoomTo(Number($('crZoom').value), f.x + f.w / 2, f.y + f.h / 2);
  });
  $('crRotate').addEventListener('click', () => {
    const c = cr.src, r = document.createElement('canvas');
    r.width = c.height; r.height = c.width;
    const g = r.getContext('2d');
    g.translate(r.width, 0);
    g.rotate(Math.PI / 2);
    g.drawImage(c, 0, 0);
    c.replaceWith(r);
    cr.src = r;
    crLayout(true);
  });
  $('crCancel').addEventListener('click', () => closeCropper(null));
  $('crDone').addEventListener('click', async () => {
    const s = cr.base * cr.zoom, f = cr.frame;
    const out = document.createElement('canvas');
    out.width = cr.spec.w; out.height = cr.spec.h;
    const g = out.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, out.width, out.height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(cr.src, (f.x - cr.tx) / s, (f.y - cr.ty) / s, f.w / s, f.h / s, 0, 0, out.width, out.height);
    closeCropper(await canvasToJpeg(out, 0.92));
  });
  window.addEventListener('resize', () => { if (cr.src && !$('cropper').classList.contains('hidden')) crLayout(true); });
}

async function openCropper(file, spec) {
  const img = await loadImage(file);
  cr.spec = spec;
  cr.src = imageToCanvas(img, 2400);
  const stage = $('crStage');
  stage.querySelectorAll('canvas').forEach(c => c.remove());
  stage.prepend(cr.src);
  $('crTitle').textContent = spec.title;
  $('crSub').textContent = spec.sub;
  $('crFrame').classList.toggle('face', !!spec.face);
  $('cropper').classList.remove('hidden');
  document.body.classList.add('modal-open');
  crLayout(true);   // reading the stage size forces layout, so this works right away
  return new Promise(resolve => { cr.resolve = resolve; });
}

function closeCropper(result) {
  $('cropper').classList.add('hidden');
  document.body.classList.remove('modal-open');
  cr.pointers.clear();
  const done = cr.resolve;
  cr.resolve = null;
  if (done) done(result);
}

function crLayout(reset) {
  const stage = $('crStage');
  const W = stage.clientWidth, H = stage.clientHeight, pad = 24;
  let fw = W - pad * 2, fh = fw / cr.spec.aspect;
  if (fh > H - pad * 2) { fh = H - pad * 2; fw = fh * cr.spec.aspect; }
  cr.frame = { x: (W - fw) / 2, y: (H - fh) / 2, w: fw, h: fh };
  Object.assign($('crFrame').style, { left: cr.frame.x + 'px', top: cr.frame.y + 'px', width: fw + 'px', height: fh + 'px' });
  const c = cr.src;
  cr.base = Math.max(fw / c.width, fh / c.height);   // smallest scale that still covers the frame
  if (reset) {
    cr.zoom = 1;
    $('crZoom').value = 1;
    cr.tx = cr.frame.x + (fw - c.width * cr.base) / 2;
    cr.ty = cr.frame.y + (fh - c.height * cr.base) / 2;
  }
  crClamp(); crApply();
}

function crZoomTo(z, cx, cy) {
  const s1 = cr.base * cr.zoom;
  cr.zoom = Math.min(5, Math.max(1, z));
  const s2 = cr.base * cr.zoom;
  cr.tx = cx - (cx - cr.tx) * (s2 / s1);
  cr.ty = cy - (cy - cr.ty) * (s2 / s1);
  $('crZoom').value = cr.zoom;
  crClamp(); crApply();
}

// Keep the photo covering the whole frame.
function crClamp() {
  const s = cr.base * cr.zoom, f = cr.frame, c = cr.src;
  cr.tx = Math.min(f.x, Math.max(f.x + f.w - c.width * s, cr.tx));
  cr.ty = Math.min(f.y, Math.max(f.y + f.h - c.height * s, cr.ty));
}

function crApply() {
  cr.src.style.transform = `translate(${cr.tx}px, ${cr.ty}px) scale(${cr.base * cr.zoom})`;
}

// =============================================================================
// Copies, price, readiness
// =============================================================================

// While typing, an empty box is allowed; it's corrected on blur.
function setCopies(n, typing) {
  if (Number.isNaN(n)) { if (typing) return; n = 1; }
  state.copies = Math.min(999, Math.max(1, n));
  if (!typing || String(state.copies) !== $('copies').value) $('copies').value = state.copies;
  renderPrice();
}

function printedPages() {
  if (mode === 'doc') return items.filter(i => i.status === 'ready').reduce((n, i) => n + selCount(i), 0);
  return 1;   // ID card copy / photo sheet = one page
}

function readiness() {
  if (mode === 'doc') {
    if (!items.length) return 'Add a file to print.';
    if (items.some(i => i.status === 'queued' || i.status === 'uploading')) return 'Uploading your files…';
    if (items.some(i => i.status === 'error')) return 'Remove the files that couldn’t be added.';
    return '';
  }
  if (mode === 'idcard') {
    if (!slots.front && !slots.back) return 'Add photos of the front and back.';
    if (!slots.front) return 'Add a photo of the front.';
    if (!slots.back) return 'Add a photo of the back.';
    return '';
  }
  return slots.photo ? '' : 'Add your photo.';
}

function renderPrice() {
  if (!CONFIG) return;
  const pages = printedPages();
  const colour = state.color && CONFIG.capabilities.color;
  const perPage = colour ? CONFIG.pricing.colorPerPage : CONFIG.pricing.bwPerPage;
  $('priceAmount').textContent = fmt(pages * state.copies * perPage);
  const copies = mode === 'passport'
    ? `${state.copies} sheet${state.copies > 1 ? 's' : ''}`
    : `${state.copies} cop${state.copies > 1 ? 'ies' : 'y'}`;
  const what = mode === 'idcard' ? 'Front & back' : mode === 'passport' ? `${photoCount} photos` : `${pages} page${pages === 1 ? '' : 's'}`;
  $('priceDetail').textContent = `${what} × ${copies} · ${colour ? 'Colour' : 'B&W'}`;
  const why = readiness();
  $('payBtn').disabled = !!why;
  $('payHint').textContent = why;
  $('payHint').classList.toggle('hidden', !why);
}

// =============================================================================
// Create the job + pay
// =============================================================================

async function payAndPrint() {
  $('jobErr').classList.add('hidden');
  if (readiness()) return;
  const btn = $('payBtn');
  btn.disabled = true;
  btn.textContent = 'Please wait…';
  try {
    let files;
    if (mode === 'doc') {
      files = items.map(i => ({
        fileId: i.fileId,
        pages: isEdited(i) ? i.sel.filter(p => p.on).map(({ n, rotate }) => ({ n, rotate })) : undefined,
      }));
    } else {
      const fd = new FormData();
      fd.append('kind', mode);
      fd.append('paperSize', state.paperSize);
      if (mode === 'idcard') {
        fd.append('front', slots.front.blob, 'front.jpg');
        fd.append('back', slots.back.blob, 'back.jpg');
      } else {
        fd.append('photo', slots.photo.blob, 'photo.jpg');
        fd.append('count', String(photoCount));
      }
      const layout = await api('/layout' + shopQuery, { method: 'POST', body: fd });
      files = [{ fileId: layout.fileId }];
    }
    const options = { copies: state.copies, color: state.color, duplex: state.duplex, paperSize: state.paperSize };
    currentJob = await api('/jobs' + shopQuery, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files, options, shop: SHOP }),
    });
    store('set', currentJob.id);
    await startPayment();
  } catch (e) {
    $('jobErr').textContent = e.message;
    $('jobErr').classList.remove('hidden');
  } finally {
    btn.textContent = PAY_LABEL;
    renderPrice();
  }
}

// Start (or restart) payment for currentJob. Online providers leave the page.
async function startPayment() {
  const pay = await api(`/jobs/${currentJob.id}/pay`, { method: 'POST' });

  // JazzCash: auto-submit a form to the hosted checkout.
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
  // Safepay: go to the hosted checkout URL.
  if (pay.redirectUrl) {
    window.location.href = pay.redirectUrl;
    return;
  }
  // Cash (or instant): we already have the job's new state.
  currentJob = pay;
  show('statusView');
  startPolling();
}

async function retryPayment() {
  const btn = $('retryPay');
  btn.disabled = true;
  btn.textContent = 'Opening payment…';
  payIssue = '';
  try { await startPayment(); }
  catch (e) { UI.alert({ title: 'Payment could not start', message: e.message, icon: 'crit' }); }
  finally { btn.disabled = false; btn.textContent = 'Try payment again'; }
}

// =============================================================================
// Status
// =============================================================================

function startPolling() {
  waitingSince = Date.now();
  renderStatus(currentJob);
  clearInterval(poll);
  if (FINAL.includes(currentJob.status)) return;
  poll = setInterval(async () => {
    try {
      const j = await api(`/jobs/${currentJob.id}`);
      currentJob = j;
      renderStatus(j);
      if (FINAL.includes(j.status)) { clearInterval(poll); store('clear'); }
    } catch {}
  }, 2000);
}

const STATUS = {
  awaiting_payment: ['clock', 'neutral busy', 'Confirming your payment…', 'This usually takes a few seconds.'],
  awaiting_approval: ['cash', 'warn', 'Pay at the counter', 'Show this screen to the shopkeeper and pay. They will release your print.'],
  queued: ['clock', 'busy', 'In the print queue', 'Your print will start in a moment.'],
  printing: ['printer', 'busy', 'Printing now', 'Please collect your pages at the counter.'],
  done: ['checkCircle', 'good', 'Printed', 'Collect your pages at the counter. Thank you!'],
  needs_attention: ['alert', 'warn', 'Please wait a moment', 'The shop is attending to the printer. You won’t be charged if it can’t print.'],
  failed: ['xCircle', 'crit', 'Could not print', 'Sorry — please ask the shopkeeper for help.'],
  refunded: ['undo', 'neutral', 'Refunded', 'The print could not be completed, so your payment was refunded.'],
};

function renderStatus(j) {
  let [icon, tone, title, msg] = STATUS[j.status] || ['clock', 'neutral', 'Working…', ''];
  let canRetry = false;

  // Back from checkout without paying, or still unconfirmed after a while.
  if (j.status === 'awaiting_payment') {
    const slow = Date.now() - waitingSince > 45 * 1000;
    if (payIssue || slow) {
      icon = 'card'; tone = 'warn';
      title = payIssue === 'cancelled' ? 'Payment cancelled' : 'Payment not completed';
      msg = slow && !payIssue
        ? 'We haven’t received your payment yet. If you were charged, it will show here shortly — otherwise try again.'
        : 'Your print is saved. You can try the payment again.';
      canRetry = true;
    }
  }
  // Auto-approved cash job: it prints first, the customer pays on pickup.
  if (j.payment.payAtCounter) {
    if (['queued', 'printing', 'done'].includes(j.status)) msg += ` Please pay ${fmt(j.price.amount)} ${j.price.currency} at the counter.`;
    else if (j.status === 'refunded') msg = 'The print could not be completed, so there is nothing to pay.';
  }

  const ic = $('stIcon');
  ic.className = 'status-ic ' + tone;
  ic.innerHTML = UI.icon(icon);
  $('stTitle').textContent = title;
  $('stMsg').textContent = msg;
  $('retryPay').classList.toggle('hidden', !canRetry);

  // Steps: Pay is done once paid/approved; Collect lights up after that.
  const paid = !['awaiting_payment', 'awaiting_approval'].includes(j.status);
  setSteps(paid ? 3 : 2);

  if (j.status !== lastStatus && lastStatus !== null) {
    if (j.status === 'done') UI.toast('Printed — collect your pages');
    else if (j.status === 'refunded') UI.toast('Refunded — the print could not complete', 'warn');
    else if (j.status === 'failed') UI.toast('Could not print — please ask the shopkeeper', 'crit');
  }
  lastStatus = j.status;

  const n = j.price.totalPagesPrinted;
  const files = j.file.items && j.file.items.length > 1 ? `<div><dt>Files</dt><dd>${j.file.items.length}</dd></div>` : '';
  $('stMeta').innerHTML = `
    <div><dt>${j.kind && j.kind !== 'doc' ? 'Print' : 'Document'}</dt><dd>${esc(j.file.originalName)}</dd></div>
    ${files}
    <div><dt>Printing</dt><dd>${n} page${n > 1 ? 's' : ''}${j.price.color ? ' · colour' : ''}</dd></div>
    ${j.payment.ref ? `<div><dt>Reference</dt><dd>${esc(j.payment.ref)}</dd></div>` : ''}
    <div class="total"><dt>Total</dt><dd>${fmt(j.price.amount)} ${esc(j.price.currency)}</dd></div>`;
}

// =============================================================================
// Helpers
// =============================================================================

const VIEW_STEP = { startView: 0, optionsView: 1, statusView: 2, lockedView: 0 };
function show(view) {
  ['startView', 'optionsView', 'statusView', 'lockedView'].forEach(v => $(v).classList.add('hidden'));
  $(view).classList.remove('hidden');
  setSteps(VIEW_STEP[view]);
  window.scrollTo(0, 0);
}
function setSteps(active) {
  document.querySelectorAll('#steps li').forEach((li, i) => {
    li.classList.toggle('done', i < active);
    li.classList.toggle('on', i === active);
  });
}

// sessionStorage can be unavailable (private mode, blocked storage) — never let it break the flow.
function store(op, val) {
  try {
    if (op === 'get') return sessionStorage.getItem(JOB_KEY);
    if (op === 'set') sessionStorage.setItem(JOB_KEY, val);
    if (op === 'clear') sessionStorage.removeItem(JOB_KEY);
  } catch {}
  return null;
}

function showErr(id, msg) { $(id).textContent = msg; $(id).classList.remove('hidden'); }
function fmt(n) { return Number(n || 0).toLocaleString('en-PK', { maximumFractionDigits: 2 }); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
