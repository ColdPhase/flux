"""Sign-in and account pages follow the final design (#351, F-026 sign-in boards).

The plain Flux logo tile above the title and no decoration outside it, a card on the computer and a
bare column on the phone. The password mode is unchanged; the page offers no email link or passkey,
which Flux does not have. Runs through scripts/check_ui.sh against the running Compose application.
"""

from __future__ import annotations

import re
import unittest

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder


class SignIn(unittest.TestCase):
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

    def page(self, scheme: str, viewport: dict) -> Page:
        phone = viewport == PHONE
        context = self.browser.new_context(base_url=ORIGIN, color_scheme=scheme, viewport=viewport, service_workers="block",
                                           has_touch=phone, is_mobile=phone, device_scale_factor=1)
        self.addCleanup(context.close)
        return context.new_page()

    def test_01_the_page_matches_the_drawn_sign_in(self) -> None:
        for name, viewport, tile, word in (("1440", DESKTOP, 44, 30), ("390", PHONE, 52, 34)):
            for scheme in ("light", "dark"):
                page = self.page(scheme, viewport)
                page.goto("/sign-in")
                expect(page.get_by_role("heading", level=1, name="Sign in", exact=True)).to_be_visible()
                expect(page.get_by_text("A shared workspace for people and their agents.")).to_be_visible()
                # The plain logo tile: one svg of the drawn size, with the wordmark beside it and nothing else around it.
                brand = page.get_by_role("link", name="Flux home")
                logo = brand.locator("svg.flux-logo")
                box = logo.bounding_box()
                self.assertAlmostEqual(box["width"], tile, delta=0.5)
                self.assertAlmostEqual(box["height"], tile, delta=0.5)
                self.assertEqual(logo.locator("path").count(), 3)  # the tile, the eye pair and the brow
                self.assertEqual(brand.locator(".brand__name").evaluate("el => parseFloat(getComputedStyle(el).fontSize)"), word)
                # No frame, shadow or fill around the tile: the link is only the tile and the word.
                self.assertEqual(brand.evaluate("el => getComputedStyle(el).boxShadow"), "none")
                self.assertEqual(brand.evaluate("el => getComputedStyle(el).backgroundColor"), "rgba(0, 0, 0, 0)")
                # The tile is the ink colour (--inv) and the page sits on the sidebar's surface (--side).
                probe = "(name) => { const e = document.createElement('i'); e.style.color = `var(${name})`; e.style.backgroundColor = `var(${name})`; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; }"
                self.assertEqual(logo.evaluate("el => getComputedStyle(el.querySelector('.flux-logo__tile')).fill"), page.evaluate(probe, "--inv"))
                self.assertEqual(page.locator(".auth").evaluate("el => getComputedStyle(el).backgroundColor"), page.evaluate(probe, "--side"))
                card = page.locator(".auth__card")
                shadow = card.evaluate("el => getComputedStyle(el).boxShadow")
                if viewport == DESKTOP:
                    self.assertNotEqual(shadow, "none")
                    self.assertAlmostEqual(card.bounding_box()["width"], 380, delta=1)
                else:
                    self.assertEqual(shadow, "none")
                # Password mode only: no email link, no passkey, no mixed methods.
                body = page.locator("body").inner_text()
                self.assertNotRegex(body, re.compile("passkey|sign-in link", re.I))
                expect(page.get_by_label("Email")).to_be_visible()
                expect(page.get_by_label("Password")).to_be_visible()
                submit = page.get_by_role("button", name="Sign in", exact=True)
                if viewport == PHONE:
                    self.assertGreaterEqual(submit.bounding_box()["height"], 44)
                shot(page, f"351-signin-{name}-{scheme}")

    def test_02_keyboard_order_and_errors(self) -> None:
        page = self.page("light", DESKTOP)
        page.goto("/sign-in")
        expect(page.get_by_label("Email")).to_be_focused()
        page.keyboard.press("Tab")
        expect(page.get_by_role("link", name="Forgot password?")).to_be_focused()
        page.keyboard.press("Tab")
        expect(page.get_by_label("Password", exact=True)).to_be_focused()
        page.keyboard.press("Tab")
        expect(page.get_by_role("button", name="Sign in", exact=True)).to_be_focused()
        page.get_by_role("button", name="Sign in", exact=True).click()
        expect(page.get_by_role("alert").first.or_(page.locator(".ui-field__error").first)).to_be_visible()
        shot(page, "351-signin-error-1440")

    def test_03_account_pages_share_the_frame(self) -> None:
        for path, title in (("/sign-up", "Create your Flux account"), ("/forgot-password", "Reset your password")):
            page = self.page("dark", PHONE)
            page.goto(path)
            expect(page.get_by_role("heading", level=1, name=title)).to_be_visible()
            expect(page.get_by_role("link", name="Flux home").locator("svg.flux-logo")).to_be_visible()
            overflow = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
            self.assertLessEqual(overflow, 0)
            shot(page, f"351-account-{path.strip('/')}-390-dark")


if __name__ == "__main__":
    unittest.main()
