"""TEST ONLY (#68): a local mock of the two Anthropic endpoints the personal-run adapter uses.

The browser suite runs the real worker and the real `@flux/agent-runtime` Anthropic adapter
against this server (the `anthropic-mock` Compose service of scripts/check_ui.sh). It is never a
provider: nothing here proves compatibility, billing or model behaviour. The tests script its
next answers through `POST /__script` and read what the adapter sent through `GET /__requests`.

Script fields (all optional): `text` (a template; `{first}`, `{message}` and `{work}` become the
source labels found in the request input; `{second}` is the second message), `delay` (seconds before answering), `status` (an HTTP
error status to return instead), `stop_reason`, `input_tokens`, `output_tokens`.
"""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FIXTURE_KEY = "flux-test-fixture-not-a-provider-key"
DEFAULT = {"text": "Fact: the camera fails below 5 lux {first}. Interpretation: the ToF sensor is the better next test {message}.",
           "delay": 0.0, "status": None, "stop_reason": "end_turn", "input_tokens": None, "output_tokens": 120}

lock = threading.Lock()
script: dict = dict(DEFAULT)
requests: list[dict] = []


def labels(text: str) -> dict[str, str]:
    """Source labels of the adapter's input, e.g. `[S3] Message 2 by …` or `[S5] Open work item …`."""
    found = {"first": "", "second": "", "message": "", "work": "", "works": ""}
    messages = 0
    for label, rest in re.findall(r"^\[(S\d+)\] (.*)$", text, flags=re.M):
        found["first"] = found["first"] or f"[{label}]"
        if rest.startswith("Message "):
            found["message"] = f"[{label}]"
            messages += 1
            if messages == 2:
                found["second"] = f"[{label}]"
        if rest.startswith("Open work item"):
            found["works"] += f"[{label}] "
            if not found["work"]:
                found["work"] = label
    return found


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args) -> None:  # quiet
        return

    def reply(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        try:
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the adapter aborted the request (Stop)

    def do_GET(self) -> None:
        if self.path == "/__health":
            return self.reply(200, {"ok": True})
        if self.path == "/__requests":
            with lock:
                return self.reply(200, {"requests": list(requests)})
        return self.reply(404, {"type": "error", "error": {"type": "not_found_error", "message": "Not found"}})

    def do_POST(self) -> None:
        global script
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.path == "/__script":
            with lock:
                script = {**DEFAULT, **body}
                if body.get("reset"):
                    requests.clear()
            return self.reply(200, {"ok": True})
        with lock:
            current = dict(script)
            requests.append({"path": self.path, "key_ok": self.headers.get("x-api-key") == FIXTURE_KEY,
                             "retry_count": self.headers.get("x-stainless-retry-count"), "body": body, "at": time.time()})
        if self.headers.get("x-api-key") != FIXTURE_KEY:
            return self.reply(401, {"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}})
        text_in = "\n".join(str(message.get("content", "")) for message in body.get("messages", []))
        if self.path == "/v1/messages/count_tokens":
            return self.reply(200, {"input_tokens": max(1, len(text_in) // 4)})
        if self.path != "/v1/messages":
            return self.reply(404, {"type": "error", "error": {"type": "not_found_error", "message": "Not found"}})
        if current.get("delay"):
            time.sleep(float(current["delay"]))
        if current.get("status"):
            return self.reply(int(current["status"]), {"type": "error", "error": {"type": "api_error", "message": "scripted failure"}})
        text = str(current["text"]).format(**labels(text_in))
        return self.reply(200, {
            "id": f"msg_{uuid.uuid4().hex}", "type": "message", "role": "assistant", "model": body.get("model"),
            "content": [{"type": "text", "text": text}], "stop_reason": current["stop_reason"], "stop_sequence": None,
            "usage": {"input_tokens": current["input_tokens"] or max(1, len(text_in) // 4), "output_tokens": current["output_tokens"]},
        })


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8090), Handler).serve_forever()
