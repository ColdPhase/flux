"""A new space in one step (F-037, #874; final design F-026 S20).

A name makes a space; people come next. Every space starts the same way, with Conversation, Tasks, Map and Wiki:
there are no templates and no goal. Its creator is its first admin, and nobody else but the company's owners and
admins can open it until people are added. Runs through scripts/check_ui.sh against the running app.
"""

from __future__ import annotations

import os

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "one step to a project"
EMAIL = f"ada.newproject+{int(time.time() * 1000)}@example.test"
HERB = "Balcony herb garden"


UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")


class NewProject(unittest.TestCase):
    browser: Browser
    state: dict = {}
    ids: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        assert cls.browser.browser_type.name == UI_BROWSER
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}")
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, scheme: str = "light", viewport: dict | None = None) -> Page:
        phone = viewport == PHONE
        options: dict = {"base_url": ORIGIN, "color_scheme": scheme, "locale": "en-GB", "service_workers": "block",
                         "viewport": viewport or DESKTOP, "device_scale_factor": 1, "has_touch": phone, "is_mobile": phone}
        if self.state:
            options["storage_state"] = self.state
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context.new_page()

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int = 201) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json", "idempotency-key": str(uuid.uuid4())},
                                      data=json.dumps(body) if body is not None else None)
        self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def ensure_account(self) -> None:
        if self.state:
            return
        page = self.page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Ada Kowalska")
        page.get_by_label("Email").fill(EMAIL)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).ids["workspace"] = self.api(page, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"})["id"]
        type(self).state = page.context.storage_state()

    def signed_up(self, name: str, email: str) -> dict:
        """A new account in its own context; returns its storage state."""
        context = self.browser.new_context(base_url=ORIGIN, locale="en-GB", service_workers="block", viewport=DESKTOP)
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill(name)
        page.get_by_label("Email").fill(email)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        return context.storage_state()

    def as_account(self, state: dict) -> Page:
        context = self.browser.new_context(base_url=ORIGIN, locale="en-GB", service_workers="block", viewport=DESKTOP, storage_state=state)
        self.addCleanup(context.close)
        return context.new_page()

    def view_names(self, page: Page) -> list[str]:
        views = page.locator("header.top").get_by_role("navigation", name="Space views")
        expect(views.get_by_role("link").first).to_be_visible()
        return [text.strip() for text in views.get_by_role("link").all_inner_texts()]

    def create(self, page: Page, name: str) -> str:
        page.goto("/projects/new")
        page.get_by_label("Space name").fill(name)
        page.get_by_role("button", name="Create space").click()
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}\?new=1"))
        return re.search(r"/projects/([0-9a-f-]{36})", page.url).group(1)

    def test_01_one_step_a_name_and_nothing_else(self) -> None:
        self.ensure_account()
        for scheme in ("light", "dark"):
            page = self.page(scheme)
            page.goto("/projects/new")
            card = page.get_by_role("form", name="New space")
            expect(card.get_by_role("heading", name="New space")).to_be_visible()
            expect(card).to_contain_text("One step — add people next")
            expect(card).to_contain_text("Until you add people, only you and the company’s admins can open it")
            expect(card).to_contain_text("Every space starts with Conversation, Tasks, Map and Wiki.")
            # A name is all it asks: no template, no goal, no "Who can see this" step.
            expect(card.get_by_role("textbox")).to_have_count(1)
            expect(card.get_by_role("radio")).to_have_count(0)
            expect(card).not_to_contain_text("goal")
            shot(page, f"874-newspace-1440-{scheme}")

    def test_02_a_new_space_has_its_four_views_and_its_creator_is_its_admin(self) -> None:
        self.ensure_account()
        page = self.page()
        pid = self.create(page, HERB)
        type(self).ids["space"] = pid
        project = self.api(page, "GET", f"/api/v1/projects/{pid}", status=200)
        self.assertEqual(project["views"], ["map", "docs"])
        self.assertEqual(project["visibility"], "restricted")
        self.assertEqual(project["access"], "manager")
        self.assertNotIn("goal", project)
        expect(page.locator("header.top").get_by_role("heading", level=1, name=HERB)).to_be_visible()
        self.assertEqual(self.view_names(page)[:4], ["Conversation", "Map", "Tasks", "Wiki"])
        # A space made through the API starts the same way.
        other = self.api(page, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Cargo bike co-op"})
        self.assertEqual(other["views"], ["map", "docs"])

    def test_05_phone_form_and_the_views_of_a_new_space(self) -> None:
        self.ensure_account()
        for scheme in ("light", "dark"):
            page = self.page(scheme, PHONE)
            page.goto("/projects/new")
            expect(page.get_by_label("Space name")).to_be_visible()
            create = page.get_by_role("button", name="Create space")
            self.assertGreaterEqual(create.bounding_box()["height"], 44)
            shot(page, f"874-newspace-390-{scheme}")
        page = self.page("light", PHONE)
        page.goto("/projects/new")
        page.get_by_label("Space name").fill("Phone space")
        page.get_by_role("button", name="Create space").tap()
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}\?new=1"))
        pid = re.search(r"/projects/([0-9a-f-]{36})", page.url).group(1)
        page.goto(f"/projects/{pid}")
        # On the phone the views live in the title's menu (#341).
        page.get_by_role("heading", level=1).get_by_role("button").tap()
        views = page.get_by_role("dialog").filter(has=page.locator(".phone-menu__list"))
        for name in ("Tasks", "Map", "Wiki"):
            expect(views.get_by_role("link", name=re.compile(f"^{name}"))).to_be_visible()
        shot(page, "874-phone-views-390")

    def test_06_the_footer_names_who_can_open_a_new_space(self) -> None:
        """The caption is true: the creator and the company's owners and admins open it at once; a member does not."""
        self.ensure_account()
        stamp = int(time.time() * 1000)
        admin_email, member_email = f"admin.np+{stamp}@example.test", f"member.np+{stamp}@example.test"
        admin_state = self.signed_up("Nia Admin", admin_email)
        member_state = self.signed_up("Kai Member", member_email)
        owner = self.page()
        self.api(owner, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/members", {"email": admin_email, "role": "admin"})
        self.api(owner, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/members", {"email": member_email, "role": "member"})
        pid = self.create(owner, "Visible to admins")
        admin = self.as_account(admin_state)
        self.assertEqual(self.api(admin, "GET", f"/api/v1/projects/{pid}", status=200)["access"], "manager")
        member = self.as_account(member_state)
        self.api(member, "GET", f"/api/v1/projects/{pid}", status=404)
        # A member starts a space of their own too, and is its admin.
        mine = self.create(member, "Kai’s space")
        self.assertEqual(self.api(member, "GET", f"/api/v1/projects/{mine}", status=200)["access"], "manager")

    def test_07_a_late_answer_does_not_pull_you_back_into_the_space(self) -> None:
        self.ensure_account()
        page = self.page()
        a = self.api(page, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Late A", "visibility": "restricted"})
        b = self.api(page, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Late B", "visibility": "restricted"})
        held: list = []

        def hold(route) -> None:
            # The server applies the change; the browser hears about it only when the test lets it.
            held.append((route, route.fetch()))

        page.route(re.compile(r"/api/v1/projects/[0-9a-f-]{36}/views$"), hold)
        page.goto(f"/projects/{a['id']}")
        page.locator("header.top").get_by_role("button", name="More", exact=True).click()
        page.get_by_role("menu", name="More").get_by_role("menuitem", name="Add Agents").click()
        deadline = time.time() + 8
        while not held and time.time() < deadline:
            page.wait_for_timeout(100)
        self.assertEqual(len(held), 1)
        # She moves on to space B and starts a message.
        page.get_by_role("complementary", name="Sidebar").get_by_role("link", name=re.compile("Late B")).click()
        expect(page).to_have_url(re.compile(f"/projects/{b['id']}"))
        composer = page.get_by_placeholder(re.compile("Message · @ mention"))
        composer.fill("Half a thought for B")
        route, response = held[0]
        route.fulfill(response=response)
        page.wait_for_timeout(600)
        expect(page).to_have_url(re.compile(f"/projects/{b['id']}"))
        expect(composer).to_have_value("Half a thought for B")
        self.assertEqual(self.api(page, "GET", f"/api/v1/projects/{a['id']}", status=200)["views"], ["map", "docs", "agents"])
        self.assertEqual(self.api(page, "GET", f"/api/v1/projects/{b['id']}", status=200)["views"], ["map", "docs"])


if __name__ == "__main__":
    unittest.main()
