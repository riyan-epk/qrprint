// Price calculation + page-range parsing. The server is the single source of
// truth for money — the phone shows an estimate, but the amount charged is
// always recomputed here.

// Parse a human page range like "1-3,5,8-10" against a document of `total`
// pages. Returns a sorted, de-duplicated, in-bounds list of 1-based page
// numbers. Empty / "all" / invalid input means "every page".
export function parseRange(range, total) {
  const all = () => Array.from({ length: total }, (_, i) => i + 1);
  if (!range || String(range).trim() === '' || /^all$/i.test(String(range).trim())) {
    return all();
  }
  const pages = new Set();
  for (const partRaw of String(range).split(',')) {
    const part = partRaw.trim();
    if (!part) continue;
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      let a = parseInt(m[1], 10);
      let b = parseInt(m[2], 10);
      if (a > b) [a, b] = [b, a];
      for (let p = a; p <= b; p++) if (p >= 1 && p <= total) pages.add(p);
    } else if (/^\d+$/.test(part)) {
      const p = parseInt(part, 10);
      if (p >= 1 && p <= total) pages.add(p);
    } else {
      // Unparseable token -> reject by falling back to everything, safest for
      // the customer (they get all pages rather than a silent under-print).
      return all();
    }
  }
  const list = [...pages].sort((a, b) => a - b);
  return list.length ? list : all();
}

// Compute the price for a job. Returns amount + a breakdown the UI can show.
// options: { copies, color, pageRange }
export function computePrice(shop, totalPages, options) {
  const copies = clampInt(options.copies, 1, 999, 1);
  const selected = parseRange(options.pageRange, totalPages);
  const pagesPerCopy = selected.length;
  const sheets = pagesPerCopy * copies;

  const perPage = options.color && shop.capabilities.color
    ? shop.pricing.colorPerPage
    : shop.pricing.bwPerPage;

  const amount = sheets * perPage;

  return {
    currency: shop.pricing.currency,
    amount,
    perPage,
    color: !!(options.color && shop.capabilities.color),
    copies,
    pagesPerCopy,
    totalPagesPrinted: sheets,
    selectedPages: selected,
  };
}

export function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
