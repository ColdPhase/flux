"""Browser tests for the assistant's model (F-027 AST-11, #596; #854 grouped by connection): a model the vendor does not accept is said in
the working line, with the way to the agent's own page (#842), where the model is chosen.

Same stubbed-engine approach as test_assistant_screen: the model endpoint is an in-memory world that applies the server's rules
(only a listed model, the previous one stays on a refusal).
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

NOW = base.NOW

CLAUDE = [
    {"id": "sonnet", "name": "Sonnet", "note": "Everyday work", "callsTools": True},
    {"id": "opus", "name": "Opus", "note": "Harder requests", "callsTools": True},
    {"id": "haiku", "name": "Haiku", "note": "Quick, simple requests", "callsTools": True},
]
CLAUDE_PLAN = {"connection": "claude_plan", "account": "claude_plan", "label": "Claude plan", "company": "Claude"}


class AssistantModel(unittest.TestCase):
    """Tests run in name order and share one account (the harness is test_assistant_screen's)."""

    state: dict | None = None
    ids: dict[str, str] = {}
    setUpClass = classmethod(base.AssistantScreen.setUpClass.__func__)
    tearDownClass = classmethod(base.AssistantScreen.tearDownClass.__func__)
    pw = None
    for _name in ("context", "page", "api", "json", "status", "stub_assistant", "stub_thread", "thread_url", "no_horizontal_scroll", "tag"):
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

    # ---------------------------------------------------------------- AST-11.7: plain errors, the previous model stays

    def test_09_a_model_the_vendor_does_not_accept_leads_to_the_agent_s_page_in_the_same_line(self) -> None:
        # #842: the model is the agent's own (its page), not a chip of the ask bar; the line says so and links there.
        page = self.page()
        self.stub_assistant(page)
        self.stub_model(page, current="opus")
        self.stub_thread(page)
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


if __name__ == "__main__":
    unittest.main()
