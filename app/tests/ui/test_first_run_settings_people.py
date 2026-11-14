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
from create_window import kind_tab, new_space_window, open_create, window
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

    def grant_of(self, page: Page, project_id: str, who: str) -> str:
        grants = self.api(page, "GET", f"/api/v1/projects/{project_id}/grants", status=200)
        return next(grant["id"] for grant in grants if grant["principal"]["id"] == self.ids[who])

    # ---------------------------------------------------------------- first run (FR-1, FR-2, FR-5, FR-9)

    def test_01_someone_nobody_invited_is_in_no_company_and_starts_no_space(self) -> None:
        """F-037: one Flux is one company, set up by its first account; a later sign-up joins only through a link."""
        self.sign_up("maria", "Maria Nowak")
        page = self.page("maria")
        page.goto("/")
        open_create(page)
        form = new_space_window(page).get_by_role("form", name="New space")
        expect(form.get_by_label("Space name")).to_be_focused()
        expect(form.get_by_role("alert")).to_have_text("You’re not in a company on this Flux yet. Ask an admin for an invite link.")
        expect(form.get_by_role("button", name="Create space")).to_be_disabled()
        expect(form.get_by_role("combobox", name="Workspace")).to_have_count(0)
        self.assertEqual(self.workspaces(page), [], "nothing was made")
        page.goto("/")
        expect(page.get_by_role("region", name="You’re not in a company here yet")).to_contain_text("Got an invite link? Open it to join your company.")
        # The test deployment's fixture route gives Maria a company of her own for the tests below.
        made = self.api(page, "POST", "/api/v1/workspaces", {"name": "Maria’s company"}, status=201)
        type(self).ids["maria:space"] = made["id"]
        page.goto("/")
        open_create(page)
        form = new_space_window(page).get_by_role("form", name="New space")
        # An empty name says so in the form's own words, not with the browser's bubble.
        form.get_by_role("button", name="Create space").click()
        expect(form.get_by_text("Give the space a name.")).to_be_visible()
        expect(form.get_by_label("Space name")).to_have_attribute("aria-invalid", "true")
        form.get_by_label("Space name").fill("Balcony herbs")
        form.get_by_role("button", name="Create space").click()
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}$"))
        self.assertEqual([(space["name"], space["role"]) for space in self.workspaces(page)], [("Maria’s company", "owner")], "starting a space makes no workspace")

    def test_02_new_with_no_space_opens_on_space_and_command_k_does_not_create(self) -> None:
        self.sign_up("nobody", "Nia Empty")
        page = self.page("nobody")
        self.api(page, "POST", "/api/v1/workspaces", {"name": "Nia’s company"}, status=201)
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        page.keyboard.press("c")
        expect(window(page)).to_have_accessible_name("New space")
        expect(new_space_window(page).get_by_role("heading", name="New space")).to_be_visible()
        expect(window(page).get_by_role("tablist")).to_have_count(0)
        page.keyboard.press("Escape")
        expect(window(page)).to_have_count(0)
        # Search finds; it has no Create row, with a space or without one (#870).
        page.keyboard.press("Control+k")
        palette = page.get_by_role("dialog", name="Search", exact=True)
        expect(palette).to_be_visible()
        expect(palette.get_by_role("option", name=re.compile("^New "))).to_have_count(0)
        palette.get_by_role("combobox", name="Search", exact=True).fill("Seed swap")
        expect(palette.get_by_role("option", name=re.compile("^New "))).to_have_count(0)
        page.keyboard.press("Escape")
        expect(palette).to_have_count(0)
        page.keyboard.press("c")
        expect(window(page)).to_have_accessible_name("New space")
        window(page).get_by_label("Space name").fill("Seed swap")
        # With a space the window starts on Task again (F-026 S3).
        window(page).get_by_role("button", name=re.compile("^Create space")).click()
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}$"))
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        page.keyboard.press("c")
        expect(kind_tab(page, "Task")).to_have_attribute("aria-selected", "true")

    # ---------------------------------------------------------------- sign-up and sign-in (FR-7, FR-8)

    def test_04_sign_up_errors_replace_hints_and_sign_in_tabs_to_the_password_first(self) -> None:
        page = self.page()
        page.goto("/sign-up?email=new.person%40example.test")
        expect(page.get_by_label("Email")).to_have_value("new.person@example.test")
        page.get_by_label("Name").fill("Short Password")
        page.get_by_label("Password").fill("short")
        page.get_by_role("button", name="Create account").click()
        expect(page.locator(".ui-field__error")).to_have_count(1)
        expect(page.get_by_text(re.compile("^At least 12 characters"))).to_have_count(0)
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

    # ---------------------------------------------------------------- Settings › AI off on the server (SG-2, SG-7)

    def test_07_settings_ai_is_two_calm_rows_when_the_server_runs_no_ai(self) -> None:
        def stub(page: Page) -> None:
            real = self.api(page, "GET", "/api/v1/personal-assistant", status=200)
            off = {**real, "state": "unavailable", "enablement": None,
                   "setup": {"provider": "off", "connection": "none", "runtime": {"state": "off", "payer": None, "accountLabel": None, "client": None}}}
            page.route(re.compile(r".*/api/v1/personal-assistant$"), lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(off))
                       if route.request.method == "GET" else route.continue_())

        for viewport in (DESKTOP, PHONE):
            page = self.page("maria", viewport=viewport)
            stub(page)
            page.goto("/settings/agents")
            calm = page.locator("[data-ai-settings='server-off']")
            expect(calm).to_be_visible()
            expect(calm.get_by_role("link", name=re.compile("^Claude Code or Codex on your computer"))).to_have_attribute("href", "/settings/agents/connect")
            card = calm.get_by_text("Off on this Flux server. Your agents wait until it is on.")
            expect(card).to_be_visible()
            expect(page.get_by_role("region", name="Your agents")).to_have_count(0)
            expect(page.get_by_role("link", name=re.compile("^Use an API key"))).to_have_count(0)
            expect(page.get_by_text("Which account should I use?")).to_have_count(0)
            # #1438: AI is off only by the operator's choice, so nobody is told to ask someone.
            expect(page.get_by_text(re.compile("ask your admin", re.I))).to_have_count(0)
            # E04 order: the person's own Claude Code or Codex, then the one status line.
            rows = [page.get_by_text("Claude Code or Codex on your computer"), card]
            tops = [row.bounding_box()["y"] for row in rows]
            self.assertEqual(tops, sorted(tops), tops)
            shot(page, f"763-agents-ai-server-off-{'390' if viewport == PHONE else '1440'}-{UI_BROWSER}")
        page = self.page("maria")
        stub(page)
        # The name at the foot of the sidebar is the one way into Settings (#1419): no menu behind it, and the company's people are in
        # Settings › Company, never features that may be off.
        page.goto("/")
        account = page.locator(".me")
        expect(account.get_by_role("link")).to_have_count(1)
        expect(account.get_by_role("link", name=re.compile(", Settings$"))).to_be_visible()
        expect(page.get_by_role("dialog", name="Account")).to_have_count(0)
        self.assertEqual(account.get_by_role("link").evaluate_all("links => links.map((l) => getComputedStyle(l).textDecorationLine)"), ["none"])

    # ---------------------------------------------------------------- Notifications (SG-3, SG-5)

    def test_08_notifications_offer_only_the_channels_this_server_has(self) -> None:
        page = self.page("maria")
        page.goto("/settings/notifications")
        # This stack has no VAPID keys: no row for this device, one line instead; email is set up, so Email me too stays.
        expect(page.get_by_text("Push isn’t set up on this Flux server. Your inbox always works.")).to_be_visible()
        expect(page.get_by_text("On this device")).to_have_count(0)
        expect(page.get_by_role("switch", name="Email me too")).to_be_visible()
        expect(page.get_by_text("Email addresses", exact=True)).to_be_visible()
        # While quiet hours are off, the switch inside Change names this browser's zone, the one turning them on will use.
        page.get_by_role("button", name="Change quiet hours").click()
        quiet = page.get_by_role("switch", name="Use quiet hours")
        expect(quiet).to_have_attribute("aria-checked", "false")
        expect(page.locator(".sset-row").filter(has=quiet)).to_contain_text("Europe/Warsaw")
        expect(page.locator(".sset-row").filter(has=quiet)).not_to_contain_text("UTC")
        # Without email too: no Email me too, no addresses, one line for both.
        stubbed = self.page("maria", viewport=PHONE)
        real = self.api(stubbed, "GET", "/api/v1/notification-preferences", status=200)
        real["email"]["available"] = False
        stubbed.route(re.compile(r".*/api/v1/notification-preferences$"), lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(real))
                      if route.request.method == "GET" else route.continue_())
        stubbed.goto("/settings/notifications")
        expect(stubbed.get_by_text("Push and email aren’t set up on this Flux server, so everything waits in your Inbox.")).to_be_visible()
        expect(stubbed.get_by_role("switch", name="Email me too")).to_have_count(0)
        expect(stubbed.get_by_text("Email addresses", exact=True)).to_have_count(0)
        expect(stubbed.get_by_role("radiogroup", name="Tell me about")).to_be_visible()
        shot(stubbed, f"763-notifications-no-channels-390-{UI_BROWSER}")

    # ---------------------------------------------------------------- touch targets (SG-4)

    def test_09_switches_and_settings_rows_are_44_px_on_a_touch_tablet(self) -> None:
        page = self.page("maria", viewport=TABLET, touch=True)
        page.goto("/settings/notifications")
        nav = page.get_by_role("navigation", name="Settings sections")
        for link in nav.get_by_role("link").all():
            box = link.bounding_box()
            self.assertGreaterEqual(box["height"], 44 - 0.001, f"{link.inner_text()}: {box}")
        for name in ("Email me too",):
            assert_touch_target(self, page, page.get_by_role("switch", name=name))
        for name in ("Change quiet hours", "Change muted places"):
            assert_touch_target(self, page, page.get_by_role("button", name=name))
        page.goto("/settings/appearance")
        assert_touch_target(self, page, page.get_by_role("switch", name="Show the face on loading and empty screens"))

    # ---------------------------------------------------------------- People (PE-1, PE-2)

    def test_10_the_company_has_one_place_in_settings(self) -> None:
        """F-037: Settings › Company replaces People: the company's name and its people with their roles, no AI switch."""
        page = self.page("maria")
        page.goto("/settings")
        nav = page.get_by_role("navigation", name="Settings sections")
        expect(nav.get_by_role("link").first).to_be_visible()
        self.assertEqual(nav.get_by_role("link").all_inner_texts()[:4], ["Account", "Appearance", "Notifications", "AI"])
        expect(nav.get_by_role("link", name="People")).to_have_count(0)
        nav.get_by_role("link", name="Company").click()
        expect(page).to_have_url(re.compile(r"/settings/company$"))
        expect(nav.get_by_role("link", name="Company")).to_have_attribute("aria-current", "page")
        expect(page.get_by_role("heading", name="Company", exact=True)).to_be_visible()
        expect(page.get_by_text("Everyone in Maria’s company works in this one Flux. Only admins can change this page.")).to_be_visible()
        expect(page.get_by_role("list", name="People in Maria’s company")).to_contain_text("Maria Nowak (you)")
        # The people come first; Invite opens the ways to add someone.
        page.get_by_role("button", name="Invite", exact=True).click()
        expect(page.get_by_role("region", name="Invite people")).to_be_visible()
        expect(page.get_by_text("Guests see only the spaces they’re added to and never have AI.")).to_be_visible()
        expect(page.get_by_role("button", name=re.compile("Turn (off|on) AI"))).to_have_count(0)
        expect(page.get_by_role("button", name="Back to Details")).to_have_count(0)
        # The owner renames the company in place.
        name = page.get_by_role("region", name="Name")
        name.get_by_role("button", name=re.compile("^Change")).click()
        name.get_by_label("Company name", exact=True).fill("Riverside Makers")
        name.get_by_role("button", name="Save name").click()
        expect(name).to_contain_text("Riverside Makers")
        shot(page, f"874-settings-company-1440-{UI_BROWSER}")
        # A member reads the company's people and cannot add anyone or rename it.
        self.sign_up("olek", "Olek Member")
        self.api(page, "POST", f"/api/v1/workspaces/{self.ids['maria:space']}/members", {"email": self.ids["olek:email"], "role": "member"}, status=201)
        olek = self.page("olek")
        olek.goto("/settings/company")
        expect(olek.get_by_role("list", name="People in Riverside Makers")).to_contain_text("Maria Nowak")
        expect(olek.get_by_role("button", name="Invite", exact=True)).to_have_count(0)
        expect(olek.get_by_role("region", name="Name").get_by_role("button", name=re.compile("^Change"))).to_have_count(0)
        expect(olek.get_by_text("Only owners and admins add people or change roles in Riverside Makers.")).to_be_visible()
        # The account menu holds no People any more; on the phone Settings lists Company.
        phone = self.page("maria", viewport=PHONE)
        phone.goto("/settings")
        phone.get_by_role("link", name=re.compile("^Company")).click()
        expect(phone).to_have_url(re.compile(r"/settings/company$"))
        self.assertLessEqual(phone.evaluate("document.documentElement.scrollWidth"), PHONE["width"])

    def test_11_someone_new_gets_an_invite_link_with_their_address(self) -> None:
        """#763 PE-2 / F-035, #1438: one form; an address Flux cannot find makes an invite link locked to it, at once."""
        page = self.page("maria")
        page.goto("/settings/company?invite=1")
        invite = page.get_by_role("region", name="Invite people")
        newcomer = f"piotr.new+{STAMP}@example.test"
        invite.get_by_label("Email (optional)").fill(newcomer)
        invite.get_by_role("button", name="Create invite link").click()
        field = invite.get_by_role("group", name="New invite link").get_by_role("textbox")
        expect(field).to_have_value(re.compile(f"^{re.escape(ORIGIN)}/join#[A-Za-z0-9_-]{{54}}$"))
        expect(invite.get_by_role("list", name=re.compile("^Waiting to be used"))).to_contain_text(newcomer)
        shot(page, f"874-company-invite-link-1440-{UI_BROWSER}")
        # The link opens the join page; Piotr creates his account there and joins as a member.
        stranger = self.page()
        stranger.goto(field.input_value())
        # #1438: the invite page is the create-account form; joining lands in the space everyone reads, or Home.
        stranger.get_by_label("Name").fill("Piotr Nowy")
        # #1471: the link is for his address, so the form has it filled in and locked.
        expect(stranger.get_by_label("Email")).to_have_value(newcomer)
        expect(stranger.get_by_label("Email")).not_to_be_editable()
        stranger.get_by_label("Password").fill(PASSWORD)
        stranger.get_by_role("button", name="Create account and join").click()
        expect(stranger).not_to_have_url(re.compile(r"/join"))
        expect(stranger.get_by_role("heading", level=1, name="You joined Riverside Makers")).to_have_count(0)
        expect(page.get_by_role("list", name="People in Riverside Makers")).to_contain_text("Piotr Nowy")

    # ---------------------------------------------------------------- mention chips (PE-4)

    def test_11_an_admin_lists_every_space_and_restores_someone_removed(self) -> None:
        """Hubert, 2026-11-05: the sidebar holds a company admin's own spaces; Settings › Company holds every space and Restore."""
        space = self.ids["maria:space"]
        self.sign_up("wera", "Wera Removed")
        page = self.page("maria")
        self.api(page, "POST", f"/api/v1/workspaces/{space}/members", {"email": self.ids["wera:email"], "role": "member"}, status=201)
        wera = self.page("wera")
        hers = self.api(wera, "POST", f"/api/v1/workspaces/{space}/projects", {"name": "Wera’s corner"}, status=201)
        page.goto("/settings/company")
        sidebar = page.get_by_role("navigation", name="Spaces")
        expect(sidebar.get_by_role("link", name=re.compile("Wera’s corner"))).to_have_count(0)
        every = page.get_by_role("list", name="Every space in the company")
        expect(every).to_contain_text("Wera’s corner")
        every.get_by_role("button", name="Add me to Wera’s corner").click()
        expect(sidebar.get_by_role("link", name=re.compile("Wera’s corner"))).to_be_visible()
        expect(every.get_by_role("button", name="Add me to Wera’s corner")).to_have_count(0)
        # Add me makes the company admin the space's admin (#903), so the space has an admin besides its creator.
        added = next(grant for grant in self.api(page, "GET", f"/api/v1/projects/{hers['id']}/grants", status=200) if grant["principal"]["id"] == self.ids["maria"])
        self.assertEqual(added["role"], "manager")
        # A company admin opens a space from a link without belonging to it (F-037: they can change any space).
        left = page.request.delete(f"{ORIGIN}/api/v1/projects/{hers['id']}/grants/{self.grant_of(page, hers['id'], 'maria')}", headers={"origin": ORIGIN})
        self.assertEqual(left.status, 204, left.text())
        page.goto(f"/projects/{hers['id']}")
        expect(page.get_by_role("heading", level=1, name="Wera’s corner")).to_be_visible()
        expect(page.get_by_role("navigation", name="Spaces").get_by_role("link", name=re.compile("Wera’s corner"))).to_have_count(0)
        # Removed, then restored: back in the company's list, and the space stays out until it is added by hand.
        removed_now = page.request.delete(f"{ORIGIN}/api/v1/workspaces/{space}/members/{self.ids['wera']}", headers={"origin": ORIGIN})
        self.assertEqual(removed_now.status, 204, removed_now.text())
        page.goto("/settings/company")
        removed = page.get_by_role("list", name="People who were removed")
        expect(removed).to_contain_text("Wera Removed")
        removed.get_by_role("button", name="Restore").click()
        expect(page.get_by_role("list", name=re.compile("^People in "))).to_contain_text("Wera Removed")
        expect(page.get_by_role("list", name="People who were removed")).to_have_count(0)
        shot(page, f"874-company-every-space-1440-{UI_BROWSER}")

    def test_11b_the_sign_in_page_names_the_company(self) -> None:
        """The guide: the company's name is on the sign-in page, and the name setup gave it says nothing."""
        fresh = self.page()
        fresh.goto("/sign-in")
        expect(fresh.get_by_role("heading", level=1, name="Sign in")).to_be_visible()
        expect(fresh.locator(".auth__company")).to_have_count(0)
        owner = self.page()
        owner.request.post(f"{ORIGIN}/api/auth/sign-in/email", headers={"origin": ORIGIN, "content-type": "application/json"},
                           data=json.dumps({"email": "company-setup@example.test", "password": "company setup for the checks"}))
        company = next(item for item in self.workspaces(owner) if item.get("company"))
        self.api(owner, "PATCH", f"/api/v1/workspaces/{company['id']}", {"name": "Riverside Makers"}, status=200)
        self.addCleanup(lambda: self.api(owner, "PATCH", f"/api/v1/workspaces/{company['id']}", {"name": "Company"}, status=200))
        fresh.reload()
        expect(fresh.locator(".auth__company")).to_have_text("Riverside Makers")
        expect(fresh.get_by_role("heading", level=1, name="Sign in")).to_be_visible()

    def test_11c_an_admin_outside_a_space_is_told_her_assistant_works_only_where_she_is_and_adds_herself(self) -> None:
        """#955, C-15: she can open the space, but her assistant has no access there; the ask bar says so (not "you can't open this space")
        and offers Add me, the step Settings › Company has."""
        olek = self.page("olek")
        room = self.api(olek, "POST", f"/api/v1/workspaces/{self.ids['maria:space']}/projects", {"name": "Olek’s room"}, status=201)
        talk = self.api(olek, "POST", f"/api/v1/projects/{room['id']}/conversations", {"body": "Where do the boards go?", "clientMessageId": str(uuid.uuid4())}, status=201)
        page = self.page("maria")
        page.goto(f"/projects/{room['id']}/conversations/{talk['id']}")
        expect(page.get_by_role("heading", level=1, name="Olek’s room")).to_be_visible()
        sidebar = page.get_by_role("navigation", name="Spaces")
        expect(sidebar.get_by_role("link", name=re.compile("Olek’s room"))).to_have_count(0)
        # She is not one of the people it was added to, so its people line does not call her "you" (#1110).
        expect(page.locator("header.top .top__audience")).to_have_attribute("title", re.compile(r"^Olek"))
        expect(page.locator("header.top .top__audience")).not_to_have_attribute("title", re.compile(r"\byou\b", re.I))
        page.locator("#thread-composer").fill("/ai What changed here?")
        ask = page.locator("#project-ask")
        expect(ask).to_contain_text("Your assistant works only in spaces you’re in.")
        expect(ask).not_to_contain_text("any more")
        shot(page, f"955-ask-outside-1440-{UI_BROWSER}")
        # A double press is one request (#968): the second would only meet "already added" and say it could not add her.
        added: list[str] = []
        page.on("request", lambda request: added.append(request.url) if request.method == "POST" and request.url.endswith("/grants") else None)
        ask.get_by_role("button", name="Add me").dblclick()
        expect(sidebar.get_by_role("link", name=re.compile("Olek’s room"))).to_be_visible()
        expect(ask).not_to_contain_text("couldn’t be added")
        self.assertEqual(len(added), 1, f"one request for a double press: {added}")
        expect(ask).not_to_contain_text("works only in spaces you’re in")
        expect(ask).not_to_contain_text("Add me")  # what the ask bar says next depends on whether she has an agent: it no longer says she cannot be here

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
