"""PDF preparation: extract a page range and split for mixed single/double.

Uses pypdf (pure Python). All outputs are written to a temp directory the
caller is responsible for cleaning up.
"""
import os
import tempfile
from pypdf import PdfReader, PdfWriter


def _page_count(path):
    return len(PdfReader(path).pages)


def parse_range(range_str, total):
    """Mirror of the server's parser. Returns 1-based page numbers, in bounds."""
    s = (range_str or "").strip()
    if not s or s.lower() == "all":
        return list(range(1, total + 1))
    pages = set()
    for part in s.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            try:
                a, b = part.split("-", 1)
                a, b = int(a), int(b)
                if a > b:
                    a, b = b, a
                for p in range(a, b + 1):
                    if 1 <= p <= total:
                        pages.add(p)
            except ValueError:
                return list(range(1, total + 1))
        elif part.isdigit():
            p = int(part)
            if 1 <= p <= total:
                pages.add(p)
        else:
            return list(range(1, total + 1))
    return sorted(pages) if pages else list(range(1, total + 1))


def _write_subset(reader, page_numbers, out_path):
    writer = PdfWriter()
    for p in page_numbers:
        writer.add_page(reader.pages[p - 1])  # pypdf is 0-based
    with open(out_path, "wb") as f:
        writer.write(f)
    return out_path


def prepare(src_path, options, workdir=None):
    """Turn the raw PDF + options into a list of print parts.

    Returns a list of dicts: [{path, sides}] where sides is
    'one-sided' or 'two-sided'. Usually one part; for 'mixed' it is two
    (page 1 one-sided, the rest two-sided).
    """
    workdir = workdir or tempfile.mkdtemp(prefix="qrprint_")
    reader = PdfReader(src_path)
    total = len(reader.pages)

    selected = parse_range(options.get("pageRange", ""), total)
    duplex = options.get("duplex", "single")

    # First narrow to the selected pages (unless it's the whole doc).
    if selected != list(range(1, total + 1)):
        subset = os.path.join(workdir, "subset.pdf")
        _write_subset(reader, selected, subset)
        reader = PdfReader(subset)
        selected = list(range(1, len(reader.pages) + 1))

    if duplex == "mixed" and len(selected) >= 2:
        first = os.path.join(workdir, "part1_first.pdf")
        rest = os.path.join(workdir, "part2_rest.pdf")
        _write_subset(reader, [selected[0]], first)
        _write_subset(reader, selected[1:], rest)
        return [
            {"path": first, "sides": "one-sided"},
            {"path": rest, "sides": "two-sided"},
        ], workdir

    sides = "two-sided" if duplex == "double" else "one-sided"
    # If we narrowed pages we already wrote a subset; otherwise use the source.
    only = os.path.join(workdir, "only.pdf")
    _write_subset(reader, selected, only)
    return [{"path": only, "sides": sides}], workdir
