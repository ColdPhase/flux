"""Installing Flux and launching it from the home screen (#20, MOB-1), in Chromium and WebKit emulation.

Founder direction #266 item 10 (2026-10-05): MOB-1 closes on emulation in Docker plus documented platform requirements.
What emulation cannot run, and how each step is stood in for here:

- Chromium fires `beforeinstallprompt` only after its own engagement heuristic, which a test browser never meets. The
  tests dispatch an event of that name with `prompt()` and `userChoice`, the shape the browser hands the page; the app's
  own listener, button and call are unchanged. The browser's install dialog itself is not shown.
- An installed app runs in the `standalone` display mode, which neither engine lets a test switch on: Chromium's
  DevTools media emulation (`Emulation.setEmulatedMedia`, feature `display-mode`) is tried and its result printed,
  but it did not apply on 2026-10-30. iOS Home Screen apps also report `navigator.standalone === true`, and Flux reads
  that flag on the same code path as `display-mode` (`pwa/install.ts` `isStandalone()`), so both lanes set it.
- A cold launch is a new browser context opened at the manifest's `start_url`, with the stored session cookie (the
  installed app reopening) or without it (signed out on that device).

Runs against the running Compose application through scripts/check_ui.sh; FLUX_UI_BROWSER selects chromium (default) or
webkit.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import urllib.parse

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, start_forwarder
from test_settings import UI_BROWSER

PASSWORD = "a home screen app opens where you left"
STAMP = int(time.time() * 1000)
NAME, EMAIL = "Maja Wrona", f"maja.install+{STAMP}@example.test"
IPHONE_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) "
             "Version/26.0 Mobile/15E148 Safari/604.1")
IPAD_UA = ("Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 "
           "Mobile/15E148 Safari/604.1")
IPADOS_DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"
TABLET = {"width": 820, "height": 1180}
ANDROID_UA = ("Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 "
              "Mobile Safari/537.36")

# The browser's install offer, as Chromium hands it to the page: a cancelable event with prompt() and userChoice.
OFFER_INSTALL = """(outcome) => {
  window.__installPrompts = 0;
  const event = new Event('beforeinstallprompt', { cancelable: true });
  let answer;
  event.userChoice = new Promise((resolve) => { answer = resolve; });
  event.prompt = () => { window.__installPrompts++; answer({ outcome, platform: 'web' }); return Promise.resolve(); };
  window.dispatchEvent(event);
  return event.defaultPrevented;
}"""

STANDALONE_FLAG = "Object.defineProperty(Navigator.prototype, 'standalone', { configurable: true, get: () => true });"


class InstallAndLaunch(unittest.TestCase):
    pw = None
    browser: Browser
    state: dict = {}
    project: dict = {}

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
        workspace = cls.call(context, "POST", "/api/v1/workspaces", {"name": "Harbour Choir"}, 201)
        cls.project = cls.call(context, "POST", f"/api/v1/workspaces/{workspace['id']}/projects", {"name": "Winter concert rehearsal plan", "visibility": "restricted"}, 201)
        cls.call(context, "POST", f"/api/v1/projects/{cls.project['id']}/work", {"title": "Book the church hall for 14 December", "status": "open"}, 201)
        cls.state = context.storage_state()
        context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    @staticmethod
    def call(context: BrowserContext, method: str, path: str, body: dict, status: int) -> dict:
        response = context.request.fetch(ORIGIN + path, method=method, headers={"origin": ORIGIN, "content-type": "application/json"}, data=json.dumps(body))
        assert response.status == status, f"{method} {path}: {response.status}, expected {status}: {response.text()}"
        return response.json()

    def context(self, viewport: dict, *, user_agent: str | None = None, signed_in: bool = True, standalone: bool = False,
                touch: bool | None = None) -> BrowserContext:
        phone = viewport["width"] <= 640 if touch is None else touch
        options: dict = {"base_url": ORIGIN, "viewport": viewport, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "service_workers": "allow"}
        if signed_in:
            options["storage_state"] = self.state
        if user_agent:
            options["user_agent"] = user_agent
        if phone:
            options.update(is_mobile=True, has_touch=True, device_scale_factor=3)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        if standalone:
            context.add_init_script(STANDALONE_FLAG)
        return context

    def page(self, context: BrowserContext, *, standalone: bool = False) -> Page:
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        if standalone and UI_BROWSER == "chromium":
            cdp = context.new_cdp_session(page)
            cdp.send("Emulation.setEmulatedMedia", {"features": [{"name": "display-mode", "value": "standalone"}]})
        return page

    def appearance(self, page: Page) -> None:
        """Where the install row lives: Settings → Notifications → This device (#763 SG-8; Appearance before)."""
        page.goto("/settings/notifications")
        expect(page.get_by_role("heading", name="Notifications").first).to_be_visible()
        expect(page.get_by_role("radiogroup", name="Notify me about")).to_be_visible()

    # ------------------------------------------------------------ install offers

    def test_01_a_computer_without_an_install_offer_shows_no_install_row(self) -> None:
        page = self.page(self.context(DESKTOP))
        # A computer browser: no phone or tablet user agent and no touch points (WebKit reports a Mac, Chromium Linux).
        self.assertTrue(page.evaluate("!/iPhone|iPad|iPod|Android/.test(navigator.userAgent) && navigator.maxTouchPoints === 0"))
        self.appearance(page)
        page.wait_for_timeout(500)
        expect(page.get_by_test_id("install-flux")).to_have_count(0)

    def row_tops(self, page: Page) -> list[float]:
        """The top of every other settings row on the page: none may move when the install row comes or goes."""
        # Measured from the page's own top, so scrolling the long Notifications page to the button moves nothing.
        return page.evaluate("""() => { const top = document.querySelector('.pane-in').getBoundingClientRect().top;
          return [...document.querySelectorAll('.sset-card > *')]
          .filter((el) => el.getAttribute('data-testid') !== 'install-flux').map((el) => el.getBoundingClientRect().top - top); }""")

    def focused(self, page: Page) -> str:
        return page.evaluate("(() => { const el = document.activeElement; return el ? (el.getAttribute('role') || el.tagName.toLowerCase()) + ':' + el.textContent.trim() : ''; })()")

    def test_02_an_offered_install_opens_the_browser_dialog_from_the_button(self) -> None:
        page = self.page(self.context(DESKTOP))
        self.appearance(page)
        before = self.row_tops(page)
        prevented = page.evaluate(OFFER_INSTALL, "accepted")
        self.assertTrue(prevented, "Flux keeps the offer for its own button instead of the browser's banner")
        row = page.get_by_test_id("install-flux")
        expect(row.locator(".sset-row__t")).to_have_text("Install Flux")
        button = row.get_by_role("button", name="Install Flux")
        expect(button).to_be_visible()
        self.assertEqual(self.row_tops(page), before, "a late offer moves no other row: the install row is last")
        # A settings row: text on the left, the compact control on the right.
        layout = row.evaluate("""(el) => { const t = el.querySelector('.sset-row__t').getBoundingClientRect();
          const b = el.querySelector('button').getBoundingClientRect(); return { right: b.left > t.right, width: b.width, row: el.getBoundingClientRect().width }; }""")
        self.assertTrue(layout["right"], f"the button is right of the title: {layout}")
        self.assertLess(layout["width"], layout["row"] / 2, f"a compact button, not a full-width bar: {layout}")
        # The live region exists, empty, before anything happens, so its later text is announced.
        expect(row.get_by_role("status")).to_have_text("")
        self.assertEqual(page.evaluate("window.__installPrompts"), 0, "nothing is asked before the person chooses")
        button.focus()
        page.keyboard.press("Enter")
        expect(row.locator(".sset-row__t")).to_have_text("Flux is installed")
        expect(row.get_by_role("status")).to_have_text(re.compile("Open it from"))
        expect(row.get_by_role("button")).to_have_count(0)
        self.assertEqual(page.evaluate("window.__installPrompts"), 1, "one browser dialog, from the key press")
        page.wait_for_function("document.activeElement && document.activeElement.getAttribute('role') === 'status'")
        self.assertEqual(self.row_tops(page), before, "the outcome moves no other row")

    def test_03_a_dismissed_install_dialog_keeps_the_row_and_says_so(self) -> None:
        page = self.page(self.context(DESKTOP))
        self.appearance(page)
        before = self.row_tops(page)
        page.evaluate(OFFER_INSTALL, "dismissed")
        row = page.get_by_test_id("install-flux")
        row.get_by_role("button", name="Install Flux").focus()
        page.keyboard.press(" ")
        expect(row.get_by_role("status")).to_have_text(re.compile("Not installed"))
        expect(row.get_by_role("button")).to_have_count(0)
        page.wait_for_function("document.activeElement && document.activeElement.getAttribute('role') === 'status'")
        self.assertEqual(page.evaluate("window.__installPrompts"), 1)
        self.assertEqual(self.row_tops(page), before)

    def test_03b_a_dialog_that_fails_to_open_leaves_a_working_button_and_a_message(self) -> None:
        page = self.page(self.context(DESKTOP))
        self.appearance(page)
        page.evaluate("""() => {
          window.__installPrompts = 0;
          const event = new Event('beforeinstallprompt', { cancelable: true });
          event.userChoice = new Promise(() => {});
          event.prompt = () => { window.__installPrompts++; return Promise.reject(new DOMException('The prompt() method cannot be called again.', 'InvalidStateError')); };
          window.dispatchEvent(event);
        }""")
        row = page.get_by_test_id("install-flux")
        button = row.get_by_role("button", name="Install Flux")
        button.focus()
        page.keyboard.press("Enter")
        expect(row.get_by_role("status")).to_have_text(re.compile("did not open"))
        expect(button).to_be_visible()
        expect(button).not_to_have_attribute("aria-disabled", "true")
        self.assertTrue(button.evaluate("(el) => el === document.activeElement"), "the focus stays on the button")
        page.keyboard.press("Enter")
        page.wait_for_function("window.__installPrompts === 2")
        expect(row.get_by_role("status")).to_have_text(re.compile("did not open"))
        # page() fails the test on any uncaught page error, so neither rejection escaped.

    def test_03c_installing_from_the_browser_menu_is_noticed(self) -> None:
        """The `appinstalled` listener: Flux installed through the browser's own menu, while an offer was showing."""
        page = self.page(self.context(DESKTOP))
        self.appearance(page)
        page.evaluate(OFFER_INSTALL, "accepted")
        row = page.get_by_test_id("install-flux")
        expect(row.get_by_role("button", name="Install Flux")).to_be_visible()
        page.evaluate("window.dispatchEvent(new Event('appinstalled'))")
        expect(row.locator(".sset-row__t")).to_have_text("Flux is installed")
        expect(row.get_by_role("button")).to_have_count(0)
        self.assertEqual(page.evaluate("window.__installPrompts"), 0, "no dialog was opened by Flux")

    def test_04_an_iphone_safari_tab_shows_the_home_screen_steps_once(self) -> None:
        page = self.page(self.context(PHONE, user_agent=IPHONE_UA))
        self.appearance(page)
        row = page.get_by_test_id("install-flux")
        expect(row.locator(".sset-row__t")).to_have_text("Flux on this phone")
        steps = row.get_by_role("note")
        expect(steps).to_have_text(re.compile(r"Tap Share, then Add to Home Screen"))
        self.assertEqual(page.get_by_role("button", name="Install Flux").count(), 0, "Safari has no install dialog to open")
        # Said once: the notifications row above points here instead of repeating the steps.
        expect(page.get_by_text(re.compile("Add to Home Screen"))).to_have_count(1)
        # Body size, like the row's title: the steps are the task, not a footnote.
        sizes = row.evaluate("(el) => [getComputedStyle(el.querySelector('.sset-row__t')).fontSize, getComputedStyle(el.querySelector('[role=note]')).fontSize]")
        self.assertGreaterEqual(float(sizes[1].rstrip("px")), float(sizes[0].rstrip("px")), f"steps at body size, not meta text: {sizes}")

    def test_04b_an_ipad_shows_the_home_screen_steps(self) -> None:
        """iPad: the classic "iPad" user agent, and iPadOS's desktop one ("Macintosh" with touch points)."""
        for name, user_agent in (("iPad", IPAD_UA), ("iPadOS desktop UA", IPADOS_DESKTOP_UA)):
            with self.subTest(name):
                context = self.context(TABLET, user_agent=user_agent, touch=True)
                context.add_init_script("Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { configurable: true, get: () => 5 });")
                page = self.page(context)
                self.appearance(page)
                row = page.get_by_test_id("install-flux")
                expect(row.locator(".sset-row__t")).to_have_text("Install Flux")
                expect(row.get_by_role("note")).to_have_text(re.compile(r"Tap Share, then Add to Home Screen"))
                self.assertEqual(page.get_by_role("button", name="Install Flux").count(), 0)

    def test_05_an_android_tab_without_an_offer_names_the_browser_menu(self) -> None:
        page = self.page(self.context(PHONE, user_agent=ANDROID_UA))
        self.appearance(page)
        expect(page.get_by_test_id("install-flux").get_by_role("note")).to_have_text(re.compile(r"Install app or Add to Home screen"))

    def test_05b_an_android_phone_with_an_offer_gets_the_install_button(self) -> None:
        page = self.page(self.context(PHONE, user_agent=ANDROID_UA))
        self.appearance(page)
        page.evaluate(OFFER_INSTALL, "accepted")
        row = page.get_by_test_id("install-flux")
        expect(row.locator(".sset-row__t")).to_have_text("Flux on this phone")
        expect(row.get_by_role("note")).to_have_count(0)
        button = row.get_by_role("button", name="Install Flux")
        box = button.bounding_box()
        self.assertIsNotNone(box)
        self.assertGreaterEqual(box["height"], 44, f"a 44 px target on a phone: {box}")
        button.tap()
        expect(row.locator(".sset-row__t")).to_have_text("Flux is installed")
        self.assertEqual(page.evaluate("window.__installPrompts"), 1)

    # ------------------------------------------------------------ the installed app

    def test_06_the_installed_app_cold_launches_signed_in_and_offers_no_install(self) -> None:
        context = self.context(PHONE, user_agent=IPHONE_UA, standalone=True)
        page = self.page(context, standalone=True)
        manifest = page.request.get(f"{ORIGIN}/manifest.webmanifest").json()
        page.goto(manifest["start_url"])
        if UI_BROWSER == "chromium":
            # Recorded, not asserted: whether this Chromium applies `display-mode` through DevTools media emulation.
            # The flag below drives the same code path either way.
            cdp = page.context.new_cdp_session(page)
            cdp.send("Emulation.setEmulatedMedia", {"features": [{"name": "display-mode", "value": "standalone"}]})
            applied = page.evaluate("matchMedia('(display-mode: standalone)').matches")
            print(f"\n[{UI_BROWSER} {self.browser.version}] display-mode standalone via setEmulatedMedia: {applied}", flush=True)
        self.assertTrue(page.evaluate("navigator.standalone === true || matchMedia('(display-mode: standalone)').matches"))
        expect(page.locator(".app")).to_be_visible()
        self.assertNotIn("sign-in", page.url)
        self.appearance(page)
        page.wait_for_timeout(500)
        expect(page.get_by_test_id("install-flux")).to_have_count(0)

    def test_07_a_link_opened_in_the_installed_app_reopens_that_project(self) -> None:
        context = self.context(PHONE, standalone=True)
        page = self.page(context, standalone=True)
        page.goto(f"/projects/{self.project['id']}")
        expect(page).to_have_url(re.compile(rf"/projects/{self.project['id']}$"))
        expect(page.get_by_text("Winter concert rehearsal plan").first).to_be_visible()

    def test_08_signed_out_the_link_asks_to_sign_in_and_then_opens_that_project(self) -> None:
        context = self.context(PHONE, signed_in=False, standalone=True)
        page = self.page(context, standalone=True)
        target = f"/projects/{self.project['id']}"
        page.goto(target)
        expect(page).to_have_url(re.compile(r"/sign-in\?next="))
        self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(page.url).query)["next"], [target])
        page.get_by_label("Email", exact=True).fill(EMAIL)
        page.get_by_label("Password", exact=True).fill(PASSWORD)
        page.get_by_role("button", name="Sign in", exact=True).tap()
        expect(page).to_have_url(re.compile(rf"{re.escape(target)}$"))
        expect(page.get_by_text("Winter concert rehearsal plan").first).to_be_visible()


if __name__ == "__main__":
    unittest.main()
