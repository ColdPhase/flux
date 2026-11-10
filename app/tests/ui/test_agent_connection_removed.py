"""Browser test: removing a connection pauses only the agents that use it (C-3, docs/product/decisions.md).

Runs with the other tests/ui journeys through scripts/check_ui.sh, on the TEST-ONLY mock provider (`FLUX_TEST_PERSONAL_RUNS=anthropic-mock`): the
real worker sends runs through the real Anthropic adapter to `tests/ui/anthropic_mock.py`. Nothing here calls a model.

In the v0.2 release acceptance (J12 at c2ae8d813) Ada replaced her AI connection: Assistant (her first agent, which answers `/ai`) lost its model
and waited, as C-3 says, but so did the private chat of Planner, made on the new connection: it read Assistant's status and refused to send
("The connection your assistant's model belonged to was removed") although the server would have run it. Each agent's chat now reads that agent's
own status, `GET /api/v1/my-agents/:id/status` (its server side, with real removed keys, is in tests/app/personal-runs.test.ts "C-3").

The test stack has one fixture key per person, so a key cannot be removed here: the browser is told that the other agent's connection was removed
(the response of the status route the chat must not depend on), and the chat must still send through the real server, worker and mock provider;
and an agent whose own status says so waits. Computer width.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import urllib.request

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UPSTREAM, shot, start_forwarder

MOCK = os.environ.get("FLUX_ANTHROPIC_MOCK_URL", "http://127.0.0.1:8090")
UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
PASSWORD = "agents that keep their own connection"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.paused+{STAMP}@example.test"),
    "ben": ("Ben Okafor", f"ben.paused+{STAMP}@example.test"),
}
KEY = f"sk-ant-api03-{'paused-ui-one-' * 3}PA01"
ANSWER = "Planner answers on its own key: measure the north beds first."
REMOVED = "The connection your assistant’s model belonged to was removed."


def mock(path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"{MOCK}{path}", data=data, method="POST" if body is not None else "GET", headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read())


class RemovedConnectionPausesOnlyItsAgents(unittest.TestCase):
    """Tests run in name order and share two accounts."""

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
        mock("/__script", {"reset": True, "text": ANSWER})
        for who, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"name": name, "email": email, "password": PASSWORD}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.states[who] = context.storage_state()
            context.close()
        context = cls.browser.new_context(service_workers="block", base_url=ORIGIN, storage_state=cls.states["ada"])
        ws = context.request.post("/api/v1/workspaces", data={"name": "Paused agents workshop"}, headers={"origin": ORIGIN}).json()
        response = context.request.post(f"/api/v1/workspaces/{ws['id']}/members", data={"email": PEOPLE["ben"][1], "role": "member"}, headers={"origin": ORIGIN})
        assert response.status == 201, response.text()
        cls.ids["workspace"] = ws["id"]
        context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        mock("/__script", {"reset": True})
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str = "ada") -> Page:
        context = self.browser.new_context(service_workers="block", base_url=ORIGIN, storage_state=self.states[who], locale="en-GB",
                                           reduced_motion="reduce", viewport=DESKTOP)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int = 200):
        response = page.request.fetch(path, method=method, headers={"origin": ORIGIN}, data=body)
        self.assertEqual(response.status, status, response.text())
        return response.json() if response.text() else None

    def removed(self, real: dict) -> str:
        """`real` as the server says it once the agent's connection was removed (C-3)."""
        return json.dumps({**real, "state": "unavailable", "unavailableReason": "connection_changed", "today": None})

    def test_01_ada_has_assistant_and_planner(self) -> None:
        page = self.page()
        self.api(page, "POST", "/api/v1/background-compute-connections", {"name": "Ada's key", "provider": "anthropic", "model": "claude-sonnet-5",
                 "apiKey": KEY, "dailyBudgetCents": 500, "timeZone": "Europe/Warsaw"}, status=201)
        mine = self.api(page, "GET", "/api/v1/my-agents")["items"]
        self.assertEqual([item["name"] for item in mine], ["Assistant"], "the first connection makes Assistant")
        type(self).ids["assistant"] = mine[0]["id"]
        type(self).ids["planner"] = self.api(page, "POST", "/api/v1/my-agents", {"workspaceId": self.ids["workspace"], "name": "Planner"}, status=201)["id"]
        for agent in ("assistant", "planner"):
            own = self.api(page, "GET", f"/api/v1/my-agents/{self.ids[agent]}/status")
            self.assertEqual((own["state"], own["enablement"]["agentId"]), ("ready", self.ids[agent]), agent)
        self.assertEqual(self.api(page, "GET", "/api/v1/personal-assistant")["enablement"]["agentId"], self.ids["assistant"], "`/ai` is Assistant's")

    def test_02_planner_s_chat_does_not_wait_for_assistant_s_removed_connection_and_answers(self) -> None:
        page = self.page()
        real = self.api(page, "GET", "/api/v1/personal-assistant")
        page.route(re.compile(r".*/api/v1/personal-assistant$"), lambda route: route.fulfill(status=200, content_type="application/json", body=self.removed(real))
                   if route.request.method == "GET" else route.continue_())
        # The chat reads Planner's own status, and sends once it has it (before, "Checking your assistant…").
        own = f"/api/v1/my-agents/{self.ids['planner']}/status"
        with page.expect_response(lambda response: response.url.endswith(own) and response.status == 200):
            page.goto(f"/agents/{self.ids['planner']}")
        page.wait_for_timeout(300)  # the response is in; React keeps it within a frame
        expect(page.get_by_text("Only you talk to Planner. Reports of its work arrive here.")).to_be_visible()
        composer = page.get_by_role("textbox", name="Message Planner")
        expect(composer).to_be_visible()
        expect(page.get_by_text(REMOVED)).to_have_count(0)
        composer.fill("Which beds first?")
        composer.press("Enter")
        chat = page.get_by_role("list", name="Your chat with Planner")
        expect(chat.get_by_text("Which beds first?")).to_be_visible()
        expect(chat.get_by_text(ANSWER)).to_be_visible(timeout=30000)
        expect(page.get_by_role("alert")).to_have_count(0)
        expect(page.get_by_text(REMOVED)).to_have_count(0)
        shot(page, "agent-chat-other-connection-removed-1440")

    def test_03_an_agent_whose_own_connection_was_removed_waits_and_sends_nothing(self) -> None:
        page = self.page()
        real = self.api(page, "GET", f"/api/v1/my-agents/{self.ids['assistant']}/status")
        page.route(re.compile(rf".*/api/v1/my-agents/{self.ids['assistant']}/status$"),
                   lambda route: route.fulfill(status=200, content_type="application/json", body=self.removed(real)))
        page.goto(f"/agents/{self.ids['assistant']}")
        composer = page.get_by_role("textbox", name="Message Assistant")
        expect(composer).to_be_visible()
        expect(page.get_by_role("status").filter(has_text=REMOVED)).to_be_visible()
        composer.fill("Anything new?")
        composer.press("Enter")
        expect(page.get_by_role("alert").filter(has_text=REMOVED)).to_be_visible()
        expect(composer).to_have_value("Anything new?")
        runs = self.api(page, "GET", f"/api/v1/assistant-runs?chatAgentId={self.ids['assistant']}&limit=20&offset=0")
        self.assertEqual(runs["items"], [], "nothing was sent for Assistant")

    def test_04_nobody_else_reads_an_agent_s_status(self) -> None:
        ben = self.page("ben")
        for agent in ("assistant", "planner"):
            self.api(ben, "GET", f"/api/v1/my-agents/{self.ids[agent]}/status", status=404)
        self.api(ben, "GET", "/api/v1/my-agents/not-an-id/status", status=404)
        self.api(self.page(), "GET", "/api/v1/my-agents/00000000-0000-4000-8000-000000000000/status", status=404)


if __name__ == "__main__":
    unittest.main()
