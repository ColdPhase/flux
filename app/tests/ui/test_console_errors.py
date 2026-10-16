"""No 401 or 429 reaches the browser console across sign-in and signed-in page loads (issue #546).

The signed-out shell must not call authenticated endpoints, and a signed-in load must not send a request
that is refused. The test records every failed response and console error while it opens the signed-out
shell, signs in on the page, and loads three signed-in pages on the computer and the phone.
Runs through scripts/check_ui.sh against the running Compose application; FLUX_UI_BROWSER picks the engine.
"""

from __future__ import annotations

import time
import unittest

from playwright.sync_api import expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, start_forwarder

PASSWORD = "a console without errors"
STAMP = int(time.time() * 1000)
REFUSED = (401, 429)


class ConsoleErrors(unittest.TestCase):
    pw = None
    browser = None

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def journey(self, label: str, viewport: dict) -> None:
        phone = viewport == PHONE
        email = f"console.{label}+{STAMP}@example.test"
        maker = self.browser.new_context(base_url=ORIGIN, service_workers="block")
        self.addCleanup(maker.close)
        made = maker.request.fetch(f"{ORIGIN}/api/auth/sign-up/email", method="POST", headers={"origin": ORIGIN},
                                   data={"name": "Kasia Lis", "email": email, "password": PASSWORD})
        self.assertLess(made.status, 300, made.text())

        context = self.browser.new_context(base_url=ORIGIN, viewport=viewport, locale="en-GB", service_workers="block",
                                           has_touch=phone, is_mobile=phone)
        self.addCleanup(context.close)
        page = context.new_page()
        problems: list[str] = []
        page.on("response", lambda r: problems.append(f"{r.status} {r.request.method} {r.url}") if r.status in REFUSED else None)
        page.on("console", lambda m: problems.append(f"console {m.text}") if m.type == "error" and any(str(s) in m.text for s in REFUSED) else None)
        page.on("pageerror", lambda e: problems.append(f"pageerror {e}"))

        # The signed-out shell: the root redirects to sign-in without a refused request.
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Sign in", exact=True)).to_be_visible()
        page.wait_for_load_state("networkidle")
        self.assertEqual(problems, [], f"{label}: signed-out shell")

        page.get_by_label("Email").fill(email)
        page.get_by_label("Password", exact=True).fill(PASSWORD)
        page.get_by_role("button", name="Sign in", exact=True).click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        page.wait_for_load_state("networkidle")
        self.assertEqual(problems, [], f"{label}: sign-in")

        for path in ("/", "/settings", "/inbox"):
            page.goto(path)
            expect(page.get_by_role("heading", level=1).first).to_be_visible()
            page.wait_for_load_state("networkidle")
            self.assertEqual(problems, [], f"{label}: signed-in load of {path}")

    def test_01_computer(self) -> None:
        self.journey("computer", DESKTOP)

    def test_02_phone(self) -> None:
        self.journey("phone", PHONE)


if __name__ == "__main__":
    unittest.main()
