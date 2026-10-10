#!/usr/bin/env python3
"""Extract narration-ready prose from a PDF.

    python3 tools/pdf-to-text.py FILE_OR_URL [-o OUT] [--pages N-M]
                                       [--keep-toc] [--report]

Shells out to pdftotext (poppler-utils); no Python PDF dependencies.

PDF text layers are laid out for sight, not for speech, and four artifacts of
that get *spoken* if fed through as-is:

  * page numbers, which sit alone on the last line of every page
    ("...on it. 30 The task begins now" — read aloud as "thirty")
  * words hyphenated across a line break ("con-\\ntinue")
  * list markers ("●") carried into the sentence text
  * zero-width spaces (U+200B) on headings, which also corrupt char offsets

So this reflows the text: drop page furniture and the table of contents, join
wrapped lines, repair hyphenation, and separate paragraphs, headings and list
items with blank lines. Blank lines matter downstream: chrome-tts-api treats one
as a hard sentence boundary and sizes the silence after it.

Tables in slide-style PDFs are usually embedded images, so only their captions
land in the text layer; the numbers are simply absent and are skipped.

Output is UTF-8 to stdout, or -o FILE.
"""
import argparse
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
import urllib.request
from pathlib import Path

BARE_NUMBER = re.compile(r'^\d{1,4}$')
# In -layout mode a TOC entry is "Section title ........ 19" on one line, so the
# page number is trailing rather than alone; both shapes must count.
TRAILING_NUMBER = re.compile(r'^(.*\S)\s+\d{1,3}$')
BULLET = re.compile(r'^\s*(?:[●•▪‣·∙*+]|[-–—]|\d{1,2}[.)])\s+')
# Invisible formatting characters PDF producers emit (Google Docs especially).
# U+200B is the important one: it glues to list markers ("● item") and
# headings, so leaving it in defeats bullet stripping and shifts every
# char offset after it.
ZERO_WIDTH = {ord(c): None for c in '\u200b\u200c\u200d\u2060\ufeff\u00ad'}
# A hyphen at end of line joining to a lowercase letter is a soft hyphen.
DEHYPHEN = re.compile(r'([A-Za-zÀ-ɏ])[-‐]\n[ \t]*([a-zÀ-ɏ])')
PAGE_SPLIT = re.compile(r'\f')
HEADING_NUM = re.compile(r'^\d+(?:\.\d+)*\.?\s+\S')      # "2.2.4 Conclusions"
HEADING_END = re.compile(r'[.!?:;,…]["”’)\]]?$')


def die(msg):
    sys.stderr.write(f"pdf-to-text: {msg}\n")
    sys.exit(1)


def fetch(src, tmpdir):
    """Return a local path for src, downloading it if it looks like a URL."""
    if not re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*://', src):
        p = Path(src).expanduser()
        if not p.exists():
            die(f"no such file: {src}")
        return str(p)
    suffix = Path(src.split('?')[0]).suffix or '.pdf'
    out = Path(tmpdir) / ('download' + suffix)
    req = urllib.request.Request(src, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=180) as r, open(out, 'wb') as f:
        shutil.copyfileobj(r, f)
    if out.stat().st_size == 0:
        die(f"downloaded empty file from {src}")
    return str(out)


def extract(path):
    """pdftotext -layout.

    Plain mode emits no blank lines between paragraphs (6% blank on the test
    letter) because the PDF has no paragraph marks — only vertical gaps. Layout
    mode preserves those gaps (26% blank), which is the only signal available
    for where paragraphs, headings and list items begin. The extra column
    padding it introduces collapses to single spaces in reflow().
    """
    try:
        r = subprocess.run(['pdftotext', '-q', '-layout', '-enc', 'UTF-8', path, '-'],
                           capture_output=True, timeout=900)
    except FileNotFoundError:
        die("pdftotext not found. Install poppler-utils "
            "(apt-get install poppler-utils / brew install poppler).")
    if r.returncode != 0:
        die(f"pdftotext failed: {r.stderr.decode('utf-8', 'replace').strip()}")
    return r.stdout.decode('utf-8', 'replace')


def normalize(raw):
    # NFKC folds ligatures (ﬁ -> fi) and full-width punctuation. Then drop the
    # zero-width characters Google Docs sprinkles on headings.
    text = unicodedata.normalize('NFKC', raw)
    return text.translate(ZERO_WIDTH).replace('\u00a0', ' ')


def is_toc_page(lines):
    """A table-of-contents page is mostly entries that end in a page number.

    Measured on the Haiku system card with -layout: TOC pages score 0.97-1.00,
    prose pages 0.02-0.06, so the 0.30 threshold separates them with room to
    spare. Bare numbers alone are not enough — layout mode puts the number on
    the same line as the title, so trailing numbers count too.

    The line floor matters: a figure page holding a caption and two numbers
    scores 1.00 on three lines and would be dropped, losing its caption. Real
    TOC pages run 30-75 lines.
    """
    if len(lines) < 10:
        return False
    hits = sum(1 for l in lines if BARE_NUMBER.match(l) or TRAILING_NUMBER.match(l))
    return hits / len(lines) > 0.30


