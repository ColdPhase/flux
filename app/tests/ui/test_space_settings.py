"""A space's settings and its AI switch (F-037, #874; final design F-026 S20).

New space takes a name, the people and an AI switch; its settings (⋯ › Settings) hold its name, its people with Admin and Member,
the AI switch, Leave space and, for its admins, Delete space, which asks first and names the space. A member reads the same page
and changes nothing. Runs through scripts/check_ui.sh against the running app.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from app_select import choose, open_select
from create_window import create_other, new_space_window, open_create
from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder, view_tab
from test_personal_assistant import mock
from themed_shots import shot_both

PASSWORD = "settings for a space"
STAMP = int(time.time() * 1000)
ADA_EMAIL = f"ada.spaceset+{STAMP}@example.test"
KAI_EMAIL = f"kai.spaceset+{STAMP}@example.test"
LEE_EMAIL = f"lee.spaceset+{STAMP}@example.test"
SPACE = "Kiln controller"

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")


class SpaceSettings(unittest.TestCase):
    browser: Browser
    states: dict = {}
    ids: dict = {}

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

    def page(self, who: str = "ada", viewport: dict | None = None) -> Page:
        phone = viewport == PHONE
        options: dict = {"base_url": ORIGIN, "locale": "en-GB", "service_workers": "block", "viewport": viewport or DESKTOP,
                         "device_scale_factor": 1, "has_touch": phone, "is_mobile": phone, "storage_state": self.states[who]}
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int = 200) -> dict | list:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json", "idempotency-key": str(uuid.uuid4())},
                                      data=json.dumps(body) if body is not None else None)
        self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def sign_up(self, who: str, name: str, email: str) -> None:
        context = self.browser.new_context(base_url=ORIGIN, locale="en-GB", service_workers="block")
        self.addCleanup(context.close)
        response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
        self.assertEqual(response.status, 200, response.text())
        type(self).states[who] = context.storage_state()

    def ensure_world(self) -> None:
        if self.states:
            return
        for who, name, email in (("ada", "Ada Kowalska", ADA_EMAIL), ("kai", "Kai Tanaka", KAI_EMAIL), ("lee", "Lee Moreno", LEE_EMAIL)):
            self.sign_up(who, name, email)
        page = self.page("ada")
        workspace = self.api(page, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, status=201)["id"]
        type(self).ids["workspace"] = workspace
        for email in (KAI_EMAIL, LEE_EMAIL):
            self.api(page, "POST", f"/api/v1/workspaces/{workspace}/members", {"email": email, "role": "member"}, status=201)
        for who in ("ada", "kai", "lee"):
            me = self.api(self.page(who), "GET", "/api/v1/me")
            type(self).ids[who] = me["user"]["id"]

    @staticmethod
    def names(card) -> str:
        """The people a card lists, by name, whoever reads it (the reader's own row says "· you")."""
        return "|".join(sorted(text.replace(" · you", "").strip() for text in card.locator(".spset__who b").all_inner_texts()))

    def settings(self, page: Page) -> None:
        """⋯ › Settings in the space's header."""
        page.locator("header.top").get_by_role("button", name="More", exact=True).click()
        page.get_by_role("menu", name="More").get_by_role("menuitem", name="Settings", exact=True).click()
        expect(page.get_by_role("heading", name="Space settings")).to_be_visible()

    def test_01_new_space_takes_people_and_ai_off_and_says_so_where_ai_would_be_used(self) -> None:
        self.ensure_world()
        page = self.page("ada")
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        # New › Space: the drawn window, with a title, a labelled Name and Cancel (not a tab of the Create window).
        open_create(page)
        create_other(page, "Space")
        window = new_space_window(page)
        card = window.get_by_role("form", name="New space")
        expect(card.get_by_role("heading", name="New space")).to_be_visible()
        expect(card.get_by_text("Name", exact=True)).to_be_visible()
        expect(card.get_by_role("button", name="Cancel")).to_be_visible()
        expect(window.get_by_role("tablist")).to_have_count(0)
        card.get_by_label("Space name").fill(SPACE)
        card.get_by_role("button", name="Add people").click()
        card.get_by_role("checkbox", name=re.compile("Kai Tanaka")).check()
        switch = card.get_by_role("switch", name="AI")
        expect(switch).to_have_attribute("aria-checked", "true")
        switch.click()
        expect(switch).to_have_attribute("aria-checked", "false")
        shot(page, "874-newspace-people-ai-off")
        card.get_by_role("button", name="Create space").click()
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}$"))
        pid = re.search(r"/projects/([0-9a-f-]{36})", page.url).group(1)
        type(self).ids["space"] = pid
        project = self.api(page, "GET", f"/api/v1/projects/{pid}")
        self.assertEqual((project["ai"], project["access"]), ("blocked", "manager"))
        grants = self.api(page, "GET", f"/api/v1/projects/{pid}/grants")
        self.assertEqual(sorted((g["principal"]["id"], g["role"]) for g in grants), sorted([(self.ids["ada"], "manager"), (self.ids["kai"], "contributor")]))
        # There is no page of its own for it any more: /projects/new is a space that does not exist.
        page.goto("/projects/new")
        expect(page.get_by_role("heading", name="This place isn’t available")).to_be_visible()
        page.goto(f"/projects/{pid}")
        # `/ai` in a space with AI off stays in the field and says so in one line; the words are not sent.
        composer = page.get_by_placeholder(re.compile("^Message")).first
        composer.fill("/ai what changed?")
        composer.press("Enter")
        expect(page.get_by_text("AI is off in this space", exact=False).first).to_be_visible()
        expect(composer).to_have_value("/ai what changed?")

    def test_01b_a_member_starts_a_space_with_the_company_owner_in_it(self) -> None:
        """D-3: People are chosen from the company, the owner too; no OWNER_REQUIRED for a new space."""
        self.ensure_world()
        page = self.page("kai")
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        open_create(page)
        create_other(page, "Space")
        card = new_space_window(page).get_by_role("form", name="New space")
        card.get_by_label("Space name").fill("Kai’s room")
        card.get_by_role("button", name="Add people").click()
        card.get_by_role("checkbox", name=re.compile("Ada Kowalska")).check()
        expect(card.get_by_role("list", name="Chosen people")).to_contain_text("Ada Kowalska")
        card.get_by_role("button", name="Create space").click()
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}$"))
        pid = re.search(r"/projects/([0-9a-f-]{36})", page.url).group(1)
        type(self).ids["kai_space"] = pid
        grants = self.api(page, "GET", f"/api/v1/projects/{pid}/grants")
        self.assertEqual(sorted((g["principal"]["id"], g["role"]) for g in grants), sorted([(self.ids["kai"], "manager"), (self.ids["ada"], "contributor")]))

    def test_01c_a_space_admin_who_is_a_member_removes_and_adds_the_company_owner_later(self) -> None:
        """#905: Add people offers the company owner like anyone else, and neither adding nor removing them answers OWNER_REQUIRED."""
        self.ensure_world()
        pid = self.ids["kai_space"]
        page = self.page("kai")
        page.goto(f"/projects/{pid}/settings")
        expect(page.get_by_role("heading", name="Space settings")).to_be_visible()
        card = page.get_by_role("list", name="People in Kai’s room")
        expect(card).to_contain_text("Ada Kowalska")
        card.get_by_role("button", name="Remove Ada Kowalska from Kai’s room").click()
        card.get_by_role("group", name="Remove Ada Kowalska").get_by_role("button", name="Remove", exact=True).click()
        expect(page.locator(".spset__status")).to_have_text("Ada was removed from Kai’s room.")
        expect(card).not_to_contain_text("Ada Kowalska")
        page.get_by_role("button", name="Add people", exact=True).click()
        add = page.get_by_role("group", name="Add people")
        add.get_by_role("checkbox", name=re.compile("Ada Kowalska")).check()
        add.get_by_role("button", name="Add 1 person").click()
        expect(page.locator(".spset__status")).to_have_text("Ada is now in Kai’s room.")
        expect(card).to_contain_text("Ada Kowalska")
        grants = self.api(page, "GET", f"/api/v1/projects/{pid}/grants")
        self.assertEqual(sorted((g["principal"]["id"], g["role"]) for g in grants), sorted([(self.ids["kai"], "manager"), (self.ids["ada"], "contributor")]))

    def test_02_the_settings_of_an_admin(self) -> None:
        self.ensure_world()
        pid = self.ids["space"]
        page = self.page("ada")
        page.goto(f"/projects/{pid}")
        self.settings(page)
        expect(page).to_have_url(re.compile(rf"/projects/{pid}/settings$"))
        expect(page.get_by_text("Only people added here, and the company’s owners and admins, can open this space.")).to_be_visible()
        # The name, with Change.
        page.get_by_role("button", name=f"Change the name of {SPACE}").click()
        page.get_by_label("Space name").fill("Kiln firmware")
        page.get_by_role("button", name="Save").click()
        expect(page.locator(".spset__status")).to_have_text("Renamed to Kiln firmware.")
        self.assertEqual(self.api(page, "GET", f"/api/v1/projects/{pid}")["name"], "Kiln firmware")
        # The editor is gone: focus returns to Change, once, when it closes, and is never taken back later (#1298).
        expect(page.get_by_role("button", name="Change the name of Kiln firmware")).to_be_focused()
        # The rename reloads the space in the background: wait for its new name to reach the page, so the switch below starts from what
        # the page holds now and not from a state that is about to be replaced.
        expect(page.get_by_role("list", name="People in Kiln firmware")).to_be_visible()
        # The AI switch: off since the space was made; on, then off again, each saying so in one line.
        switch = page.get_by_role("switch", name="AI")
        expect(switch).to_have_attribute("aria-checked", "false")
        # By keyboard: focus stays on the switch after each change, so a second press works.
        switch.focus()
        page.keyboard.press("Space")
        expect(page.locator(".spset__status")).to_have_text("AI is on in this space.")
        expect(switch).to_have_attribute("aria-checked", "true")
        expect(switch).to_be_focused()
        self.assertEqual(self.api(page, "GET", f"/api/v1/projects/{pid}")["ai"], "allowed")
        page.keyboard.press("Space")
        expect(page.locator(".spset__status")).to_have_text("AI is off in this space.")
        expect(switch).to_have_attribute("aria-checked", "false")
        expect(switch).to_be_focused()
        self.assertEqual(self.api(page, "GET", f"/api/v1/projects/{pid}")["ai"], "blocked")
        # The people: Ada (you, Admin) and Kai (Member); Add people adds Lee; a role changes; Remove asks first.
        card = page.get_by_role("list", name="People in Kiln firmware")
        expect(card.get_by_role("listitem")).to_have_count(2)
        expect(card.get_by_role("listitem").filter(has_text="Ada Kowalska")).to_contain_text("Admin")
        # One button opens the company's list; no second step, and no invite link inside it (that stays in Settings › Company).
        page.get_by_role("button", name="Add people", exact=True).click()
        add = page.get_by_role("group", name="Add people")
        expect(add.get_by_role("button", name="Add people")).to_have_count(0)
        expect(add).not_to_contain_text("Invite")
        add.get_by_role("checkbox", name=re.compile("Lee Moreno")).check()
        add.get_by_role("button", name="Add 1 person").click()
        expect(page.locator(".spset__status")).to_have_text("Lee is now in Kiln firmware.")
        choose(card.get_by_label("Role of Lee Moreno"), label="Admin")
        expect(page.locator(".spset__status")).to_have_text("Lee is now an admin of Kiln firmware.")
        expect(card.get_by_label("Role of Lee Moreno").first).to_be_focused()
        # Remove asks first: focus moves into the confirmation, Escape closes it and gives focus back.
        remove = card.get_by_role("button", name="Remove Lee Moreno from Kiln firmware")
        remove.click()
        expect(card).to_contain_text("Lee stops seeing Kiln firmware at once")
        confirm = card.get_by_role("group", name="Remove Lee Moreno")
        expect(confirm.locator(":focus")).to_have_count(1)
        page.keyboard.press("Escape")
        expect(confirm).to_have_count(0)
        expect(remove).to_be_focused()
        remove.click()
        confirm.get_by_role("button", name="Keep").click()
        expect(remove).to_be_focused()
        remove.click()
        confirm.get_by_role("button", name="Remove", exact=True).click()
        expect(page.locator(".spset__status")).to_have_text("Lee was removed from Kiln firmware.")
        self.api(self.page("lee"), "GET", f"/api/v1/projects/{pid}", status=404)
        type(self).ids["people"] = self.names(page.get_by_role("list", name="People in Kiln firmware"))
        shot(page, "874-space-settings-admin")

    def test_02b_conversation_from_the_settings_opens_the_conversation_last_open_there(self) -> None:
        """#1169: on a space's settings the view switch's Conversation leads to the conversation last open in the space, on the computer
        and the phone. The settings never become where Conversation leads, also after another view was chosen from them."""
        self.ensure_world()
        ada = self.page("ada")
        made = self.api(ada, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Glaze tests", "visibility": "restricted", "people": [self.ids["kai"]]}, status=201)
        pid = made["id"]
        root = self.api(ada, "POST", f"/api/v1/projects/{pid}/conversations", {"body": "Cone 6 glaze tiles are in the kiln until Friday.", "clientMessageId": str(uuid.uuid4())}, status=201)
        thread = f"/projects/{pid}/conversations/{root['id']}"
        for viewport in (DESKTOP, PHONE):
            tap = viewport == PHONE
            with self.subTest(width=viewport["width"]):
                page = self.page("ada", viewport)
                page.goto(thread)
                expect(page.get_by_text("Cone 6 glaze tiles are in the kiln until Friday.").first).to_be_visible()
                page.goto(f"/projects/{pid}/settings")
                expect(page.get_by_role("heading", name="Space settings")).to_be_visible()
                conversation = page.get_by_role("navigation", name="Space views").get_by_role("tab", name=re.compile("^Conversation"))
                expect(conversation).to_have_attribute("href", thread)
                view_tab(page, "Conversation", tap)
                expect(page).to_have_url(re.compile(re.escape(thread) + "$"))
                expect(page.get_by_role("heading", name="Space settings")).to_have_count(0)
                # Settings, then Tasks: Conversation still leads to the conversation, not back to the settings.
                page.goto(f"/projects/{pid}/settings")
                expect(page.get_by_role("heading", name="Space settings")).to_be_visible()
                view_tab(page, "Tasks", tap)
                expect(page).to_have_url(re.compile(rf"/projects/{pid}/tasks"))
                expect(conversation).to_have_attribute("href", thread)
                view_tab(page, "Conversation", tap)
                expect(page).to_have_url(re.compile(re.escape(thread) + "$"))

    COLUMN = """() => {
      const pane = document.querySelector('[data-space-settings]').closest('.pane-scroll'), frame = pane.getBoundingClientRect();
      const column = document.querySelector('[data-space-settings] .sset-card').getBoundingClientRect();
      return { left: column.left - frame.left, right: frame.left + pane.clientWidth - column.right, width: column.width,
        margin: getComputedStyle(document.querySelector('[data-space-settings]')).marginLeft };
    }"""

    def test_02c_the_settings_column_is_centred_in_the_pane_on_the_computer_and_as_before_on_tablet_and_phone(self) -> None:
        """#1214: drawn centred under the header (final design, Space settings); account Settings keeps its flush-left page beside its list."""
        self.ensure_world()
        ada = self.page("ada")
        made = self.api(ada, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Centred room", "visibility": "restricted", "people": [self.ids["kai"]]}, status=201)
        for width, height in ((1280, 800), (1440, 900), (1920, 1080), (2560, 1440)):
            with self.subTest(width=width):
                page = self.page("ada", {"width": width, "height": height})
                page.goto(f"/projects/{made['id']}/settings")
                expect(page.get_by_role("heading", name="Space settings")).to_be_visible()
                gaps = page.evaluate(self.COLUMN)
                self.assertAlmostEqual(gaps["left"], gaps["right"], delta=1, msg=f"{width}: the column's left and right gaps in the pane are equal: {gaps}")
                self.assertAlmostEqual(gaps["width"], 640, delta=1, msg=f"{width}: the column is 640 px: {gaps}")
                if width == 1440:
                    self.assertGreater(gaps["left"], 100, f"the column is not at the pane's left edge: {gaps}")
                    shot_both(page, f"1214-space-settings-1440-{UI_BROWSER}")
        # Account Settings keeps its own page beside its section list.
        page = self.page("ada")
        page.goto("/settings/appearance")
        expect(page.locator(".sset__nav")).to_be_visible()
        self.assertEqual(page.evaluate("getComputedStyle(document.querySelector('.pane-in.sset-in')).marginLeft"), "0px", "account Settings stays flush left")
        # Tablet and phone keep their own padding: no centring margin.
        for label, viewport in (("820", {"width": 820, "height": 1180}), ("390", PHONE)):
            page = self.page("ada", viewport)
            page.goto(f"/projects/{made['id']}/settings")
            expect(page.get_by_role("heading", name="Space settings")).to_be_visible()
            self.assertEqual(page.evaluate(self.COLUMN)["margin"], "0px", f"{label}: no centring margin")
            self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), viewport["width"], f"{label}: no sideways scroll")
            shot_both(page, f"1214-space-settings-{label}-{UI_BROWSER}")

    def test_02d_everyones_people_load_for_its_admin_without_a_failure_notice(self) -> None:
        """#1214 (to check separately): a space for the whole company lists its people from the server's read, not from the fallback that
        a failed read leaves, and says nothing about a failure."""
        self.ensure_world()
        ada = self.page("ada")
        made = self.api(ada, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Open house", "visibility": "workspace"}, status=201)
        ada.goto(f"/projects/{made['id']}/settings")
        expect(ada.get_by_role("heading", name="Space settings")).to_be_visible()
        card = ada.get_by_role("list", name="People in Open house")
        expect(card.get_by_role("listitem")).to_have_count(3)
        # Role controls come from the roster read (the fallback has none), so the read worked.
        expect(card.get_by_label("Role of Kai Tanaka")).to_be_visible()
        expect(ada.get_by_text("Who is in this space couldn’t be loaded")).to_have_count(0)
        shot_both(ada, f"1214-everyone-settings-1440-{UI_BROWSER}")

    MEMBERS = re.compile(r"/api/v1/workspaces/[^/]+/members$")

    def everyone_settings(self, name: str) -> tuple[Page, str]:
        """A space for the whole company, made by its owner; the test opens its settings page once it has set its route."""
        ada = self.page("ada")
        made = self.api(ada, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": name, "visibility": "workspace"}, status=201)
        return ada, made["id"]

    def test_02e_a_people_read_that_fails_for_a_moment_is_asked_again_and_says_nothing(self) -> None:
        """#1272: a read of who is in the space that fails for a reason that passes (a dead connection after a long idle, a busy or restarting
        server) is asked again on its own; the person sees the list and never a notice."""
        self.ensure_world()
        ada, pid = self.everyone_settings("Open door")
        answers = {"failed": 0}

        def moment(route) -> None:
            if answers["failed"] < 1:
                answers["failed"] += 1
                route.fulfill(status=503, content_type="application/json", body='{"error":"Service Unavailable"}')
            else:
                route.continue_()

        ada.route(self.MEMBERS, moment)
        ada.goto(f"/projects/{pid}/settings")
        expect(ada.get_by_role("heading", name="Space settings")).to_be_visible()
        card = ada.get_by_role("list", name="People in Open door")
        # The roster's own controls (the shell's fallback has none) arrive with the second ask, with nobody pressing anything.
        expect(card.get_by_label("Role of Kai Tanaka")).to_be_visible()
        expect(card.get_by_role("listitem")).to_have_count(3)
        expect(ada.get_by_text("Who is in this space couldn’t be loaded")).to_have_count(0)
        self.assertEqual(answers["failed"], 1, "the first read failed and the page asked again")

    def test_02f_a_people_read_that_keeps_failing_shows_the_notice_alone_and_try_again_recovers(self) -> None:
        """#1272: the section shows the list or the notice, never both: while the read fails nobody is listed (not even the owner from the
        shell), and Try again shows the list once the read works."""
        self.ensure_world()
        ada, pid = self.everyone_settings("Open yard")
        ada.route(self.MEMBERS, lambda route: route.abort())
        ada.goto(f"/projects/{pid}/settings")
        expect(ada.get_by_role("heading", name="Space settings")).to_be_visible()
        notice = ada.get_by_role("alert").filter(has_text="Who is in this space couldn’t be loaded")
        expect(notice).to_be_visible(timeout=15_000)
        expect(ada.get_by_role("list", name="People in Open yard")).to_have_count(0)
        shot_both(ada, f"1272-everyone-people-failed-1440-{UI_BROWSER}")
        ada.unroute(self.MEMBERS)
        notice.get_by_role("button", name="Try again").click()
        card = ada.get_by_role("list", name="People in Open yard")
        expect(card.get_by_label("Role of Kai Tanaka")).to_be_visible()
        expect(card.get_by_role("listitem")).to_have_count(3)
        expect(notice).to_have_count(0)

    def test_02g_a_refused_people_read_is_not_asked_again(self) -> None:
        """#1272: only a read that failed for a reason that passes is asked again; a refusal says so at once and stays asked once."""
        self.ensure_world()
        ada, pid = self.everyone_settings("Open gate")
        asked = {"n": 0}

        def refuse(route) -> None:
            asked["n"] += 1
            route.fulfill(status=403, content_type="application/json", body='{"error":"Forbidden","code":"FORBIDDEN"}')

        ada.route(self.MEMBERS, refuse)
        ada.goto(f"/projects/{pid}/settings")
        expect(ada.get_by_role("alert").filter(has_text="Who is in this space couldn’t be loaded")).to_be_visible()
        before = asked["n"]
        ada.wait_for_timeout(3600)  # longer than the page's two waits together
        self.assertEqual(asked["n"], before, "no further ask after a refusal")

    def test_03_a_member_reads_the_settings_and_can_leave(self) -> None:
        self.ensure_world()
        pid = self.ids["space"]
        page = self.page("kai")
        page.goto(f"/projects/{pid}/settings")
        expect(page.get_by_role("heading", name="Space settings")).to_be_visible()
        expect(page.get_by_role("button", name=re.compile("^(Change the name|Add people|Delete space)"))).to_have_count(0)
        expect(page.get_by_role("switch", name="AI")).to_be_disabled()
        expect(page.get_by_text("Only admins of this space or of the company turn AI on or off.")).to_have_count(0)
        card = page.get_by_role("list", name="People in Kiln firmware")
        expect(card.get_by_role("combobox")).to_have_count(0)
        # The same people as the admin read: the people added to the space.
        self.assertEqual(self.names(card), self.ids["people"])
        shot(page, "874-space-settings-member")
        page.get_by_role("button", name="Leave space").click()
        confirm = page.get_by_role("group", name="Leave Kiln firmware")
        expect(confirm).to_contain_text("You stop seeing Kiln firmware at once.")
        confirm.get_by_role("button", name="Leave Kiln firmware").click()
        expect(page).to_have_url(f"{ORIGIN}/")
        self.api(page, "GET", f"/api/v1/projects/{pid}", status=404)
        # Added again by the admin, so the next test has two people.
        self.api(self.page("ada"), "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": self.ids["kai"]}, "role": "contributor"}, status=201)

    def test_04_the_last_admin_cannot_leave_and_deleting_asks_first_and_names_the_space(self) -> None:
        self.ensure_world()
        pid = self.ids["space"]
        page = self.page("ada")
        page.goto(f"/projects/{pid}/settings")
        page.get_by_role("button", name="Leave space").click()
        page.get_by_role("group", name="Leave Kiln firmware").get_by_role("button", name="Leave Kiln firmware").click()
        expect(page.locator("[data-space-settings]").get_by_role("alert")).to_contain_text("Add another admin first: a space always keeps one.")
        page.get_by_role("group", name="Leave Kiln firmware").get_by_role("button", name="Cancel").click()
        page.get_by_role("button", name="Delete space…").click()
        dialog = page.get_by_role("alertdialog", name="Delete Kiln firmware?")
        expect(dialog).to_contain_text("Kiln firmware and everything in it will be erased")
        shot(page, "874-space-delete-confirm")
        dialog.get_by_role("button", name="Cancel").click()
        expect(dialog).to_have_count(0)
        self.assertEqual(self.api(page, "GET", f"/api/v1/projects/{pid}")["name"], "Kiln firmware")
        page.get_by_role("button", name="Delete space…").click()
        page.get_by_role("alertdialog", name="Delete Kiln firmware?").get_by_role("button", name="Delete Kiln firmware").click()
        expect(page).to_have_url(f"{ORIGIN}/")
        expect(page.get_by_text("Kiln firmware was deleted.")).to_be_visible()
        self.api(page, "GET", f"/api/v1/projects/{pid}", status=404)
        expect(page.get_by_role("navigation", name="Spaces").get_by_text("Kiln firmware")).to_have_count(0)

    def test_05_a_company_admin_deletes_a_space_from_settings_company_and_everyone_has_no_delete(self) -> None:
        self.ensure_world()
        page = self.page("ada")
        made = self.api(page, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Old experiments", "visibility": "restricted"}, status=201)
        page.goto("/settings/company")
        row = page.get_by_role("list", name="Every space in the company").get_by_role("listitem").filter(has_text="Old experiments")
        row.get_by_role("button", name="Delete Old experiments").click()
        page.get_by_role("alertdialog", name="Delete Old experiments?").get_by_role("button", name="Delete Old experiments").click()
        expect(page.get_by_text("Old experiments was deleted.")).to_be_visible()
        self.api(page, "GET", f"/api/v1/projects/{made['id']}", status=404)

    def test_06_phone_settings_fit_the_width_and_names_stay_whole(self) -> None:
        self.ensure_world()
        stamp = int(time.time() * 1000)
        long_name = "Małgorzata Wiśniewska-Kowalczyk"
        self.sign_up("mal", long_name, f"mal.spaceset+{stamp}@example.test")
        page = self.page("ada", PHONE)
        self.api(page, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/members", {"email": f"mal.spaceset+{stamp}@example.test", "role": "member"}, status=201)
        mal = self.api(self.page("mal"), "GET", "/api/v1/me")["user"]["id"]
        made = self.api(page, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Phone space", "visibility": "restricted", "people": [self.ids["kai"], mal]}, status=201)
        page.goto(f"/projects/{made['id']}/settings")
        expect(page.get_by_role("heading", name="Space settings")).to_be_visible()
        expect(page.get_by_role("list", name="People in Phone space").get_by_role("listitem")).to_have_count(3)
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"], "no horizontal page scroll")
        # A person's row stacks: the name whole on its line, the role and Remove under it, never a name broken in the middle of a word.
        rows = page.evaluate("""() => [...document.querySelectorAll('.spset .sset-row[data-person]')].map((row) => {
          const who = row.querySelector('.spset__who b'); const lh = parseFloat(getComputedStyle(who).lineHeight) || 22;
          const role = row.querySelector('.spset__rolecell, .spset__role'); const remove = row.querySelector('.spset__remove');
          return { name: who.textContent, lines: Math.round(who.getBoundingClientRect().height / lh), whoBottom: row.querySelector('.spset__who').getBoundingClientRect().bottom,
            roleTop: role ? role.getBoundingClientRect().top : null, removeTop: remove ? remove.getBoundingClientRect().top : null };
        })""")
        self.assertEqual(len(rows), 3)
        for row in rows:
            self.assertLessEqual(row["lines"], 2, f"{row['name']} stays in whole words")
            self.assertGreaterEqual(row["roleTop"], row["whoBottom"] - 1, f"the role of {row['name']} is under the name")
            if row["removeTop"] is not None:
                self.assertGreaterEqual(row["removeTop"], row["whoBottom"] - 1, f"Remove of {row['name']} is under the name")
        longest = next(row for row in rows if row["name"].startswith("Małgorzata"))
        self.assertEqual(page.evaluate("""() => { const b = [...document.querySelectorAll('.spset__who b')].find((e) => e.textContent.startsWith('Małgorzata'));
          return b.scrollWidth <= b.clientWidth + 1; }"""), True, f"{longest['name']} is not cut or pushed out")
        shot(page, "874-space-settings-phone")

    def test_07_a_company_owner_who_was_not_added_reads_the_same_people(self) -> None:
        """The people of a space are the people added to it: the company's owner reaches it but is not one of them."""
        self.ensure_world()
        lee = self.page("lee")
        made = self.api(lee, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Lee’s room", "visibility": "restricted", "people": [self.ids["kai"]]}, status=201)
        as_admin, as_member, as_owner = self.page("lee"), self.page("kai"), self.page("ada")
        lists = []
        for page in (as_admin, as_member, as_owner):
            page.goto(f"/projects/{made['id']}/settings")
            card = page.get_by_role("list", name="People in Lee’s room")
            expect(card.get_by_role("listitem")).to_have_count(2)
            lists.append(self.names(card))
        self.assertEqual(lists[0], lists[1])
        self.assertEqual(lists[1], lists[2], "the owner reads who was added, and is not in the list")
        self.assertNotIn("Ada Kowalska", lists[2])
        # The Owner choice of a new task offers the people in the space and nobody else.
        as_member.goto(f"/projects/{made['id']}/tasks")
        as_member.get_by_role("button", name=re.compile("^(New )?Task$")).first.click()
        window = as_member.get_by_role("dialog", name="New task")
        expect(window).to_be_visible()
        listbox = open_select(window.get_by_role("combobox", name="Owner"))
        # The space's people arrive after the window opens (until then it offers "you" alone).
        expect(listbox.get_by_role("option", name=re.compile("Lee Moreno"))).to_have_count(1)
        texts = listbox.get_by_role("option").all_inner_texts()
        self.assertTrue(any("Kai Tanaka" in text for text in texts) and any("Lee Moreno" in text for text in texts), texts)
        self.assertFalse(any("Ada Kowalska" in text or "Małgorzata" in text for text in texts), texts)

    def test_08_a_run_stopped_because_ai_was_turned_off_says_so_in_its_thread_also_after_a_reload(self) -> None:
        """AG-10, C-17: the owner is told in the thread where they asked; the line survives a reload until it is dismissed."""
        self.ensure_world()
        page = self.page("ada")
        space = self.api(page, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Stopped runs", "visibility": "restricted"}, status=201)
        agent = self.api(page, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/agents", {"name": "Ada’s analyst", "owner": "self"}, status=201)
        # #854: the model of a connection (Connect AI's default: the TEST-ONLY fixture key); nothing else to agree to.
        default = self.api(page, "GET", "/api/v1/personal-assistant/model", status=200)["default"]
        self.api(page, "POST", "/api/v1/my-agents", {"agentId": agent["id"], **default}, status=201)
        conversation = self.api(page, "POST", f"/api/v1/projects/{space['id']}/conversations", {"body": "Which sensor should we test?", "clientMessageId": str(uuid.uuid4())}, status=201)
        mock("/__script", {"reset": True, "delay": 20})
        try:
            run = self.api(page, "POST", f"/api/v1/conversations/{conversation['id']}/assistant-runs", {"clientRunId": str(uuid.uuid4()), "kind": "ask", "prompt": "Compare the readings."}, status=202)
            self.api(page, "PUT", f"/api/v1/projects/{space['id']}/ai-policy", {"state": "blocked"})
            end = time.time() + 30
            while time.time() < end:
                ended = self.api(page, "GET", f"/api/v1/assistant-runs/{run['id']}")
                if ended["status"] == "stopped":
                    break
                time.sleep(0.25)
            self.assertEqual((ended["status"], ended.get("endReason")), ("stopped", "ai_off"))
            line = "AI was turned off in this space, so your assistant stopped."
            page.goto(f"/projects/{space['id']}/conversations/{conversation['id']}")
            expect(page.get_by_text(line)).to_be_visible()
            page.reload()
            expect(page.get_by_text(line)).to_be_visible()
            page.get_by_role("button", name="Dismiss").click()
            expect(page.get_by_text(line)).to_have_count(0)
            page.reload()
            expect(page.get_by_role("heading", level=1)).to_be_visible()
            expect(page.get_by_text(line)).to_have_count(0)
        finally:
            mock("/__script", {"reset": True})


    def test_09_a_person_removed_from_a_space_is_told_at_once_and_back_into_it_says_so(self) -> None:
        """#862 (#592, FT-8): the removal reaches the removed person's open tab, by the space's id alone. The space leaves their sidebar
        at once, and Back into its Map or Tasks reads again instead of showing what the tab had kept: "That space is no longer available to you."."""
        self.ensure_world()
        ada = self.page("ada")
        space = self.api(ada, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Glaze recipes", "visibility": "restricted", "people": [self.ids["lee"]]}, status=201)
        pid = space["id"]
        self.api(ada, "POST", f"/api/v1/projects/{pid}/conversations", {"body": "Cone 6 test tiles on Friday", "clientMessageId": str(uuid.uuid4())}, status=201)
        for view in ("Map", "Tasks"):
            with self.subTest(view=view):
                lee = self.page("lee")
                lee.goto("/")
                spaces = lee.get_by_role("navigation", name="Spaces")
                spaces.get_by_role("link", name=re.compile("^Glaze recipes")).click()
                expect(lee.get_by_text("Cone 6 test tiles on Friday").first).to_be_visible()
                view_tab(lee, view)
                expect(lee).to_have_url(re.compile(rf"/projects/{pid}/{view.lower()}"))
                lee.get_by_role("navigation", name="Places").get_by_role("link", name="Home", exact=True).click()
                expect(lee.get_by_role("heading", level=1, name="Home")).to_be_visible()
                grants = self.api(ada, "GET", f"/api/v1/projects/{pid}/grants")
                grant = next(g for g in grants if g["principal"]["id"] == self.ids["lee"])
                removed = ada.request.delete(f"{ORIGIN}/api/v1/projects/{pid}/grants/{grant['id']}", headers={"origin": ORIGIN})
                self.assertEqual(removed.status, 204, removed.text())
                # Told at once: the space leaves the sidebar without a reload or a click.
                expect(spaces.get_by_role("link", name=re.compile("^Glaze recipes"))).to_have_count(0)
                lee.go_back()
                expect(lee.get_by_text("That space is no longer available to you.", exact=True)).to_be_visible()
                expect(lee).to_have_url(re.compile(r"/projects$"))
                expect(lee.get_by_text("Glaze recipes")).to_have_count(0)
                self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": self.ids["lee"]}, "role": "contributor"}, status=201)


    def test_10_removed_from_the_company_back_into_a_space_says_so_and_removed_inside_lands_calmly(self) -> None:
        """#862: entering a space reads the space itself, so Back into its Map after removal from the company lands on the project list with
        one line (#592), not on what the tab had kept. Someone removed from a space while on its Map lands there too."""
        self.ensure_world()
        ada = self.page("ada")
        email = f"max.spaceset+{STAMP}@example.test"
        self.sign_up("max", "Max Weber", email)
        self.api(ada, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/members", {"email": email, "role": "member"}, status=201)
        max_id = self.api(self.page("max"), "GET", "/api/v1/me")["user"]["id"]
        space = self.api(ada, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Kiln log", "visibility": "restricted", "people": [max_id]}, status=201)
        pid = space["id"]
        self.api(ada, "POST", f"/api/v1/projects/{pid}/conversations", {"body": "Bisque firing at 950", "clientMessageId": str(uuid.uuid4())}, status=201)

        def open_map(page: Page) -> None:
            page.goto("/")
            page.get_by_role("navigation", name="Spaces").get_by_role("link", name=re.compile("^Kiln log")).click()
            expect(page.get_by_text("Bisque firing at 950").first).to_be_visible()
            view_tab(page, "Map")
            expect(page).to_have_url(re.compile(rf"/projects/{pid}/map"))

        def lands_calmly(page: Page) -> None:
            expect(page.get_by_text("That space is no longer available to you.", exact=True)).to_be_visible()
            expect(page).to_have_url(re.compile(r"/projects$"))
            expect(page.get_by_text("This place isn’t available")).to_have_count(0)

        # Removed from the space while its Map is open: the calm landing, not the error page.
        inside = self.page("max")
        open_map(inside)
        grant = next(g for g in self.api(ada, "GET", f"/api/v1/projects/{pid}/grants") if g["principal"]["id"] == max_id)
        removed = ada.request.delete(f"{ORIGIN}/api/v1/projects/{pid}/grants/{grant['id']}", headers={"origin": ORIGIN})
        self.assertEqual(removed.status, 204, removed.text())
        lands_calmly(inside)
        # The event also took the space off its lists.
        expect(inside.locator("#content").get_by_text("Kiln log")).to_have_count(0)
        expect(inside.get_by_role("navigation", name="Spaces").get_by_text("Kiln log")).to_have_count(0)
        self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": max_id}, "role": "contributor"}, status=201)

        # Removed from the company while on Home: Back into the Map reads the space and says so.
        max_page = self.page("max")
        open_map(max_page)
        max_page.get_by_role("navigation", name="Places").get_by_role("link", name="Home", exact=True).click()
        expect(max_page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        gone = ada.request.delete(f"{ORIGIN}/api/v1/workspaces/{self.ids['workspace']}/members/{max_id}", headers={"origin": ORIGIN})
        self.assertEqual(gone.status, 204, gone.text())
        self.assertEqual(max_page.context.request.get(f"{ORIGIN}/api/v1/projects/{pid}").status, 404)
        max_page.go_back()
        lands_calmly(max_page)


    def test_11_removal_from_the_company_reaches_an_open_tab_inside_a_space_and_new_message(self) -> None:
        """#862: removal from the company reaches the person's open tab (`workspace.access_ended.v1`, for them alone): a view of a space they
        moved to inside it lands on the project list with one line (#592), and New message no longer offers the company's people."""
        self.ensure_world()
        ada = self.page("ada")
        email = f"noa.spaceset+{STAMP}@example.test"
        self.sign_up("noa", "Noa Lind", email)
        self.api(ada, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/members", {"email": email, "role": "member"}, status=201)
        noa_id = self.api(self.page("noa"), "GET", "/api/v1/me")["user"]["id"]
        space = self.api(ada, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Wheel room", "visibility": "restricted", "people": [noa_id]}, status=201)
        pid = space["id"]
        self.api(ada, "POST", f"/api/v1/projects/{pid}/conversations", {"body": "Clay order arrives Tuesday", "clientMessageId": str(uuid.uuid4())}, status=201)
        noa = self.page("noa")
        noa.goto("/")
        # New message lists the company's people.
        noa.get_by_role("navigation", name="Messages").get_by_role("link", name="Messages").click()
        noa.get_by_role("link", name="New message").first.click()
        people = noa.get_by_role("list", name="People")
        expect(people.get_by_text("Ada Kowalska")).to_have_count(1)
        noa.get_by_role("navigation", name="Places").get_by_role("link", name="Home", exact=True).click()
        expect(noa.get_by_role("heading", level=1, name="Home")).to_be_visible()
        # Into the space, then two views inside it: the space's own read is not made again on these moves.
        noa.get_by_role("navigation", name="Spaces").get_by_role("link", name=re.compile("^Wheel room")).click()
        expect(noa.get_by_text("Clay order arrives Tuesday").first).to_be_visible()
        view_tab(noa, "Tasks")
        expect(noa).to_have_url(re.compile(rf"/projects/{pid}/tasks"))
        view_tab(noa, "Map")
        expect(noa).to_have_url(re.compile(rf"/projects/{pid}/map"))
        gone = ada.request.delete(f"{ORIGIN}/api/v1/workspaces/{self.ids['workspace']}/members/{noa_id}", headers={"origin": ORIGIN})
        self.assertEqual(gone.status, 204, gone.text())
        # Told at once: the open view lands calmly, and the space leaves the lists.
        expect(noa.get_by_text("That space is no longer available to you.", exact=True)).to_be_visible()
        expect(noa).to_have_url(re.compile(r"/projects$"))
        expect(noa.get_by_text("This place isn’t available")).to_have_count(0)
        expect(noa.get_by_role("navigation", name="Spaces").get_by_text("Wheel room")).to_have_count(0)
        # Back into Tasks reads the space and says so too.
        noa.go_back()
        expect(noa.get_by_text("That space is no longer available to you.", exact=True)).to_be_visible()
        expect(noa).to_have_url(re.compile(r"/projects$"))
        # New message no longer offers the company's people.
        noa.get_by_role("navigation", name="Messages").get_by_role("link", name="Messages").click()
        noa.get_by_role("link", name="New message").first.click()
        expect(noa.locator("#content").get_by_role("heading", name="New message")).to_be_visible()
        expect(noa.get_by_text("Ada Kowalska")).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
