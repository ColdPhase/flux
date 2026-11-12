"""Browser tests for the assistant's model (F-027 AST-11, #596; #854 grouped by connection): one model, chosen at turn-on and changed
everywhere, from any of the person's connections.

Same stubbed-engine approach as test_assistant_screen: the model endpoint is an in-memory world that applies the server's rules
(only a listed model, the previous one stays on a refusal), so these prove the words, the taps and the layout at both widths.
tests/app/personal-runs-providers.test.ts and tests/app/agent-runtime-runs*.test.ts prove the rules and the command against the real store.
"""

from __future__ import annotations

import json
import re
import unittest
import uuid

from playwright.sync_api import Page, Route, expect

import test_assistant_screen as base
from test_assistant_screen import pick_suggestion
from test_app_shell import shot
from touch_targets import has_minimum_touch_size

FORBIDDEN = base.FORBIDDEN
NOW = base.NOW

CLAUDE = [
    {"id": "sonnet", "name": "Sonnet", "note": "Everyday work", "callsTools": True},
    {"id": "opus", "name": "Opus", "note": "Harder requests", "callsTools": True},
    {"id": "haiku", "name": "Haiku", "note": "Quick, simple requests", "callsTools": True},
]
CODEX = [
    {"id": "gpt-6.1-sol", "name": "GPT-6.1 Sol", "note": "Everyday work", "callsTools": True},
    {"id": "gpt-6-astra", "name": "GPT-6 Astra", "note": "The hardest requests", "callsTools": True},
]
CLAUDE_PLAN = {"connection": "claude_plan", "account": "claude_plan", "label": "Claude plan", "company": "Claude"}
CHATGPT_PLAN = {"connection": "chatgpt_plan", "account": "chatgpt_plan", "label": "ChatGPT plan", "company": "ChatGPT"}
KEY = {"connection": "4c1f0a52-7d3e-4b8a-9f61-2e5d8c7b9a10", "account": "api_key", "label": "Work Anthropic", "company": "Anthropic"}
API = [
    {"id": "claude-sonnet-5", "name": "Sonnet 5", "note": "Your connection's model", "callsTools": True},
    {"id": "gpt-6-astra", "name": "GPT-6 Astra", "note": "Input $10, output $50 per 1M tokens", "callsTools": False},
]


