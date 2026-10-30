#!/usr/bin/env python3
"""Exercise real account, workspace and content persistence from the packaged release.

`seed` signs a throwaway account up on one running release and writes through the public HTTP API what
an installation holds after some use: a workspace, a project, a conversation with a reply and a binary
attachment, a document with two versions, a work item and a private note. It records exactly what it
wrote in a state file. `verify` signs in again on a restored or upgraded instance, possibly of ANOTHER
release, and checks that every recorded item is still there (explicit fields and the exact attachment
bytes, never whole responses, so a field a newer release adds does not matter). `verify --write` also
proves the instance accepts a new message and reads it back.

Only routes that exist since the first release are used, because `seed` runs against the PREVIOUS
release in the upgrade leg of smoke_artifacts.sh.
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import secrets
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

WORKSPACE_NAME = "Release restore probe"
PROJECT_NAME = "Release project"
FILE_BYTES = bytes([0, 255, 128, 1, 10, 42, 0, 7, 200, 13])


class Client:
    def __init__(self, origin: str) -> None:
        self.origin = origin
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def raw(
        self, method: str, path: str, body: bytes | None = None,
        content_type: str | None = None, headers: dict[str, str] | None = None,
    ) -> tuple[int, bytes]:
        request_headers = {"Origin": self.origin, **(headers or {})}
        if content_type is not None:
            request_headers["Content-Type"] = content_type
        req = urllib.request.Request(self.origin + path, data=body, method=method, headers=request_headers)
        try:
            with self.opener.open(req, timeout=20) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"{method} {path} returned {error.code}: {error.read()[:400]!r}") from error

    def json(
        self, method: str, path: str, body: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, Any]:
        encoded = json.dumps(body).encode() if body is not None else None
        status, data = self.raw(method, path, encoded, "application/json" if encoded is not None else None, headers)
        return status, json.loads(data) if data else None

    def expect(
        self, method: str, path: str, body: dict[str, Any] | None = None,
        statuses: tuple[int, ...] = (200, 201), headers: dict[str, str] | None = None,
    ) -> Any:
        status, value = self.json(method, path, body, headers)
        if status not in statuses:
            raise RuntimeError(f"{method} {path} returned {status}: {value!r}")
        return value

    def all(self, path: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        while True:
            page = self.expect("GET", f"{path}{'&' if '?' in path else '?'}limit=100&offset={len(items)}")
            items.extend(page["items"])
            if len(items) >= page["total"] or not page["items"]:
                return items


def seed(client: Client, state_file: Path) -> None:
    if state_file.exists():
        raise ValueError("refusing to replace existing smoke state")
    tag = secrets.token_hex(4)
    email = f"release-{secrets.token_hex(8)}@example.test"
    password = secrets.token_urlsafe(32)
    client.expect("POST", "/api/auth/sign-up/email", {"email": email, "password": password, "name": "Release smoke user"}, (200,))
    user_id = client.expect("GET", "/api/v1/me")["user"]["id"]
    workspace = client.expect("POST", "/api/v1/workspaces", {"name": WORKSPACE_NAME}, (201,))
    project = client.expect(
        "POST", f"/api/v1/workspaces/{workspace['id']}/projects", {"name": PROJECT_NAME, "visibility": "workspace"},
    )
    project_id = project["id"]
    status, upload = client.raw(
        "POST", f"/api/v1/projects/{project_id}/files?{urllib.parse.urlencode({'uploadId': str(uuid.uuid4()), 'name': 'release-probe.bin'})}",
        FILE_BYTES, "application/octet-stream",
    )
    if status != 201:
        raise RuntimeError(f"file upload returned {status}")
    file_id = json.loads(upload)["id"]
    first = f"RELEASE-message-{tag}"
    reply = f"RELEASE-reply-{tag}"
    thread = client.expect("POST", f"/api/v1/projects/{project_id}/conversations", {
        "body": first, "attachmentIds": [file_id], "clientMessageId": str(uuid.uuid4()),
    })
    client.expect("POST", f"/api/v1/conversations/{thread['id']}/messages", {"body": reply, "clientMessageId": str(uuid.uuid4())})
    messages = client.expect("GET", f"/api/v1/conversations/{thread['id']}?limit=100")["messages"]
    expected_messages = [[message["sequence"], message["body"]] for message in messages]
    if [body for _, body in expected_messages] != [first, reply]:
        raise RuntimeError(f"seeded conversation reads back as {expected_messages!r}")
    doc_title = f"RELEASE-doc-{tag}"
    doc = client.expect(
        "POST", f"/api/v1/projects/{project_id}/docs", {"title": doc_title, "body": f"{doc_title}-v1"},
        (201,), {"Idempotency-Key": str(uuid.uuid4())},
    )
    client.expect(
        "PATCH", f"/api/v1/docs/{doc['id']}",
        {"body": f"{doc_title}-v2", "state": "published", "reason": "Second version"}, (200,),
        {"If-Match": f'"{doc["version"]}"'},
    )
    doc_versions = [
        [item["version"], item["state"], item["reason"]]
        for item in client.all(f"/api/v1/docs/{doc['id']}/versions")
    ]
    if len(doc_versions) != 2:
        raise RuntimeError(f"seeded document has {len(doc_versions)} versions, expected 2")
    work_title = f"RELEASE-work-{tag}"
    work = client.expect(
        "POST", f"/api/v1/projects/{project_id}/work",
        {"title": work_title, "owner": {"kind": "human", "id": user_id}, "sources": []},
    )
    note_title = f"RELEASE-private-note-{tag}"
    note = client.expect(
        "POST", f"/api/v1/workspaces/{workspace['id']}/drafts",
        {"title": note_title, "body": f"{note_title}-body", "projectId": project_id},
    )
    state_file.write_text(json.dumps({
        "email": email, "password": password, "workspace_id": workspace["id"], "project_id": project_id,
        "file_id": file_id, "file_hex": FILE_BYTES.hex(), "thread_id": thread["id"], "messages": expected_messages,
        "doc_id": doc["id"], "doc_versions": doc_versions, "work_id": work["id"], "work_title": work_title,
        "note_id": note["id"], "note_title": note_title,
    }), encoding="utf-8")
    state_file.chmod(0o600)
    print(
        "Release account, workspace, project, conversation (2 messages and an attachment), "
        "document (2 versions), work item and private note created"
    )


def check(state: dict[str, Any], observed: dict[str, Any]) -> list[str]:
    """What differs between the recorded content and the instance read back (empty when equal)."""
    problems: list[str] = []
    if observed["workspace_name"] != WORKSPACE_NAME:
        problems.append(f"workspace name {observed['workspace_name']!r}")
    if observed["project_names"].get(state["project_id"]) != PROJECT_NAME:
        problems.append("project missing or renamed")
    present = {tuple(message) for message in observed["messages"]}
    for sequence, body in state["messages"]:
        if (sequence, body) not in present:
            problems.append(f"message {sequence} {body!r} missing")
    if observed["file_hex"] != state["file_hex"]:
        problems.append("attachment bytes differ")
    if observed["doc_versions"] != state["doc_versions"]:
        problems.append(f"document versions {observed['doc_versions']!r}, recorded {state['doc_versions']!r}")
    if observed["work_title"] != state["work_title"]:
        problems.append(f"work title {observed['work_title']!r}")
    if observed["note_titles"].get(state["note_id"]) != state["note_title"]:
        problems.append("private note missing or renamed")
    return problems


def read_back(client: Client, state: dict[str, Any]) -> dict[str, Any]:
    workspace = client.expect("GET", f"/api/v1/workspaces/{state['workspace_id']}")
    projects = client.all(f"/api/v1/workspaces/{state['workspace_id']}/projects")
    messages = client.expect("GET", f"/api/v1/conversations/{state['thread_id']}?limit=100")["messages"]
    status, file_bytes = client.raw("GET", f"/api/v1/files/{state['file_id']}")
    versions = client.all(f"/api/v1/docs/{state['doc_id']}/versions")
    work = client.expect("GET", f"/api/v1/work/{state['work_id']}")
    notes = client.all(f"/api/v1/workspaces/{state['workspace_id']}/drafts")
    return {
        "workspace_name": workspace.get("name"),
        "project_names": {item["id"]: item["name"] for item in projects},
        "messages": [[message["sequence"], message["body"]] for message in messages],
        "file_hex": file_bytes.hex() if status == 200 else "",
        "doc_versions": [[item["version"], item["state"], item["reason"]] for item in versions],
        "work_title": work.get("title"),
        "note_titles": {item["id"]: item["title"] for item in notes},
    }


def verify(client: Client, state_file: Path, write: bool) -> None:
    state = json.loads(state_file.read_text(encoding="utf-8"))
    status, _ = client.json("POST", "/api/auth/sign-in/email", {"email": state["email"], "password": state["password"]})
    if status != 200:
        raise RuntimeError(f"restored account sign-in returned {status}")
    problems = check(state, read_back(client, state))
    if problems:
        raise RuntimeError("restored content differs: " + "; ".join(problems))
    print(
        "Restored account, workspace, project, conversation with its attachment, document versions, "
        "work item and private note verified"
    )
    if write:
        body = f"RELEASE-after-{secrets.token_hex(4)}"
        client.expect("POST", f"/api/v1/conversations/{state['thread_id']}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())})
        bodies = [message["body"] for message in client.expect("GET", f"/api/v1/conversations/{state['thread_id']}?limit=100")["messages"]]
        if body not in bodies:
            raise RuntimeError("a message written after the restore or upgrade does not read back")
        print("A new message was accepted and reads back")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("seed", "verify"))
    parser.add_argument("--origin", required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--write", action="store_true", help="verify: also write and read back a new message")
    args = parser.parse_args()
    client = Client(args.origin)
    if args.mode == "seed":
        seed(client, args.state)
    else:
        verify(client, args.state, args.write)


if __name__ == "__main__":
    main()
