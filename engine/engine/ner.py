"""Names, addresses and identifiers found by a small token classifier.

The model is nym-pii-multilingual-small (MIT, mmBERT-small, int8 ONNX,
pinned in ner.lock.json): one pass over the text, about 0.1 s per 1,000
characters on an M1, French and English. Its 40 fine-grained labels are
merged into the app's types here; the app's rules (regex, dates of birth by
context, known values) run on top of it.

Three things make it work on documents rather than prose:
- runs of spaces (table columns) are shortened before tokenizing, since they
  cost tokens and carry nothing;
- words in capitals are read in title case ("JACQUES RICARD" → "Jacques
  Ricard"), which the model knows much better;
- windows are whole lines of up to 64 tokens, so a number-heavy table row
  doesn't drown the name in it.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
from pathlib import Path

from . import guard
from .paths import BASE

MODEL_DIR = Path(os.environ.get("ANON_NER_DIR") or BASE / "ner")
LEXICON = BASE / "lexicon"
WINDOW = 64
BATCH = 16
THRESHOLD = 0.25
# Recall first (the model author's mode for redaction): a token is an entity when
# P(not O) reaches THRESHOLD, labelled with its likeliest entity. Missing a name
# costs more than an extra swap the reviewer can untick.
RECALL_FIRST = os.environ.get("ANON_NER_MODE", "recall") == "recall"

# nym label → app type; "name" and "street" are merged into people and addresses below.
TYPES = {
    "GIVEN_NAME": "name", "SURNAME": "name",
    "COMPANY_NAME": "organization",
    "STREET_ADDRESS": "street", "BUILDING_NUMBER": "street", "STREET_NAME": "street", "SECONDARY_ADDRESS": "street",
    "ZIP_CODE": "postal_code", "EMAIL": "email", "PHONE": "phone", "FAX_NUMBER": "phone",
    "SSN": "sin", "TAX_ID": "id_number", "GOVERNMENT_ID": "id_number", "PASSPORT": "id_number",
    "DRIVERS_LICENSE": "id_number", "LICENSE_PLATE": "id_number", "CUSTOMER_ID": "id_number",
    "EMPLOYEE_ID": "id_number", "MEDICAL_RECORD_NUMBER": "id_number",
    "ACCOUNT_NUMBER": "bank_account", "IBAN": "bank_account", "ROUTING_NUMBER": "bank_account", "SWIFT_BIC": "bank_account",
    "CREDIT_DEBIT_CARD": "card_number", "DATE_OF_BIRTH": "dob", "USERNAME": "other", "URL": "other",
}
NUMBERED = {"phone", "sin", "id_number", "bank_account", "card_number", "postal_code"}
NOT_AN_ID = re.compile(
    r"[-+−]?\$?\s?\d{1,3}(?:[ \u00a0,.]\d{3})+(?:[.,]\d{1,2})?\s?\$?"  # 1 000 000, 2 285.55, -11 735
    r"|[-+]?\d+[.,]\d+\s?%?"  # 6.875, 4.2878
    r"|\d{1,2}[-/.]\d{1,2}[-/.](?:19|20)\d\d|(?:19|20)\d\d[-/.]\d{1,2}(?:[-/.]\d{1,2})?"  # dates, year-months
    r"|(?:19|20)\d\d\s?[-/]\s?(?:19|20)?\d\d"  # fiscal years
)
STREET_WORD = re.compile(
    r"\b(?:rue|avenue|av|boulevard|boul|blvd|chemin|ch|route|rte|rang|mont[ée]e|c[ôo]te|croissant|terrasse|impasse|all[ée]e|promenade|place|carr[ée]|"
    r"concession|street|st|road|rd|drive|dr|crescent|cres|court|ct|lane|ln|way|parkway|pkwy|terrace|circle|highway|hwy|trail|line|sideroad|square|grove|heights|row|close|path)\b",
    re.IGNORECASE,
)
ORG_AND_PERSON = re.compile(r"\s+(?:&|et|and)\s+([A-ZÀ-ÖØ-Þ][a-zà-ÿ'’-]+)(?=\s+[A-ZÀ-ÖØ-Þ])")
ORG_THEN_FIRST = re.compile(r"\s+(?:&|et|and)\s+([A-ZÀ-ÖØ-Þ][a-zà-ÿ'’-]+)\s*$")
JOINER = re.compile(r"\s+(?:et|and|ou|or|&)\s+|\s*[,;/]\s*|\s+-\s+", re.IGNORECASE)
NAME_WORDS = re.compile(r"(?<![\w-])[A-ZÀ-ÖØ-Þ][\w'’.-]*(?: [A-ZÀ-ÖØ-Þ][\w'’.-]*){1,3}(?![\w-])")
CAPS_WORD = re.compile(r"\b[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ'’-]{2,}\b")

_lock = threading.Lock()
_model = None
_lexicon: tuple[frozenset[str], frozenset[str]] | None = None

TITLES = r"(?:m|mme|mlle|me|mr|mrs|ms|miss|dr|dre|monsieur|madame|maître|maitre|docteur|docteure)\.?"
# Form fields whose value is a name, even an ordinary-looking word ("Prénom : Rose").
NAME_LABEL = re.compile(
    r"(?:pr[ée]nom|nom(?: de famille)?|first name|last name|given name|surname|family name|name)s?\s*(?:\(s\))?\s*[:\-]?\s*$",
    re.IGNORECASE,
)
LEGAL = re.compile(
    r"\b(?:inc|ltée|ltee|limitée|ltd|llc|corp|corporation|cie|enr|s\.?e\.?n\.?c\.?(?:r\.?l\.?)?|senc|s\.?a\.?|sa|coop|coopérative|fiducie|trust|holding|holdings|gestion|immobilier|immobilière|associés)\b\.?",
    re.IGNORECASE,
)


def _fold(s: str) -> str:
    import unicodedata

    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def lexicon() -> tuple[frozenset[str], frozenset[str]]:
    """(ordinary French and English words, first names), lowercased, each also without accents."""
    global _lexicon
    if _lexicon is None:
        import gzip

        def load(name: str) -> frozenset[str]:
            path = LEXICON / name
            if not path.exists():
                return frozenset()
            with gzip.open(path, "rt", encoding="utf-8") as f:
                ws = {w.strip() for w in f if w.strip()}
            return frozenset(ws | {_fold(w) for w in ws})

        _lexicon = (load("words.txt.gz"), load("first-names.txt.gz"))
    return _lexicon


def _lowercase_words(text: str) -> set[str]:
    """Words the document itself writes in lowercase, so ordinary words in it: "montant", "locataire". Emails and links aside, which spell names in lowercase."""
    plain = re.sub(r"\S+@\S+|https?://\S+|www\.\S+", " ", text)
    return set(re.findall(r"(?<![\w@.])[a-zà-ÿ][a-zà-ÿ'’-]+", plain))


class _Ordinary:
    """Is a capitalised word an ordinary word here, not a name?"""

    def __init__(self, text: str):
        self.words, self.first = lexicon()
        self.lower = _lowercase_words(text)

    def __call__(self, word: str) -> bool:
        w = word.lower().strip("'’.-")
        if len(w) < 2 or not any(c.isalpha() for c in w):
            return False
        if w in self.first or _fold(w) in self.first:
            return w in self.lower
        return w in self.lower or w in self.words or _fold(w) in self.words

    def near(self, word: str) -> bool:
        """A long word a scan misread by one letter: "Sjgnature", "Ipitiales"."""
        w = word.lower().strip("'’.-")
        if len(w) < 8 or not w.isalpha():
            return False
        alphabet = "abcdefghijklmnopqrstuvwxyzéèêëàâîïôûüç"
        for i in range(len(w) + 1):
            if i < len(w) and w[:i] + w[i + 1 :] in self.words:
                return True
            for c in alphabet:
                if (i < len(w) and w[:i] + c + w[i + 1 :] in self.words) or w[:i] + c + w[i:] in self.words:
                    return True
        return False


def _threads() -> int:
    """Performance cores on Apple silicon (efficiency cores slow a step down), half the cores elsewhere."""
    if sys.platform == "darwin":
        try:
            return max(1, int(subprocess.run(["sysctl", "-n", "hw.perflevel0.physicalcpu"], capture_output=True, text=True, timeout=2).stdout))
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
    return max(1, (os.cpu_count() or 2) // 2)


class _Model:
    def __init__(self, folder: Path):
        import onnxruntime as ort
        from tokenizers import Tokenizer

        cfg = json.loads((folder / "config.json").read_text())
        self.labels = {int(k): v for k, v in cfg["id2label"].items()}
        self.outside = next(k for k, v in self.labels.items() if v == "O")
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        opts.intra_op_num_threads = _threads()
        opts.log_severity_level = 3
        self.session = ort.InferenceSession(str(folder / "model_int8.onnx"), opts, providers=["CPUExecutionProvider"])
        self.tok = Tokenizer.from_file(str(folder / "tokenizer.json"))
        self.tok.no_truncation()
        self.tok.no_padding()
        self.bos = self.tok.token_to_id("<bos>")
        self.eos = self.tok.token_to_id("<eos>")


def model() -> _Model:
    global _model
    with _lock:
        if _model is None:
            _model = _Model(MODEL_DIR)
        return _model


def available() -> bool:
    return (MODEL_DIR / "model_int8.onnx").exists()


def preload() -> None:
    """Load the model off the request path, so the first document doesn't wait for it."""
    if available():
        threading.Thread(target=model, name="ner-load", daemon=True).start()


