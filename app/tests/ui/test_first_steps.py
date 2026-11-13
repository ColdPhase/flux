"""Browser tests for Home's first-steps card (founder decisions 2026-11-13, #1438; docs/design/final/README.md "Home").

Runs with the other tests/ui modules through scripts/check_ui.sh against the running Compose application. FLUX_UI_BROWSER selects
chromium (default) or webkit. Fia owns a fresh company still called "Company": her card has Name your company, Invite people and
Connect AI, each leading to its place and leaving once done. Gus is a member: Write your first message opens the space everyone reads
with the composer ready, Add your photo opens Account. Hide hides the card for good. A guest gets no card. Ida is a member who writes her
first message and adds a photo: she has no card on any device, and it does not return when her photo goes. Only a new person has a card; the
member who joined long ago is the API test's (tests/app/first-steps.test.ts). Desktop 1440 and phone 390;
screenshots (first-steps-*-<browser>.png) go to FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, start_forwarder
from test_profile_photo import PHOTO
from test_settings import UI_BROWSER, shot

PASSWORD = "first steps for every new person"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "fia": ("Fia Holm", f"fia.steps+{STAMP}@example.test"),
    "gus": ("Gus Lind", f"gus.steps+{STAMP}@example.test"),
    "hal": ("Hal Berg", f"hal.steps+{STAMP}@example.test"),
    "ida": ("Ida Ahl", f"ida.steps+{STAMP}@example.test"),
}


class FirstStepsJourney(unittest.TestCase):
    """Tests run in name order and share the accounts and the workspace."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

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
        context = cls.browser.new_context(base_url=ORIGIN, service_workers="block", storage_state=cls.states["fia"])
        # A fresh company keeps the name setup gives it, "Company", until its owner names it.
        created = context.request.post("/api/v1/workspaces", data={"name": "Company"}, headers={"origin": ORIGIN})
        assert created.status == 201, created.text()
        cls.ids["company"] = created.json()["id"]
        everyone = context.request.post(f"/api/v1/workspaces/{cls.ids['company']}/projects", data={"name": "Everyone", "visibility": "workspace"}, headers={"origin": ORIGIN})
        cls.ids["everyone"] = everyone.json()["id"] if everyone.status == 201 else ""
        context.close()

    def add_people(self) -> None:
        """Gus and Ida (members) and Hal (guest) join after Fia's first steps: someone else in the company ends her Invite people step."""
        if self.ids.get("added"):
            return
        context = self.browser.new_context(base_url=ORIGIN, service_workers="block", storage_state=self.states["fia"])
        self.addCleanup(context.close)
        for key, role in (("gus", "member"), ("hal", "guest"), ("ida", "member")):
            added = context.request.post(f"/api/v1/workspaces/{self.ids['company']}/members", data={"email": PEOPLE[key][1], "role": role}, headers={"origin": ORIGIN})
            self.assertEqual(added.status, 201, added.text())
        self.ids["added"] = "1"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str, *, phone: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "service_workers": "block", "storage_state": self.states[who]}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def card(self, page: Page):
        return page.locator("[data-first-steps]")

    def rows(self, page: Page) -> list[str]:
        return [title.strip() for title in self.card(page).locator(".home__row-t").all_inner_texts()]

    def test_01_the_owner_of_a_fresh_company_names_it_invites_and_connects_ai(self) -> None:
        page = self.page("fia")
        page.goto("/")
        card = self.card(page)
        expect(card.get_by_role("heading", name="First steps")).to_be_visible()
        expect(card.locator(".home__row-t")).to_have_count(3)
        self.assertEqual(self.rows(page), ["Name your company", "Invite people", "Connect AI"])
        # Above what waits for her.
        self.assertLess(card.bounding_box()["y"], page.get_by_role("heading", name=re.compile("^Waiting for you")).bounding_box()["y"])
        shot(page, f"first-steps-owner-1440-{UI_BROWSER}")

        card.get_by_role("link", name=re.compile("^Name your company")).click()
        expect(page).to_have_url(re.compile(r"/settings/company\?name=1$"))
        name = page.get_by_label("Company name", exact=True)
        expect(name).to_be_visible()
        name.fill("Hollow Crafts")
        page.get_by_role("button", name="Save name").click()
        expect(page.get_by_role("region", name="Name")).to_contain_text("Hollow Crafts")
        page.goto("/")
        expect(card.locator(".home__row-t")).to_have_count(2)
        self.assertEqual(self.rows(page), ["Invite people", "Connect AI"], "a done step leaves")

        card.get_by_role("link", name=re.compile("^Invite people")).click()
        invite = page.get_by_role("region", name="Invite people")
        expect(invite).to_be_visible()
        invite.get_by_role("button", name="Create invite link").click()
        expect(invite.get_by_role("group", name="New invite link")).to_be_visible()
        page.goto("/")
        expect(card.locator(".home__row-t")).to_have_count(1)

        card.get_by_role("link", name=re.compile("^Connect AI")).click()
        expect(page).to_have_url(re.compile(r"/settings/agents\?connect=1$"))
        expect(page.get_by_role("dialog", name="Connect your AI")).to_be_visible()

    def test_02_a_new_member_writes_in_everyone_and_adds_a_photo(self) -> None:
        self.add_people()
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page("gus", phone=phone)
                page.goto("/")
                card = self.card(page)
                expect(card.get_by_role("heading", name="First steps")).to_be_visible()
                rows = self.rows(page)
                self.assertLessEqual(len(rows), 3)
                for admin_row in ("Name your company", "Invite people", "Connect AI"):
                    self.assertNotIn(admin_row, rows, "a member never sees an owner's or admin's row")
                self.assertIn("Add your photo", rows)
                if self.ids["everyone"]:
                    self.assertEqual(rows[0], "Write your first message")
                shot(page, f"first-steps-member-{'390' if phone else '1440'}-{UI_BROWSER}")
        if not self.ids["everyone"]:
            return
        page = self.page("gus")
        page.goto("/")
        self.card(page).get_by_role("link", name=re.compile("^Write your first message")).click()
        expect(page).to_have_url(re.compile(f"/projects/{self.ids['everyone']}"))
        composer = page.locator("#project-composer")
        expect(composer).to_be_focused()
        page.keyboard.type(f"Hello from Gus {uuid.uuid4().hex[:6]}")
        page.keyboard.press("Enter")
        expect(page.get_by_text(re.compile("^Hello from Gus"))).to_be_visible()
        page.goto("/")
        expect(self.card(page).get_by_role("heading", name="First steps")).to_be_visible()
        self.assertNotIn("Write your first message", self.rows(page))
        self.card(page).get_by_role("link", name=re.compile("^Add your photo")).click()
        expect(page).to_have_url(re.compile(r"/settings/account$"))

    def test_03_hide_is_for_good_and_a_guest_gets_no_card(self) -> None:
        self.add_people()
        page = self.page("gus")
        page.goto("/")
        card = self.card(page)
        card.get_by_role("button", name="Hide").click()
        expect(card).to_have_count(0)
        other = self.page("gus", phone=True)
        other.goto("/")
        expect(other.get_by_role("heading", level=2, name=re.compile("^Good"))).to_be_visible()
        expect(self.card(other)).to_have_count(0)
        guest = self.page("hal")
        guest.goto("/")
        expect(guest.get_by_role("heading", level=2, name=re.compile("^Good"))).to_be_visible()
        expect(self.card(guest)).to_have_count(0)

    def test_04_a_member_who_finished_has_no_card_on_any_device_and_it_never_returns(self) -> None:
        self.add_people()
        self.assertTrue(self.ids["everyone"], "the company has its Everyone space")
        ida = self.browser.new_context(base_url=ORIGIN, service_workers="block", storage_state=self.states["ida"])
        self.addCleanup(ida.close)
        written = ida.request.post(f"/api/v1/projects/{self.ids['everyone']}/conversations", data={"body": "Hello, I am Ida.", "clientMessageId": str(uuid.uuid4())}, headers={"origin": ORIGIN})
        self.assertEqual(written.status, 201, written.text())
        photo = ida.request.put("/api/v1/me/photo", data=PHOTO, headers={"origin": ORIGIN, "content-type": "image/png"})
        self.assertEqual(photo.status, 200, photo.text())

        def home(*, phone: bool) -> None:
            page = self.page("ida", phone=phone)
            with page.expect_response(lambda response: response.url.endswith("/api/v1/me/first-steps") and response.request.method == "GET") as read:
                page.goto("/")
            answer = read.value.json()
            self.assertEqual((answer["steps"], answer["offerPush"]), ([], False), "no step left, and notifications alone are not offered")
            expect(page.get_by_role("heading", level=2, name=re.compile("^Good"))).to_be_visible()
            expect(self.card(page)).to_have_count(0)

        # Nothing is left: no card, and no row for notifications alone, on a computer and on a new phone.
        home(phone=False)
        home(phone=True)
        # A step undone later does not bring it back, on a device that never saw it.
        removed = ida.request.delete("/api/v1/me/photo", headers={"origin": ORIGIN})
        self.assertEqual(removed.status, 204, removed.text())
        home(phone=True)


if __name__ == "__main__":
    unittest.main()
