"""PDF text extraction and in-place rewriting.

The Worker does all matching on the extracted text and sends back character
ranges with their replacements. Extraction is deterministic, so /rewrite
re-extracts the same file, checks the text hash, and maps each range back to
the glyphs on the page. Nothing here searches for strings.
"""

from __future__ import annotations

import difflib
import hashlib
import io
import math
import re
from dataclasses import dataclass, field

import pymupdf as fitz

from . import guard
from .paths import FONT_DIR

# Expand ligatures (so "ﬁ" matches "fi"), keep whitespace, and include text
# outside the visible page area: an AI reading the file would see it too.
FLAGS = fitz.TEXT_PRESERVE_WHITESPACE

FALLBACK_FONTS = {
    # (serif, bold, italic) -> file
    (False, False, False): "liberation/LiberationSans-Regular.ttf",
    (False, True, False): "liberation/LiberationSans-Bold.ttf",
    (False, False, True): "liberation/LiberationSans-Italic.ttf",
    (False, True, True): "liberation/LiberationSans-BoldItalic.ttf",
    (True, False, False): "liberation/LiberationSerif-Regular.ttf",
    (True, True, False): "liberation/LiberationSerif-Bold.ttf",
    (True, False, True): "liberation/LiberationSerif-Italic.ttf",
    (True, True, True): "liberation/LiberationSerif-BoldItalic.ttf",
}
MONO_FONT = "liberation/LiberationMono-Regular.ttf"


@dataclass
class Char:
    page: int
    line: tuple[int, int, int]  # (page, block, line)
    bbox: tuple[float, float, float, float]
    origin: tuple[float, float]
    size: float
    font: str
    color: int
    flags: int
    dir: tuple[float, float]
    alpha: int = 255


@dataclass
class Extracted:
    text: str
    chars: list[Char | None]
    fields: list[dict] = field(default_factory=list)

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.text.encode("utf-8")).hexdigest()


def open_pdf(data: bytes, password: str | None = None) -> fitz.Document:
    doc = fitz.open(stream=data, filetype="pdf")
    if doc.needs_pass:
        if not password or not doc.authenticate(password):
            raise PasswordRequired()
    return doc


class PasswordRequired(Exception):
    pass


PLAIN = {"\u00ad": "-", "\u2010": "-", "\u2011": "-", "\u00a0": " ", "\u202f": " ", "\u2007": " "}


def extract(doc: fitz.Document) -> Extracted:
    parts: list[str] = []
    chars: list[Char | None] = []

    def sep(s: str):
        for c in s:
            parts.append(c)
            chars.append(None)

    for pno, page in enumerate(doc):
        guard.beat()
        if pno > 0:
            sep("\n\n")
        d = page.get_text("rawdict", flags=FLAGS)
        # One character for one, so offsets hold: soft and Unicode hyphens read as "-", no-break spaces as " ".
        for bno, block in enumerate(d["blocks"]):
            if block.get("type") != 0:
                continue
            for lno, line in enumerate(block["lines"]):
                for span in line["spans"]:
                    for ch in span["chars"]:
                        for c in ch["c"]:
                            parts.append(PLAIN.get(c, c))
                            chars.append(
                                Char(
                                    page=pno,
                                    line=(pno, bno, lno),
                                    bbox=tuple(ch["bbox"]),
                                    origin=tuple(ch["origin"]),
                                    size=span["size"],
                                    font=span["font"],
                                    color=span["color"],
                                    flags=span["flags"],
                                    dir=tuple(line["dir"]),
                                    alpha=span.get("alpha", 255),
                                )
                            )
                sep("\n")
            sep("\n")
    return Extracted(text="".join(parts), chars=chars, fields=extract_fields(doc))