def _prepare(text: str) -> tuple[str, list[tuple[int, int]]]:
    """Shorter runs of spaces and title-cased capitals; returns the text and the cuts to map offsets back."""
    cuts: list[tuple[int, int]] = []
    parts: list[str] = []
    last = 0
    for m in re.finditer(r"[ \t]{3,}", text):
        parts.append(text[last : m.start() + 2])
        cuts.append((m.start() + 2, m.end()))
        last = m.end()
    parts.append(text[last:])
    small = "".join(parts)

    def title(m: re.Match) -> str:
        w = m[0][0] + m[0][1:].lower()
        return w if len(w) == len(m[0]) else m[0]

    return CAPS_WORD.sub(title, small), cuts


def _back(cuts: list[tuple[int, int]], i: int) -> int:
    """Offset in the shortened text → offset in the original."""
    shift = 0
    for start, end in cuts:
        if i + shift >= start:
            shift += end - start
        else:
            break
    return i + shift


def _windows(offsets: list[tuple[int, int]], text: str) -> list[tuple[int, int]]:
    """Token ranges of whole lines, at most WINDOW - 2 tokens each."""
    size = WINDOW - 2
    breaks = [i + 1 for i, (a, b) in enumerate(offsets) if "\n" in text[a:b]]
    out: list[tuple[int, int]] = []
    start = 0
    prev = 0
    for b in breaks + [len(offsets)]:
        if b - start > size and prev > start:
            out.append((start, prev))
            start = prev
        prev = b
    out.append((start, len(offsets)))
    split: list[tuple[int, int]] = []
    for a, b in out:
        split.extend((i, min(b, i + size)) for i in range(a, b, size))
    return [w for w in split if w[1] > w[0]]


