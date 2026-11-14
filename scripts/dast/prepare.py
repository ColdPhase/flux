#!/usr/bin/env python3
"""Prepares an authenticated ZAP scan of the running stack (#838): two signed-in people, the API described as OpenAPI, real ids.

    prepare.py --api http://127.0.0.1:18599 --origin http://api:8080 --server http://api:8080 --fixture-token T --out DIR
               --person ada=ada@demo.flux.test:PASSWORD --person jonas=jonas@demo.flux.test:PASSWORD

Writes into DIR: `cookie-<name>` (the session cookie, one `name=value` line, for ZAP's replacer rule), `openapi.json` (every route
the test deployment lists, with its body and query schemas, and the ids of the seeded data as examples) and `routes.json`. The first
person also sets a profile photo and sends an HTML file and a video in the first space, so the picture, file, preview, video, message
and receipt routes are scanned with ids that exist, and keeps a second video staged (unsent) so the poster route has its own video. The
preview carries the frame headers it needs, a file and a video read a byte range, and the photo, space icon, file and poster uploads raw
bytes.
Standard library only. The route listing exists only in a test deployment (`GET /api/v1/test/routes` with the fixture bearer).
"""
import argparse
import http.cookiejar
import json
import re
import struct
import sys
import urllib.error
import urllib.request
import uuid
import zlib
from pathlib import Path

# Never scanned: ending the scan's own session, the test deployment's own routes, and the long-lived streams.
SKIP = (
    re.compile(r"^/api/v1/test/"),
    re.compile(r"^/api/v1/stream"),
    re.compile(r"^/api/v1/editing"),
    re.compile(r"^/api/v1/sessions(/|$)"),
)
# Better Auth's own routes are one catch-all in the listing: the ones worth scanning, described by hand.
AUTH_ROUTES = (
    ("POST", "/api/auth/sign-in/email", {"type": "object", "required": ["email", "password"], "properties": {"email": {"type": "string"}, "password": {"type": "string"}}}),
    ("POST", "/api/auth/sign-up/email", {"type": "object", "required": ["email", "password", "name"], "properties": {"email": {"type": "string"}, "password": {"type": "string"}, "name": {"type": "string"}}}),
    ("GET", "/api/auth/get-session", None),
    ("POST", "/api/auth/request-password-reset", {"type": "object", "required": ["email"], "properties": {"email": {"type": "string"}}}),
    # A reset link's page sends the token and the new password here (#1471); the scan has no valid token, so it attacks the refusal paths.
    ("POST", "/api/auth/reset-password", {"type": "object", "required": ["token", "newPassword"], "properties": {"token": {"type": "string"}, "newPassword": {"type": "string"}}}),
)
# Which list answers an id parameter's name (workspace and project first), and where in the answer the id is.
LISTS = {
    "workspaceId": "/api/v1/workspaces", "workspace": "/api/v1/workspaces",
    "projectId": "/api/v1/workspaces/{workspaceId}/projects",
    "workId": "/api/v1/projects/{projectId}/work", "taskId": "/api/v1/projects/{projectId}/work",
    "docId": "/api/v1/projects/{projectId}/docs", "decisionId": "/api/v1/projects/{projectId}/decisions",
    "conversationId": "/api/v1/projects/{projectId}/conversations",
    "materialId": "/api/v1/projects/{projectId}/materials", "sketchId": "/api/v1/workspaces/{workspaceId}/sketches",
    "dmId": "/api/v1/workspaces/{workspaceId}/dms", "draftId": "/api/v1/workspaces/{workspaceId}/drafts",
    "agentId": "/api/v1/workspaces/{workspaceId}/agents",
}
UUID = "00000000-0000-4000-8000-000000000000"
# Routes whose body is raw bytes, not JSON, described as such so the scan sends bytes there: a profile photo (F-039), a space's icon
# picture (F-040; the same route also takes JSON `{ emoji }`) and a file upload.
RAW_BODY_ROUTES = {("PUT", "/api/v1/me/photo"): "image/png", ("PUT", "/api/v1/projects/:projectId/icon"): "image/png",
                   ("POST", "/api/v1/projects/:projectId/files"): "application/octet-stream",
                   ("POST", "/api/v1/projects/:projectId/files/:fileId/poster"): "application/octet-stream",
                   # A direct message's and an agent chat's files are staged the same way (#1438 point 10, #1448, #1464).
                   ("POST", "/api/v1/dms/:dmId/files"): "application/octet-stream",
                   ("POST", "/api/v1/dms/:dmId/files/:fileId/poster"): "application/octet-stream",
                   ("POST", "/api/v1/my-agents/:agentId/files"): "application/octet-stream",
                   ("POST", "/api/v1/my-agents/:agentId/files/:fileId/poster"): "application/octet-stream"}
