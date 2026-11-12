"""TEST ONLY (#469): pages for the link card browser tests.

The Flux server reaches this as `public.test` (the `link-mock` Compose service of scripts/check_ui.sh,
named by the API's `FLUX_TEST_LINK_PREVIEW_HOSTS`), on the default port, so the address check of that one
name is the only rule bypassed. No real site is ever fetched. `GET /__hits` returns what reached it
(path and the request headers that matter), `GET /__reset` clears it.
"""

from __future__ import annotations

import json
import struct
import threading
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

lock = threading.Lock()
hits: list[dict] = []

DESCRIPTION = (
    "Sailings move to the winter timetable on 3 November. Crossings run twice a day, and the last boat leaves the island at 17:40, "
    "so check the harbour board before you set out. Foot passengers board first, then bicycles, then vehicles."
)
assert len(DESCRIPTION) <= 300  # the server keeps at most 300 characters, so this arrives whole


def page(head: str) -> str:
    return f"<!doctype html><html><head>{head}</head><body><h1>body</h1></body></html>"


PAGES = {
    "/ferry": page(f'<title>Fallback title</title><meta property="og:title" content="Harbour &amp; Co: the winter ferry timetable"><meta property="og:description" content="{DESCRIPTION}">'),
    "/title-only": page("<title>A page with a title and no description</title>"),
    "/secret": page('<title>SECRET internal page</title><meta name="description" content="should never be fetched">'),
}


def png(width: int, height: int) -> bytes:
    """#1217: a real picture an agent attaches (green and brown squares, like boards of a raised bed), with a text chunk the server drops."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    rows = b"".join(b"\0" + b"".join(bytes((76, 140, 74) if ((x // 24) + (y // 24)) % 2 == 0 else (150, 110, 70)) for x in range(width)) for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"tEXt", b"Author\0Somebody") + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


PICTURES = {"/pic/raised-bed.png": png(480, 320)}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args) -> None:  # quiet
        return

    def reply(self, status: int, body: str, content_type: str = "text/html; charset=utf-8", headers: dict | None = None) -> None:
        data = body.encode()
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(data)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        path = self.path
        if path == "/__health":
            return self.reply(200, "ok", "text/plain")
        if path == "/__reset":
            with lock:
                hits.clear()
            return self.reply(200, "{}", "application/json")
        if path == "/__hits":
            with lock:
                return self.reply(200, json.dumps(hits), "application/json")
        with lock:
            hits.append({"path": path, "user-agent": self.headers.get("user-agent"), "cookie": self.headers.get("cookie"),
                         "referer": self.headers.get("referer"), "authorization": self.headers.get("authorization")})
        if path in PAGES:
            return self.reply(200, PAGES[path])
        if path in PICTURES:
            data = PICTURES[path]
            self.send_response(200)
            self.send_header("content-type", "image/png")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return None
        if path == "/redirect-private":
            return self.reply(302, "", headers={"location": "http://link-mock/secret"})
        return self.reply(404, "not found", "text/plain")


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8098), Handler).serve_forever()
