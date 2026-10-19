"""`anon-engine --selftest`: made-up documents through every endpoint, over real HTTP, in-process.

Checks what a bundle can get wrong: missing modules, fonts or OCR models, the
auth wrapper, multipart parsing. Prints OK and returns 0, or says what failed
and returns 1.
"""

from __future__ import annotations

import http.client
import io
import json
import secrets
import sys
import threading
import time
import zipfile

import pymupdf as fitz

from engine import desktop
from engine.main import DOCX_MIME, PDF_MIME
from engine.ner import MODEL_DIR
from engine.paths import FONT_DIR, TESSDATA

LINES = [
    "Assurances Mirador inc.",
    "Assuré : M. Jean-François Tremblay",
    "Téléphone : (450) 662-1934",
    "Monsieur Tremblay, votre police sera renouvelée le 1er décembre 2026.",
]
SWAPS = {"Tremblay": "Larivière", "662-1934": "555-0142"}


class Failed(Exception):
    pass


def make_pdf() -> bytes:
    doc = fitz.open()
    page = doc.new_page()
    for i, line in enumerate(LINES):
        page.insert_text((72, 72 + 20 * i), line, fontsize=12, fontname="helv")
    return doc.tobytes()


def make_scan(pdf_bytes: bytes) -> bytes:
    src = fitz.open(stream=pdf_bytes, filetype="pdf")[0]
    pix = src.get_pixmap(dpi=200, colorspace=fitz.csGRAY, alpha=False)
    out = fitz.open()
    out.new_page(width=src.rect.width, height=src.rect.height).insert_image(src.rect, stream=pix.tobytes("png"))
    return out.tobytes(deflate=True)


def make_png(pdf_bytes: bytes) -> bytes:
    return fitz.open(stream=pdf_bytes, filetype="pdf")[0].get_pixmap(dpi=200).tobytes("png")


def make_docx() -> bytes:
    W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    paras = "".join(f'<w:p><w:r><w:t xml:space="preserve">{line}</w:t></w:r></w:p>' for line in LINES)
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        "word/document.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="{W}"><w:body>{paras}</w:body></w:document>',
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, xml in files.items():
            z.writestr(name, xml.encode("utf-8"))
    return buf.getvalue()


def plan(text: str) -> list[dict]:
    out = []
    for real, fake in SWAPS.items():
        at = text.find(real)
        while at >= 0:
            out.append({"start": at, "end": at + len(real), "text": fake})
            at = text.find(real, at + len(real))
    return sorted(out, key=lambda r: r["start"])


class Client:
    def __init__(self, port: int, token: str):
        self.port, self.token = port, token

    def call(self, path: str, body: bytes | None = None, headers: dict | None = None, auth: bool = True) -> tuple[int, dict, bytes]:
        h = dict(headers or {})
        if auth:
            h["Authorization"] = f"Bearer {self.token}"
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=300)
        try:
            conn.request("GET" if body is None else "POST", path, body=body, headers=h)
            r = conn.getresponse()
            return r.status, dict(r.getheaders()), r.read()
        finally:
            conn.close()

    def ok(self, path: str, body: bytes | None = None, **headers) -> bytes:
        status, _, data = self.call(path, body, {k.replace("_", "-"): v for k, v in headers.items()})
        if status != 200:
            raise Failed(f"{path}: HTTP {status} {data[:300]!r}")
        return data

    def rewrite(self, data: bytes, mime: str, sha: str, reps: list[dict]) -> bytes:
        boundary = secrets.token_hex(16)
        parts = [("file", "file", mime, data), ("spec", None, None, json.dumps({"sha256": sha, "replacements": reps, "fields": []}).encode()), ("mime", None, None, mime.encode())]
        body = b""
        for name, filename, ctype, value in parts:
            disp = f'form-data; name="{name}"' + (f'; filename="{filename}"' if filename else "")
            body += f"--{boundary}\r\nContent-Disposition: {disp}\r\n".encode()
            if ctype:
                body += f"Content-Type: {ctype}\r\n".encode()
            body += b"\r\n" + value + b"\r\n"
        body += f"--{boundary}--\r\n".encode()
        return self.ok("/rewrite", body, **{"Content-Type": f"multipart/form-data; boundary={boundary}"})


def expect(cond: bool, what: str) -> None:
    if not cond:
        raise Failed(what)


