"""Browser tests for Spokój on Home, the Sketchbook and search results (#508, #514, #870).

One account in one workspace with a project, a Wiki page written in Markdown, a task, sketches (one empty,
one with a thought) and notes. Home has no views bar and keeps its quiet links; the Sketchbook is named
"Sketchbook", hides empty sketches and formats note meta without "You · v1"; Search lists its results in groups
by kind, each row 48 px with one plain line, numbers its tasks and has no filters to keep in place.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "quiet things, plainly"
STAMP = int(time.time() * 1000)
PERSON = {"name": "Ada Lindqvist", "email": f"ada.spokoj+{STAMP}@example.test"}


class SpokojHomeSearch(unittest.TestCase):
    """Tests run in name order and share one account and its content."""

    pw = None
    browser: Browser
    state: dict = {}
    ids: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, os.environ.get("FLUX_UI_BROWSER", "chromium")).launch()
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, *, phone: bool = False, dark: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        if self.state:
            options["storage_state"] = self.state
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context

    def page(self, **kwargs) -> Page:
        page = self.context(**kwargs).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method,
                                      headers={"origin": ORIGIN, "content-type": "application/json"},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    # ---------------------------------------------------------------- the account and its content

    def test_01_an_account_with_notes_sketches_and_a_wiki_page(self) -> None:
        page = self.page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill(PERSON["name"])
        page.get_by_label("Email").fill(PERSON["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).state = page.context.storage_state()
        ws = self.api(page, "POST", "/api/v1/workspaces", {"name": "Garden studio"}, status=201)
        project = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Radio garden", "visibility": "workspace"}, status=201)
        body = "## Radio\n\n| Bed | Distance |\n|---|---|\n| North | 3 m |\n\nUse **the radio** near [the gateway](https://example.test/gate) and `set_band()`."
        self.api(page, "POST", f"/api/v1/projects/{project['id']}/docs", {"title": "Radio guide", "body": body, "state": "published"}, status=201)
        for number in range(1, 5):
            self.api(page, "POST", f"/api/v1/projects/{project['id']}/docs", {"title": f"Radio note {number}", "body": "A radio note for the garden.", "state": "published"}, status=201)
        self.api(page, "POST", f"/api/v1/projects/{project['id']}/work", {"title": "Check the radio at the gateway"}, status=201)
        self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/sketches", {"title": "Untitled sketch", "scope": "private"}, status=201)
        named = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/sketches", {"title": "Bed layout", "scope": "private"}, status=201)
        thought = self.api(page, "POST", f"/api/v1/sketches/{named['id']}/thoughts", {"text": "Beans on the south side", "x": 0, "y": 0}, status=201)
        self.api(page, "POST", f"/api/v1/sketches/{named['id']}/thoughts", {"text": "Radio range along the hedge", "x": 240, "y": 0}, status=201)
        self.api(page, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": "Should the radio sit near the gateway?", "clientMessageId": str(uuid.uuid4())}, status=201)
        self.api(page, "POST", f"/api/v1/projects/{project['id']}/decisions", {"title": "Use one radio band for the garden", "rationale": "The gateway hears only one band."}, status=201)
        self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/drafts", {"title": "Ask about the pump", "body": "Ask about the pump at 9 o'clock."}, status=201)
        type(self).ids = {"workspace": ws["id"], "thought": thought["thought"]["id"]}

    # ---------------------------------------------------------------- Home (#508, AC-1)

    def test_02_home_has_no_views_bar_and_keeps_its_quiet_links(self) -> None:
        for kwargs in ({}, {"phone": True}):
            page = self.page(**kwargs)
            page.goto("/")
            expect(page.get_by_role("heading", level=2, name=re.compile("Good "))).to_be_visible()
            self.assertEqual(page.locator(".top__views").count(), 0)
            for name in ("All my tasks", "My map", "Wiki"):
                expect(page.locator(".home__more").get_by_role("link", name=name, exact=True)).to_be_visible()
            self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"))
        page = self.page()
        for path in ("/map",):
            page.goto(path)
            expect(page.get_by_role("heading", level=1).first).to_be_visible()
            self.assertEqual(page.locator(".top__views").count(), 0, path)

    # ---------------------------------------------------------------- the Sketchbook (#508, AC-2 to AC-4)

    def test_03_the_sketchbook_is_named_and_hides_empty_sketches(self) -> None:
        page = self.page()
        page.goto("/map")
        expect(page.get_by_role("heading", level=1, name="My map", exact=True)).to_be_visible()
        expect(page.get_by_text("Only you can see this until you share or move something to a space.")).to_be_visible()
        sketches = page.get_by_role("list", name="Your sketches")
        expect(sketches).to_contain_text("Bed layout")
        expect(sketches).to_contain_text("2 thoughts")
        expect(sketches.get_by_role("link", name=re.compile("Untitled sketch"))).to_have_count(0)
        self.assertEqual(page.locator(".top__views").count(), 0)
        shot(page, "spokoj-sketchbook-desktop")
        phone = self.page(phone=True)
        phone.goto("/map")
        expect(phone.get_by_role("heading", level=1, name="My map", exact=True)).to_be_visible()
        expect(phone.get_by_role("list", name="Your sketches").get_by_role("link", name=re.compile("Untitled sketch"))).to_have_count(0)
        shot(phone, "spokoj-sketchbook-phone")

    def test_04_note_meta_has_no_version_and_no_leading_zero(self) -> None:
        page = self.page()
        page.goto("/map")
        note = page.locator(".note").filter(has_text="Ask about the pump")
        expect(note).to_be_visible()
        meta = note.locator(".note__meta")
        expect(meta).not_to_contain_text("You")
        expect(meta).not_to_contain_text("v1")
        self.assertIsNone(re.search(r"\b0\d:\d\d", meta.inner_text()), meta.inner_text())
        expect(meta.locator(".note__num").first).to_be_visible()

    # ---------------------------------------------------------------- search results (#514, #870)

    def search(self, page: Page, query: str, *, phone: bool = False):
        page.goto("/")
        expect(page.get_by_role("button", name="Search", exact=True).first).to_be_visible()
        if phone:
            page.get_by_role("button", name="Search", exact=True).click()
        else:
            page.keyboard.press("Control+k")
        dialog = page.get_by_role("dialog", name="Search", exact=True)
        dialog.get_by_role("combobox", name="Search", exact=True).fill(query)
        expect(dialog.locator("[role=option].sr").first).to_be_visible()
        return dialog

    def test_05_results_are_grouped_with_plain_one_line_rows(self) -> None:
        page = self.page()
        dialog = self.search(page, "radio")
        headings = dialog.locator(".jump__sh").all_inner_texts()
        for label in ("Tasks", "Messages", "Wiki", "Thoughts"):
            self.assertIn(label, headings)
        rows = dialog.locator("[role=option].sr")
        # Every kind of result is one row of one height: the tile, the matching text and one line under it.
        for index in range(rows.count()):
            self.assertAlmostEqual(rows.nth(index).bounding_box()["height"], 48, delta=2)
        notes = rows.filter(has_text="Radio note")
        expect(notes).to_have_count(4)
        task = rows.filter(has_text="Check the radio at the gateway")
        expect(task.locator(".sr__meta")).to_contain_text("#1")
        expect(task.locator(".sr__meta")).to_contain_text("Radio garden")
        guide = rows.filter(has_text="Radio guide")
        meta = guide.locator(".sr__meta")
        expect(meta).to_be_visible()
        text = meta.inner_text()
        for markup in ("##", "|", "**", "](", "`", "\n"):
            self.assertNotIn(markup, text)
        expect(meta.locator(".sr__hit").first).to_be_visible()
        # A thought on a private map says where it is, once.
        thought = rows.filter(has_text="Radio range along the hedge")
        expect(thought.locator(".sr__meta")).to_have_text("My map · only you")
        shot(page, "spokoj-search-desktop")

    def test_06_nothing_in_the_dialog_has_a_filter_to_keep_in_place(self) -> None:
        page = self.page()
        dialog = self.search(page, "radio")
        self.assertEqual(dialog.get_by_role("group").count(), 0, "no chips")
        self.assertEqual(dialog.get_by_role("combobox").count(), 1, "the field is the only combobox: no Place filter")
        expect(dialog.get_by_text("Show 2 more")).to_have_count(0)
        before = dialog.get_by_role("combobox", name="Search", exact=True).bounding_box()
        dialog.get_by_role("combobox", name="Search", exact=True).fill("radio garden")
        expect(dialog.locator("[role=option].sr").first).to_be_visible()
        after = dialog.get_by_role("combobox", name="Search", exact=True).bounding_box()
        self.assertEqual((before["x"], before["y"]), (after["x"], after["y"]), "the field does not move when the words change")

    def test_07_on_the_phone_search_is_the_one_search_and_fits(self) -> None:
        # The phone has one search: the round Search button's sheet, the same body as the computer's dialog, with no chips.
        page = self.page(phone=True)
        dialog = self.search(page, "radio", phone=True)
        self.assertEqual(dialog.get_by_role("group").count(), 0)
        shot(page, "spokoj-search-phone")
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"))

    # ---------------------------------------------------------------- evidence for the visual review

    def test_08_screens_in_light_and_dark_on_the_computer_and_the_phone(self) -> None:
        for dark in (False, True):
            theme = "dark" if dark else "light"
            for phone in (False, True):
                size = "phone" if phone else "desktop"
                page = self.page(phone=phone, dark=dark)
                page.goto("/")
                expect(page.get_by_role("heading", level=2, name=re.compile("Good "))).to_be_visible()
                shot(page, f"spokoj-home-{size}-{theme}")
                page.goto("/map")
                expect(page.get_by_role("heading", level=1, name="My map", exact=True)).to_be_visible()
                expect(page.get_by_role("list", name="Your sketches")).to_contain_text("Bed layout")
                shot(page, f"spokoj-sketchbook-{size}-{theme}")
                self.search(page, "radio", phone=phone)
                shot(page, f"spokoj-search-{size}-{theme}")

if __name__ == "__main__":
    unittest.main()
