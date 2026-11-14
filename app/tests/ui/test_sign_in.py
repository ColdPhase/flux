"""Sign-in and account pages: the final design (#351, F-026 sign-in boards) and password mode (F-024 S5a, #313).

`SignIn` checks the drawn page: the plain Flux logo tile above the title and no decoration outside it, a
card on the computer and a bare column on the phone; the page offers no email link or passkey, which Flux
does not have. `SignInPages` checks the password-mode behaviour. The UI stack has no identity provider, so
it is password mode: the sign-in page has the password form, sign-up is open, password reset is available
(mail is set), and the claim page has nothing to claim. The single sign-on page, its refusals and the claim
flow itself are exercised against Keycloak in tests/app/e2e/oidc.e2e.ts (scripts/check_oidc.sh).
Runs through scripts/check_ui.sh against the running Compose application; FLUX_UI_BROWSER picks the engine.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder
from touch_targets import hit_rect


UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")

PASSWORD = "a password that is long enough"
PERSON = {"name": "Sami Ortiz", "email": f"sami.signin+{int(time.time() * 1000)}@example.test"}


class _Browser(unittest.TestCase):
    """One browser of the selected engine per test class."""

    pw = None
    browser: Browser

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        assert cls.browser.browser_type.name == UI_BROWSER
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}")
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()


class SignIn(_Browser):
    def page(self, scheme: str, viewport: dict) -> Page:
        phone = viewport == PHONE
        context = self.browser.new_context(base_url=ORIGIN, color_scheme=scheme, viewport=viewport, service_workers="block",
                                           has_touch=phone, is_mobile=phone, device_scale_factor=1)
        self.addCleanup(context.close)
        return context.new_page()

    def test_01_the_page_matches_the_drawn_sign_in(self) -> None:
        for name, viewport, tile, word in (("1440", DESKTOP, 44, 30), ("390", PHONE, 52, 30)):
            for scheme in ("light", "dark"):
                page = self.page(scheme, viewport)
                page.goto("/sign-in")
                expect(page.get_by_role("heading", level=1, name="Sign in", exact=True)).to_be_visible()
                expect(page.get_by_text("One place for your company’s people and their agents.")).to_be_visible()
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
                if viewport == PHONE:  # last: its final tap opens the reset page
                    self.forgot_password_hit_area_fills_the_gap_between_the_fields(page)

    def forgot_password_hit_area_fills_the_gap_between_the_fields(self, page: Page) -> None:
        """"Forgot password?" is a 17 px line between the Email and Password fields. On a phone its hit area fills the gap between the two
        inputs, wider than the text, and covers neither: a tap on the Password's top edge (or the Email's bottom edge) is that input's."""
        self.assertTrue(page.evaluate("matchMedia('(pointer: coarse)').matches"), "the phone's pointer is coarse")
        page.evaluate("document.fonts.ready.then(() => true)")
        email, password = page.get_by_label("Email"), page.get_by_label("Password", exact=True)
        forgot = page.get_by_role("link", name="Forgot password?")
        area = hit_rect(forgot)  # first: it scrolls the link into view, and the boxes are read after it
        email_box, password_box, text = email.bounding_box(), password.bounding_box(), forgot.bounding_box()
        email_bottom, password_top = email_box["y"] + email_box["height"], password_box["y"]
        self.assertLess(text["height"], 24, f"the link keeps its own small line, only its hit area is larger: {text}")
        self.assertGreaterEqual(area["top"], email_bottom, f"the hit area does not reach into the Email input: {area}, input bottom {email_bottom}")
        self.assertLessEqual(area["bottom"], password_top, f"the hit area does not reach into the Password input: {area}, input top {password_top}")
        self.assertGreaterEqual(area["height"], password_top - email_bottom - 3, f"the hit area fills the gap between the two inputs: {area}, gap {password_top - email_bottom}")
        self.assertGreaterEqual(area["width"], 44, f"and is at least 44 px wide: {area}")
        self.assertLessEqual(area["left"], text["x"] - 16, f"and wider than the text on its left: {area}, text {text}")
        # A tap on the Password's top edge, and on the Email's bottom edge, under the middle of the link, is that input's (focus moves to it, nothing opens).
        x = text["x"] + text["width"] / 2
        page.touchscreen.tap(x, password_box["y"] + 2)
        expect(password).to_be_focused()
        page.touchscreen.tap(x, email_bottom - 2)
        expect(email).to_be_focused()
        expect(page).to_have_url(f"{ORIGIN}/sign-in")
        # A tap in the gap, left of the text where only the widened area reaches, opens the reset page.
        page.touchscreen.tap(text["x"] - 12, (email_bottom + password_top) / 2)
        expect(page).to_have_url(re.compile(r"/forgot-password$"))

    def test_02_keyboard_order_and_errors(self) -> None:
        page = self.page("light", DESKTOP)
        page.goto("/sign-in")
        expect(page.get_by_label("Email")).to_be_focused()
        # "Forgot password?" sits beside the Password label but follows the field in the tab order (#763 FR-8).
        page.keyboard.press("Tab")
        expect(page.get_by_label("Password", exact=True)).to_be_focused()
        page.keyboard.press("Tab")
        expect(page.get_by_role("link", name="Forgot password?")).to_be_focused()
        page.keyboard.press("Tab")
        expect(page.get_by_role("button", name="Sign in", exact=True)).to_be_focused()
        page.get_by_role("button", name="Sign in", exact=True).click()
        expect(page.get_by_role("alert").first.or_(page.locator(".ui-field__error").first)).to_be_visible()
        shot(page, "351-signin-error-1440")

    def test_02b_forgot_password_hit_area_on_a_touch_tablet(self) -> None:
        """The form's gap is 14 px above 640 px wide and 16 px below it; the hit area follows it, so a tablet's is the gap between the inputs too."""
        context = self.browser.new_context(base_url=ORIGIN, color_scheme="light", viewport={"width": 768, "height": 1024}, service_workers="block",
                                           has_touch=True, is_mobile=True, device_scale_factor=1)
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto("/sign-in")
        expect(page.get_by_label("Password", exact=True)).to_be_visible()
        self.forgot_password_hit_area_fills_the_gap_between_the_fields(page)

    def test_03_account_pages_share_the_frame(self) -> None:
        for path, title in (("/sign-up", "Create your Flux account"), ("/forgot-password", "Reset your password")):
            page = self.page("dark", PHONE)
            page.goto(path)
            expect(page.get_by_role("heading", level=1, name=title)).to_be_visible()
            expect(page.get_by_role("link", name="Flux home").locator("svg.flux-logo")).to_be_visible()
            overflow = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
            self.assertLessEqual(overflow, 0)
            shot(page, f"351-account-{path.strip('/')}-390-dark")



