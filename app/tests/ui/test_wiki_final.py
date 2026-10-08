"""The Wiki as drawn (F-026, #354): page list, page with who edited it, outline, phone chips at 16px.

Checks the final layout at 1440x900 and 390x844 in light and dark, and that the page list and
outline are reachable by keyboard. Versions, sharing and drafts are covered by test_wiki_panes.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

STAMP = int(time.time() * 1000)
PERSON = {"name": "Ada Kowalska", "email": f"ada.wikifinal+{STAMP}@example.test"}
PASSWORD = "wiki as drawn keeps its shape"
BODY = ("Six capacitive probes send readings over LoRa to one gateway in the shed.\n\n## Parts\n\n"
        "| Part | Qty |\n| --- | ---: |\n| Probe | 6 |\n\n## Range\n\nThe far bed sits 180 m away.\n\n## Power\n\nBatteries last a season.\n")
PAGES = ("Overview", "Hardware", "Sensor placement", "Volunteer guide")


class WikiFinal(unittest.TestCase):
    browser: Browser
    state: dict
    project_id = ""
    doc_id = ""

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=8000)
        ctx = cls.browser.new_context(base_url=ORIGIN)
        page = ctx.new_page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill(PERSON["name"])
        page.get_by_label("Email").fill(PERSON["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()

        def api(method, path, body=None, headers=None):
            response = page.request.fetch(f"{ORIGIN}{path}", method=method, data=json.dumps(body) if body is not None else None,
                                          headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})})
            assert response.status < 300, response.text()
            return json.loads(response.text() or "{}")
        ws = api("POST", "/api/v1/workspaces", {"name": "Garden"})
        project = api("POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Community garden sensors", "visibility": "restricted"})
        cls.project_id = project["id"]
        for title in PAGES:
            doc = api("POST", f"/api/v1/projects/{project['id']}/docs", {"title": title, "body": BODY, "state": "published"},
                      {"idempotency-key": str(uuid.uuid4())})
            if title == "Hardware":
                cls.doc_id = doc["id"]
        cls.state = ctx.storage_state()
        ctx.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def open(self, viewport, theme, touch=False):
        options = dict(base_url=ORIGIN, viewport=viewport, storage_state=self.state, color_scheme=theme, locale="en-GB")
        if touch:
            options.update(is_mobile=True, has_touch=True, device_scale_factor=2)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        context.add_init_script(f"localStorage.setItem('flux.theme', '{theme}')")
        page = context.new_page()
        page.goto(f"/projects/{self.project_id}/docs/{self.doc_id}")
        expect(page.get_by_role("heading", level=2, name="Hardware")).to_be_visible()
        return page

    def test_computer_two_panes_and_outline(self) -> None:
        for theme in ("light", "dark"):
            with self.subTest(theme=theme):
                page = self.open(DESKTOP, theme)
                index = page.get_by_role("navigation", name="Wiki pages")
                expect(index.get_by_text("Pages", exact=True)).to_be_visible()
                expect(index.get_by_role("link", name="New page")).to_be_visible()
                expect(index.get_by_role("link", name="Hardware")).to_have_attribute("aria-current", "page")
                expect(page.locator(".wiki-who")).to_contain_text("Edited by Ada Kowalska")
                expect(page.get_by_role("link", name="Edit")).to_have_count(1)
                outline = page.get_by_role("complementary", name="On this page")
                expect(outline.get_by_role("link")).to_have_text(["Parts", "Range", "Power"])
                self.assertEqual(page.locator(".doc-prose").evaluate("e => getComputedStyle(e).fontSize"), "15px")
                box = page.locator(".wiki-doc--read").bounding_box()
                self.assertLessEqual(box["width"], 776.5)
                # Keyboard: Tab from the open page reaches the next page link; the outline is a tab stop.
                index.get_by_role("link", name="Hardware").focus()
                page.keyboard.press("Tab")
                expect(index.get_by_role("link", name="Overview")).to_be_focused()
                outline.get_by_role("link", name="Range").focus()
                page.keyboard.press("Enter")
                expect(page.locator(".doc-prose h2", has_text="Range")).to_be_focused()
                shot(page, f"wiki-final-desktop-1440-{theme}")

    def test_phone_title_chips_and_edit(self) -> None:
        for theme in ("light", "dark"):
            with self.subTest(theme=theme):
                page = self.open(PHONE, theme, touch=True)
                expect(page.locator(".wiki-bar__title")).to_have_text("Wiki · 4 pages")
                chips = page.get_by_role("navigation", name="Wiki pages")
                expect(chips.locator(".wiki-page")).to_have_count(4)
                expect(chips.get_by_role("link", name="Hardware")).to_have_attribute("aria-current", "page")
                self.assertEqual(page.locator(".doc-prose").evaluate("e => [getComputedStyle(e).fontSize, getComputedStyle(e).lineHeight]"), ["16px", "25px"])
                edit = page.get_by_role("link", name="Edit")
                box = edit.bounding_box()
                self.assertGreaterEqual(box["height"], 44)
                self.assertGreater(box["y"] + box["height"], PHONE["height"] * 0.6, "Edit stays low on the screen")
                expect(page.get_by_role("complementary", name="On this page")).to_have_count(0)
                self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"])
                shot(page, f"wiki-final-phone-390-{theme}")


if __name__ == "__main__":
    unittest.main()
