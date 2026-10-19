"""The desktop entry point, run as the app runs it: a child process on a pipe."""

from __future__ import annotations

import http.client
import os
import subprocess
import sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
TOKEN = "test-token-0123456789abcdef"


def start(env: dict | None = None) -> subprocess.Popen:
    return subprocess.Popen(
        [sys.executable, "-m", "engine.desktop"],
        cwd=ENGINE,
        env={**os.environ, **(env if env is not None else {"ANON_ENGINE_TOKEN": TOKEN})},
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def request(port: int, method: str, path: str, auth: str | None, body: bytes | None = None, headers: dict | None = None) -> int:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    h = dict(headers or {})
    if auth is not None:
        h["Authorization"] = auth
    conn.request(method, path, body=body, headers=h)
    status = conn.getresponse().status
    conn.close()
    return status


def test_serves_on_announced_port_with_token_and_exits_with_its_parent():
    p = start()
    try:
        line = p.stdout.readline().decode().strip()
        assert line.startswith("ANON_ENGINE_PORT="), line
        port = int(line.split("=", 1)[1])
        assert request(port, "GET", "/health", f"Bearer {TOKEN}") == 200
        # Every route needs the token, /health included.
        assert request(port, "GET", "/health", None) == 401
        assert request(port, "GET", "/health", f"Bearer {TOKEN}x") == 401
        assert request(port, "GET", "/health", TOKEN) == 401
        assert request(port, "POST", "/inspect", None, b"%PDF-1.7", {"x-mime": "application/pdf"}) == 401
        # The app closing its end of stdin (or dying) stops the engine.
        p.stdin.close()
        assert p.wait(timeout=10) == 0
    finally:
        p.kill()


def test_refuses_to_start_without_a_token():
    env = {k: v for k, v in os.environ.items() if k != "ANON_ENGINE_TOKEN"}
    p = subprocess.run([sys.executable, "-m", "engine.desktop"], cwd=ENGINE, env=env, capture_output=True, timeout=60)
    assert p.returncode == 2
    assert b"ANON_ENGINE_TOKEN" in p.stderr


def test_selftest():
    p = subprocess.run([sys.executable, "-m", "engine.desktop", "--selftest"], cwd=ENGINE, capture_output=True, timeout=300)
    assert p.returncode == 0, p.stderr.decode()
    assert p.stdout.decode().strip() == "OK"
