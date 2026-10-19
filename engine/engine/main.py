"""HTTP surface of the document engine: the desktop app's sidecar, and the VPS's engine for the web.

Every endpoint takes the file as the raw request body (or a multipart part)
and holds nothing after responding. Nothing is written to disk.

  POST /inspect     what the file is and whether it needs OCR
  POST /ocr         images and scans -> PDF with a text layer
  POST /extract     text + hash + out-of-flow fields (bookmarks, links, field codes…)
  POST /rewrite     multipart: file + spec {sha256, replacements, fields} -> rewritten file
  POST /check       extracted text, raster OCR text and decoded barcodes of an output file
  POST /ner         UTF-8 text -> names, addresses and identifiers found by the small model
  GET  /health      200 {"ok": true, ...}, or 503 with the lanes that are stuck

Every request ends (engine.guard): with its answer, 504 when its step stops
making progress, or 503 when the engine can't take it now (an earlier request
is stuck, the OCR workers are being restarted). Both are worth retrying.
"""

from __future__ import annotations

import asyncio
import faulthandler
import json
import signal
import time

import pymupdf as fitz
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from starlette.formparsers import MultiPartParser

from . import docx, guard, ner, ocr, pdf

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

# `kill -USR1 <pid>` prints every thread's stack to stderr (the journal on the VPS, the app's log
# on the desktop): what a stuck engine is waiting on. Code locations only, never data.
if hasattr(signal, "SIGUSR1"):
    faulthandler.register(signal.SIGUSR1, all_threads=True)

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PDF_MIME = "application/pdf"
MAX_BYTES = 60 * 1024 * 1024

# Uploads stay in memory: a spooled file would otherwise roll over to disk past 1 MB.
MultiPartParser.spool_max_size = 0

# PyMuPDF isn't thread-safe: every document operation runs on this one thread,
# in arrival order, while the event loop stays free for /health.
WORKER = guard.lane("engine", guard.ENGINE_STALL_S)
# The detection model has its own thread: it doesn't touch PyMuPDF, and a document's text can be read while another file is OCR'd.
NER_WORKER = guard.lane("ner", guard.NER_STALL_S)


async def run(fn, *args, lane: guard.Lane = WORKER, what: str = "", request: Request | None = None):
    """
    fn(*args) on a lane, waited for in a bounded loop: the job's answer; 504 when
    it goes quiet past the lane's limit; 503 when the job ahead of it is stuck.
    A request whose client has left before its turn is dropped from the queue.
    """
    fut, job = lane.submit(what, fn, *args)
    waiting = asyncio.wrap_future(fut)
    # Read the outcome even when nobody waits for it any more, so it isn't reported as lost.
    waiting.add_done_callback(lambda f: f.cancelled() or f.exception())
    while True:
        done, _ = await asyncio.wait({waiting}, timeout=1.0)
        if done:
            return waiting.result()
        if job.started is None:
            ahead = lane.stalled()
            if ahead is not None and fut.cancel():
                raise HTTPException(503, f"the engine is stuck on an earlier {ahead.what} ({ahead.quiet():.0f} s without progress) and restarts by itself; try again shortly")
            if request is not None and await request.is_disconnected() and fut.cancel():
                guard.log(f"{what}: the client left after {time.monotonic() - job.queued:.0f} s in the queue; dropped")
                raise HTTPException(499, "client left")
        elif job.quiet() > lane.stall:
            guard.log(f"{lane.name} lane: {what} answered 504 after {job.quiet():.0f} s without progress")
            raise HTTPException(504, f"the engine gave up on {what}: no progress in {lane.stall:.0f} s")


def kind_of(mime: str) -> str:
    if mime == PDF_MIME:
        return "pdf"
    if mime == DOCX_MIME:
        return "docx"
    if mime.startswith("image/"):
        return "image"
    raise HTTPException(415, f"unsupported type {mime}")


async def body(request: Request) -> bytes:
    data = await request.body()
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "file too large")
    if not data:
        raise HTTPException(400, "empty body")
    return data


def open_pdf(data: bytes, password: str | None) -> fitz.Document:
    try:
        return pdf.open_pdf(data, password)
    except pdf.PasswordRequired:
        raise HTTPException(423, "password required") from None
    except Exception as e:
        raise HTTPException(422, f"not a readable PDF: {e}") from None


@app.get("/health")
async def health():
    stuck = guard.stuck()
    body = {"ok": not stuck, "pymupdf": fitz.VersionBind, "ner": ner.available()}
    if stuck:
        return JSONResponse({**body, "stuck": stuck}, status_code=503)
    return body


def _inspect(data: bytes, kind: str, password: str | None) -> dict:
    if kind == "image":
        return {"kind": "image", "pages": 1, "ocr": "scan", "pageKinds": ["scan"]}
    if kind == "docx":
        return {"kind": "docx", "pages": None, "ocr": "none", "pageKinds": []}
    doc = open_pdf(data, password)
    kinds = pdf.page_kinds(doc)
    need = "garbled" if "garbled" in kinds else "scan" if "scan" in kinds else "none"
    return {"kind": "pdf", "pages": doc.page_count, "ocr": need, "pageKinds": kinds, "encrypted": doc.is_encrypted}


