"""Browser tests for who may accept a project decision (issue #250, decision O-009).

Runs through scripts/check_ui.sh against the running Compose application. Three people share one
restricted project: Ada manages it and Kai holds a contributor grant. Ada proposes a
decision. Kai, who did not propose it, accepts it in Details and is recorded as the decider. Every step is checked against the API, so the test proves persisted behaviour.
The agent and assistant paths are proven in the API suite (decision-authority.test.ts, personal-runs.test.ts).
"""

from __future__ import annotations

import json
import re
import time
import unittest

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "a person decides here"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Lind", "email": f"ada.authority+{STAMP}@example.test"}
KAI = {"name": "Kai Berg", "email": f"kai.authority+{STAMP}@example.test"}
TITLE = "Switch to a ToF distance sensor"
WHY = "The camera failed below 10 lux; a ToF sensor works in the dark and stores no images"


class DecisionAuthorityJourney(unittest.TestCase):
    """Tests run in name order and share three accounts, one project and one decision."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    project_id: str = ""
    decision_id: str = ""

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, who: str | None, *, phone: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        if who and who in self.states:
            options["storage_state"] = self.states[who]
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context

    def page(self, who: str | None, **kwargs) -> Page:
        page = self.context(who, **kwargs).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def fetch(self, page: Page, method: str, path: str, body: dict | None = None):
        return page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"},
                                  data=json.dumps(body) if body is not None else None)

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None) -> dict:
        response = self.fetch(page, method, path, body)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def decision(self, page: Page) -> dict:
        return self.api(page, "GET", f"/api/v1/decisions/{self.decision_id}", status=200)

    def open_decision(self, who: str, **kwargs) -> Page:
        """Opens the decision itself in the detail panel: there is no Decisions view to find it in (#342)."""
        page = self.page(who, **kwargs)
        page.goto(f"/projects/{self.project_id}/tasks?open=decision:{self.decision_id}")
        return page

    def details(self, page: Page, phone: bool = False):
        return page.get_by_role("dialog", name="Details") if phone else page.locator("#details")

    # ---------------------------------------------------------------- three people, one proposal

    def test_01_a_manager_proposes_in_a_project_with_a_contributor(self) -> None:
        for key, person in (("ada", ADA), ("kai", KAI)):
            page = self.page(None)
            page.goto("/sign-up")
            page.get_by_label("Name").fill(person["name"])
            page.get_by_label("Email").fill(person["email"])
            page.get_by_label("Password").fill(PASSWORD)
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            type(self).states[key] = page.context.storage_state()
            person["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        ada = self.page("ada")
        ws = self.api(ada, "POST", "/api/v1/workspaces", {"name": "Lamp studio"}, status=201)
        project = self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Gesture lamp", "visibility": "restricted"}, status=201)
        for person, role in ((KAI, "contributor"),):
            self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": person["email"], "role": "member"}, status=201)
            self.api(ada, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "human", "id": person["id"]}, "role": role}, status=201)
        type(self).project_id = project["id"]
        proposal = self.api(ada, "POST", f"/api/v1/projects/{project['id']}/decisions", {"title": TITLE, "rationale": WHY}, status=201)
        type(self).decision_id = proposal["id"]
        self.assertEqual((proposal["status"], proposal["decidedBy"]), ("proposed", None))

    # ---------------------------------------------------------------- a contributor decides

    def test_04_a_contributor_who_did_not_propose_it_accepts_and_is_recorded(self) -> None:
        # The proposal waits in Kai's Inbox as one card: who proposed it, who can still accept it (one person decides).
        inbox = self.page("kai")
        inbox.goto("/inbox")
        card = inbox.locator(".nyc", has_text=TITLE)
        expect(card).to_contain_text("Ada Lind")
        expect(card.locator(".nyc__waiting")).to_contain_text("waiting for you")
        expect(card.locator(".nyc__waiting")).to_contain_text("Ada Lind can accept too")
        expect(card.get_by_role("button", name=re.compile("^Accept"))).to_be_visible()
        page = self.open_decision("kai")
        panel = self.details(page)
        expect(panel.get_by_role("region", name="Who decides")).to_have_count(0)
        expect(panel).to_contain_text("Ada Lind")
        panel.get_by_role("button", name="Accept", exact=True).click()
        expect(panel.locator(".wd-eyebrow")).to_contain_text("Decision · accepted")
        expect(panel).to_contain_text("Kai Berg")
        stored = self.decision(page)
        self.assertEqual((stored["status"], stored["decidedBy"]["id"], stored["proposedBy"]["id"]), ("accepted", KAI["id"], ADA["id"]))

        # The proposer now reads a current rule, with no pending note.
        proposer = self.page("ada")
        proposer.goto(f"/projects/{self.project_id}/tasks?open=decision:{self.decision_id}")
        sheet = self.details(proposer)
        expect(sheet.locator(".wd-eyebrow")).to_contain_text("Decision · accepted")
        expect(sheet).to_contain_text("Kai Berg")
        expect(sheet.get_by_role("region", name="Who decides")).to_have_count(0)
        # Accepted, it has left everyone's Inbox.
        inbox.goto("/inbox")
        expect(inbox.locator(".nyc", has_text=TITLE)).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
