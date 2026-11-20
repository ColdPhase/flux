"""Back closes what sits on top, and a space's views are one place (#1545, #1547; founder report 2026-11-19, Android).

On a touch phone (Chromium, 390 x 844):

- #1545: Back with the message actions sheet or the Create window open closes it and stays on the page; the next Back leaves the page. A sheet
  closed with its own control (Esc, a tap on the scrim) leaves no dead Back: the next Back leaves the page at once.
- #1547: choosing Conversation, Tasks, Map and Wiki adds no history entry, so the phone's Back and the header's Back leave the space for where the
  person came from; the same with the browser's Back on a computer. Inside a view Back still closes a panel opened with `?open=`.

Runs through scripts/check_ui.sh; FLUX_UI_BROWSER selects the engine.
"""

from __future__ import annotations

import re
import unittest
import uuid

from playwright.sync_api import Page, expect, sync_playwright

import phone_world
from phone_audit import window
from test_app_shell import ORIGIN, UI_BROWSER, UPSTREAM, start_forwarder

STAMP = uuid.uuid4().hex[:8]


class PhoneBack(unittest.TestCase):
    pw = None
    browser = None
    world: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)
        cls.world = phone_world.build(cls.browser, ORIGIN, STAMP)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, *, computer: bool = False) -> Page:
        width, height = (1440, 900) if computer else (390, 844)
        context = window(self.pw, self.browser, UI_BROWSER, ORIGIN, self.world["states"]["ada"], width, height, kind="computer" if computer else "phone")
        self.addCleanup(context.close)
        return context.new_page()

    def path(self, page: Page) -> str:
        return re.sub(r"^https?://[^/]+", "", page.url)

    def entries(self, page: Page) -> int:
        return page.evaluate("history.length")

    def into_the_space(self, page: Page) -> None:
        """Home, then Spaces, then the space: three entries the person came through."""
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        page.get_by_role("navigation").get_by_role("link", name="Spaces").first.click()
        expect(page).to_have_url(re.compile(r"/projects$"))
        page.get_by_role("link", name=re.compile("Community garden sensors")).first.click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.world['ids']['project']}$"))
        expect(page.locator(".msg-touch__sr").first).to_be_visible()

    def open_message_sheet(self, page: Page):
        page.locator(".msg-touch__sr").first.click()
        sheet = page.get_by_role("dialog", name="Message")
        expect(sheet).to_be_visible()
        return sheet

    def test_01_back_closes_the_message_actions_sheet_then_leaves_the_space(self) -> None:
        page = self.page()
        self.into_the_space(page)
        sheet = self.open_message_sheet(page)
        page.go_back()
        expect(sheet).to_have_count(0)
        expect(page).to_have_url(re.compile(rf"/projects/{self.world['ids']['project']}$"))
        expect(page.locator(".msg-touch__sr").first).to_be_visible()
        page.go_back()
        expect(page).to_have_url(re.compile(r"/projects$"))

    def test_02_a_sheet_closed_with_its_own_control_leaves_no_dead_back(self) -> None:
        page = self.page()
        self.into_the_space(page)
        sheet = self.open_message_sheet(page)
        page.keyboard.press("Escape")
        expect(sheet).to_have_count(0)
        page.go_back()
        expect(page).to_have_url(re.compile(r"/projects$"))
        # And again, the sheet opened and closed twice before the person goes back.
        page.go_forward()
        expect(page).to_have_url(re.compile(rf"/projects/{self.world['ids']['project']}$"))
        for _ in range(2):
            sheet = self.open_message_sheet(page)
            page.keyboard.press("Escape")
            expect(sheet).to_have_count(0)
        page.go_back()
        expect(page).to_have_url(re.compile(r"/projects$"))

    def test_03_back_closes_the_create_window_then_leaves_the_page(self) -> None:
        page = self.page()
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        page.get_by_role("navigation").get_by_role("link", name="Spaces").first.click()
        expect(page).to_have_url(re.compile(r"/projects$"))
        page.get_by_role("button", name="Create", exact=True).click()
        window_ = page.get_by_role("dialog")
        expect(window_).to_be_visible()
        page.go_back()
        expect(window_).to_have_count(0)
        expect(page).to_have_url(re.compile(r"/projects$"))
        page.go_back()
        expect(page).to_have_url(re.compile(r"/$"))

    def test_04_a_page_made_from_the_create_window_is_followed_by_back_to_where_it_was_made(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.world['ids']['project']}/tasks")
        expect(page.get_by_role("heading", level=1, name="Community garden sensors")).to_be_visible()
        page.get_by_role("button", name="Create", exact=True).click()
        window_ = page.get_by_role("dialog", name="New task")
        expect(window_).to_be_visible()
        window_.get_by_label("Title", exact=True).fill("Check the gateway antenna")
        window_.get_by_role("button", name=re.compile("^Create task")).click()
        expect(window_).to_have_count(0)
        expect(page.get_by_text("Check the gateway antenna").first).to_be_visible()
        page.go_back()
        # Back from what Create made returns to the page it was opened from; the Create window is not open again (the task's panel, which the
        # return restores as it does for every entry, is not what this checks).
        page.wait_for_timeout(1000)
        expect(page.get_by_role("dialog", name=re.compile(r"^New (task|thought|decision|page|space)$"))).to_have_count(0)
        expect(page).to_have_url(re.compile(rf"/projects/{self.world['ids']['project']}/tasks"))

    def test_05_the_views_of_a_space_add_no_history_entry_and_back_leaves_the_space(self) -> None:
        page = self.page()
        self.into_the_space(page)
        before = self.entries(page)
        views = page.get_by_role("tablist", name="Space views")
        for name, pattern in (("Tasks", r"/tasks"), ("Map", r"/map"), ("Wiki", r"/docs"), ("Conversation", r"/projects/[0-9a-f-]{36}$")):
            views.get_by_role("tab", name=re.compile(f"^{name}")).click()
            expect(page).to_have_url(re.compile(pattern))
        views.get_by_role("tab", name=re.compile("^Tasks")).click()
        expect(page).to_have_url(re.compile(r"/tasks"))
        self.assertEqual(self.entries(page), before, "choosing a view replaces the entry")
        page.go_back()
        expect(page).to_have_url(re.compile(r"/projects$"))

    def test_06_the_headers_back_leaves_the_space_after_the_views_were_switched(self) -> None:
        page = self.page()
        self.into_the_space(page)
        views = page.get_by_role("tablist", name="Space views")
        for name in ("Tasks", "Map", "Wiki"):
            views.get_by_role("tab", name=re.compile(f"^{name}")).click()
        expect(page).to_have_url(re.compile(r"/docs"))
        page.get_by_role("button", name="Back", exact=True).click()
        expect(page).to_have_url(re.compile(r"/projects$"))

    def test_07_inside_a_view_back_still_closes_what_is_open_on_top(self) -> None:
        page = self.page()
        self.into_the_space(page)
        page.get_by_role("tablist", name="Space views").get_by_role("tab", name=re.compile("^Tasks")).click()
        expect(page).to_have_url(re.compile(r"/tasks"))
        page.goto(f"/projects/{self.world['ids']['project']}/tasks")
        page.get_by_text("Order the replacement probes from the blue box").first.click()
        expect(page).to_have_url(re.compile(r"open=work"))
        page.go_back()
        expect(page).to_have_url(re.compile(r"/tasks$"))

    def test_07b_every_menu_and_panel_over_a_page_takes_the_first_back(self) -> None:
        page = self.page()
        # A space's ⋯ menu.
        self.into_the_space(page)
        page.get_by_role("button", name=re.compile("^More")).first.click()
        menu = page.get_by_role("menu").first
        expect(menu).to_be_visible()
        page.go_back()
        expect(menu).to_have_count(0)
        expect(page).to_have_url(re.compile(rf"/projects/{self.world['ids']['project']}$"))
        # A direct message: its ⋯, then People and privacy, a panel without an address of its own.
        page.goto(f"/dm/{self.world['ids']['dm']}")
        expect(page.get_by_role("heading", level=1, name=re.compile("Kai"))).to_be_visible()
        page.get_by_role("button", name=re.compile("^More")).first.click()
        page.get_by_role("menuitem", name=re.compile("People and privacy")).click()
        panel = page.get_by_role("dialog").first
        expect(panel).to_be_visible()
        page.go_back()
        expect(page.get_by_role("dialog")).to_have_count(0)
        expect(page).to_have_url(re.compile(rf"/dm/{self.world['ids']['dm']}$"))

    def test_07c_over_a_task_back_closes_the_status_sheet_and_leaves_the_task_open(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.world['ids']['project']}/tasks")
        page.get_by_text("Order the replacement probes from the blue box").first.click()
        expect(page).to_have_url(re.compile(r"open=work"))
        panel = page.locator("#details")
        expect(panel).to_be_visible()
        panel.get_by_role("button", name="Status", exact=True).click()
        sheet = page.get_by_role("dialog", name="Status")
        expect(sheet).to_be_visible()
        page.go_back()
        expect(sheet).to_have_count(0)
        expect(page.locator("#details")).to_be_visible()
        expect(page).to_have_url(re.compile(r"open=work"))
        page.go_back()
        expect(page).to_have_url(re.compile(r"/tasks$"))

    def test_07d_a_view_chosen_after_a_sheet_closed_with_a_choice_still_leaves_the_space_on_back(self) -> None:
        # Review of #1597: the entry a closed sheet leaves behind, replaced by the view the person chooses next, is still the space: Back leaves it
        # and never walks back to the view the sheet was opened on.
        page = self.page()
        self.into_the_space(page)
        sheet = self.open_message_sheet(page)
        page.keyboard.press("Escape")
        expect(sheet).to_have_count(0)
        views = page.get_by_role("tablist", name="Space views")
        views.get_by_role("tab", name=re.compile("^Tasks")).click()
        expect(page).to_have_url(re.compile(r"/tasks"))
        views.get_by_role("tab", name=re.compile("^Map")).click()
        expect(page).to_have_url(re.compile(r"/map"))
        page.go_back()
        expect(page).to_have_url(re.compile(r"/projects$"))

    def test_07e_back_after_a_choice_in_a_sheet_over_the_create_window_closes_the_window(self) -> None:
        # Review of #1597: a day chosen in the Due sheet over the Create window closes the sheet; the next Back closes the window (no Back that does
        # nothing), and the one after leaves the page.
        page = self.page()
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        page.get_by_role("navigation").get_by_role("link", name="Spaces").first.click()
        expect(page).to_have_url(re.compile(r"/projects$"))
        page.goto(f"/projects/{self.world['ids']['project']}/tasks")
        expect(page.get_by_role("heading", level=1, name="Community garden sensors")).to_be_visible()
        page.get_by_role("button", name="Create", exact=True).click()
        window_ = page.get_by_role("dialog", name="New task")
        expect(window_).to_be_visible()
        window_.get_by_role("button", name="Due, add a date").click()
        page.get_by_role("button", name="Tomorrow", exact=True).click()
        expect(window_.get_by_role("button", name=re.compile(r"^Due \d"))).to_be_visible()
        expect(page.get_by_role("dialog")).to_have_count(1)
        page.go_back()
        expect(page.get_by_role("dialog")).to_have_count(0)
        expect(page).to_have_url(re.compile(r"/tasks$"))
        page.go_back()
        expect(page).to_have_url(re.compile(r"/projects$"))

    def test_08_on_a_computer_the_browsers_back_leaves_the_space_too(self) -> None:
        page = self.page(computer=True)
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        page.get_by_role("complementary", name="Sidebar").get_by_role("link", name=re.compile("Community garden sensors")).first.click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.world['ids']['project']}$"))
        before = self.entries(page)
        views = page.get_by_role("tablist", name="Space views")
        for name in ("Tasks", "Map", "Wiki", "Conversation"):
            views.get_by_role("tab", name=re.compile(f"^{name}")).click()
            expect(views.get_by_role("tab", name=re.compile(f"^{name}"))).to_have_attribute("aria-selected", "true")
        self.assertEqual(self.entries(page), before)
        page.go_back()
        expect(page).to_have_url(re.compile(r"/$"))


if __name__ == "__main__":
    unittest.main()
