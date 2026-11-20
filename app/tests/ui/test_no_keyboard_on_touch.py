"""No keyboard without a tap on a touch screen (#1546; founder report 2026-11-19, Android: the keyboard opened by itself in the Create window's
tabs, in an agent's chat and in the Assistant's chat).

On a touch phone (has_touch and is_mobile, Chromium's Pixel 7 emulation, which reports `hover: none`) the sweep opens every screen, window, sheet
and menu of the app and asserts after each one that `document.activeElement` is not a text field: opening a screen, a conversation, a thread, a
panel, Create with each of its tabs, Search, the message actions sheet, a Settings page, an agent's chat, sign-in. The write-now actions are
checked the other way: Reply in thread and Edit put the cursor in the field, and a tap on a field focuses it.

Map drafts (the map's "+ Thought" and the dot) are write-now actions of the map; the race of their focus is #1554 and is not part of this sweep.

Runs through scripts/check_ui.sh; FLUX_UI_BROWSER selects the engine.
"""

from __future__ import annotations

import re
import unittest
import uuid

from playwright.sync_api import Page, expect, sync_playwright

import phone_world
from inbox_items import open_item
from phone_audit import window
from test_app_shell import ORIGIN, UI_BROWSER, UPSTREAM, start_forwarder

STAMP = uuid.uuid4().hex[:8]

# The element that has the focus if it is a text field (a tap would raise the keyboard on it), else null.
TEXT_FIELD_FOCUSED = """() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  const text = el.tagName === 'TEXTAREA' || el.isContentEditable
    || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image', 'range', 'hidden'].includes(type));
  return text ? `${el.tagName.toLowerCase()}#${el.id}[${el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.className}]` : null;
}"""


