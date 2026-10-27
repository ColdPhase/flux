"""An agent's MCP suggestion in the Inbox (#661): the card shows what it saw, what it makes of it, what it
suggests and the source; Got it and Decline store the person's choice. The queue read is served with one
suggestion item (the server side is covered by tests/app/needs-you-agent-proposals.test.ts)."""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, start_forwarder

KEY = f"proposal:{uuid.uuid4()}"
ITEM = {
    "key": KEY, "kind": "question", "title": "Desk agent suggests: Compare sensor B", "detail": "Sensor A failed in dim scenes",
    "project": {"id": str(uuid.uuid4()), "name": "Community garden sensors"}, "from": {"kind": "agent", "id": str(uuid.uuid4()), "name": "Desk agent"},
    "at": "2026-10-27T09:00:00.000Z", "url": "/projects/x/agents", "decision": None, "blocked": None, "reason": "question", "snoozeTask": None,
    "proposal": {"id": str(uuid.uuid4()), "fact": "Sensor A failed in dim scenes", "interpretation": "Exposure may be too short",
                 "suggestedAction": "Compare sensor B", "source": {"materialId": str(uuid.uuid4()), "title": "Low light", "version": 1}},
}


class InboxAgentSuggestion(unittest.TestCase):
    pw = None
    browser: Browser
    state: dict

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=15000)
        context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
        email = f"ada.s+{int(time.time() * 1000)}@example.test"
        response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": "a calm inbox for the garden", "name": "Ada Kowalska"}, headers={"origin": ORIGIN})
        assert response.status == 200, response.text()
        cls.state = context.storage_state()
        context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def open(self, phone: bool) -> tuple[Page, list[dict]]:
        options: dict = {"base_url": ORIGIN, "storage_state": self.state, "service_workers": "block"}
        options.update(viewport=PHONE, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        resolved: list[dict] = []

        def on_item(route):
            if route.request.method == "POST":
                resolved.append(json.loads(route.request.post_data or "{}"))
                route.fulfill(status=200, content_type="application/json", body=json.dumps({"key": KEY, "state": "done", "until": None, "untilWorkId": None}))
            else:
                route.fulfill(status=204, body="")

        def on_queue(route):
            items = [] if resolved else [ITEM]
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"items": items, "count": len(items), "later": 0, "doneToday": 0}))

        page.route(re.compile(r"/api/v1/needs-you/[^?]+$"), on_item)
        page.route(re.compile(r"/api/v1/needs-you(\?.*)?$"), on_queue)
        return page, resolved

    def check(self, phone: bool, choice: str, action: str) -> None:
        page, resolved = self.open(phone)
        page.goto("/inbox")
        card = page.locator(f'[data-key="{KEY}"]')
        expect(card.get_by_test_id("agent-suggestion")).to_contain_text("Sensor A failed in dim scenes")
        expect(card.get_by_test_id("agent-suggestion")).to_contain_text("Exposure may be too short")
        expect(card.get_by_test_id("agent-suggestion")).to_contain_text("Compare sensor B")
        expect(card.get_by_test_id("agent-suggestion")).to_contain_text("Low light (version 1)")
        card.get_by_role("button", name=choice, exact=True).click()
        expect(card).to_have_count(0)
        self.assertEqual(resolved, [{"action": action}])

    def test_desktop_got_it(self) -> None:
        self.check(False, "Got it", "done")

    def test_desktop_decline(self) -> None:
        self.check(False, "Decline", "decline")

    def test_phone_got_it(self) -> None:
        self.check(True, "Got it", "done")


if __name__ == "__main__":
    unittest.main()