def _labels(m: _Model, ids: list[int], windows: list[tuple[int, int]]) -> tuple[list[str], list[float]]:
    """Each token's label, and how much of its probability goes to name labels."""
    import numpy as np

    out = ["O"] * len(ids)
    name_mass = [0.0] * len(ids)
    names = [k for k, v in m.labels.items() if v[2:] in ("GIVEN_NAME", "SURNAME")]
    order = sorted(range(len(windows)), key=lambda i: windows[i][1] - windows[i][0])
    for k in range(0, len(order), BATCH):
        group = [windows[i] for i in order[k : k + BATCH]]
        width = max(b - a for a, b in group) + 2
        x = np.zeros((len(group), width), dtype=np.int64)
        mask = np.zeros_like(x)
        for r, (a, b) in enumerate(group):
            x[r, : b - a + 2] = [m.bos, *ids[a:b], m.eos]
            mask[r, : b - a + 2] = 1
        logits = m.session.run(None, {"input_ids": x, "attention_mask": mask})[0]
        guard.beat()
        for r, (a, b) in enumerate(group):
            row = logits[r, 1 : b - a + 1]
            e = np.exp(row - row.max(-1, keepdims=True))
            p = e / e.sum(-1, keepdims=True)
            if RECALL_FIRST:
                ent = p.copy()
                ent[:, m.outside] = -1
                best = ent.argmax(-1)
                keep = (1 - p[:, m.outside]) >= THRESHOLD
            else:
                best = p.argmax(-1)
                keep = (best != m.outside) & (p[np.arange(len(best)), best] >= THRESHOLD)
            mass = p[:, names].sum(-1)
            for j, lab in enumerate(best):
                name_mass[a + j] = float(mass[j])
                if keep[j]:
                    out[a + j] = m.labels[int(lab)]
    return out, name_mass


