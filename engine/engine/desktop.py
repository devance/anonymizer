"""Desktop entry point: the engine as a sidecar of the app.

    anon-engine              serve on 127.0.0.1 at a port the OS picks, announced
                             on stdout as ANON_ENGINE_PORT=<n>
    anon-engine --selftest   run generated documents through every endpoint, print OK

Every request needs `Authorization: Bearer $ANON_ENGINE_TOKEN`, /health
included. The engine exits as soon as its stdin closes: the app holds the
other end of that pipe, so the engine never outlives it.

Runs as `python -m engine.desktop` from engine/, and as the frozen bundle's
entry script (hence the absolute imports).
"""

from __future__ import annotations

import hmac
import os
import socket
import sys
import threading

TOKEN_ENV = "ANON_ENGINE_TOKEN"


class BearerAuth:
    """ASGI wrapper that turns away any request without the app's token."""

    def __init__(self, app, token: str):
        self.app = app
        self.expected = f"Bearer {token}".encode()

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            got = next((v for k, v in scope["headers"] if k == b"authorization"), b"")
            if not hmac.compare_digest(got, self.expected):
                await send({"type": "http.response.start", "status": 401, "headers": [(b"content-type", b"application/json"), (b"www-authenticate", b"Bearer")]})
                await send({"type": "http.response.body", "body": b'{"detail":"unauthorized"}'})
                return
        await self.app(scope, receive, send)


def server(token: str):
    import uvicorn

    from engine.main import app

    config = uvicorn.Config(
        BearerAuth(app, token),
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
    return uvicorn.Server(config)


def listen() -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    # Listening before the port is announced: an early connection waits in the backlog instead of being refused.
    sock.listen(128)
    return sock


def _watch_stdin() -> None:
    if sys.platform == "win32" and _poll_pipe():
        os._exit(0)
    try:
        while os.read(0, 4096):
            pass
    except OSError:
        pass
    os._exit(0)


def _poll_pipe() -> bool:
    """
    Windows: wait for the app's end of the stdin pipe to close without reading
    it. A read left pending on a pipe holds up every other call on it until
    it returns, GetFileType included, which each DLL's C runtime and each new
    Python process calls on stdin as it starts: the detection model's load
    and the OCR workers (sharing that stdin) then wait forever, and with them
    any thread start, so the engine stops answering. False when stdin isn't a
    pipe (a console): the read is used there.
    """
    import ctypes
    import msvcrt
    import time
    from ctypes import wintypes

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.GetFileType.argtypes = [wintypes.HANDLE]
    k32.PeekNamedPipe.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD, wintypes.LPVOID, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
    try:
        handle = wintypes.HANDLE(msvcrt.get_osfhandle(0))
    except OSError:
        return True  # no stdin at all: nothing holds the engine alive
    if k32.GetFileType(handle) != 3:  # FILE_TYPE_PIPE
        return False
    available = wintypes.DWORD()
    while k32.PeekNamedPipe(handle, None, 0, None, ctypes.byref(available), None):
        time.sleep(0.5)
    return True  # broken pipe: the app is gone


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if "--selftest" in argv:
        from engine.selftest import run

        return run()
    token = os.environ.get(TOKEN_ENV, "")
    if len(token) < 16:
        print(f"{TOKEN_ENV} must hold a token of 16+ characters", file=sys.stderr)
        return 2
    threading.Thread(target=_watch_stdin, name="stdin-watchdog", daemon=True).start()
    srv = server(token)
    from engine import guard, ner, pool

    ner.preload()
    pool.warm()
    guard.watch()
    sock = listen()
    print(f"ANON_ENGINE_PORT={sock.getsockname()[1]}", flush=True)
    srv.run(sockets=[sock])
    return 0


if __name__ == "__main__":
    # The OCR workers are this same program started again: send them to their loop, not to main().
    import multiprocessing

    multiprocessing.freeze_support()
    sys.exit(main())
