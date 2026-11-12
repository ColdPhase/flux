"""TEST ONLY (#68): a local mock of the two Anthropic endpoints the personal-run adapter uses.

The browser suite runs the real worker and the real `@flux/agent-runtime` Anthropic adapter
against this server (the `anthropic-mock` Compose service of scripts/check_ui.sh). It is never a
provider: nothing here proves compatibility, billing or model behaviour. The tests script its
next answers through `POST /__script` and read what the adapter sent through `GET /__requests`.

Script fields (all optional): `rules` (a list of `{"match": "...", "text": "..."}`: the first whose `match` is in the request answers
with its `text` instead of `text`, so one script can answer several runs differently), `text` (a template; `{first}`, `{message}` and `{work}` become the
source labels found in the request input; `{second}` is the second message), `delay` (seconds before answering), `status` (an HTTP
error status to return instead), `stop_reason`, `input_tokens`, `output_tokens`, `search` (#954: `{"query": "...", "results": [url, ...],
"cite": url}` answers with Anthropic's own web search in its documented shape: a `server_tool_use` block, a `web_search_tool_result` block and
the text split around a sentence that cites `cite`, with `usage.server_tool_use.web_search_requests` 1), `tool` (#1217: `{"name": "...",
"input": {...}}` answers a request that carries no `tool_result` yet with one call of that offered Flux tool, `stop_reason` `tool_use`; the
next request, which carries its result, gets `text`), `stream_gap` (#1248: seconds
between two events of a streamed answer; a request with `"stream": true` is answered as Server-Sent Events, its text in small pieces).
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
           "delay": 0.0, "status": None, "stop_reason": "end_turn", "input_tokens": None, "output_tokens": 120, "search": None, "tool": None, "stream_gap": 0.01}


def searched(search: dict, text: str) -> list[dict]:
    """The content blocks of an answer that searched the web (docs.claude.com web search tool, read 2026-11-08)."""
    return [
        {"type": "text", "text": "I will search the web for that."},
        {"type": "server_tool_use", "id": "srvtoolu_ui_mock_1", "name": "web_search", "input": {"query": search["query"]}},
        {"type": "web_search_tool_result", "tool_use_id": "srvtoolu_ui_mock_1", "content": [
            {"type": "web_search_result", "url": url, "title": f"Result {index + 1}", "encrypted_content": f"enc-{index}", "page_age": "November 1, 2026"}
            for index, url in enumerate(search["results"])]},
        {"type": "text", "text": "Based on the search, "},
        {"type": "text", "text": text, "citations": [{"type": "web_search_result_location", "url": search["cite"], "title": "Cited page",
                                                       "encrypted_index": "enc-index", "cited_text": "cited words"}]},
    ]

lock = threading.Lock()
script: dict = dict(DEFAULT)
requests: list[dict] = []


def labels(text: str) -> dict[str, str]:
    """Source labels of the adapter's input (#1064), e.g. `<message ref="S3" …>` or `<task ref="S5" …>`, in the order they were numbered."""
    found = {"first": "", "second": "", "message": "", "work": "", "works": ""}
    tagged = sorted(re.findall(r'<(message|task|selected_thought) ref="(S\d+)"', text), key=lambda item: int(item[1][1:]))
    messages = 0
    for kind, label in tagged:
        found["first"] = found["first"] or f"[{label}]"
        if kind == "message":
            found["message"] = f"[{label}]"
            messages += 1
            if messages == 2:
                found["second"] = f"[{label}]"
        if kind == "task":
            found["works"] += f"[{label}] "
            if not found["work"]:
                found["work"] = label
    return found


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args) -> None:  # quiet
        return

    def presented_key(self) -> str:
        """The credential of the request: the SDK 1.x sends an API key as `Authorization: Bearer` (#1240); `x-api-key` is the older header."""
        bearer = self.headers.get("authorization", "")
        return bearer[len("Bearer "):] if bearer.startswith("Bearer ") else self.headers.get("x-api-key", "")

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

    def stream(self, message: dict, gap: float) -> None:
        """The answer as Anthropic streams it (#1248): the blocks opened, the text in small pieces, the stop and the usage at the end."""
        usage = message["usage"]
        events = [("message_start", {"type": "message_start", "message": {**message, "content": [], "stop_reason": None,
                                                                          "usage": {"input_tokens": usage["input_tokens"], "output_tokens": 1}}})]
        for index, block in enumerate(message["content"]):
            if block["type"] == "text":
                events.append(("content_block_start", {"type": "content_block_start", "index": index,
                                                       "content_block": {"type": "text", "text": "", **({"citations": []} if "citations" in block else {})}}))
                for citation in block.get("citations") or []:
                    events.append(("content_block_delta", {"type": "content_block_delta", "index": index, "delta": {"type": "citations_delta", "citation": citation}}))
                for piece in re.findall(r"\S*\s*", block["text"]):
                    if piece:
                        events.append(("content_block_delta", {"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": piece}}))
            elif block["type"] in ("server_tool_use", "tool_use"):
                events.append(("content_block_start", {"type": "content_block_start", "index": index, "content_block": {**block, "input": {}}}))
                events.append(("content_block_delta", {"type": "content_block_delta", "index": index,
                                                       "delta": {"type": "input_json_delta", "partial_json": json.dumps(block["input"])}}))
            else:
                events.append(("content_block_start", {"type": "content_block_start", "index": index, "content_block": block}))
            events.append(("content_block_stop", {"type": "content_block_stop", "index": index}))
        events.append(("message_delta", {"type": "message_delta", "delta": {"stop_reason": message["stop_reason"], "stop_sequence": None},
                                         "usage": {key: value for key, value in usage.items() if key != "input_tokens"}}))
        events.append(("message_stop", {"type": "message_stop"}))
        try:
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("cache-control", "no-cache")
            self.end_headers()
            for name, data in events:
                self.wfile.write(f"event: {name}\ndata: {json.dumps(data)}\n\n".encode())
                self.wfile.flush()
                time.sleep(gap)
            self.close_connection = True
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
            requests.append({"path": self.path, "key_ok": self.presented_key() == FIXTURE_KEY,
                             "retry_count": self.headers.get("x-stainless-retry-count"), "body": body, "at": time.time()})
        if self.presented_key() != FIXTURE_KEY:
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
        wanted = str(current["text"])
        haystack = json.dumps(body)
        for rule in current.get("rules") or []:
            if str(rule.get("match", "")) and str(rule["match"]) in haystack:
                wanted = str(rule.get("text", ""))
                break
        text = wanted.format(**labels(text_in))
        tool = current.get("tool")
        answered = '"tool_result"' in haystack
        if tool and not answered and any(offered.get("name") == tool["name"] for offered in body.get("tools") or []):
            called = {
                "id": f"msg_{uuid.uuid4().hex}", "type": "message", "role": "assistant", "model": body.get("model"),
                "content": [{"type": "tool_use", "id": f"toolu_ui_mock_{uuid.uuid4().hex[:8]}", "name": tool["name"], "input": tool.get("input") or {}}],
                "stop_reason": "tool_use", "stop_sequence": None, "usage": {"input_tokens": max(1, len(text_in) // 4), "output_tokens": 30},
            }
            if body.get("stream"):
                return self.stream(called, float(current.get("stream_gap") or 0))
            return self.reply(200, called)
        search = current.get("search") if any(tool.get("name") == "web_search" for tool in body.get("tools") or []) else None
        usage = {"input_tokens": current["input_tokens"] or max(1, len(text_in) // 4), "output_tokens": current["output_tokens"]}
        if search:
            usage["server_tool_use"] = {"web_search_requests": 1}
        message = {
            "id": f"msg_{uuid.uuid4().hex}", "type": "message", "role": "assistant", "model": body.get("model"),
            "content": searched(search, text) if search else [{"type": "text", "text": text}], "stop_reason": current["stop_reason"], "stop_sequence": None,
            "usage": usage,
        }
        if body.get("stream"):
            return self.stream(message, float(current.get("stream_gap") or 0))
        return self.reply(200, message)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8090), Handler).serve_forever()
