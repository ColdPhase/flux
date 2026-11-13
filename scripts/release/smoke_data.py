#!/usr/bin/env python3
"""Exercise real account, workspace and content persistence from the packaged release, across an upgrade.

`seed` signs a throwaway account up on one running release and writes through the public HTTP API what an
installation holds after some use (#1241):

* the base content: the company, a space, a conversation with a reply and a binary attachment, a document with two
  versions, a task and a private map;
* people: a member and a guest who signed up through invite links, and a second signed-in device (a session);
* a restricted space that holds all three, a thread of three people, a file and a short MP4 attached to it, a direct message with a thread
  reply and a group conversation, a wiki page with three versions by two people, a map with three thoughts and two links,
  tasks with due dates, one waiting for another and one for a person, notification settings with a muted space;
* an encrypted space with a message, locked again (its password is recorded);
* with `--provider-url`, an owner AI connection with an API key (the provider mock of provider-mock.compose.yaml), an agent with
  its instructions and two remembered things, a weekly schedule and a switched-off one, and a run that completed.

It records exactly what it wrote in a state file. `verify` signs in again on a restored or upgraded instance, possibly of ANOTHER
release, and checks that every recorded item is still there (explicit fields and the exact attachment bytes, never whole
responses, so a field a newer release adds does not matter), that the second device's session is still valid and that the
encrypted space unlocks with its password. `verify --write` also proves the instance accepts new work: a message of each kind,
a task, a new agent run on the provider mock, a message in the encrypted space and, from schema 71, a 6 MiB video that
answers byte ranges.

Only routes that exist in v0.2.0, the oldest release that is upgraded (#1241), are used by `seed`, because it runs against the
PREVIOUS release in the upgrade leg of smoke_artifacts.sh. `verify` runs on the previous release too (after a restore of the
pre-upgrade backup), so it reads only fields that v0.2.0 returns.
"""

from __future__ import annotations

import argparse
import hashlib
import http.cookiejar
import json
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

WORKSPACE_NAME = "Release restore probe"
PROJECT_NAME = "Release project"
GARDEN_NAME = "Garden space"
VAULT_NAME = "Release vault"
FILE_BYTES = bytes([0, 255, 128, 1, 10, 42, 0, 7, 200, 13])
GARDEN_FILE_BYTES = bytes([9, 8, 7, 0, 255, 254, 1, 2, 3, 250])
# A real 2-second MP4 (the UI tests' fixture): v0.2.0 stores it as an ordinary file; from schema 71 (videos, C-61, #1352) a video
# above the 5 MiB of other files is accepted and streamed by range.
VIDEO_CLIP = Path(__file__).resolve().parents[2] / "app" / "tests" / "ui" / "fixtures" / "video" / "clip.mp4"
VIDEOS_SCHEMA = 71
ANSWER = "UPGRADE-CHECK-ANSWER"  # what scripts/release/provider_mock.mjs says; a run's answer holds it
WAIT_FOR_RUN_SECONDS = 90


