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
                # Edit is the one primary action: the primary pill, never the page's own surface.
                look = edit.evaluate("e => { const c = getComputedStyle(e); return [c.backgroundColor, c.backgroundImage, c.color, getComputedStyle(document.documentElement).getPropertyValue('--inv').trim()]; }")
                self.assertNotEqual(look[1], "none", "the primary gradient")
                self.assertNotEqual(look[0], page.evaluate("getComputedStyle(document.body).backgroundColor"))
                self.assertNotEqual(look[0], "rgba(0, 0, 0, 0)")
                shot(page, f"wiki-final-phone-390-{theme}")


class WikiReferences(unittest.TestCase):
    """Task and decision references in a page, and a reference that is not in the project."""

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=8000)
        ctx = cls.browser.new_context(base_url=ORIGIN)
        page = ctx.new_page()
        email = f"ada.wikirefs+{STAMP}@example.test"
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Ada Kowalska")
        page.get_by_label("Email").fill(email)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()

        def api(method, path, body=None, headers=None):
            response = page.request.fetch(f"{ORIGIN}{path}", method=method, data=json.dumps(body) if body is not None else None,
                                          headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})})
            assert response.status < 300, response.text()
            return json.loads(response.text() or "{}")
        ws = api("POST", "/api/v1/workspaces", {"name": "Garden refs"})
        project = api("POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Refs garden", "visibility": "restricted"})
        other = api("POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Elsewhere", "visibility": "restricted"})
        pid = project["id"]
        task = api("POST", f"/api/v1/projects/{pid}/work", {"title": "Order the probes", "status": "in_progress"})
        accepted = api("POST", f"/api/v1/projects/{pid}/decisions", {"title": "Measure soil moisture first"})
        api("POST", f"/api/v1/decisions/{accepted['id']}/accept", {"expectedVersion": accepted["version"]})
        proposed = api("POST", f"/api/v1/projects/{pid}/decisions", {"title": "Add frost warnings later"})
        foreign = api("POST", f"/api/v1/projects/{other['id']}/work", {"title": "Not in this project"})
        body = (f"Intro.\n\n[Measure soil moisture first](flux:decision/{accepted['id']})\n\n"
                f"[Add frost warnings later](flux:decision/{proposed['id']})\n\n## Parts\n\n"
                f"Probes: [Order the probes](flux:work/{task['id']}) and [Elsewhere](flux:work/{foreign['id']}).\n")
        doc = api("POST", f"/api/v1/projects/{pid}/docs", {"title": "References", "body": body, "state": "published"}, {"idempotency-key": str(uuid.uuid4())})
        cls.url = f"/projects/{pid}/docs/{doc['id']}"
        cls.number = task["number"]
        cls.state = ctx.storage_state()
        ctx.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def read(self, viewport, touch=False, theme="light"):
        options = dict(base_url=ORIGIN, viewport=viewport, storage_state=self.state, color_scheme=theme, locale="en-GB")
        if touch:
            options.update(is_mobile=True, has_touch=True, device_scale_factor=2)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto(self.url)
        expect(page.get_by_role("heading", level=2, name="References")).to_be_visible()
        return page

    def check(self, page, name, phone):
        task = page.locator("a.doc-task")
        expect(task).to_have_count(1)
        expect(task.locator("svg.ui-glyph--in_progress")).to_have_count(1)
        expect(task).to_contain_text(f"#{self.number}")
        expect(task).to_contain_text("In progress")
        card = page.locator("a.doc-decision")
        expect(card).to_have_count(2)
        first = card.first
        expect(first).to_contain_text("Decision accepted")
        expect(first).to_contain_text("Measure soil moisture first")
        if not phone:
            expect(first.locator(".doc-decision__meta")).to_contain_text("Ada Kowalska")
            expect(first.locator(".doc-decision__meta")).to_contain_text(re.compile(r"\d{1,2} \w{3}|\w{3} \d{1,2}"))
        expect(card.nth(1)).to_contain_text("Decision proposed")
        # A reference that is not in this project stays plain text, without a glyph or card.
        missing = page.locator(".doc-ref--missing")
        expect(missing).to_have_count(1)
        expect(missing.locator("svg")).to_have_count(0)
        shot(page, name)

    def test_computer(self) -> None:
        self.check(self.read(DESKTOP), "wiki-refs-desktop-1440", False)

    def test_phone_dark(self) -> None:
        self.check(self.read(PHONE, touch=True, theme="dark"), "wiki-refs-phone-390-dark", True)


if __name__ == "__main__":
    unittest.main()
