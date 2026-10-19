"""No request waits forever: hung or dead OCR workers, a stuck lane, a frozen interpreter."""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pymupdf as fitz
import pytest
from fastapi.testclient import TestClient

from engine import guard, main, ner, ocr, pool
from engine.main import PDF_MIME, app

ENGINE = Path(__file__).resolve().parents[1]


# Run in the OCR workers (spawned processes import this module by name).
def pages_ok(data: bytes, pnos: list[int]) -> dict:
    out = {}
    for p in pnos:
        out[p] = os.getpid()
        pool.page_done(p)
    return out


def pages_hang(data: bytes, pnos: list[int]) -> dict:
    time.sleep(3600)
    return {}


def pages_die(data: bytes, pnos: list[int]) -> dict:
    os._exit(9)


def pages_slow_but_moving(data: bytes, pnos: list[int]) -> dict:
    out = {}
    for p in pnos:
        time.sleep(0.6)
        out[p] = os.getpid()
        pool.page_done(p)
    return out


def read_pages_hang(data: bytes, pnos: list[int], force: bool) -> dict:
    time.sleep(3600)
    return {}


@pytest.fixture
def two_workers(monkeypatch):
    monkeypatch.setenv("ANON_OCR_WORKERS", "2")
    monkeypatch.setattr(guard, "PAGE_S", 2.0)
    pool.reset("test start")
    yield
    pool.reset("test end")


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def test_a_hung_worker_is_killed_and_the_next_call_gets_a_fresh_pool(two_workers):
    before = set(pool.pages(pages_ok, b"", [0, 1, 2, 3]).values())
    t = time.monotonic()
    with pytest.raises(guard.StepTimeout, match="no page in 2 s"):
        pool.pages(pages_hang, b"", [0, 1])
    assert time.monotonic() - t < 6
    deadline = time.monotonic() + 5
    while any(alive(p) for p in before) and time.monotonic() < deadline:
        time.sleep(0.1)
    assert not any(alive(p) for p in before), "the hung workers were left running"
    after = pool.pages(pages_ok, b"", [0, 1, 2, 3])
    assert sorted(after) == [0, 1, 2, 3] and not set(after.values()) & before


def test_a_dead_worker_fails_the_call_and_the_pool_is_rebuilt(two_workers):
    with pytest.raises(guard.Unavailable, match="died"):
        pool.pages(pages_die, b"", [0, 1])
    assert sorted(pool.pages(pages_ok, b"", [0, 1])) == [0, 1]


def test_a_long_batch_that_keeps_finishing_pages_is_not_cut_short(two_workers):
    # Six pages of 0.6 s per worker: longer than PAGE_S in all, but never 2 s without a page.
    got = pool.pages(pages_slow_but_moving, b"", list(range(12)))
    assert sorted(got) == list(range(12))


def scan_pdf() -> bytes:
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), "Jean-François Tremblay, 1842 rue des Érables", fontsize=12)
    pix = page.get_pixmap(dpi=150)
    out = fitz.open()
    p = out.new_page(width=pix.width * 72 / 150, height=pix.height * 72 / 150)
    p.insert_image(p.rect, stream=pix.tobytes("png"))
    return out.tobytes()


def test_ocr_with_a_hung_worker_answers_504_and_the_next_one_works(two_workers, monkeypatch):
    data = scan_pdf()
    client = TestClient(app)
    with monkeypatch.context() as m:
        m.setattr(ocr, "_read_pages", read_pages_hang)
        r = client.post("/ocr", content=data, headers={"x-mime": PDF_MIME})
    assert r.status_code == 504, r.text
    assert "OCR worker finished no page" in r.json()["detail"]
    assert client.get("/health").status_code == 200
    r = client.post("/ocr", content=data, headers={"x-mime": PDF_MIME})
    assert r.status_code == 200, r.text
    ex = client.post("/extract", content=r.content, headers={"x-mime": PDF_MIME}).json()
    assert "Tremblay" in ex["text"]


