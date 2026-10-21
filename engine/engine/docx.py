"""DOCX extraction and rewriting at the XML level.

Text is read paragraph by paragraph across runs, so a name Word split over
three runs ("Jean-", "Fran", "çois") is still one string to match. A
replacement goes into the first run it touches (keeping that run's
formatting) and the other runs lose those characters.
"""

from __future__ import annotations

import hashlib
import io
import re
import zipfile
from dataclasses import dataclass, field

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"

TEXT_PART = re.compile(r"^word/(glossary/)?(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$")
PART_ORDER = ["document", "header", "footer", "footnotes", "endnotes", "comments"]


def w(tag: str) -> str:
    return f"{{{W}}}{tag}"


SEPARATORS = {w("tab"): "\t", w("br"): "\n", w("cr"): "\n", w("noBreakHyphen"): "-"}
DELETED = {w("del"), w("moveFrom")}


@dataclass
class Extracted:
    text: str
    # (part name, index of the w:t element in that part, offset in its text)
    chars: list[tuple[str, int, int] | None]
    fields: list[dict] = field(default_factory=list)
    trees: dict[str, etree._Element] = field(default_factory=dict)

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.text.encode("utf-8")).hexdigest()


def _part_key(name: str) -> tuple[int, str]:
    base = re.sub(r"^word/(glossary/)?", "", name).removesuffix(".xml")
    kind = re.sub(r"\d+$", "", base)
    return (PART_ORDER.index(kind) if kind in PART_ORDER else 99, name)


def _nearest_p(el: etree._Element) -> etree._Element | None:
    p = el.getparent()
    while p is not None and p.tag != w("p"):
        p = p.getparent()
    return p


def _deleted(el: etree._Element) -> bool:
    p = el.getparent()
    while p is not None:
        if p.tag in DELETED:
            return True
        p = p.getparent()
    return False


def _parse(data: bytes) -> tuple[list[zipfile.ZipInfo], dict[str, bytes]]:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        infos = z.infolist()
        return infos, {i.filename: z.read(i.filename) for i in infos}


def extract(data: bytes) -> Extracted:
    _, files = _parse(data)
    names = sorted((n for n in files if TEXT_PART.match(n)), key=_part_key)
    parts: list[str] = []
    chars: list[tuple[str, int, int] | None] = []
    trees: dict[str, etree._Element] = {}

    def sep(s: str):
        for c in s:
            parts.append(c)
            chars.append(None)

    for n_i, name in enumerate(names):
        if n_i > 0:
            sep("\n\n")
        tree = etree.fromstring(files[name])
        trees[name] = tree
        # Keep the element list alive: lxml proxies (and their ids) only last while referenced.
        ts = list(tree.iter(w("t")))
        t_index = {t: i for i, t in enumerate(ts)}
        for p in tree.iter(w("p")):
            for el in p.iter(w("t"), *SEPARATORS.keys()):
                if _nearest_p(el) is not p or _deleted(el):
                    continue
                if el.tag == w("t"):
                    ti = t_index[el]
                    for k, c in enumerate(el.text or ""):
                        parts.append(c)
                        chars.append((name, ti, k))
                else:
                    sep(SEPARATORS[el.tag])
            sep("\n")
    return Extracted(text="".join(parts), chars=chars, fields=_fields(files, trees), trees=trees)


def _fields(files: dict[str, bytes], trees: dict[str, etree._Element]) -> list[dict]:
    """Text outside the body flow: field codes, image descriptions, hyperlink targets."""
    out: list[dict] = []
    for name, tree in trees.items():
        for i, el in enumerate(tree.iter(w("instrText"))):
            if (el.text or "").strip():
                out.append({"id": f"instr:{name}:{i}", "text": el.text})
        for i, el in enumerate(tree.iter(w("fldSimple"))):
            if el.get(w("instr")):
                out.append({"id": f"fldsimple:{name}:{i}", "text": el.get(w("instr"))})
        for i, el in enumerate(tree.iter(f"{{{WP}}}docPr")):
            for attr in ("descr", "title"):
                if el.get(attr):
                    out.append({"id": f"docpr:{name}:{i}:{attr}", "text": el.get(attr)})
    for name, raw in files.items():
        if not name.startswith("word/_rels/") or not name.endswith(".rels"):
            continue
        tree = etree.fromstring(raw)
        for rel in tree.iter(f"{{{REL}}}Relationship"):
            if rel.get("TargetMode") == "External" and rel.get("Target"):
                out.append({"id": f"rel:{name}:{rel.get('Id')}", "text": rel.get("Target")})
    return out


