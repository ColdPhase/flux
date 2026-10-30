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

    def context(self, viewport: dict, *, user_agent: str | None = None, signed_in: bool = True, standalone: bool = False) -> BrowserContext:
        phone = viewport["width"] <= 640
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
        page.goto("/settings/appearance")
        expect(page.get_by_role("heading", name="Appearance").first).to_be_visible()

    # ------------------------------------------------------------ install offers

    def test_01_a_computer_without_an_install_offer_shows_no_install_row(self) -> None:
        page = self.page(self.context(DESKTOP))
        # A computer browser: no phone or tablet user agent and no touch points (WebKit reports a Mac, Chromium Linux).
        self.assertTrue(page.evaluate("!/iPhone|iPad|iPod|Android/.test(navigator.userAgent) && navigator.maxTouchPoints === 0"))
        self.appearance(page)
        page.wait_for_timeout(500)
        expect(page.get_by_test_id("install-flux")).to_have_count(0)

    def test_02_an_offered_install_opens_the_browser_dialog_from_the_button(self) -> None:
        page = self.page(self.context(DESKTOP))
        self.appearance(page)
        prevented = page.evaluate(OFFER_INSTALL, "accepted")
        self.assertTrue(prevented, "Flux keeps the offer for its own button instead of the browser's banner")
        row = page.get_by_test_id("install-flux")
        expect(row.locator(".sset-row__t")).to_have_text("Install Flux")
        expect(row.get_by_role("button", name="Install Flux")).to_be_visible()
        self.assertEqual(page.evaluate("window.__installPrompts"), 0, "nothing is asked before the person chooses")
        row.get_by_role("button", name="Install Flux").click()
        expect(row.get_by_role("status")).to_have_text(re.compile("Flux is installed"))
        self.assertEqual(page.evaluate("window.__installPrompts"), 1, "one browser dialog, from the click")

    def test_03_a_dismissed_install_dialog_takes_the_button_away(self) -> None:
        page = self.page(self.context(DESKTOP))
        self.appearance(page)
        page.evaluate(OFFER_INSTALL, "dismissed")
        page.get_by_test_id("install-flux").get_by_role("button", name="Install Flux").click()
        expect(page.get_by_test_id("install-flux")).to_have_count(0)
        self.assertEqual(page.evaluate("window.__installPrompts"), 1)

    def test_04_an_iphone_safari_tab_shows_the_home_screen_steps(self) -> None:
        page = self.page(self.context(PHONE, user_agent=IPHONE_UA))
        self.appearance(page)
        row = page.get_by_test_id("install-flux")
        expect(row.get_by_text("Flux on this phone", exact=True)).to_be_visible()
        expect(row.get_by_role("note")).to_have_text(re.compile(r"tap Share, then Add to Home Screen"))
        self.assertEqual(page.get_by_role("button", name="Install Flux").count(), 0, "Safari has no install dialog to open")

    def test_05_an_android_tab_without_an_offer_names_the_browser_menu(self) -> None:
        page = self.page(self.context(PHONE, user_agent=ANDROID_UA))
        self.appearance(page)
        expect(page.get_by_test_id("install-flux").get_by_role("note")).to_have_text(re.compile(r"Install app or Add to Home screen"))

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
