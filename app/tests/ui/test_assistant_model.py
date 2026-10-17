"""Browser tests for the assistant's model (F-027 AST-11, #596): one model, chosen at turn-on and changed everywhere.

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
from test_app_shell import shot

FORBIDDEN = base.FORBIDDEN
NOW = base.NOW

CLAUDE = [
    {"id": "sonnet", "name": "Sonnet", "note": "Everyday work", "callsTools": True},
    {"id": "opus", "name": "Opus", "note": "Harder requests", "callsTools": True},
    {"id": "haiku", "name": "Haiku", "note": "Quick, simple requests", "callsTools": True},
]
LEGACY = {"id": "default", "name": "Your plan's default", "note": "Whatever your plan uses", "callsTools": True}
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

    def stub_model(self, page: Page, *, saved: bool = True, current: str = "sonnet", options: list[dict] | None = None, refuse: dict | None = None) -> dict:
        """GET and PUT of the model, applying the server's rules: a model outside the list is refused and the previous one stays."""
        listed = options if options is not None else CLAUDE
        world = {"choice": {"engine": "runtime", "account": "claude_plan", "company": "Claude", "current": current, "default": listed[0]["id"] if listed else "",
                            "options": listed, "saved": saved}, "puts": [], "gets": 0, "refuse": refuse}

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
            elif any(option["id"] == body.get("model") for option in listed):
                world["choice"] = dict(world["choice"], current=body["model"], options=[option for option in listed if option["id"] != "default"])
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

    def inside(self, page: Page, locator) -> None:
        box = locator.bounding_box()
        size = page.viewport_size
        self.assertGreaterEqual(box["x"], 0)
        self.assertGreaterEqual(box["y"], 0)
        self.assertLessEqual(box["x"] + box["width"], size["width"] + 0.5)
        self.assertLessEqual(box["y"] + box["height"], size["height"] + 0.5)

    # ---------------------------------------------------------------- AST-11.6: the ready card

    def test_02_the_ready_card_preselects_the_default_and_turn_on_sends_the_pick(self) -> None:
        for phone, dark in ((False, False), (True, False), (False, True), (True, True)):
            with self.subTest(phone=phone, dark=dark):
                page = self.page(phone=phone, dark=dark)
                world = self.stub_assistant(page, enabled=False)
                model = self.stub_model(page, saved=False, current="sonnet")
                enabled = self.status(page, enabled=True)
                posted: list[dict] = []

                def enable(route: Route) -> None:
                    if route.request.method == "POST":
                        posted.append(json.loads(route.request.post_data or "{}"))
                        world["status"] = enabled
                        self.json(route, enabled)
                    else:
                        self.json(route, world["status"])
                page.route("**/api/v1/personal-assistant", enable)
                page.goto("/settings/assistant")
                card = page.get_by_role("region", name="Your assistant is ready")
                expect(card).to_contain_text("Model: Sonnet")
                menu = self.open_list(page, card)
                items = menu.get_by_role("menuitemradio")
                expect(items).to_have_count(3)
                expect(items.nth(0)).to_have_attribute("aria-checked", "true")
                expect(items.nth(0)).to_contain_text("Sonnet")
                expect(items.nth(0)).to_contain_text("Everyday work")
                expect(items.nth(1)).to_contain_text("Opus")
                expect(items.nth(2)).to_contain_text("Quick, simple requests")
                for index in range(3):
                    self.assertGreaterEqual(items.nth(index).bounding_box()["height"], 44)
                self.inside(page, menu)
                self.assertIsNone(FORBIDDEN.search(menu.inner_text()), FORBIDDEN.search(menu.inner_text()))
                shot(page, f"model-ready-list-{self.tag(phone, dark)}")
                items.nth(1).click()
                expect(menu).to_have_count(0)
                expect(card.get_by_role("button", name="Model: Opus. Change")).to_be_visible()
                self.assertEqual(model["puts"], [], "nothing is saved before Turn on")
                self.no_horizontal_scroll(page)
                shot(page, f"model-ready-{self.tag(phone, dark)}")
                card.get_by_role("button", name="Turn on", exact=True).click()
                expect(page.get_by_role("switch", name="Your assistant is on")).to_be_visible()
                self.assertEqual((posted[0]["engine"], posted[0]["model"]), ("runtime", "opus"))

    def test_03_turn_on_sends_the_default_when_nothing_was_picked(self) -> None:
        page = self.page()
        world = self.stub_assistant(page, enabled=False)
        self.stub_model(page, saved=False, current="sonnet")
        enabled = self.status(page, enabled=True)
        posted: list[dict] = []

        def enable(route: Route) -> None:
            if route.request.method == "POST":
                posted.append(json.loads(route.request.post_data or "{}"))
                world["status"] = enabled
                self.json(route, enabled)
            else:
                self.json(route, world["status"])
        page.route("**/api/v1/personal-assistant", enable)
        page.goto("/settings/assistant")
        page.get_by_role("region", name="Your assistant is ready").get_by_role("button", name="Turn on", exact=True).click()
        expect(page.get_by_role("switch", name="Your assistant is on")).to_be_visible()
        self.assertEqual(posted[0]["model"], "sonnet")

    # ---------------------------------------------------------------- AST-11.6: Settings

    def test_04_settings_shows_the_model_on_the_account_line_and_a_change_is_saved_and_confirmed(self) -> None:
        for phone, dark in ((False, False), (True, False), (False, True), (True, True)):
            with self.subTest(phone=phone, dark=dark):
                page = self.page(phone=phone, dark=dark)
                self.stub_assistant(page)
                model = self.stub_model(page)
                page.goto("/settings/assistant")
                row = page.locator(".aset-screen__account")
                expect(row).to_contain_text("Claude · your subscription")
                expect(row).to_contain_text("Model: Sonnet")
                expect(row).to_contain_text("Flux can't see your plan's limits.")
                self.assertGreaterEqual(row.get_by_role("button", name="Model: Sonnet. Change").bounding_box()["height"], 44)
                self.no_horizontal_scroll(page)
                shot(page, f"model-settings-{self.tag(phone, dark)}")
                menu = self.open_list(page, row)
                self.inside(page, menu)
                menu.get_by_role("menuitemradio", name=re.compile("Opus")).click()
                expect(row.get_by_role("button", name="Model: Opus. Change")).to_be_visible()
                expect(row.get_by_role("status")).to_have_text("Model: Opus. It applies from your next request.")
                self.assertEqual(model["puts"], [{"model": "opus"}])
                page.reload()
                expect(page.locator(".aset-screen__account")).to_contain_text("Model: Opus")
                self.assertIsNone(FORBIDDEN.search(page.locator(".pane-in").inner_text()))

    def test_05_a_request_that_is_working_keeps_its_model_and_the_confirmation_says_so(self) -> None:
        page = self.page()
        self.stub_assistant(page)
        self.stub_model(page)
        run = {"id": str(uuid.uuid4()), "clientRunId": str(uuid.uuid4()), "workspaceId": self.ids["workspace"], "projectId": self.ids["project"],
               "conversationId": self.ids["conversation"], "kind": "ask", "prompt": "Tidy this project's tasks", "target": None, "continuesRunId": None,
               "retryOfRunId": None, "status": "dispatching", "stoppedAtStage": None, "stopRequested": False, "stopAcknowledged": False, "engine": "runtime",
               "model": "sonnet", "runtimeClient": "claude_code", "endReason": None, "planLimitResetsAt": None,
               "cost": {"state": "reserved", "reservedMicros": 0, "chargedMicros": 0, "inputTokens": None, "outputTokens": None},
               "answer": None, "createdAt": NOW, "dispatchedAt": NOW, "completedAt": None}
        page.route(re.compile(r".*/api/v1/assistant-runs\?limit=\d+$"), lambda route: self.json(route, {"items": [run], "total": 1, "limit": 10, "offset": 0}))
        page.goto("/settings/assistant")
        row = page.locator(".aset-screen__account")
        self.open_list(page, row)
        page.get_by_role("menuitemradio", name=re.compile("Opus")).click()
        expect(row.get_by_role("status")).to_have_text("Model: Opus from your next request. The one running keeps Sonnet.")

    # ---------------------------------------------------------------- AST-11.6: the conversation, two taps, one value everywhere

    def test_06_from_the_ask_bar_the_model_is_two_taps_and_the_same_value_shows_in_settings_and_the_panel(self) -> None:
        for phone, dark in ((False, False), (True, False), (False, True), (True, True)):
            with self.subTest(phone=phone, dark=dark):
                page = self.page(phone=phone, dark=dark)
                self.stub_assistant(page)
                model = self.stub_model(page)
                self.stub_thread(page, [self.answer(base.ADA["id"], "Ada Brandt", "Ada's assistant")])
                page.goto(f"{self.thread_url()}?ask=1")
                bar = self.ask_bar(page)
                expect(bar).to_be_visible()
                chip = bar.get_by_role("button", name="Model: Sonnet. Change")
                expect(chip).to_have_text("Sonnet")
                self.assertGreaterEqual(chip.bounding_box()["height"], 44)
                self.assertGreaterEqual(chip.bounding_box()["width"], 44)
                shot(page, f"model-chip-{self.tag(phone, dark)}")
                taps = 0
                chip.click(); taps += 1                                                             # 1
                menu = page.get_by_role("menu", name="Model")
                expect(menu).to_be_visible()
                self.inside(page, menu)
                shot(page, f"model-chip-list-{self.tag(phone, dark)}")
                menu.get_by_role("menuitemradio", name=re.compile("Haiku")).click(); taps += 1      # 2
                self.assertEqual(taps, 2)
                expect(bar.get_by_role("button", name="Model: Haiku. Change")).to_have_text("Haiku")
                self.assertEqual(model["puts"], [{"model": "haiku"}])
                # One value everywhere: the panel, then Settings, show the same model.
                bar.get_by_role("button", name="Stop asking your assistant").click()
                page.get_by_role("button", name="Ada's assistant", exact=True).click()
                panel = page.get_by_role("group", name="Ada's assistant, details")
                expect(panel.get_by_role("button", name="Model: Haiku. Change")).to_be_visible()
                panel.get_by_role("button", name="Close").click()
                page.goto("/settings/assistant")
                expect(page.locator(".aset-screen__account")).to_contain_text("Model: Haiku")

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
        self.assertEqual(model["puts"], [{"model": "opus"}])
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

    def test_08_a_refused_change_says_so_plainly_and_the_previous_model_stays(self) -> None:
        page = self.page(phone=True)
        self.stub_assistant(page)
        model = self.stub_model(page, refuse={"code": "ASSISTANT_MODEL_UNAVAILABLE", "message": "Your Claude plan doesn't offer that model. It is still Sonnet."})
        page.goto("/settings/assistant")
        row = page.locator(".aset-screen__account")
        self.open_list(page, row)
        page.get_by_role("menuitemradio", name=re.compile("Opus")).click()
        expect(row.get_by_role("alert")).to_have_text("Your Claude plan doesn't offer that model. It is still Sonnet.")
        expect(row.get_by_role("button", name="Model: Sonnet. Change")).to_be_visible()
        self.assertEqual(model["puts"], [{"model": "opus"}])
        shot(page, "model-refused-390-light")
        # Offline: the same promise.
        page2 = self.page()
        self.stub_assistant(page2)
        self.stub_model(page2)
        page2.goto("/settings/assistant")
        row2 = page2.locator(".aset-screen__account")
        page2.context.set_offline(True)
        self.open_list(page2, row2)
        page2.get_by_role("menuitemradio", name=re.compile("Haiku")).click()
        expect(row2.get_by_role("alert")).to_have_text("Offline. It is still Sonnet.")
        expect(row2.get_by_role("button", name="Model: Sonnet. Change")).to_be_visible()

    def test_09_a_model_the_vendor_does_not_accept_offers_another_one_in_the_same_line(self) -> None:
        page = self.page()
        self.stub_assistant(page)
        model = self.stub_model(page, current="opus")
        self.stub_thread(page, [])
        run = {"id": str(uuid.uuid4()), "clientRunId": str(uuid.uuid4()), "workspaceId": self.ids["workspace"], "projectId": self.ids["project"],
               "conversationId": self.ids["conversation"], "kind": "ask", "prompt": "Catch me up", "target": None, "continuesRunId": None, "retryOfRunId": None,
               "status": "unavailable", "stoppedAtStage": None, "stopRequested": False, "stopAcknowledged": False, "engine": "runtime", "model": "opus",
               "runtimeClient": "claude_code", "endReason": "model_unavailable", "planLimitResetsAt": None,
               "cost": {"state": "unknown", "reservedMicros": 0, "chargedMicros": 0, "inputTokens": None, "outputTokens": None},
               "answer": None, "createdAt": NOW, "dispatchedAt": NOW, "completedAt": NOW}
        page.route(re.compile(r".*/api/v1/conversations/[0-9a-f-]{36}/assistant-runs$"), lambda route: self.json(route, run, 202))
        page.goto(self.thread_url())
        page.get_by_role("group", name="Suggestions for your assistant").get_by_role("button", name="Catch me up").click()
        line = page.locator(".assistant-working")
        expect(line).to_contain_text("Your Claude plan didn’t accept Opus. Nothing was changed.")
        shot(page, "model-unavailable-1440-light")
        line.get_by_role("button", name="Choose another model").click()
        menu = page.get_by_role("menu", name="Model")
        menu.get_by_role("menuitemradio", name=re.compile("Haiku")).click()
        self.assertEqual(model["puts"], [{"model": "haiku"}])
        expect(line.get_by_role("status")).to_contain_text("Model: Haiku")

    # ---------------------------------------------------------------- the list's own states

    def test_10_an_assistant_from_before_the_choice_shows_its_plans_default_until_a_pick(self) -> None:
        page = self.page()
        self.stub_assistant(page)
        legacy = self.stub_model(page, current="default", options=[LEGACY] + CLAUDE)
        page.goto("/settings/assistant")
        row = page.locator(".aset-screen__account")
        expect(row).to_contain_text("Model: Your plan's default")
        control = row.get_by_role("button", name="Model: Your plan's default. Change")
        control.click()
        menu = page.get_by_role("menu", name="Model")
        expect(menu.get_by_role("menuitemradio")).to_have_count(4)
        expect(menu.get_by_role("menuitemradio").first).to_have_attribute("aria-checked", "true")
        menu.get_by_role("menuitemradio", name=re.compile("Sonnet")).click()
        picked = row.get_by_role("button", name="Model: Sonnet. Change")
        expect(picked).to_be_visible()
        picked.click()
        expect(page.get_by_role("menu", name="Model").get_by_role("menuitemradio")).to_have_count(3)
        self.assertEqual(legacy["puts"], [{"model": "sonnet"}])

    def test_11_a_model_that_cannot_make_changes_says_so_beside_it(self) -> None:
        page = self.page()
        self.stub_assistant(page)
        keyed = self.stub_model(page, current="claude-sonnet-5", options=API)
        keyed["choice"].update(engine="server", account="api_key", company="Anthropic")
        page.goto("/settings/assistant")
        row = page.locator(".aset-screen__account")
        menu = self.open_list(page, row, "Sonnet 5")
        astra = menu.get_by_role("menuitemradio", name=re.compile("GPT-6 Astra"))
        expect(astra).to_contain_text("Can answer but can't make changes")
        expect(astra).to_contain_text("Input $10, output $50 per 1M tokens")
        expect(menu.get_by_role("menuitemradio", name=re.compile("Sonnet 5"))).not_to_contain_text("can't make changes")

    def test_12_the_list_is_a_menu_for_the_keyboard(self) -> None:
        page = self.page()
        self.stub_assistant(page)
        model = self.stub_model(page)
        page.goto("/settings/assistant")
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
        self.assertEqual(model["puts"], [{"model": "opus"}])


if __name__ == "__main__":
    unittest.main()