def _word_bounds(text: str, start: int, end: int) -> tuple[int, int] | None:
    """Grow a span to whole words; None when the model only marked a small piece of one ("ataire")."""
    s, e = start, end
    while s > 0 and text[s - 1].isalnum() and text[s].isalnum():
        s -= 1
    while e < len(text) and text[e].isalnum() and text[e - 1].isalnum():
        e += 1
    return (s, e) if (end - start) >= 0.6 * (e - s) else None


def find(text: str) -> list[dict]:
    """Detections as {start, end, type}, offsets into `text`."""
    if not text.strip():
        return []
    m = model()
    small, cuts = _prepare(text)
    enc = m.tok.encode(small, add_special_tokens=False)
    labels, name_mass = _labels(m, enc.ids, _windows(enc.offsets, small))

    spans: list[dict] = []
    cur: dict | None = None
    for (a, b), lab, nm in zip(enc.offsets, labels, name_mass):
        kind = TYPES.get(lab[2:]) if lab != "O" else None
        gap = small[cur["end"] : a] if cur else ""
        if cur and kind == cur["type"] and (lab.startswith("I-") or kind in ("name", "street")) and len(gap) <= 3 and gap.strip() in ("", "-", ".", ",", "'", "’"):
            cur["end"] = b
            cur["tokens"].append((a, b, nm))
            continue
        if cur:
            spans.append(cur)
        cur = {"type": kind, "start": a, "end": b, "tokens": [(a, b, nm)]} if kind else None
    if cur:
        spans.append(cur)

    ordinary = _Ordinary(text)
    out: list[dict] = []
    for sp in spans:
        kind = {"name": "person", "street": "address"}.get(sp["type"], sp["type"])
        if kind == "person":
            # "J.-F. Tremblay et Isabelle Côté" is two people; "Tremblay, Jean-François" is one,
            # so a comma only splits when there's a whole name on each side.
            cut = sp["start"]
            for j in JOINER.finditer(small, sp["start"], sp["end"]):
                if j[0].strip() in (",", ";", "/") and not (" " in small[cut : j.start()].strip() and " " in small[j.end() : sp["end"]].strip()):
                    continue
                got = _keep(text, cuts, kind, cut, j.start())
                if got:
                    out.append(got)
                cut = j.end()
            got = _keep(text, cuts, kind, cut, sp["end"])
            if got:
                out.append(got)
            continue
        if kind == "organization":
            # "Marvale Inc. & Laurent Boisvenu": a company and a person the model read as one name.
            j = ORG_AND_PERSON.search(small, sp["start"], sp["end"])
            if j and j.group(1).lower() in lexicon()[1]:
                for k, a, b in (("organization", sp["start"], j.start()), ("person", j.start(1), sp["end"])):
                    got = _keep(text, cuts, k, a, b)
                    if got:
                        out.append(got)
                continue
            # "Marvale Inc. & Laurent", the person read on its own: the company ends at the "&".
            j = ORG_THEN_FIRST.search(small, sp["start"], sp["end"])
            if j and j.group(1).lower() in lexicon()[1]:
                got = _keep(text, cuts, "organization", sp["start"], j.start())
                if got:
                    out.append(got)
                continue
        got = _keep(text, cuts, kind, sp["start"], sp["end"])
        if got:
            out.append(got)
        elif kind == "address":
            # In a table row the model sometimes reads a name as a street ("Virement à Kevin Ricard"):
            # the name labels still get some weight there, which a real street never gets.
            for nm in NAME_WORDS.finditer(small, sp["start"], sp["end"]):
                if max((w for a, b, w in sp["tokens"] if a < nm.end() and b > nm.start()), default=0) >= 0.05:
                    got = _keep(text, cuts, "person", nm.start(), nm.end())
                    if got:
                        out.append(got)
    found = [d for d in out if _plausible(text, d, ordinary)]
    # The rule's names where the model saw nothing, or only a piece.
    for r in rule_names(text, ordinary):
        if not any(d["start"] <= r["start"] and d["end"] >= r["end"] and d["type"] == "person" for d in found):
            found = [d for d in found if not (d["type"] in ("person", "organization") and d["start"] >= r["start"] and d["end"] <= r["end"])]
            found.append(r)
    for r in rule_stacked(text, ordinary, found) + rule_surname_first(text, ordinary):
        a, b = min(r["start"], r["last"][0]), max(r["end"], r["last"][1])
        if any(d["type"] == "person" and d["start"] <= a and d["end"] >= b for d in found):
            continue
        # A piece the model took for a company or a lone name: the pair says better.
        found = [d for d in found if not (d["type"] in ("person", "organization") and d["start"] >= a and d["end"] <= b)]
        found.append(r)
    return sorted(found, key=lambda d: d["start"])