# Request headers a route needs before its handler runs, with the value a browser sends: a file preview answers only a frame of a Flux
# page (C-60), so without them every request of the scan would stop at the same 403.
# A stored file and a video are read whole or by one byte range (C-61, #1352): the scan sends a range, so the range parser is attacked too.
HEADER_PARAMETERS = {("GET", "/api/v1/files/:fileId/preview"): {"Sec-Fetch-Dest": "iframe", "Sec-Fetch-Site": "same-origin"},
                     ("GET", "/api/v1/files/:fileId"): {"Range": "bytes=0-99"},
                     ("GET", "/api/v1/files/:fileId/video"): {"Range": "bytes=0-99"}}
# A previewable page, sent in the first space so the file, preview, message and receipt routes are scanned with ids that exist.
PREVIEW_PAGE = b"<!doctype html><title>DAST</title><h1>Gateway range report</h1><p>Signal at the far east bed.</p>"
# A real MP4 (the browser tests' fixture): a file is a video only by its container (C-61), so the video and poster routes need one.
VIDEO_CLIP = Path(__file__).resolve().parents[2] / "app/tests/ui/fixtures/video/clip.mp4"


def small_png():
    """A 4 × 4 PNG, written by hand: the photo the first person sets, so the picture route has a real id to scan."""
    chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)  # noqa: E731
    raw = b"".join(b"\x00" + bytes((40, 150, 140)) * 4 for _ in range(4))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def seeded_file(person, project_id):
    """An HTML file sent with a new message in the space: its file, message and conversation ids (empty when there is no space)."""
    if not project_id:
        return {}
    status, staged = person.call("POST", f"/api/v1/projects/{project_id}/files?uploadId={uuid.uuid4()}&name=range-report.html", PREVIEW_PAGE)
    if status != 201 or not isinstance(staged, dict):
        sys.exit(f"dast: the preview file could not be uploaded (answered {status})")
    status, started = person.call("POST", f"/api/v1/projects/{project_id}/conversations",
                                  {"body": "Range report", "attachmentIds": [staged["id"]], "clientMessageId": str(uuid.uuid4())})
    if status not in (200, 201) or not isinstance(started, dict):
        sys.exit(f"dast: the message with the preview file could not be sent (answered {status})")
    return {"fileId": staged["id"], "messageId": started["messages"][0]["id"], "conversationId": started["id"]}


def seeded_videos(person, project_id):
    """A video sent in the space (for `/files/:fileId/video`) and one left staged (for `/files/:fileId/poster`, which takes only the
    caller's own unsent video), as per-route examples by url. Empty when there is no space."""
    if not project_id:
        return {}
    clip = VIDEO_CLIP.read_bytes()
    ids = []
    for name in ("night-round.mp4", "staged-round.mp4"):
        status, staged = person.call("POST", f"/api/v1/projects/{project_id}/files?uploadId={uuid.uuid4()}&name={name}", clip)
        if status != 201 or not isinstance(staged, dict) or not staged.get("video"):
            sys.exit(f"dast: the video could not be uploaded (answered {status})")
        ids.append(staged["id"])
    status, _ = person.call("POST", f"/api/v1/projects/{project_id}/conversations",
                            {"body": "Night round", "attachmentIds": [ids[0]], "clientMessageId": str(uuid.uuid4())})
    if status not in (200, 201):
        sys.exit(f"dast: the message with the video could not be sent (answered {status})")
    return {"/api/v1/files/:fileId/video": {"fileId": ids[0]},
            "/api/v1/projects/:projectId/files/:fileId/poster": {"projectId": project_id, "fileId": ids[1]}}


