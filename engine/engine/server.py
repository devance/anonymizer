"""Server entry point: the engine as a service, for the web target's processor on the VPS.

    python -m engine.server     serve on ANON_ENGINE_HOST:ANON_ENGINE_PORT (default 127.0.0.1:8081)

The same app as the desktop's sidecar (engine.main), with the detection model
loaded and the OCR workers started before the first request. When
ANON_ENGINE_TOKEN is set, every request needs `Authorization: Bearer <token>`,
/health included; without one, the engine only listens on the loopback
interface. ANON_OCR_WORKERS caps the OCR processes (see engine.pool).

Nothing is written to disk: documents stay in memory for the length of a request.
"""

from __future__ import annotations

import ipaddress
import os
import sys

from engine.desktop import BearerAuth


def _loopback(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host == "localhost"


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if "--selftest" in argv:
        from engine.selftest import run

        return run()
    host = os.environ.get("ANON_ENGINE_HOST", "127.0.0.1")
    port = int(os.environ.get("ANON_ENGINE_PORT", "8081"))
    token = os.environ.get("ANON_ENGINE_TOKEN", "")
    if token and len(token) < 16:
        print("ANON_ENGINE_TOKEN must hold 16+ characters", file=sys.stderr)
        return 2
    if not token and not _loopback(host):
        print(f"refusing to listen on {host} without ANON_ENGINE_TOKEN", file=sys.stderr)
        return 2

    import uvicorn

    from engine import guard, ner, pool
    from engine.main import app

    ner.preload()
    pool.warm()
    guard.watch()
    print(f"engine listening on {host}:{port}, detection model {'ready' if ner.available() else 'missing'}, {pool.workers()} OCR workers", flush=True)
    uvicorn.run(
        BearerAuth(app, token) if token else app,
        host=host,
        port=port,
        loop="asyncio",
        http="h11",
        ws="none",
        lifespan="off",
        interface="asgi3",
        access_log=False,
        log_level="warning",
        server_header=False,
        date_header=False,
    )
    return 0


if __name__ == "__main__":
    # The OCR workers are this same program started again (spawn): send them to their loop, not to main().
    import multiprocessing

    multiprocessing.freeze_support()
    sys.exit(main())
