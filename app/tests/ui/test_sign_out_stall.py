"""Sign out sends its request and reaches sign-in in the browser under test (issue #461).

A new account opens Home, possibly while its service worker is still installing, and then
signs out from the account menu. POST /api/auth/sign-out must be sent and the sign-in page must
appear. Before #461 the WebKit run never sent the request: the browser's push subscription call
never settled, and the page waited on it. FLUX_UI_BROWSER selects chromium (default) or webkit.
Runs through scripts/check_ui.sh against the running Compose application.
"""

from __future__ import annotations

import json
import re
import sys
import time
import unittest

from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UI_BROWSER, UPSTREAM, start_forwarder

PASSWORD = "sign out without stalling"
NAME = "Ola Nowak"
STAMP = int(time.time() * 1000)

# A read-only snapshot taken before the click. It does not touch PushManager, the call that
# can stall the page (docs/product/mobile-pwa.md, Sign-out and this device's push subscription).
WORKER_STATE_JS = """
async () => {
  const registration = await navigator.serviceWorker.getRegistration('/');
  return {
    permission: Notification.permission,
    controller: Boolean(navigator.serviceWorker.controller),
    active: registration?.active?.state ?? null,
    installing: registration?.installing?.state ?? null,
    waiting: Boolean(registration?.waiting),
  };
}
"""


class SignOutJourney(unittest.TestCase):
    pw = None
    browser = None

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def test_01_sign_out_sends_the_request_and_shows_sign_in(self) -> None:
        context = self.browser.new_context(base_url=ORIGIN, viewport=DESKTOP, locale="en-GB", timezone_id="Europe/Warsaw")
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))

        signup = context.request.fetch(f"{ORIGIN}/api/auth/sign-up/email", method="POST",
                                       data={"name": NAME, "email": f"ola.signout+{STAMP}@example.test", "password": PASSWORD},
                                       headers={"origin": ORIGIN})
        self.assertLess(signup.status, 300, signup.text())
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        before = page.evaluate(WORKER_STATE_JS)

        page.get_by_role("button", name=re.compile(NAME)).click()
        sign_out = page.get_by_role("dialog", name="Account").get_by_role("button", name="Sign out")
        try:
            with page.expect_request(lambda request: request.method == "POST" and request.url.endswith("/api/auth/sign-out"), timeout=15000):
                sign_out.click(no_wait_after=True)
        except PlaywrightTimeout:
            # Written before the page is torn down: a wedged page can keep teardown from finishing.
            print(f"[#461] sign-out request not sent on {UI_BROWSER}; worker state before the click: {json.dumps(before)}",
                  file=sys.stderr, flush=True)
            raise

        print(f"[#461] sign-out request sent on {UI_BROWSER}; worker state before the click: {json.dumps(before)}", file=sys.stderr, flush=True)
        expect(page).to_have_url(re.compile(r"/sign-in"))
        expect(page.get_by_role("heading", name="Sign in to Flux")).to_be_visible()
        self.assertEqual(errors, [], f"no uncaught page errors (worker state before the click: {before})")


if __name__ == "__main__":
    unittest.main()
