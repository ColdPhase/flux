"""#1419 part A: menus and Connect AI show nothing this server cannot do, and a space has no details panel.

Runs through scripts/check_ui.sh against the running Compose application, on the engine named by FLUX_UI_BROWSER."""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, start_forwarder

PASSWORD = "one way to do each thing"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Kowalska", "email": f"ada.ux+{STAMP}@example.test"}
JONAS = {"name": "Jonas Berg", "email": f"jonas.ux+{STAMP}@example.test"}
OPENING = "Which supplier do we order the probes from?"


class UxSimplicityPartAMenus(unittest.TestCase):
    pw = None
    browser = None
    ada_state: dict = {}
    jonas_state: dict = {}
    ids: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def sign_up(self, person: dict) -> tuple[Page, dict]:
        context = self.browser.new_context(base_url=ORIGIN, locale="en-GB", service_workers="block", viewport=DESKTOP)
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill(person["name"])
        page.get_by_label("Email").fill(person["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        return page, context.storage_state()

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int = 201) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json", "idempotency-key": str(uuid.uuid4())},
                                      data=json.dumps(body) if body is not None else None)
        self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def ensure_world(self) -> None:
        if self.ids:
            return
        jonas_page, jonas_state = self.sign_up(JONAS)
        jonas_id = self.api(jonas_page, "GET", "/api/v1/me", None, 200)["user"]["id"]
        ada_page, ada_state = self.sign_up(ADA)
        workspace = self.api(ada_page, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"})["id"]
        self.api(ada_page, "POST", f"/api/v1/workspaces/{workspace}/members", {"email": JONAS["email"], "role": "member"})
        project = self.api(ada_page, "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": "Community garden sensors", "visibility": "restricted"})["id"]
        self.api(ada_page, "POST", f"/api/v1/projects/{project}/grants", {"principal": {"kind": "human", "id": jonas_id}, "role": "contributor"})
        conversation = self.api(ada_page, "POST", f"/api/v1/projects/{project}/conversations", {"body": OPENING, "clientMessageId": str(uuid.uuid4())})
        self.api(ada_page, "POST", f"/api/v1/workspaces/{workspace}/agents", {"name": "Planner Bot", "owner": "self"})
        dm = self.api(ada_page, "POST", f"/api/v1/workspaces/{workspace}/dms", {"participantIds": [jonas_id]})
        type(self).ada_state, type(self).jonas_state = self.ada_state or ada_state, jonas_state
        type(self).ids = {"workspace": workspace, "project": project, "conversation": conversation["id"], "message": conversation["messages"][0]["id"], "dm": dm["id"]}

    def page(self, who: str = "ada", *, phone: bool = False) -> Page:
        self.ensure_world()
        context = self.browser.new_context(base_url=ORIGIN, locale="en-GB", service_workers="block", viewport=PHONE if phone else DESKTOP,
                                           storage_state=self.ada_state if who == "ada" else self.jonas_state, has_touch=phone, is_mobile=phone)
        self.addCleanup(context.close)
        return context.new_page()

    def space(self, page: Page) -> None:
        page.goto(f"/projects/{self.ids['project']}")
        expect(page.get_by_label("Write a message", exact=True)).to_be_visible()

    def thread(self, page: Page) -> None:
        page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
        expect(page.get_by_label("Reply", exact=True)).to_be_visible()

    def test_05_a_space_and_a_direct_message_have_no_call_row_and_a_space_has_no_details_row(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                header = "header.phead" if phone else "header.top"
                page.goto(f"/projects/{self.ids['project']}")
                expect(page.get_by_label("Write a message", exact=True)).to_be_visible()
                page.locator(header).get_by_role("button", name="More", exact=True).click()
                menu = page.get_by_role("menu", name="More")
                expect(menu.get_by_role("menuitem", name="Settings")).to_be_visible()
                for gone in (r"^Call", r"details", r"^Live now"):
                    expect(menu.get_by_role("menuitem", name=re.compile(gone, re.I))).to_have_count(0)
                expect(menu).not_to_contain_text("Live sessions are not available")
                page.keyboard.press("Escape")
                page.goto(f"/dm/{self.ids['dm']}")
                expect(page.get_by_role("heading", level=1, name=re.compile("Jonas Berg"))).to_be_visible()
                page.locator(header).get_by_role("button", name="More", exact=True).click()
                menu = page.get_by_role("menu", name="More")
                expect(menu.get_by_role("menuitem", name="People and privacy")).to_be_visible()
                for gone in (r"^Call", r"^Live now"):
                    expect(menu.get_by_role("menuitem", name=re.compile(gone))).to_have_count(0)
                expect(page.locator(header).get_by_role("button", name=re.compile("^(Call|Join)"))).to_have_count(0)

    def test_06_message_info_left_open_does_not_follow_into_a_space(self) -> None:
        # A space has no panel of its own: the docked People and privacy of a direct message closes on the way to a space, never an empty panel.
        page = self.page()
        page.goto(f"/dm/{self.ids['dm']}")
        expect(page.get_by_role("heading", level=1, name=re.compile("Jonas Berg"))).to_be_visible()
        page.locator("header.top").get_by_role("button", name="More", exact=True).click()
        page.get_by_role("menu", name="More").get_by_role("menuitem", name="People and privacy").click()
        expect(page.locator("#details")).to_contain_text("People and privacy")
        page.locator(".app__side").get_by_role("link", name=re.compile("^Community garden sensors")).first.click()
        expect(page.get_by_label("Write a message", exact=True)).to_be_visible()
        expect(page.locator("#details")).to_have_count(0)

    def test_07_a_member_with_nothing_connected_sees_no_new_agent_and_no_plan_the_server_cannot_run(self) -> None:
        page = self.page("jonas")
        # The test composition gives every person a fixture key (docs/development/personal-runs.md), so "nothing connected" is what the
        # server says here: its model choice has no connection to run an agent on. A real instance answers this by itself.
        page.route("**/api/v1/personal-assistant/model", lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps({"current": None, "default": None, "groups": [], "saved": False})))
        page.goto("/settings/agents")
        connect = page.get_by_role("region", name="Connect AI", exact=True)
        expect(connect).to_be_visible()
        expect(page.get_by_text("Connect AI first.")).to_be_visible()
        expect(page.get_by_role("button", name="New agent")).to_have_count(0)
        expect(page.get_by_text("Make one with New agent")).to_have_count(0)
        connect.get_by_role("button", name="Connect AI", exact=True).click()
        window = page.get_by_role("dialog", name="Connect your AI")
        expect(window.locator("[data-choice=api_key]")).to_be_visible()
        expect(window.locator("[data-choice=local_client]")).to_be_visible()
        for kind in ("claude_plan", "chatgpt_plan"):
            expect(window.locator(f"[data-choice={kind}]")).to_have_count(0)
        expect(window).not_to_contain_text("Not offered")


if __name__ == "__main__":
    unittest.main()