def extract_fields(doc: fitz.Document) -> list[dict]:
    """Text that lives outside the page content: bookmarks, annotations, form fields, links."""
    out: list[dict] = []
    for i, entry in enumerate(doc.get_toc(simple=False)):
        out.append({"id": f"toc:{i}", "text": entry[1]})
    for pno, page in enumerate(doc):
        for annot in page.annots() or []:
            info = annot.info
            if info.get("content"):
                out.append({"id": f"annot:{pno}:{annot.xref}", "text": info["content"]})
        for w in page.widgets() or []:
            if isinstance(w.field_value, str) and w.field_value.strip():
                out.append({"id": f"widget:{pno}:{w.xref}", "text": w.field_value})
        for i, link in enumerate(page.get_links()):
            if link.get("uri"):
                out.append({"id": f"link:{pno}:{i}", "text": link["uri"]})
    return out


def page_kinds(doc: fitz.Document) -> list[str]:
    """
    Per page: 'text'; 'scan' (an image, little or no text); 'ocr' (a scan that
    already has an invisible OCR text layer); or 'garbled' (text without a
    usable Unicode map, or drawn as outlines: no text at all but hundreds of
    vector shapes, as some "print to PDF" exports and plans do).
    """
    kinds = []
    for page in doc:
        guard.beat()
        text = page.get_text("text", flags=FLAGS)
        visible = [c for c in text if not c.isspace()]
        area = abs(page.rect)
        img_area = 0.0
        for info in page.get_image_info():
            r = fitz.Rect(info["bbox"]) & page.rect
            img_area += abs(r)
        if len(visible) < 20 and img_area > 0.3 * area:
            kinds.append("scan")
            continue
        if len(visible) < 20 and sum(len(d["items"]) for d in page.get_drawings()) > 300:
            kinds.append("garbled")
            continue
        if img_area > 0.5 * area:
            trace = page.get_texttrace()
            total = sum(len(t["chars"]) for t in trace)
            hidden = sum(len(t["chars"]) for t in trace if t["type"] == 3 or t["opacity"] == 0)
            if total and hidden / total > 0.9:
                kinds.append("ocr")
                continue
        bad = sum(1 for c in visible if c == "\ufffd" or 0xE000 <= ord(c) <= 0xF8FF or (ord(c) < 32))
        letters = sum(1 for c in visible if c.isalpha())
        if visible and (bad / len(visible) > 0.1 or letters / len(visible) < 0.3):
            kinds.append("garbled")
        else:
            kinds.append("text")
    return kinds


def regions_to_read(doc: fitz.Document) -> dict[int, list[tuple[float, float, float, float]] | None]:
    """
    What the output check OCRs, per page: on a picture page (a scan, a
    rasterized page) the areas around the words painted over; on a garbled
    page the whole page (None); otherwise only the areas whose picture could
    show what the text layer doesn't (images, text in a Type3 font, glyphs
    drawn as shapes), as up to three rectangles. A page of plain text, or a
    scan with nothing replaced, is left out: OCR would read back its text
    layer, already checked.
    """
    out: dict[int, list[tuple[float, float, float, float]] | None] = {}
    for pno, (page, kind) in enumerate(zip(doc, page_kinds(doc))):
        area = abs(page.rect) or 1
        image_area = sum(abs(fitz.Rect(i["bbox"]) & page.rect) for i in page.get_image_info())
        if kind in ("scan", "ocr") or image_area > 0.5 * area:
            # A page that is a picture (a scan, a rasterized page): what could still show a real value is
            # around the words painted over, if a patch fell short. Elsewhere its OCR layer was checked.
            patches = [d["rect"] for d in page.get_drawings() if d.get("fill") is not None and d["rect"].height < 60 and all(it[0] == "re" for it in d["items"])]
            if patches:
                merged = _cluster([r + (-r.height, -0.75 * r.height, r.height, 0.75 * r.height) for r in patches], page.rect, most=6)
                out[pno] = None if sum(abs(r) for r in merged) > 0.5 * area else [tuple(r) for r in merged]
            continue
        if kind != "text":
            out[pno] = None
            continue
        rects: list[fitz.Rect] = []
        for info in page.get_image_info():
            r = fitz.Rect(info["bbox"]) & page.rect
            if abs(r) > 0.001 * area and r.width > 12 and r.height > 6:
                rects.append(r)
        type3 = {_base(f[3]) for f in page.get_fonts(full=False) if f[2] == "Type3"}
        if type3:
            rects += [fitz.Rect(t["bbox"]) for t in page.get_texttrace() if _base(t["font"]) in type3]
        glyphs = [d["rect"] for d in page.get_drawings() if d.get("fill") is not None and d["rect"].height < 40 and any(it[0] == "c" for it in d["items"])]
        if len(glyphs) > 100:
            rects += glyphs
        if not rects:
            continue
        merged = _cluster([r + (-6, -6, 6, 6) for r in rects], page.rect)
        out[pno] = None if sum(abs(r) for r in merged) > 0.5 * area else [tuple(r) for r in merged]
    return out


