"""The live stream carries the page's own session on every connection, in Chromium and WebKit (#1313).

Seen once in WebKit CI: a page's stream WebSocket got 401 on every reconnect while the same person's HTTP reads were 200. The server reads the
session for an upgrade with the same function as for any request (tests/app/session-fast-path.test.ts checks the two agree in every state), so
what is left to watch is the browser: does each upgrade the page makes arrive with the page's session cookie, again and again, while the page reads
and listens at the same time? These tests make the page connect many times and keep it busy, and fail with what the sockets and the page did.
Runs through scripts/check_ui.sh against the running app; FLUX_UI_BROWSER selects chromium (default) or webkit.
"""

from __future__ import annotations

import os
import time
import unittest
import uuid

from playwright.sync_api import BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UPSTREAM, start_forwarder
from test_work_pagination import api

PASSWORD = "a stream that knows who you are"
UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")
RECONNECTS = 40
EVENTS = 25


class Sockets:
    """The stream sockets a page opened: what each one received and whether it closed. A refused upgrade is a socket that closed before its
    first frame (the browser cannot read the status of a refused upgrade; the server's first frame is `ready`)."""

    def __init__(self, page: Page) -> None:
        self.page = page
        self.records: list[dict] = []
        self.started = time.monotonic()
        page.on("websocket", self.add)

    def add(self, socket) -> None:
        record = {"url": socket.url, "frames": 0, "closed": False, "at": time.monotonic() - self.started}
        socket.on("framereceived", lambda _payload: record.__setitem__("frames", record["frames"] + 1))
        socket.on("close", lambda _socket: record.__setitem__("closed", True))
        self.records.append(record)

    def refused(self) -> list[dict]:
        return [record for record in self.records if record["closed"] and not record["frames"]]

    def say(self) -> str:
        return "sockets: " + "; ".join(f"#{i} at {r['at']:.1f}s frames={r['frames']} closed={r['closed']}" for i, r in enumerate(self.records[-12:]))


class StreamSession(unittest.TestCase):
    pw = None
    browser = None
    ada: BrowserContext

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        assert cls.browser.browser_type.name == UI_BROWSER
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}", flush=True)
        expect.set_options(timeout=10000)
        cls.ada = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
        api(cls.ada, "POST", "/api/auth/sign-up/email", {"name": "Ada Kowalska", "email": f"stream-ada-{uuid.uuid4().hex[:8]}@example.test", "password": PASSWORD})
        workspace = api(cls.ada, "POST", "/api/v1/workspaces", {"name": "Stream works"}, 201)["id"]
        cls.project = api(cls.ada, "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": "Sockets and cookies", "visibility": "restricted"}, 201)["id"]
        cls.root = f"/api/v1/projects/{cls.project}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.ada.close()
        cls.browser.close()
        cls.pw.stop()

    def page(self) -> tuple[Page, Sockets]:
        """A page in a context of its own, signed in by a copy of the person's cookies (as the other modules do)."""
        context = self.browser.new_context(base_url=ORIGIN, storage_state=self.ada.storage_state(), viewport=DESKTOP, service_workers="block")
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page, Sockets(page)

    def until(self, page: Page, sockets: Sockets, check, what: str, seconds: float = 8) -> None:
        """Waits (letting the page's events run) until `check()` holds, else fails with what the sockets did."""
        deadline = time.monotonic() + seconds
        while not check():
            if time.monotonic() > deadline:
                cookies = ", ".join(f"{c['name']}@{c['domain']}" for c in page.context.cookies())
                self.fail(f"timed out waiting for {what}\n{sockets.say()}\ncookies: {cookies}")
            page.wait_for_timeout(40)

    def test_01_every_reconnect_of_the_stream_arrives_with_the_pages_session(self) -> None:
        page, sockets = self.page()
        page.goto(f"/projects/{self.project}")
        expect(page.locator("header.top").get_by_role("tab", name="Conversation")).to_be_visible()
        self.until(page, sockets, lambda: any(record["frames"] for record in sockets.records), "the first socket's ready frame")
        for attempt in range(RECONNECTS):
            before = len(sockets.records)
            # The browser coming back online makes the page open its stream again now, from its last cursor.
            page.evaluate("window.dispatchEvent(new Event('online'))")
            self.until(page, sockets, lambda: len(sockets.records) > before and sockets.records[-1]["frames"] >= 1, f"reconnect {attempt + 1} to be accepted")
        self.assertEqual(sockets.refused(), [], f"no upgrade was refused\n{sockets.say()}")
        # The same page's own HTTP read agrees with the stream.
        self.assertEqual(page.evaluate("fetch('/api/v1/me', { credentials: 'same-origin' }).then((response) => response.status)"), 200)

    def test_02_events_arrive_over_the_stream_while_the_page_reads_what_they_changed(self) -> None:
        page, sockets = self.page()
        page.goto(f"/projects/{self.project}/tasks")
        expect(page.locator("header.top").get_by_role("tab", name="Tasks")).to_be_visible()
        self.until(page, sockets, lambda: any(record["frames"] for record in sockets.records), "the first socket's ready frame")
        for number in range(EVENTS):
            title = f"Socket soak {number + 1:02d}"
            count, frames = len(sockets.records), sockets.records[-1]["frames"]
            api(self.ada, "POST", self.root + "/work", {"title": title}, 201)
            # The event reaches the page over its stream (not by a timer): a frame on the open socket, or the ready of a new one.
            self.until(page, sockets, lambda: len(sockets.records) > count or sockets.records[-1]["frames"] > frames, f"the event of {title} over the stream")
            expect(page.get_by_text(title, exact=True).first).to_be_visible()
        self.assertEqual(sockets.refused(), [], f"no upgrade was refused\n{sockets.say()}")
        self.assertFalse(sockets.records[-1]["closed"], f"the page still listens\n{sockets.say()}")


if __name__ == "__main__":
    unittest.main()