UP = "A-ZÀ-ÖØ-Þ"
LOW = "a-zà-ÿ"
WORD = rf"(?:[{UP}][{LOW}]+|[{UP}]{{2,}})(?:-(?:[{UP}][{LOW}]+|[{UP}]{{2,}}))*"
PARTICLE = r"(?:de |du |des |d['’]|le |la |van |von |di |da |st-|ste-)"
NAME_RULE = re.compile(rf"(?<![\w'’-])({WORD})((?:[ \t]+{PARTICLE}?{WORD}){{1,3}})(?![\w'’-])", re.IGNORECASE)
SURNAME_FIRST = re.compile(rf"(?<![\w'’-])([{UP}]{{2,}}(?:[ \t-]+[{UP}]{{2,}}){{0,2}}),[ \t]+({WORD})(?![\w'’-])")
NOT_A_SURNAME = re.compile(
    r"^(?:et|and|ou|or|rue|avenue|av|boulevard|boul|chemin|ch|route|rang|place|street|road|drive|inc|ltée|ltd|enr|senc|corp|cie|qc|québec|quebec|canada|ontario)$",
    re.IGNORECASE,
)


# Two- and three-letter "first names" in the INSEE list that are mostly words here.
NOT_GIVEN = set("le la les de du des st ste si ma ba pa en un et au aux lo li ma mon ton son sa ta ce ces on ne ni or par pour sur sous via art".split())


def _is_first(word: str, first: frozenset[str]) -> bool:
    w = word.lower()
    if w in NOT_GIVEN or len(_fold(w).replace("-", "")) < 3:
        return False
    return w in first or _fold(w) in first or all(p in first or _fold(p) in first for p in w.split("-"))


def rule_names(text: str, ordinary: _Ordinary) -> list[dict]:
    """
    People the model can miss in lists and forms: a known first name and one to
    three capitalised words, one of them at least no ordinary word ("Mathieu
    TREMBLAY CHEVALIER", "Laurent BOISVENU", "DENIS POIRIER"), or a surname
    in capitals, a comma and a first name ("BOISVENU, LAURENT").
    """
    first = ordinary.first
    out = []
    for m in NAME_RULE.finditer(text):
        given = m.group(1)
        if not (given[0].isupper() and _is_first(given, first)):
            continue
        rest = re.findall(rf"{PARTICLE}?{WORD}", m.group(2).strip(), re.IGNORECASE)
        surnames = [re.sub(PARTICLE, "", w, flags=re.IGNORECASE) for w in rest]
        # Cut at the first word that can't be a surname: "Laurent Boulevard", "Paul Inc".
        keep = []
        for i, w in enumerate(surnames):
            if NOT_A_SURNAME.match(w) or not w[0].isupper():
                break
            # "François Lessard Vincent Bédard": a first name after a surname starts the next person.
            if keep and i + 1 < len(surnames) and _is_first(w, first) and not ordinary(surnames[i + 1]):
                break
            keep.append(w)
        if not keep or all(ordinary(w) for w in keep):
            continue
        end = m.start(2) + m.group(2).find(keep[-1]) + len(keep[-1])
        out.append({"start": m.start(1), "end": end, "type": "person"})
    for m in SURNAME_FIRST.finditer(text):
        if _is_first(m.group(2), first) and not all(ordinary(w) for w in re.split(r"[ \t-]+", m.group(1))):
            out.append({"start": m.start(1), "end": m.end(2), "type": "person"})
    return out


SAINT = re.compile(r"(?:saint|sainte|st|ste)-", re.IGNORECASE)
# "Baie-Saint-Louis", "Lac-Beauport": a town, not a surname.
PLACE = re.compile(r"(?:^|-)(?:baie|lac|mont|pointe|ile|île|rivi[eè]re|cap|notre|saint|sainte|st|ste)-|-(?:saint|sainte|st|ste)-", re.IGNORECASE)
LINE_FIRST = re.compile(rf"^[ \t]*({WORD})(?:[ \t]+(\S+))?", re.MULTILINE)