class Client:
    def __init__(self, origin: str, cookies: dict[str, str] | None = None) -> None:
        self.origin = origin
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.extra_cookies = dict(cookies or {})

    def cookies(self) -> dict[str, str]:
        return {cookie.name: cookie.value for cookie in self.jar if cookie.value is not None}

    def raw(
        self, method: str, path: str, body: bytes | None = None,
        content_type: str | None = None, headers: dict[str, str] | None = None,
    ) -> tuple[int, bytes]:
        request_headers = {"Origin": self.origin, **(headers or {})}
        if self.extra_cookies:
            request_headers["Cookie"] = "; ".join(f"{name}={value}" for name, value in self.extra_cookies.items())
        if content_type is not None:
            request_headers["Content-Type"] = content_type
        for attempt in range(8):
            req = urllib.request.Request(self.origin + path, data=body, method=method, headers=request_headers)
            try:
                with self.opener.open(req, timeout=30) as response:
                    return response.status, response.read()
            except urllib.error.HTTPError as error:
                payload = error.read()
                if error.code == 429 and attempt < 7:  # the sign-in limit of a production install: wait as the answer says
                    time.sleep(min(int(error.headers.get("Retry-After") or 10), 30))
                    continue
                raise RuntimeError(f"{method} {path} returned {error.code}: {payload[:400]!r}") from error
        raise RuntimeError(f"{method} {path} stayed rate limited")

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

    def status(self, method: str, path: str, body: dict[str, Any] | None = None) -> int:
        """The status of a call that may be refused (403, 404, 423): the refusal is the answer, not an error."""
        try:
            return self.json(method, path, body)[0]
        except RuntimeError as error:
            text = str(error)
            return int(text.split(" returned ", 1)[1].split(":", 1)[0])

    def all(self, path: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        while True:
            page = self.expect("GET", f"{path}{'&' if '?' in path else '?'}limit=100&offset={len(items)}")
            items.extend(page["items"])
            if len(items) >= page["total"] or not page["items"]:
                return items

    def sign_in(self, email: str, password: str) -> None:
        self.expect("POST", "/api/auth/sign-in/email", {"email": email, "password": password}, (200,))


def new_id() -> str:
    return str(uuid.uuid4())


def sign_up(origin: str, name: str, tag: str) -> tuple[Client, dict[str, str]]:
    client = Client(origin)
    person = {"name": name, "email": f"{name.split()[0].lower()}-{tag}-{secrets.token_hex(6)}@example.test", "password": secrets.token_urlsafe(32)}
    client.expect("POST", "/api/auth/sign-up/email", person, (200,))
    person["id"] = client.expect("GET", "/api/v1/me")["user"]["id"]
    return client, person


def join(owner: Client, origin: str, company_id: str, role: str, name: str, tag: str) -> tuple[Client, dict[str, str]]:
    """A person signs up and joins through an invite link of the company (a member, or a guest)."""
    client, person = sign_up(origin, name, tag)
    invite = owner.expect("POST", f"/api/v1/workspaces/{company_id}/invites", {"role": role})
    joined = client.expect("POST", "/api/v1/invites/accept", {"token": invite["link"].split("#", 1)[1]})
    if joined.get("role") != role:
        raise RuntimeError(f"{name} joined as {joined.get('role')!r}, not {role!r}")
    person["role"] = role
    return client, person


def await_run(client: Client, run_id: str) -> dict[str, Any]:
    deadline = time.time() + WAIT_FOR_RUN_SECONDS
    while True:
        run = client.expect("GET", f"/api/v1/assistant-runs/{run_id}")
        if run["status"] not in ("queued", "reading", "dispatching") or time.time() > deadline:
            return run
        time.sleep(1)


def ask_agent(client: Client, agent_id: str, prompt: str) -> dict[str, Any]:
    started = client.expect("POST", f"/api/v1/my-agents/{agent_id}/assistant-runs", {"clientRunId": new_id(), "kind": "ask", "prompt": prompt}, (200, 201, 202))
    run = await_run(client, started["id"])
    if run["status"] != "completed" or ANSWER not in ((run.get("answer") or {}).get("body") or json.dumps(run.get("answer"))):
        raise RuntimeError(f"the agent's run ended {run['status']!r} with answer {run.get('answer')!r}, not the provider mock's")
    return run


def seed_ai(owner: Client, company_id: str, tag: str, provider_url: str) -> dict[str, Any]:
    """An owner AI connection with an API key, an agent, its memory and schedules, and one completed run."""
    # The model is what the provider lists (#1218: models are fetched from the provider, never from a fixed list); the server reads the
    # list of the mock's endpoint without a key, as the connection form does.
    listing = owner.expect("POST", "/api/v1/ai-model-lists", {"provider": "openai_compatible", "baseUrl": provider_url})
    if listing.get("status") != "listed" or not listing.get("models"):
        raise RuntimeError(f"the provider mock lists no models: {listing!r}")
    model = listing["models"][0]["id"]
    connection = owner.expect("POST", "/api/v1/background-compute-connections", {
        "name": f"Mock key {tag}", "provider": "openai_compatible", "baseUrl": provider_url, "model": model,
        "apiKey": f"owner-budget-key-{secrets.token_hex(12)}", "dailyBudgetCents": 500,
        "price": {"inputMicrosPerMTok": 0, "outputMicrosPerMTok": 0},
    })
    instructions = f"Plan the garden work, {tag}."
    agent = owner.expect("POST", "/api/v1/my-agents", {"name": f"Planner {tag}", "workspaceId": company_id, "instructions": instructions})
    memory = [f"The garden is on the north side ({tag})", f"Water on Mondays ({tag})"]
    for body in memory:
        owner.expect("POST", f"/api/v1/my-agents/{agent['id']}/memory", {"body": body})
    note = owner.expect("GET", f"/api/v1/my-agents/{agent['id']}/background-note")["version"]
    weekly = owner.expect("POST", f"/api/v1/my-agents/{agent['id']}/schedules", {
        "title": f"Weekly summary {tag}", "text": "Summarise what changed in Garden", "timeZone": "Europe/Warsaw",
        "schedule": {"kind": "weekly", "at": "09:00", "weekday": 1}, "noteVersion": note,
    })
    off = owner.expect("POST", f"/api/v1/my-agents/{agent['id']}/schedules", {
        "title": f"Daily check {tag}", "text": "Look at the garden tasks", "timeZone": "Europe/Warsaw",
        "schedule": {"kind": "daily", "at": "07:30"}, "enabled": False, "noteVersion": note,
    })
    run = ask_agent(owner, agent["id"], f"What is the garden plan? ({tag})")
    return {
        "connection_id": connection["id"], "connection_name": connection["name"], "key_last_four": connection["keyLastFour"], "model": model,
        "daily_budget_cents": connection["dailyBudgetCents"], "agent_id": agent["id"], "agent_name": agent["name"],
        "instructions": instructions, "memory": memory, "weekly_id": weekly["id"], "weekly_words": weekly["words"],
        "off_id": off["id"], "off_words": off["words"], "run_id": run["id"], "run_prompt": run["prompt"],
    }


def seed_vault(owner: Client, company_id: str, tag: str) -> dict[str, Any]:
    """An encrypted space of the company with a message in it, locked again so that the upgrade finds it as people leave it."""
    password = secrets.token_urlsafe(24)
    created = owner.expect("POST", "/api/v1/encrypted-workspaces", {
        "name": VAULT_NAME, "creationId": new_id(), "password": password, "companyId": company_id,
    }, (201,))
    if not created.get("recoveryCode") or not created.get("workspace", {}).get("id") or not (created.get("project") or {}).get("id"):
        raise RuntimeError("encrypted space created without a workspace, its space or a recovery code")
    workspace_id, project_id = created["workspace"]["id"], created["project"]["id"]
    body = f"VAULT-secret-{tag}"
    thread = owner.expect("POST", f"/api/v1/projects/{project_id}/conversations", {"body": body, "clientMessageId": new_id()})
    owner.expect("POST", f"/api/v1/workspaces/{workspace_id}/lock", None, (200, 204))
    return {"workspace_id": workspace_id, "project_id": project_id, "thread_id": thread["id"], "password": password, "message": body}


UNICODE_WORD = "\ua7c0\ua7c1\ua7c0\ua7c1"  # ꟀꟁꟀꟁ; its lower case is ꟁꟁꟁꟁ


def seed_more(owner: Client, origin: str, company_id: str, tag: str, provider_url: str | None) -> dict[str, Any]:
    member_client, ben = join(owner, origin, company_id, "member", "Ben Member", tag)
    guest_client, gina = join(owner, origin, company_id, "guest", "Gina Guest", tag)
    garden = owner.expect("POST", f"/api/v1/workspaces/{company_id}/projects", {
        "name": GARDEN_NAME, "visibility": "restricted", "people": [ben["id"], gina["id"]],
    })
    garden_id = garden["id"]

    # A thread of three people with a file attached to its first message.
    upload_status, upload = owner.raw(
        "POST", f"/api/v1/projects/{garden_id}/files?{urllib.parse.urlencode({'uploadId': new_id(), 'name': 'garden-notes.bin'})}",
        GARDEN_FILE_BYTES, "application/octet-stream",
    )
    if upload_status != 201:
        raise RuntimeError(f"garden file upload returned {upload_status}")
    garden_file_id = json.loads(upload)["id"]
    clip = VIDEO_CLIP.read_bytes()
    clip_status, clip_upload = owner.raw(
        "POST", f"/api/v1/projects/{garden_id}/files?{urllib.parse.urlencode({'uploadId': new_id(), 'name': 'garden-clip.mp4'})}",
        clip, "application/octet-stream",
    )
    if clip_status != 201:
        raise RuntimeError(f"garden video upload returned {clip_status}")
    garden_video_id = json.loads(clip_upload)["id"]
    root = f"GARDEN-root-{tag}"
    thread = owner.expect("POST", f"/api/v1/projects/{garden_id}/conversations", {
        "body": root, "attachmentIds": [garden_file_id, garden_video_id], "clientMessageId": new_id(),
    })
    member_client.expect("POST", f"/api/v1/conversations/{thread['id']}/messages", {"body": f"GARDEN-ben-{tag}", "clientMessageId": new_id()})
    guest_client.expect("POST", f"/api/v1/conversations/{thread['id']}/messages", {"body": f"GARDEN-gina-{tag}", "clientMessageId": new_id()})
    thread_messages = [[m["sequence"], m["authorId"], m["body"]] for m in owner.expect("GET", f"/api/v1/conversations/{thread['id']}?limit=100")["messages"]]
    if len(thread_messages) != 3:
        raise RuntimeError(f"the garden thread reads back as {thread_messages!r}")

    # A direct message with a thread reply, and a group conversation.
    pair = owner.expect("POST", f"/api/v1/workspaces/{company_id}/dms", {"participantIds": [ben["id"]]})
    dm_root = owner.expect("POST", f"/api/v1/dms/{pair['id']}/messages", {"body": f"DM-hello-{tag}", "clientMessageId": new_id()})
    member_client.expect("POST", f"/api/v1/dms/{pair['id']}/threads/{dm_root['id']}/replies", {"body": f"DM-reply-{tag}", "clientMessageId": new_id()})
    group = owner.expect("POST", f"/api/v1/workspaces/{company_id}/dms", {"participantIds": [ben["id"], gina["id"]], "title": f"Garden crew {tag}"})
    owner.expect("POST", f"/api/v1/dms/{group['id']}/messages", {"body": f"GROUP-hello-{tag}", "clientMessageId": new_id()})
    # A word of Latin Extended-D letters (Unicode 14), which musl (the Alpine image of v0.2.0) does not count as letters and glibc (the
    # database image from v0.2.1, F-042) does: people's search finds it after an upgrade only if migration 0065 recomputed the stored
    # search columns.
    owner.expect("POST", f"/api/v1/dms/{group['id']}/messages", {"body": f"{UNICODE_WORD} UNICODE-{tag}", "clientMessageId": new_id()})

    # A wiki page: three versions by two people.
    doc_title = f"GARDEN-wiki-{tag}"
    doc = owner.expect("POST", f"/api/v1/projects/{garden_id}/docs", {"title": doc_title, "body": f"{doc_title}-v1"}, (201,), {"Idempotency-Key": new_id()})
    second = member_client.expect("PATCH", f"/api/v1/docs/{doc['id']}", {"body": f"{doc_title}-v2"}, (200,), {"If-Match": f'"{doc["version"]}"'})
    owner.expect("PATCH", f"/api/v1/docs/{doc['id']}", {"body": f"{doc_title}-v3"}, (200,), {"If-Match": f'"{second["version"]}"'})
    doc_versions = [[v["version"], v["reason"]] for v in owner.all(f"/api/v1/docs/{doc['id']}/versions")]
    if len(doc_versions) != 3:
        raise RuntimeError(f"the wiki page has {len(doc_versions)} versions, expected 3")

    # A map: three thoughts, two links.
    sketch = owner.expect("POST", f"/api/v1/workspaces/{company_id}/sketches", {"title": f"Garden map {tag}", "scope": "project", "projectId": garden_id})
    soil = owner.expect("POST", f"/api/v1/sketches/{sketch['id']}/thoughts", {"text": "Soil", "x": 10, "y": 10})["thought"]
    water = owner.expect("POST", f"/api/v1/sketches/{sketch['id']}/thoughts", {
        "text": "Water", "x": 220, "y": 10, "linkFrom": {"thoughtId": soil["id"], "label": "needs"}})["thought"]
    owner.expect("POST", f"/api/v1/sketches/{sketch['id']}/thoughts", {
        "text": "Shade", "x": 220, "y": 120, "linkFrom": {"thoughtId": water["id"], "label": "next to"}})

    # Tasks: one with a due date and an owner, one waiting for it, one waiting for a person.
    first = owner.expect("POST", f"/api/v1/projects/{garden_id}/work", {"title": f"GARDEN-calibrate-{tag}", "dueOn": "2027-03-01", "owner": {"kind": "human", "id": ben["id"]}})
    second_task = owner.expect("POST", f"/api/v1/projects/{garden_id}/work", {
        "title": f"GARDEN-ship-{tag}", "status": "blocked", "blocker": "needs calibration", "dueOn": "2027-03-15",
        "waitingOn": {"kind": "task", "id": first["id"]}, "dependencyIds": [first["id"]],
    })
    third = owner.expect("POST", f"/api/v1/projects/{garden_id}/work", {
        "title": f"GARDEN-approve-{tag}", "status": "blocked", "blocker": "needs a decision of the owner", "dueOn": "2027-04-01",
        "waitingFor": {"kind": "human", "id": ben["id"]},
    })

    # Notification settings, with the garden muted.
    owner.expect("PATCH", "/api/v1/notification-preferences", {
        "level": "everything", "emailMe": True, "quietHours": {"enabled": True, "start": "22:00", "end": "07:00", "timeZone": "Europe/Warsaw"},
    })
    owner.expect("PUT", "/api/v1/notification-preferences/mutes", {"type": "project", "id": garden_id, "muted": True})

    return {
        "ben": ben, "gina": gina, "garden_id": garden_id, "garden_file_id": garden_file_id, "garden_file_hex": GARDEN_FILE_BYTES.hex(),
        "garden_video_id": garden_video_id, "garden_video_sha256": hashlib.sha256(clip).hexdigest(),
        "garden_thread_id": thread["id"], "garden_messages": thread_messages,
        "dm_id": pair["id"], "dm_root_id": dm_root["id"], "dm_bodies": [f"DM-hello-{tag}", f"DM-reply-{tag}"],
        "group_id": group["id"], "group_title": f"Garden crew {tag}", "group_bodies": [f"GROUP-hello-{tag}", f"{UNICODE_WORD} UNICODE-{tag}"],
        "unicode_search": {"q": UNICODE_WORD.lower(), "find": f"UNICODE-{tag}"},
        "wiki_id": doc["id"], "wiki_title": doc_title, "wiki_versions": doc_versions,
        "map_id": sketch["id"], "map_thoughts": [["Soil", 10, 10], ["Water", 220, 10], ["Shade", 220, 120]],
        "map_links": [["Soil", "Water", "needs"], ["Water", "Shade", "next to"]],
        "tasks": [
            {"id": first["id"], "title": first["title"], "status": "open", "dueOn": "2027-03-01", "owner": ben["id"], "waitingOn": None, "waitingFor": None},
            {"id": second_task["id"], "title": second_task["title"], "status": "blocked", "dueOn": "2027-03-15", "owner": None, "waitingOn": first["id"], "waitingFor": None},
            {"id": third["id"], "title": third["title"], "status": "blocked", "dueOn": "2027-04-01", "owner": None, "waitingOn": None, "waitingFor": ben["id"]},
        ],
        "second_task_depends_on": first["id"],
        "notifications": {"level": "everything", "emailMe": True, "quiet": ["22:00", "07:00", "Europe/Warsaw"], "muted": [garden_id]},
        "device": None,  # filled by seed() once the second device has signed in
        "vault": seed_vault(owner, company_id, tag),
        "ai": seed_ai(owner, company_id, tag, provider_url) if provider_url else None,
    }


def seed(client: Client, state_file: Path, provider_url: str | None = None) -> None:
    if state_file.exists():
        raise ValueError("refusing to replace existing smoke state")
    tag = secrets.token_hex(4)
    email = f"release-{secrets.token_hex(8)}@example.test"
    password = secrets.token_urlsafe(32)
    client.expect("POST", "/api/auth/sign-up/email", {"email": email, "password": password, "name": "Release smoke user"}, (200,))
    user_id = client.expect("GET", "/api/v1/me")["user"]["id"]
    # F-037: the first account on a fresh install owns the company and names it. Every release that is upgraded (v0.2.0 on) has one.
    company = next((item for item in client.expect("GET", "/api/v1/workspaces") if item.get("company")), None)
    if company is None:
        raise RuntimeError("the instance has no company: it was written by Flux v0.1, which is not upgraded")
    workspace = client.expect("PATCH", f"/api/v1/workspaces/{company['id']}", {"name": WORKSPACE_NAME})
    project = client.expect("POST", f"/api/v1/workspaces/{workspace['id']}/projects", {"name": PROJECT_NAME})
    project_id = project["id"]
    status, upload = client.raw(
        "POST", f"/api/v1/projects/{project_id}/files?{urllib.parse.urlencode({'uploadId': new_id(), 'name': 'release-probe.bin'})}",
        FILE_BYTES, "application/octet-stream",
    )
    if status != 201:
        raise RuntimeError(f"file upload returned {status}")
    file_id = json.loads(upload)["id"]
    first = f"RELEASE-message-{tag}"
    reply = f"RELEASE-reply-{tag}"
    thread = client.expect("POST", f"/api/v1/projects/{project_id}/conversations", {
        "body": first, "attachmentIds": [file_id], "clientMessageId": new_id(),
    })
    client.expect("POST", f"/api/v1/conversations/{thread['id']}/messages", {"body": reply, "clientMessageId": new_id()})
    messages = client.expect("GET", f"/api/v1/conversations/{thread['id']}?limit=100")["messages"]
    expected_messages = [[message["sequence"], message["body"]] for message in messages]
    if [body for _, body in expected_messages] != [first, reply]:
        raise RuntimeError(f"seeded conversation reads back as {expected_messages!r}")
    doc_title = f"RELEASE-doc-{tag}"
    doc = client.expect(
        "POST", f"/api/v1/projects/{project_id}/docs", {"title": doc_title, "body": f"{doc_title}-v1"},
        (201,), {"Idempotency-Key": new_id()},
    )
    client.expect(
        "PATCH", f"/api/v1/docs/{doc['id']}",
        {"body": f"{doc_title}-v2"}, (200,),
        {"If-Match": f'"{doc["version"]}"'},
    )
    doc_versions = [
        [item["version"], item["reason"]]
        for item in client.all(f"/api/v1/docs/{doc['id']}/versions")
    ]
    if len(doc_versions) != 2:
        raise RuntimeError(f"seeded document has {len(doc_versions)} versions, expected 2")
    work_title = f"RELEASE-work-{tag}"
    work = client.expect(
        "POST", f"/api/v1/projects/{project_id}/work",
        {"title": work_title, "owner": {"kind": "human", "id": user_id}, "sources": []},
    )
    note_title = f"RELEASE-private-map-{tag}"
    note = client.expect(
        "POST", f"/api/v1/workspaces/{workspace['id']}/sketches",
        {"title": note_title, "scope": "private"},
    )
    more = seed_more(client, client.origin, workspace["id"], tag, provider_url)
    # The second device signs in last, so that its session is a separate row and the first account's one is not the newest.
    device = Client(client.origin)
    device.sign_in(email, password)
    device_session = next(item["id"] for item in device.expect("GET", "/api/v1/sessions") if item["current"])
    more["device"] = {"cookies": device.cookies(), "session_id": device_session}
    state_file.write_text(json.dumps({
        "email": email, "password": password, "workspace_id": workspace["id"], "project_id": project_id,
        "file_id": file_id, "file_hex": FILE_BYTES.hex(), "thread_id": thread["id"], "messages": expected_messages,
        "doc_id": doc["id"], "doc_versions": doc_versions, "work_id": work["id"], "work_title": work_title,
        "note_id": note["id"], "note_title": note_title, "more": more,
    }), encoding="utf-8")
    state_file.chmod(0o600)
    print(
        "Release account, workspace, project, conversation (2 messages and an attachment), "
        "document (2 versions), work item and private map created"
    )
    print(
        "More content: a member and a guest, a restricted space with a three-person thread and a file, direct and group "
        "conversations, a wiki page of three versions, a map of three thoughts, three tasks with due dates and waits, notification "
        "settings, a second device, an encrypted space (locked)"
        + (", an AI connection, an agent with memory and two schedules and a completed run" if more["ai"] else "")
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
        problems.append("private map missing or renamed")
    return problems


def check_more(more: dict[str, Any], observed: dict[str, Any], now: datetime | None = None) -> list[str]:
    """The same for the content of `seed_more`. A schedule's next times must lie ahead, a week apart for a weekly one."""
    problems: list[str] = []
    people = observed["people"]
    for key in ("ben", "gina"):
        person = more[key]
        if people.get(person["id"]) != person["role"]:
            problems.append(f"{person['name']} is {people.get(person['id'])!r}, recorded {person['role']!r}")
    if more["garden_id"] not in observed["guest_spaces"]:
        problems.append("the guest lost the space they were added to")
    if not observed["guest_denied"]:
        problems.append("the guest can read a space they are not in")
    present = {tuple(item) for item in observed["garden_messages"]}
    for item in more["garden_messages"]:
        if tuple(item) not in present:
            problems.append(f"garden message {item[0]} {item[2]!r} missing or by another author")
    if observed["garden_file_hex"] != more["garden_file_hex"]:
        problems.append("garden file bytes differ")
    if more.get("garden_video_sha256") and observed.get("garden_video_sha256") != more["garden_video_sha256"]:
        problems.append("garden video bytes differ")
    for label, recorded, seen in (("direct", more["dm_bodies"], observed["dm_bodies"]), ("group", more["group_bodies"], observed["group_bodies"])):
        missing = [body for body in recorded if body not in seen]
        if missing:
            problems.append(f"{label} conversation lost {missing!r}")
    if observed["group_title"] != more["group_title"]:
        problems.append(f"group title {observed['group_title']!r}")
    for version in more["wiki_versions"]:
        if version not in observed["wiki_versions"]:
            problems.append(f"wiki version {version!r} missing from {observed['wiki_versions']!r}")
    for number, body in observed["wiki_bodies"].items():
        if body != f"{more['wiki_title']}-v{number}":
            problems.append(f"wiki version {number} reads {body!r}")
    if sorted(observed["map_thoughts"]) != sorted(more["map_thoughts"]):
        problems.append(f"map thoughts {observed['map_thoughts']!r}")
    if sorted(observed["map_links"]) != sorted(more["map_links"]):
        problems.append(f"map links {observed['map_links']!r}")
    for task in more["tasks"]:
        seen = observed["tasks"].get(task["id"])
        if seen is None:
            problems.append(f"task {task['title']!r} missing")
        elif seen != {key: task[key] for key in ("title", "status", "dueOn", "owner", "waitingOn", "waitingFor")}:
            problems.append(f"task {task['title']!r} reads {seen!r}")
    if observed["task_prerequisites"] != [more["second_task_depends_on"]]:
        problems.append(f"the waiting task's prerequisites are {observed['task_prerequisites']!r}")
    notes = more["notifications"]
    if (observed["notifications"]["level"], observed["notifications"]["emailMe"]) != (notes["level"], notes["emailMe"]):
        problems.append(f"notification settings read {observed['notifications']!r}")
    if observed["notifications"]["quiet"] != notes["quiet"] or observed["notifications"]["muted"] != notes["muted"]:
        problems.append(f"quiet hours or muted places read {observed['notifications']!r}")
    if not observed["device_session"]:
        problems.append("the second device's session no longer works or is no longer listed")
    if more["vault"]["message"] not in observed["vault_messages"]:
        problems.append(f"the encrypted space reads {observed['vault_messages']!r} after its unlock")
    ai = more.get("ai")
    if ai:
        seen = observed["ai"]
        for key, recorded in (
            ("connection_name", ai["connection_name"]), ("model", ai["model"]), ("key_last_four", ai["key_last_four"]), ("daily_budget_cents", ai["daily_budget_cents"]),
            ("agent_name", ai["agent_name"]), ("instructions", ai["instructions"]), ("weekly_words", ai["weekly_words"]), ("off_words", ai["off_words"]),
        ):
            if seen.get(key) != recorded:
                problems.append(f"AI {key} reads {seen.get(key)!r}, recorded {recorded!r}")
        if sorted(seen["memory"]) != sorted(ai["memory"]):
            problems.append(f"agent memory reads {seen['memory']!r}")
        if seen["run_status"] != "completed" or ANSWER not in seen["run_answer"]:
            problems.append(f"the agent's earlier run reads {seen['run_status']!r} with {seen['run_answer']!r}")
        if not seen["weekly_enabled"] or seen["off_enabled"]:
            problems.append("a schedule's switch changed")
        problems.extend(check_next_times(seen["weekly_next"], seen["off_next"], now or datetime.now().astimezone()))
    return problems


def check_next_times(weekly: list[str], off: list[str], now: datetime) -> list[str]:
    """The weekly schedule's next three times lie ahead, exactly a week apart; the switched-off one has none."""
    problems: list[str] = []
    if off:
        problems.append(f"a switched-off schedule has next times {off!r}")
    if len(weekly) != 3:
        return problems + [f"the weekly schedule has {len(weekly)} next times, expected 3"]
    moments = [datetime.fromisoformat(value.replace("Z", "+00:00")) for value in weekly]
    if moments[0] <= now:
        problems.append(f"the weekly schedule's next time {weekly[0]} is not ahead of {now.isoformat()}")
    week = timedelta(days=7)
    # Local 9:00 is the same wall-clock time across a change of summer time: an hour either way is allowed.
    if any(abs(later - earlier - week) > timedelta(hours=1) for earlier, later in zip(moments, moments[1:])):
        problems.append(f"the weekly schedule's next times are not a week apart: {weekly!r}")
    return problems


def read_back(client: Client, state: dict[str, Any]) -> dict[str, Any]:
    workspace = client.expect("GET", f"/api/v1/workspaces/{state['workspace_id']}")
    projects = client.all(f"/api/v1/workspaces/{state['workspace_id']}/projects")
    messages = client.expect("GET", f"/api/v1/conversations/{state['thread_id']}?limit=100")["messages"]
    status, file_bytes = client.raw("GET", f"/api/v1/files/{state['file_id']}")
    versions = client.all(f"/api/v1/docs/{state['doc_id']}/versions")
    work = client.expect("GET", f"/api/v1/work/{state['work_id']}")
    notes = client.all(f"/api/v1/workspaces/{state['workspace_id']}/sketches?scope=private")
    return {
        "workspace_name": workspace.get("name"),
        "project_names": {item["id"]: item["name"] for item in projects},
        "messages": [[message["sequence"], message["body"]] for message in messages],
        "file_hex": file_bytes.hex() if status == 200 else "",
        "doc_versions": [[item["version"], item["reason"]] for item in versions],
        "work_title": work.get("title"),
        "note_titles": {item["id"]: item["title"] for item in notes},
    }


def read_more(owner: Client, origin: str, state: dict[str, Any]) -> dict[str, Any]:
    """Reads the content of `seed_more` back as the people who wrote it, unlocking the encrypted space with its password."""
    more = state["more"]
    company = state["workspace_id"]
    members = owner.expect("GET", f"/api/v1/workspaces/{company}/members")
    guest = Client(origin)
    guest.sign_in(more["gina"]["email"], more["gina"]["password"])
    member = Client(origin)
    member.sign_in(more["ben"]["email"], more["ben"]["password"])
    guest_spaces = [item["id"] for item in guest.all(f"/api/v1/workspaces/{company}/projects")]
    thread = owner.expect("GET", f"/api/v1/conversations/{more['garden_thread_id']}?limit=100")["messages"]
    status, garden_file = owner.raw("GET", f"/api/v1/files/{more['garden_file_id']}")
    video_status, garden_video = owner.raw("GET", f"/api/v1/files/{more['garden_video_id']}") if more.get("garden_video_id") else (0, b"")
    dm_thread = member.expect("GET", f"/api/v1/dms/{more['dm_id']}/threads/{more['dm_root_id']}")
    group = owner.expect("GET", f"/api/v1/dms/{more['group_id']}?limit=100")
    versions = owner.all(f"/api/v1/docs/{more['wiki_id']}/versions")
    bodies = {number: owner.expect("GET", f"/api/v1/docs/{more['wiki_id']}/versions/{number}")["body"] for number in sorted(item["version"] for item in versions)}
    sketch = owner.expect("GET", f"/api/v1/sketches/{more['map_id']}")
    texts = {thought["id"]: thought["text"] for thought in sketch["thoughts"]}
    tasks: dict[str, dict[str, Any]] = {}
    prerequisites: list[str] = []
    for task in more["tasks"]:
        item = owner.expect("GET", f"/api/v1/work/{task['id']}")
        tasks[task["id"]] = {
            "title": item["title"], "status": item["status"], "dueOn": item["dueOn"], "owner": (item.get("owner") or {}).get("id"),
            "waitingOn": (item.get("waitingOn") or {}).get("id"), "waitingFor": (item.get("waitingFor") or {}).get("id"),
        }
        if task["id"] == more["tasks"][1]["id"]:
            prerequisites = item.get("dependencyIds", [])
    prefs = owner.expect("GET", "/api/v1/notification-preferences")
    device = Client(origin, more["device"]["cookies"])
    device_ok = device.status("GET", "/api/v1/me") == 200 and any(item["id"] == more["device"]["session_id"] for item in device.expect("GET", "/api/v1/sessions"))
    vault = more["vault"]
    state_now = owner.expect("GET", f"/api/v1/workspaces/{vault['workspace_id']}")["encryption"]["state"]
    if state_now == "locked":
        # What an upgrade does to the keyring (it restarts): the space opens again with its password, which an upgrade must not change.
        if owner.status("GET", f"/api/v1/conversations/{vault['thread_id']}") != 423:
            raise RuntimeError("a locked encrypted space answered a read without its unlock")
        owner.expect("POST", f"/api/v1/workspaces/{vault['workspace_id']}/unlock", {"password": vault["password"]}, (200,))
    vault_messages = [m["body"] for m in owner.expect("GET", f"/api/v1/conversations/{vault['thread_id']}?limit=100")["messages"]]
    observed: dict[str, Any] = {
        "people": {item["userId"]: item["role"] for item in members},
        "guest_spaces": guest_spaces,
        "guest_denied": guest.status("GET", f"/api/v1/projects/{state['project_id']}") in (403, 404),
        "garden_messages": [[m["sequence"], m["authorId"], m["body"]] for m in thread],
        "garden_file_hex": garden_file.hex() if status == 200 else "",
        "garden_video_sha256": hashlib.sha256(garden_video).hexdigest() if video_status == 200 else "",
        "dm_bodies": [dm_thread["root"]["body"]] + [reply["body"] for reply in dm_thread["replies"]],
        "group_bodies": [m["body"] for m in group["messages"]], "group_title": group.get("title"),
        "wiki_versions": [[item["version"], item["reason"]] for item in versions], "wiki_bodies": bodies,
        "map_thoughts": [[thought["text"], thought["x"], thought["y"]] for thought in sketch["thoughts"]],
        "map_links": [[texts[link["fromId"]], texts[link["toId"]], link["label"]] for link in sketch["links"]],
        "tasks": tasks, "task_prerequisites": prerequisites,
        "notifications": {
            "level": prefs["level"], "emailMe": prefs["emailMe"],
            "quiet": [prefs["quietHours"]["start"], prefs["quietHours"]["end"], prefs["quietHours"]["timeZone"]],
            "muted": [item["id"] for item in prefs["muted"]],
        },
        "device_session": device_ok, "vault_messages": vault_messages,
    }
    ai = more.get("ai")
    if ai:
        connections = {item["id"]: item for item in owner.expect("GET", "/api/v1/background-compute-connections")}
        connection = connections.get(ai["connection_id"], {})
        agent = next((item for item in owner.expect("GET", "/api/v1/my-agents")["items"] if item["id"] == ai["agent_id"]), {})
        schedules = {item["id"]: item for item in owner.expect("GET", f"/api/v1/my-agents/{ai['agent_id']}/schedules")["items"]}
        run = owner.expect("GET", f"/api/v1/assistant-runs/{ai['run_id']}")
        observed["ai"] = {
            "connection_name": connection.get("name"), "model": connection.get("model"), "key_last_four": connection.get("keyLastFour"),
            "daily_budget_cents": connection.get("dailyBudgetCents"),
            "agent_name": agent.get("name"), "instructions": agent.get("instructions"),
            "memory": [item["body"] for item in owner.expect("GET", f"/api/v1/my-agents/{ai['agent_id']}/memory")["items"]],
            "weekly_words": schedules.get(ai["weekly_id"], {}).get("words"), "off_words": schedules.get(ai["off_id"], {}).get("words"),
            "weekly_enabled": schedules.get(ai["weekly_id"], {}).get("enabled"), "off_enabled": schedules.get(ai["off_id"], {}).get("enabled"),
            "weekly_next": [item["at"] for item in schedules.get(ai["weekly_id"], {}).get("next", [])],
            "off_next": [item["at"] for item in schedules.get(ai["off_id"], {}).get("next", [])],
            "run_status": run["status"], "run_answer": json.dumps(run.get("answer")),
        }
    return observed


def write_more(owner: Client, origin: str, state: dict[str, Any]) -> None:
    """New work on the upgraded instance: a message of each kind by the people who wrote the old ones, a task, and a new agent run."""
    more = state["more"]
    tag = secrets.token_hex(4)
    guest = Client(origin)
    guest.sign_in(more["gina"]["email"], more["gina"]["password"])
    member = Client(origin)
    member.sign_in(more["ben"]["email"], more["ben"]["password"])
    after = f"GARDEN-after-{tag}"
    guest.expect("POST", f"/api/v1/conversations/{more['garden_thread_id']}/messages", {"body": after, "clientMessageId": new_id()})
    member.expect("POST", f"/api/v1/dms/{more['dm_id']}/messages", {"body": f"DM-after-{tag}", "clientMessageId": new_id()})
    owner.expect("POST", f"/api/v1/dms/{more['group_id']}/messages", {"body": f"GROUP-after-{tag}", "clientMessageId": new_id()})
    version = owner.expect("GET", f"/api/v1/docs/{more['wiki_id']}")["version"]
    owner.expect("PATCH", f"/api/v1/docs/{more['wiki_id']}", {"body": f"{more['wiki_title']}-v4"}, (200,), {"If-Match": f'"{version}"'})
    owner.expect("POST", f"/api/v1/projects/{more['garden_id']}/work", {"title": f"GARDEN-after-{tag}", "dueOn": "2027-05-01"})
    vault = more["vault"]
    owner.expect("POST", f"/api/v1/conversations/{vault['thread_id']}/messages", {"body": f"VAULT-after-{tag}", "clientMessageId": new_id()})
    bodies = [m["body"] for m in owner.expect("GET", f"/api/v1/conversations/{more['garden_thread_id']}?limit=100")["messages"]]
    if after not in bodies:
        raise RuntimeError("a guest's message written after the restore or upgrade does not read back")
    if int(owner.expect("GET", "/api/v1/health").get("schemaVersion", 0)) >= VIDEOS_SCHEMA:
        write_video(member, more["garden_id"], tag)
    if more.get("ai"):
        ask_agent(owner, more["ai"]["agent_id"], f"And what next? ({tag})")
        owner.expect("POST", f"/api/v1/my-agents/{more['ai']['agent_id']}/memory", {"body": f"Written after the upgrade ({tag})"})
        # The seed's memory must not grow past the recorded items for the next verify: remove the one just written.
        items = owner.expect("GET", f"/api/v1/my-agents/{more['ai']['agent_id']}/memory")["items"]
        for item in items:
            if item["body"].startswith("Written after the upgrade"):
                owner.expect("DELETE", f"/api/v1/my-agents/{more['ai']['agent_id']}/memory/{item['id']}", None, (200, 204))


def write_video(member: Client, garden_id: str, tag: str) -> None:
    """From schema 71 (C-61, #1352): a 6 MiB video, above the 5 MiB of other files, is stored as a video, answers byte ranges with 206
    and goes with a message. The release's default FLUX_VIDEO_MAX_MIB (200) allows it; a reverse proxy is not in this path."""
    clip = VIDEO_CLIP.read_bytes()
    video = clip + bytes((i * 31 + 7) & 0xFF for i in range(len(clip), 6 * 1024 * 1024))
    status, upload = member.raw(
        "POST", f"/api/v1/projects/{garden_id}/files?{urllib.parse.urlencode({'uploadId': new_id(), 'name': f'GARDEN-video-{tag}.mp4'})}",
        video, "application/octet-stream",
    )
    staged = json.loads(upload) if status == 201 else {}
    if status != 201 or staged.get("video") != "mp4":
        raise RuntimeError(f"a 6 MiB video upload after the upgrade returned {status} {upload[:300]!r}")
    for start, end in ((0, 99), (5_000_000, 5_000_099)):
        status, part = member.raw("GET", f"/api/v1/files/{staged['id']}/video", headers={"Range": f"bytes={start}-{end}"})
        if status != 206 or part != video[start:end + 1]:
            raise RuntimeError(f"the video's range {start}-{end} answered {status} with {len(part)} bytes")
    sent = member.expect("POST", f"/api/v1/projects/{garden_id}/conversations", {
        "body": f"GARDEN-video-{tag}", "attachmentIds": [staged["id"]], "clientMessageId": new_id(),
    })
    status, whole = member.raw("GET", f"/api/v1/files/{staged['id']}")
    if status != 200 or hashlib.sha256(whole).digest() != hashlib.sha256(video).digest() or not sent.get("id"):
        raise RuntimeError("the video sent after the upgrade does not read back")


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
        "work item and private map verified"
    )
    if "more" in state:
        problems = check_more(state["more"], read_more(client, client.origin, state))
        unicode_search = state["more"].get("unicode_search")
        # Only on Flux's database image (schema 65 on, F-042): a release on the Alpine image, such as v0.2.0 reading its own backup
        # back, does not count those letters as letters at all.
        if unicode_search and int(client.expect("GET", "/api/v1/health").get("schemaVersion", 0)) >= 65:
            found = client.expect("GET", "/api/v1/search?" + urllib.parse.urlencode({"q": unicode_search["q"]}))
            texts = [" ".join(part["text"] for part in (item.get("title") or []) + (item.get("snippet") or [])) for item in found["items"]]
            if not any(unicode_search["find"] in text for text in texts):
                problems.append(f"people's search does not find {unicode_search['q']!r} (stored search columns not recomputed, F-042): {texts!r}")
        if problems:
            raise RuntimeError("restored content differs: " + "; ".join(problems))
        print(
            "Members and guest, the restricted space with its thread and file, direct and group conversations, wiki versions, map, "
            "tasks, notification settings, the second device's session and the encrypted space (unlocked with its password) verified"
            + (", and the AI connection, agent, memory, schedules (next times ahead) and earlier run" if state["more"].get("ai") else "")
        )
    if write:
        body = f"RELEASE-after-{secrets.token_hex(4)}"
        client.expect("POST", f"/api/v1/conversations/{state['thread_id']}/messages", {"body": body, "clientMessageId": new_id()})
        bodies = [message["body"] for message in client.expect("GET", f"/api/v1/conversations/{state['thread_id']}?limit=100")["messages"]]
        if body not in bodies:
            raise RuntimeError("a message written after the restore or upgrade does not read back")
        print("A new message was accepted and reads back")
        if "more" in state:
            write_more(client, client.origin, state)
            print(
                "New work was accepted: messages of the guest, the member and the owner, a wiki version, a task, a message in the encrypted space"
                + (", a 6 MiB video streamed by range" if int(client.expect("GET", "/api/v1/health").get("schemaVersion", 0)) >= VIDEOS_SCHEMA else "")
                + (", a new agent run answered by the provider mock" if state["more"].get("ai") else "")
            )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("seed", "verify"))
    parser.add_argument("--origin", required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--write", action="store_true", help="verify: also write new content and read it back")
    parser.add_argument("--provider-url", help="seed: the OpenAI-compatible base URL of the provider mock; adds the AI connection and agent content")
    args = parser.parse_args()
    client = Client(args.origin)
    if args.mode == "seed":
        seed(client, args.state, args.provider_url)
    else:
        verify(client, args.state, args.write)


if __name__ == "__main__":
    main()
