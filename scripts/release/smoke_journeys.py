#!/usr/bin/env python3
"""Every feature works on the data an upgrade carried over: old rows, not new ones (founder request, Hubert, 2026-11-20).

smoke_data.py proves that what a release wrote reads back after an upgrade. This script proves that people can go on WORKING with it:

`seed` runs against the PREVIOUS release (v0.2.1 on), after `smoke_data.py seed`, as the same people (its state file), and writes what a
company has after some use, each kind in a place of its own so that smoke_data's later checks are untouched:

* a space with a thread of three people that mentions and asks, a message to edit and one to delete;
* files of each kind in one message: a PDF with text, a scanned PDF (a picture of Polish text, no text layer), a picture with text, a CSV,
  a DOCX and a short video; a PDF in the 1:1 direct message and a DOCX in a new group conversation;
* a map with thoughts and a link, tasks in every status with owners, due dates and a discussion, a Wiki page with two versions, a saved
  source (a "material" with its link: #1508's migration 0107 makes it a Wiki page), a proposed decision with a discussion and an accepted one;
* the Inbox items those messages make, a schedule of the agent (switched off), a file and a message in the encrypted space;
* a member who wrote in the space and a direct message and was then removed from the company.

`exercise` runs on the UPGRADED instance and uses each of those old rows: it reads, replies to, edits and deletes old messages, opens the old
thread and direct messages and downloads every old file byte for byte, searches for the words of old messages, pages and files (and, with
--ocr, for a word of the old scan and picture once OCR has read them), adds a thought and a link to the old map, moves every old task through
its statuses, saves a new version of the old page, opens the old source and its link, accepts the old decision, resolves the old Inbox items,
fires the old schedule by Run now and by its clock on the provider mock, unlocks the encrypted space and reads its old file, and checks that
the guest still sees only their space, that the removed member is still out, and that a new mention in an old thread still reaches the Inbox.

`real` is the READ-ONLY subset for a copy of a real installation (scripts/check_backup_upgrade.sh): it signs in as the given person and
opens what they can reach. It prints counts and PASS/FAIL only, never a name, a title, a word of content or a secret.

Each journey reports PASS, FAIL (with the exact error) or SKIP (with why), and the script exits 1 when any journey failed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import secrets
import sys
import time
import traceback
import urllib.parse
import zlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))
from smoke_data import ANSWER, VIDEO_CLIP, Client, await_run, new_id  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OCR_FIXTURES = ROOT / "app" / "tests" / "app" / "fixtures" / "ocr"
OCR_WORD = "kalibratorów"  # in tests/app/fixtures/ocr/faktura.{jpg,png} (C-70, #1575)
OWNER_NAME = "Release smoke user"  # smoke_data.py's first account
OCR_SCHEMA = 104  # C-70: OCR of scans and pictures
WAIT_SECONDS = 180


# --- Files of each kind (ported from app/tests/app/support/file-text.ts) ---------------------------------------------------------------

def pdf_bytes(pages: list[str]) -> bytes:
    """A PDF with one page for each string, in Helvetica (PDF.js reads its text layer as it is)."""
    objects = ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"]
    pages_id = 2 + len(pages) * 2
    kids = []
    for index, text in enumerate(pages):
        escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        stream = f"BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET"
        objects.append(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream")
        objects.append(f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 612 792] /Contents {2 + index * 2} 0 R /Resources << /Font << /F1 1 0 R >> >> >>")
        kids.append(3 + index * 2)
    objects.append(f"<< /Type /Pages /Count {len(kids)} /Kids [{' '.join(f'{k} 0 R' for k in kids)}] >>")
    objects.append(f"<< /Type /Catalog /Pages {pages_id} 0 R >>")
    return _assemble([o.encode("latin-1") for o in objects])


def pdf_of_jpeg(jpeg: bytes, width: int, height: int) -> bytes:
    """A scan: one page that is a grey JPEG and no text (C-69)."""
    image = b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length %d >>\nstream\n" % (
        width, height, len(jpeg)) + jpeg + b"\nendstream"
    content = b"q %d 0 0 %d 0 0 cm /Im1 Do Q" % (width, height)
    contents = b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream"
    page = b"<< /Type /Page /Parent 4 0 R /MediaBox [0 0 %d %d] /Resources << /XObject << /Im1 1 0 R >> >> /Contents 2 0 R >>" % (width, height)
    return _assemble([image, contents, page, b"<< /Type /Pages /Count 1 /Kids [3 0 R] >>", b"<< /Type /Catalog /Pages 4 0 R >>"])


def _assemble(objects: list[bytes]) -> bytes:
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, body in enumerate(objects):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % (index + 1) + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, len(objects), xref)
    return bytes(out)


def docx_bytes(paragraphs: list[str]) -> bytes:
    def esc(text: str) -> str:
        return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    body = "".join(f'<w:p><w:r><w:t xml:space="preserve">{esc(p)}</w:t></w:r></w:p>' for p in paragraphs)
    xml = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
           f"<w:body>{body}</w:body></w:document>")
    return _zip([("[Content_Types].xml", b"<Types/>"), ("word/document.xml", xml.encode())])


def _zip(entries: list[tuple[str, bytes]]) -> bytes:
    import struct
    locals_, directory, offset = [], [], 0
    for name, data in entries:
        compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
        body = compressor.compress(data) + compressor.flush()
        crc, raw_name = zlib.crc32(data) & 0xFFFFFFFF, name.encode("latin-1")
        local = struct.pack("<IHHHHHIIIHH", 0x04034B50, 20, 0, 8, 0, 0, crc, len(body), len(data), len(raw_name), 0)
        header = struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, 20, 20, 0, 8, 0, 0, crc, len(body), len(data), len(raw_name), 0, 0, 0, 0, 0, offset)
        locals_ += [local, raw_name, body]
        directory += [header, raw_name]
        offset += len(local) + len(raw_name) + len(body)
    cd = b"".join(directory)
    end = struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, len(entries), len(entries), len(cd), offset, 0)
    return b"".join(locals_) + cd + end


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# --- Small API helpers ------------------------------------------------------------------------------------------------------------------

def upload(client: Client, place: str, place_id: str, name: str, data: bytes) -> dict[str, Any]:
    status, body = client.raw("POST", f"/api/v1/{place}/{place_id}/files?{urllib.parse.urlencode({'uploadId': new_id(), 'name': name})}", data, "application/octet-stream")
    if status != 201:
        raise RuntimeError(f"upload of {name} returned {status}: {body[:300]!r}")
    return json.loads(body)


def send(client: Client, conversation_id: str, body: str) -> dict[str, Any]:
    return client.expect("POST", f"/api/v1/conversations/{conversation_id}/messages", {"body": body, "clientMessageId": new_id()})


def signed_in(origin: str, person: dict[str, str]) -> Client:
    client = Client(origin)
    client.sign_in(person["email"], person["password"])
    return client


def inbox(client: Client) -> list[dict[str, Any]]:
    return client.expect("GET", "/api/v1/inbox")["items"]


def wait_for(what: str, probe: Callable[[], Any], seconds: int = WAIT_SECONDS) -> Any:
    deadline = time.time() + seconds
    last: Any = None
    while True:
        last = probe()
        if last:
            return last
        if time.time() > deadline:
            raise RuntimeError(f"{what}: not within {seconds} s")
        time.sleep(2)


def search_texts(client: Client, q: str) -> list[dict[str, Any]]:
    found = client.expect("GET", "/api/v1/search?" + urllib.parse.urlencode({"q": q}))
    out = []
    for item in found["items"]:
        text = " ".join(part["text"] for part in (item.get("title") or []) + (item.get("snippet") or []))
        out.append({"kind": item.get("kind"), "text": text, "label": item.get("label")})
    return out


def finds(client: Client, q: str, needle: str, kind: str | None = None) -> bool:
    return any(needle.lower() in hit["text"].lower() and (kind is None or hit["kind"] == kind) for hit in search_texts(client, q))


def schema(client: Client) -> int:
    return int(client.expect("GET", "/api/v1/health").get("schemaVersion", 0))


def item_version(item: dict[str, Any]) -> str:
    return f'"{item["version"]}"'


# --- seed (on the previous release) ------------------------------------------------------------------------------------------------------

def seed(origin: str, account: dict[str, Any], state_file: Path) -> None:
    if state_file.exists():
        raise ValueError("refusing to replace existing journeys state")
    more = account["more"]
    company = account["workspace_id"]
    tag = secrets.token_hex(4)
    owner = signed_in(origin, {"email": account["email"], "password": account["password"]})
    ben_c = signed_in(origin, more["ben"])
    gina_c = signed_in(origin, more["gina"])
    from smoke_data import join
    rita_c, rita = join(owner, origin, company, "member", "Rita Removed", tag)
    owner_id = owner.expect("GET", "/api/v1/me")["user"]["id"]
    ben_id, gina_id = more["ben"]["id"], more["gina"]["id"]
    space = owner.expect("POST", f"/api/v1/workspaces/{company}/projects", {"name": f"Journeys {tag}", "visibility": "restricted", "people": [ben_id, rita["id"]]})
    sid = space["id"]
    s: dict[str, Any] = {"tag": tag, "space_id": sid, "owner_id": owner_id, "rita": rita}

    # A thread of three people: a mention of Ben, a question to the owner, a reply of the member who is removed later.
    root = owner.expect("POST", f"/api/v1/projects/{sid}/conversations", {"body": f"journeyroot{tag} kickoff, @Ben Member please look", "clientMessageId": new_id()})
    question = send(ben_c, root["id"], f"@{OWNER_NAME} can you check journeyquestion{tag}?")
    send(rita_c, root["id"], f"journeyrita{tag} done on my side")
    s["thread"] = {"id": root["id"], "bodies": [m["body"] for m in owner.expect("GET", f"/api/v1/conversations/{root['id']}?limit=100")["messages"]],
                   "question_id": question["id"]}
    edit = owner.expect("POST", f"/api/v1/projects/{sid}/conversations", {"body": f"journeyedit{tag} draft words", "clientMessageId": new_id()})
    gone = owner.expect("POST", f"/api/v1/projects/{sid}/conversations", {"body": f"journeydelete{tag} to remove", "clientMessageId": new_id()})
    s["edit"] = {"conversation": edit["id"], "message": first_message(owner, edit["id"])}
    s["delete"] = {"conversation": gone["id"], "message": first_message(owner, gone["id"])}

    # Files of each kind in one message.
    scan_jpeg = (OCR_FIXTURES / "faktura.jpg").read_bytes()
    files = {
        "report.pdf": pdf_bytes(["Opening page", f"Second page names journeypdf{tag} here."]),
        "skan-faktury.pdf": pdf_of_jpeg(scan_jpeg, 1000, 420),
        "faktura.png": (OCR_FIXTURES / "faktura.png").read_bytes(),
        "rows.csv": f"name,value\njourneycsv{tag},1\nother,2\n".encode(),
        "notes.docx": docx_bytes([f"Agreed: journeydocx{tag}"]),
        "clip.mp4": VIDEO_CLIP.read_bytes(),
    }
    staged = {name: upload(owner, "projects", sid, name, data) for name, data in files.items()}
    sent = owner.expect("POST", f"/api/v1/projects/{sid}/conversations", {
        "body": f"journeyfiles{tag} every kind", "attachmentIds": [staged[n]["id"] for n in files], "clientMessageId": new_id()})
    # What the release stored is what must come back: it re-encodes a picture on upload (the stored bytes are not the sent ones).
    s["files"] = {"conversation": sent["id"], "items": {n: {"id": staged[n]["id"], "sha256": stored(owner, staged[n]), "size": staged[n]["size"], "video": staged[n].get("video")} for n in files},
                  "words": {"report.pdf": f"journeypdf{tag}", "rows.csv": f"journeycsv{tag}", "notes.docx": f"journeydocx{tag}"}}

    # The 1:1 direct message (smoke_data's own, the same pair) with a PDF and a thread reply; a new group conversation with a DOCX.
    pair = owner.expect("POST", f"/api/v1/workspaces/{company}/dms", {"participantIds": [ben_id]})
    dm_pdf = pdf_bytes([f"Direct journeydmpdf{tag}"])
    dm_file = upload(owner, "dms", pair["id"], "dm-report.pdf", dm_pdf)
    dm_root = owner.expect("POST", f"/api/v1/dms/{pair['id']}/messages", {"body": f"journeydm{tag} the report", "attachmentIds": [dm_file["id"]], "clientMessageId": new_id()})
    ben_c.expect("POST", f"/api/v1/dms/{pair['id']}/threads/{dm_root['id']}/replies", {"body": f"journeydmreply{tag} thanks", "clientMessageId": new_id()})
    group = owner.expect("POST", f"/api/v1/workspaces/{company}/dms", {"participantIds": [ben_id, gina_id], "title": f"Journey crew {tag}"})
    group_docx = docx_bytes([f"Crew notes journeygroupdocx{tag}"])
    group_file = upload(owner, "dms", group["id"], "crew.docx", group_docx)
    owner.expect("POST", f"/api/v1/dms/{group['id']}/messages", {"body": f"journeygroup{tag} notes", "attachmentIds": [group_file["id"]], "clientMessageId": new_id()})
    s["dm"] = {"id": pair["id"], "root": dm_root["id"], "file": dm_file["id"], "sha256": stored(owner, dm_file), "word": f"journeydmpdf{tag}",
               "bodies": [f"journeydm{tag} the report", f"journeydmreply{tag} thanks"]}
    s["group"] = {"id": group["id"], "file": group_file["id"], "sha256": stored(owner, group_file), "body": f"journeygroup{tag} notes"}

    # The removed member's direct message with the owner, written before the removal.
    rita_dm = rita_c.expect("POST", f"/api/v1/workspaces/{company}/dms", {"participantIds": [owner_id]})
    rita_c.expect("POST", f"/api/v1/dms/{rita_dm['id']}/messages", {"body": f"journeyritadm{tag} before I go", "clientMessageId": new_id()})
    s["rita_dm"] = rita_dm["id"]

    # A map: two thoughts and a link.
    sketch = owner.expect("POST", f"/api/v1/workspaces/{company}/sketches", {"title": f"Journey map {tag}", "scope": "project", "projectId": sid})
    seedling = owner.expect("POST", f"/api/v1/sketches/{sketch['id']}/thoughts", {"text": "Seedlings", "x": 10, "y": 10})["thought"]
    light = owner.expect("POST", f"/api/v1/sketches/{sketch['id']}/thoughts", {"text": "Light", "x": 240, "y": 10, "linkFrom": {"thoughtId": seedling["id"], "label": "need"}})["thought"]
    owner.expect("POST", f"/api/v1/sketches/{sketch['id']}/thoughts", {"text": "Frost", "x": 240, "y": 140})
    s["map"] = {"id": sketch["id"], "thoughts": sorted(["Seedlings", "Light", "Frost"]), "links": 1}

    # Tasks in every status, with owners, due dates and a discussion.
    tasks = {}
    for status, extra in (
        ("open", {"owner": {"kind": "human", "id": ben_id}, "dueOn": "2027-06-01"}),
        ("in_progress", {"owner": {"kind": "human", "id": owner_id}, "dueOn": "2027-06-02"}),
        ("blocked", {"blocker": "waiting for the owner", "waitingFor": {"kind": "human", "id": owner_id}, "dueOn": "2027-06-03"}),
        ("done", {"owner": {"kind": "human", "id": owner_id}}),
    ):
        task = owner.expect("POST", f"/api/v1/projects/{sid}/work", {"title": f"journeytask{status.replace('_', '')}{tag}", "status": status, **extra})
        if task["status"] != status:
            raise RuntimeError(f"a task created {status} is {task['status']}")
        ben_c.expect("POST", f"/api/v1/work/{task['id']}/discussion", {"body": f"journeytaskdisc{status.replace('_', '')}{tag}", "clientMessageId": new_id()})
        tasks[status] = {"id": task["id"], "title": task["title"], "dueOn": task.get("dueOn")}
    s["tasks"] = tasks

    # A Wiki page with two versions, and a saved source with its link (a "material" of v0.2.1).
    page = owner.expect("POST", f"/api/v1/projects/{sid}/docs", {"title": f"journeywiki{tag}", "body": f"journeywikiv1{tag}"}, (201,), {"Idempotency-Key": new_id()})
    second = ben_c.expect("PATCH", f"/api/v1/docs/{page['id']}", {"body": f"journeywikiv2{tag}"}, (200,), {"If-Match": item_version(page)})
    s["wiki"] = {"id": page["id"], "title": f"journeywiki{tag}", "bodies": {"1": f"journeywikiv1{tag}", "2": f"journeywikiv2{tag}"}, "version": second["version"]}
    link = f"https://example.org/journey-source-{tag}"
    material = owner.expect("POST", f"/api/v1/projects/{sid}/materials", {"clientMutationId": new_id(), "title": f"journeysource{tag}", "body": f"Saved journeysourcebody{tag}", "url": link})
    s["source"] = {"id": material.get("materialId") or material["id"], "title": f"journeysource{tag}", "url": link, "body": f"Saved journeysourcebody{tag}"}

    # Decisions: one proposed with a discussion, one accepted.
    proposed = owner.expect("POST", f"/api/v1/projects/{sid}/decisions", {"title": f"journeydecisionproposed{tag}"})
    ben_c.expect("POST", f"/api/v1/decisions/{proposed['id']}/discussion", {"body": f"journeydecisiondisc{tag}", "clientMessageId": new_id()})
    accepted = owner.expect("POST", f"/api/v1/projects/{sid}/decisions", {"title": f"journeydecisionaccepted{tag}"})
    owner.expect("POST", f"/api/v1/decisions/{accepted['id']}/accept", {}, (200,), {"If-Match": item_version(accepted)})
    s["decisions"] = {"proposed": proposed["id"], "accepted": accepted["id"], "discussion": f"journeydecisiondisc{tag}"}

    # The Inbox items the thread made: the owner's question, Ben's mention.
    q_item = wait_for("the owner's Inbox item for Ben's question", lambda: next((i for i in inbox(owner) if (i.get("url") or "").endswith(question["id"])), None), 60)
    root_message = first_message(owner, root["id"])
    m_item = wait_for("Ben's Inbox item for the mention", lambda: next((i for i in inbox(ben_c) if (i.get("url") or "").endswith(root_message)), None), 60)
    s["inbox"] = {"owner_item": q_item["id"], "owner_reason": q_item.get("reason"), "ben_item": m_item["id"], "ben_reason": m_item.get("reason")}

    # A schedule of the agent, switched off (only with smoke_data's AI content).
    ai = more.get("ai")
    if ai:
        note = owner.expect("GET", f"/api/v1/my-agents/{ai['agent_id']}/background-note")["version"]
        job = owner.expect("POST", f"/api/v1/my-agents/{ai['agent_id']}/schedules", {
            "title": f"Journey tick {tag}", "text": "Say what changed in the Journeys space", "timeZone": "UTC",
            "schedule": {"kind": "daily", "at": "03:00"}, "enabled": False, "noteVersion": note})
        s["schedule"] = {"agent": ai["agent_id"], "id": job["id"]}

    # The encrypted space: a file and a message, locked again as people leave it.
    vault = more["vault"]
    owner.expect("POST", f"/api/v1/workspaces/{vault['workspace_id']}/unlock", {"password": vault["password"]}, (200,))
    vault_bytes = pdf_bytes([f"Sealed journeyvault{tag}"])
    vault_file = upload(owner, "projects", vault["project_id"], "sealed.pdf", vault_bytes)
    vault_message = owner.expect("POST", f"/api/v1/projects/{vault['project_id']}/conversations", {
        "body": f"journeyvault{tag} sealed file", "attachmentIds": [vault_file["id"]], "clientMessageId": new_id()})
    vault_sha = stored(owner, vault_file)
    owner.expect("POST", f"/api/v1/workspaces/{vault['workspace_id']}/lock", None, (200, 204))
    s["vault"] = {"conversation": vault_message["id"], "file": vault_file["id"], "sha256": vault_sha, "body": f"journeyvault{tag} sealed file"}

    # The member who wrote here is removed from the company; what they get now is recorded and must hold after the upgrade.
    owner.expect("DELETE", f"/api/v1/workspaces/{company}/members/{rita['id']}", None, (200, 204))
    s["removed_before"] = removed_view(origin, rita, company, sid)
    if s["removed_before"]["space"] not in (403, 404) or s["removed_before"]["in_company"]:
        raise RuntimeError(f"the removed member still reaches the company on the previous release: {s['removed_before']!r}")

    state_file.write_text(json.dumps(s), encoding="utf-8")
    state_file.chmod(0o600)
    print("Journeys seeded: a thread with a mention and a question, a message to edit and one to delete, six files of each kind, files in a "
          "direct and a group message, a map, four tasks in every status with discussions, a Wiki page of two versions, a saved source with "
          "its link, a proposed and an accepted decision, Inbox items, " + ("a schedule, " if ai else "") + "a sealed file, and a removed member")


def stored(client: Client, staged: dict[str, Any]) -> str:
    """The SHA-256 of the bytes the release serves for a file it stored (it says the same in the upload's answer)."""
    status, data = client.raw("GET", f"/api/v1/files/{staged['id']}")
    if status != 200 or (staged.get("sha256") and sha(data) != staged["sha256"]):
        raise RuntimeError(f"{staged.get('name')} reads back {status} with other bytes than the release stored, before any upgrade")
    return sha(data)


def first_message(client: Client, conversation_id: str) -> str:
    return client.expect("GET", f"/api/v1/conversations/{conversation_id}?limit=100")["messages"][0]["id"]


def removed_view(origin: str, person: dict[str, str], company: str, space_id: str) -> dict[str, Any]:
    """What a removed person gets: whether they can sign in at all, and if so whether the company and its space still open."""
    client = Client(origin)
    try:
        client.sign_in(person["email"], person["password"])
        status = 200
    except RuntimeError as error:
        status = int(str(error).split(" returned ", 1)[1].split(":", 1)[0])
    if status != 200:
        return {"sign_in": status, "space": 401, "in_company": False}
    companies = [w["id"] for w in client.expect("GET", "/api/v1/workspaces")]
    return {"sign_in": status, "space": client.status("GET", f"/api/v1/projects/{space_id}"), "in_company": company in companies}


# --- exercise (on the upgraded instance) -------------------------------------------------------------------------------------------------

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def private_error(text: str) -> str:
    """An error on a copy of real data keeps its route shape and status only: no id, no query (a search word), no answer's text."""
    call = re.match(r"([A-Z]+) (\S+) returned (\d+)", text)
    if call:
        path, query = call.group(2).split("?", 1) if "?" in call.group(2) else (call.group(2), "")
        return f"{call.group(1)} {UUID.sub('<id>', path)}{'?<query>' if query else ''} returned {call.group(3)}"
    return UUID.sub("<id>", text.split(": ", 1)[0])


class Report:
    def __init__(self, private: bool = False) -> None:
        self.rows: list[tuple[str, str, str]] = []
        self.private = private  # a copy of real data: an error keeps its route shape and status, never an id or an answer's text

    def run(self, name: str, journey: Callable[[], str | None]) -> None:
        try:
            note = journey()
            if isinstance(note, str) and note.startswith("SKIP"):
                self.rows.append((name, "SKIP", note[5:].strip()))
            else:
                self.rows.append((name, "PASS", note or ""))
        except Exception as error:  # noqa: BLE001 - every journey reports, one failure does not hide the others
            text = f"{error}"
            if self.private:
                text = private_error(text)
            else:
                traceback.print_exc(limit=2, file=sys.stderr)
            self.rows.append((name, "FAIL", text[:600]))
        status, note = self.rows[-1][1], self.rows[-1][2]
        print(f"  {status:4}  {name}{(' - ' + note) if note else ''}", flush=True)

    def finish(self, path: Path | None) -> int:
        failed = [row for row in self.rows if row[1] == "FAIL"]
        print(f"journeys: {sum(r[1] == 'PASS' for r in self.rows)} PASS, {len(failed)} FAIL, {sum(r[1] == 'SKIP' for r in self.rows)} SKIP")
        if path:
            path.write_text(json.dumps(self.rows, indent=1), encoding="utf-8")
        return 1 if failed else 0


def exercise(origin: str, account: dict[str, Any], state_file: Path, ocr: bool, report_file: Path | None) -> int:
    s = json.loads(state_file.read_text(encoding="utf-8"))
    more = account["more"]
    company = account["workspace_id"]
    owner = signed_in(origin, {"email": account["email"], "password": account["password"]})
    ben_c = signed_in(origin, more["ben"])
    gina_c = signed_in(origin, more["gina"])
    tag, sid, after = s["tag"], s["space_id"], secrets.token_hex(3)
    version = schema(owner)
    r = Report()
    print(f"Journeys on the old rows (schema {version}):")

    def messages() -> str:
        thread = owner.expect("GET", f"/api/v1/conversations/{s['thread']['id']}?limit=100")["messages"]
        if [m["body"] for m in thread][:3] != s["thread"]["bodies"]:
            raise RuntimeError(f"the old thread reads {[m['body'] for m in thread]!r}")
        reply = send(owner, s["thread"]["id"], f"journeyreplyafter{after}")
        edited = owner.expect("PATCH", f"/api/v1/conversations/{s['edit']['conversation']}/messages/{s['edit']['message']}", {"body": f"journeyedited{after} new words"}, (200,))
        if edited.get("body") != f"journeyedited{after} new words":
            raise RuntimeError(f"the edit of an old message answered {edited.get('body')!r}")
        reread = owner.expect("GET", f"/api/v1/conversations/{s['edit']['conversation']}?limit=100")["messages"][0]
        if reread["body"] != f"journeyedited{after} new words":
            raise RuntimeError(f"the edited old message reads {reread['body']!r}")
        owner.expect("DELETE", f"/api/v1/conversations/{s['delete']['conversation']}/messages/{s['delete']['message']}", None, (200, 204))
        removed = owner.expect("GET", f"/api/v1/conversations/{s['delete']['conversation']}?limit=100")["messages"][0]
        if f"journeydelete{tag}" in (removed.get("body") or ""):
            raise RuntimeError("a deleted old message still shows its words")
        return f"thread of {len(thread)} read, reply {reply['sequence']}, edit and delete of old messages"
    r.run("Old messages: read, reply, edit, delete", messages)

    def thread() -> str:
        bodies = [m["body"] for m in ben_c.expect("GET", f"/api/v1/conversations/{s['thread']['id']}?limit=100")["messages"]]
        missing = [b for b in s["thread"]["bodies"] if b not in bodies]
        if missing:
            raise RuntimeError(f"the member does not read {missing!r} in the old thread")
        return "three authors' messages, incl. the removed member's, as the member reads them"
    r.run("Old thread opens (as another member)", thread)

    def dms() -> str:
        dm_thread = ben_c.expect("GET", f"/api/v1/dms/{s['dm']['id']}/threads/{s['dm']['root']}")
        bodies = [dm_thread["root"]["body"]] + [x["body"] for x in dm_thread["replies"]]
        if bodies[:2] != s["dm"]["bodies"]:
            raise RuntimeError(f"the old direct thread reads {bodies!r}")
        files = dm_thread["root"].get("files") or []
        if [f["id"] for f in files] != [s["dm"]["file"]]:
            raise RuntimeError(f"the old direct message lists files {files!r}")
        status, data = ben_c.raw("GET", f"/api/v1/files/{s['dm']['file']}")
        if status != 200 or sha(data) != s["dm"]["sha256"]:
            raise RuntimeError(f"the old direct message's PDF answered {status} with other bytes")
        ben_c.expect("POST", f"/api/v1/dms/{s['dm']['id']}/threads/{s['dm']['root']}/replies", {"body": f"journeydmafter{after}", "clientMessageId": new_id()})
        group = gina_c.expect("GET", f"/api/v1/dms/{s['group']['id']}?limit=100")
        if s["group"]["body"] not in [m["body"] for m in group["messages"]]:
            raise RuntimeError("the guest does not read the old group message")
        status, data = gina_c.raw("GET", f"/api/v1/files/{s['group']['file']}")
        if status != 200 or sha(data) != s["group"]["sha256"]:
            raise RuntimeError(f"the old group DOCX answered {status} with other bytes")
        return "1:1 thread + its PDF (byte-identical), reply; group message + its DOCX as the guest"
    r.run("Old direct messages and their files", dms)

    def files() -> str:
        message = owner.expect("GET", f"/api/v1/conversations/{s['files']['conversation']}?limit=100")["messages"][0]
        listed = {f["id"]: f for f in message.get("files") or []}
        for name, item in s["files"]["items"].items():
            if item["id"] not in listed:
                raise RuntimeError(f"the old message no longer lists {name}")
            status, data = owner.raw("GET", f"/api/v1/files/{item['id']}")
            if status != 200 or sha(data) != item["sha256"]:
                raise RuntimeError(f"{name} answered {status} with {len(data)} bytes, not the {item['size']} it had")
        clip = s["files"]["items"]["clip.mp4"]
        note = ""
        if clip.get("video"):
            status, part = owner.raw("GET", f"/api/v1/files/{clip['id']}/video", headers={"Range": "bytes=0-99"})
            if status != 206 or len(part) != 100:
                raise RuntimeError(f"the old video's range answered {status} with {len(part)} bytes")
            note = ", the video streams by range"
        scan = listed[s["files"]["items"]["skan-faktury.pdf"]["id"]]
        return f"{len(s['files']['items'])} files byte-identical{note}; the scan is {'marked no-text' if scan.get('noText') else 'read (OCR text)' if version >= OCR_SCHEMA else 'unmarked'}"
    r.run("Old files of every kind download byte-identical", files)

    def search() -> str:
        checks = [("message", f"journeyroot{tag}", f"journeyroot{tag}", owner), ("Wiki page", s["wiki"]["title"], s["wiki"]["title"], owner),
                  ("task", s["tasks"]["open"]["title"], s["tasks"]["open"]["title"], owner),
                  ("PDF text", s["files"]["words"]["report.pdf"], "report.pdf", owner), ("DOCX text", s["files"]["words"]["notes.docx"], "notes.docx", owner),
                  ("CSV text", s["files"]["words"]["rows.csv"], "rows.csv", owner), ("decision", f"journeydecisionproposed{tag}", f"journeydecisionproposed{tag}", owner),
                  ("saved source", s["source"]["title"], s["source"]["title"], owner), ("DM message", f"journeydm{tag}", f"journeydm{tag}", ben_c)]
        if version >= 109:  # #1596: the files of a direct message are found by its people
            checks.append(("DM PDF text", s["dm"]["word"], "dm-report.pdf", ben_c))
        missing = []
        for label, q, needle, who in checks:
            try:
                wait_for(f"search for the old {label}", lambda: finds(who, q, needle), 120)
            except RuntimeError:
                missing.append(label)
        if missing:
            raise RuntimeError(f"search does not find the old {', '.join(missing)}")
        return f"{len(checks)} kinds found by a word (vectors: not run, embeddings off)"
    r.run("Search finds old content", search)

    def ocr_search() -> str:
        if version < OCR_SCHEMA:
            return "SKIP the candidate has no OCR"
        if not ocr:
            return "SKIP FLUX_FILE_OCR is off on this instance"
        found = wait_for("OCR of the old scan and picture, then search", lambda: (
            lambda hits: hits if {"skan-faktury.pdf", "faktura.png"} <= {name for name in ("skan-faktury.pdf", "faktura.png") if any(name in h["text"] for h in hits)} else None
        )(search_texts(owner, OCR_WORD)), 300)
        return f"'{OCR_WORD}' finds the old scan and picture ({len(found)} hits)"
    r.run("OCR backfill: search finds a word in the old scan", ocr_search)

    def maps() -> str:
        sketch = owner.expect("GET", f"/api/v1/sketches/{s['map']['id']}")
        texts = {t["id"]: t["text"] for t in sketch["thoughts"]}
        if sorted(texts.values()) != s["map"]["thoughts"] or len(sketch["links"]) != s["map"]["links"]:
            raise RuntimeError(f"the old map reads {sorted(texts.values())!r} with {len(sketch['links'])} links")
        ids = {text: tid for tid, text in texts.items()}
        owner.expect("POST", f"/api/v1/sketches/{s['map']['id']}/thoughts", {"text": f"Water {after}", "x": 10, "y": 200, "linkFrom": {"thoughtId": ids["Seedlings"], "label": "need"}})
        owner.expect("POST", f"/api/v1/sketches/{s['map']['id']}/links", {"fromId": ids["Light"], "toId": ids["Frost"], "label": "against"})
        again = owner.expect("GET", f"/api/v1/sketches/{s['map']['id']}")
        if len(again["thoughts"]) != 4 or len(again["links"]) != 3:
            raise RuntimeError(f"the old map has {len(again['thoughts'])} thoughts and {len(again['links'])} links after adding")
        return "old map opened; a thought linked from an old one and a link between two old ones added"
    r.run("Old map: open, add thought and link", maps)

    def tasks() -> str:
        moves = {"open": ["in_progress", "blocked", "done"], "in_progress": ["blocked", "done", "open"], "blocked": ["in_progress", "done"], "done": ["open", "in_progress"]}
        ben_id = more["ben"]["id"]
        for status, path in moves.items():
            task = s["tasks"][status]
            item = owner.expect("GET", f"/api/v1/work/{task['id']}")
            if item["status"] != status or item["title"] != task["title"] or item.get("dueOn") != task["dueOn"]:
                raise RuntimeError(f"the old {status} task reads {item['status']!r} {item['title']!r} {item.get('dueOn')!r}")
            discussion = owner.expect("GET", f"/api/v1/work/{task['id']}/discussion")
            if f"journeytaskdisc{status.replace('_', '')}{tag}" not in [m["body"] for m in discussion["messages"]]:
                raise RuntimeError(f"the old {status} task's discussion lost its message")
            owner.expect("POST", f"/api/v1/work/{task['id']}/discussion", {"body": f"journeytaskafter{after}", "clientMessageId": new_id()})
            for target in path:
                item = owner.expect("GET", f"/api/v1/work/{task['id']}")
                change: dict[str, Any] = {"status": target, "clientCommandId": new_id()}
                if target == "blocked":
                    change.update(blocker="waiting again", waitingFor={"kind": "human", "id": ben_id})
                if target == "in_progress" and not item.get("owner"):
                    change["owner"] = {"kind": "human", "id": s["owner_id"]}
                moved = owner.expect("PATCH", f"/api/v1/work/{task['id']}", change, (200,), {"If-Match": item_version(item)})
                if moved["status"] != target:
                    raise RuntimeError(f"the old {status} task moved to {moved['status']!r}, not {target!r}")
        return "4 old tasks (open, in progress, blocked, done) read with owner/due/discussion and moved through every status"
    r.run("Old tasks: discussion, move through statuses", tasks)

    def wiki() -> str:
        page = owner.expect("GET", f"/api/v1/docs/{s['wiki']['id']}")
        if page["title"] != s["wiki"]["title"]:
            raise RuntimeError(f"the old page is titled {page['title']!r}")
        for number, body in s["wiki"]["bodies"].items():
            seen = owner.expect("GET", f"/api/v1/docs/{s['wiki']['id']}/versions/{number}")["body"]
            if seen != body:
                raise RuntimeError(f"version {number} of the old page reads {seen!r}")
        saved = owner.expect("PATCH", f"/api/v1/docs/{s['wiki']['id']}", {"body": f"journeywikiafter{after}"}, (200,), {"If-Match": item_version(page)})
        return f"old page and its 2 versions read; version {saved['version']} saved"
    r.run("Old Wiki page: open, versions, save", wiki)

    def source() -> str:
        material = owner.expect("GET", f"/api/v1/materials/{s['source']['id']}")
        if material["title"] != s["source"]["title"] or material.get("url") != s["source"]["url"]:
            raise RuntimeError(f"the old source reads {material.get('title')!r} with link {material.get('url')!r}")
        if material.get("kind") == "material":
            return "the old source opens with its link, still as a saved source (#1508's migration 0107 is not in this candidate)"
        page = owner.expect("GET", f"/api/v1/docs/{s['source']['id']}")
        first = owner.expect("GET", f"/api/v1/docs/{s['source']['id']}/versions/1")
        if page["title"] != s["source"]["title"] or first.get("url") != s["source"]["url"] or first.get("body") != s["source"]["body"]:
            raise RuntimeError(f"the converted source reads {page.get('title')!r}, link {first.get('url')!r}")
        return "the old source is a Wiki page with its 'Open source link'"
    r.run("Old saved source (material) and its link", source)

    def decisions() -> str:
        proposed = owner.expect("GET", f"/api/v1/decisions/{s['decisions']['proposed']}")
        accepted = owner.expect("GET", f"/api/v1/decisions/{s['decisions']['accepted']}")
        if proposed["status"] != "proposed" or accepted["status"] != "accepted":
            raise RuntimeError(f"the old decisions read {proposed['status']!r} and {accepted['status']!r}")
        discussion = owner.expect("GET", f"/api/v1/decisions/{s['decisions']['proposed']}/discussion")
        if s["decisions"]["discussion"] not in [m["body"] for m in discussion["messages"]]:
            raise RuntimeError("the old decision's discussion lost its message")
        owner.expect("POST", f"/api/v1/decisions/{s['decisions']['proposed']}/discussion", {"body": f"journeydecisionafter{after}", "clientMessageId": new_id()})
        done = owner.expect("POST", f"/api/v1/decisions/{s['decisions']['proposed']}/accept", {}, (200,), {"If-Match": item_version(proposed)})
        if done["status"] != "accepted":
            raise RuntimeError(f"accepting the old decision answered {done['status']!r}")
        return "old proposed and accepted decisions read; discussion replied; the proposed one accepted"
    r.run("Old decisions: read, discuss, accept", decisions)

    def inbox_items() -> str:
        own = {i["id"]: i for i in inbox(owner)}
        bens = {i["id"]: i for i in inbox(ben_c)}
        if s["inbox"]["owner_item"] not in own or s["inbox"]["ben_item"] not in bens:
            raise RuntimeError("an old Inbox item is gone")
        detail = owner.expect("GET", f"/api/v1/inbox/{s['inbox']['owner_item']}")
        owner.expect("POST", f"/api/v1/inbox/{s['inbox']['owner_item']}/read", None, (200, 204))
        ben_c.expect("POST", f"/api/v1/inbox/{s['inbox']['ben_item']}/read", None, (200, 204))
        if not {i["id"]: i for i in inbox(owner)}[s["inbox"]["owner_item"]].get("readAt"):
            raise RuntimeError("the old Inbox item is not marked read")
        return f"old {s['inbox']['owner_reason']} and {s['inbox']['ben_reason']} items listed, opened (from: {(detail.get('from') or {}).get('kind')}) and resolved"
    r.run("Inbox: old items listed and resolved", inbox_items)

    def deliver() -> str:
        asked = send(ben_c, s["thread"]["id"], f"@{OWNER_NAME} one more journeyafterq{after}?")
        item = wait_for("the Inbox item of a new question in the old thread", lambda: next((i for i in inbox(owner) if (i.get("url") or "").endswith(asked["id"])), None), 60)
        return f"a new question in the old thread reached the owner's Inbox ({item.get('reason')}); push and e-mail not exercised here"
    r.run("Notifications still deliver (old thread)", deliver)

    def agent() -> str:
        if not s.get("schedule"):
            return "SKIP no AI content was seeded (no provider mock)"
        agent_id, job_id = s["schedule"]["agent"], s["schedule"]["id"]
        started = owner.expect("POST", f"/api/v1/my-agents/{agent_id}/schedules/{job_id}/run", None, (200, 202))
        run = await_run(owner, started["run"]["runId"]) if started["run"].get("runId") else None
        if not run or run["status"] != "completed" or ANSWER not in json.dumps(run.get("answer")):
            raise RuntimeError(f"Run now of the old schedule ended {run and run['status']!r}: {run and run.get('answer')!r}")
        # By its clock: the old schedule is set to the next whole minute that is at least 70 s away, and must fire by itself.
        at = (datetime.now(timezone.utc) + timedelta(seconds=130)).replace(second=0, microsecond=0)
        job = next(j for j in owner.expect("GET", f"/api/v1/my-agents/{agent_id}/schedules")["items"] if j["id"] == job_id)
        owner.expect("PATCH", f"/api/v1/my-agents/{agent_id}/schedules/{job_id}", {
            "expectedVersion": job["version"], "enabled": True, "timeZone": "UTC", "schedule": {"kind": "daily", "at": at.strftime("%H:%M")}}, (200,))
        fired = wait_for("the old schedule firing by its clock", lambda: next((h for h in owner.expect("GET", f"/api/v1/my-agents/{agent_id}/schedules/{job_id}/history")["items"]
                                                                              if h["firedBy"] == "schedule" and h["state"] in ("done", "failed", "skipped")), None), 300)
        job = next(j for j in owner.expect("GET", f"/api/v1/my-agents/{agent_id}/schedules")["items"] if j["id"] == job_id)
        owner.expect("PATCH", f"/api/v1/my-agents/{agent_id}/schedules/{job_id}", {"expectedVersion": job["version"], "enabled": False}, (200,))
        if fired["state"] != "done":
            raise RuntimeError(f"the old schedule fired by its clock and ended {fired['state']!r}: {fired['line']!r}")
        return f"Run now answered by the mock; fired by its clock at {at.strftime('%H:%M')} UTC: {fired['line']!r}"
    r.run("Old agent schedule: Run now and fires by its clock", agent)

    def vault() -> str:
        v = more["vault"]
        if owner.expect("GET", f"/api/v1/workspaces/{v['workspace_id']}")["encryption"]["state"] == "locked":
            owner.expect("POST", f"/api/v1/workspaces/{v['workspace_id']}/unlock", {"password": v["password"]}, (200,))
        message = owner.expect("GET", f"/api/v1/conversations/{s['vault']['conversation']}?limit=100")["messages"][0]
        if message["body"] != s["vault"]["body"]:
            raise RuntimeError(f"the old sealed message reads {message['body']!r}")
        status, data = owner.raw("GET", f"/api/v1/files/{s['vault']['file']}")
        if status != 200 or sha(data) != s["vault"]["sha256"]:
            raise RuntimeError(f"the old sealed file answered {status} with other bytes")
        send(owner, s["vault"]["conversation"], f"journeyvaultafter{after}")
        return "unlocked with its password; the old sealed message and file read; a reply written"
    r.run("Encrypted space: unlock, old message and file", vault)

    def guest() -> str:
        spaces = [p["id"] for p in gina_c.all(f"/api/v1/workspaces/{company}/projects")]
        if sid in spaces or more["garden_id"] not in spaces:
            raise RuntimeError(f"the guest's spaces changed: Journeys {'listed' if sid in spaces else 'not listed'}, Garden {'listed' if more['garden_id'] in spaces else 'gone'}")
        if gina_c.status("GET", f"/api/v1/projects/{sid}") not in (403, 404):
            raise RuntimeError("the guest opens a space they are not in")
        if gina_c.status("GET", f"/api/v1/conversations/{s['thread']['id']}") not in (403, 404):
            raise RuntimeError("the guest reads a thread of a space they are not in")
        if finds(gina_c, f"journeyroot{tag}", f"journeyroot{tag}"):
            raise RuntimeError("the guest's search finds a message of a space they are not in")
        return f"the guest lists {len(spaces)} space(s), Garden only of the seeded ones; Journeys refused and not found"
    r.run("Guest still sees only their space", guest)

    def removed() -> str:
        now = removed_view(origin, s["rita"], company, sid)
        if now != s["removed_before"]:
            raise RuntimeError(f"the removed member gets {now!r} after the upgrade, {s['removed_before']!r} before")
        dm = owner.expect("GET", f"/api/v1/dms/{s['rita_dm']}?limit=100")
        if not any(f"journeyritadm{s['tag']}" in m["body"] for m in dm["messages"]):
            raise RuntimeError("the removed member's old direct message is gone")
        return f"sign-in {now['sign_in']}, space {now['space']}, company {'listed' if now['in_company'] else 'not listed'} - as before the upgrade; their old DM reads ({dm.get('counterpartGone')})"
    r.run("Removed person stays out", removed)

    return r.finish(report_file)


# --- real: the read-only subset for a copy of a real installation ------------------------------------------------------------------------

def real(origin: str, email: str, password: str, report_file: Path | None) -> int:
    """Opens what this person reaches, writes nothing, prints counts and PASS/FAIL only (no names, titles, words or secrets)."""
    me = Client(origin)
    me.sign_in(email, password)
    r = Report(private=True)
    version = schema(me)
    print(f"Read-only journeys on a copy of real data (schema {version}):")
    workspaces = me.expect("GET", "/api/v1/workspaces")
    spaces: list[dict[str, Any]] = []
    locked = 0
    for w in workspaces:
        if (w.get("encryption") or {}).get("state") == "locked":
            locked += 1
            continue
        spaces += [{**p, "_ws": w["id"]} for p in me.all(f"/api/v1/workspaces/{w['id']}/projects")]
    counts: dict[str, int] = {}
    words: list[tuple[str, str]] = []  # (word, kind) taken from content to search for; never printed

    def first_word(text: str) -> str | None:
        for token in text.split():
            token = "".join(ch for ch in token if ch.isalnum())
            if len(token) >= 6:
                return token
        return None

    def spaces_journey() -> str:
        counts["workspaces"], counts["spaces"], counts["locked"] = len(workspaces), len(spaces), locked
        for p in spaces:
            me.expect("GET", f"/api/v1/projects/{p['id']}")
        return f"{len(workspaces)} workspace(s), {len(spaces)} space(s) open; {locked} encrypted workspace(s) locked (no password here)"
    r.run("Spaces open", spaces_journey)

    files_seen: list[dict[str, Any]] = []

    def conversations() -> str:
        n_conv = n_msg = 0
        for p in spaces:
            roots = me.expect("GET", f"/api/v1/projects/{p['id']}/conversation-roots")
            for root in roots.get("roots", [])[:40]:
                cid = root.get("conversationId")
                if not cid:
                    continue
                window = me.expect("GET", f"/api/v1/conversations/{cid}?limit=100")
                n_conv += 1
                for m in window["messages"]:
                    n_msg += 1
                    files_seen.extend(m.get("files") or [])
                    if len(words) < 6 and (w := first_word(m.get("body") or "")):
                        words.append((w, "message"))
        counts["conversations"], counts["messages"] = n_conv, n_msg
        return f"{n_conv} conversation(s), {n_msg} message(s) read"
    r.run("Conversations and threads open", conversations)

    def dms() -> str:
        n_dm = n_msg = 0
        for w in workspaces:
            if (w.get("encryption") or {}).get("state") == "locked":
                continue
            for dm in me.all(f"/api/v1/workspaces/{w['id']}/dms"):
                window = me.expect("GET", f"/api/v1/dms/{dm['id']}?limit=100")
                n_dm += 1
                for m in window["messages"]:
                    n_msg += 1
                    files_seen.extend(m.get("files") or [])
        return f"{n_dm} direct conversation(s), {n_msg} message(s) read"
    r.run("Direct messages open", dms)

    def files() -> str:
        unique = {f["id"]: f for f in files_seen}
        bad = 0
        for f in unique.values():
            status, data = me.raw("GET", f"/api/v1/files/{f['id']}")
            if status != 200 or len(data) != f["size"]:
                bad += 1
        if bad:
            raise RuntimeError(f"{bad} of {len(unique)} file(s) did not download at their recorded size")
        return f"{len(unique)} file(s) downloaded at their recorded size"
    r.run("Files download", files)

    def docs() -> str:
        n = 0
        for p in spaces:
            for d in me.all(f"/api/v1/projects/{p['id']}/docs"):
                page = me.expect("GET", f"/api/v1/docs/{d['id']}")
                me.all(f"/api/v1/docs/{d['id']}/versions")
                n += 1
                if len(words) < 9 and (w := first_word(page.get("title") or "")):
                    words.append((w, "page"))
        return f"{n} Wiki page(s) and their versions open"
    r.run("Wiki pages open", docs)

    def maps() -> str:
        n = thoughts = 0
        for w in workspaces:
            if (w.get("encryption") or {}).get("state") == "locked":
                continue
            listed = {sk["id"] for sk in me.all(f"/api/v1/workspaces/{w['id']}/sketches?scope=private")}
            for p in spaces:
                if p["_ws"] == w["id"]:
                    listed |= {sk["id"] for sk in me.all(f"/api/v1/workspaces/{w['id']}/sketches?projectId={p['id']}")}
            for sketch_id in listed:
                thoughts += len(me.expect("GET", f"/api/v1/sketches/{sketch_id}")["thoughts"])
                n += 1
        return f"{n} map(s), {thoughts} thought(s) open"
    r.run("Maps open", maps)

    def tasks() -> str:
        n = statuses = 0
        seen: set[str] = set()
        for p in spaces:
            for t in me.all(f"/api/v1/projects/{p['id']}/work"):
                item = me.expect("GET", f"/api/v1/work/{t['id']}")
                me.expect("GET", f"/api/v1/work/{t['id']}/discussion")
                seen.add(item["status"])
                n += 1
        statuses = len(seen)
        return f"{n} task(s) and their discussions open, in {statuses} status(es)"
    r.run("Tasks open", tasks)

    def inbox_journey() -> str:
        items = inbox(me)
        for item in items[:20]:
            me.expect("GET", f"/api/v1/inbox/{item['id']}")
        return f"{len(items)} Inbox item(s) listed, {min(len(items), 20)} opened"
    r.run("Inbox lists and opens old items", inbox_journey)

    def search() -> str:
        if not words:
            return "SKIP no words to search for"
        found = sum(1 for word, _ in words if search_texts(me, word))
        if found != len(words):
            raise RuntimeError(f"search found {found} of {len(words)} words taken from old content")
        return f"{found} of {len(words)} words taken from old messages and pages found"
    r.run("Search finds old content", search)

    def agents() -> str:
        mine = me.expect("GET", "/api/v1/my-agents")["items"]
        schedules = ahead = 0
        now = datetime.now(timezone.utc)
        for agent in mine:
            for job in me.expect("GET", f"/api/v1/my-agents/{agent['id']}/schedules")["items"]:
                schedules += 1
                if job["enabled"] and job["next"]:
                    if datetime.fromisoformat(job["next"][0]["at"].replace("Z", "+00:00")) <= now:
                        raise RuntimeError("an enabled schedule's next time is not ahead")
                    ahead += 1
        return f"{len(mine)} agent(s), {schedules} schedule(s), {ahead} enabled with next times ahead (runs not started: the AI key file is not in a backup)"
    r.run("Agents and schedules read", agents)

    def people() -> str:
        n = 0
        for w in workspaces:
            if w.get("company"):
                members = me.expect("GET", f"/api/v1/workspaces/{w['id']}/members")
                roles: dict[str, int] = {}
                for m in members:
                    roles[m["role"]] = roles.get(m["role"], 0) + 1
                n += len(members)
                removed = me.status("GET", f"/api/v1/workspaces/{w['id']}/removed-people")
                return f"{n} member(s) by role {dict(sorted(roles.items()))}; removed-people list answers {removed}"
        return "SKIP no company"
    r.run("People and roles read", people)
    return r.finish(report_file)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mode", choices=("seed", "exercise", "real"))
    parser.add_argument("--origin", required=True)
    parser.add_argument("--account", type=Path, help="seed/exercise: smoke_data.py's state file")
    parser.add_argument("--state", type=Path, help="seed/exercise: this script's state file")
    parser.add_argument("--ocr", action="store_true", help="exercise: the instance runs with FLUX_FILE_OCR=on")
    parser.add_argument("--report", type=Path, help="write the journeys' results as JSON")
    args = parser.parse_args()
    if args.mode == "real":
        import os
        email, password = os.environ.get("FLUX_JOURNEYS_EMAIL"), os.environ.get("FLUX_JOURNEYS_PASSWORD")
        if not email or not password:
            parser.error("real reads FLUX_JOURNEYS_EMAIL and FLUX_JOURNEYS_PASSWORD from the environment")
        sys.exit(real(args.origin, email, password, args.report))
    if not args.account or not args.state:
        parser.error("seed and exercise need --account and --state")
    account = json.loads(args.account.read_text(encoding="utf-8"))
    if args.mode == "seed":
        seed(args.origin, account, args.state)
    else:
        sys.exit(exercise(args.origin, account, args.state, args.ocr, args.report))


if __name__ == "__main__":
    main()