class SignInPages(_Browser):
    def page(self):
        context = self.browser.new_context(base_url=ORIGIN, viewport=DESKTOP, color_scheme="light", locale="en-GB", service_workers="block")
        self.addCleanup(context.close)
        return context.new_page()

    def test_01_password_mode_offers_the_password_form_sign_up_and_reset(self) -> None:
        page = self.page()
        page.goto("/sign-in")
        expect(page.get_by_role("heading", level=1, name="Sign in", exact=True)).to_be_visible()
        expect(page.get_by_label("Password")).to_be_visible()
        expect(page.get_by_role("button", name="Sign in", exact=True)).to_be_visible()
        expect(page.get_by_role("link", name="Forgot password?")).to_be_visible()
        expect(page.get_by_role("button", name="Sign in with Keycloak")).to_have_count(0)
        capabilities = json.loads(page.request.get(f"{ORIGIN}/api/v1/auth/capabilities").text())
        self.assertEqual(capabilities, {"company": None, "setup": False, "passwordReset": "available", "signup": "open", "ssoOnly": False, "linkable": False, "sso": None})

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

    def test_06_a_page_opened_from_a_refused_address_is_told_the_one_flux_accepts(self) -> None:
        """#1471: the old loopback address of a server that has moved to its public one says which address to open. The server names the one
        it accepts in the refusal; when that is the page's own address, the words stay general."""
        for named, line in (("https://flux.example.org", "Open Flux at https://flux.example.org and try again."),
                            (ORIGIN, "Open Flux at its usual address and try again.")):
            page = self.page()
            page.route("**/api/auth/sign-in/email", lambda route, _request, named=named: route.fulfill(status=403, content_type="application/json",
                       body=json.dumps({"error": "Forbidden", "code": "ORIGIN_REJECTED", "reason": "origin does not match", "origin": named})))
            page.goto("/sign-in")
            page.get_by_label("Email").fill(PERSON["email"])
            page.get_by_label("Password").fill(PASSWORD)
            page.get_by_role("button", name="Sign in", exact=True).click()
            expect(page.get_by_text(f"This page was opened from an address Flux doesn’t accept. {line}")).to_be_visible()

    def test_04_a_common_password_is_refused_with_the_reason_and_the_account_is_not_made(self) -> None:
        page = self.page()
        email = f"weak.password+{int(time.time() * 1000)}@example.test"
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Weak Password")
        page.get_by_label("Email").fill(email)
        # Twelve characters pass the form's own length rule; the server's list of common passwords refuses this one (#990).
        page.get_by_label("Password").fill("password1234")
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_text("That password is too easy to guess.")).to_be_visible()
        expect(page).to_have_url(re.compile(r"/sign-up"))
        page.get_by_label("Password").fill("a lantern on the harbour wall")
        page.get_by_role("button", name="Create account").click()
        expect(page).to_have_url(f"{ORIGIN}/")

    def test_05_five_wrong_passwords_make_the_page_ask_to_wait_and_the_owner_who_signed_in_before_is_not_locked_out(self) -> None:
        page = self.page()
        # The account is made by one browser context (which is then remembered by the account) and guessed at from another, which is not,
        # and this page has no session and shows the form.
        owner = self.page()
        stranger = self.page()
        email = f"back.off+{int(time.time() * 1000)}@example.test"
        made = owner.request.post(f"{ORIGIN}/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": "Back Off"}, headers={"origin": ORIGIN})
        self.assertEqual(made.status, 200, made.text())
        for attempt in range(5):
            wrong = stranger.request.post(f"{ORIGIN}/api/auth/sign-in/email", data={"email": email, "password": f"wrong guess {attempt} here"}, headers={"origin": ORIGIN})
            self.assertEqual(wrong.status, 401)
        page.goto("/sign-in")
        page.get_by_label("Email").fill(email)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Sign in", exact=True).click()
        # The fifth attempt put the account on a wait: even the right password is refused from a browser nobody knows, with the way out.
        # The page asks to wait a few minutes and does not count the seconds down.
        expect(page.get_by_text("Too many sign-in attempts for this account. Try again in a few minutes. If you have forgotten the password, you can reset it.")).to_be_visible()
        expect(page).to_have_url(re.compile(r"/sign-in"))
        # The browser that made the account is remembered: the stranger's guesses do not keep the owner out.
        known = owner.request.post(f"{ORIGIN}/api/auth/sign-in/email", data={"email": email, "password": PASSWORD}, headers={"origin": ORIGIN})
        self.assertEqual(known.status, 200, known.text())

    def test_03_the_claim_page_has_nothing_to_claim_without_a_provider_sign_in(self) -> None:
        page = self.page()
        page.goto("/claim")
        expect(page.get_by_role("heading", name="There is nothing to claim here")).to_be_visible()
        expect(page.get_by_role("button", name="Claim this address")).to_have_count(0)
        self.assertEqual(json.loads(page.request.get(f"{ORIGIN}/api/v1/identity/claim").text())["code"], "CLAIM_NOT_FOUND")



if __name__ == "__main__":
    unittest.main()
