"""First run, Settings and People after the #763 Part B audit (FR-1–FR-9, SG-1–SG-7, PE-1–PE-4).

Real accounts through the running Compose app (scripts/check_ui.sh), in the engine FLUX_UI_BROWSER names (Chromium
or WebKit). Where the server state cannot be set from a test (in-app AI or email off), the one answer the page reads
is stubbed and the rest stays real.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from app_select import choose
from app_select import labels as app_labels
from create_window import kind_tab, window
from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder
from test_settings import assert_touch_target

PASSWORD = "a calm first run"
STAMP = int(time.time() * 1000)
TABLET = {"width": 768, "height": 1024}
UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")


class FirstRunSettingsPeople(unittest.TestCase):
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        assert cls.browser.browser_type.name == UI_BROWSER
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}")
        expect.set_options(timeout=10000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    # ---------------------------------------------------------------- helpers

    def page(self, who: str | None = None, *, viewport: dict | None = None, touch: bool = False, scheme: str = "light") -> Page:
        mobile = viewport == PHONE
        options: dict = {"base_url": ORIGIN, "color_scheme": scheme, "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "service_workers": "block", "viewport": viewport or DESKTOP, "device_scale_factor": 1,
                         "has_touch": touch or mobile, "is_mobile": mobile}
        if who:
            options["storage_state"] = self.states[who]
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def sign_up(self, key: str, name: str) -> str:
        email = f"{key}.firstrun+{STAMP}@example.test"
        page = self.page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill(name)
        page.get_by_label("Email").fill(email)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).states[key] = page.context.storage_state()
        type(self).ids[key] = self.api(page, "GET", "/api/v1/me")["user"]["id"]
        type(self).ids[f"{key}:email"] = email
        return email

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None):
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json", "idempotency-key": str(uuid.uuid4())},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        text = response.text()
        return json.loads(text) if text else None

    def workspaces(self, page: Page) -> list[dict]:
        return self.api(page, "GET", "/api/v1/workspaces", status=200)

    # ---------------------------------------------------------------- first run (FR-1, FR-2, FR-5, FR-9)

    def test_01_a_first_project_asks_only_its_name_and_makes_the_workspace_quietly(self) -> None:
        self.sign_up("maria", "Maria Nowak")
        for viewport in (DESKTOP, PHONE):
            page = self.page("maria", viewport=viewport)
            page.goto("/projects/new")
            form = page.get_by_role("form", name="New project")
            expect(form.get_by_label("What is it about?")).to_be_focused()
            # No field asks for a workspace: the page says where the project goes, and that only Maria sees it.
            expect(form.get_by_label("Your space")).to_have_count(0)
            expect(form.get_by_role("textbox")).to_have_count(1)
            expect(form).to_contain_text("In Maria’s space")
            expect(form).to_contain_text("Only you can see it until you invite someone")
            expect(form.get_by_role("combobox", name="Workspace")).to_have_count(0)
            shot(page, f"763-new-project-first-{'390' if viewport == PHONE else '1440'}-{UI_BROWSER}")
        # An empty name says so in the form's own words, not with the browser's bubble.
        form.get_by_role("button", name="Create project").click()
        expect(form.get_by_text("Give the project a name.")).to_be_visible()
        expect(form.get_by_label("What is it about?")).to_have_attribute("aria-invalid", "true")
        self.assertEqual(self.workspaces(page), [], "nothing was made")
        form.get_by_label("What is it about?").fill("Balcony herbs")
        form.get_by_role("button", name="Create project").click()
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}\?new=1"))
        spaces = self.workspaces(page)
        self.assertEqual([(space["name"], space["role"]) for space in spaces], [("Maria’s space", "owner")])
        type(self).ids["maria:space"] = spaces[0]["id"]

    def test_02_new_with_no_project_opens_on_project_and_command_k_offers_a_project(self) -> None:
        self.sign_up("nobody", "Nia Empty")
        page = self.page("nobody")
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        page.keyboard.press("c")
        expect(window(page)).to_have_accessible_name("New project")
        expect(kind_tab(page, "Project")).to_have_attribute("aria-selected", "true")
        expect(window(page).get_by_role("tabpanel")).not_to_contain_text("There is no project yet")
        expect(window(page)).to_contain_text("In Nia’s space")
        page.keyboard.press("Escape")
        expect(window(page)).to_have_count(0)
        page.keyboard.press("Control+k")
        palette = page.get_by_role("dialog", name="Jump to")
        expect(palette).to_be_visible()
        expect(palette.get_by_role("option", name=re.compile("^New task"))).to_have_count(0)
        expect(palette.get_by_role("option", name=re.compile("^New project"))).to_have_count(1)
        palette.get_by_role("combobox", name="Jump to").fill("Seed swap")
        expect(palette.get_by_role("option", name=re.compile("^New task"))).to_have_count(0)
        palette.get_by_role("option", name=re.compile("^New project “Seed swap”")).click()
        expect(window(page)).to_have_accessible_name("New project")
        expect(window(page).get_by_label("What is it about?")).to_have_value("Seed swap")
        # With a project the window starts on Task again (F-026 S3).
        window(page).get_by_role("button", name=re.compile("^Create project")).click()
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}\?new=1"))
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        page.keyboard.press("c")
        expect(kind_tab(page, "Task")).to_have_attribute("aria-selected", "true")

    def test_03_someone_who_manages_two_workspaces_chooses_where_the_project_goes(self) -> None:
        page = self.page("maria")
        second = self.api(page, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, status=201)
        # A workspace where Maria is only a member is not offered: members do not create projects there.
        self.sign_up("olek", "Olek Member")
        olek = self.page("olek")
        other = self.api(olek, "POST", "/api/v1/workspaces", {"name": "Olek’s club"}, status=201)
        self.api(olek, "POST", f"/api/v1/workspaces/{other['id']}/members", {"email": self.ids["maria:email"], "role": "member"}, status=201)
        page = self.page("maria")
        page.goto("/projects/new")
        form = page.get_by_role("form", name="New project")
        picker = form.get_by_role("combobox", name="Workspace")
        expect(picker).to_be_visible()
        expect(form).to_contain_text(re.compile("In (Maria’s space|Riverside Makers)"))
        self.assertEqual(sorted(app_labels(picker)), ["Maria’s space", "Riverside Makers"])
        choose(picker, label="Riverside Makers")
        expect(form).to_contain_text("In Riverside Makers")
        shot(page, f"763-new-project-two-places-1440-{UI_BROWSER}")
        form.get_by_label("What is it about?").fill("Tool library")
        form.get_by_role("button", name="Create project").click()
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}\?new=1"))
        project_id = re.search(r"/projects/([0-9a-f-]{36})", page.url).group(1)
        self.assertEqual(self.api(page, "GET", f"/api/v1/projects/{project_id}", status=200)["workspaceId"], second["id"])
        # The Create window's Project tab has the same picker.
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        page.keyboard.press("c")
        kind_tab(page, "Project").click()
        expect(window(page).get_by_role("combobox", name="Workspace")).to_be_visible()

    # ---------------------------------------------------------------- sign-up and sign-in (FR-7, FR-8)

    def test_04_sign_up_errors_replace_hints_and_sign_in_tabs_to_the_password_first(self) -> None:
        page = self.page()
        page.goto("/sign-up?email=new.person%40example.test")
        expect(page.get_by_label("Email")).to_have_value("new.person@example.test")
        page.get_by_label("Name").fill("Short Password")
        page.get_by_label("Password").fill("short")
        page.get_by_role("button", name="Create account").click()
        expect(page.locator(".ui-field__error")).to_have_count(1)
        expect(page.get_by_text(re.compile("^At least 8 characters"))).to_have_count(0)
        page.goto("/sign-in")
        expect(page.get_by_label("Email")).to_be_focused()
        page.keyboard.press("Tab")
        expect(page.get_by_label("Password")).to_be_focused()
        page.keyboard.press("Tab")
        expect(page.get_by_role("link", name="Forgot password?")).to_be_focused()
        # On screen it still sits beside the Password label.
        link, label = page.get_by_role("link", name="Forgot password?").bounding_box(), page.locator("label", has_text="Password").bounding_box()
        self.assertLess(abs(link["y"] - label["y"]), 8, (link, label))
        self.assertLess(link["y"], page.get_by_label("Password").bounding_box()["y"])

    # ---------------------------------------------------------------- Settings → Account (SG-1)

    def test_05_account_changes_name_email_and_password_and_lists_devices(self) -> None:
        email = self.sign_up("acct", "Jonas Berg")
        other = self.page()
        other.goto("/sign-in")
        other.get_by_label("Email").fill(email)
        other.get_by_label("Password").fill(PASSWORD)
        other.get_by_role("button", name="Sign in").click()
        expect(other.get_by_role("heading", level=1, name="Home")).to_be_visible()

        page = self.page("acct")
        page.goto("/settings/account")
        details = page.get_by_role("region", name="Your details")
        details.get_by_role("button", name="Change name").click()
        details.get_by_label("Name").fill("Jonas B. Berg")
        details.get_by_role("button", name="Save name").click()
        expect(details.get_by_role("status").filter(has_text="Name saved")).to_be_visible()
        self.assertEqual(self.api(page, "GET", "/api/v1/me")["user"]["name"], "Jonas B. Berg")

        details.get_by_role("button", name="Change email").click()
        details.get_by_label("New email").fill(f"jonas.moved+{STAMP}@example.test")
        details.get_by_label("Current password").fill("not the password")
        details.get_by_role("button", name="Change email").last.click()
        expect(details.get_by_text("Your current password is not right.")).to_be_visible()
        self.assertEqual(self.api(page, "GET", "/api/v1/me")["user"]["email"], email)
        details.get_by_label("Current password").fill(PASSWORD)
        details.get_by_role("button", name="Change email").last.click()
        moved = f"jonas.moved+{STAMP}@example.test"
        expect(details.get_by_role("status").filter(has_text=f"Your address is now {moved}.")).to_be_visible()
        self.assertEqual(self.api(page, "GET", "/api/v1/me")["user"]["email"], moved)

        devices = page.get_by_role("list", name="Signed-in devices")
        expect(devices.get_by_role("listitem")).to_have_count(2)
        expect(devices.get_by_role("listitem").first).to_contain_text("this device")
        shot(page, f"763-settings-account-1440-{UI_BROWSER}")

        details.get_by_role("button", name="Change password").click()
        details.get_by_label("Current password").fill(PASSWORD)
        details.get_by_label("New password").fill("a new calm sentence")
        expect(details.get_by_label("Sign out my other devices")).to_be_checked()
        details.get_by_role("button", name="Change password").last.click()
        expect(details.get_by_role("status").filter(has_text="Password changed. Your other devices are signed out.")).to_be_visible()
        self.assertEqual(other.request.get(f"{ORIGIN}/api/v1/me").status, 401, "the other device is signed out")
        fresh = self.page()
        fresh.goto("/sign-in")
        fresh.get_by_label("Email").fill(moved)
        fresh.get_by_label("Password").fill("a new calm sentence")
        fresh.get_by_role("button", name="Sign in").click()
        expect(fresh.get_by_role("heading", level=1, name="Home")).to_be_visible()

    def test_06_a_changed_address_needs_the_current_password_on_the_server_too(self) -> None:
        page = self.page("maria")
        response = page.request.post(f"{ORIGIN}/api/auth/change-email", headers={"origin": ORIGIN}, data={"newEmail": f"stolen+{STAMP}@example.test"})
        self.assertEqual(response.status, 400, response.text())
        self.assertEqual(response.json().get("code"), "INVALID_PASSWORD")
        self.assertEqual(self.api(page, "GET", "/api/v1/me")["user"]["email"], self.ids["maria:email"])

    # ---------------------------------------------------------------- Agents and AI off on the server (SG-2, SG-7)

    def test_07_agents_and_ai_is_three_calm_rows_when_the_server_runs_no_ai(self) -> None:
        def stub(page: Page) -> None:
            real = self.api(page, "GET", "/api/v1/personal-assistant", status=200)
            off = {**real, "state": "unavailable", "enablement": None,
                   "setup": {"provider": "off", "connection": "none", "runtime": {"state": "off", "payer": None, "accountLabel": None, "client": None}}}
            page.route(re.compile(r".*/api/v1/personal-assistant$"), lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(off))
                       if route.request.method == "GET" else route.continue_())
            page.route(re.compile(r".*/api/v1/background-comparisons/runtime$"), lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({"status": "unavailable"})))

        for viewport in (DESKTOP, PHONE):
            page = self.page("maria", viewport=viewport)
            stub(page)
            page.goto("/settings/agents")
            calm = page.locator("[data-ai-settings='server-off']")
            expect(calm).to_be_visible()
            expect(calm.get_by_role("link", name=re.compile("^Local co-work on this computer"))).to_be_visible()
            card = page.get_by_role("region", name=re.compile("^Your assistant"))
            expect(card).to_contain_text("Off on this Flux server · ask your admin to turn it on")
            expect(card.get_by_role("button")).to_have_count(0)
            expect(card.get_by_role("link")).to_have_count(0)
            expect(calm).to_contain_text("Background suggestions")
            expect(page.get_by_role("link", name=re.compile("^Use an API key"))).to_have_count(0)
            expect(page.get_by_text("Which account should I use?")).to_have_count(0)
            # E04 order: local co-work, the assistant, background suggestions.
            rows = [page.get_by_text("Local co-work on this computer"), card, page.get_by_text("Background suggestions", exact=True)]
            tops = [row.bounding_box()["y"] for row in rows]
            self.assertEqual(tops, sorted(tops), tops)
            shot(page, f"763-agents-ai-server-off-{'390' if viewport == PHONE else '1440'}-{UI_BROWSER}")
        page = self.page("maria")
        stub(page)
        page.goto("/settings/assistant")
        expect(page.locator("[data-assistant='server-off']")).to_contain_text("Off on this Flux server · ask your admin to turn it on")
        expect(page.locator("[data-assistant='server-off']").get_by_role("button")).to_have_count(0)
        expect(page.get_by_role("link", name="Back to Agents and AI")).to_be_visible()
        # The account menu holds Settings and People, never features that may be off.
        page.goto("/")
        page.locator(".me__btn").click()
        menu = page.get_by_role("dialog", name="Account")
        expect(menu.get_by_role("link", name="Your assistant")).to_have_count(0)
        expect(menu.get_by_role("link", name="Your background suggestions")).to_have_count(0)
        expect(menu.get_by_role("link", name="All settings")).to_be_visible()
        expect(menu.get_by_role("link", name="People")).to_be_visible()
        self.assertEqual(menu.get_by_role("link").evaluate_all("links => links.map((l) => getComputedStyle(l).textDecorationLine)"), ["none", "none"])

    # ---------------------------------------------------------------- Notifications (SG-3, SG-5)

    def test_08_notifications_offer_only_the_channels_this_server_has(self) -> None:
        page = self.page("maria")
        page.goto("/settings/notifications")
        # This stack has no VAPID keys: no Push column and no device push card, one line instead.
        expect(page.get_by_text("Push isn’t set up on this Flux server. Your inbox always works.")).to_be_visible()
        expect(page.get_by_role("columnheader", name="Push")).to_have_count(0)
        expect(page.get_by_role("columnheader", name="Email")).to_have_count(1)
        expect(page.get_by_text("Push on this device")).to_have_count(0)
        # While quiet hours are off, the line names this browser's zone, the one turning them on will use.
        quiet = page.get_by_role("switch", name="Quiet hours")
        expect(quiet).to_have_attribute("aria-checked", "false")
        expect(page.locator(".sset-row").filter(has=quiet)).to_contain_text("Europe/Warsaw")
        expect(page.locator(".sset-row").filter(has=quiet)).not_to_contain_text("UTC")
        # Without email too: no Email column, no "Where email goes", one line for both.
        stubbed = self.page("maria", viewport=PHONE)
        real = self.api(stubbed, "GET", "/api/v1/notification-preferences", status=200)
        real["email"]["available"] = False
        stubbed.route(re.compile(r".*/api/v1/notification-preferences$"), lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(real))
                      if route.request.method == "GET" else route.continue_())
        stubbed.goto("/settings/notifications")
        expect(stubbed.get_by_text("Push and email aren’t set up on this Flux server, so everything waits in your Inbox.")).to_be_visible()
        expect(stubbed.get_by_role("columnheader", name="Email")).to_have_count(0)
        expect(stubbed.get_by_role("heading", name="Where email goes")).to_have_count(0)
        expect(stubbed.get_by_role("columnheader", name="Inbox")).to_have_count(1)
        shot(stubbed, f"763-notifications-no-channels-390-{UI_BROWSER}")

    # ---------------------------------------------------------------- touch targets (SG-4)

    def test_09_switches_and_settings_rows_are_44_px_on_a_touch_tablet(self) -> None:
        page = self.page("maria", viewport=TABLET, touch=True)
        page.goto("/settings/notifications")
        nav = page.get_by_role("navigation", name="Settings sections")
        for link in nav.get_by_role("link").all():
            box = link.bounding_box()
            self.assertGreaterEqual(box["height"], 44 - 0.001, f"{link.inner_text()}: {box}")
        for name in ("Quiet hours", "Morning summary"):
            assert_touch_target(self, page, page.get_by_role("switch", name=name))
        page.goto("/settings/appearance")
        assert_touch_target(self, page, page.get_by_role("switch", name="Kreska in loading and empty screens"))

    # ---------------------------------------------------------------- People (PE-1, PE-2)

    def test_10_people_have_one_place_in_settings_and_the_account_menu(self) -> None:
        page = self.page("maria")
        page.goto("/settings")
        nav = page.get_by_role("navigation", name="Settings sections")
        expect(nav.get_by_role("link").first).to_be_visible()
        self.assertEqual(nav.get_by_role("link").all_inner_texts()[:2], ["Account", "People"])
        nav.get_by_role("link", name="People").click()
        expect(page).to_have_url(re.compile(r"/settings/people$"))
        expect(nav.get_by_role("link", name="People")).to_have_attribute("aria-current", "page")
        # Maria is in three workspaces: one row each, with her role.
        rows = page.locator(".sset-card").get_by_role("link")
        expect(rows).to_have_count(3)
        expect(page.get_by_role("link", name=re.compile("^Olek’s club"))).to_contain_text("You’re a member")
        page.get_by_role("link", name=re.compile("^Riverside Makers")).click()
        expect(page.get_by_role("heading", name="People", exact=True)).to_be_visible()
        expect(page.get_by_role("list", name="People in Riverside Makers")).to_contain_text("Maria Nowak (you)")
        expect(page.get_by_role("region", name="Add someone")).to_be_visible()
        expect(page.get_by_role("button", name="Back to Details")).to_have_count(0)
        shot(page, f"763-settings-people-1440-{UI_BROWSER}")
        # A member reads the people of a workspace and cannot add anyone.
        page.goto("/settings/people")
        page.get_by_role("link", name=re.compile("^Olek’s club")).click()
        expect(page.get_by_role("list", name="People in Olek’s club")).to_contain_text("Olek Member")
        expect(page.get_by_role("region", name="Add someone")).to_have_count(0)
        expect(page.get_by_text("Only owners and admins add people or change roles in Olek’s club.")).to_be_visible()
        # On the phone Settings lists People under the account.
        phone = self.page("maria", viewport=PHONE)
        phone.goto("/settings")
        phone.get_by_role("link", name=re.compile("^People")).click()
        expect(phone).to_have_url(re.compile(r"/settings/people$"))
        self.assertLessEqual(phone.evaluate("document.documentElement.scrollWidth"), PHONE["width"])

    def test_11_someone_new_gets_a_sign_up_link_with_their_address(self) -> None:
        page = self.page("maria")
        if UI_BROWSER == "chromium":
            page.context.grant_permissions(["clipboard-read", "clipboard-write"], origin=ORIGIN)
        page.goto(f"/settings/people/{self.ids['maria:space']}")
        add = page.get_by_role("region", name="Add someone")
        newcomer = f"piotr.new+{STAMP}@example.test"
        add.get_by_label("Email").fill(newcomer)
        add.get_by_role("button", name=re.compile("^Add to ")).click()
        expect(add.get_by_role("alert")).to_contain_text(f"No one has an account with {newcomer} here yet.")
        invite = page.get_by_role("region", name="Someone new to Flux")
        expect(invite).to_contain_text(f"as {newcomer}")
        invite.get_by_role("button", name="Copy sign-up link").click()
        expected = f"{ORIGIN}/sign-up?email={newcomer.replace('@', '%40').replace('+', '%2B')}"
        copied = invite.get_by_role("status")
        expect(copied).to_have_text(re.compile("Sign-up link copied.|Copy this link and send it to them."))
        # WebKit lets the page write the clipboard but not a test read it back.
        if "copied" in copied.inner_text() and UI_BROWSER == "chromium":
            self.assertEqual(page.evaluate("navigator.clipboard.readText()"), expected)
        else:
            expect(invite.get_by_label("Sign-up link")).to_have_value(expected)
        shot(page, f"763-people-sign-up-link-1440-{UI_BROWSER}")
        # The link opens sign-up with the address filled in; once the account exists, Maria adds it.
        stranger = self.page()
        stranger.goto(expected.replace(ORIGIN, ""))
        expect(stranger.get_by_label("Email")).to_have_value(newcomer)
        stranger.get_by_label("Name").fill("Piotr Nowy")
        stranger.get_by_label("Password").fill(PASSWORD)
        stranger.get_by_role("button", name="Create account").click()
        expect(stranger.get_by_role("heading", level=1, name="Home")).to_be_visible()
        add.get_by_label("Email").fill(newcomer)
        add.get_by_role("button", name=re.compile("^Add to ")).click()
        expect(page.locator("section[aria-labelledby='people-here'] .people__done")).to_contain_text("Piotr Nowy joined Maria’s space as member.")

    # ---------------------------------------------------------------- mention chips (PE-4)

    def test_12_mention_chips_use_the_same_initials_as_avatars(self) -> None:
        page = self.page("maria")
        project = self.api(page, "POST", f"/api/v1/workspaces/{self.ids['maria:space']}/projects", {"name": "Mentions", "visibility": "workspace"}, status=201)
        self.api(page, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": "Thanks @Maria Nowak and @Piotr Nowy", "clientMessageId": str(uuid.uuid4())}, status=201)
        page.goto(f"/projects/{project['id']}")
        chips = page.locator(".ref-chip--person .ref-chip__face")
        expect(chips.first).to_be_visible()
        self.assertEqual(chips.evaluate_all("faces => faces.map((face) => face.dataset.initials)"), ["MN", "PN"])


if __name__ == "__main__":
    unittest.main()
