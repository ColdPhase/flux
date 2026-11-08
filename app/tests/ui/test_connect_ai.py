"""Browser tests for Connect AI in Settings › AI (#854, #843; F-036 CA-1 to CA-3; earlier F-022 T2, #277).

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose application
(composed with the TEST-ONLY anthropic-mock fixture key connection that test_personal_assistant uses; no
model is called). Settings › AI shows Connect AI first: one row per connection a person holds at the same time
(a Claude plan, a ChatGPT plan, API keys), each with one usage line and "Change" on the right; then the assistant,
which uses one of them; then their own agent app. The check stack runs without the agent runtime, so the plans are
rendered from a stubbed runtime status (wording and layout, not sign-in). Flux shows no limits of its own and never
offers to switch a connection. Details link there; the project Agents view shows each MCP entry; and a second member
never sees, or can change, the first member's connections, keys or the runtime.

Two members share one workspace: Ines (owner of an MCP connection and of the assistant) and Tom (nothing
connected, the no-AI journey).
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
from datetime import datetime, timedelta, timezone

from playwright.sync_api import Browser, BrowserContext, Locator, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")

PASSWORD = "one place for both ways"
STAMP = int(time.time() * 1000)
INES = {"name": "Ines Moreau", "email": f"ines.connect+{STAMP}@example.test"}
TOM = {"name": "Tom Reyes", "email": f"tom.connect+{STAMP}@example.test"}
CONNECTION = "Ines desk laptop"
KEY_NAME = "Ines lab key"
MODE_B_PAGE = "Your agent app"  # Settings › AI, plain words (F-027 AST-10.2)
# F-027 AST-10.2: words no Flux screen shows. "API" is allowed in "API key", "API keys", "API credits", and the
# payer labels "API billing" that the #277 change list names.
JARGON = re.compile(r"\b(scopes?|grants?|MCP|tokens?|capabilit(?:y|ies)|execut(?:e|ion)|runtimes?|transports?|OAuth|"
                    r"policy|policies|proposals?|payloads?|slots?|jobs?|reactions?|cron)\b|\bAPI\b(?!\s+(?:keys?|credits|billing)\b)", re.I)
# Words of a limit Flux would set itself, or of a switch to another payer; none may appear (#843, #854).
FLUX_LIMITS = re.compile(r"(?i)\b(runs? a day|requests? a day|per run|changes per run|per request|allowance|switch to|use another|instead)\b")
RUNTIME_ON = {"enabled": True, "clients": {"claude_code": "available", "codex": "available"}, "commercialTerms": None,
              "idleReleaseDays": None, "pool": "available", "binding": None, "lastRelease": None,
              "connections": {"claude_code": None, "codex": None}}
SOON = (datetime.now(timezone.utc) + timedelta(hours=3)).isoformat().replace("+00:00", "Z")
LATER = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat().replace("+00:00", "Z")


def usage(left: int | None, window: str | None = None, resets: str | None = None, reached: bool = False) -> dict:
    return {"leftPercent": left, "window": window, "resetsAt": resets, "limitReached": reached, "readAt": "2026-10-16T10:30:00.000Z"}


def signed_in(method: str, payer: str, auth: str, at: str, used: dict | None = None) -> dict:
    return {"state": "signed_in", "signInMethod": method, "authMethod": auth, "plan": None, "accountLabel": None,
            "signedInAt": at, "payer": payer, "accountChange": None, "signOut": None, "usage": used}


def runtime_signed_in(claude: dict | None, codex: dict | None) -> dict:
    """Both plans signed in (or one of them), with what each provider reported."""
    return {**RUNTIME_ON, "binding": {"state": "active", "boundAt": "2026-10-16T10:00:00.000Z", "lastUsedAt": None, "idleReleaseAt": None},
            "connections": {"claude_code": claude, "codex": codex}, "auth": {}}


CLAUDE = signed_in("claude_account", "claude_plan", "claude.ai", "2026-10-16T10:05:00.000Z")
CODEX = signed_in("device_code", "chatgpt_plan", "chatgpt", "2026-10-16T10:07:00.000Z", usage(48, "weekly", LATER))


class ConnectAiJourney(unittest.TestCase):
    """Tests run in name order and share two accounts and one project."""

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

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, who: str | None, *, phone: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "service_workers": "block"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        if who and who in self.states:
            options["storage_state"] = self.states[who]
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context

    def page(self, who: str | None, **kwargs) -> Page:
        page = self.context(who, **kwargs).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None):
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def no_horizontal_scroll(self, page: Page) -> None:
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"))

    def above(self, first, second) -> bool:
        a = first.bounding_box()
        b = second.bounding_box()
        self.assertIsNotNone(a, "first element is visible")
        self.assertIsNotNone(b, "second element is visible")
        return a["y"] < b["y"]

    def stub_runtime(self, page: Page, status: dict | None = None) -> None:
        """A stubbed runtime status (the check suite runs with it off); the sign-in pages are not read here."""
        page.route(re.compile(r".*/api/v1/agent-runtime$"), lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(status or RUNTIME_ON)))

    def sections(self, page: Page) -> tuple[Locator, Locator, Locator]:
        return (page.get_by_role("region", name="Connect AI", exact=True), page.get_by_role("region", name="Your assistant", exact=True),
                page.get_by_role("region", name=MODE_B_PAGE, exact=True))

    def assert_change_beside_the_text(self, row: Locator) -> None:
        """#854: "Change" sits on the right of its row, vertically centred, and never overlaps the name or the usage line."""
        geometry = row.evaluate("""row => {
          const box = (node) => { const r = node.getBoundingClientRect(); return {left: r.left, right: r.right, top: r.top, bottom: r.bottom}; };
          const change = row.querySelector('.cai__change');
          const texts = [...row.querySelectorAll('.sset-row__t, .cai__usage-text')].map((node) => {
            const range = document.createRange(); range.selectNodeContents(node);
            const rects = [...range.getClientRects()];
            return {right: Math.max(...rects.map((r) => r.right)), top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom))};
          });
          return {row: box(row), change: box(change), texts};
        }""")
        change, row_box = geometry["change"], geometry["row"]
        for text in geometry["texts"]:
            self.assertLessEqual(text["right"], change["left"] - 4, f"the text ends before Change: {geometry}")
        self.assertLessEqual(row_box["right"] - change["right"], 24, f"Change is at the right of its row: {geometry}")
        middle = (row_box["top"] + row_box["bottom"]) / 2
        self.assertAlmostEqual((change["top"] + change["bottom"]) / 2, middle, delta=2, msg=f"Change is vertically centred: {geometry}")

    def test_01_two_members_one_connection(self) -> None:
        for key, person in (("ines", INES), ("tom", TOM)):
            page = self.page(None)
            page.goto("/sign-up")
            page.get_by_label("Name").fill(person["name"])
            page.get_by_label("Email").fill(person["email"])
            page.get_by_label("Password").fill(PASSWORD)
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            type(self).states[key] = page.context.storage_state()
            person["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        ines = self.page("ines")
        ws = self.api(ines, "POST", "/api/v1/workspaces", {"name": "Connect studio"}, status=201)
        self.api(ines, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": TOM["email"], "role": "member"}, status=201)
        project = self.api(ines, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Two ways", "visibility": "workspace"}, status=201)
        agent = self.api(ines, "POST", f"/api/v1/workspaces/{ws['id']}/agents", {"name": "Ines's coding agent", "owner": "self"}, status=201)
        connection = self.api(ines, "POST", "/api/v1/integration/agent-connections", {"agentId": agent["id"],
                              "name": CONNECTION, "clientDesignation": "codex"}, status=201)
        type(self).ids = {"workspace": ws["id"], "project": project["id"], "agent": agent["id"], "connection": connection["id"]}

    def test_02_settings_ai_puts_connect_ai_first_then_the_assistant_and_the_agent_app(self) -> None:
        """#854 (mockup Main): with nothing connected yet, Connect AI opens its window with the three kinds of connection. The check
        stack does not run the plans, so they say so in their row; an API key is offered. The assistant and the agent app follow."""
        page = self.page("ines")
        page.goto("/settings/agents")
        expect(page.get_by_role("heading", level=2, name="AI", exact=True)).to_be_visible()
        connect, assistant, app = self.sections(page)
        expect(connect).to_contain_text("Plans can run side by side. Each agent uses one.")
        expect(connect.get_by_role("button", name="Connect another")).to_have_count(0)
        connect.get_by_role("button", name="Connect AI", exact=True).click()
        window = page.get_by_role("dialog", name="Connect your AI")
        expect(window).to_contain_text("Flux adds no limits of its own.")
        for kind, title in (("claude_plan", "Claude plan"), ("chatgpt_plan", "ChatGPT plan")):
            row = window.locator(f"[data-choice={kind}]")
            expect(row).to_contain_text(title)
            expect(row).to_contain_text("Not offered on this Flux server")
            expect(row.locator("input")).to_be_disabled()
        api_key = window.locator("[data-choice=api_key]")
        expect(api_key).to_contain_text("API key")
        expect(api_key.locator("input")).to_be_checked()
        window.get_by_role("button", name="Cancel").click()
        expect(window).to_have_count(0)
        card = assistant.get_by_role("region", name=re.compile("^Your assistant"))
        expect(card.get_by_role("link", name="Set up", exact=True)).to_have_attribute("href", "/settings/assistant")
        expect(card.get_by_role("link", name="How it works")).to_have_attribute("href", "/settings/assistant/how")
        self.assertTrue(self.above(connect, assistant), "Connect AI comes first")
        self.assertTrue(self.above(assistant, app), "then the assistant, then the agent app")
        # Your agent app: MCP connections; no client guide with command-line words on this page.
        # #763 SG-6: the client and its Agent tag first, the device in the meta line ("Codex · for you · Ines desk laptop").
        expect(app.get_by_role("link", name=re.compile(f"^Codex.*for you · {CONNECTION}"))).to_have_attribute("href", "/connect-agent")
        expect(app.get_by_role("link", name="Local co-work on this computer")).to_have_attribute("href", "/connect-agent")
        expect(app).not_to_contain_text("claude mcp add")
        for region in (connect, assistant):
            self.assertIsNone(FLUX_LIMITS.search(region.inner_text()), f"no Flux limit or switch: {region.inner_text()!r}")
        shot(page, "connect-ai-desktop-1440")

    def test_03_phone_width_keeps_every_section_readable(self) -> None:
        page = self.page("ines", phone=True)
        page.goto("/settings/agents")
        connect, assistant, app = self.sections(page)
        expect(connect).to_be_visible()
        expect(assistant).to_be_visible()
        expect(app).to_be_visible()
        self.assertTrue(self.above(connect, assistant))
        self.no_horizontal_scroll(page)
        shot(page, "connect-ai-phone-390")
        page.goto("/settings")
        expect(page.get_by_role("link", name=re.compile("^AI\\b"))).to_have_attribute("href", "/settings/agents")
        self.no_horizontal_scroll(page)

    def test_05_no_ai_journey_nothing_connected(self) -> None:
        page = self.page("tom")
        page.goto("/settings/agents")
        connect, assistant, app = self.sections(page)
        expect(connect.locator("li[data-connection]")).to_have_count(0)
        expect(connect.get_by_role("button", name="Connect AI", exact=True)).to_be_visible()
        expect(assistant).to_contain_text("not set up")
        expect(app.get_by_role("link", name="Local co-work on this computer")).to_be_visible()
        expect(app.locator(".sset-row__identity")).to_have_count(0)
        expect(page.get_by_text("Your connected agents could not be listed")).to_have_count(0)
        # Human work goes on: the project opens. Tom has no AI of his own; the project lists the MCP agent Ines
        # connected to it, with its owner (project members see each connection's owner, client and name).
        page.goto(f"/projects/{self.ids['project']}/agents")
        expect(page.get_by_role("heading", level=1, name="Agents")).to_be_visible()
        rows = page.get_by_role("list", name="Agents in this project").get_by_role("listitem")
        expect(rows.filter(has_text=CONNECTION)).to_have_count(1)
        expect(rows.filter(has_text=CONNECTION)).to_contain_text("for Ines Moreau")

    def test_06_the_project_lists_only_mcp_while_own_assistant_stays_in_settings(self) -> None:
        ines = self.page("ines")
        status = self.api(ines, "GET", "/api/v1/personal-assistant", status=200)
        self.assertEqual(status["state"], "not_enabled")
        assistant = self.api(ines, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/agents", {"name": "Ines personal assistant", "owner": "self"}, status=201)
        type(self).ids["assistant_agent"] = assistant["id"]
        # #854: the model of a connection, Connect AI's default here (the TEST-ONLY fixture key); nothing else to agree to.
        choice = self.api(ines, "GET", "/api/v1/personal-assistant/model", status=200)
        self.assertIsNotNone(choice["default"])
        self.api(ines, "POST", "/api/v1/personal-assistant", {"agentId": assistant["id"], **choice["default"]}, status=201)
        ines.goto(f"/projects/{self.ids['project']}/agents")
        rows = ines.get_by_role("list", name="Agents in this project").get_by_role("listitem")
        # Project lists contain only MCP connections, even for the assistant owner (#522).
        expect(rows).to_have_count(1)
        expect(ines.get_by_text("Ines personal assistant", exact=False)).to_have_count(0)
        expect(ines.get_by_role("region", name="Assistant join requests")).to_have_count(0)
        expect(rows.filter(has_text=CONNECTION)).to_have_count(1)
        expect(rows.filter(has_text=CONNECTION)).to_contain_text("for Ines")
        # Settings keeps the owner’s assistant, its model and its connection reachable.
        ines.goto("/settings/agents")
        _, section, _ = self.sections(ines)
        expect(section).to_contain_text("· API key · Assistant on")

    def test_07_a_second_member_never_sees_or_changes_the_first_members_connections(self) -> None:
        ines = self.page("ines")
        key = self.api(ines, "POST", "/api/v1/background-compute-connections", {"name": KEY_NAME, "provider": "anthropic", "model": "claude-sonnet-5",
                       "apiKey": f"sk-ant-api03-{'connect-ai-ui-key-' * 3}CA01", "dailyBudgetCents": 750, "timeZone": "Europe/Warsaw"}, status=201)
        type(self).ids["key"] = key["id"]
        tom = self.page("tom")
        # What Tom sees: his own page, and the shared project's Agents view with Ines's connection read-only; not her assistant or keys.
        tom.goto("/settings/agents")
        connect, assistant, app = self.sections(tom)
        expect(app).not_to_contain_text(CONNECTION)
        expect(app).not_to_contain_text("Ines")
        expect(assistant).not_to_contain_text("Ines")
        expect(assistant).not_to_contain_text("Assistant on")
        expect(connect).not_to_contain_text(KEY_NAME)
        expect(connect.locator("li[data-connection]")).to_have_count(0)
        # The project lists Ines's MCP agent to Tom with its owner, read-only: no stop, hand-off or revoke control.
        tom.goto(f"/projects/{self.ids['project']}/agents")
        rows = tom.get_by_role("list", name="Agents in this project").get_by_role("listitem")
        ines_row = rows.filter(has_text=CONNECTION)
        expect(ines_row).to_have_count(1)
        expect(ines_row).to_be_visible()
        expect(ines_row).to_contain_text("for Ines Moreau")
        manage = re.compile("Stop|Take back|Revoke|Remove|Hand off", re.I)
        expect(ines_row.get_by_role("button", name=manage)).to_have_count(0)
        ines_row.get_by_role("button").first.click()
        expect(tom.locator(".agents-detail").get_by_role("button", name=manage)).to_have_count(0)
        # What Tom's API calls return and refuse.
        own = self.api(tom, "GET", "/api/v1/agent-connections", status=200)
        self.assertEqual([item for item in own if item["id"] == self.ids["connection"]], [])
        self.assertEqual(self.api(tom, "GET", "/api/v1/personal-assistant", status=200)["enablement"], None, "Tom has no assistant of his own")
        self.assertEqual([item for item in self.api(tom, "GET", "/api/v1/background-compute-connections", status=200) if item["id"] == key["id"]], [])
        changed = tom.request.fetch(f"{ORIGIN}/api/v1/background-compute-connections/{key['id']}", method="PATCH",
                                    headers={"origin": ORIGIN, "content-type": "application/json"}, data=json.dumps({"dailyBudgetCents": 100000}))
        self.assertIn(changed.status, (403, 404), changed.text())
        runtime = self.api(tom, "GET", "/api/v1/agent-runtime", status=200)
        self.assertIsNone(runtime.get("binding"))
        self.assertNotIn(INES["id"], json.dumps(runtime))
        revoke = tom.request.fetch(f"{ORIGIN}/api/v1/agent-connections/{self.ids['connection']}", method="DELETE", headers={"origin": ORIGIN})
        self.assertIn(revoke.status, (403, 404), revoke.text())
        # Control: the connection and the key are still Ines's and unchanged.
        live = [item for item in self.api(ines, "GET", "/api/v1/agent-connections", status=200) if item["id"] == self.ids["connection"]]
        self.assertEqual(len(live), 1)
        self.assertIsNone(live[0].get("revokedAt"))
        mine = [item for item in self.api(ines, "GET", "/api/v1/background-compute-connections", status=200) if item["id"] == key["id"]]
        self.assertEqual([item["dailyBudgetCents"] for item in mine], [750])

    def assert_phone_roster_summary(self, page: Page, count: int) -> None:
        unit = "client" if count == 1 else "clients"
        subtitle = page.locator("header.phead .phead__sub")
        expect(subtitle).to_contain_text(f"{count} MCP {unit}")
        # Generated content is visible but omitted from textContent/Playwright text assertions.
        rendered = subtitle.evaluate(r"""element => {
          const generated = (node, pseudo) => {
            const content = getComputedStyle(node, pseudo).content;
            return content === 'none' || content === 'normal' ? '' : content.replace(/^["']|["']$/g, '');
          };
          const text = node => node.nodeType === Node.TEXT_NODE ? node.textContent
            : generated(node, '::before') + [...node.childNodes].map(text).join('') + generated(node, '::after');
          return text(element).replace(/\s+/g, ' ').trim();
        }""")
        self.assertEqual(rendered, f"Agents · 2 people · {count} MCP {unit}", "the rendered subtitle has exactly one separator between each part")

    def assert_phone_title_focus_inset(self, page: Page) -> None:
        menu = page.locator(".phead__menu")
        expect(menu).to_be_focused()
        geometry = menu.evaluate("""button => {
          const box = button.getBoundingClientRect(), style = getComputedStyle(button);
          const name = button.querySelector('.phead__name').getBoundingClientRect();
          const icon = button.querySelector('svg').getBoundingClientRect();
          const subtitle = button.closest('.phead__title').querySelector('.phead__sub').getBoundingClientRect();
          return {width:box.width,height:box.height,visible:button.matches(':focus-visible'),
            outlineWidth:parseFloat(style.outlineWidth),outlineStyle:style.outlineStyle,outlineColor:style.outlineColor,
            contentLeft:name.left,contentRight:icon.right,
            outlineLeft:box.left - parseFloat(style.outlineOffset) - parseFloat(style.outlineWidth),
            outlineRight:box.right + parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth),
            outlineBottom:box.bottom + parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth),
            subtitleTop:subtitle.top, subtitleBottom:subtitle.bottom, subtitleLeft:subtitle.left, subtitleRight:subtitle.right};
        }""")
        self.assertGreaterEqual(geometry["height"], 44)
        self.assertGreaterEqual(geometry["width"], 44)
        self.assertTrue(geometry["visible"])
        self.assertEqual(geometry["outlineStyle"], "solid")
        self.assertGreaterEqual(geometry["outlineWidth"], 2)
        self.assertNotIn(geometry["outlineColor"], ("transparent", "rgba(0, 0, 0, 0)"))
        self.assertLessEqual(geometry["outlineLeft"] + geometry["outlineWidth"], geometry["contentLeft"], "focus outline stays outside title text")
        self.assertLessEqual(geometry["contentRight"], geometry["outlineRight"] - geometry["outlineWidth"], "focus outline stays outside the title chevron")
        # The 56 px phone header (Spokój #507 AC-3) puts the view line inside the title's 44 px target: the visible
        # focus frames the title and its view line whole instead of crossing the subtitle.
        self.assertGreaterEqual(geometry["outlineBottom"], geometry["subtitleBottom"], "visible title focus does not cross the subtitle")
        self.assertLessEqual(geometry["outlineLeft"], geometry["subtitleLeft"], "visible title focus does not cross the subtitle")
        self.assertGreaterEqual(geometry["outlineRight"], geometry["subtitleRight"], "visible title focus does not cross the subtitle")

    def test_07b_owner_and_member_mcp_visibility_on_computer_and_phone(self) -> None:
        for phone in (False, True):
            for who in ("ines", "tom"):
                with self.subTest(phone=phone, who=who):
                    page = self.page(who, phone=phone)
                    page.goto(f"/projects/{self.ids['project']}/agents")
                    rows = page.get_by_role("list", name="Agents in this project").get_by_role("listitem")
                    expect(rows).to_have_count(1)
                    expect(rows).to_contain_text(CONNECTION)
                    expect(rows).to_contain_text("for Ines Moreau")
                    expect(rows).to_contain_text("Codex")
                    expect(page.get_by_text("Ines personal assistant", exact=False)).to_have_count(0)
                    if phone:
                        self.assert_phone_roster_summary(page, 1)
                        page.locator(".phead__menu").click()
                        expect(page.locator(".phone-menu__item").filter(has_text=re.compile("^Agents"))).to_contain_text("1 MCP client")
                        shot(page, f"menu-{who}-phone-390-{UI_BROWSER}")
                        page.keyboard.press("Escape")
                        self.assert_phone_title_focus_inset(page)
                    shot(page, f"roster-{who}-{'phone-390' if phone else 'desktop-1440'}-{UI_BROWSER}")
                    rows.get_by_role("button").first.click()
                    panel = page.locator(".agents-detail")
                    if who == "ines":
                        expect(panel.get_by_role("button", name=re.compile("^Hand off to "))).to_have_count(1)
                    else:
                        expect(panel.get_by_role("button", name=re.compile("Stop|Take back|Revoke|Remove|Hand off|^Ask ", re.I))).to_have_count(0)
                        view = self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/agents", status=200)
                        self.assertEqual(len(view["connections"]), 1)
                        self.assertFalse(any(connection.get("assistant") for connection in view["connections"]))
                        people = self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/people", status=200)
                        self.assertNotIn(self.ids["assistant_agent"], [person["id"] for person in people])
                        self.assertIn(self.ids["agent"], [person["id"] for person in people])
                    self.no_horizontal_scroll(page)
                    shot(page, f"agent-visibility-{who}-{'phone-390' if phone else 'desktop-1440'}-{UI_BROWSER}")
                    if who == "ines":
                        page.goto("/settings/assistant")
                        expect(page.get_by_role("heading", name="Your assistant", exact=True)).to_be_visible()
                        page.locator("details.aset__more > summary").click()
                        expect(page.get_by_role("region", name="Your assistant’s project access")).to_have_count(0)
                        shot(page, f"assistant-own-settings-{'phone-390' if phone else 'desktop-1440'}-{UI_BROWSER}")

    def test_08_several_connections_side_by_side_each_with_one_usage_line(self) -> None:
        """#854 (mockups Main and ConnectAI): a Claude plan, a ChatGPT plan and an API key at the same time, in the order they were
        made. Each row: its name and state, one usage line (the provider's remaining usage, "Plan limits apply" when it reported
        none, or the key's daily budget) and "Change" on the right, vertically centred, never over the text."""
        for phone in (False, True):
            width = "phone-390" if phone else "desktop-1440"
            page = self.page("ines", phone=phone)
            self.stub_runtime(page, runtime_signed_in(CLAUDE, CODEX))
            page.goto("/settings/agents")
            connect, assistant, _ = self.sections(page)
            rows = connect.locator("li[data-connection]")
            expect(rows).to_have_count(3)
            expect(rows.nth(0)).to_have_attribute("data-connection", "claude_plan")
            expect(rows.nth(1)).to_have_attribute("data-connection", "chatgpt_plan")
            expect(rows.nth(2)).to_have_attribute("data-connection", "api_key")
            expect(rows.nth(0).locator(".sset-row__t")).to_have_text("Claude plan · Connected")
            expect(rows.nth(0).locator(".cai__usage-text")).to_have_text("Plan limits apply")
            expect(rows.nth(0).locator(".cai__bar")).to_have_count(0)
            expect(rows.nth(1).locator(".sset-row__t")).to_have_text("ChatGPT plan · Connected")
            expect(rows.nth(1).locator(".cai__usage-text")).to_have_text(re.compile(r"^48% of your weekly limit left · resets \S+"))
            expect(rows.nth(2).locator(".sset-row__t")).to_have_text(f"{KEY_NAME} · Connected")
            expect(rows.nth(2).locator(".cai__usage-text")).to_have_text("$0.00 of $7.50 today")
            for index, to in enumerate(("/settings/agents/claude-code", "/settings/agents/codex", f"/settings/ai-connections?key={self.ids['key']}")):
                change = rows.nth(index).get_by_role("link", name=re.compile("^Change "))
                expect(change).to_have_count(1)
                expect(change).to_have_attribute("href", to)
                self.assert_change_beside_the_text(rows.nth(index))
            # Nothing offers to move work to another connection, and no limit of Flux's own is shown.
            self.assertIsNone(FLUX_LIMITS.search(connect.inner_text()), connect.inner_text())
            expect(connect.get_by_role("button", name=re.compile("switch", re.I))).to_have_count(0)
            self.no_horizontal_scroll(page)
            shot(page, f"connect-ai-three-{width}")
            # "Connect another" offers only what is not connected yet: another API key.
            connect.get_by_role("button", name="Connect another").click()
            window = page.get_by_role("dialog", name="Connect your AI")
            expect(window.locator("[data-choice]")).to_have_count(1)
            expect(window.locator("[data-choice=api_key] input")).to_be_checked()
            window.get_by_role("button", name="Cancel").click()
            expect(window).to_have_count(0)
            expect(connect.get_by_role("button", name="Connect another")).to_be_visible()
            page.context.close()

    def test_08d_connect_ai_is_one_window_in_steps(self) -> None:
        """#854 (the guide, mockup ConnectAI): choose, sign in, fail and enter a key in one window, without leaving Settings."""
        for phone in (False, True):
            page = self.page("tom", phone=phone)
            self.stub_runtime(page, RUNTIME_ON)
            page.route(re.compile(r".*/api/v1/agent-runtime/console$"), lambda route: route.fulfill(status=409, content_type="application/json",
                       body=json.dumps({"error": "Your runtime is busy with another sign-in", "code": "AGENT_RUNTIME_BUSY"})))
            page.goto("/settings/agents")
            connect, _, _ = self.sections(page)
            connect.get_by_role("button", name="Connect AI", exact=True).click()
            window = page.get_by_role("dialog", name="Connect your AI")
            expect(window.get_by_role("heading", name="Connect your AI")).to_be_visible()
            expect(window.locator("[data-choice]")).to_have_count(3)
            window.locator("[data-choice=claude_plan]").click()
            window.get_by_role("button", name="Continue").click()
            expect(window.get_by_role("heading", name="Couldn’t connect")).to_be_visible()
            expect(window.get_by_role("alert")).to_contain_text("busy")
            expect(window.get_by_role("button", name="Try again")).to_be_visible()
            shot(page, f"connect-ai-window-failed-{'phone' if phone else 'desktop'}")
            window.get_by_role("button", name="Use an API key").click()
            expect(window.get_by_role("heading", name="Use an API key")).to_be_visible()
            expect(window.get_by_label("Daily budget (USD)", exact=True)).to_have_value("5.00")
            expect(page).to_have_url(re.compile(r"/settings/agents$"))
            self.no_horizontal_scroll(page)
            window.get_by_role("button", name="Cancel").click()
            expect(window.locator("[data-choice=api_key]")).to_be_visible()
            window.get_by_role("button", name="Cancel").click()
            expect(window).to_have_count(0)
            page.context.close()

    def test_08f_escape_closes_connect_ai_after_a_step_changed(self) -> None:
        """#910: the button that held focus goes with its step, and focus must stay in the window, or Escape reaches nothing."""
        for phone in (False, True):
            page = self.page("tom", phone=phone)
            self.stub_runtime(page, RUNTIME_ON)
            page.route(re.compile(r".*/api/v1/agent-runtime/console$"), lambda route: route.fulfill(status=409, content_type="application/json",
                       body=json.dumps({"error": "Your runtime is busy with another sign-in", "code": "AGENT_RUNTIME_BUSY"})))
            page.goto("/settings/agents")
            connect, _, _ = self.sections(page)
            window = page.get_by_role("dialog", name="Connect your AI")
            for choice, heading in (("claude_plan", "Couldn’t connect"), ("api_key", "Use an API key")):
                connect.get_by_role("button", name="Connect AI", exact=True).click()
                expect(window).to_be_visible()
                window.locator(f"[data-choice={choice}]").click()
                window.get_by_role("button", name="Continue").click()
                expect(window.get_by_role("heading", name=heading)).to_be_visible()
                self.assertTrue(page.evaluate("document.activeElement !== document.body && !!document.activeElement.closest('.cai-window, .ui-overlay')"),
                                f"focus is inside the window at {heading!r}")
                page.keyboard.press("Escape")
                expect(window).to_have_count(0)
            page.context.close()

    def test_08g_a_plan_that_is_not_ready_is_not_offered_and_a_busy_start_says_what_to_do(self) -> None:
        """#910: while the place to sign in is not ready (it is starting, or the host cannot run it), the plans say so and the sign-in
        is not offered; a sign-in that still fails because it is starting shows the server's words and who to ask."""
        starting = {**RUNTIME_ON, "pool": "starting"}
        page = self.page("tom")
        self.stub_runtime(page, starting)
        page.goto("/settings/agents")
        connect, _, _ = self.sections(page)
        connect.get_by_role("button", name="Connect AI", exact=True).click()
        window = page.get_by_role("dialog", name="Connect your AI")
        for plan in ("claude_plan", "chatgpt_plan"):
            expect(window.locator(f"[data-choice={plan}] input")).to_be_disabled()
            expect(window.locator(f"[data-choice={plan}]")).to_contain_text("Not ready yet. If this stays, ask whoever runs Flux.")
        expect(window.locator("[data-choice=api_key] input")).to_be_checked()
        window.get_by_role("button", name="Cancel").click()
        # Ready, but the start fails with the server's own words: they are shown, with who to ask when it stays.
        page.unroute(re.compile(r".*/api/v1/agent-runtime$"))
        self.stub_runtime(page, RUNTIME_ON)
        page.route(re.compile(r".*/api/v1/agent-runtime/console$"), lambda route: route.fulfill(status=503, content_type="application/json",
                   body=json.dumps({"error": "The agent runtime is starting; try again shortly", "code": "AGENT_RUNTIME_UNAVAILABLE"})))
        page.reload()
        connect, _, _ = self.sections(page)
        connect.get_by_role("button", name="Connect AI", exact=True).click()
        window = page.get_by_role("dialog", name="Connect your AI")
        window.locator("[data-choice=claude_plan]").click()
        window.get_by_role("button", name="Continue").click()
        expect(window.get_by_role("alert")).to_have_text("The agent runtime is starting; try again shortly. If it stays like this, ask whoever runs Flux.")
        page.context.close()

    def test_08b_a_plan_at_its_limit_says_so_in_one_line_and_nothing_switches(self) -> None:
        """#854: "Claude limit reached, resumes at 14:00", or without a time when the provider gave none. The line stays one
        line beside Change, also on the phone; there is no switch button anywhere on the page."""
        cases = (
            (usage(None, None, SOON, reached=True), re.compile(r"^Claude limit reached, resumes \S+")),
            (usage(None, None, None, reached=True), re.compile(r"^Claude limit reached$")),
        )
        for phone in (False, True):
            for index, (reported, line) in enumerate(cases):
                page = self.page("ines", phone=phone)
                claude = signed_in("claude_account", "claude_plan", "claude.ai", "2026-10-16T10:05:00.000Z", reported)
                self.stub_runtime(page, runtime_signed_in(claude, None))
                page.goto("/settings/agents")
                connect, _, _ = self.sections(page)
                row = connect.locator("li[data-connection=claude_plan]")
                expect(row.locator(".cai__usage-text")).to_have_text(line)
                self.assert_change_beside_the_text(row)
                expect(page.get_by_role("button", name=re.compile("switch|use another|instead", re.I))).to_have_count(0)
                expect(page.get_by_role("link", name=re.compile("switch|use another|instead", re.I))).to_have_count(0)
                self.no_horizontal_scroll(page)
                if index == 0:
                    shot(page, f"connect-ai-claude-limit-{'phone-390' if phone else 'desktop-1440'}")
                page.context.close()

    def test_08c_a_plan_to_sign_in_again_keeps_its_row(self) -> None:
        expired = {**CLAUDE, "state": "sign_in_again"}
        page = self.page("ines")
        self.stub_runtime(page, runtime_signed_in(expired, None))
        page.goto("/settings/agents")
        connect, _, _ = self.sections(page)
        row = connect.locator("li[data-connection=claude_plan]")
        expect(row.locator(".sset-row__t")).to_have_text("Claude plan · Sign in again")
        expect(row.locator(".cai__usage-text")).to_have_text("Sign in again to keep using it")
        expect(row.get_by_role("link", name="Change Claude plan")).to_have_attribute("href", "/settings/agents/claude-code")

    def test_08e_a_failed_read_of_the_plans_says_so_and_never_calls_them_not_offered(self) -> None:
        """#854: a plan is called "Not offered" only when the server says so; a failed read has its own line with Try again."""
        page = self.page("tom")
        page.route(re.compile(r".*/api/v1/agent-runtime$"), lambda route: route.fulfill(status=500, content_type="application/json", body="{}"))
        page.goto("/settings/agents")
        connect, _, _ = self.sections(page)
        expect(connect).to_contain_text("Your plans could not be read.")
        connect.get_by_role("button", name="Connect AI", exact=True).click()
        window = page.get_by_role("dialog", name="Connect your AI")
        expect(window.locator("[data-choice=claude_plan]")).to_contain_text("Flux couldn’t check this just now")
        expect(window.locator("[data-choice=claude_plan]")).not_to_contain_text("Not offered")
        window.get_by_role("button", name="Cancel").click()
        page.unroute(re.compile(r".*/api/v1/agent-runtime$"))
        self.stub_runtime(page, RUNTIME_ON)
        connect.get_by_role("button", name="Try again").click()
        expect(connect).not_to_contain_text("Your plans could not be read.")
        page.context.close()

    def test_09_the_page_uses_no_jargon_words_with_runtime_on_or_off(self) -> None:
        """AST-10.2 (#277): no visible text on the page uses the listed words; scanner negative control first."""
        self.assertIsNotNone(JARGON.search("Ask the MCP server"), "negative control: the scanner flags a jargon word")
        self.assertIsNotNone(JARGON.search("Your runtime"), "negative control: the scanner flags runtime")
        self.assertIsNone(JARGON.search("Use an API key. API keys and API credits, API billing, Claude · your subscription"), "allowed API phrases pass")
        self.assertIsNotNone(FLUX_LIMITS.search("20 requests a day"), "negative control: the limit scanner flags a Flux limit")
        for runtime_on in (False, True):
            for phone in (False, True):
                page = self.page("ines", phone=phone)
                if runtime_on:
                    self.stub_runtime(page, runtime_signed_in(CLAUDE, CODEX))
                page.goto("/settings/agents")
                expect(page.get_by_role("region", name="Connect AI", exact=True)).to_be_visible()
                page.get_by_role("region", name=MODE_B_PAGE, exact=True).get_by_text("Local co-work on this computer").wait_for()
                for details in page.locator("details").all():
                    details.locator("summary").click()
                text = page.locator(".pane-in").first.inner_text()
                match = JARGON.search(text)
                self.assertIsNone(match, f"jargon on the page (runtime {'on' if runtime_on else 'off'}): {match and match.group(0)}")
                page.context.close()

    def test_10_the_assistant_card_says_in_one_line_when_in_app_ai_is_off(self) -> None:
        """#513 AC-3 (M5): with in-app AI off on the server (a stubbed status), the card says so once, in its status
        line, with no facts and no "How it works". With nothing set up, Set up stays in its place, dimmed (Spokój
        rule 7); an assistant that is set up keeps its Manage link there."""
        def stub(page: Page, body: dict) -> None:
            page.route(re.compile(r".*/api/v1/personal-assistant$"), lambda route: route.fulfill(
                status=200, content_type="application/json", body=json.dumps(body)) if route.request.method == "GET" else route.continue_())

        def one_off_line(card, step: str) -> None:
            expect(card).to_contain_text("In-app AI is off on this Flux server")
            text = card.inner_text()
            self.assertEqual(len(re.findall(r"(?i)\boff\b", text)), 1, f"the off state is said once: {text!r}")
            lines = [" ".join(line.split()) for line in text.splitlines()]
            self.assertEqual([line for line in lines if line and line not in ("Your assistant", "Agent", "Your assistant Agent", step)],
                             ["In-app AI is off on this Flux server"], f"one line besides the name, the Agent tag and {step}: {text!r}")
            expect(card.locator(".sset-assistant__facts")).to_have_count(0)
            expect(card.get_by_role("link", name="How it works")).to_have_count(0)

        def same_place(a: dict | None, b: dict | None) -> None:
            self.assertIsNotNone(a)
            self.assertIsNotNone(b)
            self.assertAlmostEqual(a["y"], b["y"], delta=1, msg=f"the step keeps its row: {a} vs {b}")
            self.assertAlmostEqual(a["x"] + a["width"], b["x"] + b["width"], delta=1, msg=f"the step keeps its right edge: {a} vs {b}")

        for phone in (False, True):
            on = self.page("ines", phone=phone)
            on.goto("/settings/agents")
            live = on.get_by_role("region", name=re.compile("^Your assistant Agent"))
            # test_06 turned Ines's assistant on, so the live card offers Manage.
            step = live.get_by_role("link", name="Manage", exact=True)
            expect(step).to_be_visible()
            expect(live.locator(".sset-assistant__facts li")).to_have_count(3)
            real = self.api(on, "GET", "/api/v1/personal-assistant", status=200)
            self.assertIsNotNone(real["enablement"], "test_06 turned Ines's assistant on")
            off = {**real, "state": "unavailable", "setup": {**real["setup"], "provider": "off", "connection": "none", "runtime": None}}
            # Nothing set up: Set up stays where it is, dimmed.
            page = self.page("ines", phone=phone)
            stub(page, {**off, "enablement": None})
            page.goto("/settings/agents")
            card = page.get_by_role("region", name=re.compile("^Your assistant Agent"))
            one_off_line(card, "Set up")
            expect(card.get_by_role("link")).to_have_count(0)
            dimmed = card.get_by_role("button", name="Set up", exact=True)
            expect(dimmed).to_be_disabled()
            same_place(step.bounding_box(), dimmed.bounding_box())
            shot(page, f"connect-ai-assistant-off-{'phone-390' if phone else 'desktop-1440'}")
            # Set up already: Manage stays, so the person can still pause or remove it.
            managed = self.page("ines", phone=phone)
            stub(managed, off)
            managed.goto("/settings/agents")
            card = managed.get_by_role("region", name=re.compile("^Your assistant Agent"))
            one_off_line(card, "Manage")
            manage = card.get_by_role("link", name="Manage", exact=True)
            expect(manage).to_have_attribute("href", "/settings/assistant")
            expect(card.get_by_role("button", name="Set up")).to_have_count(0)
            same_place(step.bounding_box(), manage.bounding_box())


    def test_10_phone_counts_clients_and_refreshes_after_final_mcp_revocation(self) -> None:
        owner = self.page("ines", phone=True)
        owner.goto(f"/projects/{self.ids['project']}/agents")
        self.assertIn(self.ids["assistant_agent"], [person["id"] for person in self.api(owner, "GET", f"/api/v1/projects/{self.ids['project']}/people", status=200)], "own assistant remains in the authorized audience")
        extra = self.api(owner, "POST", "/api/v1/integration/agent-connections", {"agentId": self.ids["agent"],
                         "name": "Ines second client", "clientDesignation": "claude_code"}, status=201)
        pages = {"ines": owner, "tom": self.page("tom", phone=True)}
        for who, page in pages.items():
            page.goto(f"/projects/{self.ids['project']}/agents")
            expect(page.get_by_role("list", name="Agents in this project").get_by_role("listitem")).to_have_count(2)
            self.assert_phone_roster_summary(page, 2)
            page.locator(".phead__menu").click()
            expect(page.locator(".phone-menu__item").filter(has_text=re.compile("^Agents"))).to_contain_text("2 MCP clients")
            shot(page, f"menu-two-clients-{who}-phone-390-{UI_BROWSER}")
            page.keyboard.press("Escape")
            self.assert_phone_title_focus_inset(page)
        for connection_id, count in ((extra["id"], 1), (self.ids["connection"], 0)):
            removed = owner.request.fetch(f"{ORIGIN}/api/v1/agent-connections/{connection_id}", method="DELETE", headers={"origin": ORIGIN})
            self.assertEqual(removed.status, 204, removed.text())
            for who, page in pages.items():
                page.evaluate("() => window.dispatchEvent(new Event('focus'))")
                if count:
                    expect(page.get_by_role("list", name="Agents in this project").get_by_role("listitem")).to_have_count(count)
                else:
                    expect(page.locator(".agents-row")).to_have_count(0)
                self.assert_phone_roster_summary(page, count)
                page.locator(".phead__menu").click()
                expect(page.locator(".phone-menu__item").filter(has_text=re.compile("^Agents"))).to_contain_text(f"{count} MCP {'client' if count == 1 else 'clients'}")
                if not count:
                    shot(page, f"menu-revoked-{who}-phone-390-{UI_BROWSER}")
                page.keyboard.press("Escape")
                self.assert_phone_title_focus_inset(page)
                if not count:
                    shot(page, f"roster-revoked-{who}-phone-390-{UI_BROWSER}")
        self.assertIn(self.ids["assistant_agent"], [person["id"] for person in self.api(owner, "GET", f"/api/v1/projects/{self.ids['project']}/people", status=200)], "MCP revocation changes no own assistant authority")


if __name__ == "__main__":
    unittest.main()
