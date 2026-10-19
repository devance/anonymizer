"""OCR and image handling.

Scans and photos become PDFs with an invisible OCR text layer, so the same
extract/rewrite path works on them: the text layer says where each word is,
and rewriting patches the pixels under it.

Tesseract runs inside PyMuPDF on pages rendered in memory (it only needs the
models in TESSDATA); nothing is written to disk. The original page images are
left as they are: the layer is added on top.
"""

from __future__ import annotations

import io
import statistics
from dataclasses import dataclass, field
from functools import lru_cache

import pymupdf as fitz
from PIL import Image, ImageChops, ImageOps
from pillow_heif import register_heif_opener

from . import guard, pool
from .paths import FONT_DIR, TESSDATA

register_heif_opener()

LANGS = "fra+eng"
# Tesseract reads best at about 300 dpi: coarser scans are upsampled to it, finer ones read at up to MAX_DPI.
OCR_DPI = 300
MAX_DPI = 400
MAX_PIXELS = 60_000_000
ORIENT_DPI = 150
# The layer is set in Liberation Sans: Arial's widths, and an ascent and descent
# that bound accented capitals and descenders, so a word's box covers its ink.
LAYER_FONT = FONT_DIR / "liberation" / "LiberationSans-Regular.ttf"
LAYER_NAME = "OCRText"

# Frequent short words of French and English. A reading full of them is the right way up.
COMMON = frozenset(
    """le la les de des du un une et en au aux pour par sur dans avec est sont ce cette ces qui que ne pas
    plus ou son sa ses votre vos nous vous il elle ils leur date nom page
    the of and to in is for on with that this be are as at by from or an your our we you it not""".split()
)
VOWELS = set("aeiouyàâäéèêëîïôöùûü")


@dataclass
class Word:
    text: str
    x0: float
    x1: float
    top: float  # Tesseract's line box
    bottom: float


@dataclass
class Line:
    words: list[Word] = field(default_factory=list)
    baseline: float = 0.0
    size: float = 0.0


def _tessdata() -> str:
    if not (TESSDATA / "fra.traineddata").exists():
        raise RuntimeError(f"OCR models missing from {TESSDATA}")
    return str(TESSDATA)


def _recognize(pix: fitz.Pixmap) -> list[list[Word]]:
    """Tesseract's words on a rendered page, line by line, in pixels."""
    page = fitz.open(stream=pix.pdfocr_tobytes(compress=False, language=LANGS, tessdata=_tessdata()), filetype="pdf")[0]
    k = pix.width / page.rect.width
    lines: list[list[Word]] = []
    for block in page.get_text("rawdict", flags=0)["blocks"]:
        for line in block.get("lines", []):
            cur: Word | None = None
            for span in line["spans"]:
                for ch in span["chars"]:
                    x0, y0, x1, y1 = (v * k for v in ch["bbox"])
                    if ch["c"].isspace():
                        cur = None
                        continue
                    # MuPDF writes each word as a run of touching glyphs; a line's words share its box.
                    if cur and abs(x0 - cur.x1) < 0.5 and abs(y0 - cur.top) < 0.5 and abs(y1 - cur.bottom) < 0.5:
                        cur.text += ch["c"]
                        cur.x1 = x1
                        continue
                    cur = Word(ch["c"], x0, x1, y0, y1)
                    for ws in lines:
                        if abs(ws[0].top - y0) < 0.5 and abs(ws[0].bottom - y1) < 0.5:
                            ws.append(cur)
                            break
                    else:
                        lines.append([cur])
    return [sorted(ws, key=lambda w: w.x0) for ws in lines]


def _score(lines: list[list[Word]]) -> tuple[int, int]:
    """
    (points, words): how much a reading looks like French or English. Frequent
    short words count most; words in odd case ("aIJEUJEN", what a page read
    upside down gives) or all capitals don't count.
    """
    pts = n = 0
    for ws in lines:
        for w in ws:
            t = w.text.strip(".,;:!?()[]«»\"'")
            if not t:
                continue
            n += 1
            if not (t.islower() or t.istitle()):
                continue
            if t.lower() in COMMON:
                pts += 3
            elif len(t) >= 4 and t.isalpha() and VOWELS & set(t.lower()):
                pts += 1
    return pts, n


def _render(page: fitz.Page, dpi: float, turn: int = 0) -> fitz.Pixmap:
    # RGB: MuPDF's OCR returns nothing for a grayscale pixmap.
    pix = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72).prerotate(turn), colorspace=fitz.csRGB, alpha=False)
    pix.set_dpi(round(dpi), round(dpi))
    return pix


