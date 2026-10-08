"""Browser tests for Settings (#350, F-026 "Prostota"): Account, Appearance, Notifications, Agents and AI and
Keyboard shortcuts, at 1440 × 900 and on a 390 × 844 touch phone, in light and dark.

Runs with the other tests/ui modules through scripts/check_ui.sh against the running Compose application.
Every step that changes something is checked in the running app (the root's data attributes, storage and
the API), each with a negative control. Screenshots (settings-*.png) go to FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import re
import time
import unittest

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, box, shot, start_forwarder

PASSWORD = "settings stay calm and findable"
STAMP = int(time.time() * 1000)
NAME, EMAIL = "Ada Kowalska", f"ada.settings+{STAMP}@example.test"
SECTIONS = ["Account", "Appearance", "Notifications", "Agents and AI", "Keyboard shortcuts"]
# Guide §4, in order: every shortcut and its action.
SHORTCUTS = [
    ("C", "New (task by default)"), ("⌘K", "Search or run"), ("GI", "Go to Inbox"), ("JorK", "Move in a list"), ("E", "Done"),
    ("S", "Not now"), ("A", "Accept"), ("Z", "Undo"), ("R", "Reply in thread"), ("T", "Create a task from a message"),
    ("1to5", "Task state"), ("[", "Collapse the sidebar"), ("F", "Focus mode"), ("Esc", "Close a panel or menu"),
]
TOUCH = 43.99  # 44 px, allowing for sub-pixel layout noise


class SettingsJourney(unittest.TestCase):
    pw = None
    browser: Browser
    state: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=15000)
        context = cls.browser.new_context(base_url=ORIGIN)
        response = context.request.post("/api/auth/sign-up/email", data={"email": EMAIL, "password": PASSWORD, "name": NAME}, headers={"origin": ORIGIN})
        assert response.status == 200, response.text()
        space = context.request.post("/api/v1/workspaces", data={"name": "Riverside Makers"}, headers={"origin": ORIGIN})
        assert space.status == 201, space.text()
        cls.state = context.storage_state()
        context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, *, phone: bool = False, dark: bool = False, signed_in: bool = True) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
        if signed_in:
            options["storage_state"] = self.state
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        context: BrowserContext = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def no_colour_picker(self, page: Page) -> None:
        expect(page.locator("input[type=color]")).to_have_count(0)
        expect(page.get_by_text(re.compile("accent", re.I)).filter(has_not_text="no accent")).to_have_count(0)
        self.assertEqual(page.evaluate("Object.keys(localStorage).filter(k => k.startsWith('flux.accent'))"), [])

    # ---------------------------------------------------------------- computer

    def test_01_sections_and_appearance_on_the_computer(self) -> None:
        page = self.page()
        page.goto("/settings")
        expect(page.locator("header.top").get_by_role("heading", level=1, name="Settings")).to_be_visible()
        nav = page.get_by_role("navigation", name="Settings sections")
        self.assertEqual(nav.get_by_role("link").all_inner_texts(), SECTIONS)
        expect(nav.get_by_role("link", name="Appearance")).to_have_attribute("aria-current", "page")
        expect(nav.get_by_role("link", name="Notifications")).not_to_have_attribute("aria-current", "page")
        expect(page.get_by_role("heading", level=2, name="Appearance")).to_be_visible()

        themes = page.get_by_role("radiogroup", name="Theme")
        self.assertEqual(themes.get_by_role("radio").all_inner_texts(), ["Light", "Dark", "Match system"])
        expect(themes.get_by_role("radio", name="Match system")).to_be_checked()
        self.no_colour_picker(page)
        shot(page, "settings-desktop-1440-appearance-light")

        # Dark applies at once and is stored; Match system forgets it again. Arrow keys move the choice.
        themes.get_by_role("radio", name="Dark").click()
        self.assertEqual(page.evaluate("[document.documentElement.dataset.theme, localStorage.getItem('flux.theme')]"), ["dark", "dark"])
        expect(themes.get_by_role("radio", name="Dark")).to_be_focused()
        page.keyboard.press("ArrowRight")
        expect(themes.get_by_role("radio", name="Match system")).to_be_checked()
        self.assertEqual(page.evaluate("[document.documentElement.dataset.theme ?? null, localStorage.getItem('flux.theme')]"), [None, None])
        page.keyboard.press("ArrowLeft")
        expect(themes.get_by_role("radio", name="Dark")).to_be_checked()
        page.reload()
        expect(page.get_by_role("radiogroup", name="Theme").get_by_role("radio", name="Dark")).to_be_checked()
        self.no_colour_picker(page)
        shot(page, "settings-desktop-1440-appearance-dark")
        page.get_by_role("radiogroup", name="Theme").get_by_role("radio", name="Light").click()
        self.assertEqual(page.evaluate("document.documentElement.dataset.theme"), "light")

    def test_02_kreska_small_moments_switch_persists(self) -> None:
        page = self.page()
        page.goto("/settings")
        switch = page.get_by_role("switch", name="Kreska in loading and empty screens")
        expect(switch).to_have_attribute("aria-checked", "true")
        self.assertIsNone(page.evaluate("document.documentElement.dataset.kreska ?? null"), "on by default")
        switch.click()
        expect(switch).to_have_attribute("aria-checked", "false")
        self.assertEqual(page.evaluate("[document.documentElement.dataset.kreska, localStorage.getItem('flux.kreska')]"), ["off", "off"])
        page.reload()
        expect(page.get_by_role("switch", name="Kreska in loading and empty screens")).to_have_attribute("aria-checked", "false")
        self.assertEqual(page.evaluate("document.documentElement.dataset.kreska"), "off", "applied before the page renders")
        # Negative control: another device (a fresh browser) keeps its own choice, on.
        other = self.page()
        other.goto("/settings")
        expect(other.get_by_role("switch", name="Kreska in loading and empty screens")).to_have_attribute("aria-checked", "true")
        page.get_by_role("switch", name="Kreska in loading and empty screens").press("Space")
        expect(page.get_by_role("switch", name="Kreska in loading and empty screens")).to_have_attribute("aria-checked", "true")
        self.assertIsNone(page.evaluate("localStorage.getItem('flux.kreska')"))

    def test_03_agents_and_ai_keep_every_existing_setting(self) -> None:
        page = self.page()
        page.goto("/settings")
        expect(page.get_by_role("heading", level=2, name="Agents and AI")).to_be_visible()
        page.get_by_role("navigation", name="Settings sections").get_by_role("link", name="Agents and AI").click()
        expect(page).to_have_url(re.compile(r"/settings/agents$"))
        cards = page.locator(".sset-card")
        expect(page.get_by_role("link", name=re.compile("^Local co-work on this computer"))).to_have_attribute("href", "/connect-agent")
        assistant = page.get_by_role("link", name=re.compile("^Your assistant · for you"))
        expect(assistant).to_have_attribute("href", "/settings/assistant")
        expect(page.get_by_role("link", name=re.compile("^Background suggestions"))).to_have_attribute("href", "/settings/background-compute")
        # Agents have their colour here (and only in the Agents section); the Appearance switch's Kreska is monochrome.
        self.assertRegex(assistant.locator(".kreska").get_attribute("class") or "", r"kreska--(clay|ochre|sage|teal|indigo|plum|rose)")
        page.goto("/settings")
        self.assertNotRegex(page.get_by_role("switch", name="Kreska in loading and empty screens").locator("xpath=..").locator(".kreska").get_attribute("class") or "", r"kreska--")
        expect(cards.first).to_be_visible()
        page.goto("/settings/agents")
        assistant = page.get_by_role("link", name=re.compile("^Your assistant · for you"))
        assistant.click()
        expect(page).to_have_url(re.compile(r"/settings/assistant$"))
        expect(page.locator("header.top").get_by_role("heading", level=1, name="Your assistant")).to_be_visible()
        expect(page.get_by_role("navigation", name="Settings sections").get_by_role("link", name="Agents and AI")).to_have_attribute("aria-current", "page")
        shot(page, "settings-desktop-1440-assistant")

    def test_04_keyboard_shortcuts_list_every_key_of_the_guide(self) -> None:
        page = self.page()
        page.goto("/settings/shortcuts")
        expect(page.get_by_role("heading", level=2, name="Keyboard shortcuts")).to_be_visible()
        rows = page.get_by_role("table", name="Keyboard shortcuts").locator("tbody tr")
        expect(rows).to_have_count(len(SHORTCUTS))
        found = [(re.sub(r"\s+", "", row.locator("td").inner_text()), row.locator("th").inner_text()) for row in rows.all()]
        self.assertEqual(found, SHORTCUTS)
        shot(page, "settings-desktop-1440-shortcuts")

    def test_05_account_and_earlier_addresses_keep_a_home(self) -> None:
        page = self.page()
        page.goto("/settings/account")
        me = page.get_by_label("Signed in as")
        expect(me.get_by_text(NAME, exact=True)).to_be_visible()
        expect(me.get_by_text(EMAIL)).to_be_visible()
        expect(page.get_by_text(re.compile("^Signed in on this device until"))).to_be_visible()
        expect(page.get_by_role("button", name=re.compile("^Sign out"))).to_be_visible()
        nav = page.get_by_role("navigation", name="Settings sections")
        for path, current in (("/settings/notifications", "Notifications"), ("/settings/appearance", "Appearance"),
                              ("/settings/background-compute", "Agents and AI"), ("/settings/notifications/verify?token=nope", "Notifications")):
            page.goto(path)
            expect(nav.get_by_role("link", name=current)).to_have_attribute("aria-current", "page")
        expect(page.get_by_role("heading", name="This link did not work")).to_be_visible()
        # Back and history are kept across sections.
        page.goto("/settings/shortcuts")
        nav.get_by_role("link", name="Account").click()
        expect(page).to_have_url(re.compile(r"/settings/account$"))
        page.go_back()
        expect(page).to_have_url(re.compile(r"/settings/shortcuts$"))

    # ---------------------------------------------------------------- phone

    def phone_rows(self, page: Page) -> None:
        heights = page.locator(".sset-row, .sset-theme").evaluate_all("els => els.filter(e => e.offsetParent).map(e => e.getBoundingClientRect().height)")
        self.assertTrue(heights, "rows are rendered")
        self.assertTrue(all(height >= TOUCH for height in heights), f"every row is at least 44 px: {heights}")
        self.assertLessEqual(page.evaluate("document.scrollingElement.scrollWidth"), PHONE["width"], "no sideways scroll")

    def test_06_phone_settings_page_with_44px_rows(self) -> None:
        for dark in (False, True):
            page = self.page(phone=True, dark=dark)
            page.goto("/settings")
            expect(page.get_by_role("radiogroup", name="Theme")).to_be_visible()
            expect(page.get_by_role("navigation", name="Settings sections")).to_have_count(0)
            self.assertEqual(page.locator(".sset-in > h2.sset-sec").all_inner_texts(), ["Appearance", "This phone", "Agents and AI", "More"])
            themes = page.get_by_role("radiogroup", name="Theme")
            self.assertEqual(themes.get_by_role("radio").all_inner_texts(), ["Light", "Dark", "System"])
            expect(page.get_by_text("One neutral palette. There is no accent color to pick.")).to_be_visible()
            expect(page.get_by_role("switch", name="Kreska in small moments")).to_be_visible()
            expect(page.get_by_text("Notifications on this phone")).to_be_visible()
            self.no_colour_picker(page)
            self.phone_rows(page)
            shot(page, f"settings-phone-390-settings-{'dark' if dark else 'light'}")
            themes.get_by_role("radio", name="Light" if dark else "Dark").tap()
            self.assertEqual(page.evaluate("document.documentElement.dataset.theme"), "light" if dark else "dark")

    def test_07_phone_sections_open_as_pages_with_back(self) -> None:
        page = self.page(phone=True)
        page.goto("/settings")
        page.get_by_role("link", name=re.compile("^Notifications")).tap()
        expect(page).to_have_url(re.compile(r"/settings/notifications$"))
        expect(page.get_by_role("heading", level=2, name="Notifications")).to_be_visible()
        expect(page.get_by_role("radio", name="Only “Needs you”")).to_be_checked()
        self.phone_rows(page)
        shot(page, "settings-phone-390-notifications-light")
        page.get_by_role("button", name="Back").tap()
        expect(page).to_have_url(re.compile(r"/settings$"))
        page.get_by_role("link", name=re.compile("^Keyboard shortcuts")).tap()
        expect(page.get_by_role("table", name="Keyboard shortcuts").locator("tbody tr")).to_have_count(len(SHORTCUTS))
        page.get_by_role("button", name="Back").tap()
        page.get_by_role("link", name=re.compile("^Account")).tap()
        expect(page.get_by_role("button", name=re.compile("^Sign out"))).to_be_visible()
        self.phone_rows(page)
        dark = self.page(phone=True, dark=True)
        dark.goto("/settings/notifications")
        expect(dark.get_by_role("radio", name="Only “Needs you”")).to_be_checked()
        shot(dark, "settings-phone-390-notifications-dark")


if __name__ == "__main__":
    unittest.main()
