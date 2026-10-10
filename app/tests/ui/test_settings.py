"""Browser tests for Settings (#350, F-026 "Prostota"): Account, Appearance, Notifications, Agents and AI and
Keyboard shortcuts, at 1440 × 900 and on a 390 × 844 touch phone, in light and dark.

Runs with the other tests/ui modules through scripts/check_ui.sh against the running Compose application.
Every step that changes something is checked in the running app (the root's data attributes, storage and
the API), each with a negative control. FLUX_UI_BROWSER selects chromium (default) or webkit.
Screenshots (settings-*-<browser>.png) go to FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import os
import re
import time
import unittest

from playwright.sync_api import Browser, BrowserContext, Locator, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, box, shot as save_shot, start_forwarder
from touch_targets import has_minimum_touch_size

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")

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


def shot(page: Page, name: str) -> None:
    save_shot(page, f"{name}-{UI_BROWSER}")


def assert_touch_target(case: unittest.TestCase, page: Page, control: Locator) -> None:
    """Measure a native control's actual hit area, including an associated label or switch halo."""
    case.assertTrue(control.evaluate("el => el.matches('button, input, select, a[href]')"), "measure a native control, not a decorative row")
    target = control
    if control.evaluate("el => el.matches('input') && el.closest('label')?.control === el"):
        target = control.locator("xpath=ancestor::label[1]")
    target.scroll_into_view_if_needed()
    target.evaluate("el => el.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'})")
    measured = target.evaluate("""el => {
      const rect = el.getBoundingClientRect();
      let left = rect.left, top = rect.top, width = rect.width, height = rect.height;
      // The switch track is deliberately smaller than its native button's ::after hit area.
      // Read that actual box and prove that its perimeter belongs to the button, rather than
      // counting the surrounding non-interactive .sset-row as a target.
      if (el.matches('button.sset-switch')) {
        const after = getComputedStyle(el, '::after');
        if (after.content !== 'none' && after.display !== 'none' && after.pointerEvents !== 'none') {
          const values = [after.left, after.top, after.width, after.height].map(parseFloat);
          if (values.every(Number.isFinite) && values[2] > 0 && values[3] > 0) {
            [left, top, width, height] = [rect.left + values[0], rect.top + values[1], values[2], values[3]];
          }
        }
      }
      // Prove a usable 44 px core, not every pixel of a larger decorative box. This
      // allows an Inbox row's separate read button while rejecting a blocked switch halo.
      // Edge midpoints also work for circular and pill-shaped native targets.
      const coreWidth = Math.min(width, 44), coreHeight = Math.min(height, 44);
      const x = (width - coreWidth) / 2, y = (height - coreHeight) / 2;
      const positions = [[x + .5, height / 2], [x + coreWidth - .5, height / 2], [width / 2, y + .5], [width / 2, y + coreHeight - .5], [width / 2, height / 2]];
      return {width, height, hittable: positions.every(([x, y]) => {
        const hit = document.elementFromPoint(left + x, top + y);
        return hit === el || (hit !== null && el.contains(hit));
      })};
    }""")
    name = control.get_attribute("aria-label") or control.inner_text() or control.get_attribute("name") or control.get_attribute("type")
    case.assertTrue(has_minimum_touch_size(measured["width"]) and has_minimum_touch_size(measured["height"]), f"44 × 44 px touch target {name!r}: {measured}")
    case.assertTrue(measured["hittable"], f"the measured hit area belongs to {name!r}: {measured}")


def has_visible_colour(value: str) -> bool:
    """True for a computed rgb()/rgba() colour whose alpha is above zero; 'transparent' is not visible."""
    match = re.fullmatch(r"rgba?\(([^)]*)\)", value.strip())
    if match is None:
        return False
    parts = [part.strip() for part in match.group(1).split(",")]
    return (float(parts[3]) if len(parts) == 4 else 1.0) > 0


def assert_halo_touch_target(case: unittest.TestCase, link: Locator) -> None:
    """Measure a text link's declared ::after hit area (the coarse-pointer halo in app.css), not its text box."""
    case.assertTrue(link.evaluate("el => el.matches('a[href]')"), "measure a link")
    link.evaluate("el => el.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'})")
    measured = link.evaluate("""el => {
      const rect = el.getBoundingClientRect();
      const after = getComputedStyle(el, '::after');
      const values = [after.left, after.top, after.width, after.height].map(parseFloat);
      const declared = after.content !== 'none' && after.display !== 'none' && after.pointerEvents !== 'none'
        && values.every(Number.isFinite) && values[2] > 0 && values[3] > 0;
      if (!declared) return {width: rect.width, height: rect.height, hittable: false, declared: false};
      const left = rect.left + values[0], top = rect.top + values[1], width = values[2], height = values[3];
      // Same 44 px core and edge midpoints as assert_touch_target: every point must hit the link itself.
      const coreWidth = Math.min(width, 44), coreHeight = Math.min(height, 44);
      const x = (width - coreWidth) / 2, y = (height - coreHeight) / 2;
      const positions = [[x + .5, height / 2], [x + coreWidth - .5, height / 2], [width / 2, y + .5], [width / 2, y + coreHeight - .5], [width / 2, height / 2]];
      return {width, height, declared: true, hittable: positions.every(([px, py]) => {
        const hit = document.elementFromPoint(left + px, top + py);
        return hit === el || (hit !== null && el.contains(hit));
      })};
    }""")
    name = link.inner_text()
    case.assertTrue(measured["declared"], f"the link declares a hit area (::after) for {name!r}: {measured}")
    case.assertTrue(has_minimum_touch_size(measured["width"]) and has_minimum_touch_size(measured["height"]), f"44 × 44 px touch target {name!r}: {measured}")
    case.assertTrue(measured["hittable"], f"the measured hit area belongs to {name!r}: {measured}")


