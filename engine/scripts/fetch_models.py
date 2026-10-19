"""Download the files pinned in tessdata.lock.json (OCR) and ner.lock.json (detection model)
into engine/tessdata/ and engine/ner/, and check their hashes.

    python engine/scripts/fetch_models.py

Files already present with the right hash are kept; anything else is replaced.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCKS = {"tessdata.lock.json": "tessdata", "ner.lock.json": "ner"}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def fetch(lock_name: str, dest: Path) -> bool:
    lock = json.loads((ROOT / lock_name).read_text())
    dest.mkdir(parents=True, exist_ok=True)
    ok = True
    for name, f in lock["files"].items():
        out = dest / name
        if out.exists() and sha256(out) == f["sha256"]:
            print(f"{dest.name}/{name}: ok")
            continue
        tmp = out.with_suffix(out.suffix + ".part")
        with urllib.request.urlopen(f["url"], timeout=120) as r, tmp.open("wb") as w:
            shutil.copyfileobj(r, w, 1 << 20)
        got = sha256(tmp)
        if got != f["sha256"] or tmp.stat().st_size != f["size"]:
            print(f"{dest.name}/{name}: hash mismatch (got {got}, {tmp.stat().st_size} bytes)", file=sys.stderr)
            tmp.unlink()
            ok = False
            continue
        tmp.replace(out)
        print(f"{dest.name}/{name}: downloaded")
    return ok


def main() -> int:
    results = [fetch(lock, ROOT / folder) for lock, folder in LOCKS.items()]
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
