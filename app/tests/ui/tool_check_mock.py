"""TEST ONLY (#1441, RT-1 rule 2): the answers of the browser suite's mock providers to the check that a model calls tools.

When a key is added in Connect AI the server sends the provider one small request on the key's model with one tool, `ping`, that the model
is asked to call (`checkToolCalling` in packages/agent-runtime). The suite's mocks answer it here, in the wire format the request came in
(Anthropic Messages, the OpenAI Responses API, Chat Completions): the model calls `ping`, unless its id says otherwise. A model whose id
contains `no-tools` answers in words only, and one that contains `check-fails` is answered with a 500, so a test can see the refusal. It is
never a provider: nothing here proves compatibility, billing or model behaviour. The app suite's mocks do the same (app/tests/app/support/
tool-answers.ts).
"""

from __future__ import annotations

import uuid

USAGE = {"input": 60, "output": 8}


def first_tool(body: dict, wire: str) -> str | None:
    tools = body.get("tools") or []
    if not tools:
        return None
    first = tools[0]
    return first.get("function", {}).get("name") if wire == "chat" else first.get("name")


def wire_of(path: str) -> str | None:
    """The wire format a request path is for, or None when it is not a request for an answer."""
    path = path.split("?")[0]
    if path.endswith("/v1/messages"):
        return "anthropic"
    if path.endswith("/responses"):
        return "responses"
    if path.endswith("/chat/completions"):
        return "chat"
    return None


def answer(path: str, body: dict) -> tuple[int, dict] | None:
    """The status and body that answer a check at `path`, or None when `path` is not one."""
    wire = wire_of(path)
    if wire is None:
        return None
    model = str(body.get("model", ""))
    if "check-fails" in model:
        return 500, {"error": {"message": "scripted failure", "type": "server_error"}}
    name = first_tool(body, wire)
    call = name if name and "no-tools" not in model else None
    unique = uuid.uuid4().hex[:12]
    if wire == "anthropic":
        content = [{"type": "tool_use", "id": f"toolu_{unique}", "name": call, "input": {}}] if call else [{"type": "text", "text": "ping"}]
        return 200, {"id": f"msg_{unique}", "type": "message", "role": "assistant", "model": model, "content": content,
                     "stop_reason": "tool_use" if call else "end_turn", "stop_sequence": None,
                     "usage": {"input_tokens": USAGE["input"], "output_tokens": USAGE["output"]}}
    usage = {"input_tokens": USAGE["input"], "output_tokens": USAGE["output"], "total_tokens": USAGE["input"] + USAGE["output"]}
    if wire == "responses":
        output = [{"id": f"fc_{unique}", "call_id": f"call_{unique}", "type": "function_call", "name": call, "arguments": "{}", "status": "completed"}] if call else [
            {"id": f"msg_{unique}", "type": "message", "status": "completed", "role": "assistant",
             "content": [{"type": "output_text", "text": "ping", "annotations": []}]}]
        return 200, {"id": f"resp_{unique}", "object": "response", "model": model, "status": "completed", "incomplete_details": None, "output": output, "usage": usage}
    message = ({"role": "assistant", "content": None, "tool_calls": [{"id": f"call_{unique}", "type": "function", "function": {"name": call, "arguments": "{}"}}]}
               if call else {"role": "assistant", "content": "ping"})
    return 200, {"id": f"chatcmpl-{unique}", "object": "chat.completion", "created": 1790000000, "model": model,
                 "choices": [{"index": 0, "finish_reason": "tool_calls" if call else "stop", "message": message}],
                 "usage": {"prompt_tokens": USAGE["input"], "completion_tokens": USAGE["output"], "total_tokens": USAGE["input"] + USAGE["output"]}}