class NoKeyboardOnTouch(unittest.TestCase):
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

    def phone(self, *, signed_in: bool = True) -> Page:
        state = self.world["states"]["ada"] if signed_in else {"cookies": [], "origins": []}
        context = window(self.pw, self.browser, UI_BROWSER, ORIGIN, state, 390, 844)
        self.addCleanup(context.close)
        page = context.new_page()
        self.assertTrue(page.evaluate("matchMedia('(hover: none)').matches"), "the emulation is a touch screen")
        return page

    def calm(self, page: Page, label: str, wait: int = 1000) -> None:
        """What has the focus once the screen has settled (arrival focus comes after the reads, a sheet's after its motion)."""
        page.wait_for_timeout(wait)
        self.assertIsNone(page.evaluate(TEXT_FIELD_FOCUSED), f"{label}: a text field took the focus by itself")

    def visit(self, page: Page, path: str, label: str, *, wait: int = 1000) -> None:
        page.goto(path)
        expect(page.locator("#root")).not_to_be_empty()
        page.wait_for_load_state("networkidle")
        self.calm(page, label, wait)

    @property
    def ids(self) -> dict:
        return self.world["ids"]

    def test_01_every_screen_opens_without_the_keyboard(self) -> None:
        page = self.phone()
        project = f"/projects/{self.ids['project']}"
        routes = [
            ("/", "Home"), ("/projects", "Spaces"), (project, "a space's conversation"), (f"{project}/conversations/{self.ids['conversation']}", "a thread"),
            (f"{project}/tasks", "the space's Tasks"), (f"{project}/map", "the space's Map"), (f"{project}/docs", "the space's Wiki"),
            (f"{project}/settings", "Space settings"), (f"{project}?open=work:{self.ids['task']}", "a task's panel"),
            (f"{project}?open=decision:{self.ids['decision']}", "a decision's panel"), ("/tasks", "My tasks"), ("/map", "My map"),
            ("/dm", "Messages"), ("/dm/new", "New message"), (f"/dm/{self.ids['dm']}", "a direct message"), ("/inbox", "the Inbox"),
            (f"/agents/{self.ids['agent']}", "an agent's chat"), (f"/settings/agents/{self.ids['agent']}", "an agent's page"),
            ("/settings", "Settings"), ("/settings/appearance", "Appearance"), ("/settings/account", "Account"), ("/settings/company", "Company"),
            ("/settings/notifications", "Notifications"), ("/settings/agents", "Agents"), ("/settings/ai-connections", "AI connections"),
            ("/settings/shortcuts", "Shortcuts"),
        ]
        for path, label in routes:
            self.visit(page, path, label)

    def test_02_an_inbox_item_opens_without_the_keyboard(self) -> None:
        page = self.phone()
        self.visit(page, "/inbox", "the Inbox")
        row = page.locator(".nyc").first
        open_item(row)
        self.calm(page, "an Inbox item")

    def test_03_the_create_window_shows_each_tab_without_the_keyboard(self) -> None:
        page = self.phone()
        self.visit(page, "/projects", "Spaces")
        page.get_by_role("button", name="Create", exact=True).click()
        create = page.get_by_role("dialog", name=re.compile(r"^New (task|thought|decision|page|space)$"))
        expect(create).to_be_visible()
        self.calm(page, "the Create window opened on Task")
        for tab in ("Thought", "Decision", "Page", "Task"):
            create.get_by_role("tablist", name="Create").get_by_role("tab", name=tab, exact=True).click()
            expect(create.get_by_role("tab", name=tab, exact=True)).to_have_attribute("aria-selected", "true")
            self.calm(page, f"the Create window's {tab} tab", 600)
        create.get_by_role("tab", name="Space", exact=True).click()
        expect(page.get_by_role("dialog", name="New space")).to_be_visible()
        self.calm(page, "the Create window's Space tab", 600)
        # A tap on a field is what raises the keyboard. Back closes the window (nothing in it has the focus for Esc).
        page.go_back()
        expect(page.get_by_role("dialog")).to_have_count(0)
        page.get_by_role("button", name="Create", exact=True).click()
        field = page.get_by_role("dialog", name="New task").get_by_label("Title", exact=True)
        expect(field).to_be_visible()
        self.calm(page, "the Create window opened again", 600)
        field.tap()
        expect(field).to_be_focused()

    def test_04_search_and_the_message_sheet_open_without_the_keyboard(self) -> None:
        page = self.phone()
        self.visit(page, "/projects", "Spaces")
        page.get_by_role("button", name="Search", exact=True).click()
        expect(page.get_by_role("dialog")).to_be_visible()
        self.calm(page, "Search")
        page.keyboard.press("Escape")
        self.visit(page, f"/projects/{self.ids['project']}", "a space's conversation")
        page.locator(".msg-touch__sr").first.click()
        expect(page.get_by_role("dialog", name="Message")).to_be_visible()
        self.calm(page, "the message actions sheet", 600)
        page.keyboard.press("Escape")
        page.get_by_role("button", name=re.compile("^More")).first.click()
        expect(page.get_by_role("menu")).to_be_visible()
        self.calm(page, "the space's ⋯ menu", 600)

    def test_05_the_assistant_opens_without_the_keyboard(self) -> None:
        page = self.phone()
        self.visit(page, "/projects", "Spaces")
        assistant = page.get_by_role("link", name=re.compile("^Assistant"))
        if not assistant.count():
            self.skipTest("this install has no Assistant row in Spaces (it needs the runtime); an agent's chat is covered by the sweep")
        assistant.first.click()
        page.wait_for_load_state("networkidle")
        self.calm(page, "the Assistant's chat")

    def test_06_signed_out_screens_open_without_the_keyboard(self) -> None:
        page = self.phone(signed_in=False)
        for path, label in (("/sign-in", "Sign in"), ("/sign-up", "Create account"), ("/forgot-password", "Forgot password")):
            self.visit(page, path, label)

    def test_07_reply_in_thread_and_edit_are_write_now_actions_that_focus_the_field(self) -> None:
        page = self.phone()
        self.visit(page, f"/projects/{self.ids['project']}", "a space's conversation")
        # Reply in thread, from the message actions sheet: the cursor is in the thread's reply field.
        page.locator(".msg-touch__sr").first.click()
        page.get_by_role("menuitem", name="Reply in thread").click()
        expect(page.locator("#thread-composer")).to_be_focused()
        # Edit, on a message of Ada's own: the cursor is in the edit field.
        self.visit(page, f"/projects/{self.ids['project']}", "a space's conversation again")
        own = page.locator(".msg-touch", has_text="Soil probes arrive on Friday.")
        own.locator(".msg-touch__sr").click()
        page.get_by_role("menuitem", name="Edit", exact=True).click()
        expect(page.locator("textarea:focus")).to_have_count(1)


if __name__ == "__main__":
    unittest.main()
