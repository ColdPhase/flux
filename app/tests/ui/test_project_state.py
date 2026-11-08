"""A space's header and access stay truthful (#136, #865).

The header is one row without a state line (F-026 §4, #340), and the space's own Details have no "Now" (#865): what is
current lives in Tasks and what waits for the person in the Inbox. A long title keeps one row; a removed member sees nothing.

Actual authenticated browser/API data; viewport captures are emulation, not device acceptance.
"""
from __future__ import annotations

import os

import json
import re
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright

from test_app_shell import UI_BROWSER, ORIGIN, UPSTREAM, open_details, shot, start_forwarder, view_tab
from test_project_surface import LONG_NAME


UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")


class ProjectStateJourney(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        assert cls.browser.browser_type.name == UI_BROWSER
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}")
        expect.set_options(timeout=8000)
        cls.accounts = {}
        for name in ("Ada State", "Jonas Reader"):
            context = cls.browser.new_context(base_url=ORIGIN)
            page = context.new_page()
            page.goto("/sign-up")
            page.get_by_label("Name").fill(name)
            email = f"state-{uuid.uuid4()}@example.test"
            page.get_by_label("Email").fill(email)
            page.get_by_label("Password").fill("native state stays truthful")
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            me = cls.call(page, "GET", "/api/v1/me")["user"]
            cls.accounts[name] = {"id": me["id"], "email": email, "state": context.storage_state()}
            context.close()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    @staticmethod
    def call(page, method, path, body=None, status=200, headers=None):
        response = page.request.fetch(ORIGIN + path, method=method,
            headers={"origin": ORIGIN, **({"content-type": "application/json"} if body is not None else {}), **(headers or {})},
            data=json.dumps(body) if body is not None else None)
        if response.status != status:
            raise AssertionError(f"{method} {path}: {response.status}, expected {status}: {response.text()}")
        return response.json() if response.text() else None

    def page(self, who="Ada State", width=1280, height=800, dark=False):
        context = self.browser.new_context(base_url=ORIGIN, viewport={"width": width, "height": height},
            storage_state=self.accounts[who]["state"], color_scheme="dark" if dark else "light",
            is_mobile=width <= 640, has_touch=width <= 640)
        self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        return page

    def assert_text_is_unclipped(self, locator):
        self.assertTrue(locator.evaluate("el => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1"), "the visible label is not clipped")

    def scene(self, name="Gesture lamp"):
        owner = self.page()
        ws = self.call(owner, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, 201)
        self.call(owner, "POST", f"/api/v1/workspaces/{ws['id']}/members",
            {"email": self.accounts["Jonas Reader"]["email"], "role": "member"}, 201)
        project = self.call(owner, "POST", f"/api/v1/workspaces/{ws['id']}/projects",
            {"name": name, "visibility": "restricted"}, 201)
        self.call(owner, "POST", f"/api/v1/projects/{project['id']}/grants",
            {"principal": {"kind": "human", "id": self.accounts["Jonas Reader"]["id"]}, "role": "contributor"}, 201)
        return owner, project

    def faces(self, page):
        return page.locator("header.top").get_by_role("button", name=re.compile("who can see this space$"))

    def work(self, page, project, title, status="open"):
        return self.call(page, "POST", f"/api/v1/projects/{project['id']}/work", {"title": title, "status": status}, 201)

    def test_03_a_member_who_is_removed_from_the_space_sees_nothing_of_it(self):
        owner, project = self.scene()
        task = self.work(owner, project, "Prepare the ToF sensor experiment for the library")
        member = self.page("Jonas Reader")
        self.call(member, "GET", f"/api/v1/projects/{project['id']}/work", status=200)
        grants = self.call(owner, "GET", f"/api/v1/projects/{project['id']}/grants")
        gone = next(grant for grant in grants if grant["principal"]["id"] == self.accounts["Jonas Reader"]["id"])
        self.call(owner, "DELETE", f"/api/v1/projects/{project['id']}/grants/{gone['id']}", status=204)
        removed = self.page("Jonas Reader")
        self.call(removed, "GET", f"/api/v1/projects/{project['id']}/work", status=404)
        removed.goto(f"/projects/{project['id']}")
        expect(removed.locator('[data-seg="open"]')).to_have_count(0)
        expect(removed.get_by_text(task["title"], exact=True)).to_have_count(0)

    def test_05_long_project_title_keeps_one_row_with_views_and_people(self):
        for name in (LONG_NAME, LONG_NAME + " — sensor calibration and accessible night lighting"):
            owner, project = self.scene(name)
            self.work(owner, project, "Check low-light reliability")
            for width in (641, 700, 744, 820, 1024, 1280, 1440):
                with self.subTest(name=name, width=width):
                    page = self.page(width=width, height=1180)
                    page.goto(f"/projects/{project['id']}")
                    header = page.locator("header.top")
                    # One row at every width (Spokój rule 3): a long name shortens; the views (below 900 px the
                    # title's view menu) and More stay, and where the row has no room the people move into More.
                    self.assertLessEqual(header.bounding_box()["height"], 72, "a long title never stacks the header")
                    title = header.get_by_role("heading", level=1)
                    expect(title).to_have_attribute("title", name)
                    self.assertGreaterEqual(title.bounding_box()["width"], 80, "the name keeps a readable start")
                    if width <= 900:
                        expect(title.get_by_role("button")).to_be_visible()
                    else:
                        expect(header.get_by_role("navigation", name="Space views")).to_be_visible()
                    expect(header.get_by_role("button", name="More", exact=True)).to_be_in_viewport()
                    self.assertLessEqual(page.locator("body").evaluate("el => el.scrollWidth"), width)
                    if width <= 900 or page.locator(".app__main").evaluate("el => el.clientWidth") > 860:
                        self.faces(page).click()
                    else:
                        header.get_by_role("button", name="More", exact=True).click()
                        page.get_by_role("menu", name="More").get_by_role("menuitem", name="Who can see this").click()
                    # The audience leads to the space's settings (F-037), under the same header with its long title.
                    expect(page).to_have_url(re.compile(r"/settings$"))
                    expect(page.get_by_role("heading", name="Space settings")).to_be_visible()
                    expect(header.get_by_role("heading", level=1, name=name, exact=True)).to_be_visible()
                    page.go_back()
                    expect(header.get_by_role("button", name="More", exact=True)).to_be_visible()
                    if width in (744, 820, 1280):
                        shot(page, f"136-state-long-title-{len(name)}-{width}")
