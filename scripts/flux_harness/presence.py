"""Paired execution guard. Heartbeats are metadata, never model prompts or task claims."""

from datetime import datetime
import json
import time
import uuid

from .github import HarnessError, digest


MARKER = "<!-- flux-presence:v1\n"
HEALTHY = {"ready", "working", "waiting"}
TERMINAL = {"stopped", "suspended", "complete"}


class PeerUnavailable(HarnessError):
    """The pair cannot continue; preserve unfinished work and end this invocation."""


def record(comment):
    body = comment.get("body", "")
    if not isinstance(body, str) or not body.startswith(MARKER):
        return None
    try:
        payload, _ = body[len(MARKER):].split("\n-->", 1)
        data = json.loads(payload)
        return data if isinstance(data, dict) else None
    except (ValueError, TypeError):
        return None


class PeerGuard:
    def __init__(self, github, config, worker, state):
        # Dedicated transport: no recursive heartbeat hook on our own API calls.
        self.github, self.config, self.worker, self.state = github, config, worker, state
        self.peer = next(item for item in config["workers"] if item["id"] != worker["id"])
        self.settings = config["peer_watch"]
        self.issue = self.settings["issue_number"]
        self.signature = digest({"version": config["version"], "workers": config["workers"],
                                 "peer_watch": self.settings})
        self.run_id = str(uuid.uuid4())
        self.comment_id = None
        self.sequence = 0
        self.last_poll = float("-inf")
        self.reason = "Peer presence has not been checked"

    def _comment(self, comments, worker):
        matches = [item for item in comments
                   if item.get("user", {}).get("login", "").casefold() == worker["github_login"].casefold()
                   and isinstance(item.get("body"), str) and item["body"].startswith(MARKER)]
        if len(matches) > 1:
            raise PeerUnavailable(f"Multiple presence records for {worker['id']}; reconcile before resuming")
        return matches[0] if matches else None

    def start(self):
        issue = self.github.api(f"{self.github.prefix}/issues/{self.issue}")
        if issue.get("milestone") is not None or "pull_request" in issue:
            raise HarnessError("The presence issue must be an issue outside product milestones")
        return self.poll("ready", force=True)

    def _peer_reason(self, comment):
        name = self.peer["id"]
        if comment is None:
            return f"No authenticated heartbeat from {name}"
        data = record(comment)
        if not data or data.get("worker") != name or not isinstance(data.get("run_id"), str) or not data["run_id"]:
            return f"Invalid heartbeat from {name}"
        if data.get("config_digest") != self.signature:
            return f"{name} uses a different peer-watch configuration; both workers must upgrade"
        if not isinstance(data.get("status"), str) or data["status"] not in HEALTHY:
            return f"{name} is stopped, suspended or unavailable"
        try:
            updated = datetime.fromisoformat(comment["updated_at"].replace("Z", "+00:00"))
            if updated.tzinfo is None:
                raise ValueError("Missing timezone")
            age = time.time() - updated.timestamp()
        except (KeyError, ValueError, TypeError, AttributeError):
            return f"Invalid heartbeat timestamp from {name}"
        if age < -60 or age >= self.settings["stale_after_seconds"]:
            return f"Heartbeat from {name} expired or clock is inconsistent"
        return None

    def poll(self, status, force=False):
        if not force and time.monotonic() - self.last_poll < self.settings["heartbeat_seconds"]:
            return self.reason
        if status not in HEALTHY | TERMINAL:
            raise HarnessError("Invalid local presence status")
        comments = self.github.comments(self.issue)
        own = self._comment(comments, self.worker)
        if self.comment_id is not None:
            if own is None or own["id"] != self.comment_id or (record(own) or {}).get("run_id") != self.run_id:
                raise PeerUnavailable("Local presence was replaced; another invocation may be using this identity")
        self.sequence += 1
        body = MARKER + json.dumps({
            "worker": self.worker["id"], "run_id": self.run_id, "status": status,
            "config_digest": self.signature, "sequence": self.sequence,
        }, sort_keys=True) + "\n-->\n" + f"Worker `{self.worker['id']}`: **{status}**.\n"
        if own is None:
            saved = self.github.api(f"{self.github.prefix}/issues/{self.issue}/comments", "POST", {"body": body})
        else:
            saved = self.github.api(f"{self.github.prefix}/issues/comments/{own['id']}", "PATCH", {"body": body})
        self.comment_id = saved["id"]
        self.state.set("presence", {"run_id": self.run_id, "comment_id": self.comment_id, "status": status})
        peer = self._comment(comments, self.peer)
        self.reason = self._peer_reason(peer)
        self.last_poll = time.monotonic()
        self.state.set("peer_presence", {"worker": self.peer["id"], "reason": self.reason,
            "updated_at": peer.get("updated_at") if peer else None,
            "status": (record(peer) or {}).get("status") if peer else None})
        return self.reason

    def check(self, status="working"):
        reason = self.poll(status)
        if reason is not None:
            raise PeerUnavailable(reason + "; paired execution suspended, unfinished work preserved")

    def close(self, status):
        if self.comment_id is None:
            return
        # Best effort, bounded even after the run deadline or a transport outage.
        self.github.deadline = time.monotonic() + 5
        try:
            self.poll(status, force=True)
        except Exception:
            pass  # The other worker will stop when our last heartbeat expires.