class Person:
    """A signed-in session: the cookie jar of a real sign-in through the public API."""

    def __init__(self, api, origin, name, email, password):
        self.api, self.origin, self.name = api.rstrip("/"), origin, name
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        status, _ = self.call("POST", "/api/auth/sign-in/email", {"email": email, "password": password})
        if status != 200:
            sys.exit(f"dast: {email} could not sign in (answered {status})")

    def call(self, method, path, body=None, headers=None):
        raw = isinstance(body, bytes)
        data = None if body is None else body if raw else json.dumps(body).encode()
        kind = {"content-type": "application/octet-stream" if raw else "application/json"} if body is not None else {}
        request = urllib.request.Request(self.api + path, data=data, method=method, headers={"origin": self.origin, **kind, **(headers or {})})
        try:
            with self.opener.open(request, timeout=30) as response:
                text = response.read().decode("utf-8", "replace")
                return response.status, (json.loads(text) if text.strip().startswith(("{", "[")) else text)
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode("utf-8", "replace")

    def cookie(self):
        """`name=value;name=value` with no spaces, for a ZAP option string."""
        pairs = [f"{cookie.name}={cookie.value}" for cookie in self.jar]
        if not pairs:
            sys.exit(f"dast: {self.name} has no session cookie after signing in")
        return ";".join(pairs)


def first_id(answer):
    items = answer.get("items") if isinstance(answer, dict) else answer
    if isinstance(items, list):
        for item in items:
            if isinstance(item, dict) and isinstance(item.get("id"), str):
                return item["id"]
    return None


def seeded_ids(person, names):
    """Real ids of the demo data for the parameters the routes use; the rest keep a well-formed id that exists nowhere."""
    found = {}
    for name in ("workspaceId", "projectId"):
        found[name] = first_id(person.call("GET", LISTS[name].format(**found))[1]) if name in names or name == "workspaceId" else None
    found["workspace"] = found["workspaceId"]
    for name, path in LISTS.items():
        if name in found or name not in names:
            continue
        try:
            found[name] = first_id(person.call("GET", path.format(**found))[1])
        except KeyError:
            found[name] = None
    return {name: value for name, value in found.items() if value}


def schema_of(raw):
    """A route's JSON schema as OpenAPI 3.0: a type list with null becomes `nullable`, unknown keywords are dropped."""
    if not isinstance(raw, dict):
        return {}
    out = {}
    kind = raw.get("type")
    if isinstance(kind, list):
        kinds = [item for item in kind if item != "null"]
        kind = kinds[0] if kinds else "string"
        if "null" in raw["type"]:
            out["nullable"] = True
    if isinstance(kind, str):
        out["type"] = kind
    for key in ("enum", "format", "pattern", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "required", "default"):
        if key in raw and not (key == "format" and raw[key] not in ("uuid", "date", "date-time", "email", "uri", "int32", "int64", "float", "double", "byte", "binary", "password")):
            out[key] = raw[key]
    if isinstance(raw.get("properties"), dict):
        out["type"] = "object"
        out["properties"] = {name: schema_of(value) for name, value in raw["properties"].items()}
        if raw.get("additionalProperties") is False:
            out["additionalProperties"] = False
    if "items" in raw:
        out["type"] = "array"
        out["items"] = schema_of(raw["items"])
    for key in ("anyOf", "oneOf"):
        if isinstance(raw.get(key), list) and raw[key]:
            pick = next((item for item in raw[key] if isinstance(item, dict) and item.get("type") != "null"), raw[key][0])
            out.update(schema_of(pick))
            if any(isinstance(item, dict) and item.get("type") == "null" for item in raw[key]):
                out["nullable"] = True
    if out.get("type") == "object" and "properties" not in out:
        out["additionalProperties"] = True
    return out or {"type": "string"}


