#!/usr/bin/env python3
"""A short browser pass over the main screens of an UPGRADED instance, on the old rows that smoke_journeys.py seeded (founder request,
Hubert, 2026-11-20). It runs in the pinned Playwright image of the UI tests (docker/ui-tests.Dockerfile), on the host network:

  docker run --rm --network host -v <state dir>:/state:ro,z -v <this file>:/check.py:ro,z -v <shots>:/shots:z <ui-tests image> \
      python3 /check.py --origin http://127.0.0.1:<port> --account /state/account.json --state /state/journeys.json --shots /shots

Signed in as the owner, at computer and phone width, it opens Home, the Inbox, the old thread, the old direct message, the old Wiki page,
the old map and the space's tasks, and checks that each shows the old content it must show and no error page ("Something went wrong",
"Page not found"), and that no page threw a script error. A screenshot of each lands in --shots. It writes nothing.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ERRORS = ("Something went wrong", "Page not found", "This page could not be opened")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--origin", required=True)
    parser.add_argument("--account", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--shots", type=Path, required=True)
    args = parser.parse_args()
    account = json.loads(args.account.read_text())
    s = json.loads(args.state.read_text())
    tag, sid = s["tag"], s["space_id"]
    screens = [
        ("home", "/", None),
        ("inbox", "/inbox", "Ben Member"),
        ("thread", f"/projects/{sid}/conversations/{s['thread']['id']}", f"journeyrita{tag}"),
        ("files", f"/projects/{sid}/conversations/{s['files']['conversation']}", "skan-faktury.pdf"),
        ("dm", f"/dm/{s['dm']['id']}", f"journeydm{tag}"),
        ("wiki", f"/projects/{sid}/docs/{s['wiki']['id']}", s["wiki"]["title"]),
        ("map", f"/projects/{sid}/map/{s['map']['id']}", "Seedlings"),
        ("tasks", f"/projects/{sid}/tasks", f"journeytaskopen{tag}"),
    ]
    failures: list[str] = []
    args.shots.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width, height, label in ((1440, 900, "computer"), (390, 844, "phone")):
            context = browser.new_context(viewport={"width": width, "height": height}, base_url=args.origin)
            signed = context.request.post("/api/auth/sign-in/email", data={"email": account["email"], "password": account["password"]},
                                          headers={"Origin": args.origin})
            if signed.status != 200:
                print(f"FAIL sign-in answered {signed.status}")
                return 1
            page = context.new_page()
            script_errors: list[str] = []
            page.on("pageerror", lambda error: script_errors.append(str(error)[:200]))
            for name, path, expect in screens:
                before = len(script_errors)
                page.goto(path, wait_until="domcontentloaded")
                try:
                    page.wait_for_load_state("networkidle", timeout=15_000)
                except Exception:  # noqa: BLE001 - the stream keeps a request open; the text checks below decide
                    pass
                problem = ""
                if expect:
                    try:
                        page.get_by_text(expect, exact=False).first.wait_for(state="attached", timeout=15_000)
                    except Exception:  # noqa: BLE001
                        problem = f"does not show {expect!r}"
                body = page.inner_text("body")
                shown = [e for e in ERRORS if e in body]
                if shown:
                    problem = f"shows {shown!r}"
                if len(script_errors) > before:
                    problem = (problem + "; " if problem else "") + f"script error {script_errors[before]!r}"
                page.screenshot(path=str(args.shots / f"{label}-{name}.png"), full_page=False)
                print(f"  {'FAIL' if problem else 'PASS'}  {label} {name}{(' - ' + problem) if problem else ''}", flush=True)
                if problem:
                    failures.append(f"{label} {name}: {problem}")
            context.close()
        browser.close()
    print(f"browser pass: {2 * len(screens) - len(failures)} PASS, {len(failures)} FAIL; screenshots in {args.shots}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
