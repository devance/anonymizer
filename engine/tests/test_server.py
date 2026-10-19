"""The server entry point (web target, on the VPS), run as systemd runs it."""

from __future__ import annotations

import http.client
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
TOKEN = "server-token-0123456789abcdef"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start(env: dict) -> subprocess.Popen:
    return subprocess.Popen([sys.executable, "-m", "engine.server"], cwd=ENGINE, env={**os.environ, **env}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def status(port: int, path: str, auth: str | None = None) -> int:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    conn.request("GET", path, headers={"Authorization": auth} if auth else {})
    code = conn.getresponse().status
    conn.close()
    return code


def wait_up(port: int, auth: str | None = None) -> None:
    for _ in range(300):
        try:
            status(port, "/health", auth)
            return
        except OSError:
            time.sleep(0.1)
    raise AssertionError("engine did not start")


def test_serves_on_the_configured_port_and_checks_the_token():
    port = free_port()
    p = start({"ANON_ENGINE_PORT": str(port), "ANON_ENGINE_TOKEN": TOKEN, "ANON_OCR_WORKERS": "1"})
    try:
        wait_up(port)
        assert status(port, "/health") == 401
        assert status(port, "/health", "Bearer wrong-token-0123456789") == 401
        assert status(port, "/health", f"Bearer {TOKEN}") == 200
    finally:
        p.terminate()
        p.wait(10)


def test_without_a_token_it_serves_the_loopback_only():
    port = free_port()
    p = start({"ANON_ENGINE_PORT": str(port), "ANON_ENGINE_TOKEN": "", "ANON_OCR_WORKERS": "1"})
    try:
        wait_up(port)
        assert status(port, "/health") == 200
    finally:
        p.terminate()
        p.wait(10)
    refused = start({"ANON_ENGINE_HOST": "0.0.0.0", "ANON_ENGINE_PORT": str(free_port()), "ANON_ENGINE_TOKEN": ""})
    assert refused.wait(30) == 2
    assert b"refusing" in refused.stderr.read()