def rule_stacked(text: str, ordinary: _Ordinary, found: list[dict]) -> list[dict]:
    """
    A name the OCR split over two lines, each half starting a line: "Jacques 5 S Ê"
    over "Poulin Agent aux programmes", "OUELLET Montant…" over "SYLVAIN Pour…". A
    known first name, and right above or below it a word that is neither ordinary
    nor a first name, written the same way (both in capitals or neither). The
    first name's span carries the surname's as "last".
    """
    first = ordinary.first
    lines = []
    for m in LINE_FIRST.finditer(text):
        lines.append((text.count("\n", 0, m.start()), m))
    by_line = {n: m for n, m in lines}
    used: set[int] = set()
    out = []
    for n, m in lines:
        given = m.group(1)
        # Weaker evidence than a name on one line: a first name the document also writes as a word ("salle") or a place's saint doesn't count.
        if not _is_first(given, first) or ordinary(given) or SAINT.match(given):
            continue
        # A surname on the same line is rule_names' or the model's job.
        nxt = m.group(2) or ""
        if re.fullmatch(WORD, nxt.strip(",.")) and not ordinary(nxt.strip(",.")):
            continue
        if any(d["type"] == "person" and d["start"] <= m.start(1) and d["end"] > m.end(1) for d in found):
            continue
        for k in (n + 1, n - 1):
            o = by_line.get(k)
            if not o or k in used:
                continue
            last = o.group(1)
            if (
                len(_fold(last).replace("-", "")) < 3
                or PLACE.search(last)
                or last.isupper() != given.isupper()
                or _is_first(last, first)
                or ordinary(last)
                or NOT_A_SURNAME.match(last)
            ):
                continue
            out.append({"start": m.start(1), "end": m.end(1), "type": "person", "last": [o.start(1), o.end(1)]})
            used.update((n, k))
            break
    return out


SURNAME_THEN_FIRST = re.compile(rf"^[ \t]*([{UP}]{{2,}}(?:[ -][{UP}]{{2,}})?)[ \t]+([{UP}]{{2,}}(?:-[{UP}]{{2,}})?)(?=[ \t]{{2,}}|[ \t]*$)", re.MULTILINE)


def rule_surname_first(text: str, ordinary: _Ordinary) -> list[dict]:
    """
    "BOISVENU LAURENT" alone on its line or before a column gap, as tables and
    insurers print it: surname, then a known first name, in capitals, no comma.
    Given like a stacked name: the first name's span, the surname's as "last".
    """
    out = []
    for m in SURNAME_THEN_FIRST.finditer(text):
        sur, given = m.group(1), m.group(2)
        words = re.split(r"[ -]", sur)
        if not _is_first(given, ordinary.first) or any(_is_first(w, ordinary.first) or ordinary(w) or NOT_A_SURNAME.match(w) for w in words):
            continue
        out.append({"start": m.start(2), "end": m.end(2), "type": "person", "last": [m.start(1), m.end(1)]})
    return out


