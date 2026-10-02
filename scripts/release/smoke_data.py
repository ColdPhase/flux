#!/usr/bin/env python3
"""Exercise real account/workspace persistence from the packaged release."""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import secrets
import urllib.error
import urllib.request
from pathlib import Path


def request(
    opener: urllib.request.OpenerDirector, origin: str, method: str,
    path: str, body: dict[str, str] | None = None,
) -> tuple[int, dict[str, object]]:
    encoded = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        origin + path, data=encoded, method=method,
        headers={"Origin": origin, "Content-Type": "application/json"},
    )
    try:
        with opener.open(req, timeout=15) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"{method} {path} returned {error.code}: {error.read()[:400]!r}") from error


def run(mode: str, origin: str, state_file: Path) -> None:
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    if mode == "seed":
        if state_file.exists():
            raise ValueError("refusing to replace existing smoke state")
        email = f"release-{secrets.token_hex(8)}@example.test"
        password = secrets.token_urlsafe(32)
        status, _ = request(opener, origin, "POST", "/api/auth/sign-up/email", {
            "email": email, "password": password, "name": "Release smoke user",
        })
        if status != 200:
            raise RuntimeError(f"sign-up returned {status}")
        status, workspace = request(opener, origin, "POST", "/api/v1/workspaces", {
            "name": "Release restore probe",
        })
        if status != 201 or not isinstance(workspace.get("id"), str):
            raise RuntimeError(f"workspace creation returned {status}: {workspace!r}")
        state_file.write_text(json.dumps({
            "email": email, "password": password, "workspace_id": workspace["id"],
        }), encoding="utf-8")
        state_file.chmod(0o600)
        print("Release account and workspace created")
        return
    state = json.loads(state_file.read_text(encoding="utf-8"))
    status, _ = request(opener, origin, "POST", "/api/auth/sign-in/email", {
        "email": state["email"], "password": state["password"],
    })
    if status != 200:
        raise RuntimeError(f"restored account sign-in returned {status}")
    status, workspace = request(
        opener, origin, "GET", f"/api/v1/workspaces/{state['workspace_id']}"
    )
    if status != 200 or workspace.get("name") != "Release restore probe":
        raise RuntimeError(f"restored workspace mismatch: {status}: {workspace!r}")
    print("Restored account and workspace verified")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("seed", "verify"))
    parser.add_argument("--origin", required=True)
    parser.add_argument("--state", type=Path, required=True)
    args = parser.parse_args()
    run(args.mode, args.origin, args.state)


if __name__ == "__main__":
    main()
