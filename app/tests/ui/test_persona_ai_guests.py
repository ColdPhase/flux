"""Browser tests for the v0.2.1 final persona round's AI and guest findings (founder decisions on #1424).

Runs with the other tests/ui modules through scripts/check_ui.sh against the running Compose application. FLUX_UI_BROWSER selects
chromium (default) or webkit. Ola owns Nowak Bakery; Mia is a member with no AI; Gia is a guest. Covered:

- P2 #1, E-3: `/ai` chosen without an assistant opens the one Connect AI window (as Settings › AI and Home do), in a space and in a direct
  message; the ask bar's Connect your AI opens the same window; there is no side panel with an MCP explainer. On a server that runs no AI
  `/ai` is not offered. A guest is told who can give them AI.
- P2 #2: a guest's Home does not say they can start a space, New has no Space tab, and its Task tab does not point to New space.
- P2 #3: Space settings says "Guest" for a guest, to the owner, a member and the guest herself, and a guest has no AI row.
- P3: the people list refreshes when someone is added elsewhere; "Everyone … is already in …" when nobody is left to add; the company's
  invite form has Close; Invite then Cancel in New space leaves no working link.
Desktop 1440; screenshots (persona-*-<browser>.png) go to FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, Route, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UPSTREAM, start_forwarder
from test_settings import UI_BROWSER, shot

PASSWORD = "persona round ai and guests"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ola": ("Ola Nowak", f"ola.pag+{STAMP}@example.test"),
    "mia": ("Mia Kran", f"mia.pag+{STAMP}@example.test"),
    "gia": ("Gia Mlyn", f"gia.pag+{STAMP}@example.test"),
    "tom": ("Tom Lis", f"tom.pag+{STAMP}@example.test"),
}


class PersonaAiAndGuests(unittest.TestCase):
    """Tests run in name order and share the accounts and the company."""

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
        context = cls.browser.new_context(base_url=ORIGIN, service_workers="block", storage_state=cls.states["ola"])
        post = lambda path, body: context.request.post(path, data=body, headers={"origin": ORIGIN, "idempotency-key": str(uuid.uuid4())})  # noqa: E731
        company = post("/api/v1/workspaces", {"name": "Nowak Bakery"})
        assert company.status == 201, company.text()
        cls.ids["company"] = company.json()["id"]
        for key, role in (("mia", "member"), ("gia", "guest"), ("tom", "member")):
            added = post(f"/api/v1/workspaces/{cls.ids['company']}/members", {"email": PEOPLE[key][1], "role": role})
            assert added.status == 201, added.text()
        space = post(f"/api/v1/workspaces/{cls.ids['company']}/projects", {"name": "Shop floor", "visibility": "restricted"})
        assert space.status == 201, space.text()
        cls.ids["space"] = space.json()["id"]
        granted = post(f"/api/v1/projects/{cls.ids['space']}/grants", {"principal": {"kind": "human", "id": cls.ids["mia"]}, "role": "contributor"})
        assert granted.status == 201, granted.text()
        dm = post(f"/api/v1/workspaces/{cls.ids['company']}/dms", {"participantIds": [cls.ids["mia"]]})
        assert dm.status == 201, dm.text()
        cls.ids["dm"] = dm.json()["id"]
        context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str) -> Page:
        context = self.browser.new_context(base_url=ORIGIN, locale="en-GB", timezone_id="Europe/Warsaw", service_workers="block",
                                           storage_state=self.states[who], viewport=DESKTOP, device_scale_factor=1)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None) -> dict | list:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json",
                                      "idempotency-key": str(uuid.uuid4())}, data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def connect_window(self, page: Page):
        return page.get_by_role("dialog", name="Connect your AI")

    # ---------------------------------------------------------------- P2 #1, E-3: one Connect AI

    def test_01_ai_without_an_assistant_opens_the_one_connect_ai_window(self) -> None:
        page = self.page("mia")
        status = self.api(page, "GET", "/api/v1/personal-assistant", status=200)
        self.assertEqual(status["state"], "not_enabled")
        page.goto(f"/projects/{self.ids['space']}")
        composer = page.locator("#project-composer")
        expect(composer).to_be_visible()
        composer.fill("/")
        option = page.get_by_role("option", name=re.compile(r"^\/ai"))
        expect(option).to_have_count(1)
        option.click()
        # The same window as Settings › AI's Connect AI: its title, its choices and Cancel; no side panel of MCP words.
        window = self.connect_window(page)
        expect(window).to_be_visible()
        expect(window.get_by_role("heading", name="Connect your AI")).to_be_visible()
        expect(window.get_by_role("radiogroup", name="What to connect")).to_be_visible()
        expect(page.get_by_role("complementary", name="Connect your AI")).to_have_count(0)
        expect(page.get_by_text(re.compile("MCP client|personal Flux grant|The ✦ button"))).to_have_count(0)
        shot(page, f"persona-connect-ai-from-composer-{UI_BROWSER}")
        window.get_by_role("button", name="Cancel").click()
        expect(window).to_have_count(0)
        # The ask bar still says so, and its Connect your AI opens the same window again.
        bar = page.locator("#project-ask")
        expect(bar).to_contain_text("You haven’t set up your assistant.")
        bar.get_by_role("button", name="Connect your AI").click()
        expect(self.connect_window(page)).to_be_visible()
        page.keyboard.press("Escape")
        expect(self.connect_window(page)).to_have_count(0)

        # A direct message's composer: the same command, the same window.
        page.goto(f"/dm/{self.ids['dm']}")
        dm = page.locator("#dm-composer")
        expect(dm).to_be_visible()
        dm.fill("/")
        page.get_by_role("option", name=re.compile(r"^\/ai")).click()
        expect(self.connect_window(page)).to_be_visible()
        self.assertEqual(self.api(page, "GET", "/api/v1/personal-assistant", status=200)["state"], "not_enabled", "nothing was connected")

    def test_02_a_server_that_runs_no_ai_does_not_offer_ai(self) -> None:
        page = self.page("mia")
        real = self.api(page, "GET", "/api/v1/personal-assistant", status=200)
        off = {**real, "state": "not_enabled", "enablement": None, "today": None, "unavailableReason": None,
               "setup": {"provider": "off", "connection": "none", "runtime": {"state": "off", "payer": None, "accountLabel": None, "client": None}}}

        def fulfil(route: Route) -> None:
            if route.request.method == "GET":
                route.fulfill(status=200, content_type="application/json", body=json.dumps(off))
            else:
                route.continue_()
        page.route("**/api/v1/personal-assistant", fulfil)
        page.goto(f"/projects/{self.ids['space']}")
        composer = page.locator("#project-composer")
        composer.fill("/")
        expect(page.get_by_role("option", name=re.compile(r"^\/task"))).to_have_count(1)
        expect(page.get_by_role("option", name=re.compile(r"^\/ai"))).to_have_count(0)
        # Typed anyway, it says what Settings › AI says and offers nothing to connect.
        composer.fill("/ai ")
        bar = page.locator("#project-ask")
        expect(bar).to_contain_text("Off on this Flux server.")
        expect(bar.get_by_role("button", name="Connect your AI")).to_have_count(0)

    # ---------------------------------------------------------------- P2 #2: a guest is not offered a space

    def test_03_a_guest_is_not_offered_a_space_of_their_own(self) -> None:
        page = self.page("gia")
        page.goto("/")
        first = page.locator(".home__first")
        expect(first).to_contain_text("When someone adds you to a space, it appears under Spaces at once.")
        expect(first).not_to_contain_text("start your own")
        expect(first.get_by_role("button", name="Start a space")).to_have_count(0)
        page.get_by_role("complementary", name="Sidebar").get_by_role("button", name=re.compile("^New")).click()
        window = page.get_by_role("dialog", name="New task")
        expect(window).to_be_visible()
        expect(window.get_by_role("tab", name="Task")).to_be_visible()
        expect(window.get_by_role("tab", name="Space")).to_have_count(0)
        expect(window).not_to_contain_text("New space")
        expect(window).to_contain_text("When someone adds you to one, you can add its tasks here.")
        shot(page, f"persona-guest-new-{UI_BROWSER}")

    # ---------------------------------------------------------------- P2 #3: one role word, and no AI row for a guest

    def test_04_space_settings_says_guest_for_a_guest_to_everyone(self) -> None:
        owner = self.page("ola")
        owner.goto(f"/projects/{self.ids['space']}/settings")
        people = owner.get_by_role("list", name="People in Shop floor")
        expect(people.get_by_role("listitem")).to_have_count(2)
        # Live (#1424): the guest is added from elsewhere, and her row appears without a reload.
        self.api(owner, "POST", f"/api/v1/projects/{self.ids['space']}/grants", {"principal": {"kind": "human", "id": self.ids["gia"]}, "role": "contributor"}, status=201)
        guest_row = people.locator(f"[data-person='{self.ids['gia']}']")
        expect(guest_row).to_be_visible()
        expect(guest_row).to_contain_text("Guest")
        expect(guest_row.get_by_role("combobox")).to_have_count(0)
        expect(people.locator(f"[data-person='{self.ids['mia']}']").get_by_role("combobox")).to_contain_text("Member")
        shot(owner, f"persona-space-settings-guest-{UI_BROWSER}")
        for who in ("mia", "gia"):
            page = self.page(who)
            page.goto(f"/projects/{self.ids['space']}/settings")
            row = page.get_by_role("list", name="People in Shop floor").locator(f"[data-person='{self.ids['gia']}']")
            expect(row.locator(".spset__role")).to_have_text("Guest")
            expect(page.get_by_role("heading", name="AI", exact=True)).to_have_count(1 if who == "mia" else 0)
            expect(page.locator("[data-ai-switch]")).to_have_count(1 if who == "mia" else 0)

    # ---------------------------------------------------------------- P3: true words, Close, no stray link

    def test_05_add_people_says_everyone_is_here_when_nobody_is_left(self) -> None:
        owner = self.page("ola")
        self.api(owner, "POST", f"/api/v1/projects/{self.ids['space']}/grants", {"principal": {"kind": "human", "id": self.ids["tom"]}, "role": "contributor"}, status=201)
        owner.goto(f"/projects/{self.ids['space']}/settings")
        owner.get_by_role("button", name="Add people", exact=True).click()
        add = owner.get_by_role("group", name="Add people")
        expect(add).to_contain_text("Everyone in Nowak Bakery is already in Shop floor.")
        expect(add).not_to_contain_text("There is nobody else in the company yet.")

    def test_06_the_company_invite_form_closes(self) -> None:
        owner = self.page("ola")
        owner.goto("/settings/company")
        owner.get_by_role("button", name="Invite", exact=True).click()
        region = owner.get_by_role("region", name="Invite people")
        expect(region).to_be_visible()
        region.get_by_role("button", name="Close").click()
        expect(region).to_have_count(0)
        expect(owner.get_by_role("button", name="Invite", exact=True)).to_be_focused()

    def test_07_invite_then_cancel_in_new_space_leaves_no_working_link(self) -> None:
        owner = self.page("ola")
        before = {item["id"] for item in self.api(owner, "GET", f"/api/v1/workspaces/{self.ids['company']}/invites", status=200)}
        owner.goto("/")
        owner.get_by_role("complementary", name="Sidebar").get_by_role("button", name=re.compile("^New")).click()
        owner.get_by_role("dialog").get_by_role("tab", name="Space").click()
        form = owner.get_by_role("form", name="New space")
        form.get_by_label("Space name").fill("Weekend market")
        form.get_by_role("button", name="Add people").click()
        new = form.get_by_role("form", name="Invite someone new")
        new.get_by_label("Someone new?").fill(f"zosia.pag+{STAMP}@example.test")
        new.get_by_role("button", name="Invite").click()
        expect(form.get_by_role("group", name="New invite link").get_by_role("textbox")).to_have_value(re.compile(r"/join#"))
        made = [item for item in self.api(owner, "GET", f"/api/v1/workspaces/{self.ids['company']}/invites", status=200) if item["id"] not in before]
        self.assertEqual(len(made), 1, "the link exists while the window is open")
        form.get_by_role("button", name="Cancel").click()
        expect(form).to_have_count(0)
        deadline = time.time() + 10
        while time.time() < deadline:
            left = [item for item in self.api(owner, "GET", f"/api/v1/workspaces/{self.ids['company']}/invites", status=200) if item["id"] not in before]
            if not left:
                break
            time.sleep(0.2)
        self.assertEqual(left, [], "Cancel revoked the link made in the window")


if __name__ == "__main__":
    unittest.main()