def _cluster(rects: list[fitz.Rect], page: fitz.Rect, most: int = 3) -> list[fitz.Rect]:
    """Overlapping rectangles joined, then the closest pairs until at most `most` are left."""
    rs = [r & page for r in rects if not (r & page).is_empty]
    changed = True
    while changed:
        changed = False
        for i in range(len(rs)):
            for j in range(i + 1, len(rs)):
                if rs[i].intersects(rs[j]):
                    rs[i] = rs[i] | rs[j]
                    del rs[j]
                    changed = True
                    break
            if changed:
                break
    while len(rs) > most:
        best = min(((abs(rs[i] | rs[j]) - abs(rs[i]) - abs(rs[j]), i, j) for i in range(len(rs)) for j in range(i + 1, len(rs))))
        _, i, j = best
        rs[i] = rs[i] | rs[j]
        del rs[j]
    return rs


_font_cache: dict[str, fitz.Font] = {}

# Metric-compatible stand-ins, picked by the original font's name, so a word
# drawn in a substitute takes the same room and looks close to its neighbours.
NAME_FALLBACKS = [
    ("calibri", "crosextra/Carlito"),
    ("carlito", "crosextra/Carlito"),
    ("cambria", "crosextra/Caladea"),
    ("caladea", "crosextra/Caladea"),
    ("arial", "liberation/LiberationSans"),
    ("helvetica", "liberation/LiberationSans"),
    ("liberation sans", "liberation/LiberationSans"),
    ("liberationsans", "liberation/LiberationSans"),
    ("times", "liberation/LiberationSerif"),
    ("liberation serif", "liberation/LiberationSerif"),
    ("liberationserif", "liberation/LiberationSerif"),
    ("courier", "liberation/LiberationMono"),
]


def _style(c: Char) -> tuple[bool, bool]:
    name = c.font.lower()
    bold = bool(c.flags & 16) or "bold" in name or "black" in name or "heavy" in name
    italic = bool(c.flags & 2) or "italic" in name or "oblique" in name
    return bold, italic


def _load(path: str) -> fitz.Font | None:
    if path not in _font_cache:
        f = FONT_DIR / path
        _font_cache[path] = fitz.Font(fontfile=str(f)) if f.exists() else None
    return _font_cache[path]


def _fallback_font(c: Char) -> fitz.Font:
    bold, italic = _style(c)
    name = c.font.lower()
    suffix = {(False, False): "Regular", (True, False): "Bold", (False, True): "Italic", (True, True): "BoldItalic"}[(bold, italic)]
    for needle, family in NAME_FALLBACKS:
        if needle in name:
            f = _load(f"{family}-{suffix}.ttf")
            if f:
                return f
    if c.flags & 8 or "mono" in name:
        return _load("liberation/LiberationMono-Regular.ttf") or fitz.Font("cour")
    return _load(FALLBACK_FONTS[(bool(c.flags & 4) or "serif" in name and "sans" not in name, bold, italic)]) or fitz.Font("helv")


