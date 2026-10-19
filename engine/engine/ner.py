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
STREET_WORD = re.compile(
    r"\b(?:rue|avenue|av|boulevard|boul|blvd|chemin|ch|route|rte|rang|mont[ée]e|c[ôo]te|croissant|terrasse|impasse|all[ée]e|promenade|place|carr[ée]|"
    r"concession|street|st|road|rd|drive|dr|crescent|cres|court|ct|lane|ln|way|parkway|pkwy|terrace|circle|highway|hwy|trail|line|sideroad|square|grove|heights|row|close|path)\b",
    re.IGNORECASE,
)
JOINER = re.compile(r"\s+(?:et|and|ou|or|&)\s+|\s*[,;/]\s*|\s+-\s+", re.IGNORECASE)
NAME_WORDS = re.compile(r"(?<![\w-])[A-ZÀ-ÖØ-Þ][\w'’.-]*(?: [A-ZÀ-ÖØ-Þ][\w'’.-]*){1,3}(?![\w-])")
CAPS_WORD = re.compile(r"\b[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ'’-]{2,}\b")

_lock = threading.Lock()
_model = None


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
    return out


def _capitalised(word: str) -> bool:
    """'Tremblay', 'J.-F.', "d'Amours", '(Paul'; not 'le', 'et', '12'."""
    w = re.sub(r"^\W+|^[dlDL]['’]", "", word)
    return bool(w) and w[0].isupper()


def _keep(text: str, cuts: list[tuple[int, int]], kind: str, small_start: int, small_end: int) -> dict | None:
    """A span of the shortened text as a detection in `text`, or None when it doesn't hold up."""
    start, end = _back(cuts, small_start), _back(cuts, small_end - 1) + 1
    while start < end and text[start] in " \t\n,;:":
        start += 1
    while end > start and text[end - 1] in " \t\n,;:.-–":
        end -= 1
    bounds = _word_bounds(text, start, end) if end > start else None
    if not bounds:
        return None
    start, end = bounds
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
    digits = sum(c.isdigit() for c in value)
    letters = sum(c.isalpha() for c in value)
    if kind in NUMBERED and digits < (7 if kind == "phone" else 4 if kind != "postal_code" else 2):
        return None
    # A number never spans a column gap or a line break: "00      8 755,63" is two amounts.
    if kind in NUMBERED and re.search(r"\s{2,}|\n", value):
        return None
    if kind == "phone" and digits < 10 and not re.fullmatch(r"\d{3}[-. ]\d{4}", value):
        return None
    # "app. 3", "Unit 9", "2022 Freightliner": an address needs a civic number and a street word.
    if kind == "address" and not (digits and STREET_WORD.search(value)):
        return None
    if kind in ("person", "organization") and (letters < 3 or value == value.lower()):
        return None
    # A lone capitalised acronym ("CAIB", "REVENU") isn't a person.
    if kind == "person" and " " not in value.strip() and value.isupper():
        return None
    return {"start": start, "end": end, "type": kind}