@app.post("/inspect")
async def inspect(request: Request, x_mime: str = Header(...), x_password: str | None = Header(None)):
    data = await body(request)
    return await run(_inspect, data, kind_of(x_mime), x_password, what="/inspect", request=request)


def _ocr(data: bytes, kind: str, force: bool, password: str | None) -> bytes:
    if kind == "image":
        data = ocr.image_to_pdf(data)
    elif password:
        # OCR works on a decrypted copy, which is what the rest of the pipeline gets back.
        data = pdf.save(open_pdf(data, password))
    return ocr.ocr_pdf(data, force=force)


@app.post("/ocr")
async def run_ocr(request: Request, x_mime: str = Header(...), x_force: str = Header("0"), x_password: str | None = Header(None)):
    data = await body(request)
    kind = kind_of(x_mime)
    if kind == "docx":
        raise HTTPException(400, "DOCX needs no OCR")
    out = await run(_ocr, data, kind, x_force == "1", x_password, what="/ocr", request=request)
    return Response(out, media_type=PDF_MIME)


def _extract(data: bytes, kind: str, password: str | None) -> dict:
    if kind == "docx":
        ex = docx.extract(data)
        return {"text": ex.text, "sha256": ex.sha256, "fields": ex.fields}
    doc = open_pdf(data, password)
    ex = pdf.extract(doc)
    return {"text": ex.text, "sha256": ex.sha256, "fields": ex.fields, "pageKinds": pdf.page_kinds(doc)}


@app.post("/extract")
async def extract(request: Request, x_mime: str = Header(...), x_password: str | None = Header(None)):
    data = await body(request)
    kind = kind_of(x_mime)
    if kind == "image":
        raise HTTPException(400, "run /ocr first")
    return await run(_extract, data, kind, x_password, what="/extract", request=request)


def _rewrite(data: bytes, kind: str, s: dict, password: str | None) -> Response:
    try:
        if kind == "docx":
            out, report = docx.rewrite(data, s["sha256"], s["replacements"], s.get("fields", []))
            return Response(out, media_type=DOCX_MIME, headers={"x-report": json.dumps(report)})
        doc = open_pdf(data, password)
        scanned = {i for i, k in enumerate(pdf.page_kinds(doc)) if k == "scan"} | set(s.get("scannedPages", []))
        report = pdf.rewrite(doc, s["sha256"], s["replacements"], s.get("fields", []), scanned)
        return Response(pdf.save(doc), media_type=PDF_MIME, headers={"x-report": json.dumps(report)})
    except ValueError as e:
        raise HTTPException(409, str(e)) from None


@app.post("/rewrite")
async def rewrite(request: Request, file: UploadFile = File(...), spec: str = Form(...), mime: str = Form(...), password: str | None = Form(None)):
    data = await file.read()
    s = json.loads(spec)
    return await run(_rewrite, data, kind_of(mime), s, password, what="/rewrite", request=request)


def _check(data: bytes, kind: str, raster: bool) -> dict:
    if kind == "docx":
        ex = docx.extract(data)
        return {"text": ex.text, "fields": ex.fields, "raster": [], "codes": {}}
    doc = open_pdf(data, None)
    ex = pdf.extract(doc)
    return {
        "text": ex.text,
        "fields": ex.fields,
        "raster": ocr.raster_text(data) if raster else [],
        "codes": {str(k): v for k, v in ocr.read_codes(doc).items()},
        "metadata": {k: v for k, v in (doc.metadata or {}).items() if v and k not in ("format", "encryption")},
    }


@app.post("/check")
async def check(request: Request, x_mime: str = Header(...), x_raster: str = Header("1")):
    """Everything readable in an output file, for the app to search for real values."""
    data = await body(request)
    return await run(_check, data, kind_of(x_mime), x_raster == "1", what="/check", request=request)


@app.post("/ner")
async def find_entities(request: Request):
    """Spans as {start, end, type}; offsets count UTF-16 code units, like JavaScript strings."""
    data = await body(request)
    if not ner.available():
        raise HTTPException(503, "detection model missing")
    text = data.decode("utf-8")
    found = await run(ner.find, text, lane=NER_WORKER, what="/ner", request=request)
    return {"entities": _utf16(text, found)}


def _utf16(text: str, found: list[dict]) -> list[dict]:
    """Python counts code points; the app's strings count UTF-16 units, so characters past U+FFFF shift offsets."""
    if all(ord(c) < 0x10000 for c in text):
        return found
    units = [0]
    for c in text:
        units.append(units[-1] + (2 if ord(c) >= 0x10000 else 1))
    return [{**f, "start": units[f["start"]], "end": units[f["end"]]} for f in found]


@app.exception_handler(guard.EngineFailure)
async def failed(_: Request, exc: guard.EngineFailure):
    return JSONResponse({"error": type(exc).__name__, "detail": str(exc)[:300]}, status_code=exc.status)


@app.exception_handler(Exception)
async def unhandled(_: Request, exc: Exception):
    # Messages only: never echo document content back.
    return JSONResponse({"error": type(exc).__name__, "detail": str(exc)[:300]}, status_code=500)