def _with_cmap(buf: bytes, unicode_to_gid: dict[int, int]) -> bytes | None:
    """
    Give an embedded subset font the Unicode map PDFs usually strip from it,
    using the glyph ids the page itself draws for each character. Without
    one, the font can't be used to write text by character.
    """
    try:
        from fontTools.ttLib import TTFont, newTable
        from fontTools.ttLib.tables._c_m_a_p import CmapSubtable

        font = TTFont(io.BytesIO(buf), lazy=False)
        order = font.getGlyphOrder()
        mapping = {u: order[g] for u, g in unicode_to_gid.items() if 0 <= g < len(order) and u <= 0xFFFF}
        if not mapping:
            return None
        sub = CmapSubtable.newSubtable(4)
        sub.platformID, sub.platEncID, sub.language = 3, 1, 0
        sub.cmap = mapping
        cmap = newTable("cmap")
        cmap.tableVersion = 0
        cmap.tables = [sub]
        font["cmap"] = cmap
        out = io.BytesIO()
        font.save(out)
        return out.getvalue()
    except Exception:
        return None


BASE14 = {
    "helvetica": "helv", "helvetica-bold": "hebo", "helvetica-oblique": "heit", "helvetica-boldoblique": "hebi",
    "times-roman": "tiro", "times-bold": "tibo", "times-italic": "tiit", "times-bolditalic": "tibi",
    "courier": "cour", "courier-bold": "cobo", "courier-oblique": "coit", "courier-boldoblique": "cobi",
    "symbol": "symb", "zapfdingbats": "zadb",
}


def _base(name: str) -> str:
    return name.split("+", 1)[-1]


class PageFonts:
    """
    The fonts a page actually uses, reusable for writing. Embedded fonts are
    taken from the file; standard ones map to PyMuPDF's built-ins. Fonts that
    weren't embedded at all fall back to a metric-compatible substitute, which
    is what a viewer shows anyway.
    """

    def __init__(self, doc: fitz.Document, page: fitz.Page):
        self.by_name: dict[str, list[fitz.Font]] = {}
        self.not_embedded: set[str] = set()
        # Which glyph the page draws for each character, per font.
        drawn: dict[str, dict[int, int]] = {}
        for span in page.get_texttrace():
            m = drawn.setdefault(_base(span["font"]), {})
            for u, gid, *_ in span["chars"]:
                if u >= 32 and gid >= 0:
                    m.setdefault(u, gid)
        for xref, ext, ftype, basefont, *_ in page.get_fonts(full=False):
            base = _base(basefont)
            if ftype == "Type3":
                continue
            if ext in ("n/a", ""):
                builtin = BASE14.get(base.lower().replace(",", "-"))
                if builtin:
                    self.by_name.setdefault(base, []).append(fitz.Font(builtin))
                else:
                    self.not_embedded.add(base)
                continue
            try:
                buf = doc.extract_font(xref)[3]
                if not buf:
                    continue
                font = fitz.Font(fontbuffer=buf)
                used = drawn.get(base, {})
                if used and not all(font.has_glyph(u) for u in list(used)[:40]):
                    repaired = _with_cmap(buf, used)
                    if repaired:
                        font = fitz.Font(fontbuffer=repaired)
                self.by_name.setdefault(base, []).append(font)
            except Exception:
                pass

    def for_text(self, c: Char, text: str) -> fitz.Font | None:
        """A font that can draw `text` the way `c` is drawn, or None."""
        base = _base(c.font)
        # A font without a name (ours, from an earlier rewrite, are like that) can't be told from the
        # page's other unnamed fonts: reusing the wrong one draws "p" for "a".
        if base in ("", "(null)"):
            return None
        for f in self.by_name.get(base, []):
            if all(ch.isspace() or f.has_glyph(ord(ch)) for ch in text):
                return f
        if base in self.not_embedded or base not in self.by_name:
            fb = _fallback_font(c)
            if all(ch.isspace() or fb.has_glyph(ord(ch)) for ch in text):
                return fb
        return None


def _union(boxes: list[tuple[float, float, float, float]]) -> fitz.Rect:
    r = fitz.Rect(boxes[0])
    for b in boxes[1:]:
        r |= fitz.Rect(b)
    return r


