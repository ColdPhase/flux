"""#1419 part A: one "+" on the phone and one way to Settings.

Runs through scripts/check_ui.sh against the running Compose application, on the engine named by FLUX_UI_BROWSER."""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Page, expect, sync_playwright

from account import account_link, open_settings, sign_out_button
from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, start_forwarder

PASSWORD = "one way to do each thing"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Kowalska", "email": f"ada.ux+{STAMP}@example.test"}
JONAS = {"name": "Jonas Berg", "email": f"jonas.ux+{STAMP}@example.test"}
OPENING = "Which supplier do we order the probes from?"


class UxSimplicityPartAAccount(unittest.TestCase):
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

    def test_04_the_spaces_list_has_no_new_space_button_and_the_messages_list_has_one_plus_of_its_own(self) -> None:
        page = self.page(phone=True)
        page.goto("/projects")
        expect(page.get_by_role("heading", level=1, name="Spaces")).to_be_visible()
        expect(page.get_by_role("button", name="New space")).to_have_count(0)
        expect(page.locator(".phone-fab")).to_have_count(1)
        page.locator(".phone-fab").tap()
        sheet = page.get_by_role("dialog", name="Create")
        expect(sheet.get_by_role("button", name="Space", exact=True)).to_be_visible()
        page.keyboard.press("Escape")
        # The Messages list: its own "+ New message" starts a message; the floating "+" (which cannot) is not there.
        page.goto("/dm")
        expect(page.get_by_role("heading", level=1, name="Messages")).to_be_visible()
        expect(page.locator(".phone-fab")).to_have_count(0)
        expect(page.get_by_role("button", name="Create", exact=True)).to_have_count(0)
        expect(page.get_by_role("link", name="New message")).to_have_count(1)

    def test_06_the_name_at_the_foot_of_the_sidebar_is_the_one_way_to_settings(self) -> None:
        page = self.page()
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        account = page.locator(".side .me")
        expect(account.get_by_role("link")).to_have_count(1)
        expect(account.get_by_role("button")).to_have_count(0)
        expect(page.get_by_role("link", name="Settings", exact=True)).to_have_count(0)
        expect(page.get_by_role("dialog", name="Account")).to_have_count(0)
        link = account_link(page, ADA["name"])
        expect(link).to_have_attribute("href", "/settings")
        link.click()
        expect(page).to_have_url(f"{ORIGIN}/settings")
        expect(link).to_have_attribute("aria-current", "page")
        # Sign out is in Settings › Account.
        expect(sign_out_button(page)).to_be_visible()
        open_settings(page, ADA["name"])


if __name__ == "__main__":
    unittest.main()
