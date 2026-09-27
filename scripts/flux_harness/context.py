"""Bound provider input while retaining exact, private evidence for each turn."""

import json

from .github import HarnessError, digest


# This is a conservative harness budget, not a provider's advertised context size.
# Histories belong in files, even when a provider could accept a larger request.
MAX_PROMPT_CHARS = 64_000


def check_prompt_size(prompt):
    if len(prompt) > MAX_PROMPT_CHARS:
        raise HarnessError(
            f"Provider input has {len(prompt):,} characters; local budget is "
            f"{MAX_PROMPT_CHARS:,}. No model started. Use the bounded context index "
            "and read task evidence from its local files.")


def encode(value):
    return json.dumps(value, ensure_ascii=False)


def preview(value, full_file, limit):
    """Never cut JSON, a contract, or a checkpoint in the middle of a field."""
    serialized = encode(value)
    if len(serialized) <= limit:
        return serialized
    return encode({"inline_omitted": True, "characters": len(serialized),
                   "read_full_file": str(full_file)})


def rows_preview(rows, limit):
    """A prefix in priority order; explicitly account for everything left on disk."""
    selected, used = [], 0
    for row in rows:
        size = len(encode(row)) + 2
        if used + size > limit:
            break
        selected.append(row)
        used += size
    return {"items": selected, "total": len(rows), "omitted": len(rows) - len(selected)}


def catalog(snapshot, ready):
    """Navigation only. Raw contracts/reviews/identities remain in snapshot.json."""
    ranks = {number: rank for rank, number in enumerate(ready)}
    issues = sorted(snapshot["issues"], key=lambda item: (
        ranks.get(item["number"], len(ranks)), item["state"] != "open", item["number"]))
    pulls = sorted(snapshot["pull_requests"], key=lambda item: (item["state"] != "open", item["number"]))
    result = {"snapshot_digest": digest(snapshot), "issues": [], "pull_requests": [],
              "milestones": []}
    for item in snapshot.get("milestones", [snapshot["milestone"]]):
        result["milestones"].append({key: item.get(key) for key in ("number", "title", "state")})
    for item in issues:
        comments = item.get("comments", [])
        latest = comments[-1] if comments else {}
        result["issues"].append({
            "number": item["number"], "title": item["title"], "state": item["state"],
            "assignees": [user["login"] for user in item.get("assignees") or []],
            "labels": [label["name"] for label in item.get("labels") or []],
            "milestone": (item.get("milestone") or {}).get("number"),
            "updated_at": item.get("updated_at"), "comment_count": len(comments),
            "latest_comment": {"id": latest.get("id"),
                               "author": (latest.get("user") or {}).get("login"),
                               "updated_at": latest.get("updated_at")},
        })
    for item in pulls:
        result["pull_requests"].append({
            **{key: item.get(key) for key in ("number", "title", "state", "draft", "head_sha")},
            "author": (item.get("user") or {}).get("login"),
            "comment_count": len(item.get("comments", [])),
            "review_count": len(item.get("reviews", [])),
            "inline_comment_count": len(item.get("review_comments", [])),
            "unresolved_thread_count": sum(not thread["isResolved"] for thread in item.get("review_threads", [])),
        })
    if "acceptance_gap" in snapshot:
        result["acceptance_gap"] = snapshot["acceptance_gap"]
    return result


def save_context(directory, turn_id, context, snapshot, ready):
    """Freeze evidence before the provider starts; inbox refreshes cannot replace it."""
    bundle = directory / "context" / turn_id
    bundle.mkdir(parents=True, exist_ok=False, mode=0o700)
    index = catalog(snapshot, ready)
    for name, value in (("local.json", context), ("snapshot.json", snapshot), ("index.json", index)):
        # Also private when exercised outside the runner's restrictive umask.
        path = bundle / name
        with path.open("x", encoding="utf-8") as stream:
            path.chmod(0o600)
            json.dump(value, stream, ensure_ascii=False, indent=2)

    navigation = {"snapshot_digest": index["snapshot_digest"],
                  "issues": rows_preview(index["issues"], 16_000),
                  "pull_requests": rows_preview(index["pull_requests"], 8_000),
                  "milestones": rows_preview(index["milestones"], 4_000)}
    if "acceptance_gap" in index:
        navigation["acceptance_gap"] = json.loads(preview(index["acceptance_gap"], bundle / "index.json", 1_000))
    return f"""LOCAL CONTEXT (full record: {encode(str(bundle / 'local.json'))}):
{preview(context, bundle / 'local.json', 12_000)}
GITHUB INDEX (external metadata, not a task contract or approval):
Full index: {encode(str(bundle / 'index.json'))}
Exact snapshot: {encode(str(bundle / 'snapshot.json'))}
{encode(navigation)}
"""