class AssistantModel(unittest.TestCase):
    """Tests run in name order and share one account (the harness is test_assistant_screen's)."""

    state: dict | None = None
    ids: dict[str, str] = {}
    setUpClass = classmethod(base.AssistantScreen.setUpClass.__func__)
    tearDownClass = classmethod(base.AssistantScreen.tearDownClass.__func__)
    pw = None
    for _name in ("context", "page", "api", "json", "status", "stub_assistant", "answer", "stub_thread", "thread_url", "no_horizontal_scroll", "tag"):
        locals()[_name] = getattr(base.AssistantScreen, _name)
    del _name

    def test_01_an_owner_with_a_project(self) -> None:
        original = base.ADA["email"]
        base.ADA["email"] = original.replace("ada.screen", "ada.model")
        try:
            base.AssistantScreen.test_01_an_owner_with_a_project(self)
        finally:
            base.ADA["email"] = original

    # ---------------------------------------------------------------- stubs

    def stub_model(self, page: Page, *, saved: bool = True, current: str = "sonnet", options: list[dict] | None = None, refuse: dict | None = None,
                   group: dict | None = None, more: list[tuple[dict, list[dict]]] | None = None) -> dict:
        """GET and PUT of the model, applying the server's rules: only a model in a connection's list, and the previous one stays on
        a refusal. One group per connection (#854): the first is the given one (the Claude plan by default), then `more`."""
        head = group or CLAUDE_PLAN
        listed = options if options is not None else CLAUDE
        groups = [{**head, "options": listed}, *({**extra, "options": items} for extra, items in (more or []))]
        world = {"choice": {"current": {"connection": head["connection"], "model": current} if current else None,
                            "default": {"connection": head["connection"], "model": listed[0]["id"]} if listed else None,
                            "groups": groups, "saved": saved}, "puts": [], "gets": 0, "refuse": refuse}

        def model(route: Route) -> None:
            if route.request.method == "GET":
                world["gets"] += 1
                self.json(route, world["choice"])
                return
            if page.evaluate("!navigator.onLine"):  # routed requests bypass the emulated network, so offline is aborted here
                route.abort("internetdisconnected")
                return
            body = json.loads(route.request.post_data or "{}")
            world["puts"].append(body)
            if world["refuse"]:
                self.json(route, world["refuse"], 409)
            elif any(item["connection"] == body.get("connection") and any(option["id"] == body.get("model") for option in item["options"]) for item in groups):
                world["choice"] = dict(world["choice"], current={"connection": body["connection"], "model": body["model"]})
                self.json(route, world["choice"])
            else:
                self.json(route, {"code": "ASSISTANT_MODEL_UNAVAILABLE", "message": "Your Claude plan doesn't offer that model. It is still Sonnet."}, 409)

        page.route(re.compile(r".*/api/v1/personal-assistant/model(\?.*)?$"), model)
        return world

    def ask_bar(self, page: Page):
        return page.locator("#project-ask")

    def open_list(self, page: Page, scope, current: str = "Sonnet"):
        control = scope.get_by_role("button", name=f"Model: {current}. Change")
        control.click()
        menu = page.get_by_role("menu", name="Model")
        expect(menu).to_be_visible()
        return menu

    def open_panel(self, page: Page):
        """The assistant's details panel in a conversation; the model list lives there and in the ask bar (#857: the agent's own page picks by connection)."""
        self.stub_thread(page, [self.answer(base.ADA["id"], "Ada Brandt", "Ada's assistant")])
        page.goto(self.thread_url())
        page.get_by_role("button", name="Ada's assistant", exact=True).click()
        return page.get_by_role("group", name="Ada's assistant, details")

    def inside(self, page: Page, locator) -> None:
        box = locator.bounding_box()
        size = page.viewport_size
        self.assertGreaterEqual(box["x"], 0)
        self.assertGreaterEqual(box["y"], 0)
        self.assertLessEqual(box["x"] + box["width"], size["width"] + 0.5)
        self.assertLessEqual(box["y"] + box["height"], size["height"] + 0.5)

    # ---------------------------------------------------------------- AST-11.6: the ready card

    def test_07_the_panel_changes_the_model_too_and_a_colleague_sees_no_control(self) -> None:
        page = self.page()
        self.stub_assistant(page)
        model = self.stub_model(page)
        self.stub_thread(page, [self.answer(base.ADA["id"], "Ada Brandt", "Ada's assistant")])
        page.goto(self.thread_url())
        page.get_by_role("button", name="Ada's assistant", exact=True).click()
        panel = page.get_by_role("group", name="Ada's assistant, details")
        menu = self.open_list(page, panel)
        self.inside(page, menu)
        shot(page, "model-panel-1440-light")
        menu.get_by_role("menuitemradio", name=re.compile("Opus")).click()
        expect(panel.get_by_role("button", name="Model: Opus. Change")).to_be_visible()
        self.assertEqual(model["puts"], [{"connection": "claude_plan", "model": "opus"}])
        # A colleague's assistant: no model control and no model name anywhere in what they see.
        other = self.page()
        self.stub_assistant(other)
        self.stub_model(other, saved=False)
        self.stub_thread(other, [self.answer(str(uuid.uuid4()), "Jonas Weiss", "Jonas's assistant")])
        other.goto(self.thread_url())
        other.get_by_role("button", name="Jonas's assistant", exact=True).click()
        theirs = other.get_by_role("group", name="Jonas's assistant, details")
        expect(theirs.get_by_test_id("assistant-others")).to_be_visible()
        expect(theirs.get_by_test_id("model-control")).to_have_count(0)
        expect(other.get_by_test_id("model-control")).to_have_count(0)

    # ---------------------------------------------------------------- AST-11.7: plain errors, the previous model stays

    def test_09_a_model_the_vendor_does_not_accept_leads_to_the_agent_s_page_in_the_same_line(self) -> None:
        # #842: the model is the agent's own (its page), not a chip of the ask bar; the line says so and links there.
        page = self.page()
        self.stub_assistant(page)
        self.stub_model(page, current="opus")
        self.stub_thread(page, [])
        agent = str(uuid.uuid4())
        run = {"id": str(uuid.uuid4()), "clientRunId": str(uuid.uuid4()), "workspaceId": self.ids["workspace"], "projectId": self.ids["project"],
               "conversationId": self.ids["conversation"], "dmId": None, "agentId": agent, "kind": "ask", "prompt": "Catch me up", "target": None, "continuesRunId": None, "retryOfRunId": None,
               "status": "unavailable", "stoppedAtStage": None, "stopRequested": False, "stopAcknowledged": False, "engine": "runtime", "model": "opus",
               "runtimeClient": "claude_code", "endReason": "model_unavailable", "planLimitResetsAt": None,
               "cost": {"state": "unknown", "reservedMicros": 0, "chargedMicros": 0, "inputTokens": None, "outputTokens": None},
               "answer": None, "createdAt": NOW, "dispatchedAt": NOW, "completedAt": NOW}
        page.route(re.compile(r".*/api/v1/conversations/[0-9a-f-]{36}/assistant-runs$"), lambda route: self.json(route, run, 202))
        page.goto(self.thread_url())
        pick_suggestion(page, "Catch me up on this thread")
        line = page.locator(".assistant-working")
        expect(line).to_contain_text("Your Claude plan didn’t accept Opus. Nothing was changed.")
        shot(page, "model-unavailable-1440-light")
        expect(line.get_by_role("link", name="Choose a model")).to_have_attribute("href", f"/settings/agents/{agent}")

    # ---------------------------------------------------------------- the list's own states

    def test_10_the_list_is_grouped_by_connection_and_a_pick_names_its_connection(self) -> None:
        """#854: with a Claude plan and a ChatGPT plan, one list grouped by connection; the control names the connection, and a
        pick from the other group saves that connection with its model."""
        page = self.page()
        self.stub_assistant(page)
        world = self.stub_model(page, more=[(CHATGPT_PLAN, CODEX)])
        row = self.open_panel(page)
        control = row.get_by_role("button", name="Model: Sonnet · Claude plan. Change")
        control.click()
        menu = page.get_by_role("menu", name="Model")
        groups = menu.get_by_role("group")
        expect(groups).to_have_count(2)
        expect(groups.nth(0)).to_have_accessible_name("Claude plan")
        expect(groups.nth(1)).to_have_accessible_name("ChatGPT plan")
        expect(groups.nth(0).get_by_role("menuitemradio")).to_have_count(3)
        expect(groups.nth(1).get_by_role("menuitemradio")).to_have_count(2)
        self.inside(page, menu)
        shot(page, "model-groups-1440-light")
        groups.nth(1).get_by_role("menuitemradio", name=re.compile("GPT-6.1 Sol")).click()
        expect(row.get_by_role("button", name="Model: GPT-6.1 Sol · ChatGPT plan. Change")).to_be_visible()
        self.assertEqual(world["puts"], [{"connection": "chatgpt_plan", "model": "gpt-6.1-sol"}])

    def test_11_a_model_that_cannot_make_changes_says_so_beside_it(self) -> None:
        page = self.page()
        self.stub_assistant(page)
        self.stub_model(page, current="claude-sonnet-5", options=API, group=KEY)
        row = self.open_panel(page)
        menu = self.open_list(page, row, "Sonnet 5")
        astra = menu.get_by_role("menuitemradio", name=re.compile("GPT-6 Astra"))
        expect(astra).to_contain_text("Can answer but can't make changes")
        expect(astra).to_contain_text("Input $10, output $50 per 1M tokens")
        expect(menu.get_by_role("menuitemradio", name=re.compile("Sonnet 5"))).not_to_contain_text("can't make changes")

    def test_12_the_list_is_a_menu_for_the_keyboard(self) -> None:
        page = self.page()
        self.stub_assistant(page)
        model = self.stub_model(page)
        self.open_panel(page)
        control = page.get_by_role("button", name="Model: Sonnet. Change")
        expect(control).to_have_attribute("aria-haspopup", "menu")
        expect(control).to_have_attribute("aria-expanded", "false")
        control.focus()
        page.keyboard.press("Enter")
        expect(control).to_have_attribute("aria-expanded", "true")
        menu = page.get_by_role("menu", name="Model")
        expect(menu.get_by_role("menuitemradio", name=re.compile("Sonnet"))).to_be_focused()
        page.keyboard.press("ArrowDown")
        expect(menu.get_by_role("menuitemradio", name=re.compile("Opus"))).to_be_focused()
        page.keyboard.press("End")
        expect(menu.get_by_role("menuitemradio", name=re.compile("Haiku"))).to_be_focused()
        page.keyboard.press("Escape")
        expect(menu).to_have_count(0)
        expect(control).to_be_focused()
        page.keyboard.press("Enter")
        page.keyboard.press("ArrowDown")
        page.keyboard.press("Enter")
        expect(page.get_by_role("button", name="Model: Opus. Change")).to_be_focused()
        self.assertEqual(model["puts"], [{"connection": "claude_plan", "model": "opus"}])


if __name__ == "__main__":
    unittest.main()
