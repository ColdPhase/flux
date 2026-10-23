"""Browser tests for the workspace AI lock's human-only interface (F-029, issue #614, slice S3, AC-4).

Runs with the other tests/ui modules through scripts/check_ui.sh; FLUX_UI_BROWSER picks chromium (default) or webkit.
Four people and two workspaces: Ada owns Garden club (A) with Lee as admin and Kai as member; Ben owns Harbour Studio (B)
and Ada is a member there. Each workspace has an agent, a project with a conversation and an assistant that is "ready" for
Ada (stubbed status). In both a computer window (1440 × 900) and a 390 × 844 touch phone:

* the admin turns AI off and on in the workspace's People panel; the row, its button and its confirm do not move, the
  confirm works by keyboard, the state survives a reload, a version conflict and a refusal say what happened;
* a member sees no switch, and one read-only line while AI is off;
* while AI is off in A there is no `[data-ai-surface]` in A's project, its composer menus, its message menu or ⌘K, there is
  no Agents view and nothing to add it, no request is refused with `WORKSPACE_AI_BLOCKED` (nothing AI was asked), and in B
  (the control) the same places show their AI surfaces;
* direct links to A's Agents view (and an agent's thread) show the calm blocked state, Settings says where AI is off;
* conversation, tasks, map, wiki, files and search keep working for two people in A;
* a second open tab follows the change from the stream, without a reload.

Screenshots (workspace-ai-*-<browser>.png) go to FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, Route, expect, sync_playwright

from project_views import project_views
from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, open_details, shot as save_shot, start_forwarder

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")

PASSWORD = "the lock keeps the humans calm"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.lock+{STAMP}@example.test"),
    "ben": ("Ben Okafor", f"ben.lock+{STAMP}@example.test"),
    "lee": ("Lee Moreno", f"lee.lock+{STAMP}@example.test"),
    "kai": ("Kai Tanaka", f"kai.lock+{STAMP}@example.test"),
}
A_NAME, B_NAME = "Garden club", "Harbour Studio"
A_PROJECT, B_PROJECT = "Seed tray", "Dock lights"
A_ROOT, B_ROOT = "Order the spring seeds", "Replace the dock lights"
A_AGENT, B_AGENT = "Sprout", "Beacon"
OFF_LINE = re.compile(r"^Off · turned off by Ada Kowalska on \d{1,2} \w{3}\. No agent or assistant can read or change anything here\.$")
ON_LINE = "On · agents and assistants can work here."
NOW = "2026-10-22T10:00:00.000Z"


def shot(page: Page, name: str) -> None:
    save_shot(page, f"workspace-ai-{name}-{UI_BROWSER}")


class WorkspaceAiLock(unittest.TestCase):
    """Tests run in name order and share the accounts, the workspaces and A's AI state (see each test's first line)."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

    # ---------------------------------------------------------------- fixture

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            context.close()
        ada, ben = (cls.browser.new_context(base_url=ORIGIN, storage_state=cls.states[who]) for who in ("ada", "ben"))
        try:
            def call(context: BrowserContext, method: str, path: str, body: dict | None = None, status: int = 201) -> dict:
                response = context.request.fetch(path, method=method, data=json.dumps(body) if body is not None else None,
                                                 headers={"origin": ORIGIN, "content-type": "application/json"})
                assert response.status == status, f"{method} {path}: {response.status} {response.text()}"
                return response.json() if response.text() else {}

            a = call(ada, "POST", "/api/v1/workspaces", {"name": A_NAME})
            b = call(ben, "POST", "/api/v1/workspaces", {"name": B_NAME})
            call(ada, "POST", f"/api/v1/workspaces/{a['id']}/members", {"email": PEOPLE["lee"][1], "role": "admin"})
            call(ada, "POST", f"/api/v1/workspaces/{a['id']}/members", {"email": PEOPLE["kai"][1], "role": "member"})
            call(ben, "POST", f"/api/v1/workspaces/{b['id']}/members", {"email": PEOPLE["ada"][1], "role": "member"})
            cls.ids.update(a=a["id"], b=b["id"])
            for key, owner, workspace, name, project_name, root in (("a", ada, a, A_AGENT, A_PROJECT, A_ROOT), ("b", ben, b, B_AGENT, B_PROJECT, B_ROOT)):
                project = call(owner, "POST", f"/api/v1/workspaces/{workspace['id']}/projects", {"name": project_name, "visibility": "workspace"})
                agent = call(owner, "POST", f"/api/v1/workspaces/{workspace['id']}/agents", {"name": name, "owner": "self"})
                call(owner, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "agent", "id": agent["id"]}, "role": "contributor"})
                conversation = call(owner, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": root, "clientMessageId": str(uuid.uuid4())})
                work = call(owner, "POST", f"/api/v1/projects/{project['id']}/work", {"title": f"Check {project_name.lower()} wiring"})
                cls.ids.update({f"{key}_project": project["id"], f"{key}_agent": agent["id"], f"{key}_conversation": conversation["id"], f"{key}_work": work["id"]})
        finally:
            ada.close()
            ben.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    # ---------------------------------------------------------------- helpers

    def context(self, who: str, *, phone: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who],
                         # A service worker's own requests are not seen by page.route in every engine: the stubs below need to see them.
                         "service_workers": "block"}
        options.update(viewport=PHONE, device_scale_factor=2, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context

    def page(self, who: str, *, phone: bool = False, ready: bool = False) -> Page:
        """A page for `who`; `ready` stubs Ada's assistant as set up and ready (the runtime itself is not under test)."""
        page = self.context(who, phone=phone).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        refused: list[str] = []
        page.on("response", lambda response: refused.append(f"{response.status} {response.url}") if response.status == 403 else None)
        page.refused = refused  # type: ignore[attr-defined]
        if ready:
            self.stub_ready(page, who)
        return page

    def stub_ready(self, page: Page, who: str) -> None:
        real = page.request.get("/api/v1/personal-assistant").json()
        agents = [{"workspaceId": self.ids["a"], "agentId": self.ids["a_agent"]}, {"workspaceId": self.ids["b"], "agentId": self.ids["b_agent"]}]
        stub = {**real, "state": "ready", "unavailableReason": None, "today": {"chargedMicros": 0, "reservedMicros": 0, "capCents": 100, "resetsAt": NOW},
                "setup": {"provider": "off", "connection": "none", "runtime": {"state": "signed_in", "payer": "claude_plan", "accountLabel": "a***@example.test", "client": "claude_code"}},
                "enablement": {"ownerUserId": self.ids[who], "connectionId": None, "engine": "runtime", "status": "active", "perRunCents": 6, "dailyCapCents": 100, "timeZone": "UTC",
                               "consent": {"version": "f-022-runtime-2026-10-16", "acceptedAt": NOW, "provider": "anthropic", "model": "claude-code",
                                           "payer": {"organization": "Your Claude plan", "workspace": "a***@example.test"}},
                               "agents": agents, "version": 1, "createdAt": NOW, "updatedAt": NOW}}

        def status(route: Route) -> None:
            if route.request.method == "GET":
                page.stubbed = getattr(page, "stubbed", 0) + 1  # type: ignore[attr-defined]
                route.fulfill(status=200, content_type="application/json", body=json.dumps(stub))
            else:
                route.continue_()
        page.route("**/api/v1/personal-assistant", status)

    def api(self, page: Page, method: str, path: str, body: dict | None = None, *, status: int | None = 200, headers: dict | None = None) -> dict:
        response = page.request.fetch(path, method=method, data=json.dumps(body) if body is not None else None,
                                      headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})})
        if status is not None:
            self.assertEqual(response.status, status, f"{method} {path}: {response.text()}")
        return response.json() if response.text() else {}

    def ai_state(self, page: Page, workspace: str = "a") -> dict:
        return self.api(page, "GET", f"/api/v1/workspaces/{self.ids[workspace]}")["ai"]

    def set_ai(self, page: Page, state: str, workspace: str = "a") -> None:
        """The same command as the switch, from a test that is not exercising the switch: it keeps this test's start state."""
        current = self.ai_state(page, workspace)
        if current["state"] != state:
            self.api(page, "PUT", f"/api/v1/workspaces/{self.ids[workspace]}/ai-policy", {"state": state}, headers={"if-match": f'"{current["version"]}"', "idempotency-key": str(uuid.uuid4())})

    def open_people(self, page: Page, workspace: str) -> None:
        """Home → Details → People → the workspace, as a person finds it."""
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        open_details(page)
        page.get_by_role("region", name="People").get_by_role("button", name=re.compile(f"^{workspace}")).click()
        expect(page.get_by_role("heading", name="People", exact=True)).to_be_visible()
        expect(page.locator(".details__eyebrow", has_text=workspace)).to_be_visible()

    def ai_row(self, page: Page, workspace: str = A_NAME):
        return page.get_by_role("region", name=f"AI in {workspace}")

    def geometry(self, page: Page) -> dict:
        """Where the AI row's heading and button are, in the page: they must not move with the state."""
        row = self.ai_row(page)
        button = row.get_by_role("button", name=re.compile(r"^Turn o(n|ff) AI$")).first
        heading = row.get_by_role("heading")
        # In the panel's own coordinates, so the panel being scrolled by a click or by focus does not count as the control moving.
        measure = """el => {
          const body = el.closest('.ui-panel__body') || document.documentElement;
          const r = el.getBoundingClientRect(), b = body.getBoundingClientRect();
          return {x: r.left - b.left, y: r.top - b.top + body.scrollTop, width: r.width, height: r.height};
        }"""
        return {"button": button.evaluate(measure), "heading": heading.evaluate(measure)}

    def same_place(self, before: dict, after: dict) -> None:
        for name in ("button", "heading"):
            for edge in ("x", "y", "width", "height"):
                self.assertAlmostEqual(before[name][edge], after[name][edge], delta=0.6, msg=f"{name}.{edge} stays: {before[name]} → {after[name]}")

    def open_jump(self, page: Page, phone: bool) -> None:
        if phone:
            page.get_by_role("button", name="Search").first.click()
        else:
            page.keyboard.press("Control+k")
        expect(page.get_by_role("combobox", name="Jump to")).to_be_visible()

    def markers(self, page: Page) -> int:
        return page.locator("[data-ai-surface]").count()

    def project_page(self, page: Page, key: str) -> None:
        page.goto(f"/projects/{self.ids[f'{key}_project']}")
        expect(page.get_by_text(A_ROOT if key == "a" else B_ROOT).first).to_be_visible()

    def views(self, page: Page) -> list[str]:
        """The names of the project's views, as the header or the phone's title menu list them."""
        links = project_views(page).get_by_role("link")
        names = [text.strip().split("\n")[0] for text in links.all_inner_texts()]
        if page.viewport_size["width"] <= 900:
            page.keyboard.press("Escape")
        return names

    def wait_for_agents_view(self, page: Page, present: bool) -> None:
        """The Agents view appears or goes (from the stream, with no reload) within a few seconds."""
        for _ in range(30):
            if ("Agents" in self.views(page)) == present:
                return
            page.wait_for_timeout(500)
        self.assertEqual("Agents" in self.views(page), present, "the open tab followed the change")

    def composer_actions(self, page: Page, composer: str, trigger: str) -> list[str]:
        field = page.locator(composer)
        field.click()
        field.fill(trigger)
        menu = page.get_by_role("listbox", name="Actions" if trigger == "/" else "Mention")
        expect(menu).to_be_visible()
        names = [text.strip().split("\n")[0] for text in menu.get_by_role("option").all_inner_texts()]
        self.open_markers = self.markers(page)
        field.fill("")
        return names

    def message_menu_items(self, page: Page, phone: bool, text: str) -> list[str]:
        row = page.locator("li", has=page.get_by_text(text, exact=True)).first
        if phone:
            row.get_by_role("button", name="Message actions").focus()
            page.keyboard.press("Enter")
        else:
            row.hover()
            row.get_by_role("button", name="More actions").click()
        menu = page.get_by_role("menu", name="Message actions")
        expect(menu).to_be_visible()
        names = [text.strip() for text in menu.get_by_role("menuitem").all_inner_texts()]
        page.keyboard.press("Escape")
        expect(menu).to_have_count(0)
        return names

    # ---------------------------------------------------------------- AC-4: the control, then the switch

    def test_01_the_control_ai_is_on_and_shows_its_surfaces_in_both_workspaces(self) -> None:
        self.set_ai(self.page("ada"), "allowed")
        for phone in (False, True):
            with self.subTest(phone=phone):
                for key in ("a", "b"):
                    page = self.page("ada", phone=phone, ready=True)
                    self.project_page(page, key)
                    self.assertIn("Agents", self.views(page), f"{key}: the Agents view is offered while AI is on")
                    self.assertIn("/handoff", self.composer_actions(page, "#project-composer", "/"))
                    self.assertTrue(any(A_AGENT in name or B_AGENT in name for name in self.composer_actions(page, "#project-composer", "@")))
                    self.assertIn("Hand off to an agent", self.message_menu_items(page, phone, A_ROOT if key == "a" else B_ROOT))
                    self.open_jump(page, phone)
                    page.get_by_role("combobox", name="Jump to").fill("ask")
                    try:
                        expect(page.get_by_role("option", name=re.compile("Ask my assistant"))).to_be_visible()
                    except AssertionError:
                        raise AssertionError(f"stub hit {getattr(page, 'stubbed', 0)} times; list: {page.get_by_role('listbox').all_inner_texts()}; markers {self.markers(page)}") from None
                    self.assertGreater(self.markers(page), 0, f"{key}: AI surfaces are marked while AI is on")
                    self.assertEqual(page.refused, [])

    def test_02_members_see_no_switch_while_ai_is_on(self) -> None:
        for who in ("kai",):
            for phone in (False, True):
                with self.subTest(who=who, phone=phone):
                    page = self.page(who, phone=phone)
                    self.open_people(page, A_NAME)
                    expect(page.get_by_role("region", name=f"AI in {A_NAME}")).to_have_count(0)
                    expect(page.get_by_text("AI is off in")).to_have_count(0)
                    expect(page.get_by_role("button", name=re.compile(r"Turn o(n|ff) AI"))).to_have_count(0)

    def test_03_an_admin_turns_ai_off_and_on_and_the_control_never_moves(self) -> None:
        self.set_ai(self.page("ada"), "allowed")
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page("ada", phone=phone)
                self.open_people(page, A_NAME)
                row = self.ai_row(page)
                heading = row.get_by_role("heading", name=f"AI in {A_NAME}")
                expect(heading).to_be_visible()
                expect(row.locator(".people__ai-line")).to_have_text(ON_LINE)
                # After the people list, before Leave.
                roster, leave = page.get_by_role("list", name=f"People in {A_NAME}"), page.get_by_role("region", name=f"Leave {A_NAME}")
                self.assertGreater(heading.bounding_box()["y"], roster.bounding_box()["y"] + roster.bounding_box()["height"] - 1)
                self.assertLess(heading.bounding_box()["y"], leave.bounding_box()["y"])
                on_place = self.geometry(page)
                trigger = row.get_by_role("button", name="Turn off AI", exact=True)
                shot(page, f"row-on-{'phone' if phone else 'desktop'}")

                # The confirm works by keyboard: Enter opens it and moves into it, Esc closes it and returns to the button.
                trigger.focus()
                page.keyboard.press("Enter")
                confirm = row.get_by_role("group", name=f"Turn off AI in {A_NAME}")
                expect(confirm).to_contain_text("No agent or assistant, including each person’s own, can read or change anything in Garden club. Work they are doing now stops and is not posted. Nothing is deleted.")
                expect(confirm.get_by_role("button", name="Turn off AI")).to_be_focused()
                expect(confirm.get_by_role("button", name="Keep AI on")).to_be_visible()
                shot(page, f"confirm-off-{'phone' if phone else 'desktop'}")
                self.same_place(on_place, self.geometry(page))
                page.keyboard.press("Escape")
                expect(confirm).to_have_count(0)
                expect(trigger).to_be_focused()
                self.assertEqual(self.ai_state(page)["state"], "allowed", "Esc changed nothing")
                page.keyboard.press("Enter")
                page.keyboard.press("Tab")
                expect(confirm.get_by_role("button", name="Keep AI on")).to_be_focused()
                page.keyboard.press("Enter")
                expect(confirm).to_have_count(0)
                expect(trigger).to_be_focused()
                self.assertEqual(self.ai_state(page)["state"], "allowed", "Keep AI on changed nothing")

                # Turn it off.
                trigger.click()
                confirm.get_by_role("button", name="Turn off AI").click()
                expect(row.locator(".people__ai-line")).to_have_text(OFF_LINE)
                expect(row.get_by_role("button", name="Turn on AI", exact=True)).to_be_visible()
                expect(row.get_by_role("status")).to_have_text(re.compile(r"^AI is off in Garden club\.( \d+ runs? stopped\.)?$"))
                expect(confirm).to_have_count(0)
                expect(row.get_by_role("button", name="Turn on AI", exact=True)).to_be_focused()
                off_place = self.geometry(page)
                self.same_place(on_place, off_place)
                shot(page, f"row-off-{'phone' if phone else 'desktop'}")
                state = self.ai_state(page)
                self.assertEqual(state["state"], "blocked")
                self.assertEqual(state["changedBy"]["id"], self.ids["ada"])

                # The state is the server's: a reload shows it in the same place.
                page.reload()
                self.open_people(page, A_NAME)
                expect(self.ai_row(page).locator(".people__ai-line")).to_have_text(OFF_LINE)
                self.same_place(on_place, self.geometry(page))

                # Turn it back on: its own words, the same place.
                row = self.ai_row(page)
                row.get_by_role("button", name="Turn on AI", exact=True).click()
                confirm = row.get_by_role("group", name=f"Turn on AI in {A_NAME}")
                expect(confirm).to_contain_text("People’s assistants and connected agents can work here again, with the access they had. Nothing that was stopped starts again.")
                expect(confirm.get_by_role("button", name="Keep AI off")).to_be_visible()
                self.same_place(on_place, self.geometry(page))
                confirm.get_by_role("button", name="Turn on AI").click()
                expect(row.locator(".people__ai-line")).to_have_text(ON_LINE)
                expect(row.get_by_role("status")).to_have_text("AI is on in Garden club.")
                self.same_place(on_place, self.geometry(page))
                self.assertEqual(self.ai_state(page)["state"], "allowed")
                self.assertEqual(page.refused, [])

    def test_04_a_version_conflict_and_a_refusal_say_what_happened(self) -> None:
        self.set_ai(self.page("ada"), "allowed")
        page = self.page("lee")
        self.open_people(page, A_NAME)
        row = self.ai_row(page)
        expect(row.locator(".people__ai-line")).to_have_text(ON_LINE)
        # The admin's request carries an old version, as after a change by someone else a moment ago.
        page.route(f"**/api/v1/workspaces/{self.ids['a']}/ai-policy", self.stale)
        row.get_by_role("button", name="Turn off AI", exact=True).click()
        row.get_by_role("group", name=f"Turn off AI in {A_NAME}").get_by_role("button", name="Turn off AI").click()
        expect(row.get_by_role("alert")).to_have_text("Someone changed this just now.")
        expect(row.get_by_role("group")).to_have_count(0)
        self.assertEqual(self.ai_state(page)["state"], "allowed", "the stale request changed nothing")
        page.unroute(f"**/api/v1/workspaces/{self.ids['a']}/ai-policy")

        # A request the server refuses for the caller's role says so in the panel's words.
        page.route(f"**/api/v1/workspaces/{self.ids['a']}/ai-policy", lambda route: route.fulfill(
            status=403, content_type="application/json", body=json.dumps({"error": "Only workspace owners and admins can turn AI on or off", "code": "WORKSPACE_AI_ADMIN_REQUIRED"})))
        row.get_by_role("button", name="Turn off AI", exact=True).click()
        row.get_by_role("group", name=f"Turn off AI in {A_NAME}").get_by_role("button", name="Turn off AI").click()
        expect(row.get_by_role("alert")).to_have_text("Only owners and admins can change this.")
        self.assertEqual(self.ai_state(page)["state"], "allowed")

    def stale(self, route: Route) -> None:
        """The request goes out with an old version (fetched here, so every engine sends the changed header)."""
        route.fulfill(response=route.fetch(headers={**route.request.headers, "if-match": '"999"'}))

    # ---------------------------------------------------------------- AC-4: while AI is off in A

    def test_05_members_and_admins_see_the_state_while_ai_is_off(self) -> None:
        self.set_ai(self.page("ada"), "blocked")
        for phone in (False, True):
            with self.subTest(phone=phone):
                kai = self.page("kai", phone=phone)
                self.open_people(kai, A_NAME)
                row = kai.get_by_role("region", name=f"AI in {A_NAME}")
                expect(row).to_have_text(f"AI is off in {A_NAME}. Its owners and admins turned it off.")
                expect(kai.get_by_role("button", name=re.compile(r"Turn o(n|ff) AI"))).to_have_count(0)
                shot(kai, f"member-line-{'phone' if phone else 'desktop'}")
                lee = self.page("lee", phone=phone)
                self.open_people(lee, A_NAME)
                expect(self.ai_row(lee).locator(".people__ai-line")).to_have_text(OFF_LINE)
                expect(self.ai_row(lee).get_by_role("button", name="Turn on AI", exact=True)).to_be_visible()

    def test_06_no_ai_surface_in_the_blocked_workspace_and_all_of_them_in_the_other(self) -> None:
        self.set_ai(self.page("ada"), "blocked")
        for phone in (False, True):
            with self.subTest(phone=phone):
                # The control, in the workspace whose AI is on.
                page = self.page("ada", phone=phone, ready=True)
                self.project_page(page, "b")
                self.assertIn("Agents", self.views(page))
                self.assertIn("/handoff", self.composer_actions(page, "#project-composer", "/"))
                self.assertGreater(self.open_markers, 0, "the composer's AI commands are marked")
                self.assertEqual(page.refused, [])

                # The blocked one: the same steps find none of it.
                page = self.page("ada", phone=phone, ready=True)
                self.project_page(page, "a")
                self.assertNotIn("Agents", self.views(page), "no Agents view")
                if not phone:
                    page.get_by_role("button", name="More", exact=True).click()
                    self.assertEqual(page.get_by_role("menuitem", name="Add Agents").count(), 0)
                    page.keyboard.press("Escape")
                actions = self.composer_actions(page, "#project-composer", "/")
                self.assertNotIn("/handoff", actions)
                self.assertNotIn("/ai", actions)
                self.assertIn("/task", actions)
                self.assertEqual(self.open_markers, 0, "no AI command is marked in the composer's menu")
                mentions = self.composer_actions(page, "#project-composer", "@")
                self.assertFalse(any(A_AGENT in name for name in mentions), mentions)
                self.assertNotIn("Hand off to an agent", self.message_menu_items(page, phone, A_ROOT))
                page.goto(f"/projects/{self.ids['a_project']}/conversations/{self.ids['a_conversation']}")
                thread = page.locator("#thread-composer")
                expect(thread).to_be_visible()
                self.assertNotIn("/ai", self.composer_actions(page, "#thread-composer", "/"))
                # A typed command is not sent as a message to the people here: the words stay, with a hint.
                before = len(self.api(page, "GET", f"/api/v1/projects/{self.ids['a_project']}/conversations?limit=50")["items"])
                for command in ("/handoff calibrate the probes", "/ai tidy the tasks"):
                    field = page.locator("#thread-composer")
                    field.fill(command)
                    page.get_by_role("button", name="Send reply").click()
                    expect(page.get_by_role("status").filter(has_text="AI is off in this workspace")).to_be_visible()
                    expect(field).to_have_value(command)
                after = self.api(page, "GET", f"/api/v1/conversations/{self.ids['a_conversation']}")
                self.assertNotIn("calibrate the probes", json.dumps(after))
                self.assertNotIn("tidy the tasks", json.dumps(after))
                self.assertEqual(len(self.api(page, "GET", f"/api/v1/projects/{self.ids['a_project']}/conversations?limit=50")["items"]), before)
                field.fill("")
                thread.fill("/ai tidy the tasks")
                expect(page.locator("#project-ask")).to_have_count(0)
                thread.fill("")
                self.project_page(page, "a")
                self.open_jump(page, phone)
                jump = page.get_by_role("combobox", name="Jump to")
                jump.fill("ask")
                expect(page.get_by_role("option", name=re.compile("Ask my assistant"))).to_have_count(0)
                jump.fill("@" + A_AGENT[:3])
                expect(page.get_by_role("option", name=re.compile(A_AGENT))).to_have_count(0)
                self.assertEqual(self.markers(page), 0, "no AI surface is marked in a blocked workspace")
                self.assertEqual(page.refused, [], "nothing AI was asked of the server")

                # Tasks and its details: no hand-off, no agent owner.
                page.goto(f"/projects/{self.ids['a_project']}/tasks?open=work:{self.ids['a_work']}")
                panel = page.get_by_role("complementary", name="Details").or_(page.get_by_role("dialog", name="Details"))
                expect(panel.get_by_text(f"Check {A_PROJECT.lower()} wiring").first).to_be_visible()
                expect(panel.get_by_role("button", name="Hand off to an agent")).to_have_count(0)
                expect(panel.get_by_role("link", name=re.compile("^Agents’ thread"))).to_have_count(0)
                self.assertEqual(self.markers(page), 0)
                self.assertEqual(page.refused, [])
                shot(page, f"project-human-only-{'phone' if phone else 'desktop'}")

    def test_07_direct_links_show_one_calm_blocked_state_and_launch_nothing(self) -> None:
        self.set_ai(self.page("ada"), "blocked")
        links = [f"/projects/{self.ids['a_project']}/agents", f"/projects/{self.ids['a_project']}/agents?thread={self.ids['a_work']}",
                 f"/projects/{self.ids['a_project']}/agents?task={self.ids['a_work']}"]
        for phone in (False, True):
            for link in links:
                with self.subTest(phone=phone, link=link):
                    page = self.page("ada", phone=phone, ready=True)
                    page.goto("/")
                    page.goto(link)
                    blocked = page.locator("[data-ai-off]")
                    expect(blocked.get_by_role("heading", name=f"AI is off in {A_NAME}")).to_be_visible()
                    expect(blocked).to_contain_text("Its admins turned off agents and assistants here. Everything else works as usual.")
                    self.assertTrue(page.url.endswith(link), "the address is not rewritten")
                    self.assertEqual(self.markers(page), 0)
                    self.assertEqual(page.refused, [], "no AI request was made")
                    expect(blocked.get_by_role("button", name="People")).to_be_visible()
                    # It sits inside the pane's gutter, never flush with the sidebar or the screen edge.
                    pane = page.locator("#content").bounding_box()
                    for part in (blocked.get_by_role("heading"), blocked.get_by_text("Its admins turned off"), blocked.get_by_role("link", name="Back to the conversation")):
                        self.assertGreaterEqual(part.bounding_box()["x"] - pane["x"], 16, "the blocked state has the pane's gutter")
                        self.assertLessEqual(part.bounding_box()["x"] + part.bounding_box()["width"], pane["x"] + pane["width"] - 16)
                    if phone:
                        expect(page.locator("header .phead__sub")).not_to_contain_text("Agents")
                    shot(page, f"blocked-state-{'phone' if phone else 'desktop'}")
            # Back goes to the conversation; People opens the workspace's People panel.
            page = self.page("ada", phone=phone)
            page.goto(links[0])
            page.get_by_role("link", name="Back to the conversation").click()
            expect(page).to_have_url(re.compile(rf"/projects/{self.ids['a_project']}$"))
            page.go_back()
            expect(page.locator("[data-ai-off]")).to_be_visible()
            page.locator("[data-ai-off]").get_by_role("button", name="People").click()
            expect(page.get_by_role("heading", name="People", exact=True)).to_be_visible()
            expect(self.ai_row(page).locator(".people__ai-line")).to_have_text(OFF_LINE)
            # A member gets the state and the way back, but no People.
            kai = self.page("kai", phone=phone)
            kai.goto(links[0])
            expect(kai.locator("[data-ai-off]").get_by_role("heading", name=f"AI is off in {A_NAME}")).to_be_visible()
            expect(kai.locator("[data-ai-off]").get_by_role("button", name="People")).to_have_count(0)
            expect(kai.locator("[data-ai-off]").get_by_role("link", name="Back to the conversation")).to_be_visible()

    def test_08_settings_and_connect_say_where_ai_is_off(self) -> None:
        self.set_ai(self.page("ada"), "blocked")
        for phone in (False, True):
            with self.subTest(phone=phone):
                # Ada has another workspace with AI on: the page stays, and says once where it is off.
                page = self.page("ada", phone=phone, ready=True)
                page.goto("/settings/agents")
                expect(page.get_by_role("heading", name="Agents and AI").first).to_be_visible()
                expect(page.get_by_text(f"Not in {A_NAME}: AI is off there.")).to_have_count(2)
                expect(page.get_by_role("link", name="Set up").or_(page.get_by_role("link", name="Manage")).first).to_be_visible()
                # The project picker of the rules offers only projects whose workspace has AI on.
                page.goto("/settings/background-compute")
                picker = page.get_by_label("Project", exact=True)
                expect(picker.locator("option", has_text=B_PROJECT)).to_have_count(1)
                expect(picker.locator("option", has_text=A_PROJECT)).to_have_count(0)
                page.goto("/connect-agent")
                expect(page.locator("[data-ai-off]")).to_contain_text(f"AI is off in {A_NAME}.")
                self.assertEqual(page.refused, [])
                # Lee is only in A: the page shows only where AI is off and how to turn it back on.
                lee = self.page("lee", phone=phone)
                lee.goto("/settings/agents")
                off = lee.locator("[data-ai-off]")
                expect(off).to_contain_text(f"AI is off in {A_NAME}. Its owners and admins can turn it back on in People.")
                expect(lee.get_by_role("heading", name="Agent in Flux")).to_have_count(0)
                expect(lee.get_by_role("heading", name="Your agent app")).to_have_count(0)
                expect(lee.get_by_text("Your agents work for you")).to_have_count(0)
                shot(lee, f"settings-all-off-{'phone' if phone else 'desktop'}")
                off.get_by_role("button", name="People").click()
                expect(lee.get_by_role("heading", name="People", exact=True)).to_be_visible()
                lee.goto("/settings/assistant")
                expect(lee.locator("[data-ai-off]")).to_contain_text(f"AI is off in {A_NAME}.")
                # The personal-key pages say the same, and ask for nothing; the account menu has no entry for them.
                asked: list[str] = []
                lee.on("request", lambda request: asked.append(request.url) if re.search(r"/api/v1/.*(background-|personal-assistant|assistant-runs|working-agents)", request.url) else None)
                for path in ("/settings/background-compute", "/settings/ai-connections"):
                    lee.goto(path)
                    expect(lee.locator("[data-ai-off]")).to_contain_text(f"AI is off in {A_NAME}.")
                self.assertEqual(asked, [], "nothing AI-shaped was read for a person whose every workspace is off")
                if not phone:
                    lee.goto("/")
                    lee.get_by_role("button", name=re.compile("Lee Moreno")).first.click()
                    expect(lee.get_by_role("link", name="All settings")).to_be_visible()
                    expect(lee.get_by_role("link", name="Your background suggestions")).to_have_count(0)
                    expect(lee.get_by_role("link", name="Your assistant")).to_have_count(0)
                lee.goto("/")
                expect(lee.get_by_role("heading", level=1, name="Home")).to_be_visible()
                expect(lee.get_by_text("Meet your assistant")).to_have_count(0)
                self.assertEqual(self.markers(lee), 0)
                self.assertEqual(lee.refused, [])
                kai = self.page("kai", phone=phone)
                kai.goto("/settings/agents")
                expect(kai.locator("[data-ai-off]")).to_contain_text(f"AI is off in {A_NAME}. Its owners and admins can turn it back on.")
                expect(kai.locator("[data-ai-off]").get_by_role("button", name="People")).to_have_count(0)

    def test_09_conversation_tasks_map_wiki_files_and_search_work_for_two_people(self) -> None:
        self.set_ai(self.page("ada"), "blocked")
        for phone in (False, True):
            with self.subTest(phone=phone):
                token = f"marigold{uuid.uuid4().hex[:8]}"
                ada, kai = self.page("ada", phone=phone), self.page("kai", phone=phone)
                self.project_page(ada, "a")
                self.project_page(kai, "a")
                # A message from Kai reaches Ada's open stream.
                kai.locator("#project-composer").fill(f"Pot the {token} seedlings")
                kai.get_by_role("button", name="Send message").click()
                expect(ada.get_by_text(f"Pot the {token} seedlings")).to_be_visible(timeout=30000)
                # A reply in its thread, written by Ada.
                kai_root = next(item for item in self.api(ada, "GET", f"/api/v1/projects/{self.ids['a_project']}/conversations?limit=20")["items"] if token in item["firstMessageBody"])
                ada.goto(f"/projects/{self.ids['a_project']}/conversations/{kai_root['id']}")
                ada.locator("#thread-composer").fill("Done by noon")
                ada.get_by_role("button", name="Send reply").click()
                expect(ada.get_by_text("Done by noon")).to_be_visible()
                # A task, a sketch, a wiki page and a file, made by people.
                work = self.api(ada, "POST", f"/api/v1/projects/{self.ids['a_project']}/work", {"title": f"Water the {token} bed"}, status=201)
                sketch = self.api(ada, "POST", f"/api/v1/workspaces/{self.ids['a']}/sketches", {"title": f"{token} beds", "scope": "project", "projectId": self.ids["a_project"]}, status=201)
                self.api(ada, "POST", f"/api/v1/sketches/{sketch['id']}/thoughts", {"text": f"{token} by the wall", "x": 0, "y": 0}, status=201)
                doc = self.api(ada, "POST", f"/api/v1/projects/{self.ids['a_project']}/docs", {"title": f"{token} guide", "body": "Water in the morning.", "state": "published"}, status=201)
                kai.goto(f"/projects/{self.ids['a_project']}/tasks")
                expect(kai.get_by_text(f"Water the {token} bed").first).to_be_visible()
                kai.goto(f"/projects/{self.ids['a_project']}/map")
                expect(kai.get_by_text(f"{token} beds").first).to_be_visible()
                kai.goto(f"/projects/{self.ids['a_project']}/docs/{doc['id']}")
                expect(kai.get_by_text("Water in the morning.")).to_be_visible()
                # Search finds all of it.
                self.open_jump(kai, phone)
                kai.get_by_role("combobox", name="Jump to").fill(token)
                for text in (f"Pot the {token} seedlings", f"Water the {token} bed", f"{token} guide"):
                    expect(kai.get_by_role("listbox").get_by_text(re.compile(re.escape(text))).first).to_be_visible()
                self.assertEqual(work["title"], f"Water the {token} bed")
                self.assertEqual(self.markers(kai), 0)
                self.assertEqual(ada.refused + kai.refused, [])
                shot(kai, f"human-work-{'phone' if phone else 'desktop'}")

    def test_09b_home_and_inbox_show_no_agent_question_from_the_blocked_workspace(self) -> None:
        """An agent's question in A (stubbed read: asking one needs an MCP bearer) is not shown while AI is off; the same one in B is."""
        self.set_ai(self.page("ada"), "blocked")
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page("ada", phone=phone, ready=True)

                def item(key: str, project: str, name: str, agent: bool) -> dict:
                    return {"key": key, "kind": "question", "title": f"{name} asks which bed", "detail": "Per bed, or one value?", "project": {"id": self.ids[project], "name": name},
                            "from": {"kind": "agent", "id": str(uuid.uuid4()), "name": "Sprout"} if agent else {"kind": "human", "id": self.ids["kai"], "name": "Kai Tanaka"},
                            "at": NOW, "url": f"/projects/{self.ids[project]}", "decision": None, "blocked": None, "reason": "question", "snoozeTask": None}
                queue = [item(f"note:{uuid.uuid4()}", "a_project", A_PROJECT, True), item(f"note:{uuid.uuid4()}", "b_project", B_PROJECT, True), item(f"note:{uuid.uuid4()}", "a_project", "Seed order", False)]
                page.route("**/api/v1/needs-you", lambda route: route.fulfill(status=200, content_type="application/json",
                           body=json.dumps({"items": queue, "count": len(queue), "later": 0, "doneToday": 0})) if route.request.method == "GET" else route.continue_())
                for path in ("/", "/inbox"):
                    page.goto(path)
                    expect(page.get_by_text(f"{B_PROJECT} asks which bed").first).to_be_visible()
                    expect(page.get_by_text("Seed order asks which bed").first).to_be_visible()
                    expect(page.get_by_text(f"{A_PROJECT} asks which bed")).to_have_count(0)
                    self.assertEqual(page.locator(f"[data-ai-surface='needs-you-ai']").count(), 1, "only the allowed workspace's agent question is drawn")
                    self.assertEqual(page.refused, [])
                shot(page, f"inbox-{'phone' if phone else 'desktop'}")

    def test_10_an_open_tab_follows_the_change_without_a_reload(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                self.set_ai(self.page("ada"), "allowed")
                tab = self.page("ada", phone=phone, ready=True)
                self.project_page(tab, "a")
                self.assertIn("Agents", self.views(tab))
                admin = self.page("lee", phone=phone)
                self.open_people(admin, A_NAME)
                row = self.ai_row(admin)
                row.get_by_role("button", name="Turn off AI", exact=True).click()
                row.get_by_role("group").get_by_role("button", name="Turn off AI").click()
                expect(row.locator(".people__ai-line")).to_have_text(re.compile(r"^Off · turned off by Lee Moreno on "))
                # The other tab lost the Agents view and its composer commands; it was not reloaded.
                self.wait_for_agents_view(tab, False)
                self.assertNotIn("/handoff", self.composer_actions(tab, "#project-composer", "/"))
                # And back.
                row.get_by_role("button", name="Turn on AI", exact=True).click()
                row.get_by_role("group").get_by_role("button", name="Turn on AI").click()
                expect(row.locator(".people__ai-line")).to_have_text(ON_LINE)
                self.wait_for_agents_view(tab, True)
                self.assertIn("/handoff", self.composer_actions(tab, "#project-composer", "/"))
                self.assertEqual(tab.refused, [])
                # A member's open People panel follows too.
                kai = self.page("kai", phone=phone)
                self.open_people(kai, A_NAME)
                expect(kai.get_by_role("region", name=f"AI in {A_NAME}")).to_have_count(0)
                self.set_ai(admin, "blocked")
                expect(kai.get_by_role("region", name=f"AI in {A_NAME}")).to_have_text(f"AI is off in {A_NAME}. Its owners and admins turned it off.")
                self.set_ai(admin, "allowed")
                expect(kai.get_by_role("region", name=f"AI in {A_NAME}")).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
