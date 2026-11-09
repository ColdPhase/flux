"""An open tab follows what others change with no timer while the live stream is up (#862), including what sends no event.

Ada acts through the API; Kai (or Ada, for "Seen by") keeps a tab open and touches nothing: no focus, no reload, no move.
- A space's conversation shows a task unblocked by someone else (`project.work_updated.v1`).
- The Inbox count catches an item handled on another device, which sends this tab no event: its two-minute read stays while the
  stream is up (the page's clock is moved on, not waited for).
- "Seen by" stops naming someone once they can no longer read the space.
Runs through scripts/check_ui.sh; FLUX_UI_BROWSER selects chromium (default) or webkit.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UI_BROWSER, UPSTREAM, start_forwarder

PASSWORD = "an open tab follows along"
STAMP = int(time.time() * 1000)
PEOPLE = {"ada": ("Ada Kowalska", f"ada.live+{STAMP}@example.test"), "kai": ("Kai Tanaka", f"kai.live+{STAMP}@example.test")}


class LiveUpdates(unittest.TestCase):
    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=15000)
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            context.close()
        workspace = cls.call("ada", "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, 201)["id"]
        cls.call("ada", "POST", f"/api/v1/workspaces/{workspace}/members", {"email": PEOPLE["kai"][1], "role": "member"}, 201)
        cls.space = cls.call("ada", "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": "Garden sensors", "visibility": "restricted", "people": [cls.ids["kai"]]}, 201)["id"]
        cls.call("ada", "POST", f"/api/v1/projects/{cls.space}/conversations", {"body": "Kick-off: the sensor boards arrive Thursday.", "clientMessageId": str(uuid.uuid4())}, 201)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    @classmethod
    def call(cls, who: str, method: str, path: str, body: dict | None = None, expected: int = 200):
        context = cls.browser.new_context(service_workers="block", base_url=ORIGIN, storage_state=cls.states[who])
        try:
            headers = {"origin": ORIGIN, **({"content-type": "application/json"} if body is not None else {})}
            response = context.request.fetch(path, method=method, data=json.dumps(body) if body is not None else None, headers=headers)
            assert response.status == expected, f"{method} {path}: {response.status} {response.text()}"
            return response.json() if response.text() else {}
        finally:
            context.close()

    def page(self, who: str, clock: bool = False) -> Page:
        context = self.browser.new_context(service_workers="block", base_url=ORIGIN, viewport=DESKTOP, locale="en-GB", storage_state=self.states[who])
        self.addCleanup(context.close)
        page = context.new_page()
        if clock:
            page.clock.install()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def live(self, page: Page) -> None:
        """The stream is open and the page has settled: what follows reaches it by an event or not at all."""
        page.wait_for_timeout(3000)

    def test_01_a_conversation_shows_a_task_unblocked_by_someone_else(self) -> None:
        task = self.call("ada", "POST", f"/api/v1/projects/{self.space}/work", {"title": "Order the soil sensors", "status": "blocked", "blocker": "waiting for the supplier"}, 201)
        kai = self.page("kai")
        kai.goto(f"/projects/{self.space}")
        expect(kai.get_by_text("Kick-off: the sensor boards arrive Thursday.")).to_be_visible()
        self.live(kai)
        current = self.call("ada", "GET", f"/api/v1/work/{task['id']}")
        self.call("ada", "PATCH", f"/api/v1/work/{task['id']}", {"status": "in_progress", "expectedVersion": current["version"]})
        expect(kai.get_by_text(re.compile(rf"#{task['number']} unblocked")).first).to_be_visible()

    def test_02_the_inbox_count_catches_an_item_handled_on_another_device(self) -> None:
        self.call("ada", "POST", f"/api/v1/projects/{self.space}/conversations", {"body": "@Kai can you check the sensor list?", "clientMessageId": str(uuid.uuid4())}, 201)
        deadline = time.time() + 20
        while time.time() < deadline and not self.call("kai", "GET", "/api/v1/needs-you")["items"]:
            time.sleep(0.5)
        items = self.call("kai", "GET", "/api/v1/needs-you")["items"]
        self.assertTrue(items, "the mention waits for Kai")
        kai = self.page("kai", clock=True)
        kai.goto("/")
        inbox = kai.locator('a.side__item[href="/inbox"]')
        expect(inbox).to_have_attribute("aria-label", re.compile(rf"{len(items)} new"))
        self.live(kai)
        # Kai handles it on his phone: nothing tells this tab.
        for item in items:
            self.call("kai", "POST", f"/api/v1/needs-you/{item['key']}", {"action": "done"})
        kai.clock.run_for(125_000)
        expect(inbox).not_to_have_attribute("aria-label", re.compile(r"\d+ new"))

    def test_03_seen_by_stops_naming_someone_who_can_no_longer_read_the_space(self) -> None:
        mine = self.call("ada", "POST", f"/api/v1/projects/{self.space}/conversations", {"body": "I will wire the first prototype on Friday.", "clientMessageId": str(uuid.uuid4())}, 201)
        message = mine["messages"][0]["id"]
        ada = self.page("ada")
        ada.goto(f"/projects/{self.space}")
        expect(ada.locator(f"#message-{message}")).to_be_visible()
        self.live(ada)
        kai = self.page("kai")
        kai.goto(f"/projects/{self.space}")
        expect(kai.locator(f"#message-{message}")).to_be_in_viewport()
        seen = ada.locator(f"#message-{message} .message-seen")
        expect(seen).to_contain_text("Kai")
        kai.context.close()
        grant = next(g for g in self.call("ada", "GET", f"/api/v1/projects/{self.space}/grants") if g["principal"]["id"] == self.ids["kai"])
        self.call("ada", "DELETE", f"/api/v1/projects/{self.space}/grants/{grant['id']}", None, 204)
        expect(ada.locator(f"#message-{message} .message-seen", has_text="Kai")).to_have_count(0)
        self.call("ada", "POST", f"/api/v1/projects/{self.space}/grants", {"principal": {"kind": "human", "id": self.ids["kai"]}, "role": "contributor"}, 201)


if __name__ == "__main__":
    unittest.main()
