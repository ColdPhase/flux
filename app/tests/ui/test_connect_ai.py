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
RUNTIME_ON = {"enabled": True, "clients": {"claude_code": "available", "codex": "pending"}, "commercialTerms": None,
              "idleReleaseDays": None, "pool": "available", "binding": None, "lastRelease": None,
              "connections": {"claude_code": None, "codex": None}}


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
        expect(flux.get_by_role("link", name=re.compile("^Your assistant Agent"))).to_have_attribute("href", "/settings/assistant")
        expect(flux).to_contain_text(OFF_SENTENCE)
        expect(flux.get_by_role("link", name=re.compile("^Sign in with"))).to_have_count(0)
        expect(flux.get_by_text("Sign in with Claude", exact=True)).to_have_count(0)
        expect(flux.get_by_text("Sign in with ChatGPT", exact=True)).to_have_count(0)
        # The API key choices are shown plainly when sign-in is off.
        expect(flux.get_by_role("link", name=re.compile("^Use an API key"))).to_be_visible()
        # Your agent app: mode (b) connections; no client guide with command-line words on this page.
        expect(app.get_by_role("link", name=re.compile(f"^{CONNECTION}"))).to_have_attribute("href", "/connect-agent")
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
        self.no_horizontal_scroll(page)
        shot(page, "connect-ai-phone-390")
        page.goto("/settings")
        expect(page.get_by_role("link", name="Local co-work on this computer")).to_be_visible()
        self.no_horizontal_scroll(page)

    def test_04_details_and_the_assistant_empty_state_link_there(self) -> None:
        page = self.page("tom")
        page.goto("/")
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
        # Human work goes on: the project opens and the Agents view says nothing is connected.
        page.goto(f"/projects/{self.ids['project']}/agents")
        expect(page.get_by_role("heading", level=1, name="Working together")).to_be_visible()

    def test_06_the_agents_view_shows_each_entrys_mode(self) -> None:
        ines = self.page("ines")
        status = self.api(ines, "GET", "/api/v1/personal-assistant", status=200)
        self.assertEqual(status["state"], "not_enabled")
        self.api(ines, "POST", "/api/v1/personal-assistant", {"consentVersion": CONSENT, "agentId": self.ids["agent"], "perRunCents": 6,
                 "dailyCapCents": 100, "timeZone": "Europe/Warsaw"}, status=201)
        ines.goto(f"/projects/{self.ids['project']}/agents")
        rows = ines.get_by_role("list", name="Agent connections in this project").get_by_role("listitem")
        expect(rows).to_have_count(2)
        mine = rows.filter(has_text="Your assistant")
        expect(mine).to_contain_text(MODE_A)
        expect(mine).to_contain_text("Ines Moreau (you)")
        mcp = rows.filter(has_text=CONNECTION)
        expect(mcp).to_contain_text(MODE_B)
        shot(ines, "connect-ai-agents-view-1440")
        # The settings page lists the same assistant with its AI connection, its payer and each use.
        ines.goto("/settings/agents")
        flux = ines.get_by_role("region", name=MODE_A, exact=True)
        expect(flux).to_contain_text("Paid by")
        expect(flux).to_contain_text("Assistant on")

    def test_07_a_second_member_never_sees_or_changes_the_first_members_connections(self) -> None:
        tom = self.page("tom")
        # What Tom sees: his own page and the shared project's Agents view, not Ines's assistant or keys.
        tom.goto("/settings/agents")
        flux = tom.get_by_role("region", name=MODE_A, exact=True)
        app = tom.get_by_role("region", name=MODE_B_PAGE, exact=True)
        expect(app).not_to_contain_text(CONNECTION)
        expect(app).not_to_contain_text("Ines")
        expect(flux).not_to_contain_text("Ines")
        expect(flux).not_to_contain_text("Assistant on")
        expect(flux).not_to_contain_text("Paid by")
        tom.goto(f"/projects/{self.ids['project']}/agents")
        rows = tom.get_by_role("list", name="Agent connections in this project").get_by_role("listitem")
        expect(rows.filter(has_text="Your assistant")).to_have_count(0)
        expect(rows.filter(has_text=MODE_A)).to_have_count(0)
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

    def stub_runtime_on(self, page: Page) -> None:
        """A stubbed status with the runtime on (the check suite runs with it off); the sign-in pages are not read here."""
        page.route(re.compile(r".*/api/v1/agent-runtime$"), lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(RUNTIME_ON)))

    def test_08_runtime_on_puts_the_sign_in_choices_first_at_both_widths(self) -> None:
        """AST-1.1: Sign in with Claude and Sign in with ChatGPT come first; API keys only under a folded "Other ways to connect"."""
        for phone in (False, True):
            page = self.page("ines", phone=phone)
            self.stub_runtime_on(page)
            page.goto("/settings/agents")
            flux = page.get_by_role("region", name=MODE_A, exact=True)
            claude = flux.get_by_role("link", name=re.compile("^Sign in with Claude"))
            chatgpt = flux.get_by_text("Sign in with ChatGPT", exact=True)
            assistant = flux.get_by_role("link", name=re.compile("^Your assistant Agent"))
            expect(claude).to_be_visible()
            expect(chatgpt).to_be_visible()
            expect(flux).not_to_contain_text(OFF_SENTENCE)
            self.assertTrue(self.above(claude, chatgpt), "Sign in with Claude is above Sign in with ChatGPT")
            self.assertTrue(self.above(chatgpt, assistant), "the sign-in choices are above the assistant row")
            # Negative control: the same check must reject the reverse order of two elements that are really in that order.
            self.assertFalse(self.above(chatgpt, claude), "negative control: reversed order is rejected")
            # The API key choices are folded under "Other ways to connect" and not visible until opened.
            other = flux.locator("details.rt-more").filter(has_text="Other ways to connect")
            expect(other.locator("summary")).to_have_text("Other ways to connect")
            self.assertFalse(other.evaluate("d => d.open"), "Other ways to connect starts folded")
            api = flux.get_by_role("link", name=re.compile("^Use an API key"))
            expect(api).to_be_hidden()
            other.locator("summary").click()
            expect(api).to_be_visible()
            self.assertTrue(self.above(claude, api), "API key choices come after the sign-in choices")
            # Which account should I use? is one folded line in plain words (AST-1 "Which account").
            which = flux.locator("details").filter(has_text="Which account should I use?")
            self.assertFalse(which.evaluate("d => d.open"))
            which.locator("summary").click()
            expect(flux).to_contain_text("Max and Team plans include monthly API credits")
            expect(flux).to_contain_text("non-business use")
            self.no_horizontal_scroll(page)
            if phone:
                shot(page, "connect-ai-runtime-on-phone-390")
            else:
                shot(page, "connect-ai-runtime-on-desktop-1440")
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

    def above(self, first, second) -> bool:
        a = first.bounding_box()
        b = second.bounding_box()
        self.assertIsNotNone(a, "first element is visible")
        self.assertIsNotNone(b, "second element is visible")
        return a["y"] < b["y"]


if __name__ == "__main__":
    unittest.main()
