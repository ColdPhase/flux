"""Adapters for installed official CLIs; no copied login tokens or SDK packages."""

import json
import os
from pathlib import Path
import signal
import subprocess
import time

from .context import MAX_PROMPT_CHARS, check_prompt_size
from .github import HarnessError


RESULT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "outcome": {"type": "string", "enum": ["progress", "waiting", "blocked", "candidate-complete"]},
        "task": {"type": ["integer", "null"]},
        "role": {"type": "string", "enum": ["planning", "implementation", "review", "verification"]},
        "summary": {"type": "string"}, "next_action": {"type": "string"},
        "evidence": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["outcome", "task", "role", "summary", "next_action", "evidence"],
}


def validate_result(result):
    if not isinstance(result, dict) or set(result) != set(RESULT_SCHEMA["required"]):
        raise HarnessError("Provider returned an incomplete/unknown outcome schema")
    for field in ("outcome", "role"):
        if result[field] not in RESULT_SCHEMA["properties"][field]["enum"]:
            raise HarnessError(f"Unknown provider {field}")
    if result["task"] is not None and (type(result["task"]) is not int or result["task"] <= 0):
        raise HarnessError("Invalid task number")
    if result["outcome"] == "candidate-complete" and result["task"] is not None:
        raise HarnessError("Milestone acceptance uses a null task; task handoffs use waiting")
    if any(not isinstance(result[key], str) or not result[key].strip()
           for key in ("summary", "next_action")):
        raise HarnessError("Provider must return a summary and next action")
    if not isinstance(result["evidence"], list) or any(not isinstance(x, str) for x in result["evidence"]):
        raise HarnessError("Provider evidence must be a list of strings")
    return result


def provider_command(provider, root, turn_directory, session=None, options=None):
    options = options or {}
    schema_path = turn_directory / "result-schema.json"
    if provider == "codex":
        # Keep the sandbox; the worker needs its worktrees and GitHub network access.
        argv = ["codex", "--no-daemon", "--ask-for-approval", "never"]
        if options.get("model"):
            argv += ["--model", options["model"]]
        if options.get("reasoning_effort"):
            argv += ["-c", "model_reasoning_effort=" + json.dumps(options["reasoning_effort"])]
        argv += [
                "-c", 'sandbox_mode="workspace-write"',
                "-c", "sandbox_workspace_write.network_access=true",
                "-c", "sandbox_workspace_write.writable_roots=" + json.dumps([str(root)]), "exec"]
        if session:
            argv += ["resume", session]
        return argv + ["--json", "--output-schema", str(schema_path),
                       "--output-last-message", str(turn_directory / "result.json"), "-"]
    if provider == "claude":
        argv = ["claude", "-p", "--output-format", "stream-json", "--verbose",
                "--json-schema", json.dumps(RESULT_SCHEMA), "--permission-mode", "auto",
                "--permission-prompts", "none", "--add-dir", str(root)]
        if session:
            argv += ["--resume", session]
        if options.get("model"):
            argv += ["--model", options["model"]]
        if options.get("reasoning_effort"):
            argv += ["--effort", options["reasoning_effort"]]
        return argv
    raise HarnessError(f"Unsupported provider: {provider}")


def parse_output(provider, directory):
    events = []
    for line in (directory / "events.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            try:
                event = json.loads(line)
            except ValueError as error:
                raise HarnessError("CLI event stream is not JSON; see the private turn logs") from error
            if not isinstance(event, dict):
                raise HarnessError("CLI event stream contains a non-object event")
            events.append(event)
    session = None
    if provider == "codex":
        for event in events:
            if event.get("type") == "thread.started":
                session = event.get("thread_id")
            if event.get("type") in ("error", "turn.failed"):
                raise HarnessError("Codex reported a failed turn; see the private turn logs")
        try:
            result = json.loads((directory / "result.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise HarnessError("Codex did not produce a structured result") from error
    else:
        # Background subagents make Claude emit one result per resumed turn; use the latest structured one.
        results = [event for event in events if event.get("type") == "result"]
        structured = [event for event in results if event.get("structured_output") is not None]
        if not structured or any(event.get("is_error") for event in results):
            raise HarnessError("Claude did not produce a successful result; see the private turn logs")
        if any(event.get("permission_denials") for event in results):
            raise HarnessError("Claude denied a required action; review the private permission log")
        if len({event.get("session_id") for event in results}) != 1:
            raise HarnessError("Claude results span several sessions; see the private turn logs")
        response = structured[-1]
        result, session = response.get("structured_output"), response.get("session_id")
    if session is not None and not isinstance(session, str):
        raise HarnessError("CLI returned an invalid session ID")
    return validate_result(result), session


def terminate(process):
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        process.wait()
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)


def run_provider(provider, root, workspace, directory, prompt, deadline, tick, session=None, options=None,
                 idle_timeout=None):
    check_prompt_size(prompt)
    directory.mkdir(parents=True, exist_ok=False, mode=0o700)
    (directory / "result-schema.json").write_text(json.dumps(RESULT_SCHEMA), encoding="utf-8")
    (directory / "prompt.txt").write_text(prompt, encoding="utf-8")
    argv = provider_command(provider, root, directory, session, options)
    (directory / "execution.json").write_text(json.dumps({"provider": provider,
        "selection": options or {}, "argv": argv, "input_characters": len(prompt),
        "input_budget": MAX_PROMPT_CHARS}, indent=2), encoding="utf-8")
    process = None
    output_size, last_output = 0, time.monotonic()
    with (directory / "prompt.txt").open() as incoming, \
            (directory / "events.jsonl").open("w") as outgoing, \
            (directory / "stderr.log").open("w") as errors:
        try:
            process = subprocess.Popen(argv, cwd=workspace, stdin=incoming, stdout=outgoing,
                                       stderr=errors, start_new_session=True)
            while process.poll() is None:
                if time.monotonic() >= deadline:
                    raise HarnessError("Turn/run time limit reached; preserve and resume the checkpoint")
                size = (directory / "events.jsonl").stat().st_size
                if size != output_size:
                    output_size, last_output = size, time.monotonic()
                if idle_timeout is not None and time.monotonic() - last_output >= idle_timeout:
                    raise HarnessError("Provider event stream stalled; unfinished turn and files are preserved")
                tick()
                time.sleep(0.5)
            if process.returncode:
                raise HarnessError(f"{provider} exited {process.returncode}; see {directory / 'stderr.log'}")
        finally:
            if process is not None:
                terminate(process)
    return parse_output(provider, directory)
