"""Browser tests for adding and managing people (issue #188, AC-1–AC-4).

Runs with the other tests/ui modules through scripts/check_ui.sh against the running Compose
application. Four people and two workspaces: Ada owns Riverside Makers, Lee owns Harbour Studio.
From Home's Details, Ada adds Kai, Lee and Mia to Riverside Makers by email (the form is driven by
the keyboard), meets the "no account yet" and "already here" messages, and changes Lee's role.
Members and guests see the people read-only. A new project opens its "Who can see this", where Ada
gives Kai access, changes and removes it; on a workspace-visible project reached from the header's
audience line she keeps Lee out and lets him back in. A restricted project stays invisible (sidebar
and search) to everyone not given access. A DM sketch becomes a project with and without "Also
give Kai access". Ada removes Mia and Lee leaves. Phone 390 and desktop 1440, light and dark.
Every step is checked against the API. Screenshots (people-*.png) go to FLUX_UI_SCREENSHOTS.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, box, shot, start_forwarder

PASSWORD = "people before projects"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.people+{STAMP}@example.test"),
    "kai": ("Kai Tanaka", f"kai.people+{STAMP}@example.test"),
    "lee": ("Lee Moreno", f"lee.people+{STAMP}@example.test"),
    "mia": ("Mia Novak", f"mia.people+{STAMP}@example.test"),
}
NOBODY = f"nia.people+{STAMP}@example.test"
RESTRICTED = "Kiln controller"
OPEN = "Garden sensors"


class PeopleJourney(unittest.TestCase):
    """Tests run in name order and share the accounts, the workspaces and the projects."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    riverside = ""
    harbour = ""
    kiln = ""
    garden = ""

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=10000)
        # Accounts exist first, as a person would create them at this Flux address.
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            context.close()
        # Two workspaces, each started by its owner. Everyone else is added in the browser.
        for key, name, attr in (("ada", "Riverside Makers", "riverside"), ("lee", "Harbour Studio", "harbour")):
            context = cls.browser.new_context(base_url=ORIGIN, storage_state=cls.states[key])
            created = context.request.post("/api/v1/workspaces", data={"name": name}, headers={"origin": ORIGIN})
            assert created.status == 201, created.text()
            setattr(cls, attr, created.json()["id"])
            context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    # ---------------------------------------------------------------- helpers

    def context(self, who: str, *, phone: bool = False, dark: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who]}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context

    def page(self, who: str, **kwargs) -> Page:
        page = self.context(who, **kwargs).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, path: str) -> tuple[int, dict | list]:
        response = page.request.get(path)
        return response.status, (json.loads(response.text()) if response.text() else {})

    def post(self, page: Page, path: str, body: dict) -> dict:
        response = page.request.post(path, data=body, headers={"origin": ORIGIN})
        assert response.status in (200, 201), response.text()
        return response.json()

    def roles(self, page: Page, workspace_id: str) -> dict[str, str]:
        status, members = self.api(page, f"/api/v1/workspaces/{workspace_id}/members")
        self.assertEqual(status, 200)
        return {member["userId"]: member["role"] for member in members}

    def open_people(self, page: Page, workspace: str) -> None:
        """Home → Details → People → the workspace, as a person finds it."""
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        page.get_by_role("button", name="Details", exact=True).click()
        people = page.get_by_role("region", name="People")
        people.get_by_role("button", name=re.compile(f"^{workspace}")).click()
        expect(page.get_by_role("heading", name="People", exact=True)).to_be_visible()
        expect(page.locator(".details__eyebrow", has_text=workspace)).to_be_visible()

    def add(self, page: Page, email: str, role: str | None = None) -> None:
        form = page.get_by_role("region", name="Add someone")
        form.get_by_label("Email").fill(email)
        if role:
            form.get_by_label("Role").select_option(label=role)
        form.get_by_role("button", name=re.compile("^Add to ")).click()

    def access_region(self, page: Page):
        return page.get_by_role("region", name="Who can see this")

    def sidebar_projects(self, page: Page):
        return page.get_by_role("navigation", name="Projects")

    def no_horizontal_scroll(self, page: Page, width: int) -> None:
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), width, "no horizontal page scroll")
        overflow = page.evaluate("[...document.querySelectorAll('.ui-panel__body')].map((el) => el.scrollWidth - el.clientWidth)")
        self.assertTrue(all(value <= 1 for value in overflow), f"Details fits its width: {overflow}")

    # ---------------------------------------------------------------- AC-1 workspace people

    def test_01_owner_adds_people_by_email_with_the_keyboard(self) -> None:
        page = self.page("ada")
        self.open_people(page, "Riverside Makers")
        people = page.get_by_role("list", name="People in Riverside Makers")
        expect(people.get_by_text("Ada Kowalska (you)")).to_be_visible()
        expect(page.get_by_text("They need an account at this Flux address first. Flux doesn’t send invitations.")).to_be_visible()

        # Keyboard only: type the address, Tab to the role (Member by default), Tab to the button, Enter.
        form = page.get_by_role("region", name="Add someone")
        email = form.get_by_label("Email")
        email.focus()
        page.keyboard.type(PEOPLE["kai"][1])
        page.keyboard.press("Tab")
        expect(form.get_by_label("Role")).to_be_focused()
        expect(form.get_by_label("Role")).to_have_value("member")
        page.keyboard.press("Tab")
        expect(form.get_by_role("button", name="Add to Riverside Makers")).to_be_focused()
        page.keyboard.press("Enter")
        expect(page.locator(".people__done")).to_have_text("Kai Tanaka joined Riverside Makers as member.")
        expect(email).to_have_value("")
        expect(people.get_by_role("listitem").filter(has_text="Kai Tanaka")).to_contain_text("Member")

        # Enter in the address field submits too.
        email.fill(PEOPLE["lee"][1])
        form.get_by_label("Role").select_option(label="Admin")
        expect(form.get_by_text("Adds and removes people and manages every project.")).to_be_visible()
        email.press("Enter")
        expect(page.locator(".people__done")).to_have_text("Lee Moreno joined Riverside Makers as admin.")
        self.add(page, PEOPLE["mia"][1], "Guest")
        expect(page.locator(".people__done")).to_have_text("Mia Novak joined Riverside Makers as guest.")
        expect(people.get_by_role("listitem")).to_have_count(4)
        expect(page.get_by_role("heading", name="In Riverside Makers · 4")).to_be_visible()
        self.assertEqual(self.roles(page, self.riverside), {self.ids["ada"]: "owner", self.ids["kai"]: "member", self.ids["lee"]: "admin", self.ids["mia"]: "guest"})
        self.no_horizontal_scroll(page, DESKTOP["width"])
        shot(page, "people-desktop-1440-light")

    def test_02_not_found_and_already_member_say_what_to_do(self) -> None:
        page = self.page("ada")
        self.open_people(page, "Riverside Makers")
        form = page.get_by_role("region", name="Add someone")
        self.add(page, NOBODY)
        alert = form.get_by_role("alert")
        expect(alert).to_contain_text(f"No one has an account with {NOBODY} at this Flux address yet.")
        expect(alert).to_contain_text(f"Ask them to create one at {ORIGIN} first, then add them here. Flux doesn’t send invitations.")
        expect(form.get_by_label("Email")).to_be_focused()
        shot(page, "people-desktop-1440-not-found")

        self.add(page, PEOPLE["kai"][1].upper())
        expect(alert).to_have_text("Kai Tanaka is already in Riverside Makers.")
        self.add(page, "kai")
        expect(alert).to_have_text("Enter the email address of their Flux account.")
        # Nothing changed on the server.
        self.assertEqual(len(self.roles(page, self.riverside)), 4)

    def test_03_owner_changes_a_role(self) -> None:
        page = self.page("ada", dark=True)
        self.open_people(page, "Riverside Makers")
        change = page.get_by_role("button", name="Change Lee Moreno")
        change.click()
        editor = page.get_by_role("group", name="Change Lee Moreno")
        expect(editor.get_by_label("Role")).to_be_focused()
        expect(editor.get_by_label("Role")).to_have_value("admin")
        # Esc closes the editor and returns focus to its button.
        page.keyboard.press("Escape")
        expect(editor).to_have_count(0)
        expect(change).to_be_focused()
        change.click()
        editor.get_by_label("Role").select_option(label="Member")
        expect(editor).to_contain_text("Sees projects open to the workspace and the ones given to them.")
        shot(page, "people-desktop-1440-dark-change-role")
        editor.get_by_role("button", name="Save role").click()
        expect(page.locator(".people__done")).to_have_text("Lee Moreno is now a member.")
        expect(page.get_by_role("list", name="People in Riverside Makers").get_by_role("listitem").filter(has_text="Lee Moreno")).to_contain_text("Member")
        self.assertEqual(self.roles(page, self.riverside)[self.ids["lee"]], "member")
        shot(page, "people-desktop-1440-dark")

    def test_04_members_and_guests_see_people_read_only(self) -> None:
        # Lee adds Ada to Harbour Studio, so Ada has two workspaces.
        lee = self.page("lee")
        self.open_people(lee, "Harbour Studio")
        self.add(lee, PEOPLE["ada"][1])
        expect(lee.locator(".people__done")).to_have_text("Ada Kowalska joined Harbour Studio as member.")
        # Lee is the only owner there, so leaving says what to do first.
        expect(lee.get_by_text("You’re the only owner of Harbour Studio. To leave, make someone else an owner first.")).to_be_visible()
        expect(lee.get_by_role("button", name="Leave Harbour Studio")).to_have_count(0)

        kai = self.page("kai")
        self.open_people(kai, "Riverside Makers")
        people = kai.get_by_role("list", name="People in Riverside Makers")
        expect(people.get_by_role("listitem")).to_have_count(4)
        expect(people.get_by_role("listitem").filter(has_text="Ada Kowalska")).to_contain_text("Owner")
        expect(kai.get_by_role("region", name="Add someone")).to_have_count(0)
        expect(kai.get_by_role("button", name=re.compile("^Change "))).to_have_count(0)
        expect(kai.get_by_text("Only owners and admins add people or change roles in Riverside Makers.")).to_be_visible()
        expect(kai.get_by_role("button", name="Leave Riverside Makers")).to_be_visible()
        shot(kai, "people-desktop-1440-member-read-only")

        mia = self.page("mia")
        self.open_people(mia, "Riverside Makers")
        expect(mia.get_by_text("Guests see only the projects given to them, not everyone in Riverside Makers.")).to_be_visible()
        expect(mia.get_by_text("Kai Tanaka")).to_have_count(0)
        expect(mia.get_by_role("region", name="Add someone")).to_have_count(0)

        # Ada's Home lists both workspaces; in Harbour Studio she is a member, read-only.
        ada = self.page("ada")
        ada.goto("/")
        ada.get_by_role("button", name="Details", exact=True).click()
        rows = ada.get_by_role("region", name="People")
        expect(rows.get_by_role("button", name=re.compile("^Riverside Makers.*owner"))).to_be_visible()
        expect(rows.get_by_role("button", name=re.compile("^Harbour Studio.*member"))).to_be_visible()
        rows.get_by_role("button", name=re.compile("^Harbour Studio")).click()
        expect(ada.get_by_role("list", name="People in Harbour Studio").get_by_role("listitem")).to_have_count(2)
        expect(ada.get_by_role("region", name="Add someone")).to_have_count(0)

    # ---------------------------------------------------------------- AC-2/AC-3 project access

    def test_05_a_new_project_opens_who_can_see_this_and_gives_access(self) -> None:
        page = self.page("ada")
        page.goto("/")
        self.sidebar_projects(page).get_by_role("link", name="New project").click()
        expect(page.get_by_text("A new project is restricted: only you and the workspace’s owners and admins can see it.")).to_be_visible()
        page.get_by_label("Project name").fill(RESTRICTED)
        page.get_by_role("button", name="Create project").click()
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}\?new=1$"))
        type(self).kiln = re.search(r"/projects/([0-9a-f-]{36})", page.url).group(1)
        region = self.access_region(page)
        expect(region.get_by_role("heading", name="Who can see this")).to_be_focused()
        expect(region).to_contain_text("Restricted. Only the people listed here can open it; others in Riverside Makers don’t see it at all.")
        expect(page.locator(".top__audience")).to_contain_text("Only you")

        region.get_by_role("button", name="Give someone access").click()
        give = region.get_by_role("group", name="Give someone access")
        expect(give.get_by_label("Person")).to_be_focused()
        # Only people who can't see it yet are offered: not Ada herself.
        options = give.get_by_label("Person").locator("option").all_inner_texts()
        self.assertEqual(sorted(o.split(" · ")[0] for o in options[1:]), ["Kai Tanaka", "Lee Moreno", "Mia Novak (guest)"])
        give.get_by_label("Person").select_option(value=self.ids["kai"])
        expect(give).to_contain_text("Only Kai Tanaka gains access. Kai will be able to read and write in Kiln controller")
        expect(give).to_contain_text("Nobody else is added.")
        shot(page, "people-desktop-1440-give-access")
        give.get_by_role("button", name="Give Kai access").click()
        expect(region.locator(".people__done")).to_have_text("Kai can now write in Kiln controller.")
        kai_row = region.get_by_role("list", name=f"People who can see {RESTRICTED}").get_by_role("listitem").filter(has_text="Kai Tanaka")
        expect(kai_row).to_contain_text("Can write · Given access here")
        expect(page.locator(".top__audience")).to_contain_text("Kai and you · only you two")
        status, grants = self.api(page, f"/api/v1/projects/{self.kiln}/grants")
        self.assertEqual(status, 200)
        self.assertEqual([(g["principal"]["id"], g["role"]) for g in grants], [(self.ids["kai"], "contributor")])
        self.no_horizontal_scroll(page, DESKTOP["width"])
        shot(page, "people-desktop-1440-project-access")

        # Kai sees it; Lee (a member) and Mia (a guest) see nothing, not even its title.
        kai = self.page("kai")
        kai.goto("/")
        expect(self.sidebar_projects(kai).get_by_role("link", name=RESTRICTED)).to_be_visible()
        self.assertEqual(self.api(kai, f"/api/v1/projects/{self.kiln}")[0], 200)
        for who in ("lee", "mia"):
            other = self.page(who)
            other.goto("/")
            expect(self.sidebar_projects(other).get_by_role("heading", name="Projects")).to_be_visible()
            expect(other.get_by_text(RESTRICTED)).to_have_count(0)
            self.assertEqual(self.api(other, f"/api/v1/projects/{self.kiln}")[0], 404)
            other.goto(f"/search?q={RESTRICTED.replace(' ', '+')}")
            expect(other.get_by_role("heading", name=f"Nothing matches “{RESTRICTED}”")).to_be_visible()
            status, found = self.api(other, f"/api/v1/search?q={RESTRICTED.replace(' ', '+')}")
            self.assertEqual(status, 200)
            self.assertNotIn(RESTRICTED, json.dumps(found))

    def test_06_change_and_remove_a_grant(self) -> None:
        page = self.page("ada")
        page.goto(f"/projects/{self.kiln}")
        page.locator(".top__audience").click()
        region = self.access_region(page)
        expect(region.get_by_role("heading", name="Who can see this")).to_be_focused()
        region.get_by_role("button", name="Change access for Kai Tanaka").click()
        editor = region.get_by_role("group", name="Change access for Kai Tanaka")
        expect(editor.get_by_label("Access")).to_be_focused()
        editor.get_by_label("Access").select_option(label="Can read")
        expect(editor).to_contain_text("Kai Tanaka will be able to read Kiln controller but not write in it.")
        editor.get_by_role("button", name="Change access").click()
        expect(region.locator(".people__done")).to_have_text("Kai can now read Kiln controller.")
        self.assertEqual(self.api(self.page("kai"), f"/api/v1/projects/{self.kiln}")[1]["access"], "viewer")

        region.get_by_role("button", name="Change access for Kai Tanaka").click()
        editor.get_by_label("Access").select_option(label="Remove access")
        expect(editor).to_contain_text("Kai Tanaka loses access to Kiln controller at once. They won’t see it at all, not even its name.")
        editor.get_by_role("button", name="Remove access").click()
        expect(region.locator(".people__done")).to_have_text("Kai’s access was removed.")
        expect(region.get_by_text("Kai Tanaka")).to_have_count(0)
        expect(page.locator(".top__audience")).to_contain_text("Only you")
        self.assertEqual(self.api(self.page("kai"), f"/api/v1/projects/{self.kiln}")[0], 404)
        status, grants = self.api(page, f"/api/v1/projects/{self.kiln}/grants")
        self.assertEqual((status, grants), (200, []))

    def test_07_keep_someone_out_from_the_header_audience_line(self) -> None:
        page = self.page("ada")
        type(self).garden = self.post(page, f"/api/v1/workspaces/{self.riverside}/projects", {"name": OPEN, "visibility": "workspace"})["id"]
        lee = self.page("lee")
        self.assertEqual(self.api(lee, f"/api/v1/projects/{self.garden}")[1]["access"], "contributor")

        page.goto(f"/projects/{self.garden}")
        audience = page.locator(".top__audience")
        expect(audience).to_contain_text("you")
        audience.click()
        region = self.access_region(page)
        expect(region.get_by_role("heading", name="Who can see this")).to_be_focused()
        expect(region).to_contain_text("Open to Riverside Makers. Every member can write here; guests only with access given here.")
        lee_row = region.get_by_role("listitem").filter(has_text="Lee Moreno")
        expect(lee_row).to_contain_text("Can write · Everyone in Riverside Makers")
        region.get_by_role("button", name="Change access for Lee Moreno").click()
        editor = region.get_by_role("group", name="Change access for Lee Moreno")
        editor.get_by_label("Access").select_option(label="Keep out of this project")
        expect(editor).to_contain_text("Lee Moreno is kept out of Garden sensors at once, whatever their role in Riverside Makers.")
        shot(page, "people-desktop-1440-keep-out")
        editor.get_by_role("button", name="Keep Lee out").click()
        expect(region.locator(".people__done")).to_have_text("Lee is kept out of Garden sensors.")
        kept = region.get_by_role("list", name="Kept out")
        expect(kept.get_by_role("listitem").filter(has_text="Lee Moreno")).to_contain_text("Kept out · Member of Riverside Makers")
        self.assertEqual(self.api(lee, f"/api/v1/projects/{self.garden}")[0], 404)
        status, grants = self.api(page, f"/api/v1/projects/{self.garden}/grants")
        self.assertEqual([(g["principal"]["id"], g["role"]) for g in grants], [(self.ids["lee"], "denied")])
        lee.goto("/")
        expect(self.sidebar_projects(lee).get_by_role("heading", name="Projects")).to_be_visible()
        expect(lee.get_by_text(OPEN)).to_have_count(0)

        region.get_by_role("button", name="Change access for Lee Moreno").click()
        editor.get_by_label("Access").select_option(label="Let back in")
        expect(editor).to_contain_text("Lee Moreno can write in Garden sensors again as a member of Riverside Makers.")
        editor.get_by_role("button", name="Let Lee back in").click()
        expect(region.locator(".people__done")).to_have_text("Lee is no longer kept out.")
        expect(region.get_by_role("list", name="Kept out")).to_have_count(0)
        self.assertEqual(self.api(lee, f"/api/v1/projects/{self.garden}")[1]["access"], "contributor")

    def test_08_promote_a_dm_sketch_with_and_without_giving_access(self) -> None:
        page = self.page("ada")
        dm = page.request.post(f"/api/v1/workspaces/{self.riverside}/dms", data={"participantIds": [self.ids["kai"]]}, headers={"origin": ORIGIN})
        assert dm.status in (200, 201), dm.text()
        dm_id = dm.json()["id"]
        kai = self.page("kai")
        self.post(kai, f"/api/v1/dms/{dm_id}/messages", {"body": "Glaze tiles first, then the kiln wiring?", "clientMessageId": str(uuid.uuid4())})
        sketches = [self.post(page, f"/api/v1/workspaces/{self.riverside}/sketches", {"title": title, "scope": "dm", "dmId": dm_id})["id"] for title in ("Glaze test tiles", "Kiln wiring")]

        # Without the checkbox: only Ada (the workspace's one manager) can open the new project.
        page.goto(f"/dm/{dm_id}/sketches/{sketches[0]}")
        page.get_by_role("button", name="Make it a project…").click()
        details = page.locator("#details")
        also = details.get_by_role("checkbox", name="Also give Kai access")
        expect(also).to_be_visible()
        expect(also).not_to_be_checked()
        expect(details).to_contain_text("Kai Tanaka can then read and write in the new project. Nobody else is added.")
        expect(details.locator(".promote__aud b")).to_have_text("Only you")
        expect(details).to_contain_text("Kai won’t see it unless you also give them access.")
        shot(page, "people-desktop-1440-promote-unchecked")
        details.get_by_role("button", name="Create project").click()
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}/map/[0-9a-f-]{36}$"))
        alone = re.search(r"/projects/([0-9a-f-]{36})", page.url).group(1)
        self.assertEqual(self.api(page, f"/api/v1/projects/{alone}/grants"), (200, []))
        self.assertEqual(self.api(kai, f"/api/v1/projects/{alone}")[0], 404)
        kai.goto("/")
        expect(self.sidebar_projects(kai).get_by_role("heading", name="Projects")).to_be_visible()
        expect(self.sidebar_projects(kai).get_by_text("Glaze test tiles")).to_have_count(0)

        # With it: Kai is named before confirming, and only Kai is added.
        page.goto(f"/dm/{dm_id}/sketches/{sketches[1]}")
        page.get_by_role("button", name="Make it a project…").click()
        also = details.get_by_role("checkbox", name="Also give Kai access")
        expect(also).not_to_be_checked()
        also.check()
        expect(details.locator(".promote__aud b")).to_have_text("Kai and you — only you two")
        expect(details).to_contain_text("Kai is added because you chose to. Nobody else is.")
        shot(page, "people-desktop-1440-promote-checked")
        details.get_by_role("button", name="Create project").click()
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}/map/[0-9a-f-]{36}$"))
        expect(page.get_by_text("Kai can open it too.")).to_be_visible()
        together = re.search(r"/projects/([0-9a-f-]{36})", page.url).group(1)
        status, grants = self.api(page, f"/api/v1/projects/{together}/grants")
        self.assertEqual([(g["principal"]["id"], g["role"]) for g in grants], [(self.ids["kai"], "contributor")])
        self.assertEqual(self.api(kai, f"/api/v1/projects/{together}")[1]["access"], "contributor")
        self.assertEqual(self.api(self.page("lee"), f"/api/v1/projects/{together}")[0], 404)

    # ---------------------------------------------------------------- remove and leave

    def test_09_remove_someone_and_leave(self) -> None:
        page = self.page("ada")
        self.open_people(page, "Riverside Makers")
        page.get_by_role("button", name="Change Mia Novak").click()
        editor = page.get_by_role("group", name="Change Mia Novak")
        editor.get_by_role("button", name="Remove from Riverside Makers").click()
        confirm = editor.get_by_role("group", name="Remove Mia Novak")
        expect(confirm).to_contain_text("Mia loses access to Riverside Makers at once: its projects, and any access given to them there.")
        confirm.get_by_role("button", name="Remove Mia").click()
        expect(page.locator(".people__done")).to_have_text("Mia Novak is no longer in Riverside Makers.")
        expect(page.get_by_role("list", name="People in Riverside Makers").get_by_text("Mia Novak")).to_have_count(0)
        self.assertNotIn(self.ids["mia"], self.roles(page, self.riverside))
        self.assertEqual(self.api(self.page("mia"), f"/api/v1/workspaces/{self.riverside}")[0], 404)

        lee = self.page("lee")
        self.open_people(lee, "Riverside Makers")
        lee.get_by_role("button", name="Leave Riverside Makers").click()
        leave = lee.get_by_role("group", name="Leave Riverside Makers")
        expect(leave).to_contain_text("You lose access to Riverside Makers and its projects at once.")
        leave.get_by_role("button", name="Leave", exact=True).click()
        expect(lee.get_by_text("You left Riverside Makers.")).to_be_visible()
        expect(lee).to_have_url(f"{ORIGIN}/")
        self.assertEqual(self.api(lee, f"/api/v1/workspaces/{self.riverside}")[0], 404)
        self.assertNotIn(self.ids["lee"], self.roles(page, self.riverside))
        # Details stays open on Home, now listing only the workspace Lee is still in.
        rows = lee.get_by_role("region", name="People")
        expect(rows.get_by_role("button", name=re.compile("^Harbour Studio"))).to_be_visible()
        expect(rows.get_by_role("button", name=re.compile("^Riverside Makers"))).to_have_count(0)

    # ---------------------------------------------------------------- phone

    def test_10_phone_people_and_project_access(self) -> None:
        for dark in (False, True):
            theme = "dark" if dark else "light"
            page = self.page("ada", phone=True, dark=dark)
            self.open_people(page, "Riverside Makers")
            sheet = page.get_by_role("dialog")
            expect(sheet.get_by_role("list", name="People in Riverside Makers").get_by_role("listitem")).to_have_count(2)
            change = sheet.get_by_role("button", name="Change Kai Tanaka")
            size = box(page, change)
            self.assertGreaterEqual(size["height"], 44, "touch target")
            self.no_horizontal_scroll(page, PHONE["width"])
            shot(page, f"people-phone-390-{theme}")

            page.goto(f"/projects/{self.garden}")
            page.locator(".top__audience").click()
            region = self.access_region(page)
            expect(region.get_by_role("heading", name="Who can see this")).to_be_focused()
            region.get_by_role("button", name="Change access for Kai Tanaka").click()
            expect(region.get_by_role("group", name="Change access for Kai Tanaka")).to_be_visible()
            self.no_horizontal_scroll(page, PHONE["width"])
            shot(page, f"people-phone-390-{theme}-project-access")


if __name__ == "__main__":
    unittest.main()