def strip_furniture(pages):
    """Drop running headers/footers and the page number on each page edge."""
    counts = {}
    for pg in pages:
        lines = [l.strip() for l in pg.split('\n') if l.strip()]
        for edge in (lines[0] if lines else None, lines[-1] if lines else None):
            if edge and len(edge) < 70:
                counts[edge] = counts.get(edge, 0) + 1
    # A short edge line seen on several pages is a running header/footer.
    repeated = {t for t, n in counts.items() if n >= 3}

    out = []
    for pg in pages:
        lines = pg.split('\n')
        idx = [i for i, l in enumerate(lines) if l.strip()]
        if not idx:
            out.append('')
            continue
        edge = {idx[0], idx[-1]}
        keep = []
        for i, raw in enumerate(lines):
            s = raw.strip()
            if not s:
                keep.append('')
                continue
            if i in edge and (BARE_NUMBER.match(s) or s in repeated):
                continue
            keep.append(s)
        out.append('\n'.join(keep))
    return out


STARTS_SENTENCE = re.compile(r'^["“(“\'\dA-ZÀ-Þ]')


def is_heading(line, nxt):
    """A standalone line that is not a wrapped continuation.

    PDF text gives no paragraph marks inside a block, so the signal is: short,
    no terminal punctuation, and the next line begins a fresh sentence. Numbered
    section titles ("2.2.4 Conclusions") are unambiguous on their own.
    """
    if not line or len(line) > 90 or BULLET.match(line):
        return False
    if HEADING_END.search(line):
        return False
    if HEADING_NUM.match(line):
        return True
    if not nxt or len(line) > 60:
        return False
    return bool(STARTS_SENTENCE.match(nxt))


def reflow(page):
    """Join wrapped lines; separate blocks with blank lines.

    A heading (above) becomes its own block, as does every list item — that
    blank line is what tells chrome-tts-api to end the sentence and pick a
    pause. Being slightly eager here is deliberate: a missed heading merges into
    the paragraph after it, whereas an over-split only costs a short pause.
    """
    lines = [l.strip() for l in page.split('\n')]
    blocks, cur = [], []

    def flush():
        nonlocal cur
        if cur:
            blocks.append(' '.join(cur)); cur = []

    for i, line in enumerate(lines):
        if not line:
            flush()
            continue
        nxt = next((l for l in lines[i + 1:] if l), '')
        if is_heading(line, nxt):
            flush()
            blocks.append(line)
            continue
        cur.append(BULLET.sub('', line) if BULLET.match(line) else line)
    flush()

    out = []
    for b in blocks:
        b = re.sub(r'\s{2,}', ' ', b).strip()
        if b:
            out.append(b)
    return out


def clean(raw, page_range=None, keep_toc=False):
    stats = {'pages': 0, 'toc_pages': 0, 'furniture_lines': 0, 'headings': 0, 'blocks': 0}
    text = normalize(raw)
    pages = PAGE_SPLIT.split(text)
    if page_range:
        a, b = page_range
        pages = pages[a - 1:b]
    stats['pages'] = len(pages)

    kept = []
    for pg in pages:
        lines = [l.strip() for l in pg.split('\n') if l.strip()]
        if not lines:
            continue
        if not keep_toc and is_toc_page(lines):
            stats['toc_pages'] += 1
            continue
        kept.append(pg)

    before = sum(len([l for l in p.split('\n') if l.strip()]) for p in kept)
    kept = strip_furniture(kept)
    after = sum(len([l for l in p.split('\n') if l.strip()]) for p in kept)
    stats['furniture_lines'] = max(0, before - after)

    blocks = []
    for pg in kept:
        # A soft hyphen binds to the next line; repair before joining.
        pg = DEHYPHEN.sub(r'\1\2', pg)
        blocks.extend(reflow(pg))
    # A block is a heading if it is short, unterminated and not a list item.
    stats['headings'] = sum(
        1 for b in blocks if len(b) <= 90 and not HEADING_END.search(b)
        and not BULLET.match(b) and b)
    stats['blocks'] = len(blocks)
    return '\n\n'.join(blocks), stats


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('source', help='PDF path or URL')
    ap.add_argument('-o', '--out', help='write here instead of stdout')
    ap.add_argument('--pages', help='restrict to pages N-M (1-indexed)')
    ap.add_argument('--keep-toc', action='store_true', help='do not drop TOC pages')
    ap.add_argument('--report', action='store_true', help='print a summary to stderr')
    a = ap.parse_args()

    pr = None
    if a.pages:
        m = re.match(r'^(\d+)(?:-(\d+))?$', a.pages)
        if not m:
            die(f"bad --pages {a.pages!r}; expected N or N-M")
        lo = int(m.group(1)); hi = int(m.group(2) or m.group(1))
        if lo < 1 or hi < lo:
            die(f"bad --pages {a.pages!r}; expected N or N-M with 1 <= N <= M")
        pr = (lo, hi)

    with tempfile.TemporaryDirectory() as td:
        path = fetch(a.source, td)
        text, stats = clean(extract(path), page_range=pr, keep_toc=a.keep_toc)

    text = text.strip()
    if not text:
        die("no text extracted — the PDF may be scanned images (needs OCR)")

    if a.out:
        Path(a.out).write_text(text, encoding='utf-8')
    else:
        sys.stdout.write(text + '\n')

    if a.report:
        words = len(text.split())
        print(f"pages={stats['pages']} toc_dropped={stats['toc_pages']} "
              f"furniture_lines={stats['furniture_lines']} "
              f"headings={stats['headings']} blocks={stats['blocks']}", file=sys.stderr)
        print(f"chars={len(text)} words={words} "
              f"~audio={words / 150:.1f} min", file=sys.stderr)


if __name__ == '__main__':
    main()