class SettingsJourney(unittest.TestCase):
    pw = None
    browser: Browser
    state: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
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
        assistant = page.get_by_role("link", name=re.compile("^Your assistant Agent · for you"))
        expect(assistant).to_have_attribute("href", "/settings/assistant")
        expect(page.get_by_role("link", name=re.compile("^Background suggestions"))).to_have_attribute("href", "/settings/background-compute")
        # Agents have their colour here (and only in the Agents section); the Appearance switch's Kreska is monochrome.
        expect(assistant.locator(".agent-tag")).to_have_text("Agent")
        self.assertRegex(assistant.locator(".sset-row__ic > .kreska").get_attribute("class") or "", r"kreska--(clay|ochre|sage|teal|indigo|plum|rose)")
        page.goto("/settings")
        self.assertNotRegex(page.get_by_role("switch", name="Kreska in loading and empty screens").locator("xpath=..").locator(".kreska").get_attribute("class") or "", r"kreska--")
        expect(cards.first).to_be_visible()
        page.goto("/settings/agents")
        assistant = page.get_by_role("link", name=re.compile("^Your assistant Agent · for you"))
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
            if path == "/settings/notifications":
                # This route includes two async push-status reads. Finish the rendered
                # state before the next hard navigation destroys its document in WebKit.
                expect(page.get_by_text("Push is not set up on this Flux server, so the Push column has no effect. Your inbox always works.", exact=True)).to_be_visible()
                expect(page.get_by_text("Notifications are not set up on this Flux server. New activity always appears in your Inbox.", exact=True)).to_be_visible()
        expect(page.get_by_role("heading", name="This link did not work")).to_be_visible()
        # Back and history are kept across sections.
        page.goto("/settings/shortcuts")
        nav.get_by_role("link", name="Account").click()
        expect(page).to_have_url(re.compile(r"/settings/account$"))
        page.go_back()
        expect(page).to_have_url(re.compile(r"/settings/shortcuts$"))

    # ---------------------------------------------------------------- phone

    def phone_targets(self, page: Page) -> None:
        controls = page.locator("a.sset-row, button.sset-row, button.sset-theme, button.sset-switch, .sset-row--stack button, .sset-choice input")
        scroller = page.locator(".sset__page .pane-scroll")
        previous_scroll = scroller.evaluate("el => el.scrollTop")
        self.assertGreater(controls.count(), 0, "native settings controls are rendered")
        for control in controls.all():
            assert_touch_target(self, page, control)
        scroller.evaluate("(el, top) => { el.scrollTop = top; }", previous_scroll)
        self.assertLessEqual(page.evaluate("document.scrollingElement.scrollWidth"), PHONE["width"], "no sideways scroll")

    def test_06_phone_settings_page_with_44px_targets(self) -> None:
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
            expect(page.get_by_role("link", name=re.compile("^Your assistant Agent")).locator(".agent-tag")).to_have_text("Agent")
            self.phone_targets(page)
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
        self.phone_targets(page)
        shot(page, "settings-phone-390-notifications-light")
        page.get_by_role("button", name="Back").tap()
        expect(page).to_have_url(re.compile(r"/settings$"))
        page.get_by_role("link", name=re.compile("^Keyboard shortcuts")).tap()
        expect(page.get_by_role("table", name="Keyboard shortcuts").locator("tbody tr")).to_have_count(len(SHORTCUTS))
        page.get_by_role("button", name="Back").tap()
        page.get_by_role("link", name=re.compile("^Account")).tap()
        expect(page.get_by_role("button", name=re.compile("^Sign out"))).to_be_visible()
        self.phone_targets(page)
        dark = self.page(phone=True, dark=True)
        dark.goto("/settings/notifications")
        expect(dark.get_by_role("radio", name="Only “Needs you”")).to_be_checked()
        shot(dark, "settings-phone-390-notifications-dark")

    def test_07b_phone_notifications_hairlines_and_44px_checkboxes(self) -> None:
        """#434: the level card has hairlines between options in light and dark; matrix checkboxes and email rows are 44 px on touch."""
        for dark in (False, True):
            theme = "dark" if dark else "light"
            with self.subTest(theme=theme):
                page = self.page(phone=True, dark=dark)
                page.goto("/settings/notifications")
                choices = page.locator(".sset-choice")
                expect(choices).to_have_count(3)
                if dark:
                    # Without the dark palette the colour check below would prove nothing.
                    self.assertEqual(page.evaluate("getComputedStyle(document.documentElement).colorScheme"), "dark")
                for index in (1, 2):
                    width, style, colour = choices.nth(index).evaluate("el => { const s = getComputedStyle(el); return [s.borderTopWidth, s.borderTopStyle, s.borderTopColor]; }")
                    self.assertEqual(f"{width} {style}", "1px solid", f"{theme}: hairline above notification level option {index}")
                    self.assertTrue(has_visible_colour(colour), f"{theme}: hairline above notification level option {index} is visible: {colour!r}")
                self.assertEqual(choices.first.evaluate("el => getComputedStyle(el).borderTopWidth"), "0px", "no hairline above the first option")
                checks = page.locator(".nset__check input")
                self.assertGreater(checks.count(), 0)
                for index in range(checks.count()):
                    assert_touch_target(self, page, checks.nth(index))
                destinations = page.locator(".nset__radio input")
                for index in range(destinations.count()):
                    box = destinations.nth(index).locator("xpath=ancestor::label[1]").bounding_box()
                    self.assertIsNotNone(box)
                    self.assertGreaterEqual(box["height"], 44, f"{theme}: email destination row {index} is a 44 px target: {box}")
                shot(page, f"settings-phone-390-notifications-{theme}")

    def test_07c_phone_sign_in_create_account_link_has_a_44px_hit_area(self) -> None:
        """#434 item 5: on a coarse pointer the sign-in footer link has a 44 px hit area, and its text does not move."""
        page = self.page(phone=True, signed_in=False)
        page.goto("/sign-in")
        link = page.get_by_role("link", name="Create an account", exact=True)
        expect(link).to_be_visible()
        self.assertTrue(page.evaluate("matchMedia('(pointer: coarse)').matches"), "the phone emulation has a coarse pointer")
        # Measure only once the web font has loaded: a fallback-font box has a different size and position.
        page.evaluate("document.fonts.ready.then(() => true)")
        assert_halo_touch_target(self, link)
        shot(page, "settings-phone-390-sign-in")
        # The halo is layout-neutral: the text box is the same with and without it. Both boxes are read in one
        # synchronous step, so neither an entrance animation nor a scroll can separate them.
        boxes = page.evaluate("""() => {
          const link = [...document.querySelectorAll('.auth__alt .ui-link')].find((el) => el.textContent === 'Create an account');
          const box = () => { const r = link.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
          const withHalo = box();
          const style = document.createElement('style');
          style.textContent = '.auth__alt .ui-link::after { content: none !important; }';
          document.head.append(style);
          const withoutHalo = box();
          style.remove();
          return {withHalo, withoutHalo};
        }""")
        self.assertEqual(boxes["withHalo"], boxes["withoutHalo"], "the halo does not move the link text")
        # Without the declared halo the 18 px text box must fail.
        style = page.add_style_tag(content=".auth__alt .ui-link::after { content: none !important; }")
        with self.assertRaisesRegex(AssertionError, "declares a hit area"):
            assert_halo_touch_target(self, link)
        style.evaluate("el => el.remove()")
        assert_halo_touch_target(self, link)

    def test_08_touch_guard_rejects_small_or_noninteractive_hit_areas(self) -> None:
        for size in (44, 48, 43.99997):
            self.assertTrue(has_minimum_touch_size(size), str(size))
        for size in (43.99, 43.9989, 43.75, 0, float("nan"), float("inf")):
            self.assertFalse(has_minimum_touch_size(size), str(size))

        page = self.page(phone=True)
        page.goto("/settings")
        switch = page.get_by_role("switch", name="Kreska in small moments")
        assert_touch_target(self, page, switch)
        # Keep the decorative row unchanged while removing the button's actual extension.
        # A row-only size check would still pass, but the 28 px native track must fail.
        row = switch.locator("xpath=..")
        self.assertTrue(has_minimum_touch_size(box(page, row)["height"]))
        style = page.add_style_tag(content=".sset-switch::after { content: none !important; }")
        with self.assertRaisesRegex(AssertionError, "44 × 44 px touch target"):
            assert_touch_target(self, page, switch)
        style.evaluate("el => el.remove()")
        assert_touch_target(self, page, switch)

        # A declared 44 px halo that cannot receive events must not count either.
        style = page.add_style_tag(content=".sset-switch::after { pointer-events: none !important; }")
        with self.assertRaisesRegex(AssertionError, "44 × 44 px touch target"):
            assert_touch_target(self, page, switch)
        style.evaluate("el => el.remove()")

        # Width and height independently gate a real button; its parent remains full size.
        theme = page.get_by_role("radio", name="Light", exact=True)
        for dimension in ("width", "height"):
            style = page.add_style_tag(content=f"button.sset-theme {{ {dimension}: 43.99px !important; min-{dimension}: 0 !important; max-{dimension}: 43.99px !important; overflow: hidden !important; }}")
            with self.assertRaisesRegex(AssertionError, "44 × 44 px touch target"):
                assert_touch_target(self, page, theme)
            style.evaluate("el => el.remove()")
        assert_touch_target(self, page, theme)


if __name__ == "__main__":
    unittest.main()
