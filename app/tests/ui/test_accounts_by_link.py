"""Browser tests for accounts and password resets by link (#1471; docs/development/access-policy.md#accounts-only-from-a-link-1471).

Runs with the other tests/ui modules through scripts/check_ui.sh against the running Compose application, a test deployment
whose company was set up by company_setup.py. FLUX_UI_BROWSER selects chromium (default) or webkit.

- Setup: a Flux with no company (its capabilities answered by the test) opens Setup from the sign-in page; the setup link's
  token leaves the address at once and travels with the sign-up; Setup without the token, or once the company exists, has no form.
- Sign-up without a link (an install's capabilities) is no form, and the sign-in page says to open the invite link.
- An invite link for one address fills that address in, read-only, on the join page; the new account joins as it is made.
- The company's owner makes a reset link next to that person in Settings › Company; the link opens Choose a new password,
  sets it once, and the address loses the token.
"""

from __future__ import annotations

import json
import re
import time
import unittest

from playwright.sync_api import Browser, BrowserContext, Page, Route, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, start_forwarder
from test_settings import UI_BROWSER, shot

STAMP = int(time.time() * 1000)
OWNER = ("company-setup@example.test", "company setup for the checks")  # company_setup.py
NEWCOMER = ("Rosa Ilves", f"rosa.link+{STAMP}@example.test")
PASSWORD = "a link made this account"
NEW_PASSWORD = "a reset link chose this one"
SETUP_TOKEN = "5e7" * 21 + "a"
INSTALL = {"company": None, "setup": False, "passwordReset": "unavailable", "signup": "link", "ssoOnly": False, "linkable": False, "sso": None}