def rewrite(data: bytes, sha256: str, replacements: list[dict], fields: list[dict]) -> tuple[bytes, dict]:
    infos, files = _parse(data)
    ex = extract(data)
    if ex.sha256 != sha256:
        raise ValueError("document text changed since it was analyzed")

    # Edits per w:t element: (start offset, end offset, inserted text).
    edits: dict[tuple[str, int], list[tuple[int, int, str]]] = {}
    for rep in replacements:
        pos = [ex.chars[i] for i in range(rep["start"], rep["end"]) if ex.chars[i] is not None]
        if not pos:
            continue
        by_t: dict[tuple[str, int], list[int]] = {}
        for part, ti, off in pos:
            by_t.setdefault((part, ti), []).append(off)
        for n, (key, offs) in enumerate(by_t.items()):
            edits.setdefault(key, []).append((min(offs), max(offs) + 1, rep["text"] if n == 0 else ""))

    for name, tree in ex.trees.items():
        ts = list(tree.iter(w("t")))
        for (part, ti), es in edits.items():
            if part != name:
                continue
            t = ts[ti]
            s = t.text or ""
            for a, b, ins in sorted(es, reverse=True):
                s = s[:a] + ins + s[b:]
            t.text = s
            t.set(XML_SPACE, "preserve")
        _strip_history(tree)

    new_fields = {f["id"]: f["text"] for f in fields}
    _apply_fields(ex.trees, files, new_fields)

    out_files = dict(files)
    for name, tree in ex.trees.items():
        out_files[name] = etree.tostring(tree, xml_declaration=True, encoding="UTF-8", standalone=True)
    _scrub_props(out_files)

    warnings = []
    if any(n.startswith("word/embeddings/") for n in files):
        warnings.append("embedded files (charts, spreadsheets, objects) were not checked")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for info in infos:
            z.writestr(info, out_files[info.filename], compress_type=info.compress_type)
    return buf.getvalue(), {"replaced": len(replacements), "warnings": warnings}


def _strip_history(tree: etree._Element) -> None:
    """Accept tracked changes: deleted text goes, inserted text stays, and nobody's name is left on a revision."""
    for tag in ("del", "moveFrom", "rPrChange", "pPrChange", "sectPrChange", "tblPrChange", "trPrChange", "tcPrChange", "numberingChange"):
        for el in list(tree.iter(w(tag))):
            el.getparent().remove(el)
    for tag in ("ins", "moveTo"):
        for el in list(tree.iter(w(tag))):
            parent = el.getparent()
            idx = parent.index(el)
            for child in list(el):
                parent.insert(idx, child)
                idx += 1
            parent.remove(el)
    for tag in ("moveFromRangeStart", "moveFromRangeEnd", "moveToRangeStart", "moveToRangeEnd"):
        for el in list(tree.iter(w(tag))):
            el.getparent().remove(el)
    for el in tree.iter():
        for attr in (w("author"), w("initials")):
            if attr in el.attrib:
                el.set(attr, "")


def _apply_fields(trees: dict[str, etree._Element], files: dict[str, bytes], new: dict[str, str]) -> None:
    for name, tree in trees.items():
        for i, el in enumerate(tree.iter(w("instrText"))):
            key = f"instr:{name}:{i}"
            if key in new:
                el.text = new[key]
        for i, el in enumerate(tree.iter(w("fldSimple"))):
            key = f"fldsimple:{name}:{i}"
            if key in new:
                el.set(w("instr"), new[key])
        for i, el in enumerate(tree.iter(f"{{{WP}}}docPr")):
            for attr in ("descr", "title"):
                key = f"docpr:{name}:{i}:{attr}"
                if key in new:
                    el.set(attr, new[key])
    for name in list(files):
        if not name.startswith("word/_rels/") or not name.endswith(".rels"):
            continue
        tree = etree.fromstring(files[name])
        changed = False
        for rel in tree.iter(f"{{{REL}}}Relationship"):
            key = f"rel:{name}:{rel.get('Id')}"
            if key in new:
                rel.set("Target", new[key])
                changed = True
        if changed:
            files[name] = etree.tostring(tree, xml_declaration=True, encoding="UTF-8", standalone=True)


def _scrub_props(files: dict[str, bytes]) -> None:
    """Author, company, title and custom properties often carry names."""
    if "docProps/core.xml" in files:
        tree = etree.fromstring(files["docProps/core.xml"])
        for el in tree:
            local = etree.QName(el).localname
            if local in ("creator", "lastModifiedBy", "title", "subject", "keywords", "description", "category", "contentStatus", "identifier"):
                el.text = ""
        files["docProps/core.xml"] = etree.tostring(tree, xml_declaration=True, encoding="UTF-8", standalone=True)
    if "docProps/app.xml" in files:
        tree = etree.fromstring(files["docProps/app.xml"])
        for el in tree:
            if etree.QName(el).localname in ("Company", "Manager", "HyperlinkBase"):
                el.text = ""
        files["docProps/app.xml"] = etree.tostring(tree, xml_declaration=True, encoding="UTF-8", standalone=True)
    if "docProps/custom.xml" in files:
        tree = etree.fromstring(files["docProps/custom.xml"])
        for el in list(tree):
            tree.remove(el)
        files["docProps/custom.xml"] = etree.tostring(tree, xml_declaration=True, encoding="UTF-8", standalone=True)
    if "word/people.xml" in files:
        tree = etree.fromstring(files["word/people.xml"])
        for el in list(tree):
            tree.remove(el)
        files["word/people.xml"] = etree.tostring(tree, xml_declaration=True, encoding="UTF-8", standalone=True)