def _colors(page: fitz.Page, rect: fitz.Rect) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    """
    Paper and ink colour around a word on a scanned page: the most common
    colour along the box's border, and the average of the pixels inside that
    differ clearly from it. White text on a dark band stays white.
    """
    clip = fitz.Rect(rect.x0 - 2, rect.y0 - 2, rect.x1 + 2, rect.y1 + 2) & page.rect
    pix = page.get_pixmap(clip=clip, dpi=150, colorspace=fitz.csRGB, alpha=False)
    w, h = pix.width, pix.height
    counts: dict[tuple[int, int, int], int] = {}
    for x in range(w):
        for y in (0, 1, h - 2, h - 1):
            p = pix.pixel(x, max(0, min(h - 1, y)))[:3]
            counts[p] = counts.get(p, 0) + 1
    for y in range(h):
        for x in (0, 1, w - 2, w - 1):
            p = pix.pixel(max(0, min(w - 1, x)), y)[:3]
            counts[p] = counts.get(p, 0) + 1
    bg = max(counts, key=counts.get) if counts else (255, 255, 255)
    inked: list[tuple[int, tuple[int, int, int]]] = []
    for y in range(2, h - 2):
        for x in range(2, w - 2):
            p = pix.pixel(x, y)[:3]
            d = sum(abs(p[i] - bg[i]) for i in range(3))
            if d > 180:
                inked.append((d, p))
    if inked:
        # The strongest third: glyph cores, not their anti-aliased edges.
        inked.sort(key=lambda t: t[0], reverse=True)
        core = inked[: max(1, len(inked) // 3)]
        ink = tuple(sum(p[i] for _, p in core) / len(core) / 255 for i in range(3))
    else:
        ink = (1.0, 1.0, 1.0) if sum(bg) < 3 * 110 else (0.08, 0.08, 0.08)
    return tuple(v / 255 for v in bg), ink


# The OCR layer (ocr.py) is set at the Liberation Sans size whose glyphs match
# each line's ink, but squeezing a word onto its box changes the size extraction
# reports: it reads about 3% small (1.01-1.04 measured on 11 and 16 pt sans and
# serif scans). Its baselines are within half a point.
OCR_SIZE_FACTOR = 1.03


def _rgb(color: int) -> tuple[float, float, float]:
    return ((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255


def _squeeze(font: fitz.Font, text: str, size: float, width: float, max_stretch: float = 1.0) -> tuple[float, float]:
    """Horizontal scale (and font size) so `text` fits in `width`, stretching a short one by at most `max_stretch`."""
    natural = font.text_length(text, fontsize=size)
    if natural <= 0 or width <= 0:
        return 1.0, size
    if natural < width:
        return min(width / natural, max_stretch), size
    if natural > width * 1.02:
        sx = width / natural
        if sx < 0.6:
            # Too long to squeeze legibly: shrink the type instead.
            return 0.6, size * sx / 0.6
        return sx, size
    return 1.0, size


def _write(page: fitz.Page, origin: tuple[float, float], text: str, font: fitz.Font, size: float, color, sx: float, direction=(1.0, 0.0)):
    mat = fitz.Matrix(sx, 0, 0, 1, 0, 0)
    cos, sin = direction
    if abs(cos - 1) > 1e-3:
        mat = mat * fitz.Matrix(math.degrees(math.atan2(sin, cos)))
    try:
        tw = fitz.TextWriter(page.rect, color=color)
        tw.append(origin, text, font=font, fontsize=size)
        tw.write_text(page, morph=(fitz.Point(origin), mat))
    except Exception:
        # MuPDF can't write with some fonts ("substitute font creation is not implemented yet"):
        # the replacement goes in a bundled font rather than failing the whole document.
        tw = fitz.TextWriter(page.rect, color=color)
        tw.append(origin, text, font=_load("liberation/LiberationSans-Regular.ttf") or fitz.Font("helv"), fontsize=size)
        tw.write_text(page, morph=(fitz.Point(origin), mat))


def _groups(ex: Extracted, rep: dict) -> list[list[Char]]:
    groups: list[list[Char]] = []
    for i in range(rep["start"], rep["end"]):
        c = ex.chars[i]
        if c is None:
            continue
        if groups and groups[-1][0].line == c.line:
            groups[-1].append(c)
        else:
            groups.append([c])
    return groups


def rewrite(doc: fitz.Document, sha256: str, replacements: list[dict], fields: list[dict], scanned_pages: set[int]) -> dict:
    ex = extract(doc)
    if ex.sha256 != sha256:
        raise ValueError("document text changed since it was analyzed")
    kinds = page_kinds(doc)
    pixel_pages = set(scanned_pages) | {i for i, k in enumerate(kinds) if k in ("scan", "ocr")}

    by_page: dict[int, list[dict]] = {}
    for rep in sorted(replacements, key=lambda r: r["start"]):
        groups = _groups(ex, rep)
        if groups:
            by_page.setdefault(groups[0][0].page, []).append(rep)
            # A value continuing onto the next page is cleared there too.
            for g in groups[1:]:
                if g[0].page != groups[0][0].page:
                    by_page.setdefault(g[0].page, [])

    new_fields = {f["id"]: f["text"] for f in fields}

    # Redaction drops links it overlaps, and PyMuPDF caches a page's link list,
    # so take every link off first (with its new target) and put them back at the end.
    saved_links: dict[int, list[dict]] = {}
    for pno in range(doc.page_count):
        page = doc[pno]
        links = page.get_links()
        for i, link in enumerate(links):
            key = f"link:{pno}:{i}"
            page.delete_link(link)
            if key in new_fields and link.get("uri"):
                link["uri"] = new_fields[key]
        if links:
            saved_links[pno] = links
        # Page objects cache their links; drop this one so later lookups start fresh.
        del page

    stats = {"replaced": 0, "retypeset_pages": 0, "patched_pages": 0, "retypeset_rejected": 0}
    for pno, reps in sorted(by_page.items()):
        guard.beat()
        page = doc[pno]
        ok = pno not in pixel_pages and _retypeset_ok(doc, pno, ex, reps)
        if pno not in pixel_pages and not ok:
            stats["retypeset_rejected"] += 1
        if ok and _retypeset(doc, page, pno, ex, reps):
            stats["retypeset_pages"] += 1
        else:
            _patch(page, pno, ex, reps, scanned=pno in pixel_pages)
            stats["patched_pages"] += 1
        stats["replaced"] += len(reps)
        del page

    for pno, links in saved_links.items():
        page = doc[pno]
        for link in links:
            page.insert_link({k: v for k, v in link.items() if k not in ("xref", "id")})

    apply_fields(doc, new_fields)

    doc.set_metadata({})
    doc.del_xml_metadata()
    options = dict(
        attached_files=True,
        clean_pages=True,
        embedded_files=True,
        hidden_text=False,
        javascript=True,
        metadata=True,
        redactions=False,
        remove_links=False,
        reset_fields=False,
        reset_responses=True,
        thumbnails=True,
        xml_metadata=True,
    )
    try:
        doc.scrub(**options)
    except Exception:
        # A link put back above can leave MuPDF's annotation list stale ("xref 729 is not an annot of this page"):
        # scrub without walking annotations, and drop replies to comments (which can hold names) by xref.
        doc.scrub(**{**options, "reset_responses": False})
        for pno in range(doc.page_count):
            page = doc[pno]
            for xref in page.annot_xrefs():
                if doc.xref_get_key(xref[0], "IRT")[0] != "null":
                    doc.xref_set_key(xref[0], "Contents", "()")
            del page
    return stats


def _page_text(ex: Extracted, pno: int, reps: list[dict]) -> str:
    """What page `pno` should read after the replacements, without whitespace."""
    out = []
    starts = {r["start"]: r for r in reps}
    skip_to = -1
    for i, c in enumerate(ex.chars):
        if i < skip_to:
            continue
        if i in starts:
            out.append(starts[i]["text"])
            skip_to = starts[i]["end"]
            continue
        if c is not None and c.page == pno and c.alpha != 0:
            out.append(ex.text[i])
    return re.sub(r"\s+", "", "".join(out))


def _retypeset_ok(doc: fitz.Document, pno: int, ex: Extracted, reps: list[dict]) -> bool:
    """
    Retypeset a copy of the page and read it back: only when it reads exactly
    as it should (same characters, the replacements in) does the real page get
    retypeset. A font that maps letters to the wrong glyphs, or a substitute
    that spaces letters apart, shows up here, and the page is patched instead.
    """
    scratch = fitz.open()
    scratch.insert_pdf(doc, from_page=pno, to_page=pno)
    try:
        if not _retypeset(scratch, scratch[0], pno, ex, reps):
            return False
        got = re.sub(r"\s+", "", scratch[0].get_text("text", flags=FLAGS))
    except Exception:
        return False
    want = _page_text(ex, pno, reps)
    return got == want or difflib.SequenceMatcher(None, got, want, autojunk=False).ratio() >= 0.995


def _retypeset(doc: fitz.Document, page: fitz.Page, pno: int, ex: Extracted, reps: list[dict]) -> bool:
    """
    Rewrite every glyph on the page, in reading order, each at its exact
    original position and in the document's own font, with replacements
    slotted in. The page looks the same, and the replacements sit in the text
    flow where the originals were, which matters to anything that reads the
    PDF's text in stream order.

    Returns False (changing nothing) when the page's fonts can't be reused.
    """
    fonts = PageFonts(doc, page)
    first: dict[int, tuple[dict, list[Char]]] = {}
    covered: set[int] = set()
    for rep in reps:
        idx = [i for i in range(rep["start"], rep["end"]) if ex.chars[i] is not None and ex.chars[i].page == pno]
        if not idx:
            continue
        covered.update(idx)
        groups = [g for g in _groups(ex, rep) if g[0].page == pno]
        first[idx[0]] = (rep, groups[0])

    items: list[tuple] = []
    for i, c in enumerate(ex.chars):
        if c is None or c.page != pno:
            continue
        if i in first:
            rep, group = first[i]
            font = fonts.for_text(group[0], rep["text"]) or _fallback_font(group[0])
            items.append(("rep", rep["text"], group[0], font, _union([g.bbox for g in group]).width))
            continue
        if i in covered:
            continue
        ch = ex.text[i]
        if ch.isspace() or c.alpha == 0:
            # Spaces need no ink; hidden text isn't carried over.
            continue
        font = fonts.for_text(c, ch)
        if font is None:
            return False
        items.append(("char", ch, c, font))

    page.add_redact_annot(page.rect, fill=False)
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE, text=fitz.PDF_REDACT_TEXT_REMOVE)

    # Replacements rarely match the original's width. On a horizontal line the
    # rest of the line moves over, as if the text had been edited; only when
    # that would run past the right margin is the replacement squeezed.
    right_margin = max((c.bbox[2] for c in ex.chars if c is not None and c.page == pno), default=page.rect.x1)
    line_end: dict[tuple, float] = {}
    for c in ex.chars:
        if c is not None and c.page == pno:
            line_end[c.line] = max(line_end.get(c.line, 0.0), c.bbox[2])

    tw: fitz.TextWriter | None = None
    tw_color = None
    offset = 0.0
    current_line = None

    def flush():
        nonlocal tw
        if tw is not None:
            tw.write_text(page)
            tw = None

    for item in items:
        kind, text, c, font = item[:4]
        if c.line != current_line:
            current_line, offset = c.line, 0.0
        color = _rgb(c.color)
        horizontal = abs(c.dir[0] - 1) < 1e-3 and abs(c.dir[1]) < 1e-3
        origin = (c.origin[0] + offset, c.origin[1]) if horizontal else c.origin
        if kind == "char" and horizontal:
            if tw is None or tw_color != color:
                flush()
                tw = fitz.TextWriter(page.rect, color=color)
                tw_color = color
            tw.append(origin, text, font=font, fontsize=c.size)
            continue
        flush()
        if kind == "char":
            _write(page, origin, text, font, c.size, color, 1.0, c.dir)
            continue
        old_width = item[4]
        if not horizontal:
            sx, size = _squeeze(font, text, c.size, old_width, max_stretch=1.06)
            _write(page, origin, text, font, size, color, sx, c.dir)
            continue
        natural = font.text_length(text, fontsize=c.size)
        room = max(0.0, right_margin - (line_end[c.line] + offset))
        delta = natural - old_width
        if delta <= room:
            _write(page, origin, text, font, c.size, color, 1.0)
            offset += delta
        else:
            sx, size = _squeeze(font, text, c.size, old_width + room)
            _write(page, origin, text, font, size, color, sx)
            offset += room
    flush()
    return True


def _patch(page: fitz.Page, pno: int, ex: Extracted, reps: list[dict], scanned: bool) -> None:
    """
    Remove just the replaced glyphs and draw the replacements on top. Used for
    scans (where the pixels under each word are painted over with the paper
    colour) and for pages whose fonts can't be reused.
    """
    rects: list[fitz.Rect] = []
    writes: list[tuple] = []
    for rep in reps:
        for gi, g in enumerate(_groups(ex, rep)):
            if g[0].page != pno:
                continue
            rect = _union([c.bbox for c in g])
            h = rect.height
            # Trim text boxes top and bottom so ascenders and descenders of neighbouring lines stay put.
            rects.append(rect if scanned else fitz.Rect(rect.x0, rect.y0 + h * 0.125, rect.x1, rect.y1 - h * 0.125))
            if gi == 0:
                writes.append((rep["text"], g[0], rect, len(rects) - 1))

    colors = {i: _colors(page, r) for i, r in enumerate(rects)} if scanned else {}
    if scanned:
        # Pad a little so no anti-aliased edge of the old word survives around the patch.
        rects = [fitz.Rect(r.x0 - 0.75, r.y0 - 0.75, r.x1 + 0.75, r.y1 + 0.75) for r in rects]
    for r in rects:
        page.add_redact_annot(r, fill=False)
    page.apply_redactions(
        images=fitz.PDF_REDACT_IMAGE_PIXELS if scanned else fitz.PDF_REDACT_IMAGE_NONE,
        graphics=fitz.PDF_REDACT_LINE_ART_NONE,
        text=fitz.PDF_REDACT_TEXT_REMOVE,
    )
    for i, (bg, _) in colors.items():
        # Wider than the redaction: image pixels it only grazed are blanked to white, a frame on a dark band.
        r = rects[i]
        page.draw_rect(fitz.Rect(r.x0 - 0.75, r.y0 - 0.75, r.x1 + 0.75, r.y1 + 0.75), color=None, fill=bg, width=0, overlay=True)

    fonts = None if scanned else PageFonts(page.parent, page)
    for text, c, rect, ri in writes:
        if scanned:
            # The OCR layer's font says nothing about the printed one; sans is the common case.
            font = _fallback_font(Char(**{**c.__dict__, "font": "sans", "flags": c.flags & ~4}))
            size = max(4.0, c.size * OCR_SIZE_FACTOR)
            origin = (rect.x0, c.origin[1])
            color = colors[ri][1]
        else:
            font = fonts.for_text(c, text) or _fallback_font(c)
            size, origin, color = c.size, c.origin, _rgb(c.color)
        sx, size = _squeeze(font, text, size, rect.width, max_stretch=1.06)
        _write(page, origin, text, font, size, color, sx, c.dir)


def apply_fields(doc: fitz.Document, new: dict[str, str]) -> None:
    if not new:
        return
    toc = doc.get_toc(simple=False)
    changed = False
    for i, entry in enumerate(toc):
        if f"toc:{i}" in new:
            entry[1] = new[f"toc:{i}"]
            changed = True
    if changed:
        doc.set_toc(toc)
    for pno, page in enumerate(doc):
        for annot in page.annots() or []:
            key = f"annot:{pno}:{annot.xref}"
            info = annot.info
            # Authors are dropped outright; content is rewritten when it held a value.
            annot.set_info(content=new.get(key, info.get("content", "")), title="", subject=info.get("subject", ""))
            annot.update()
        for w in page.widgets() or []:
            key = f"widget:{pno}:{w.xref}"
            if key in new:
                w.field_value = new[key]
                w.update()


def save(doc: fitz.Document) -> bytes:
    # Never incremental: earlier revisions in an appended file would still hold the real text.
    return doc.tobytes(garbage=4, deflate=True, clean=True)
