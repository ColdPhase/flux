"""Offline mock for the harness probe of 2026-11-13 (docs/product/research/agent-harness-2026-11.md).

Two servers in one process, standard library only:

* :8080  an OpenAI-compatible Chat Completions model (`/v1/chat/completions`, `/v1/models`), a minimal
         OpenAI Responses model (`/v1/responses`, what Codex speaks) and a minimal Anthropic Messages model
         (`/v1/messages`). It is never a model: on a request without a tool result it
         calls the offered tool whose name contains `flux_echo`; once a tool result is in the request it answers
         "DONE <first 40 characters of the result>". Every response reports usage (100 prompt / 10 completion).
* :8090  a minimal MCP server over streamable HTTP (`/mcp`, JSON responses) with one tool, `flux_echo`, that
         requires `Authorization: Bearer run-token` (a stand-in for Flux's run token).

Every model request is appended to /out/journal.jsonl: the client's user agent, the tool names it offered, the
size of its system prompt and of its tool definitions, and whether it asked for streaming. That is how the probe
reads which built-in tools a harness declares and how many bytes it sends before any work.
"""
import json
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OUT = sys.argv[1] if len(sys.argv) > 1 else "/out"
LOCK = threading.Lock()
USAGE = {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110}


def journal(entry):
    with LOCK, open(f"{OUT}/journal.jsonl", "a") as f:
        f.write(json.dumps(entry) + "\n")


def tool_names_openai(tools):
    names = []
    for t in tools or []:
        fn = t.get("function") or t
        names.append(fn.get("name") or t.get("type"))
    return names