def _dpi(page: fitz.Page) -> float:
    """Resolution to read a page at: its images' own, within limits."""
    res = 0.0
    for info in page.get_image_info():
        r = fitz.Rect(info["bbox"])
        if min(r.width, r.height) > 1 and info["width"]:
            res = max(res, max(info["width"], info["height"]) / max(r.width, r.height) * 72)
    dpi = min(max(res, OCR_DPI), MAX_DPI)
    pixels = abs(page.rect) * (dpi / 72) ** 2
    return dpi * min(1.0, (MAX_PIXELS / pixels) ** 0.5) if pixels else dpi


def _orientation(page: fitz.Page, pts0: int) -> int:
    """
    The clockwise turn (0, 90, 270 or 180) that puts a page's text upright,
    from quick low-resolution readings: the first that reads like prose, else
    the one with clearly more real words than the page as it is (`pts0`).
    """
    best, need = 0, max(8, 2 * pts0)
    for turn in (90, 270, 180):
        pts, n = _score(_recognize(_render(page, ORIENT_DPI, turn)))
        if n >= 8 and pts >= 0.5 * n:
            return turn
        if pts >= need:
            best, need = turn, pts + 1
    return best


@lru_cache(maxsize=1)
def _glyph_extents() -> dict[str, tuple[float, float]]:
    """Per character of the layer font: how far its glyph rises above and drops below the baseline, in ems."""
    from fontTools.ttLib import TTFont

    tt = TTFont(str(LAYER_FONT))
    upm = tt["head"].unitsPerEm
    glyf = tt["glyf"]
    out = {}
    for code, name in tt.getBestCmap().items():
        g = glyf[name]
        out[chr(code)] = (g.yMax / upm, -g.yMin / upm) if g.numberOfContours else (0.0, 0.0)
    return out


def _ink(img: Image.Image, w: Word) -> tuple[float, float] | None:
    """Top and bottom of the ink inside a word's box."""
    box = (max(0, int(w.x0)), max(0, int(w.top) - 1), min(img.width, int(w.x1) + 1), min(img.height, int(w.bottom) + 2))
    if box[2] <= box[0] or box[3] <= box[1]:
        return None
    region = img.crop(box)
    lo, hi = region.getextrema()
    if hi - lo < 48:
        return None
    mid = (lo + hi) // 2
    hist = region.histogram()
    # Ink is whichever side of the midpoint has fewer pixels (light text on a dark band too).
    dark = sum(hist[:mid]) * 2 < sum(hist)
    bb = region.point(lambda v: 255 if (v < mid) == dark else 0).getbbox()
    return (box[1] + bb[1], box[1] + bb[3]) if bb else None


def _set_type(img: Image.Image, words: list[Word]) -> Line:
    """
    Baseline and type size of a line, from how far each word's ink reaches
    above and below it, given the glyphs it holds. Words without descenders
    sit right on the baseline.
    """
    ext = _glyph_extents()
    est: list[tuple[float, float, bool]] = []
    for w in words:
        up = max((ext[c][0] for c in w.text if c in ext), default=0.0)
        down = max((max(0.0, ext[c][1]) for c in w.text if c in ext), default=0.0)
        ink = _ink(img, w) if up >= 0.5 else None
        if ink and ink[1] - ink[0] >= 4:
            size = (ink[1] - ink[0]) / (up + down)
            est.append((ink[1] - down * size, size, down < 0.03))
    if est:
        size = statistics.median(s for _, s, _ in est)
        flat = [b for b, _, f in est if f]
        base = statistics.median(flat) if flat else statistics.median(b for b, _, _ in est)
    else:
        # Nothing measurable: fall back to Tesseract's box around the line.
        text = "".join(w.text for w in words)
        up = max((ext[c][0] for c in text if c in ext), default=0.7) or 0.7
        down = max((max(0.0, ext[c][1]) for c in text if c in ext), default=0.0)
        size = (words[0].bottom - words[0].top) / (up + down)
        base = words[0].bottom - down * size
    return Line(words, base, size)


def _join(lines: list[Line]) -> list[Line]:
    """
    Tesseract sometimes splits a line at a wide gap. Pieces that share a
    baseline and sit a word's gap apart become one line again, so the text
    keeps the space between them.
    """
    out: list[Line] = []
    for line in lines:
        for prev in out:
            s = max(prev.size, line.size)
            if abs(prev.baseline - line.baseline) < 0.2 * s and abs(prev.size - line.size) < 0.25 * s:
                gap = max(line.words[0].x0 - prev.words[-1].x1, prev.words[0].x0 - line.words[-1].x1)
                if -0.3 * s < gap < 1.5 * s:
                    if len(line.words) > len(prev.words):
                        prev.baseline, prev.size = line.baseline, line.size
                    prev.words = sorted(prev.words + line.words, key=lambda w: w.x0)
                    break
        else:
            out.append(line)
    return out


