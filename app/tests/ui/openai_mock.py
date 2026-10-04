"""TEST ONLY (#179): a local OpenAI-compatible endpoint for the AI connection settings form.

The browser suite saves an owner connection whose base URL points here (the `openai-mock` Compose
service of scripts/check_ui.sh, allowed by the test stack's `FLUX_AI_PRIVATE_TARGETS`), and the
Flux server lists its models without a key. It is never a provider: nothing here proves
compatibility, billing or model behaviour. `GET /__requests` returns what reached it.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

lock = threading.Lock()
requests: list[dict] = []
MODELS = {"object": "list", "data": [{"id": "llama3.1:8b", "object": "model"}, {"id": "qwen2.5:7b-instruct", "object": "model"}]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args) -> None:  # quiet
        return

    def reply(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/__health":
            return self.reply(200, {"ok": True})
        if self.path == "/__requests":
            with lock:
                return self.reply(200, {"requests": list(requests)})
        with lock:
            requests.append({"method": "GET", "path": self.path, "authorization": self.headers.get("authorization")})
        if self.path == "/v1/models":
            return self.reply(200, MODELS)
        return self.reply(404, {"error": {"message": "not found"}})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8091), Handler).serve_forever()
