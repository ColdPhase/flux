"""Browser tests for the sign-in page with single sign-on (F-024 S1, #310 AC-4, #847).

The page asks the capabilities again while the provider is unreachable, so its button comes back without a
reload. The provider's answer is faked here (the Keycloak-backed run is tests/app/e2e/oidc-mcp.e2e.ts):
the first two answers say "not reachable", then the provider answers and the same open page enables it.

With single sign-on as the only way in, the page never shows the email and password form, not even before the capabilities
answer arrives (#847): the answer is held for a while, and a watcher in the page records any password field, "Forgot password?" or
"Create an account" that is ever attached. If the capabilities cannot be read the page is the password page it always was.
"""

from __future__ import annotations

import json
import time
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UPSTREAM, start_forwarder

CAPABILITIES = "**/api/v1/auth/capabilities"
BUTTON = "Sign in with Recovery provider"
SSO_ONLY = {"passwordReset": "unavailable", "setup": False, "signup": "link", "ssoOnly": True, "sso": {"providerId": "oidc-recovery", "label": "Recovery provider", "reachable": True}}
# Records, from the first byte of the document, whether anything that cannot work in SSO-only mode was ever attached.
WATCH = """() => {
  window.__passwordForm = false;
  const look = () => { if (document.querySelector('input[type=password], a[href="/forgot-password"], a[href^="/sign-up"]')) window.__passwordForm = true; };
  new MutationObserver(look).observe(document, { childList: true, subtree: true, attributes: true });
  look();
}"""


class SignInWhileProviderIsDown(unittest.TestCase):
    pw = None

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def test_01_the_open_page_enables_the_provider_once_it_answers(self) -> None:
        context = self.browser.new_context(
            base_url=ORIGIN, viewport=DESKTOP, color_scheme="light", locale="en-GB",
            service_workers="block",
        )
        self.addCleanup(context.close)
        answers: list[int] = []

        def capabilities(route) -> None:
            answers.append(1)
            reachable = len(answers) >= 3
            body = {"passwordReset": "unavailable", "ssoOnly": True, "sso": {"providerId": "oidc-recovery", "label": "Recovery provider", "reachable": reachable}}
            route.fulfill(status=200, content_type="application/json", body=json.dumps(body))

        context.route(CAPABILITIES, capabilities)
        page = context.new_page()
        page.goto("/sign-in")
        button = page.get_by_role("button", name=BUTTON, exact=True)
        expect(button).to_be_disabled()
        expect(page.get_by_text("Recovery provider is not reachable right now.")).to_be_visible()
        # No reload: the same page asks again and the provider comes back.
        expect(button).to_be_enabled(timeout=20_000)
        expect(page.get_by_text("is not reachable right now")).to_have_count(0)
        self.assertGreaterEqual(len(answers), 3, "the page asked again while the provider was unreachable")

    def context(self):
        context = self.browser.new_context(base_url=ORIGIN, viewport=DESKTOP, color_scheme="light", locale="en-GB", service_workers="block")
        self.addCleanup(context.close)
        return context

    def test_02_sso_only_never_shows_the_password_form_while_the_capabilities_are_on_their_way(self) -> None:
        for address in ("/sign-in", "/login"):
            with self.subTest(address=address):
                context = self.context()
                context.add_init_script(f"({WATCH})()")
                held: list = []
                context.route(CAPABILITIES, lambda route: held.append(route))
                page = context.new_page()
                page.goto(address, wait_until="commit")
                for _ in range(100):
                    if held:
                        break
                    page.wait_for_timeout(50)
                self.assertTrue(held, "the page asked for the capabilities")
                # The answer is late: for a second and a half the page has no form to offer.
                page.wait_for_timeout(1500)
                self.assertFalse(page.evaluate("window.__passwordForm"), "no password field, Forgot password or Create an account while it waits")
                expect(page.get_by_label("Password")).to_have_count(0)
                for route in held:
                    route.fulfill(status=200, content_type="application/json", body=json.dumps(SSO_ONLY))
                expect(page.get_by_role("button", name=BUTTON, exact=True)).to_be_enabled()
                self.assertFalse(page.evaluate("window.__passwordForm"), "and none after it either")
                expect(page.get_by_label("Password")).to_have_count(0)
                expect(page.get_by_role("link", name="Forgot password?")).to_have_count(0)
                expect(page.get_by_role("link", name="Create an account")).to_have_count(0)

    def test_03_without_the_capabilities_the_page_is_the_password_page(self) -> None:
        for address in ("/sign-in", "/login"):
            with self.subTest(address=address):
                context = self.context()
                context.route(CAPABILITIES, lambda route: route.abort())
                page = context.new_page()
                page.goto(address)
                expect(page.get_by_label("Email")).to_be_visible()
                expect(page.get_by_label("Password")).to_be_visible()
                expect(page.get_by_role("link", name="Forgot password?")).to_be_visible()
                # #1471: without the capabilities the page cannot know it is a test deployment; accounts come from links.
                expect(page.get_by_text("New here? Open the invite link you were sent.")).to_be_visible()

    def test_04_password_mode_is_the_page_it_was(self) -> None:
        context = self.context()
        context.route(CAPABILITIES, lambda route: route.fulfill(status=200, content_type="application/json",
                                                                 body=json.dumps({"passwordReset": "available", "setup": False, "signup": "open", "ssoOnly": False, "sso": None})))
        page = context.new_page()
        page.goto("/sign-in")
        expect(page.get_by_label("Password")).to_be_visible()
        expect(page.get_by_role("link", name="Create an account")).to_be_visible()
        expect(page.get_by_role("button", name=BUTTON, exact=True)).to_have_count(0)

    def test_05_signing_out_names_the_provider_in_sso_only_mode(self) -> None:
        context = self.context()
        page = context.new_page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Sam Signout")
        page.get_by_label("Email").fill(f"sam.signout+{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}@example.test")
        page.get_by_label("Password").fill("a calm way to sign out")
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        page.goto("/sign-out")
        expect(page.get_by_text("You’ll need your email and password to sign in again on this device.")).to_be_visible()
        context.route(CAPABILITIES, lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(SSO_ONLY)))
        page.goto("/sign-out")
        expect(page.get_by_text("You’ll sign in with Recovery provider again on this device.")).to_be_visible()
        expect(page.get_by_text("email and password")).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