def _read(page: fitz.Page, pix: fitz.Pixmap | None = None) -> tuple[list[Line], float, int]:
    """OCR one page, turning it upright first if it reads better that way. Returns lines in pixels, the scale and the turn."""
    dpi = _dpi(page)
    pix = pix or _render(page, dpi)
    lines = _recognize(pix)
    pts, n = _score(lines)
    turn = 0
    # Prose read the right way up scores close to a point a word; only doubtful pages get turned around.
    if n >= 8 and pts < 0.3 * n:
        turn = _orientation(page, pts)
        if turn:
            _turn(page, turn)
            pix = _render(page, dpi)
            lines = _recognize(pix)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples).convert("L")
    return _join([_set_type(img, ws) for ws in lines]), pix.width / page.rect.width, turn


def _turn(page: fitz.Page, turn: int) -> None:
    page.set_rotation(turn)
    page.remove_rotation()


def _upright(page: fitz.Page, force: bool) -> fitz.Pixmap | None:
    """What every page to OCR goes through first, in a worker and again in the engine: the same steps give the same page."""
    if page.rotation:
        page.remove_rotation()
    return _rasterize(page) if force else None


def _read_pages(data: bytes, pnos: list[int], force: bool) -> dict[int, tuple[list[Line], float, int]]:
    """Worker side of ocr_pdf: its own copy of the PDF, these pages."""
    doc = fitz.open(stream=data, filetype="pdf")
    out = {}
    for pno in pnos:
        page = doc[pno]
        out[pno] = _read(page, _upright(page, force))
        pool.page_done(pno)
    return out


def _subset(chars: set[str]) -> bytes:
    from fontTools import subset
    from fontTools.ttLib import TTFont

    tt = TTFont(str(LAYER_FONT))
    opts = subset.Options()
    opts.hinting = False
    opts.layout_features = []
    opts.notdef_outline = True
    opts.drop_tables += ["FFTM"]
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=[ord(c) for c in chars | {" "}])
    sub.subset(tt)
    buf = io.BytesIO()
    tt.save(buf)
    return buf.getvalue()


def _add_layer(page: fitz.Page, lines: list[Line], scale: float, font_buf: bytes, font: fitz.Font) -> None:
    """Draw the words in invisible text (render mode 3), each stretched over its box, spaces filling the gaps."""
    if not lines:
        return
    doc = page.parent
    to_pdf = ~page.transformation_matrix
    ops = ["BT", "3 Tr"]
    for line in lines:
        size = line.size / scale
        if size < 1:
            continue
        ops.append(f"/{LAYER_NAME} {size:.2f} Tf")
        runs: list[tuple[str, float, float]] = []
        for i, w in enumerate(line.words):
            runs.append((w.text, w.x0, w.x1))
            if i + 1 < len(line.words):
                # Words whose ink touches (a j's tail under the colon before it) still get their space.
                nxt = line.words[i + 1].x0
                runs.append((" ", min(w.x1, nxt - 1), nxt))
        for text, a, b in runs:
            text = "".join(c for c in text if font.has_glyph(ord(c)))
            width = font.text_length(text, fontsize=size)
            if not text or width <= 0 or b <= a:
                continue
            p = fitz.Point(a / scale, line.baseline / scale) * to_pdf
            gids = "".join(f"{font.has_glyph(ord(c)):04x}" for c in text)
            ops.append(f"{100 * (b - a) / scale / width:.2f} Tz 1 0 0 1 {p.x:.2f} {p.y:.2f} Tm <{gids}> Tj")
    ops.append("ET")
    page.insert_font(fontname=LAYER_NAME, fontbuffer=font_buf)
    # Keep whatever state the page's own drawing leaves from reaching the layer.
    xref = doc.get_new_xref()
    doc.update_object(xref, "<<>>")
    doc.update_stream(xref, b"q\n" + page.read_contents() + b"\nQ\n" + "\n".join(ops).encode())
    page.set_contents(xref)


def _rasterize(page: fitz.Page) -> fitz.Pixmap:
    """Replace what a page draws with a picture of it (annotations and links stay). Returns the picture."""
    doc = page.parent
    dpi = _dpi(page)
    pix = page.get_pixmap(dpi=round(dpi), annots=False, colorspace=fitz.csRGB, alpha=False)
    r, g, b = Image.frombytes("RGB", (pix.width, pix.height), pix.samples).split()
    colorless = ImageChops.difference(r, g).getextrema()[1] < 12 and ImageChops.difference(g, b).getextrema()[1] < 12
    xref = doc.get_new_xref()
    doc.update_object(xref, "<<>>")
    doc.update_stream(xref, b" ")
    page.set_contents(xref)
    doc.xref_set_key(page.xref, "Resources", "<<>>")
    page.insert_image(page.rect, pixmap=fitz.Pixmap(fitz.csGRAY, pix) if colorless else pix)
    return pix


