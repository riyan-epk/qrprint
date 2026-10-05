// Print layouts built on the server, at true physical size:
//   - ID card copy (CNIC): front + back on one sheet, each 85.6 x 54 mm
//   - Passport photos: a cut-ready grid of 35 x 45 mm photos
//   - Merging several uploaded files (with per-page selection and rotation)
//     into the single PDF the print agent receives.
// The agent just prints the result "as is", so no agent update is needed.
import fs from 'node:fs';
import { PDFDocument, degrees, rgb } from 'pdf-lib';

const MM = 72 / 25.4;
export const PAPER = { A4: [595.28, 841.89], Letter: [612, 792], Legal: [612, 1008] };

export const CARD_MM = [85.6, 54];       // ISO ID-1 — CNIC, driving licence, bank card
export const PHOTO_MM = [35, 45];        // Pakistan passport / visa photo
export const PHOTO_COUNTS = [4, 8, 12, 16, 20];

// JPEG or PNG, by magic bytes (never trust the file name).
export function imageType(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  return null;
}

async function embed(doc, bytes) {
  const t = imageType(bytes);
  if (t === 'jpg') return doc.embedJpg(bytes);
  if (t === 'png') return doc.embedPng(bytes);
  throw Object.assign(new Error('Unsupported image'), { code: 'BAD_IMAGE' });
}

// A hairline frame helps the shopkeeper cut neatly.
function cutFrame(page, x, y, w, h) {
  page.drawRectangle({ x, y, width: w, height: h, borderColor: rgb(0.78, 0.8, 0.84), borderWidth: 0.5 });
}

// Front above back, centred on the page with a gap between them.
export async function idCardPdf(frontBytes, backBytes, paper = 'A4') {
  const doc = await PDFDocument.create();
  const [pw, ph] = PAPER[paper] || PAPER.A4;
  const page = doc.addPage([pw, ph]);
  const w = CARD_MM[0] * MM, h = CARD_MM[1] * MM, gap = 12 * MM;
  const x = (pw - w) / 2;
  const top = (ph + (h * 2 + gap)) / 2;            // the pair is centred vertically
  const front = await embed(doc, frontBytes);
  const back = await embed(doc, backBytes);
  page.drawImage(front, { x, y: top - h, width: w, height: h });
  page.drawImage(back, { x, y: top - 2 * h - gap, width: w, height: h });
  cutFrame(page, x, top - h, w, h);
  cutFrame(page, x, top - 2 * h - gap, w, h);
  doc.setTitle('ID card copy');
  return doc.save();
}

// `count` photos in rows of 4, centred horizontally, from the top margin.
export async function passportPdf(photoBytes, count = 8, paper = 'A4') {
  const doc = await PDFDocument.create();
  const [pw, ph] = PAPER[paper] || PAPER.A4;
  const page = doc.addPage([pw, ph]);
  const img = await embed(doc, photoBytes);
  const w = PHOTO_MM[0] * MM, h = PHOTO_MM[1] * MM, gap = 4 * MM, cols = 4;
  const n = PHOTO_COUNTS.includes(count) ? count : 8;
  const gridW = cols * w + (cols - 1) * gap;
  const x0 = (pw - gridW) / 2, top = ph - 15 * MM;
  for (let i = 0; i < n; i++) {
    const c = i % cols, r = Math.floor(i / cols);
    const x = x0 + c * (w + gap), y = top - (r + 1) * h - r * gap;
    page.drawImage(img, { x, y, width: w, height: h });
    cutFrame(page, x, y, w, h);
  }
  doc.setTitle('Passport photos');
  return doc.save();
}

// items: [{ path, pages: [{ n, rotate }] | null }] in print order. `pages` null
// means every page, unrotated. With double-sided printing, each file after the
// first starts on a fresh sheet (a blank back page is added) — blank pages are
// not charged. Returns { bytes, contentPages, totalPages }.
export async function mergeFiles(items, { duplex = 'single' } = {}) {
  const out = await PDFDocument.create();
  let contentPages = 0;
  for (const [i, item] of items.entries()) {
    const src = await PDFDocument.load(fs.readFileSync(item.path), { ignoreEncryption: true });
    const total = src.getPageCount();
    const sel = item.pages && item.pages.length
      ? item.pages.filter(p => p.n >= 1 && p.n <= total)
      : Array.from({ length: total }, (_, k) => ({ n: k + 1, rotate: 0 }));
    const copied = await out.copyPages(src, sel.map(p => p.n - 1));
    copied.forEach((page, k) => {
      const extra = sel[k].rotate || 0;
      if (extra) page.setRotation(degrees((page.getRotation().angle + extra) % 360));
      out.addPage(page);
    });
    contentPages += copied.length;
    const isLast = i === items.length - 1;
    if (duplex === 'double' && !isLast && out.getPageCount() % 2 === 1) {
      const last = out.getPage(out.getPageCount() - 1);
      const { width, height } = last.getSize();
      out.addPage([width, height]);
    }
  }
  return { bytes: await out.save(), contentPages, totalPages: out.getPageCount() };
}
