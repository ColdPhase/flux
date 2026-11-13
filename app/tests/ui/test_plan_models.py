"""Browser tests for a plan's models on an agent's page (CA-2, #1332): the models the signed-in Claude Code or Codex offers.

Runs through scripts/check_ui.sh in Chromium and WebKit (FLUX_UI_BROWSER). The UI stack has no runtime and no CLI, so the plan's group is
shown on a stubbed model choice, in the shape the server sends for a plan whose CLI listed its models; the rules that make the list (the
CLI's own order and names, no Fable, no hidden model, retired ones, the pause) are proven against the real use cases and the fake CLIs in
app/tests/app/plan-models.test.ts and agent-runtime-models-core.test.ts. Nothing here signs in to anything or calls a model.
"""

from __future__ import annotations

import json
import re
import time
import unittest

from playwright.sync_api import Browser, Page, Route, expect, sync_playwright

from app_select import choose, open_select, values
from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder

PASSWORD = "models from the program itself"
STAMP = int(time.time() * 1000)
OWNER = {"name": "Iga Marek", "email": f"iga.marek+{STAMP}@example.test"}


def named(name: str) -> str:
    return name if UI_BROWSER == "chromium" else f"{name}-{UI_BROWSER}"


def claude(model_id: str, name: str, note: str, **extra) -> dict:
    return {"id": model_id, "name": name, "note": note, "callsTools": True, **extra}


# Codex 0.160.1's own list (captured 2026-11-12), under the names it gives: eight models, more than segments hold.
CODEX = [
    claude("gpt-6.1-sol", "GPT-6.1-Sol", "Latest workhorse model for coding and everyday work."),
    claude("gpt-6-astra", "GPT-6-Astra", "Frontier intelligence for the most demanding work."),
    claude("gpt-6-sol", "GPT-6-Sol", "Previous generation workhorse model."),
    claude("gpt-6-luna", "GPT-6-Luna", "Fast and affordable model for easier tasks."),
    claude("gpt-5.6-sol", "GPT-5.6-Sol", "Older generation workhorse model."),
    claude("gpt-5.6-terra", "GPT-5.6-Terra", "Older balanced model for straightforward work."),
    claude("gpt-5.6-luna", "GPT-5.6-Luna", "Older fast and efficient model."),
    claude("gpt-5.5", "GPT-5.5", "Legacy coding model."),
]
CLAUDE = [
    claude("opus", "Opus 5.5", "Best for everyday, complex tasks"),
    claude("sonnet", "Sonnet 5.5", "Efficient for routine tasks"),
    claude("haiku", "Haiku 4.5", "Fastest for quick answers"),
]


