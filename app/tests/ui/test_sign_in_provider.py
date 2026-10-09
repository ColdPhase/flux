"""Browser test for the sign-in page while the single sign-on provider is unreachable (F-024 S1, #310 AC-4).

The page asks the capabilities again while the provider is unreachable, so its button comes back without a
reload. The provider's answer is faked here (the Keycloak-backed run is tests/app/e2e/oidc-mcp.e2e.ts):
the first two answers say "not reachable", then the provider answers and the same open page enables it.
"""

from __future__ import annotations

import json
import unittest

from playwright.sync_api import expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UPSTREAM, start_forwarder

CAPABILITIES = "**/api/v1/auth/capabilities"
BUTTON = "Sign in with Recovery provider"


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
        context = self.browser.new_context(base_url=ORIGIN, viewport=DESKTOP, color_scheme="light", locale="en-GB")
        self.addCleanup(context.close)
        answers: list[int] = []

        def capabilities(route) -> None:
            answers.append(1)
            reachable = len(answers) >= 3
            body = {"passwordReset": "unavailable", "sso": {"providerId": "oidc-recovery", "label": "Recovery provider", "reachable": reachable}}
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


if __name__ == "__main__":
    unittest.main()