class Model(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0].endswith("/responses"):
            return self._json(426, {"error": "mock: no websocket"})
        if self.path.rstrip("/").endswith("/models"):
            return self._json(200, {"object": "list", "data": [{"id": "mock-model", "object": "model", "owned_by": "mock",
                                                                "created": 0}]})
        self._json(404, {"error": "not found"})

    def do_HEAD(self):
        self.send_response(200)
        self.send_header("content-length", "0")
        self.end_headers()

    def _sse(self, events):
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()
        for ev in events:
            self.wfile.write(ev.encode())
            self.wfile.flush()
        self.close_connection = True

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            req = json.loads(raw or b"{}")
        except Exception:
            req = {}
        path = self.path.split("?")[0]
        if path.endswith("/chat/completions"):
            return self.chat(req, raw)
        if path.endswith("/responses"):
            return self.responses_api(req, raw)
        if path.endswith("/messages/count_tokens"):
            return self._json(200, {"input_tokens": 100})
        if path.endswith("/messages"):
            return self.messages(req, raw)
        journal({"t": time.time(), "path": path, "agent": self.headers.get("user-agent"), "unhandled": True})
        self._json(404, {"error": {"message": "mock: unsupported path " + path}})

    # OpenAI Chat Completions ------------------------------------------------------------------------------------
    def chat(self, req, raw):
        msgs = req.get("messages") or []
        tools = req.get("tools") or []
        names = tool_names_openai(tools)
        system = "".join(m.get("content") if isinstance(m.get("content"), str) else json.dumps(m.get("content"))
                         for m in msgs if m.get("role") in ("system", "developer"))
        results = [m for m in msgs if m.get("role") == "tool"]
        journal({"t": time.time(), "api": "chat", "agent": self.headers.get("user-agent"), "model": req.get("model"),
                 "stream": bool(req.get("stream")), "tools": names, "system_chars": len(system),
                 "tools_bytes": len(json.dumps(tools)), "request_bytes": len(raw), "tool_results": len(results)})
        echo = next((x for x in names if x and "flux_echo" in x), None)
        cid = "chatcmpl-" + uuid.uuid4().hex[:8]
        if results:
            text = "DONE " + str(results[-1].get("content"))[:40]
            call = None
        elif echo:
            text, call = None, {"id": "call_" + uuid.uuid4().hex[:8], "type": "function",
                                "function": {"name": echo, "arguments": json.dumps({"text": "hello from the probe"})}}
        else:
            text, call = "NO FLUX TOOL OFFERED", None
        finish = "tool_calls" if call else "stop"
        if not req.get("stream"):
            msg = {"role": "assistant", "content": text}
            if call:
                msg["tool_calls"] = [call]
            return self._json(200, {"id": cid, "object": "chat.completion", "created": int(time.time()),
                                    "model": req.get("model"), "choices": [{"index": 0, "message": msg,
                                                                            "finish_reason": finish}], "usage": USAGE})
        def chunk(delta, fin=None, usage=None):
            c = {"id": cid, "object": "chat.completion.chunk", "created": int(time.time()), "model": req.get("model"),
                 "choices": [{"index": 0, "delta": delta, "finish_reason": fin}]}
            if usage:
                c["usage"] = usage
            return "data: " + json.dumps(c) + "\n\n"
        evs = [chunk({"role": "assistant", "content": ""})]
        if call:
            evs.append(chunk({"tool_calls": [{"index": 0, **call}]}))
        else:
            evs.append(chunk({"content": text}))
        evs.append(chunk({}, finish))
        last = {"id": cid, "object": "chat.completion.chunk", "created": int(time.time()), "model": req.get("model"),
                "choices": [], "usage": USAGE}
        evs.append("data: " + json.dumps(last) + "\n\n")
        evs.append("data: [DONE]\n\n")
        self._sse(evs)

    # OpenAI Responses (what Codex speaks) ------------------------------------------------------------------------
    def responses_api(self, req, raw):
        items = req.get("input") or []
        items = items if isinstance(items, list) else [{"type": "message", "role": "user", "content": items}]
        tools = req.get("tools") or []
        names = []
        for t in tools:
            names.append(t.get("name") or t.get("type"))
            for sub in t.get("tools") or []:  # a namespace of tools
                names.append((t.get("name") or "") + "." + (sub.get("name") or ""))
        instr = req.get("instructions") or ""
        dev = "".join(json.dumps(i.get("content")) for i in items if i.get("role") in ("developer", "system"))
        results = [i for i in items if i.get("type") in ("function_call_output", "custom_tool_call_output")]
        journal({"t": time.time(), "api": "responses", "agent": self.headers.get("user-agent"), "model": req.get("model"),
                 "stream": bool(req.get("stream")), "tools": names, "system_chars": len(instr) + len(dev),
                 "tools_bytes": len(json.dumps(tools)), "request_bytes": len(raw), "tool_results": len(results)})
        echo = next((x for x in names if x and "flux_echo" in x), None)
        rid = "resp_" + uuid.uuid4().hex[:8]
        if results:
            item = {"type": "message", "id": "msg_1", "role": "assistant", "status": "completed",
                    "content": [{"type": "output_text", "text": "DONE " + str(results[-1].get("output"))[:40], "annotations": []}]}
        elif echo:
            ns, _, nm = echo.rpartition(".")
            item = {"type": "function_call", "id": "fc_1", "call_id": "call_" + uuid.uuid4().hex[:8], "name": nm,
                    "arguments": json.dumps({"text": "hello from the probe"}), "status": "completed"}
            if ns:
                item["namespace"] = ns
        else:
            item = {"type": "message", "id": "msg_1", "role": "assistant", "status": "completed",
                    "content": [{"type": "output_text", "text": "NO FLUX TOOL OFFERED", "annotations": []}]}
        usage = {"input_tokens": 100, "input_tokens_details": {"cached_tokens": 0}, "output_tokens": 10,
                 "output_tokens_details": {"reasoning_tokens": 0}, "total_tokens": 110}
        def ev(name, data):
            return f"event: {name}\ndata: {json.dumps(data)}\n\n"
        self._sse([ev("response.created", {"type": "response.created", "response": {"id": rid}}),
                   ev("response.output_item.added", {"type": "response.output_item.added", "output_index": 0, "item": item}),
                   ev("response.output_item.done", {"type": "response.output_item.done", "output_index": 0, "item": item}),
                   ev("response.completed", {"type": "response.completed",
                                             "response": {"id": rid, "status": "completed", "usage": usage, "output": [item]}})])

    # Anthropic Messages -----------------------------------------------------------------------------------------
    def messages(self, req, raw):
        msgs = req.get("messages") or []
        tools = req.get("tools") or []
        names = [t.get("name") for t in tools]
        system = req.get("system")
        system_s = system if isinstance(system, str) else json.dumps(system or "")
        results = [b for m in msgs if m.get("role") == "user" and isinstance(m.get("content"), list)
                   for b in m["content"] if isinstance(b, dict) and b.get("type") == "tool_result"]
        journal({"t": time.time(), "api": "messages", "agent": self.headers.get("user-agent"), "model": req.get("model"),
                 "stream": bool(req.get("stream")), "tools": names, "system_chars": len(system_s),
                 "tools_bytes": len(json.dumps(tools)), "request_bytes": len(raw), "tool_results": len(results)})
        echo = next((x for x in names if x and "flux_echo" in x), None)
        mid = "msg_" + uuid.uuid4().hex[:8]
        if results:
            c = results[-1].get("content")
            block = {"type": "text", "text": "DONE " + (json.dumps(c) if not isinstance(c, str) else c)[:40]}
        elif echo:
            block = {"type": "tool_use", "id": "toolu_" + uuid.uuid4().hex[:8], "name": echo,
                     "input": {"text": "hello from the probe"}}
        else:
            block = {"type": "text", "text": "NO FLUX TOOL OFFERED"}
        stop = "tool_use" if block["type"] == "tool_use" else "end_turn"
        usage = {"input_tokens": 100, "output_tokens": 10, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
        if not req.get("stream"):
            return self._json(200, {"id": mid, "type": "message", "role": "assistant", "model": req.get("model"),
                                    "content": [block], "stop_reason": stop, "usage": usage})
        def ev(name, data):
            return f"event: {name}\ndata: {json.dumps(data)}\n\n"
        evs = [ev("message_start", {"type": "message_start", "message": {"id": mid, "type": "message", "role": "assistant",
                                                                          "model": req.get("model"), "content": [],
                                                                          "stop_reason": None, "usage": usage}})]
        if block["type"] == "text":
            evs.append(ev("content_block_start", {"type": "content_block_start", "index": 0,
                                                  "content_block": {"type": "text", "text": ""}}))
            evs.append(ev("content_block_delta", {"type": "content_block_delta", "index": 0,
                                                  "delta": {"type": "text_delta", "text": block["text"]}}))
        else:
            evs.append(ev("content_block_start", {"type": "content_block_start", "index": 0,
                                                  "content_block": {"type": "tool_use", "id": block["id"],
                                                                    "name": block["name"], "input": {}}}))
            evs.append(ev("content_block_delta", {"type": "content_block_delta", "index": 0,
                                                  "delta": {"type": "input_json_delta",
                                                            "partial_json": json.dumps(block["input"])}}))
        evs.append(ev("content_block_stop", {"type": "content_block_stop", "index": 0}))
        evs.append(ev("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop},
                                        "usage": {"output_tokens": 10}}))
        evs.append(ev("message_stop", {"type": "message_stop"}))
        self._sse(evs)