def _plausible(text: str, d: dict, ordinary: _Ordinary) -> bool:
    """
    The model takes some capitalised words in forms and tables for names or
    companies: "Montant", "Colonne", "Aucun", "Services courants". Matched
    everywhere in the document afterwards, one such word mangles hundreds of
    places. A name or company made only of ordinary words goes, unless a title
    or a form label says it's a name ("M. Petit", "Prénom : Rose").
    """
    if d["type"] not in ("person", "organization"):
        return True
    value = text[d["start"] : d["end"]]
    before = text[max(0, d["start"] - 40) : d["start"]]
    if d["type"] == "person":
        if re.search(rf"(?:^|[^\w]){TITLES}\s*$", before, re.IGNORECASE) or re.match(rf"{TITLES}\s", value, re.IGNORECASE):
            return True
        # The label may sit on the line above: "Prénom\n\nLaurent".
        if NAME_LABEL.search(re.sub(r"\s*\n\s*", " ", before)):
            return True
        if any(c.isdigit() for c in value):
            return False
        words = [w for w in re.findall(r"[^\W\d_][\w'’-]*", value) if not re.fullmatch(r"(?:de|du|des|la|le|van|von|di|da|d|l)", w, re.IGNORECASE)]
        if not words or all(ordinary(w) for w in words):
            return False
        # A form's labels the scan misspelled: "Année Sjgnature", "Jour Mois Année Ipitiales". One word exactly
        # ordinary, the others ordinary or a long word one letter off one, and no first name.
        if len(words) >= 2 and any(ordinary(w) for w in words) and not any(_is_first(w, ordinary.first) for w in words):
            if all(ordinary(w) or ordinary.near(w) for w in words):
                return False
        return True
    words = re.findall(r"[^\W\d_][\w'’-]*", value)
    # "S.O. S.O", "CO-130.A": form codes, not companies. A company name has a word of 3+ letters.
    if not any(sum(c.isalpha() for c in w) >= 3 for w in words):
        return False
    if LEGAL.search(value):
        return bool(LEGAL.sub("", value).strip(" .,&-"))
    if len(words) == 1 and len(words[0]) <= 4 and words[0].isupper():
        return False
    stop = {"de", "du", "des", "la", "le", "les", "et", "of", "the", "and", "d", "l", "à", "a", "en", "pour"}
    content = [w for w in words if w.lower() not in stop]
    return bool(content) and not all(ordinary(w) for w in content)


def _capitalised(word: str) -> bool:
    """'Tremblay', 'J.-F.', "d'Amours", '(Paul'; not 'le', 'et', '12'."""
    w = re.sub(r"^\W+|^[dlDL]['’]", "", word)
    return bool(w) and w[0].isupper()


_AS_LETTER = {"0": "O", "1": "I", "2": "Z", "4": "A", "5": "S", "6": "G", "8": "B"}
_AS_DIGIT = {"O": "0", "o": "0", "I": "1", "i": "1", "l": "1", "Z": "2", "z": "2", "A": "4", "S": "5", "s": "5", "G": "6", "B": "8"}


def _postal_ok(value: str) -> bool:
    """A Canadian postal code, as a scan reads it too: "G0A 1 P2", or one character off ("J7K 3AB" for J7K 3A8)."""
    c = re.sub(r"[\s-]", "", value)
    if len(c) != 6:
        return False
    fixed = "".join((_AS_LETTER if i % 2 == 0 else _AS_DIGIT).get(ch, ch) for i, ch in enumerate(c))
    return sum(a != b for a, b in zip(c, fixed)) <= 1 and bool(re.fullmatch(r"[A-Za-z]\d[A-Za-z]\d[A-Za-z]\d", fixed))


def _debris(value: str) -> bool:
    """OCR noise read as a name: "IRIS IRIS", "Sfp LIL ILILIL", "Annexe B", "OO Bax Box Box", "Québec (NEQ) 0 |s.o."."""
    if re.search(r"[|$<>{}\[\]=_@#*]", value):
        return True
    ws = re.findall(r"[^\W\d_][\w'’.-]*", value)
    if not ws:
        return True
    low = [w.lower().strip(".") for w in ws]
    if len(low) > 1 and len(set(low)) < len(low):
        return True  # a word repeated
    for w in low:
        letters = re.sub(r"[^a-zà-ÿ]", "", w)
        if len(letters) >= 3 and not re.search(r"[aeiouyàâäéèêëîïôöùûü]", letters):
            return True  # no vowel: "sfp", "lsrl"
        if re.search(r"(.)\1\1", letters) or re.search(r"(?:il|li){2,}", letters):
            return True  # "lll", "ililil"
        # A form's "☐ oui ☐ non" read as a name: "Cioui Érfon", "Ooui Cinon".
        if re.fullmatch(r".{1,3}oui", letters):
            return True
        # Letters no name here has, or two accented letters in a row: "Ænon", "Coûüi" (not "agréé", "créées").
        if re.search(r"[æÿ÷øþ]", letters) or re.search(r"[à-ÿ]{2}", re.sub(r"éé(?=e?s?$)", "e", letters)):
            return True
    # Two capitals then lowercase in a short word: "EOnon", "ÉHéton", "COoui" (not "LeBlanc" or "TREMBLAY").
    if any(re.fullmatch(rf"[{UP}]{{2}}[{LOW}]{{2,5}}", w) for w in ws):
        return True
    # "Annexe B", "Tome I": a word then a lone letter or Roman numeral.
    if len(ws) == 2 and re.fullmatch(r"[A-Z]|[IVX]{1,4}", ws[1]):
        return True
    return False


