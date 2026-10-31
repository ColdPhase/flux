"""Browser tests for one Connect AI entry for both AI modes (F-022 T2, #277).

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose application
(composed with the TEST-ONLY anthropic-mock fixture key connection that test_personal_assistant uses; no
model is called). Settings -> Agents and AI shows two sections, Agent in Flux and Your agent app. With the
runtime on (a stubbed status, F-027 AST-1.1) the sign-in choices come first, Sign in with Claude and Sign in
with ChatGPT, and the API key choices sit under a folded "Other ways to connect". With the runtime off
(AST-1.2) one plain sentence says so and the API key choices show. The page uses no jargon (AST-10.2).
Details and the assistant's empty state link there; the project Agents view shows each entry's mode; and a
second member never sees, or can change, the first member's connections, keys or the runtime.

Two members share one workspace: Ines (owner of an MCP connection and of the assistant) and Tom (nothing
connected, the no-AI journey).
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")

PASSWORD = "one place for both ways"
STAMP = int(time.time() * 1000)
INES = {"name": "Ines Moreau", "email": f"ines.connect+{STAMP}@example.test"}
TOM = {"name": "Tom Reyes", "email": f"tom.connect+{STAMP}@example.test"}
CONNECTION = "Ines desk laptop"
CONSENT = "o-008-2026-10-02"
MODE_B = "Your agent app (MCP)"  # the project Agents view keeps its label
MODE_B_PAGE = "Your agent app"  # Settings -> Agents and AI, plain words (F-027 AST-10.2)
MODE_A = "Agent in Flux"
OFF_SENTENCE = "Signing in with your Claude or ChatGPT subscription isn’t turned on for this Flux server."
# F-027 AST-10.2: words no Flux screen shows. "API" is allowed in "API key", "API keys", "API credits", and the
# payer labels "API billing" that the #277 change list names.
JARGON = re.compile(r"\b(scopes?|grants?|MCP|tokens?|capabilit(?:y|ies)|execut(?:e|ion)|runtimes?|transports?|OAuth|"
                    r"policy|policies|proposals?|payloads?|slots?|jobs?|reactions?|cron)\b|\bAPI\b(?!\s+(?:keys?|credits|billing)\b)", re.I)
RUNTIME_ON = {"enabled": True, "clients": {"claude_code": "available", "codex": "available"}, "commercialTerms": None,
              "idleReleaseDays": None, "pool": "available", "binding": None, "lastRelease": None,
              "connections": {"claude_code": None, "codex": None}}
# F-027 AST-1 "Which account should I use?", as the spec words it (docs/product/assistant.md). The page uses the typographic
# apostrophe, so the comparison reads both as one.
WHICH_ACCOUNT = (
    "Claude Max and Team plans include monthly API credits. Anthropic recommends an API key for work that runs on its own, and a key from "
    "your Claude Console organization uses those credits (about 5 minutes in the Claude Console).",
    "Using Flux for work? In the EU and Switzerland, Claude's personal plans (Pro, Max) are for non-business use. A Team plan or an API key covers work.",
)


def signed_in(method: str, payer: str, auth: str) -> dict:
    return {"state": "signed_in", "signInMethod": method, "authMethod": auth, "plan": None, "accountLabel": None,
            "signedInAt": "2026-10-16T10:05:00.000Z", "payer": payer, "accountChange": None, "signOut": None}


def runtime_signed_in(claude: tuple[str, str, str], codex: tuple[str, str, str]) -> dict:
    return {**RUNTIME_ON, "binding": {"state": "active", "boundAt": "2026-10-16T10:00:00.000Z", "lastUsedAt": None, "idleReleaseAt": None},
            "connections": {"claude_code": signed_in(*claude), "codex": signed_in(*codex)}, "auth": {}}


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
        self.api(ines, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "agent", "id": agent["id"]}, "role": "contributor"}, status=201)
        connection = self.api(ines, "POST", "/api/v1/agent-connections", {"agentId": agent["id"], "selectedProjectIds": [project["id"]],
                              "scopes": ["flux.context.read", "flux.proposal.write"], "name": CONNECTION, "clientDesignation": "codex"}, status=201)
        type(self).ids = {"workspace": ws["id"], "project": project["id"], "agent": agent["id"], "connection": connection["id"]}

    def test_02_settings_has_two_sections_and_the_runtime_off_copy(self) -> None:
        page = self.page("ines")
        page.goto("/settings/agents")
        expect(page.get_by_role("heading", level=2, name="Agents and AI")).to_be_visible()
        flux = page.get_by_role("region", name=MODE_A, exact=True)
        app = page.get_by_role("region", name=MODE_B_PAGE, exact=True)
        expect(flux).to_be_visible()
        expect(app).to_be_visible()
        # Agent in Flux: the assistant, and the instance's switch said in one plain sentence (AST-1.2).
        card = flux.get_by_role("region", name=re.compile("^Your assistant"))
        expect(card.get_by_role("link", name="Set up", exact=True)).to_have_attribute("href", "/settings/assistant")
        expect(card.get_by_role("link", name="How it works")).to_have_attribute("href", "/settings/assistant/how")
        expect(flux).to_contain_text(OFF_SENTENCE)
        expect(flux.get_by_role("link", name=re.compile("^Sign in with"))).to_have_count(0)
        expect(flux.get_by_text("Sign in with Claude", exact=True)).to_have_count(0)
        expect(flux.get_by_text("Sign in with ChatGPT", exact=True)).to_have_count(0)
        # The API key choices are shown plainly when sign-in is off, and lead to the one AI connections page (#513).
        api_key = flux.get_by_role("link", name=re.compile("^Use an API key"))
        expect(api_key).to_be_visible()
        expect(api_key).to_have_attribute("href", "/settings/ai-connections")
        # AI setup starts with the assistant card (Spokój E04, #513 M4); the ways to connect follow it.
        self.assertTrue(self.above(card, flux.get_by_text(OFF_SENTENCE)), "the assistant card comes before the ways to connect")
        self.assertTrue(self.above(card, api_key))
        # Your agent app: mode (b) connections; no client guide with command-line words on this page.
        # #763 SG-6: the client and its Agent tag first, the device in the meta line ("Codex · for you · Ines desk laptop").
        expect(app.get_by_role("link", name=re.compile(f"^Codex.*for you · {CONNECTION}"))).to_have_attribute("href", "/connect-agent")
        expect(app.get_by_role("link", name="Local co-work on this computer")).to_have_attribute("href", "/connect-agent")
        expect(app).not_to_contain_text("claude mcp add")
        for text in (page.locator("main, .pane-in").first.inner_text(),):
            self.assertNotRegex(text, r"(?i)three ways", "no copy counts the ways wrongly")
        shot(page, "connect-ai-desktop-1440")

    def test_03_phone_width_keeps_both_sections_readable(self) -> None:
        page = self.page("ines", phone=True)
        page.goto("/settings/agents")
        expect(page.get_by_role("region", name=MODE_A, exact=True)).to_be_visible()
        expect(page.get_by_role("region", name=MODE_B_PAGE, exact=True)).to_be_visible()
        # #513 M4: on the phone the whole assistant card is on the first screen, before the ways to connect.
        card = page.get_by_role("region", name=re.compile("^Your assistant"))
        expect(card.get_by_role("link", name="How it works")).to_be_visible()
        card_box = card.bounding_box()
        self.assertIsNotNone(card_box)
        self.assertLessEqual(card_box["y"] + card_box["height"], PHONE["height"], f"the assistant card fits the first screen: {card_box}")
        self.assertTrue(self.above(card, page.get_by_text(OFF_SENTENCE)))
        self.no_horizontal_scroll(page)
        shot(page, "connect-ai-phone-390")
        page.goto("/settings")
        expect(page.get_by_role("link", name=re.compile("^Agents and AI"))).to_be_visible()
        self.no_horizontal_scroll(page)

    def test_04_details_and_the_assistant_empty_state_link_there(self) -> None:
        page = self.page("tom")
        # The private note composer lives in the Sketchbook (New > Private note opens it).
        page.goto("/map")
        ask = page.locator(".composer__ask")
        page.get_by_label("Private note", exact=True).fill("Which sensor works in the dark?")
        ask.click()
        panel = page.get_by_role("complementary", name="Details")
        link = panel.get_by_role("link", name=re.compile("^Ways to connect"))
        expect(link).to_have_attribute("href", "/settings/agents")
        link.click()
        expect(page).to_have_url(re.compile(r"/settings/agents$"))
        page.goto("/settings/assistant")
        empty = page.get_by_role("link", name="Ways to connect")
        expect(empty).to_have_attribute("href", "/settings/agents")
        empty.click()
        expect(page.get_by_role("region", name=MODE_A, exact=True)).to_be_visible()

    def test_05_no_ai_journey_nothing_connected(self) -> None:
        page = self.page("tom")
        page.goto("/settings/agents")
        flux = page.get_by_role("region", name=MODE_A, exact=True)
        app = page.get_by_role("region", name=MODE_B_PAGE, exact=True)
        expect(flux).to_contain_text("not set up")
        expect(flux).to_contain_text(OFF_SENTENCE)
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
        self.api(ines, "POST", "/api/v1/personal-assistant", {"consentVersion": CONSENT, "agentId": assistant["id"], "perRunCents": 8,
                 "dailyCapCents": 100, "timeZone": "Europe/Warsaw"}, status=201)
        ines.goto(f"/projects/{self.ids['project']}/agents")
        rows = ines.get_by_role("list", name="Agents in this project").get_by_role("listitem")
        # Project lists contain only MCP connections, even for the assistant owner (#522).
        expect(rows).to_have_count(1)
        expect(ines.get_by_text("Ines personal assistant", exact=False)).to_have_count(0)
        expect(ines.get_by_role("region", name="Assistant join requests")).to_have_count(0)
        expect(rows.filter(has_text=CONNECTION)).to_have_count(1)
        expect(rows.filter(has_text=CONNECTION)).to_contain_text("for Ines")
        # Settings keeps the owner’s assistant, payer and permitted project access reachable.
        ines.goto("/settings/agents")
        flux = ines.get_by_role("region", name=MODE_A, exact=True)
        expect(flux).to_contain_text("Paid by")
        expect(flux).to_contain_text("Assistant on")

    def test_07_a_second_member_never_sees_or_changes_the_first_members_connections(self) -> None:
        tom = self.page("tom")
        # What Tom sees: his own page, and the shared project's Agents view with Ines's connection read-only; not her assistant or keys.
        tom.goto("/settings/agents")
        flux = tom.get_by_role("region", name=MODE_A, exact=True)
        app = tom.get_by_role("region", name=MODE_B_PAGE, exact=True)
        expect(app).not_to_contain_text(CONNECTION)
        expect(app).not_to_contain_text("Ines")
        expect(flux).not_to_contain_text("Ines")
        expect(flux).not_to_contain_text("Assistant on")
        expect(flux).not_to_contain_text("Paid by")
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
        runtime = self.api(tom, "GET", "/api/v1/agent-runtime", status=200)
        self.assertIsNone(runtime.get("binding"))
        self.assertNotIn(INES["id"], json.dumps(runtime))
        revoke = tom.request.fetch(f"{ORIGIN}/api/v1/agent-connections/{self.ids['connection']}", method="DELETE", headers={"origin": ORIGIN})
        self.assertIn(revoke.status, (403, 404), revoke.text())
        # Control: the connection is still Ines's and still live.
        ines = self.page("ines")
        live = [item for item in self.api(ines, "GET", "/api/v1/agent-connections", status=200) if item["id"] == self.ids["connection"]]
        self.assertEqual(len(live), 1)
        self.assertIsNone(live[0].get("revokedAt"))

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
                        expect(page.get_by_role("region", name="Your assistant’s project access")).to_contain_text("Your assistant has access to this project.")
                        page.get_by_role("region", name="Your assistant’s project access").scroll_into_view_if_needed()
                        shot(page, f"assistant-own-settings-{'phone-390' if phone else 'desktop-1440'}-{UI_BROWSER}")

    def stub_runtime_on(self, page: Page, status: dict | None = None) -> None:
        """A stubbed status with the runtime on (the check suite runs with it off); the sign-in pages are not read here."""
        page.route(re.compile(r".*/api/v1/agent-runtime$"), lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(status or RUNTIME_ON)))

    def test_08_runtime_on_puts_the_sign_in_choices_first_at_both_widths(self) -> None:
        """AST-1.1: Sign in with Claude and Sign in with ChatGPT come first; API keys only under a folded "Other ways to connect"."""
        for phone in (False, True):
            width = "phone-390" if phone else "desktop-1440"
            page = self.page("ines", phone=phone)
            self.stub_runtime_on(page)
            page.goto("/settings/agents")
            flux = page.get_by_role("region", name=MODE_A, exact=True)
            expect(flux.get_by_role("heading", name=re.compile(r"Claude Code and Codex in Flux.*Claude Code not signed in.*Codex not signed in"))).to_be_visible()
            claude = flux.get_by_role("link", name=re.compile("^Sign in with Claude"))
            chatgpt = flux.get_by_role("link", name=re.compile("^Sign in with ChatGPT"))
            assistant = flux.get_by_role("region", name=re.compile("^Your assistant"))
            expect(claude).to_be_visible()
            expect(chatgpt).to_be_visible()
            # They open the guided sign-in; they are the first two choices of the list, and the only sign-in ones.
            expect(claude).to_have_attribute("href", "/settings/agents/claude-code")
            expect(chatgpt).to_have_attribute("href", "/settings/agents/codex")
            choices = flux.locator("ul.rt-choices > li")
            expect(choices).to_have_count(2)
            expect(choices.nth(0)).to_contain_text("Sign in with Claude")
            expect(choices.nth(1)).to_contain_text("Sign in with ChatGPT")
            expect(flux).not_to_contain_text(OFF_SENTENCE)
            self.assertTrue(self.above(claude, chatgpt), "Sign in with Claude is above Sign in with ChatGPT")
            # Spokój E04 (#513 M4): AI setup starts with the assistant card; the sign-in choices follow it, still
            # before every API key choice (AST-1.1).
            self.assertTrue(self.above(assistant, claude), "the assistant card is above the sign-in choices")
            # Negative control: the same check must reject the reverse order of two elements that are really in that order.
            self.assertFalse(self.above(chatgpt, claude), "negative control: reversed order is rejected")
            # The API key choices are folded under "Other ways to connect" and not visible until opened.
            other = flux.locator("details.rt-more").filter(has_text="Other ways to connect")
            expect(other.locator("summary")).to_have_text("Other ways to connect")
            self.assertFalse(other.evaluate("d => d.open"), "Other ways to connect starts folded")
            api = flux.get_by_role("link", name=re.compile("^Use an API key"))
            expect(api).to_be_hidden()
            which = flux.locator("details").filter(has_text="Which account should I use?")
            self.assertFalse(which.evaluate("d => d.open"), "Which account should I use? starts folded")
            self.no_horizontal_scroll(page)
            shot(page, f"connect-ai-runtime-on-{width}")
            other.locator("summary").click()
            expect(api).to_be_visible()
            self.assertTrue(self.above(claude, api), "API key choices come after the sign-in choices")
            self.assertTrue(self.above(chatgpt, api), "and after the ChatGPT one")
            # Which account should I use? is one folded line in plain words, exactly the spec's copy (AST-1).
            which.locator("summary").click()
            notes = which.locator("p")
            expect(notes).to_have_count(len(WHICH_ACCOUNT))
            for index, text in enumerate(WHICH_ACCOUNT):
                self.assertEqual(notes.nth(index).inner_text().replace("’", "'"), text)
            self.no_horizontal_scroll(page)
            shot(page, f"connect-ai-runtime-on-{width}-open")
            page.context.close()

    def test_08b_runtime_off_says_so_once_and_shows_the_api_key_choices_at_both_widths(self) -> None:
        """AST-1.2: with the runtime off (the check stack's own setting, no stub) the page shows one plain sentence and the API key
        choices, in the open; no sign-in button is shown. Nothing on Home or in the assistant's set-up promises the plan."""
        for phone in (False, True):
            page = self.page("ines", phone=phone)
            page.goto("/settings/agents")
            flux = page.get_by_role("region", name=MODE_A, exact=True)
            sentence = flux.get_by_text(OFF_SENTENCE, exact=True)
            expect(sentence).to_have_count(1)
            self.assertEqual(sentence.evaluate("el => el.tagName"), "P", "the sentence is one plain paragraph")
            self.assertEqual(flux.locator("p", has_text="Signing in with").count(), 1, "and the page says it once")
            self.assertIsNone(re.search(r"Sign in\b", flux.inner_text()), "no sign-in wording at all while the runtime is off")
            expect(flux.get_by_role("button", name=re.compile("^Sign in", re.I))).to_have_count(0)
            expect(flux.get_by_role("link", name=re.compile("^Sign in", re.I))).to_have_count(0)
            expect(flux.locator("ul.rt-choices")).to_have_count(0)
            api = flux.get_by_role("link", name=re.compile("^Use an API key"))
            expect(api).to_be_visible()  # shown plainly: not inside a folded "Other ways to connect"
            expect(api).to_have_attribute("href", "/settings/ai-connections")
            self.assertEqual(api.evaluate("el => !!el.closest('details')"), False, "the API key choice is not folded away")
            expect(flux.get_by_text("Other ways to connect")).to_have_count(0)
            self.assertTrue(self.above(sentence, api), "the sentence comes before the API key choices")
            self.no_horizontal_scroll(page)
            for path, heading in (("/", page.get_by_role("heading", level=1, name="Home")), ("/settings/assistant", page.get_by_role("heading", name="Your assistant", exact=True))):
                page.goto(path)
                expect(heading).to_be_visible()
                text = page.locator("main, .pane-in").first.inner_text()
                self.assertIsNone(re.search(r"plan you already (have|pay for)", text), f"{path} does not promise the plan you already have")
            page.context.close()

    def test_08c_plain_account_labels_with_the_payer_text_as_the_longer_line(self) -> None:
        """AST-1 plain account labels: Claude / ChatGPT subscription, Anthropic Console API billing, OpenAI API key. The F-022 payer
        text stays as the longer line of the account row."""
        cases = (
            (runtime_signed_in(("claude_account", "claude_plan", "claude.ai"), ("device_code", "chatgpt_plan", "chatgpt")),
             "Claude · your subscription", "ChatGPT · your subscription",
             "Your Claude plan (plan limits or paid extra usage, not visible to Flux).", "Your ChatGPT plan (plan limits or credits, not visible to Flux)."),
            (runtime_signed_in(("console", "anthropic_console", "api_key"), ("api_key", "openai_api", "api_key")),
             "Anthropic Console · API billing", "OpenAI · API key",
             "Your Anthropic Console organization (API billing, cost not reported to Flux).", "Your OpenAI API organization (API billing, cost not reported to Flux)."),
        )
        for phone in (False, True):
            for index, (status, claude_label, codex_label, claude_payer, codex_payer) in enumerate(cases):
                page = self.page("ines", phone=phone)
                self.stub_runtime_on(page, status)
                page.goto("/settings/agents")
                flux = page.get_by_role("region", name=MODE_A, exact=True)
                expect(flux.get_by_role("heading", name=re.compile(r"Claude Code and Codex in Flux.*Claude Code signed in.*Codex signed in"))).to_be_visible()
                mine = flux.get_by_role("list", name="Your sign-in")
                codex = flux.get_by_label("Codex in Flux").get_by_role("list", name="Your Codex sign-in")
                expect(mine).to_contain_text(claude_label)
                expect(mine).to_contain_text(claude_payer)
                expect(codex).to_contain_text(codex_label)
                expect(codex).to_contain_text(codex_payer)
                self.assertEqual(mine.locator("li").first.locator("b").inner_text(), claude_label, "the label leads its row")
                self.assertEqual(codex.locator("li").first.locator("b").inner_text(), codex_label)
                self.assertGreater(len(claude_payer), len(claude_label), "the payer text is the longer line")
                self.assertIsNone(JARGON.search(claude_label + " " + codex_label), "and the labels use no jargon")
                self.no_horizontal_scroll(page)
                if index == 1:
                    shot(page, f"connect-ai-labels-{'phone-390' if phone else 'desktop-1440'}")
                page.context.close()

    def test_09_the_page_uses_no_jargon_words_with_runtime_on_or_off(self) -> None:
        """AST-10.2 (#277): no visible text on the page uses the listed words; scanner negative control first."""
        self.assertIsNotNone(JARGON.search("Ask the MCP server"), "negative control: the scanner flags a jargon word")
        self.assertIsNotNone(JARGON.search("Your runtime"), "negative control: the scanner flags runtime")
        self.assertIsNone(JARGON.search("Use an API key. API keys and API credits, API billing, Claude · your subscription"), "allowed API phrases pass")
        for runtime_on in (False, True):
            for phone in (False, True):
                page = self.page("ines", phone=phone)
                if runtime_on:
                    self.stub_runtime_on(page)
                page.goto("/settings/agents")
                expect(page.get_by_role("region", name=MODE_A, exact=True)).to_be_visible()
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
            live = on.get_by_role("region", name=re.compile("^Your assistant"))
            # test_06 turned Ines's assistant on, so the live card offers Manage.
            step = live.get_by_role("link", name="Manage", exact=True)
            expect(step).to_be_visible()
            expect(live.locator(".sset-assistant__facts li")).to_have_count(3)
            real = self.api(on, "GET", "/api/v1/personal-assistant", status=200)
            self.assertIsNotNone(real["enablement"], "test_06 turned Ines's assistant on")
            off = {**real, "state": "unavailable", "setup": {"provider": "off", "connection": "none"}}
            # Nothing set up: Set up stays where it is, dimmed.
            page = self.page("ines", phone=phone)
            stub(page, {**off, "enablement": None})
            page.goto("/settings/agents")
            card = page.get_by_role("region", name=re.compile("^Your assistant"))
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
            card = managed.get_by_role("region", name=re.compile("^Your assistant"))
            one_off_line(card, "Manage")
            manage = card.get_by_role("link", name="Manage", exact=True)
            expect(manage).to_have_attribute("href", "/settings/assistant")
            expect(card.get_by_role("button", name="Set up")).to_have_count(0)
            same_place(step.bounding_box(), manage.bounding_box())

    def above(self, first, second) -> bool:
        a = first.bounding_box()
        b = second.bounding_box()
        self.assertIsNotNone(a, "first element is visible")
        self.assertIsNotNone(b, "second element is visible")
        return a["y"] < b["y"]



    def test_10_phone_counts_clients_and_refreshes_after_final_mcp_revocation(self) -> None:
        owner = self.page("ines", phone=True)
        owner.goto(f"/projects/{self.ids['project']}/agents")
        self.assertIn(self.ids["assistant_agent"], [person["id"] for person in self.api(owner, "GET", f"/api/v1/projects/{self.ids['project']}/people", status=200)], "own assistant remains in the authorized audience")
        extra = self.api(owner, "POST", "/api/v1/agent-connections", {"agentId": self.ids["agent"], "selectedProjectIds": [self.ids["project"]],
                         "scopes": ["flux.context.read"], "name": "Ines second client", "clientDesignation": "claude_code"}, status=201)
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
