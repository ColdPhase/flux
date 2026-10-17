"""Browser tests for the assistant screen and its journeys (F-027 A7, #407; AST-10).

The check_ui.sh stack has no agent runtime, so the owner's enablement, switches and answers are stubbed
responses (as in test_assistant_runtime). This proves the words, the flow and the layout at both widths;
tests/app/assistant-settings.test.ts proves the switches against the real store.
"""

from __future__ import annotations

import copy
import json
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, Route, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "my own claude plan"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Brandt", "email": f"ada.screen+{STAMP}@example.test"}
FORBIDDEN = re.compile(r"\b(scope|grant|MCP|token|capability|execute|runtime|transport|OAuth|policy|proposal|payload|slot|job|reaction|cron)\b", re.I)
NOW = "2026-10-16T09:00:00.000Z"
UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")


class AssistantScreen(unittest.TestCase):
    """Tests run in name order and share one account."""

    pw = None
    browser: Browser
    state: dict | None = None
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

    def context(self, *, phone: bool = False, dark: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "UTC"}
        options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP, device_scale_factor=1)
        if self.state:
            options["storage_state"] = self.state
        context = self.browser.new_context(service_workers="block", **options)
        self.addCleanup(context.close)
        return context

    def page(self, **kwargs) -> Page:
        page = self.context(**kwargs).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def json(self, route: Route, body: dict, status: int = 200) -> None:
        route.fulfill(status=status, content_type="application/json", body=json.dumps(body))

    # ---------------------------------------------------------------- stubs

    def status(self, page: Page, *, enabled: bool, paused: bool = False, runtime: str = "signed_in") -> dict:
        stub = copy.deepcopy(self.api(page, "GET", "/api/v1/personal-assistant", status=200))
        stub["setup"] = {"provider": "off", "connection": "none", "runtime": {"state": runtime, "payer": "claude_plan", "accountLabel": "a***@example.test", "client": "claude_code"}}
        if enabled:
            stub.update(state="paused" if paused else "ready", unavailableReason=None, today={"chargedMicros": 0, "reservedMicros": 0, "capCents": 100, "resetsAt": NOW}, enablement={
                "ownerUserId": ADA["id"], "connectionId": None, "engine": "runtime", "status": "active", "perRunCents": 6, "dailyCapCents": 100, "timeZone": "UTC",
                "consent": {"version": "f-022-runtime-2026-10-16", "acceptedAt": NOW, "provider": "anthropic", "model": "claude-code",
                            "payer": {"organization": "Your Claude plan", "workspace": "a***@example.test"}},
                "agents": [{"workspaceId": self.ids["workspace"], "agentId": self.ids["agent"]}], "version": 1, "createdAt": NOW, "updatedAt": NOW})
        else:
            stub.update(state="not_enabled", unavailableReason=None, enablement=None, today=None)
        return stub

    def stub_assistant(self, page: Page, *, enabled: bool = True, runtime: str = "signed_in") -> dict:
        """Status, settings (GET and PATCH keep their own version) and pause/resume, all in memory."""
        world = {"status": self.status(page, enabled=enabled, runtime=runtime), "patches": [], "pauses": [],
                 "settings": {"workspaceId": self.ids["workspace"], "ownerUserId": ADA["id"], "agentId": self.ids["agent"], "connectionId": "c", "approvalMode": "act",
                              "changesPerRun": 20, "backgroundRunsPerDay": 24, "projectMode": "all", "version": 1, "createdAt": NOW, "updatedAt": NOW,
                              "areas": {"tasks": "edit", "wiki": "edit", "maps": "edit", "conversations": "edit", "decisions": "edit"}, "policy": {}}}

        def status(route: Route) -> None:
            self.json(route, world["status"]) if route.request.method == "GET" else route.continue_()

        def settings(route: Route) -> None:
            if route.request.method == "PATCH":
                patch = json.loads(route.request.post_data or "{}")
                world["patches"].append(patch)
                current = world["settings"]
                current["areas"].update(patch.get("areas", {}))
                if "approvalMode" in patch:
                    current["approvalMode"] = patch["approvalMode"]
                current["version"] += 1
            self.json(route, world["settings"])

        def pause(route: Route) -> None:
            world["pauses"].append(route.request.url.rsplit("/", 1)[-1])
            world["status"]["state"] = "paused" if route.request.url.endswith("/pause") else "ready"
            self.json(route, world["status"])

        page.route("**/api/v1/personal-assistant", status)
        page.route("**/api/v1/personal-assistant/pause", pause)
        page.route("**/api/v1/personal-assistant/resume", pause)
        page.route(re.compile(r".*/api/v1/workspaces/[0-9a-f-]{36}/assistants/[0-9a-f-]{36}/settings$"), settings)
        return world

    def answer(self, owner: str, owner_name: str, label: str) -> dict:
        return {"runId": str(uuid.uuid4()), "conversationId": self.ids["conversation"], "projectId": self.ids["project"], "audience": {"kind": "project", "projectId": self.ids["project"]},
                "assistant": {"ownerUserId": owner, "label": label}, "askedBy": {"id": owner, "name": owner_name},
                "request": {"kind": "ask", "prompt": "What do the notes say about the sensor?"}, "body": "The notes favour the ToF sensor.", "truncated": False,
                "provenance": {"provider": "anthropic", "model": "claude-code"}, "sources": [], "proposalId": None, "committedAt": NOW}

    def stub_thread(self, page: Page, answers: list[dict]) -> None:
        page.route(re.compile(r".*/api/v1/conversations/[0-9a-f-]{36}/assistant-answers\?.*"), lambda route: self.json(route, {"items": answers, "total": len(answers), "limit": 100, "offset": 0}))
        page.route(re.compile(r".*/api/v1/assistant-runs\?limit=\d+$"), lambda route: self.json(route, {"items": [], "total": 0, "limit": 10, "offset": 0}))

    def thread_url(self) -> str:
        return f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}"

    def no_horizontal_scroll(self, page: Page) -> None:
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"))

    def tag(self, phone: bool, dark: bool = False) -> str:
        return f"{'390' if phone else '1440'}-{'dark' if dark else 'light'}"

    # ---------------------------------------------------------------- tests

    def test_01_an_owner_with_a_project(self) -> None:
        page = self.page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill(ADA["name"])
        page.get_by_label("Email").fill(ADA["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).state = page.context.storage_state()
        ADA["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        ws = self.api(page, "POST", "/api/v1/workspaces", {"name": "Lamp studio"}, status=201)
        project = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Gesture lamp", "visibility": "restricted"}, status=201)
        thread = self.api(page, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": "Camera or ToF sensor for the bedside lamp?", "clientMessageId": str(uuid.uuid4())}, status=201)
        agent = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/agents", {"name": "Ada's assistant", "owner": "self"}, status=201)
        type(self).ids = {"workspace": ws["id"], "project": project["id"], "conversation": thread["id"], "agent": agent["id"]}

    def test_02_home_offers_the_assistant_once_and_not_now_is_remembered(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                self.stub_assistant(page, enabled=False)
                page.goto("/")
                card = page.get_by_role("region", name="Meet your assistant")
                expect(card).to_contain_text("It works inside Flux with the Claude or ChatGPT plan you already have.")
                expect(card.get_by_role("link", name="Set up")).to_have_attribute("href", "/settings/assistant")
                self.no_horizontal_scroll(page)
                shot(page, f"home-card-{self.tag(phone)}")
                card.get_by_role("button", name="Not now").click()
                expect(card).to_have_count(0)
                page.reload()
                expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
                expect(page.get_by_role("region", name="Meet your assistant")).to_have_count(0)

    def test_03_without_subscription_sign_in_the_card_promises_no_plan(self) -> None:
        page = self.page()
        world = self.stub_assistant(page, enabled=False, runtime="off")
        world["status"]["setup"]["provider"] = "on"
        page.goto("/")
        card = page.get_by_role("region", name="Meet your assistant")
        expect(card).to_contain_text("It works inside Flux with your AI account.")
        expect(card).not_to_contain_text("plan you already have")

    def test_04_the_screen_has_the_account_the_approval_choice_and_five_switches(self) -> None:
        for phone, dark in ((False, False), (True, False), (False, True), (True, True)):
            with self.subTest(phone=phone, dark=dark):
                page = self.page(phone=phone, dark=dark)
                world = self.stub_assistant(page)
                page.goto("/settings/assistant")
                expect(page.get_by_role("heading", name=re.compile("Ada.s assistant"))).to_be_visible()
                expect(page.get_by_text("for you · in Flux")).to_be_visible()
                expect(page.get_by_text("Claude · your subscription")).to_be_visible()
                expect(page.get_by_text("Flux can't see your plan's limits.")).to_be_visible()
                expect(page.get_by_role("switch", name="Your assistant is on")).to_have_attribute("aria-checked", "true")
                group = page.get_by_role("radiogroup", name="When it changes something")
                expect(group.get_by_role("radio", name="Do it and tell me")).to_have_attribute("aria-checked", "true")
                expect(page.get_by_text("It asks before removing anything or changing things other people made or are responsible for.")).to_be_visible()
                for label in ("Read and edit tasks", "Read and edit the Wiki", "Read and edit maps", "Read conversations and reply", "Read decisions and suggest new ones"):
                    expect(page.get_by_role("switch", name=label)).to_have_attribute("aria-checked", "true")
                can = page.get_by_test_id("assistant-can")
                expect(can).to_have_text("Read and edit tasks, the Wiki and maps, reply in conversations, suggest decisions. Asks before removing anything or changing things other people made or are responsible for. Can't accept decisions or invite people.")
                # Targets of at least 44 px, no horizontal scroll, the rest folded under More.
                self.assertGreaterEqual(group.get_by_role("radio").first.bounding_box()["height"], 44)
                for name in ("Read and edit the Wiki", "Your assistant is on"):
                    row = page.get_by_role("switch", name=name).locator("xpath=ancestor::*[contains(@class,'sset-row')][1]")
                    self.assertGreaterEqual(row.bounding_box()["height"], 44, name)
                expect(page.locator("details.aset__more")).not_to_have_attribute("open", "")
                self.no_horizontal_scroll(page)
                shot(page, f"screen-{self.tag(phone, dark)}")
                self.assertEqual(world["patches"], [])
                text = page.locator(".pane-in").inner_text()
                self.assertIsNone(FORBIDDEN.search(text), FORBIDDEN.search(text))

    def test_05_allowing_wiki_edits_is_two_taps_and_the_can_sentence_follows(self) -> None:
        page = self.page()
        world = self.stub_assistant(page)
        world["settings"]["areas"]["wiki"] = "off"
        page.goto("/settings/assistant")
        wiki = page.get_by_role("switch", name="Read and edit the Wiki")
        expect(wiki).to_have_attribute("aria-checked", "false")
        expect(page.get_by_test_id("assistant-can")).to_contain_text("Read and edit tasks and maps, reply in conversations")
        wiki.click()
        expect(wiki).to_have_attribute("aria-checked", "true")
        expect(page.get_by_test_id("assistant-can")).to_contain_text("Read and edit tasks, the Wiki and maps")
        self.assertEqual(world["patches"], [{"areas": {"wiki": "edit"}, "expectedVersion": 1}])

    def test_06_the_approval_choice_is_a_radio_group_with_arrow_keys(self) -> None:
        page = self.page()
        world = self.stub_assistant(page)
        page.goto("/settings/assistant")
        first = page.get_by_role("radio", name="Do it and tell me")
        first.focus()
        page.keyboard.press("ArrowRight")
        expect(page.get_by_role("radio", name="Ask me first")).to_have_attribute("aria-checked", "true")
        expect(page.get_by_test_id("assistant-can")).to_contain_text("Asks before changing anything.")
        expect(page.get_by_role("radio", name="Ask me first")).to_be_focused()
        self.assertEqual(world["patches"][-1]["approvalMode"], "ask")

    def test_07_one_switch_pauses_and_resumes_everything(self) -> None:
        page = self.page(phone=True)
        world = self.stub_assistant(page)
        page.goto("/settings/assistant")
        power = page.get_by_role("switch", name="Your assistant is on")
        power.click()
        expect(power).to_have_attribute("aria-checked", "false")
        power.click()
        expect(power).to_have_attribute("aria-checked", "true")
        self.assertEqual(world["pauses"], ["pause", "resume"])

    def test_08_at_my_assistant_comes_first_and_starts_an_ask(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                self.stub_assistant(page)
                self.stub_thread(page, [])
                page.goto(self.thread_url())
                box = page.get_by_placeholder(re.compile("Reply in thread"))
                box.fill("@")
                options = page.get_by_role("listbox", name="Mention").get_by_role("option")
                expect(options.first).to_contain_text("My assistant")
                expect(options.first).to_contain_text("Agent · for you")
                shot(page, f"at-list-{self.tag(phone)}")
                options.first.click()
                expect(page.get_by_placeholder("Ask your assistant…")).to_be_visible()
                self.stub_thread(page, [])

    def test_09_at_my_assistant_leads_to_set_up_when_it_is_not_set_up(self) -> None:
        page = self.page()
        self.stub_assistant(page, enabled=False)
        self.stub_thread(page, [])
        page.goto(self.thread_url())
        page.get_by_placeholder(re.compile("Reply in thread")).fill("@my")
        option = page.get_by_role("listbox", name="Mention").get_by_role("option").first
        expect(option).to_contain_text("My assistant")
        expect(option).to_contain_text("Set up")
        option.click()
        expect(page).to_have_url(re.compile(r"/settings/assistant$"))

    def test_10_command_k_asks_my_assistant_in_the_open_thread(self) -> None:
        page = self.page()
        self.stub_assistant(page)
        self.stub_thread(page, [])
        page.goto(self.thread_url())
        expect(page.get_by_placeholder(re.compile("Reply in thread"))).to_be_visible()
        page.keyboard.press("Control+k")
        option = page.get_by_role("option", name=re.compile("Ask my assistant…"))
        expect(option).to_be_visible()
        option.click()
        expect(page.get_by_placeholder("Ask your assistant…")).to_be_visible()
        expect(page).to_have_url(re.compile(r"/conversations/[0-9a-f-]{36}$"))

    def test_11_the_panel_shows_now_recent_can_and_pauses_in_two_taps(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                world = self.stub_assistant(page)
                self.stub_thread(page, [self.answer(ADA["id"], "Ada Brandt", "Ada's assistant")])
                page.goto(self.thread_url())
                header = page.locator(".assistant-answer__asked")
                expect(header).to_contain_text("for you · Claude")
                page.get_by_role("button", name="Ada's assistant", exact=True).click()
                panel = page.get_by_role("group", name="Ada's assistant, details")
                for heading in ("Now", "Recent", "Can"):
                    expect(panel.get_by_role("heading", name=heading, exact=True)).to_be_visible()
                expect(panel.get_by_test_id("assistant-can")).to_have_text("Read and edit tasks, the Wiki and maps, reply in conversations, suggest decisions. Asks before removing anything or changing things other people made or are responsible for. Can't accept decisions or invite people.")
                shot(page, f"panel-{self.tag(phone)}")
                panel.get_by_role("button", name="Pause my assistant").click()
                expect(panel.get_by_role("button", name="Resume my assistant")).to_be_visible()
                self.assertEqual(world["pauses"], ["pause"])
                self.assertIsNone(FORBIDDEN.search(panel.inner_text()))
                panel.get_by_role("button", name="Resume my assistant").click()
                panel.get_by_role("button", name="Message").click()
                expect(page.get_by_placeholder("Ask your assistant…")).to_be_visible()

    def test_12_everyone_sees_the_company_and_who_pays_in_the_header(self) -> None:
        page = self.page()
        self.stub_assistant(page)
        self.stub_thread(page, [self.answer(str(uuid.uuid4()), "Jonas Weiss", "Jonas's assistant")])
        page.goto(self.thread_url())
        expect(page.locator(".assistant-answer__asked")).to_contain_text("for Jonas Weiss · Claude")
        page.get_by_role("button", name="Jonas's assistant", exact=True).click()
        panel = page.get_by_role("group", name="Jonas's assistant, details")
        expect(panel.get_by_test_id("assistant-others")).to_have_text("Uses Claude through Jonas Weiss's account. What it reads here goes to Anthropic.")
        expect(panel.get_by_role("button", name="Pause my assistant")).to_have_count(0)
        shot(page, "panel-others-1440-light")


if __name__ == "__main__":
    unittest.main()