def openapi(routes, server, ids, only=None, examples=None):
    """An OpenAPI 3.0 document of the listed routes. `ids` give the path parameters their real values as examples, and `examples` one
    route's own (by its url). `only`, a regular expression, keeps the paths it matches (a scan of one change's routes)."""
    paths = {}
    wanted = [(route["method"], route["url"], route.get("body"), route.get("query")) for route in routes
              if route["url"].startswith("/api/") and not any(skip.match(route["url"]) for skip in SKIP)]
    wanted += [(method, url, body, None) for method, url, body in AUTH_ROUTES]
    for method, url, body, query in wanted:
        if method in ("HEAD", "OPTIONS") or (only and not re.search(only, url)):
            continue
        parameters = []
        for name in re.findall(r":(\w+)", url):
            example = (examples or {}).get(url, {}).get(name, ids.get(name, UUID))
            parameters.append({"name": name, "in": "path", "required": True, "schema": {"type": "string"}, "example": example})
        path = re.sub(r":(\w+)", r"{\1}", url)
        if isinstance(query, dict):
            required = set(query.get("required") or [])
            for name, value in (query.get("properties") or {}).items():
                parameters.append({"name": name, "in": "query", "required": name in required, "schema": schema_of(value)})
        for name, value in HEADER_PARAMETERS.get((method, url), {}).items():
            parameters.append({"name": name, "in": "header", "required": True, "schema": {"type": "string", "default": value}, "example": value})
        operation = {"operationId": f"{method.lower()}_{re.sub(r'[^A-Za-z0-9]+', '_', path).strip('_')}", "parameters": parameters,
                     "responses": {"default": {"description": "Whatever the API answers"}}}
        if (method, url) in RAW_BODY_ROUTES:
            operation["requestBody"] = {"required": True, "content": {RAW_BODY_ROUTES[(method, url)]: {"schema": {"type": "string", "format": "binary"}}}}
        elif isinstance(body, dict) and method in ("POST", "PUT", "PATCH", "DELETE"):
            operation["requestBody"] = {"required": bool(body.get("required")), "content": {"application/json": {"schema": schema_of(body)}}}
        paths.setdefault(path, {})[method.lower()] = operation
    return {"openapi": "3.0.3", "info": {"title": "Flux API (from the test deployment's route listing)", "version": "dast"},
            "servers": [{"url": server}], "paths": paths}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--api", required=True, help="where this script reaches the API (the published loopback port)")
    parser.add_argument("--origin", required=True, help="the API's public origin (the Origin header every state-changing call needs)")
    parser.add_argument("--server", required=True, help="where ZAP reaches the API (the OpenAPI server URL)")
    parser.add_argument("--fixture-token", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--person", action="append", required=True, metavar="NAME=EMAIL:PASSWORD")
    parser.add_argument("--only", default="", help="a regular expression: describe only the API paths it matches")
    args = parser.parse_args()
    people = []
    for spec in args.person:
        name, _, rest = spec.partition("=")
        email, _, password = rest.partition(":")
        people.append(Person(args.api, args.origin, name, email, password))
    first = people[0]
    status, listing = first.call("GET", "/api/v1/test/routes", headers={"authorization": f"Bearer {args.fixture_token}"})
    routes = listing.get("routes") if isinstance(listing, dict) else None
    if status != 200 or not routes:
        sys.exit(f"dast: the route listing is unavailable (answered {status}); the stack must be a test deployment")
    names = {name for route in routes for name in re.findall(r":(\w+)", route["url"])}
    ids = seeded_ids(first, names)
    for person in people:
        with open(f"{args.out}/cookie-{person.name}", "w", encoding="utf-8") as handle:
            handle.write(person.cookie())
    ids.update(seeded_file(first, ids.get("projectId")))
    ids["userId"] = (people[1] if len(people) > 1 else first).call("GET", "/api/v1/me")[1].get("user", {}).get("id", UUID)
    # A real photo, so the picture route is scanned with an id that exists (F-039); the second person can see the first's.
    examples = seeded_videos(first, ids.get("projectId"))
    status, photo = first.call("PUT", "/api/v1/me/photo", small_png())
    if status == 200 and isinstance(photo, dict):
        examples["/api/v1/pictures/:pictureId/:size"] = {"pictureId": photo["photo"], "size": "128"}
    document = openapi(routes, args.server, ids, args.only or None, examples)
    with open(f"{args.out}/openapi.json", "w", encoding="utf-8") as handle:
        json.dump(document, handle, indent=1)
    with open(f"{args.out}/routes.json", "w", encoding="utf-8") as handle:
        json.dump({"routes": len(routes), "operations": sum(len(item) for item in document["paths"].values()), "ids": sorted(ids)}, handle)
    print(f"dast: {len(routes)} routes listed, {sum(len(item) for item in document['paths'].values())} operations described, "
          f"{len(ids)} seeded ids found, {len(people)} people signed in")


if __name__ == "__main__":
    main()