def ocr_pdf(data: bytes, force: bool) -> bytes:
    """
    Add a text layer to the pages that are scans. `force` rasterizes every
    page first, for PDFs whose existing text is garbage (fonts without a
    Unicode map).
    """
    from .pdf import page_kinds

    doc = fitz.open(stream=data, filetype="pdf")
    todo = [i for i, k in enumerate(page_kinds(doc)) if force or k == "scan"]
    if not todo:
        return data
    read = pool.pages(_read_pages, data, todo, force)
    for pno in todo:
        # The workers changed their own copies; this one gets the same steps.
        page = doc[pno]
        _upright(page, force)
        if read[pno][2]:
            _turn(page, read[pno][2])
    chars = {c for lines, _, _ in read.values() for line in lines for w in line.words for c in w.text}
    font_buf = _subset({c for c in chars if c in _glyph_extents()})
    font = fitz.Font(fontbuffer=font_buf)
    for pno, (lines, scale, _) in read.items():
        _add_layer(doc[pno], lines, scale, font_buf, font)
        guard.beat()
    return doc.tobytes(garbage=3, deflate=True)


def image_to_pdf(data: bytes) -> bytes:
    """JPEG/PNG/HEIC (and anything else Pillow reads) to a one-page PDF."""
    img = Image.open(io.BytesIO(data))
    fmt = img.format
    orientation = img.getexif().get(0x0112, 1)
    dpi = img.info.get("dpi", (0, 0))[0] or 0
    # Cameras say 72 dpi whatever they shot; a page that size would be read far too coarsely.
    dpi = dpi if 150 <= dpi <= 1200 else OCR_DPI
    doc = fitz.open()
    if fmt == "JPEG" and img.mode in ("RGB", "L") and orientation in (1, 3, 6, 8):
        # Keep the camera's own bytes and turn the picture on the page instead.
        turn = {1: 0, 3: 180, 6: 90, 8: 270}[orientation]
        w, h = (img.height, img.width) if turn in (90, 270) else img.size
        page = doc.new_page(width=w * 72 / dpi, height=h * 72 / dpi)
        page.insert_image(page.rect, stream=data, rotate=-turn)
        return doc.tobytes(garbage=3, deflate=True)
    img = ImageOps.exif_transpose(img)
    if img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        img = Image.new("RGB", rgba.size, (255, 255, 255))
        img.paste(rgba, mask=rgba.getchannel("A"))
    elif img.mode not in ("RGB", "L", "1"):
        img = img.convert("RGB")
    buf = io.BytesIO()
    if fmt in ("HEIF", "AVIF", "WEBP", "JPEG"):
        # Photos: a PNG of one would be several times the size for nothing.
        img.convert("RGB" if img.mode != "L" else "L").save(buf, format="JPEG", quality=92)
    else:
        img.save(buf, format="PNG")
    page = doc.new_page(width=img.width * 72 / dpi, height=img.height * 72 / dpi)
    page.insert_image(page.rect, stream=buf.getvalue())
    return doc.tobytes(garbage=3, deflate=True)


def raster_text(data: bytes, max_pages: int = 60) -> list[str]:
    """
    What a person (or a vision model) would read on each page: render it and
    OCR the pixels. Catches values drawn as shapes, stamped in images or left
    in a layer the text extractor can't see. Pages go to the workers.
    """
    count = min(fitz.open(stream=data, filetype="pdf").page_count, max_pages)
    read = pool.pages(_raster_pages, data, list(range(count)))
    return [read[p] for p in range(count)]


def _raster_pages(data: bytes, pnos: list[int]) -> dict[int, str]:
    doc = fitz.open(stream=data, filetype="pdf")
    out = {}
    for pno in pnos:
        out[pno] = "\n".join(" ".join(w.text for w in ws) for ws in _recognize(_render(doc[pno], 200)))
        pool.page_done(pno)
    return out


def read_codes(doc: fitz.Document, max_pages: int = 60) -> dict[int, list[str]]:
    """Decode every barcode and QR code on each page. Their contents can hold a name or an account number no text extractor sees."""
    import zxingcpp

    found: dict[int, list[str]] = {}
    for pno, page in enumerate(doc):
        if pno >= max_pages:
            break
        guard.beat()
        if not page.get_image_info() and not page.get_drawings():
            continue
        pix = page.get_pixmap(dpi=150, colorspace=fitz.csRGB, alpha=False)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        codes = [r.text for r in zxingcpp.read_barcodes(img) if r.text]
        if codes:
            found[pno] = codes
    return found
