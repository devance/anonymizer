"""Pages read in parallel: one process per performance core.

PyMuPDF and its Tesseract can't run on several threads, so OCR (reading a
scan, checking a rewritten file) goes to worker processes, each opening its
own copy of the PDF. Started at engine start so the first document doesn't
wait for them. ANON_OCR_WORKERS=1 keeps everything in the engine's process.

Every wait on a worker is bounded. Workers report each page they finish; a
batch whose worker finishes no page in guard.PAGE_S seconds is a hung worker,
and a worker that dies (out of memory, a crash in a C library) breaks the
pool. Either way the workers are killed, the request fails with a clear error,
and the next request gets a fresh pool. With workers, a single page goes to
them too: a worker can be killed, the engine's own thread can't, and Tesseract
holds the GIL while it reads (seconds at a time), which would stall /health.
"""

from __future__ import annotations

import itertools
import multiprocessing
import os
import queue
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from concurrent.futures.process import BrokenProcessPool

from . import guard

_lock = threading.Lock()
_pool: ProcessPoolExecutor | None = None
# Pages done, from the workers: (batch, pno). One queue per pool: a worker killed while writing can leave a queue unusable.
_done: multiprocessing.Queue | None = None
_batches = itertools.count(1)

# In a worker: where to report pages, and which batch is running.
_report: multiprocessing.Queue | None = None
_batch = 0


def workers() -> int:
    from .ner import _threads

    return max(1, int(os.environ.get("ANON_OCR_WORKERS") or min(4, _threads())))


def _orphan_watch(parent: int) -> None:
    """In each worker: leave as soon as the engine is gone. It exits at once when the app closes its stdin, or gets killed, without telling the workers."""

    def watch() -> None:
        while os.getppid() == parent:
            time.sleep(0.5)
        os._exit(0)

    threading.Thread(target=watch, name="orphan-watch", daemon=True).start()


def _init(parent: int, report: multiprocessing.Queue) -> None:
    global _report
    _report = report
    _orphan_watch(parent)


def _pool_get() -> tuple[ProcessPoolExecutor, multiprocessing.Queue]:
    global _pool, _done
    with _lock:
        if _pool is None:
            ctx = multiprocessing.get_context("spawn")
            _done = ctx.Queue()
            _pool = ProcessPoolExecutor(max_workers=workers(), mp_context=ctx, initializer=_init, initargs=(os.getpid(), _done))
        assert _done is not None
        return _pool, _done


def reset(why: str) -> None:
    """Kill the workers and drop the pool; the next call starts a fresh one."""
    global _pool, _done
    with _lock:
        pool, done = _pool, _done
        _pool = _done = None
    if pool is None:
        return
    procs = list((getattr(pool, "_processes", None) or {}).values())
    for p in procs:
        try:
            p.kill()
        except Exception:  # noqa: BLE001  already gone
            pass
    pool.shutdown(wait=False, cancel_futures=True)
    if done is not None:
        done.cancel_join_thread()
        done.close()
    guard.log(f"OCR workers restarted ({len(procs)} killed): {why}")
    warm()


def page_done(pno: int) -> None:
    """Called after each page: from a worker, tells the engine; in the engine, counts as the job's progress."""
    if _report is not None:
        try:
            _report.put_nowait((_batch, pno))
        except Exception:  # noqa: BLE001  progress is best effort; the result is what counts
            pass
    else:
        guard.beat()


def _run(batch: int, fn, data: bytes, pnos: list[int], *args) -> dict:
    """In a worker: one batch of pages."""
    global _batch
    _batch = batch
    return fn(data, pnos, *args)


def _ready() -> bool:
    import pymupdf  # noqa: F401  the slow part of a worker's start

    return True


def warm() -> None:
    """Start the workers in the background."""
    if workers() <= 1:
        return

    def go() -> None:
        try:
            pool, _ = _pool_get()
            for f in [pool.submit(_ready) for _ in range(workers())]:
                f.result(timeout=120)
        except (RuntimeError, BrokenProcessPool):
            pass  # reset meanwhile; the next pool warms itself
        except Exception as e:  # noqa: BLE001  a pool that can't start fails the first request instead, with its error
            guard.log(f"OCR workers did not start: {type(e).__name__}: {e}")

    threading.Thread(target=go, name="pool-warm", daemon=True).start()


def pages(fn, data: bytes, pnos: list[int], *args, page_s: float | None = None) -> dict:
    """
    fn(data, some_pnos, *args) -> {pno: result}, spread over the workers (in
    this process without them). fn calls page_done(pno) after each page. A
    batch that finishes no page in `page_s` seconds fails the call.
    """
    limit = guard.PAGE_S if page_s is None else page_s
    if workers() <= 1 or not pnos:
        return fn(data, pnos, *args)
    n = min(workers(), len(pnos))
    # Round robin: a document's heavy pages (scans, tables) tend to sit together.
    chunks = [pnos[i::n] for i in range(n)]
    try:
        pool, done_q = _pool_get()
    except OSError as e:
        # No worker processes on this machine (a sandbox without semaphores): read here, as with one worker.
        guard.log(f"OCR workers unavailable ({e}); reading pages in the engine's process")
        return fn(data, pnos, *args)
    ids = [next(_batches) for _ in chunks]
    try:
        futs = {pool.submit(_run, b, fn, data, c, *args): b for b, c in zip(ids, chunks)}
    except (BrokenProcessPool, RuntimeError) as e:
        reset(f"pool unusable: {type(e).__name__}")
        raise guard.Unavailable("the OCR workers had stopped; they were restarted, try again") from None
    last = {b: time.monotonic() for b in ids}
    out: dict = {}
    pending = set(futs)
    while pending:
        finished, pending = wait(pending, timeout=1.0, return_when=FIRST_COMPLETED)
        now = time.monotonic()
        for f in finished:
            try:
                out.update(f.result())
            except BrokenProcessPool:
                reset("a worker died")
                raise guard.Unavailable("an OCR worker died while reading pages (out of memory?); the workers were restarted, try again") from None
            last.pop(futs[f], None)
            guard.beat()
        while True:
            try:
                batch, _pno = done_q.get_nowait()
            except queue.Empty:
                break
            except (OSError, ValueError, EOFError):
                break
            if batch in last:
                last[batch] = now
                guard.beat()
        slow = [b for b in last if now - last[b] > limit]
        if slow and pending:
            reset(f"no page done in {limit:.0f} s")
            raise guard.StepTimeout(f"an OCR worker finished no page in {limit:.0f} s; the workers were restarted")
    return out
