"""A new project in one step and views that appear when needed (#351, final design F-026 S20, S21).

A name and a template make a project; people and agents come later. Map, Wiki and Agents show in the
header the first time they are needed (from the template, from use) and can be added from More.
Projects that existed before keep every view. Runs through scripts/check_ui.sh against the running app.
"""

from __future__ import annotations

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


class NewProject(unittest.TestCase):
    browser: Browser
    state: dict = {}
    ids: dict = {}

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

    def view_names(self, page: Page) -> list[str]:
        views = page.locator("header.top").get_by_role("navigation", name="Project views")
        expect(views.get_by_role("link").first).to_be_visible()
        return [text.strip() for text in views.get_by_role("link").all_inner_texts()]

    def create(self, page: Page, name: str, template: str | None = None) -> str:
        page.goto("/projects/new")
        page.get_by_label("What is it about?").fill(name)
        if template:
            page.get_by_role("radio", name=re.compile(f"^{template}")).check()
        page.get_by_role("button", name="Create project").click()
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}\?new=1"))
        return re.search(r"/projects/([0-9a-f-]{36})", page.url).group(1)

    def test_01_one_step_a_name_and_a_template(self) -> None:
        self.ensure_account()
        for scheme in ("light", "dark"):
            page = self.page(scheme)
            page.goto("/projects/new")
            card = page.get_by_role("form", name="New project")
            expect(card.get_by_role("heading", name="New project")).to_be_visible()
            expect(card).to_contain_text("One step — invite people and agents later")
            expect(card).to_contain_text("Only you can see it until you invite someone")
            # No "Who can see this" step before the project: a name and a template are all it asks.
            expect(card.get_by_role("textbox")).to_have_count(1)
            templates = card.get_by_role("radio")
            self.assertEqual(templates.count(), 4)
            expect(card.get_by_role("radio", name=re.compile("^Build something"))).to_be_checked()
            for text in ("Conversation + Tasks", "Conversation + Wiki", "Conversation only"):
                expect(card).to_contain_text(text)
            expect(card).to_contain_text("Map, Wiki and Agents appear the first time you need them")
            # The chosen template is outlined, whichever it is, and keys move between them.
            card.get_by_role("radio", name=re.compile("^Build something")).focus()
            page.keyboard.press("ArrowRight")
            expect(card.get_by_role("radio", name=re.compile("^Research"))).to_be_checked()
            shot(page, f"351-newproject-1440-{scheme}")

    def test_02_research_starts_with_a_wiki_and_more_adds_a_map(self) -> None:
        self.ensure_account()
        page = self.page()
        pid = self.create(page, HERB, "Research")
        type(self).ids["research"] = pid
        project = self.api(page, "GET", f"/api/v1/projects/{pid}", status=200)
        self.assertEqual(project["views"], ["docs"])
        self.assertEqual(project["visibility"], "restricted")
        expect(page.locator("header.top").get_by_role("heading", level=1, name=HERB)).to_be_visible()
        self.assertEqual(self.view_names(page), ["Conversation", "Tasks", "Wiki"])
        page.locator("header.top").get_by_role("button", name="More", exact=True).click()
        menu = page.get_by_role("menu", name="More")
        expect(menu.get_by_role("menuitem", name="Add Wiki")).to_have_count(0)
        expect(menu.get_by_role("menuitem", name="Add Agents")).to_be_visible()
        shot(page, "351-more-add-views-1440")
        menu.get_by_role("menuitem", name="Add Map").click()
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}/map"))
        expect(page.locator("header.top").get_by_role("navigation", name="Project views").get_by_role("link", name="Map")).to_be_visible()
        self.assertEqual(self.view_names(page), ["Conversation", "Map", "Tasks", "Wiki"])
        self.assertEqual(self.api(page, "GET", f"/api/v1/projects/{pid}", status=200)["views"], ["docs", "map"])
        # Adding is remembered: after a reload the Map is still there.
        page.reload()
        self.assertEqual(self.view_names(page), ["Conversation", "Map", "Tasks", "Wiki"])

    def test_03_blank_shows_two_views_and_use_makes_one_appear(self) -> None:
        self.ensure_account()
        page = self.page("dark")
        pid = self.create(page, "Blank slate")
        # Build something is the default template.
        self.assertEqual(self.api(page, "GET", f"/api/v1/projects/{pid}", status=200)["views"], [])
        self.assertEqual(self.view_names(page), ["Conversation", "Tasks"])
        shot(page, "351-two-views-1440-dark")
        # Someone sketches in the project: the Map is needed, so it appears without being added.
        self.api(page, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/sketches", {"title": "First thought", "scope": "project", "projectId": pid})
        page.goto(f"/projects/{pid}")
        self.assertEqual(self.view_names(page), ["Conversation", "Map", "Tasks"])
        # Direct links to a view that is not shown still open it, and show its tab.
        other = self.create(page, "Linked straight to Agents")
        page.goto(f"/projects/{other}/agents")
        self.assertIn("Agents", self.view_names(page))

    def test_04_projects_that_exist_keep_every_view(self) -> None:
        self.ensure_account()
        page = self.page()
        old = self.api(page, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Cargo bike co-op", "visibility": "restricted"})
        self.assertEqual(old["views"], ["map", "docs", "agents"])
        page.goto(f"/projects/{old['id']}")
        self.assertEqual(self.view_names(page), ["Conversation", "Map", "Tasks", "Wiki", "Agents"])
        page.locator("header.top").get_by_role("button", name="More", exact=True).click()
        expect(page.get_by_role("menu", name="More").get_by_role("menuitem", name=re.compile("^Add "))).to_have_count(0)

    def test_05_phone_sheet_and_adding_a_view(self) -> None:
        self.ensure_account()
        for scheme in ("light", "dark"):
            page = self.page(scheme, PHONE)
            page.goto("/projects/new")
            expect(page.get_by_label("What is it about?")).to_be_visible()
            for box in page.get_by_role("radio").all():
                label = box.locator("xpath=..").bounding_box()
                self.assertGreaterEqual(label["height"], 44)
            create = page.get_by_role("button", name="Create project")
            self.assertGreaterEqual(create.bounding_box()["height"], 44)
            shot(page, f"351-newproject-390-{scheme}")
        page = self.page("light", PHONE)
        page.goto("/projects/new")
        page.get_by_label("What is it about?").fill("Phone project")
        page.get_by_role("radio", name=re.compile("^Blank")).check(force=True)
        page.get_by_role("button", name="Create project").tap()
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}\?new=1"))
        pid = re.search(r"/projects/([0-9a-f-]{36})", page.url).group(1)
        # Close "Who can see this", which a new project opens.
        page.goto(f"/projects/{pid}")
        views = page.get_by_role("navigation", name="Project views")
        expect(views.get_by_role("link", name="Tasks")).to_be_visible()
        expect(views.get_by_role("link", name="Map")).to_have_count(0)
        add = page.get_by_role("button", name="Add a view", exact=True)
        self.assertGreaterEqual(add.bounding_box()["height"], 44)
        add.tap()
        page.get_by_role("menu", name="Add a view").get_by_role("menuitem", name="Add Wiki").tap()
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}/docs"))
        expect(page.get_by_role("navigation", name="Project views").get_by_role("link", name="Wiki")).to_be_visible()
        shot(page, "351-phone-views-390")


if __name__ == "__main__":
    unittest.main()
