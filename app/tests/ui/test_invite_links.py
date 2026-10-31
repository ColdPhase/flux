"""Browser tests for invite links (F-035, #763 PE-2; docs/development/access-policy.md#invite-links-f-035).

Runs with the other tests/ui modules through scripts/check_ui.sh against the running Compose application.
FLUX_UI_BROWSER selects chromium (default) or webkit. Ada owns Riverside Makers. In People she makes a member link
for anyone; Nia, who has no account, opens it on a phone, creates one and joins. Ada locks a guest link to Ben's
address: Cleo's account is refused, Ben signs in through it and joins. A revoked link says it no longer works. In
an encrypted workspace an admin joins and is told an unlock password comes only from someone who has one. Desktop
1440 and phone 390. Every step is checked against the API. Screenshots (invite-*-<browser>.png) go to
FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from app_select import choose
from app_select import labels as app_labels
from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, open_details, start_forwarder
from test_settings import UI_BROWSER, shot

PASSWORD = "invite links join the workspace"
SEALED_PASSWORD = "quartz lantern hollow meadow ripple kestrel 4821"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.invite+{STAMP}@example.test"),
    "ben": ("Ben Okafor", f"ben.invite+{STAMP}@example.test"),
    "cleo": ("Cleo Duarte", f"cleo.invite+{STAMP}@example.test"),
    "dan": ("Dan Reyes", f"dan.invite+{STAMP}@example.test"),
}
NIA = ("Nia Lindqvist", f"nia.invite+{STAMP}@example.test")


class InviteLinksJourney(unittest.TestCase):
    """Tests run in name order and share the accounts and the workspace."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    riverside = ""

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            context.close()
        context = cls.browser.new_context(base_url=ORIGIN, service_workers="block", storage_state=cls.states["ada"])
        created = context.request.post("/api/v1/workspaces", data={"name": "Riverside Makers"}, headers={"origin": ORIGIN})
        assert created.status == 201, created.text()
        cls.riverside = created.json()["id"]
        context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    # ---------------------------------------------------------------- helpers

    def page(self, who: str | None, *, phone: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "service_workers": "block"}
        if who:
            options["storage_state"] = self.states[who]
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        context: BrowserContext = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def roles(self, workspace_id: str) -> dict[str, str]:
        context = self.browser.new_context(base_url=ORIGIN, service_workers="block", storage_state=self.states["ada"])
        self.addCleanup(context.close)
        response = context.request.get(f"/api/v1/workspaces/{workspace_id}/members")
        self.assertEqual(response.status, 200, response.text())
        return {member["email"]: member["role"] for member in response.json()}

    def pending(self, workspace_id: str) -> list[dict]:
        context = self.browser.new_context(base_url=ORIGIN, service_workers="block", storage_state=self.states["ada"])
        self.addCleanup(context.close)
        response = context.request.get(f"/api/v1/workspaces/{workspace_id}/invites")
        self.assertEqual(response.status, 200, response.text())
        return response.json()

    def open_people(self, page: Page) -> None:
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        open_details(page)
        page.get_by_role("region", name="People").get_by_role("button", name=re.compile("^Riverside Makers")).click()
        expect(page.get_by_role("heading", name="People", exact=True)).to_be_visible()

    def make_link(self, page: Page, role: str, email: str = "") -> str:
        region = page.get_by_role("region", name="Invite with a link")
        choose(region.get_by_label("Joins as"), label=role)
        region.get_by_label("Only for (optional)").fill(email)
        region.get_by_role("button", name="Create invite link").click()
        link = region.get_by_role("group", name="New invite link").get_by_role("textbox")
        expect(link).to_have_value(re.compile(f"^{re.escape(ORIGIN)}/join#[A-Za-z0-9_-]{{54}}$"))
        expect(region.get_by_role("status")).to_contain_text("Invite link created")
        return link.input_value()

    # ---------------------------------------------------------------- the journey

    def test_01_owner_makes_a_link_in_people(self) -> None:
        page = self.page("ada")
        self.open_people(page)
        region = page.get_by_role("region", name="Invite with a link")
        expect(region.get_by_label("Works for")).to_contain_text("7 days")
        # Ada is an owner: Admin is offered; never Owner.
        self.assertEqual(app_labels(region.get_by_label("Joins as")), ["Member", "Guest", "Admin"])
        link = self.make_link(page, "Member")
        pending = region.get_by_role("list", name=re.compile("^Waiting to be used"))
        expect(pending.get_by_role("listitem")).to_have_count(1)
        expect(pending.get_by_role("listitem").first).to_contain_text("Anyone with the link")
        expect(pending.get_by_role("listitem").first).to_contain_text("Member")
        listed = self.pending(self.riverside)
        self.assertEqual([(item["role"], item["email"], item["link"]) for item in listed], [("member", None, link)])
        type(self).member_link = link
        shot(page, "invite-people-desktop-1440")

    def test_02_someone_new_creates_an_account_through_the_link_on_a_phone(self) -> None:
        page = self.page(None, phone=True)
        page.goto(self.member_link)
        expect(page.get_by_role("heading", level=1, name="Join Riverside Makers")).to_be_visible()
        expect(page.get_by_text("Ada Kowalska invited you to Riverside Makers as a member.")).to_be_visible()
        # The token is kept in this tab only: not in the address or the history (#776 review P3-2).
        self.assertEqual(page.evaluate("location.hash"), "")
        self.assertEqual(page.url, f"{ORIGIN}/join")
        shot(page, "invite-join-signed-out-phone-390")
        page.get_by_role("button", name="Create an account").click()
        expect(page).to_have_url(re.compile(r"/sign-up\?next=%2Fjoin%3Fcreated%3D1$"))
        page.get_by_label("Name").fill(NIA[0])
        page.get_by_label("Email").fill(NIA[1])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        # #763 FT-3: an account made from the link joins as it is made; there is no second "Join" to press.
        expect(page.get_by_role("heading", level=1, name="You joined Riverside Makers")).to_be_visible()
        self.assertEqual(page.url, f"{ORIGIN}/join")
        expect(page.get_by_text("You’re a member of Riverside Makers.")).to_be_visible()
        page.get_by_role("button", name="Open Riverside Makers").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        self.assertEqual(self.roles(self.riverside).get(NIA[1]), "member")
        self.assertEqual(self.pending(self.riverside), [], "the used link is no longer listed")
        # The link worked once: opening it again from this account says there is nothing more to do.
        page.goto(self.member_link)
        expect(page.get_by_role("heading", level=1, name="You’re in Riverside Makers")).to_be_visible()

    def test_03_an_email_lock_admits_only_that_address(self) -> None:
        owner = self.page("ada")
        self.open_people(owner)
        link = self.make_link(owner, "Guest", PEOPLE["ben"][1].upper())
        item = owner.get_by_role("list", name=re.compile("^Waiting to be used")).get_by_role("listitem").first
        expect(item).to_contain_text(PEOPLE["ben"][1])
        expect(item).to_contain_text("Guest")

        cleo = self.page("cleo")
        cleo.goto(link)
        expect(cleo.get_by_text("This link works only for the email address it was sent to.")).to_be_visible()
        cleo.get_by_role("button", name="Join Riverside Makers").click()
        expect(cleo.get_by_role("alert")).to_contain_text("This link was made for a different email address.")
        self.assertNotIn(PEOPLE["cleo"][1], self.roles(self.riverside))

        # Ben, signed out, signs in through the link and joins as a guest.
        ben = self.page(None)
        ben.goto(link)
        ben.get_by_role("button", name="Sign in to join").click()
        ben.get_by_label("Email").fill(PEOPLE["ben"][1])
        ben.get_by_label("Password").fill(PASSWORD)
        ben.get_by_role("button", name="Sign in").click()
        ben.get_by_role("button", name="Join Riverside Makers").click()
        expect(ben.get_by_role("heading", level=1, name="You joined Riverside Makers")).to_be_visible()
        expect(ben.get_by_text("You’re a guest of Riverside Makers.")).to_be_visible()
        self.assertEqual(self.roles(self.riverside).get(PEOPLE["ben"][1]), "guest")
        # Ada's People shows Ben without a reload (the join is an event of the workspace).
        expect(owner.get_by_role("list", name="People in Riverside Makers")).to_contain_text("Ben Okafor")

    def test_04_a_revoked_link_no_longer_works(self) -> None:
        owner = self.page("ada", phone=True)
        self.open_people(owner)
        link = self.make_link(owner, "Member")
        owner.get_by_role("button", name="Revoke link for Anyone with the link").click()
        # #763 FT-13: a revoked link can't come back, so Revoke asks once, in place.
        owner.get_by_role("group", name="Revoke link for Anyone with the link").get_by_role("button", name="Revoke link").click()
        expect(owner.get_by_role("region", name="Invite with a link").get_by_role("status")).to_have_text("Invite link revoked. It no longer works.")
        self.assertEqual(self.pending(self.riverside), [])
        shot(owner, "invite-people-phone-390")
        visitor = self.page(None, phone=True)
        visitor.goto(link)
        expect(visitor.get_by_role("heading", level=1, name="This invite link no longer works")).to_be_visible()
        # A link that never existed says only that it does not work.
        visitor.goto(f"/join#{'A' * 54}")
        visitor.reload()
        expect(visitor.get_by_role("heading", level=1, name="This invite link doesn’t work")).to_be_visible()

    def test_04b_with_single_sign_on_the_first_sign_in_makes_the_account(self) -> None:
        """#776 review P2: SSO-only reports sign-up off, yet the first single sign-on creates the account (F-024)."""
        context = self.browser.new_context(base_url=ORIGIN, service_workers="block", storage_state=self.states["ada"])
        self.addCleanup(context.close)
        invite = context.request.post(f"/api/v1/workspaces/{self.riverside}/invites", data={"role": "member"}, headers={"origin": ORIGIN, "idempotency-key": str(uuid.uuid4())})
        self.assertEqual(invite.status, 201, invite.text())
        visitor = self.page(None)
        visitor.route("**/api/v1/auth/capabilities", lambda route: route.fulfill(json={
            "passwordReset": "unavailable", "signup": "off", "ssoOnly": True, "linkable": False,
            "sso": {"providerId": "company", "label": "Company SSO", "reachable": True}}))
        visitor.goto(invite.json()["link"])
        expect(visitor.get_by_text("New here? Sign in with Company SSO; your account is made the first time.")).to_be_visible()
        expect(visitor.get_by_text("New accounts are closed on this Flux server.")).to_have_count(0)
        expect(visitor.get_by_role("button", name="Sign in to join")).to_be_visible()
        # A tab without the token (a sign-in finished in another tab) asks for the link again (#776 review P3-3).
        fresh = self.page(None)
        fresh.goto("/join")
        expect(fresh.get_by_role("heading", level=1, name="Open the invite link again in this tab")).to_be_visible()

    def test_05_an_admin_joining_an_encrypted_workspace_learns_how_keys_work(self) -> None:
        context = self.browser.new_context(base_url=ORIGIN, service_workers="block", storage_state=self.states["ada"])
        self.addCleanup(context.close)
        created = context.request.post("/api/v1/encrypted-workspaces", data={"name": "Garden club", "creationId": str(uuid.uuid4()), "password": SEALED_PASSWORD},
                                       headers={"origin": ORIGIN, "authorization": f"Bearer {os.environ['FLUX_FIXTURE_TOKEN']}"})
        self.assertEqual(created.status, 201, created.text())
        sealed = created.json()["workspace"]["id"]
        invite = context.request.post(f"/api/v1/workspaces/{sealed}/invites", data={"role": "admin"}, headers={"origin": ORIGIN, "idempotency-key": str(uuid.uuid4())})
        self.assertEqual(invite.status, 201, invite.text())

        dan = self.page("dan", phone=True)
        dan.goto(invite.json()["link"])
        expect(dan.get_by_role("heading", level=1, name="Join Garden club")).to_be_visible()
        expect(dan.get_by_role("note")).to_contain_text("Garden club is encrypted.")
        expect(dan.get_by_role("note")).to_contain_text("As an admin you get your own unlock password only when someone who has one lets you set it.")
        dan.get_by_role("button", name="Join Garden club").click()
        expect(dan.get_by_role("heading", level=1, name="You joined Garden club")).to_be_visible()
        expect(dan.locator("[data-invite-keys='needed']")).to_contain_text("Garden club is encrypted. You don’t have an unlock password yet.")
        shot(dan, "invite-joined-encrypted-phone-390")
        self.assertEqual(self.roles(sealed).get(PEOPLE["dan"][1]), "admin")
        dan.get_by_role("button", name="Open Garden club").click()
        expect(dan.get_by_role("heading", level=1, name="Home")).to_be_visible()


if __name__ == "__main__":
    unittest.main()