def _keep(text: str, cuts: list[tuple[int, int]], kind: str, small_start: int, small_end: int) -> dict | None:
    """A span of the shortened text as a detection in `text`, or None when it doesn't hold up."""
    start, end = _back(cuts, small_start), _back(cuts, small_end - 1) + 1
    while start < end and text[start] in " \t\n,;:":
        start += 1
    while end > start and text[end - 1] in " \t\n,;:.-–(":
        end -= 1
    bounds = _word_bounds(text, start, end) if end > start else None
    if not bounds:
        return None
    start, end = bounds
    if kind in ("person", "organization", "address"):
        # OCR debris at the edges ("·Paul", "~Gervais"): a name starts and ends with a letter or a digit.
        while start < end and not text[start].isalnum():
            start += 1
        while end > start and not (text[end - 1].isalnum() or text[end - 1] in ".)"):
            end -= 1
        if end <= start:
            return None
    if kind == "person":
        # Names are capitalised: "le" after "Paul Gagnon" (recall-first reaches for it) isn't part of
        # the name. Particles inside one stay ("Jean de la Fontaine").
        words = list(re.finditer(r"\S+", text[start:end]))
        while words and not _capitalised(words[0][0]):
            words.pop(0)
        while words and not _capitalised(words[-1][0]):
            words.pop()
        if not words:
            return None
        start, end = start + words[0].start(), start + words[-1].end()
    value = text[start:end]
    # The model reads a lone 5-digit number as a US ZIP; in these documents it's a file, branch or folio number.
    if kind == "postal_code" and re.fullmatch(r"\d{5,}", value.strip()):
        kind = "id_number"
    # A price (and a receipt's tax code) the model ran into a code: "QRT5501234 9.97 FP", "4471820 2.67" (an AI quotes the code alone).
    if kind in NUMBERED and kind not in ("phone", "postal_code"):
        m = re.fullmatch(r"(.*?\d.*?)\s+[-+]?\$?\d+[.,]\d{1,2}\s?\$?(?:\s+[A-Z]{1,3})?", value)
        if m:
            end = start + len(m.group(1))
            value = m.group(1)
    digits = sum(c.isdigit() for c in value)
    letters = sum(c.isalpha() for c in value)
    if kind in NUMBERED and digits < (7 if kind == "phone" else 4 if kind != "postal_code" else 2):
        return None
    # A number never spans a column gap or a line break: "00      8 755,63" is two amounts.
    if kind in NUMBERED and re.search(r"\s{2,}|\n", value):
        return None
    if kind == "phone" and digits < 10 and not re.fullmatch(r"\d{3}[-. ]\d{4}", value):
        return None
    # A North American number: area code and exchange start with 2-9.
    if kind == "phone" and digits >= 10:
        d = re.sub(r"\D", "", value)
        d = d[1:] if len(d) == 11 and d[0] == "1" else d[-10:]
        if not re.fullmatch(r"[2-9]\d{2}[2-9]\d{6}", d):
            return None
    # Amounts, rates, dates and year-months aren't references: "2 285.55", "1 000 000", "6.875", "26-10-2021", "2017-08".
    if kind in NUMBERED and kind not in ("phone", "postal_code") and NOT_AN_ID.fullmatch(value.strip()):
        return None
    # A Canadian postal code, a real email: "190 610" or "@" from the model aren't.
    if kind == "postal_code" and not _postal_ok(value):
        return None
    if kind == "email" and not re.fullmatch(r"[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}", value.strip()):
        return None
    # The model's "other" (usernames, links) is mostly "PDF", "image001.png" or a public site in these documents.
    if kind == "other":
        return None
    # "app. 3", "Unit 9", "2022 Freightliner": an address needs a civic number and a street word.
    if kind == "address" and not (digits and STREET_WORD.search(value)):
        return None
    if kind in ("person", "organization") and (letters < 3 or value == value.lower()):
        return None
    if kind in ("person", "organization") and _debris(value):
        return None
    # A lone capitalised acronym ("CAIB", "REVENU") isn't a person.
    if kind == "person" and " " not in value.strip() and value.isupper():
        return None
    return {"start": start, "end": end, "type": kind}
