"""Browser tests for the password sign-in, sign-up and claim pages in password mode (F-024 S5a, #313).

Runs through scripts/check_ui.sh with the other journeys. The UI stack has no identity provider, so it is
password mode: the sign-in page has the password form, sign-up is open, password reset is available (mail is
set), and the claim page has nothing to claim. The single sign-on refusals and the claim flow itself are
exercised against Keycloak in tests/app/e2e/oidc.e2e.ts (scripts/check_oidc.sh).
"""

from __future__ import annotations

import json
import time
import unittest

from playwright.sync_api import Browser, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UPSTREAM, start_forwarder

PASSWORD = "a password that is long enough"
PERSON = {"name": "Sami Ortiz", "email": f"sami.signin+{int(time.time() * 1000)}@example.test"}


class SignInPages(unittest.TestCase):
    pw = None
    browser: Browser

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

    def page(self):
        context = self.browser.new_context(base_url=ORIGIN, viewport=DESKTOP, color_scheme="light", locale="en-GB")
        self.addCleanup(context.close)
        return context.new_page()

    def test_01_password_mode_offers_the_password_form_sign_up_and_reset(self) -> None:
        page = self.page()
        page.goto("/sign-in")
        expect(page.get_by_role("heading", level=1, name="Sign in to Flux")).to_be_visible()
        expect(page.get_by_label("Password")).to_be_visible()
        expect(page.get_by_role("button", name="Sign in", exact=True)).to_be_visible()
        expect(page.get_by_role("link", name="Forgot password?")).to_be_visible()
        expect(page.get_by_role("button", name="Sign in with Keycloak")).to_have_count(0)
        capabilities = json.loads(page.request.get(f"{ORIGIN}/api/v1/auth/capabilities").text())
        self.assertEqual(capabilities, {"passwordReset": "available", "signup": "open", "ssoOnly": False, "linkable": False, "sso": None})

    def test_02_a_new_account_signs_up_and_a_wrong_password_is_refused(self) -> None:
        page = self.page()
        page.goto("/sign-up")
        expect(page.get_by_role("heading", level=1, name="Create your Flux account")).to_be_visible()
        page.get_by_label("Name").fill(PERSON["name"])
        page.get_by_label("Email").fill(PERSON["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page).to_have_url(f"{ORIGIN}/")

        other = self.page()
        other.goto("/sign-in")
        other.get_by_label("Email").fill(PERSON["email"])
        other.get_by_label("Password").fill("the wrong password entirely")
        other.get_by_role("button", name="Sign in", exact=True).click()
        expect(other.get_by_text("That email and password don’t match an account.")).to_be_visible()

    def test_03_the_claim_page_has_nothing_to_claim_without_a_provider_sign_in(self) -> None:
        page = self.page()
        page.goto("/claim")
        expect(page.get_by_role("heading", name="There is nothing to claim here")).to_be_visible()
        expect(page.get_by_role("button", name="Claim this address")).to_have_count(0)
        self.assertEqual(json.loads(page.request.get(f"{ORIGIN}/api/v1/identity/claim").text())["code"], "CLAIM_NOT_FOUND")


if __name__ == "__main__":
    unittest.main()