def roundtrip(c: Client, name: str, data: bytes, mime: str, raster: bool = True) -> None:
    """Extract, replace the made-up person, check nothing of them is left anywhere."""
    ex = json.loads(c.ok("/extract", data, x_mime=mime))
    expect("Tremblay" in ex["text"], f"{name}: name not found in extracted text")
    out = c.rewrite(data, mime, ex["sha256"], plan(ex["text"]))
    chk = json.loads(c.ok("/check", out, x_mime=mime, x_raster="1" if raster else "0"))
    seen = chk["text"] + "\n".join(chk["raster"])
    expect("Tremblay" not in seen and "662-1934" not in seen, f"{name}: real values left in the output")
    expect("Larivi" in chk["text"], f"{name}: replacement missing from the output")
    if raster and mime == PDF_MIME:
        expect("Larivi" in "\n".join(chk["raster"]), f"{name}: OCR of the output page read nothing")


def checks(c: Client) -> None:
    for f in ("liberation/LiberationSans-Regular.ttf", "liberation/LiberationSerif-Regular.ttf", "crosextra/Carlito-Regular.ttf"):
        expect((FONT_DIR / f).exists(), f"font missing: {FONT_DIR / f}")
    for f in ("eng.traineddata", "fra.traineddata"):
        expect((TESSDATA / f).exists(), f"OCR model missing: {TESSDATA / f}")

    expect(json.loads(c.ok("/health"))["ok"] is True, "/health")
    expect(c.call("/health", auth=False)[0] == 401, "a request without the token was let through")

    text_pdf = make_pdf()
    info = json.loads(c.ok("/inspect", text_pdf, x_mime=PDF_MIME))
    expect(info["ocr"] == "none" and info["pageKinds"] == ["text"], f"text PDF inspected as {info}")
    roundtrip(c, "text PDF", text_pdf, PDF_MIME)

    scan = make_scan(text_pdf)
    info = json.loads(c.ok("/inspect", scan, x_mime=PDF_MIME))
    expect(info["ocr"] == "scan", f"scanned PDF inspected as {info}")
    ocred = c.ok("/ocr", scan, x_mime=PDF_MIME)
    expect(json.loads(c.ok("/inspect", ocred, x_mime=PDF_MIME))["pageKinds"] == ["ocr"], "OCR added no text layer")
    roundtrip(c, "scanned PDF", ocred, PDF_MIME)

    # Three scanned pages: the OCR workers (separate processes of this same program) do the reading.
    three = fitz.open()
    for _ in range(3):
        three.insert_pdf(fitz.open(stream=scan, filetype="pdf"))
    ocred3 = c.ok("/ocr", three.tobytes(garbage=3, deflate=True), x_mime=PDF_MIME)
    chk = json.loads(c.ok("/check", ocred3, x_mime=PDF_MIME))
    expect(len(chk["raster"]) == 3 and all("Tremblay" in r for r in chk["raster"]), "three-page scan: the workers read nothing")

    image_pdf = c.ok("/ocr", make_png(text_pdf), x_mime="image/png")
    roundtrip(c, "image", image_pdf, PDF_MIME, raster=False)

    roundtrip(c, "DOCX", make_docx(), DOCX_MIME)

    for f in ("model_int8.onnx", "tokenizer.json", "config.json"):
        expect((MODEL_DIR / f).exists(), f"detection model file missing: {MODEL_DIR / f}")
    text = "\n".join(LINES)
    found = json.loads(c.ok("/ner", text.encode(), **{"Content-Type": "text/plain; charset=utf-8"}))["entities"]
    people = [text[e["start"] : e["end"]] for e in found if e["type"] == "person"]
    expect(any("Tremblay" in p for p in people), f"/ner found no person: {found}")


def run() -> int:
    t0 = time.perf_counter()
    token = secrets.token_urlsafe(24)
    srv = desktop.server(token)
    sock = desktop.listen()
    thread = threading.Thread(target=srv.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    try:
        while not srv.started:
            if not thread.is_alive():
                raise Failed("server did not start")
            time.sleep(0.01)
        checks(Client(sock.getsockname()[1], token))
    except Exception as e:
        print(f"selftest failed: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    finally:
        srv.should_exit = True
        thread.join(timeout=10)
    print(f"selftest passed in {time.perf_counter() - t0:.1f}s", file=sys.stderr)
    print("OK", flush=True)
    return 0