class Mcp(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, obj=None, headers=None):
        body = json.dumps(obj).encode() if obj is not None else b""
        self.send_response(code)
        if obj is not None:
            self.send_header("content-type", "application/json")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send(405)

    def do_DELETE(self):
        self._send(200)

    def do_POST(self):
        if self.headers.get("authorization") != "Bearer run-token":
            journal({"t": time.time(), "mcp": "unauthorized", "agent": self.headers.get("user-agent")})
            return self._send(401, {"error": "unauthorized"})
        n = int(self.headers.get("content-length") or 0)
        msg = json.loads(self.rfile.read(n) or b"{}")
        batch = msg if isinstance(msg, list) else [msg]
        out = []
        for m in batch:
            method, mid = m.get("method"), m.get("id")
            journal({"t": time.time(), "mcp": method, "agent": self.headers.get("user-agent"),
                     "protocol": (m.get("params") or {}).get("protocolVersion")})
            if mid is None:
                continue
            if method == "initialize":
                res = {"protocolVersion": (m.get("params") or {}).get("protocolVersion", "2025-06-18"),
                       "capabilities": {"tools": {}}, "serverInfo": {"name": "flux", "version": "probe"}}
            elif method == "tools/list":
                res = {"tools": [{"name": "flux_echo", "description": "Echo the text back (Flux probe tool).",
                                  "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}},
                                                  "required": ["text"]}}]}
            elif method == "tools/call":
                text = ((m.get("params") or {}).get("arguments") or {}).get("text", "")
                res = {"content": [{"type": "text", "text": "echo: " + text}], "isError": False}
            elif method in ("ping",):
                res = {}
            elif method in ("resources/list", "prompts/list", "resources/templates/list"):
                res = {method.split("/")[0]: []} if method != "resources/templates/list" else {"resourceTemplates": []}
            else:
                out.append({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "Method not found"}})
                continue
            out.append({"jsonrpc": "2.0", "id": mid, "result": res})
        if not out:
            return self._send(202)
        self._send(200, out if isinstance(msg, list) else out[0], {"mcp-session-id": "probe-session"})


if __name__ == "__main__":
    threading.Thread(target=ThreadingHTTPServer(("0.0.0.0", 8090), Mcp).serve_forever, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 8080), Model).serve_forever()