def test_a_stuck_model_answers_504_turns_the_queue_away_and_health_says_so(monkeypatch):
    release = threading.Event()
    real = ner.find

    def stuck(text: str):
        if text.startswith("hang"):
            release.wait(30)
        return real(text) if not text.startswith("hang") else []

    monkeypatch.setattr(ner, "find", stuck)
    monkeypatch.setattr(main.NER_WORKER, "stall", 1.0)
    with TestClient(app) as tc:
        codes: dict[str, tuple[int, str]] = {}

        def post(name: str, text: str):
            r = tc.post("/ner", content=text.encode())
            codes[name] = (r.status_code, r.text)

        first = threading.Thread(target=post, args=("first", "hang"))
        first.start()
        time.sleep(0.3)
        second = threading.Thread(target=post, args=("second", "Jean Tremblay habite à Laval."))
        second.start()
        first.join(15)
        second.join(15)
        assert codes["first"][0] == 504 and "no progress" in codes["first"][1], codes
        assert codes["second"][0] == 503 and "stuck on an earlier /ner" in codes["second"][1], codes
        h = tc.get("/health")
        assert h.status_code == 503 and h.json()["stuck"][0]["lane"] == "ner", h.text
        release.set()
        deadline = time.monotonic() + 5
        while tc.get("/health").status_code != 200 and time.monotonic() < deadline:
            time.sleep(0.1)
        assert tc.get("/health").status_code == 200
        r = tc.post("/ner", content="Jean Tremblay habite au 1842, rue des Érables à Laval.".encode())
        assert r.status_code == 200 and r.json()["entities"], r.text


def run_py(code: str, env: dict, timeout: float = 30) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-c", code], cwd=ENGINE, env={**os.environ, **env}, capture_output=True, text=True, timeout=timeout)


def test_the_watchdog_restarts_an_engine_whose_lane_stays_stuck():
    code = """
import threading, time
from engine import guard
lane = guard.lane("engine", 0.5)
lane.submit("/ocr", lambda: threading.Event().wait())
guard.watch(interval=0.2)
time.sleep(20)
print("still running")
"""
    t = time.monotonic()
    p = run_py(code, {"ANON_ENGINE_GRACE_S": "0.5"})
    assert p.returncode == guard.EXIT_CODE, (p.returncode, p.stdout, p.stderr)
    assert time.monotonic() - t < 10
    assert "stuck" in p.stderr and "restarting the engine" in p.stderr
    assert 'File "<string>"' in p.stderr  # the stacks were dumped
    assert "still running" not in p.stdout


def test_a_frozen_interpreter_is_restarted_too():
    # A regex that never ends holds the GIL in C: no Python thread runs, the watchdog included.
    code = """
import re, time
from engine import guard
guard.watch(interval=0.2)
time.sleep(0.5)
re.match(r"(a+)+$", "a" * 64 + "b")
"""
    t = time.monotonic()
    p = run_py(code, {"ANON_ENGINE_FROZEN_S": "2"})
    assert p.returncode != 0 and time.monotonic() - t < 15, (p.returncode, p.stderr[-500:])
    assert "Timeout" in p.stderr, p.stderr[-500:]


def test_a_queued_request_whose_client_left_is_dropped():
    import asyncio

    from fastapi import HTTPException

    lane = guard.Lane("test", 30)
    release = threading.Event()
    ran: list[str] = []
    lane.submit("/ocr", lambda: release.wait(10))

    class Gone:
        async def is_disconnected(self) -> bool:
            return True

    async def go():
        with pytest.raises(HTTPException) as e:
            await main.run(lambda: ran.append("ran"), lane=lane, what="/extract", request=Gone())
        return e.value.status_code

    assert asyncio.run(go()) == 499
    release.set()
    lane.submit("/inspect", lambda: None)[0].result(5)
    assert ran == []