class AccountsByLink(unittest.TestCase):
    """Tests run in name order and share the newcomer's account."""

    pw = None
    browser: Browser
    company = ""

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, *, owner: bool = False, phone: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "service_workers": "block"}
        options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP, device_scale_factor=1)
        context: BrowserContext = self.browser.new_context(**options)
        self.addCleanup(context.close)
        if owner:
            signed = context.request.post("/api/auth/sign-in/email", data={"email": OWNER[0], "password": OWNER[1]}, headers={"origin": ORIGIN})
            self.assertEqual(signed.status, 200, signed.text())
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    @staticmethod
    def capabilities(page: Page, **changes: object) -> None:
        page.route("**/api/v1/auth/capabilities", lambda route: route.fulfill(json={**INSTALL, **changes}))

    # ---------------------------------------------------------------- setup

    def test_01_a_flux_without_a_company_opens_setup_and_the_sign_up_carries_the_token(self) -> None:
        page = self.page()
        self.capabilities(page, setup=True)
        page.goto("/sign-in")
        expect(page).to_have_url(re.compile(r"/setup$"))
        expect(page.get_by_role("heading", level=1, name="Open the setup link")).to_be_visible()
        expect(page.get_by_text("Use the whole link that ./flux up printed on the server.")).to_be_visible()
        expect(page.get_by_role("textbox")).to_have_count(0)

        sent: list[dict] = []
        def refuse(route: Route) -> None:
            sent.append(json.loads(route.request.post_data or "{}"))
            route.fulfill(status=403, json={"code": "SETUP_LINK_INVALID", "message": "This setup link is not this Flux’s"})
        page = self.page()
        self.capabilities(page, setup=True)
        page.route("**/api/auth/sign-up/email", refuse)
        page.goto(f"/setup#{SETUP_TOKEN}")
        expect(page.get_by_role("heading", level=1, name="Set up Flux")).to_be_visible()
        expect(page.get_by_text("Create the owner’s account. You name the company next.")).to_be_visible()
        self.assertEqual(page.evaluate("location.hash"), "", "the token leaves the address and the history")
        page.get_by_label("Name").fill("Owner Person")
        page.get_by_label("Email").fill(f"owner.setup+{STAMP}@example.test")
        page.get_by_label("Password").fill(PASSWORD)
        shot(page, "setup-desktop-1440")
        page.get_by_role("button", name="Create owner account").click()
        expect(page.get_by_role("alert")).to_contain_text("This setup link doesn’t work. Open the whole link that ./flux up printed on the server.")
        self.assertEqual([(body.get("setupToken"), body.get("email")) for body in sent], [(SETUP_TOKEN, f"owner.setup+{STAMP}@example.test")])

    def test_02_setup_once_the_company_exists_has_no_form(self) -> None:
        page = self.page(phone=True)
        page.goto(f"/setup#{SETUP_TOKEN}")
        expect(page.get_by_role("heading", level=1, name="This Flux is set up")).to_be_visible()
        expect(page.get_by_role("textbox")).to_have_count(0)
        page.get_by_role("link", name="Sign in").click()
        expect(page.get_by_role("heading", level=1, name="Sign in")).to_be_visible()

    def test_03_without_a_link_there_is_no_form_to_create_an_account(self) -> None:
        page = self.page(phone=True)
        self.capabilities(page)
        page.goto("/sign-in")
        expect(page.get_by_text("New here? Open the invite link you were sent.")).to_be_visible()
        expect(page.get_by_role("link", name="Create an account")).to_have_count(0)
        page.goto("/sign-up")
        expect(page.get_by_role("heading", level=1, name="Ask for an invite link")).to_be_visible()
        expect(page.get_by_text("Accounts on this Flux are made from an invite link. Ask an owner or admin of your company for one.")).to_be_visible()
        expect(page.get_by_role("textbox")).to_have_count(0)
        shot(page, "sign-up-without-link-phone-390")

    # ---------------------------------------------------------------- an invite for one address

    def test_04_an_invite_for_one_address_fills_it_in_and_joins_as_the_account_is_made(self) -> None:
        owner = self.page(owner=True)
        company = next(item for item in owner.request.get("/api/v1/workspaces").json() if item.get("company"))
        type(self).company = company["id"]
        made = owner.request.post(f"/api/v1/workspaces/{self.company}/invites", data={"role": "member", "email": NEWCOMER[1].upper()},
                                  headers={"origin": ORIGIN})
        self.assertEqual(made.status, 201, made.text())

        page = self.page(phone=True)
        page.goto(made.json()["link"])
        expect(page.get_by_role("heading", level=1, name=f"Join {company['name']}")).to_be_visible()
        expect(page.get_by_role("note")).to_contain_text(f"This link works only for {NEWCOMER[1]}.")
        # #1438: the join page is the create-account form; #1471: the link's address is filled in, read-only.
        form = page.get_by_role("form", name="Create account and join")
        email = form.get_by_label("Email")
        expect(email).to_have_value(NEWCOMER[1])
        expect(email).not_to_be_editable()
        expect(form.get_by_text("This invite is for this address.")).to_be_visible()
        shot(page, "join-locked-address-phone-390")
        form.get_by_label("Name").fill(NEWCOMER[0])
        form.get_by_label("Password").fill(PASSWORD)
        form.get_by_role("button", name="Create account and join").click()
        expect(page).not_to_have_url(re.compile(r"/join"))
        members = {member["email"]: member["role"] for member in owner.request.get(f"/api/v1/workspaces/{self.company}/members").json()}
        self.assertEqual(members.get(NEWCOMER[1]), "member")

    # ---------------------------------------------------------------- a reset link next to a person

    def test_05_the_owner_makes_a_reset_link_next_to_the_person_and_it_works_once(self) -> None:
        owner = self.page(owner=True)
        owner.goto("/settings/company")
        owner.get_by_role("button", name=f"Change {NEWCOMER[0]}, Member").click()
        group = owner.get_by_role("group", name="Password")
        expect(group.get_by_text("Make a one-time link that lets Rosa choose a new password.")).to_be_visible()
        group.get_by_role("button", name="Make reset link").click()
        field = group.get_by_label(f"Reset link for {NEWCOMER[0]}")
        expect(field).to_have_value(re.compile(f"^{re.escape(ORIGIN)}/reset-password#[A-Za-z0-9_-]{{24}}$"))
        expect(group.get_by_role("status")).to_contain_text("It stops working when it is used or in 1 hour.")
        shot(owner, "reset-link-company-desktop-1440")
        link = field.input_value()

        page = self.page(phone=True)
        page.goto(link)
        expect(page.get_by_role("heading", level=1, name="Choose a new password")).to_be_visible()
        self.assertEqual(page.evaluate("location.hash"), "", "the token leaves the address")
        page.get_by_label("New password", exact=True).fill(NEW_PASSWORD)
        page.get_by_label("Repeat new password").fill(NEW_PASSWORD)
        page.get_by_role("button", name="Save new password").click()
        expect(page).to_have_url(re.compile(r"/sign-in"))
        signed = page.request.post("/api/auth/sign-in/email", data={"email": NEWCOMER[1], "password": NEW_PASSWORD}, headers={"origin": ORIGIN})
        self.assertEqual(signed.status, 200, signed.text())

        again = self.page()
        again.goto(link)
        again.get_by_label("New password", exact=True).fill("and once more with it")
        again.get_by_label("Repeat new password").fill("and once more with it")
        again.get_by_role("button", name="Save new password").click()
        expect(again.get_by_role("alert")).to_contain_text("This reset link has expired or was already used.")

    def test_06_without_email_the_reset_page_names_who_makes_a_link(self) -> None:
        page = self.page()
        self.capabilities(page)
        page.goto("/forgot-password")
        expect(page.get_by_text("Ask an owner or admin of your company for a reset link: they make one in Settings › Company.")).to_be_visible()


if __name__ == "__main__":
    unittest.main()
