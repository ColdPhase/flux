#!/usr/bin/env python3
"""Cold first visits and the move into a space, in Chromium, for scripts/perf_compare.sh.

Signs in as the perf seed's owner once, then LOADS times: a fresh browser context (empty cache, no service worker yet) with only
the session cookie opens the app's root and waits until Home is usable (the heading "Home" and the seeded space in the Spaces
navigation); then, in the same tab, it clicks that space and waits until its Conversation shows the seed's threads.

Per load it records:
- the time from navigation start to a usable Home, and the JS and CSS bytes on the wire (encoded body) before that moment and in
  all until the page was quiet (the service worker's precache included);
- for the move into the space: the API requests from the click until 0.9 s without one (the live stream not counted, as
  app/tests/ui/test_navigation_requests.py counts them), the database statements meanwhile (pg_stat_statements of the stack's
  database, reset at the click; the worker is stopped) and the time until the Conversation's first thread is visible.

The caller runs it on the client CPUs (taskset), so the browser never takes the server's. Output: one JSON file (--out).
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import time

from playwright.sync_api import sync_playwright

SPACE = "Community garden sensors"
EMAIL = "ada@perf.flux.test"
THREAD = re.compile(r"Thread \d+: what should we decide about")
STATEMENTS = ("SELECT coalesce(sum(calls), 0) FROM pg_stat_statements WHERE query NOT ILIKE '%pg_stat_statements%' "
              "AND query NOT ILIKE '%pgboss%'")


def psql(container: str, sql: str) -> str:
    return subprocess.run(["docker", "exec", container, "psql", "-U", "flux", "-d", "flux", "-tA", "-c", sql],
                          check=True, capture_output=True, text=True).stdout.strip()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--origin", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("--db-container", required=True)
    parser.add_argument("--loads", type=int, default=3)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    origin = args.origin
    results = {"loads": [], "errors": []}
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        results["browser"] = browser.version
        first = browser.new_context()
        signed = first.request.post(f"{origin}/api/auth/sign-in/email", headers={"origin": origin},
                                    data={"email": EMAIL, "password": args.password})
        if signed.status != 200:
            raise SystemExit(f"sign-in answered {signed.status}")
        state = first.storage_state()
        first.close()
        for index in range(args.loads + 1):  # the first load warms the server's caches and is not kept
            context = browser.new_context(storage_state=state, viewport={"width": 1440, "height": 900}, locale="en-GB")
            page = context.new_page()
            finished: list[tuple[float, str, str, int]] = []

            def on_finished(request) -> None:
                try:
                    size = request.sizes()["responseBodySize"]
                except Exception:  # noqa: BLE001 - a request the page dropped has no sizes
                    size = 0
                finished.append((time.monotonic(), request.resource_type, request.url, size))

            page.on("requestfinished", on_finished)
            try:
                page.goto(f"{origin}/", wait_until="commit")
                page.get_by_role("heading", level=1, name="Home").wait_for(state="visible", timeout=60000)
                space = page.get_by_role("navigation", name="Spaces").get_by_role("link", name=re.compile(f"^{SPACE}"))
                space.wait_for(state="visible", timeout=60000)
                usable_at = time.monotonic()
                usable_ms = page.evaluate("performance.now()")
                page.wait_for_load_state("networkidle", timeout=60000)
                page.wait_for_timeout(1500)
                code = lambda rows: sum(size for _, kind, _, size in rows if kind in ("script", "stylesheet"))  # noqa: E731
                before = [row for row in finished if row[0] <= usable_at]
                load = {"usableMs": round(usable_ms, 1), "codeBytesBeforeUsable": code(before), "codeFilesBeforeUsable":
                        sum(1 for _, kind, _, _ in before if kind in ("script", "stylesheet")),
                        "codeBytesUntilQuiet": code(finished), "allBytesUntilQuiet": sum(size for *_, size in finished),
                        "requestsBeforeUsable": len(before)}

                # The move into the space's Conversation.
                seen: list[str] = []
                last = [time.monotonic()]

                def on_request(request) -> None:
                    path = request.url.removeprefix(origin)
                    if path.startswith("/api/") and not path.startswith("/api/v1/stream"):
                        seen.append(f"{request.method} {re.sub(r'[0-9a-f]{8}-[0-9a-f-]{27}', ':id', re.sub(r'[?].*', '', path)).removeprefix('/api/v1/')}")
                        last[0] = time.monotonic()

                psql(args.db_container, "SELECT pg_stat_statements_reset()")
                page.on("request", on_request)
                clicked = time.monotonic()
                last[0] = clicked
                space.click()
                page.get_by_text(THREAD).first.wait_for(state="visible", timeout=60000)
                shown = time.monotonic()
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline and time.monotonic() - last[0] < 0.9:
                    page.wait_for_timeout(50)
                page.wait_for_timeout(200)
                page.remove_listener("request", on_request)
                load.update({"openMs": round((shown - clicked) * 1000, 1), "openRequests": len(seen), "openAddresses": sorted(seen),
                             "openStatements": int(psql(args.db_container, STATEMENTS) or 0)})
                if index:
                    results["loads"].append(load)
                print(json.dumps(load), flush=True)
            except Exception as error:  # noqa: BLE001 - recorded, the next load still runs
                results["errors"].append(f"load {index}: {error}"[:600])
                print(f"load {index} failed: {error}", flush=True)
            finally:
                context.close()
        browser.close()
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(results, handle, indent=1)


if __name__ == "__main__":
    main()
