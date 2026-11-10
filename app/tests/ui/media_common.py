"""What the media recorders share (scripts/record_demo.sh runs them in the pinned Playwright container, not as tests).

The demo's people and names, the sign-in and API helpers, the provider mock's script call, and the forwarder that makes the origin
the app believes it is served from reachable inside the recording container.

Input (environment): FLUX_UI_ORIGIN, FLUX_UI_UPSTREAM, FLUX_DEMO_OWNER_PASSWORD, FLUX_DEMO_PARTNER_PASSWORD, FLUX_UI_SCREENSHOTS,
FLUX_ANTHROPIC_MOCK_URL.
"""

from __future__ import annotations

import json
import os
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import urllib.parse
import urllib.request
from pathlib import Path

from playwright.sync_api import APIRequestContext

from test_app_shell import ORIGIN, UPSTREAM, start_forwarder

SHOTS = Path(os.environ.get("FLUX_UI_SCREENSHOTS", "/screenshots"))
EMAIL = "ada@demo.flux.test"
PASSWORD = os.environ.get("FLUX_DEMO_OWNER_PASSWORD", "")
PARTNER = ("jonas@demo.flux.test", os.environ.get("FLUX_DEMO_PARTNER_PASSWORD", ""))
# The demo seed names the company "Riverside Makers (demo)"; the media scene renames it (media_scene.py).
COMPANY = "Riverside Makers"
PROJECT = "Community garden sensors"
MOCK = os.environ.get("FLUX_ANTHROPIC_MOCK_URL", "http://127.0.0.1:8090")


def sign_in(request: APIRequestContext, email: str, password: str) -> None:
    response = request.post(f"{ORIGIN}/api/auth/sign-in/email", data={"email": email, "password": password}, headers={"origin": ORIGIN})
    if response.status != 200:
        sys.exit(f"media: sign-in as {email} answered {response.status}; seed the demo first")


def call(request: APIRequestContext, method: str, path: str, body: dict | None = None, ok: tuple[int, ...] = (200, 201), headers: dict | None = None) -> dict:
    """One public API call as the person the request context is signed in as; the answer's JSON, or an exit that names the call."""
    response = request.fetch(f"{ORIGIN}{path}", method=method, data=json.dumps(body) if body is not None else None,
                             headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})})
    if response.status not in ok:
        sys.exit(f"media: {method} {path} answered {response.status}: {response.text()}")
    text = response.text()
    return json.loads(text) if text and text[:1] in "[{" else {}


def company_id(request: APIRequestContext) -> str:
    """The company's workspace id: the one workspace a Flux has that is the company (F-037)."""
    return next(item for item in call(request, "GET", "/api/v1/workspaces") if item.get("company"))["id"]


def project_id(request: APIRequestContext, name: str = PROJECT) -> str:
    return next(item for item in call(request, "GET", f"/api/v1/workspaces/{company_id(request)}/projects")["items"] if item["name"] == name)["id"]


def mock(path: str, body: dict | None = None) -> dict:
    """The TEST-ONLY provider mock of the recording stack (tests/ui/anthropic_mock.py): `/__script` sets the next answers."""
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"{MOCK}{path}", data=data, method="POST" if body is not None else "GET", headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read())


def start_recording_forwarder() -> None:
    """Makes ORIGIN reachable in this container, whatever it is.

    A loopback http origin is the tests' own forwarder. A public-looking https origin (scripts/record_demo.sh
    uses https://flux.example.com, so invite links and agent commands read like a real install, not
    127.0.0.1:38910) gets its name added to /etc/hosts and a listener on the origin's port that terminates TLS
    with a throwaway self-signed certificate and forwards to the API. The recorders then trust that certificate
    (`ignore_https_errors`). Nothing of this leaves the container."""
    if not ORIGIN.startswith("https://"):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        return
    parts = urllib.parse.urlsplit(ORIGIN)
    host, port = parts.hostname or "", parts.port or 443
    with open("/etc/hosts", "a", encoding="utf-8") as hosts:
        hosts.write(f"127.0.0.1 {host}\n")
    folder = tempfile.mkdtemp()
    key, cert = f"{folder}/key.pem", f"{folder}/cert.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1",
                    "-subj", f"/CN={host}", "-addext", f"subjectAltName=DNS:{host}"], check=True, capture_output=True)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(cert, key)
    upstream_host, _, upstream_port = UPSTREAM.partition(":")
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", port))
    server.listen(128)

    def pipe(source: socket.socket, target: socket.socket) -> None:
        try:
            while data := source.recv(65536):
                target.sendall(data)
        except OSError:
            pass
        finally:
            for end in (source, target):
                try:
                    end.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    def handle(raw: socket.socket) -> None:
        try:
            client = tls.wrap_socket(raw, server_side=True)
            remote = socket.create_connection((upstream_host, int(upstream_port or 80)), timeout=10)
        except OSError:
            raw.close()
            return
        remote.settimeout(None)
        remote.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        first = threading.Thread(target=pipe, args=(client, remote), daemon=True)
        first.start()
        pipe(remote, client)
        first.join()
        client.close()
        remote.close()

    def accept() -> None:
        while True:
            raw, _ = server.accept()
            threading.Thread(target=handle, args=(raw,), daemon=True).start()

    threading.Thread(target=accept, daemon=True).start()
