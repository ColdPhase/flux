"""Explicit provider selection, preserved between runs without changing repo config."""

import json
import sqlite3

from .github import HarnessError


EFFORTS = {
    "codex": {"none", "minimal", "low", "medium", "high", "xhigh", "max"},
    "claude": {"low", "medium", "high", "xhigh", "max"},
}


def execution_options(provider, saved=None, model=None, effort=None, use_cli_defaults=False):
    options = {} if use_cli_defaults else dict(saved or {})
    if model is not None:
        if not isinstance(model, str) or not model.strip() or model.startswith("-") or any(
                char.isspace() or ord(char) < 32 for char in model):
            raise HarnessError("Model must be a nonempty CLI model ID or alias")
        options["model"] = model
    if effort is not None:
        options["reasoning_effort"] = effort
    options = {key: options.get(key) for key in ("model", "reasoning_effort")}
    if options["reasoning_effort"] is not None and options["reasoning_effort"] not in EFFORTS[provider]:
        raise HarnessError(f"Unsupported {provider} reasoning effort; choose {', '.join(sorted(EFFORTS[provider]))}")
    return options


def selection_summary(options):
    return ", ".join(f"{key}={value or 'CLI default (not pinned)'}" for key, value in options.items())


def saved_options(directory):
    database = directory / "journal.sqlite3"
    if not database.exists():
        return None
    connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
    try:
        row = connection.execute("SELECT value FROM state WHERE key='execution_options'").fetchone()
        return json.loads(row[0]) if row else None
    finally:
        connection.close()
