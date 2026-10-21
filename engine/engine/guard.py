"""Bounded waits: every request the engine takes ends, with its answer or a clear error.

The work runs in two lanes, each one thread taking jobs in arrival order: "engine"
(PyMuPDF and OCR, which aren't thread-safe) and "ner" (the detection model). A job
shows it is moving by calling `beat()`: each page read, written or checked, each
batch of the model. The request waiting on a job gives up with 504 when its job
goes quiet for the lane's `stall` seconds. Requests still queued behind a stalled
job are turned away with 503 instead of queueing forever, /health reports the
stalled lane, and when the job hasn't come back `GRACE_S` later the engine dumps
every thread's stack and exits so its supervisor (systemd on the VPS, the app on
the desktop) starts a fresh one. A Python thread can't be killed: a fresh
process is the only way out of a hang inside PyMuPDF, Tesseract or the model.

Pages read in the OCR workers (engine.pool) are timed there: a worker that
finishes no page in `PAGE_S` seconds is killed with its pool, so a hung or dead
worker costs one request, not the engine. `stall` for the engine lane is longer
than `PAGE_S`, so the pool recovers on its own before the engine would restart.

If Python itself stops running (C code holding the GIL forever), the watchdog
thread can't run either; faulthandler's own C thread then fires after
`FROZEN_S` and does the same dump and exit.

Times are monotonic: a laptop's sleep doesn't count against a job.
Logs: code locations, request paths, seconds. Never document content.
"""

from __future__ import annotations

import faulthandler
import os
import sys
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field


def _env(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name) or default)
    except ValueError:
        return default


# One page in an OCR worker. The slowest page measured on an M1 core (a dense page
# scanned upside down: four readings) takes 30 s; the VPS's workers share 1.5 cores.
PAGE_S = _env("ANON_PAGE_BUDGET_S", 300)
# A lane's job that shows no progress this long is stalled.
ENGINE_STALL_S = _env("ANON_ENGINE_STALL_S", PAGE_S + 60)
# One batch of the detection model (16 lines) takes about 0.05 s on an M1.
NER_STALL_S = _env("ANON_NER_STALL_S", 60)
# After a lane stalls: how long it may take to come back before the engine restarts.
GRACE_S = _env("ANON_ENGINE_GRACE_S", 60)
# Python frozen this long (no thread can run): faulthandler dumps the stacks and exits.
FROZEN_S = _env("ANON_ENGINE_FROZEN_S", 600)
EXIT_CODE = 70


class EngineFailure(Exception):
    """A request that can't be answered as asked; `status` is its HTTP status."""

    status = 500


class StepTimeout(EngineFailure):
    status = 504


class Unavailable(EngineFailure):
    """Worth trying again shortly: the engine is restarting a part of itself."""

    status = 503


def log(msg: str) -> None:
    print(f"engine: {msg}", file=sys.stderr, flush=True)


@dataclass
class Job:
    what: str
    lane: Lane
    queued: float = field(default_factory=time.monotonic)
    started: float | None = None
    beat: float = 0.0
    done: bool = False

    def quiet(self) -> float:
        """Seconds since this job last showed progress (0 while queued)."""
        return 0.0 if self.started is None or self.done else time.monotonic() - self.beat


_local = threading.local()


def beat() -> None:
    """The current job moved (a page, a batch). Cheap; a no-op outside a lane."""
    job = getattr(_local, "job", None)
    if job is not None:
        job.beat = time.monotonic()


class Lane:
    """One thread, jobs in arrival order, each one watched."""

    def __init__(self, name: str, stall: float):
        self.name = name
        self.stall = stall
        self._exec = ThreadPoolExecutor(max_workers=1, thread_name_prefix=name)
        self.current: Job | None = None

    def submit(self, what: str, fn, *args) -> tuple[Future, Job]:
        job = Job(what, self)

        def call():
            job.started = job.beat = time.monotonic()
            self.current = job
            _local.job = job
            try:
                return fn(*args)
            finally:
                job.done = True
                _local.job = None
                self.current = None
                took = time.monotonic() - job.started
                if took > 60:
                    log(f"{self.name} lane: {what} took {took:.0f} s")

        return self._exec.submit(call), job

    def stalled(self) -> Job | None:
        """The running job, when it has gone quiet past the lane's limit."""
        job = self.current
        return job if job is not None and job.quiet() > self.stall else None


LANES: list[Lane] = []


def lane(name: str, stall: float) -> Lane:
    out = Lane(name, stall)
    LANES.append(out)
    return out


def stuck() -> list[dict]:
    """Stalled lanes, for /health."""
    return [{"lane": job.lane.name, "what": job.what, "quietFor": round(job.quiet())} for job in (lane.stalled() for lane in LANES) if job]


_watching = threading.Event()


def watch(interval: float = 5.0) -> None:
    """Start the watchdog (once): restart the engine when a lane stays stalled, or when Python stops running."""
    if _watching.is_set():
        return
    _watching.set()

    def loop() -> None:
        reported: set[int] = set()
        while True:
            # Re-armed while this thread runs; if it can't (the GIL held for good), the C thread exits for us.
            faulthandler.dump_traceback_later(FROZEN_S, exit=True)
            for ln in LANES:
                job = ln.stalled()
                if job is None:
                    continue
                if id(job) not in reported:
                    reported.add(id(job))
                    log(f"{ln.name} lane: {job.what} has made no progress for {job.quiet():.0f} s; the engine restarts in {GRACE_S:.0f} s if it doesn't come back")
                if job.quiet() > ln.stall + GRACE_S:
                    log(f"{ln.name} lane: {job.what} stuck for {job.quiet():.0f} s; restarting the engine. Thread stacks:")
                    faulthandler.dump_traceback(file=sys.stderr, all_threads=True)
                    sys.stderr.flush()
                    os._exit(EXIT_CODE)
            time.sleep(interval)

    threading.Thread(target=loop, name="watchdog", daemon=True).start()