class PlanModels(unittest.TestCase):
    """Tests run in name order and share one owner and her agent."""

    pw = None
    browser: Browser
    state: dict | None = None
    agent: dict = {}

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

    def page(self, *, phone: bool = False, dark: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=UI_BROWSER == "chromium", has_touch=True)
        else:
            options.update(viewport=DESKTOP)
        if self.state:
            options["storage_state"] = self.state
        context = self.browser.new_context(service_workers="block", **options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def own(self) -> str:
        """The agent's own model id: the page reads the agent from the shell data, so the plan's list names it as one of its models."""
        return (type(self).agent.get("model") or {}).get("model") or "claude-sonnet-5"

    def stub(self, page: Page, *, account: str, label: str, company: str, options: list[dict], patches: list[dict] | None = None) -> str:
        """The agent's connection as a plan with the given models; an option whose id is `@own` stands for the agent's own model."""
        agent = type(self).agent
        connection = (agent.get("model") or {}).get("connection") or "claude_plan"
        model = self.own()
        listed = [{**option, "id": model if option["id"] == "@own" else option["id"]} for option in options]
        group = {"connection": connection, "account": account, "label": label, "company": company, "options": listed}

        def choice(route: Route) -> None:
            route.fulfill(status=200, content_type="application/json", body=json.dumps(
                {"current": {"connection": connection, "model": model}, "default": None, "groups": [group], "saved": True}))

        def patch(route: Route) -> None:
            if route.request.method != "PATCH":
                route.fallback()
                return
            if patches is not None:
                patches.append(json.loads(route.request.post_data or "{}"))
            route.fulfill(status=200, content_type="application/json", body=json.dumps(agent))

        page.route(re.compile(r".*/api/v1/personal-assistant/model$"), choice)
        page.route(re.compile(rf".*/api/v1/my-agents/{agent['id']}$"), patch)
        return connection

    def test_01_owner_makes_an_agent(self) -> None:
        page = self.page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill(OWNER["name"])
        page.get_by_label("Email").fill(OWNER["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).state = page.context.storage_state()
        headers = {"origin": ORIGIN}
        ws = page.request.post(f"{ORIGIN}/api/v1/workspaces", data={"name": "Plan lab"}, headers=headers)
        self.assertEqual(ws.status, 201, ws.text())
        made = page.request.post(f"{ORIGIN}/api/v1/my-agents", data={"workspaceId": ws.json()["id"], "name": "Planner"}, headers=headers)
        self.assertEqual(made.status, 201, made.text())
        type(self).agent = made.json()

    def test_02_a_claude_plan_with_a_few_models_keeps_them_as_segments(self) -> None:
        page = self.page()
        patches: list[dict] = []
        connection = self.stub(page, account="claude_plan", label="Claude plan", company="Claude", options=[CLAUDE[0], {**CLAUDE[1], "id": "@own"}, CLAUDE[2]], patches=patches)
        page.goto(f"/settings/agents/{type(self).agent['id']}")
        models = page.get_by_role("radiogroup", name="Claude plan")
        expect(models.get_by_role("radio")).to_have_count(3)
        self.assertEqual([text.strip() for text in models.get_by_role("radio").all_inner_texts()], ["Opus 5.5", "Sonnet 5.5", "Haiku 4.5"], "the CLI's order and names")
        expect(models.get_by_role("radio", name="Sonnet 5.5")).to_have_attribute("aria-checked", "true")
        expect(page.get_by_role("combobox", name="Claude plan")).to_have_count(0)
        models.get_by_role("radio", name="Opus 5.5").click()
        expect(page.get_by_text("Model changed")).to_be_visible()
        self.assertEqual(patches[-1], {"connection": connection, "model": "opus"})
        shot(page, named("plan-models-claude-1440"))

    def test_03_a_plan_with_more_models_than_segments_hold_is_the_apps_dropdown_in_the_clis_order(self) -> None:
        for label, phone in (("1440", False), ("390", True)):
            with self.subTest(label):
                page = self.page(phone=phone)
                patches: list[dict] = []
                connection = self.stub(page, account="chatgpt_plan", label="ChatGPT plan", company="ChatGPT", options=[{**CODEX[0], "id": "@own"}, *CODEX[1:]], patches=patches)
                page.goto(f"/settings/agents/{type(self).agent['id']}")
                model = page.get_by_role("combobox", name="ChatGPT plan")
                expect(model).to_contain_text("GPT-6.1-Sol · Latest workhorse model for coding and everyday work.")
                expect(page.get_by_role("group", name=re.compile("^Model")).get_by_role("radio")).to_have_count(0)
                self.assertEqual(values(model), [self.own(), *[option["id"] for option in CODEX[1:]]], "every model the CLI lists, in its order, and no other")
                box = open_select(model)
                expect(box.get_by_role("option", name="GPT-6-Luna · Fast and affordable model for easier tasks.", exact=True)).to_be_visible()
                expect(box.get_by_role("option")).to_have_count(8)
                page.keyboard.press("Escape")
                choose(model, value="gpt-6-luna")
                expect(page.get_by_text("Model changed")).to_be_visible()
                self.assertEqual(patches[-1], {"connection": connection, "model": "gpt-6-luna"})
                self.assertLessEqual(page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth"), 0)
                if not phone:
                    shot(page, named("plan-models-codex-1440"))
                else:
                    shot(page, named("plan-models-codex-390"))

    def test_04_a_model_the_plan_stopped_offering_says_so_and_pauses_its_agent(self) -> None:
        page = self.page()
        options = [*CLAUDE[:2], claude("@own", "Haiku 4.5", "", retired=True), claude("opus-4-8", "Opus 4.8", "", retired=True)]
        self.stub(page, account="claude_plan", label="Claude plan", company="Claude", options=options)
        page.goto(f"/settings/agents/{type(self).agent['id']}")
        model = page.get_by_role("combobox", name="Claude plan")
        # The agent's own model stays, as "no longer offered"; a retired model that no agent is on is left out of the list.
        expect(model).to_contain_text("Haiku 4.5 · no longer offered by Claude")
        expect(page.get_by_role("note").filter(has_text="Haiku 4.5 is no longer offered by Claude. Planner is paused until you choose another model.")).to_be_visible()
        self.assertEqual(sorted(values(model)), sorted([self.own(), "opus", "sonnet"]))
        box = open_select(model)
        expect(box.get_by_role("option", name="Haiku 4.5 · no longer offered by Claude", exact=True)).to_have_attribute("aria-disabled", "true")
        page.keyboard.press("Escape")
        shot(page, named("plan-models-retired-1440"))
        # Nothing switches by itself: the agent is still on it until its owner chooses another.
        choose(model, value="sonnet")
        expect(page.get_by_text("Model changed")).to_be_visible()

    def test_05_a_plan_whose_models_were_not_read_yet_says_so_and_offers_no_control(self) -> None:
        page = self.page()
        self.stub(page, account="claude_plan", label="Claude plan", company="Claude", options=[])
        page.goto(f"/settings/agents/{type(self).agent['id']}")
        expect(page.get_by_role("note").filter(has_text="Flux hasn’t read this plan’s models yet. It reads them when you sign in and again every few hours.")).to_be_visible()
        expect(page.get_by_role("group", name=re.compile("^Model")).get_by_role("radio")).to_have_count(0)
        expect(page.get_by_role("combobox", name="Claude plan")).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
