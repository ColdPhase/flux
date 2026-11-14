"""Browser tests for a person's agents (F-036 AG-1, #857): the list in Settings > AI, one agent's page, and Messages.

Runs with the other tests/ui journeys through scripts/check_ui.sh. That stack is composed with the TEST-ONLY switch
`FLUX_TEST_PERSONAL_RUNS=anthropic-mock`: every person has a fixture API key connection, which is not a connection the
person made, so no agent exists until Ada connects AI herself and the server makes Assistant. Nothing here calls a model. Ada makes
a second agent, Planner, gives it instructions, a model (under More), Ask me first and something to remember, finds it in
Messages and deletes it; Ben, in the same company, never sees any of it. Computer and phone widths.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest

from playwright.sync_api import Browser, expect, sync_playwright

from app_select import choose
from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder
from themed_shots import shot_both

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
PASSWORD = "agents that belong to one person"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.agents+{STAMP}@example.test"),
    "ben": ("Ben Okafor", f"ben.agents+{STAMP}@example.test"),
    "gus": ("Gus Lindqvist", f"gus.agents+{STAMP}@example.test"),
}
KEY = f"sk-ant-api03-{'agents-ui-key-' * 3}AG01"
SECOND_KEY = f"sk-ant-api03-{'agents-ui-two-' * 3}AG02"
INSTRUCTIONS = "Split a task into 3 to 5 steps, one verb and one result each.\nPlain English, no jargon."


class MyAgentsJourney(unittest.TestCase):
    """Tests run in name order and share two accounts."""

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
        for who, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"name": name, "email": email, "password": PASSWORD}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.states[who] = context.storage_state()
            context.close()
        # Ada's company, with Ben in it: agents belong to a person in the company's one workspace.
        context = cls.browser.new_context(service_workers="block", base_url=ORIGIN, storage_state=cls.states["ada"])
        ws = context.request.post("/api/v1/workspaces", data={"name": "Agents workshop"}, headers={"origin": ORIGIN}).json()
        for who, role in (("ben", "member"), ("gus", "guest")):
            response = context.request.post(f"/api/v1/workspaces/{ws['id']}/members", data={"email": PEOPLE[who][1], "role": role}, headers={"origin": ORIGIN})
            assert response.status == 201, response.text()
        cls.ids["workspace"] = ws["id"]
        context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str = "ada", *, phone: bool = False, viewport: dict | None = None):
        options = {"service_workers": "block", "base_url": ORIGIN, "storage_state": self.states[who], "locale": "en-GB", "reduced_motion": "reduce"}
        options.update(viewport=viewport or PHONE, is_mobile=True, has_touch=True, device_scale_factor=3) if phone else options.update(viewport=DESKTOP)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page, method: str, path: str, body: dict | None = None, status: int = 200):
        response = page.request.fetch(path, method=method, headers={"origin": ORIGIN}, data=body)
        self.assertEqual(response.status, status, response.text())
        return response.json() if response.text() else None

    def sidebar_agents(self, page):
        return page.get_by_role("navigation", name="Messages").or_(page.locator(".side__sec", has=page.get_by_role("heading", name="Messages")))

    def test_01_connecting_ai_gives_a_person_their_assistant(self) -> None:
        page = self.page()
        page.goto("/settings/agents")
        # Opening Settings makes nothing: she has not connected AI herself yet.
        expect(page.get_by_text("You have no agents. Make one with New agent.")).to_be_visible()
        self.assertEqual(self.api(page, "GET", "/api/v1/my-agents")["items"], [])
        connect = page.get_by_role("region", name="Connect AI", exact=True)
        connect.get_by_role("button", name="Connect AI", exact=True).click()
        window = page.get_by_role("dialog", name="Connect your AI")
        window.get_by_role("button", name="Continue").click()
        choose(window.get_by_label("Provider", exact=True), label="Anthropic")
        window.get_by_label("API key", exact=True).fill(KEY)
        window.get_by_label("API key", exact=True).blur()
        choose(window.get_by_label("Model", exact=True), value="claude-sonnet-5")
        window.get_by_label("Name", exact=True).fill("Ada's Anthropic key")
        window.get_by_label("Daily budget (USD)", exact=True).fill("5")
        window.get_by_role("button", name="Connect", exact=True).click()
        expect(window).to_have_count(0)
        # The server made Assistant when the connection was made; the page shows it without a reload.
        list_ = page.get_by_role("list", name="Your agents")
        expect(list_.get_by_role("link", name=re.compile("^Assistant"))).to_be_visible()
        expect(list_).to_contain_text("Answers /ai")
        expect(list_).to_contain_text("Do it and tell me")
        expect(page.get_by_text("Agents never have more rights than you.")).to_be_visible()
        mine = self.api(page, "GET", "/api/v1/my-agents")["items"]
        self.assertEqual([(item["name"], item["answersAi"], item["colour"]) for item in mine], [("Assistant", True, "ink")])
        type(self).ids["assistant"] = mine[0]["id"]
        # Assistant is pinned first in Messages.
        side = page.locator(".side__sec", has=page.get_by_role("heading", name="Messages"))
        expect(side.locator("[data-agent]").first).to_contain_text("Assistant")
        expect(side.get_by_label("Pinned")).to_be_visible()
        shot(page, "my-agents-list-1440")

    def test_02_a_new_agent_has_a_name_instructions_ask_me_first_a_model_under_more_and_a_colour(self) -> None:
        page = self.page()
        page.goto("/settings/agents")
        page.get_by_role("button", name="New agent").click()
        page.get_by_label("Name", exact=True).fill("Planner")
        page.get_by_role("button", name="Make agent").click()
        expect(page.get_by_role("heading", level=2, name="Planner")).to_be_visible()
        type(self).ids["planner"] = page.url.rsplit("/", 1)[1]
        expect(page.get_by_text("Your agent · uses your")).to_be_visible()
        page.get_by_label("Instructions").fill(INSTRUCTIONS)
        page.get_by_label("Name", exact=True).click()  # leaving the instructions saves them
        expect(page.get_by_role("status").filter(has_text="Saved")).to_be_visible()
        # #1419: the agent starts on its connection's default model, named beside More; the choice is behind More.
        expect(page.get_by_role("group", name=re.compile("^Model"))).to_have_count(0)
        expect(page.locator("[data-agent-model]")).to_contain_text("Model: ")
        page.get_by_role("button", name="More settings").click()
        expect(page.get_by_role("button", name="More settings")).to_have_attribute("aria-expanded", "true")
        # A second model, if the connection offers one, is a click; the choice is the one the server kept.
        group = page.get_by_role("group", name=re.compile("^Model"))
        # A plan's few models are segments; a key's models are the app's dropdown (#1218).
        self.assertGreaterEqual(group.get_by_role("radio").count() + group.get_by_role("combobox").count(), 1)
        # A key's models read as the Connect AI window words them, "Sonnet 5 · $2 / $10", with the unit said once (#1362), not "Input $2, output $10 per 1M tokens".
        if group.get_by_role("combobox").count():
            expect(group.get_by_role("combobox")).to_contain_text(re.compile(r"· \$[\d.]+ / \$[\d.]+"))
            expect(group).not_to_contain_text("Input $")
            expect(group).to_contain_text("Prices are US dollars per 1M tokens, input / output.")
        # #1419: one switch instead of three choices; off is "Do it and tell me", the default.
        switch = page.get_by_role("switch", name="Ask me first")
        expect(switch).not_to_be_checked()
        expect(page.get_by_role("radio", name="Only read")).to_have_count(0)
        switch.click()
        expect(switch).to_be_checked()
        expect(page.locator("[data-ask-first]")).to_contain_text("Every change waits for your OK.")
        stored = self.api(page, "GET", f"/api/v1/my-agents/{self.ids['planner']}")
        self.assertEqual((stored["name"], stored["instructions"], stored["mayDo"], stored["answersAi"]), ("Planner", INSTRUCTIONS, "ask", False))
        self.assertEqual(stored["colour"], "teal", "the first agent after Assistant gets the colour furthest from ink (#1377)")
        page.reload()
        expect(page.get_by_label("Instructions")).to_have_value(INSTRUCTIONS)
        expect(page.get_by_role("switch", name="Ask me first")).to_be_checked()
        # The agent's page lists no schedules and offers no morning summary: they live in its chat (#1419).
        expect(page.get_by_role("heading", name="Schedules")).to_have_count(0)
        expect(page.get_by_text("Morning summary")).to_have_count(0)
        shot(page, "my-agent-page-1440")

    def test_02b_the_agents_list_matches_its_render_and_the_first_agents_are_told_apart(self) -> None:
        """#1377 (F-026 §7 Agents and AI): Assistant says what it is for before it has instructions, its Ask me first is a tag, a second new agent is
        Indigo (not another warm brown), and there is no "When someone assigns a task to me" (#1419)."""
        page = self.page()
        page.goto("/settings/agents")
        page.get_by_role("button", name="New agent").click()
        page.get_by_label("Name", exact=True).fill("Reviewer")
        page.get_by_role("button", name="Make agent").click()
        expect(page.get_by_role("heading", level=2, name="Reviewer")).to_be_visible()
        reviewer = page.url.rsplit("/", 1)[1]
        self.assertEqual([item["colour"] for item in self.api(page, "GET", "/api/v1/my-agents")["items"]], ["ink", "teal", "indigo"], "colours are told apart")
        page.goto("/settings/agents")
        rows = page.get_by_role("list", name="Your agents")
        expect(rows.locator("[data-agent]").first.locator(".agl__job")).to_have_text("Answers your questions and runs your schedules.")
        tag = rows.locator("[data-agent]").first.locator(".agl__may")
        expect(tag).to_have_text("Do it and tell me")
        card = rows.evaluate("el => getComputedStyle(el).backgroundColor")
        self.assertNotEqual(tag.evaluate("el => getComputedStyle(el).backgroundColor"), card, "the tag is drawn against its card")
        hues = rows.locator(".kreska").evaluate_all("els => els.map((el) => [...el.classList].find((name) => name.startsWith('kreska--')) ?? 'ink')")
        self.assertEqual(len(set(hues)), 3, f"three agents, three faces: {hues}")
        expect(page.get_by_text("When someone assigns a task to me")).to_have_count(0)
        shot(page, f"1377-settings-ai-{UI_BROWSER}")
        # Leave the world as the next tests expect it: Assistant and Planner.
        page.goto(f"/settings/agents/{reviewer}")
        page.get_by_role("button", name="Delete Reviewer").click()
        page.get_by_role("group", name="Delete Reviewer").get_by_role("button", name="Delete Reviewer").click()
        expect(page.get_by_role("list", name="Your agents")).to_be_visible()

    def test_03_what_an_agent_remembers_is_visible_and_editable(self) -> None:
        page = self.page()
        page.goto(f"/settings/agents/{self.ids['planner']}")
        expect(page.get_by_text("Tell Planner “remember that…”")).to_be_visible()
        page.get_by_role("button", name="Add", exact=True).click()
        page.get_by_label("What Planner should remember").fill("Due dates fall on Fridays.")
        page.get_by_role("button", name="Save", exact=True).click()
        item = page.get_by_role("list", name="What Planner remembers").get_by_role("listitem").first
        expect(item).to_contain_text("Due dates fall on Fridays.")
        expect(item).to_contain_text("Added by you · today")
        item.get_by_role("button", name=re.compile("^Edit")).click()
        page.get_by_label("What Planner should remember").fill("Due dates fall on Mondays.")
        page.get_by_role("button", name="Save", exact=True).click()
        expect(item.get_by_text("Added by you")).to_be_visible()  # the form is gone: the server kept it
        expect(item).to_contain_text("Due dates fall on Mondays.")
        memory = self.api(page, "GET", f"/api/v1/my-agents/{self.ids['planner']}/memory")["items"]
        self.assertEqual([entry["body"] for entry in memory], ["Due dates fall on Mondays."])
        item.get_by_role("button", name=re.compile("^Edit")).click()
        page.get_by_role("button", name="Delete", exact=True).click()
        expect(page.get_by_text("Nothing yet.")).to_be_visible()
        self.assertEqual(self.api(page, "GET", f"/api/v1/my-agents/{self.ids['planner']}/memory")["items"], [])

    def stub_models(self, page, agent: dict, *, sees_pictures: bool | None) -> None:
        """The model list of the agent's connection, with the agent's own model in it; `sees_pictures` None leaves the field out (it sees them)."""
        model = agent["model"]
        option = {"id": model["model"], "name": "Test model", "note": "Input $1, output $2 per 1M tokens"}
        if sees_pictures is not None:
            option["seesPictures"] = sees_pictures
        group = {"connection": model["connection"], "account": "api_key", "label": "Ada's Anthropic key", "company": "Anthropic", "options": [option]}
        choice = {"current": model, "default": model, "groups": [group], "saved": True}
        page.route("**/api/v1/personal-assistant/model", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(choice))
                   if route.request.method == "GET" else route.continue_())

    def stub_plan_models(self, page, agent: dict) -> None:
        """The agent's connection as a Claude plan: its few models are segments (#1219), the agent's own model among them."""
        model = agent["model"]
        options = [{"id": model["model"], "name": "Sonnet", "note": "Everyday work"},
                   {"id": "opus", "name": "Opus", "note": "Harder requests"},
                   {"id": "haiku", "name": "Haiku", "note": "Quick, simple requests"}]
        group = {"connection": model["connection"], "account": "claude_plan", "label": "Claude plan", "company": "Claude", "options": options}
        choice = {"current": model, "default": model, "groups": [group], "saved": True}
        page.route("**/api/v1/personal-assistant/model", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(choice))
                   if route.request.method == "GET" else route.continue_())

    def test_03b_a_model_that_cannot_see_pictures_says_so_on_the_agent_s_page(self) -> None:
        """#1217 (C-59): an agent on a model without vision sees attached files only by name, and its page says so; a model that sees them says nothing."""
        agent = self.api(self.page(), "GET", f"/api/v1/my-agents/{self.ids['planner']}")
        note = "can’t see pictures, so it sees attached files only by name."
        blind = self.page()
        self.stub_models(blind, agent, sees_pictures=False)
        blind.goto(f"/settings/agents/{agent['id']}")
        blind.get_by_role("button", name="More settings").click()  # the Model is behind More (#1419)
        # An API key's models are the app's dropdown, named by the key (#1218); it shows the agent's model.
        expect(blind.get_by_role("combobox", name="Ada's Anthropic key")).to_contain_text("Test model")
        expect(blind.get_by_role("note").filter(has_text=note)).to_have_text(f"Test model: {note}")
        shot(blind, "agent-vision-note-1440")
        for label, vision in (("a model that sees pictures", True), ("a model whose list says nothing of it", None)):
            with self.subTest(label):
                sighted = self.page()
                self.stub_models(sighted, agent, sees_pictures=vision)
                sighted.goto(f"/settings/agents/{agent['id']}")
                sighted.get_by_role("button", name="More settings").click()
                expect(sighted.get_by_role("combobox", name="Ada's Anthropic key")).to_contain_text("Test model")
                expect(sighted.get_by_role("note").filter(has_text="see pictures")).to_have_count(0)

    def test_04_each_agent_is_a_private_conversation_in_messages(self) -> None:
        page = self.page()
        page.goto("/")
        side = page.locator(".side__sec", has=page.get_by_role("heading", name="Messages"))
        expect(side.locator("[data-agent]")).to_have_count(2)
        names = [text.strip() for text in side.locator("[data-agent]").all_inner_texts()]
        self.assertEqual([name.split("\n")[0] for name in names][:2], ["Assistant", "Planner"], "Assistant first, then the others")
        side.locator(f"[data-agent='{self.ids['planner']}']").click()
        expect(page.get_by_text("Only you talk to Planner. Reports of its work arrive here.")).to_be_visible()
        expect(page.get_by_role("heading", level=1, name="Planner")).to_be_visible()

    def test_05_the_list_and_the_page_fit_a_phone(self) -> None:
        page = self.page(phone=True)
        page.goto("/settings/agents")
        expect(page.get_by_role("list", name="Your agents")).to_be_visible()
        self.assertLessEqual(page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth"), 0)
        shot(page, "my-agents-list-phone-390")
        page.goto(f"/settings/agents/{self.ids['planner']}")
        expect(page.get_by_label("Instructions")).to_be_visible()
        self.assertLessEqual(page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth"), 0)
        for control in page.get_by_role("radio").all():
            self.assertGreaterEqual(control.bounding_box()["height"], 32)
        shot(page, "my-agent-page-phone-390")
        # One way back on the phone: the header's (#1377). The page itself carries no second "‹ AI".
        expect(page.locator("header.phead").get_by_role("button", name="Back", exact=True)).to_be_visible()
        expect(page.get_by_role("link", name="Back to AI")).to_have_count(0)
        page.locator("header.phead").get_by_role("button", name="Back", exact=True).click()
        expect(page).to_have_url(re.compile(r"/settings/agents$"))
        # The agent's chat: its Settings are in the title row's ⋯ (#1356), a 44 px touch target (#1377).
        page.goto(f"/agents/{self.ids['planner']}")
        more = page.locator("header.phead").get_by_role("button", name="More")
        box = more.bounding_box()
        self.assertGreaterEqual(min(box["width"], box["height"]), 44, f"the agent chat's ⋯ on touch: {box}")
        more.click()
        page.get_by_role("menuitem", name="Settings").click()
        expect(page).to_have_url(re.compile(rf"/settings/agents/{self.ids['planner']}$"))
        # A tablet with touch keeps "‹ AI" above the page's title, 44 px high.
        tablet = self.page(phone=True, viewport={"width": 820, "height": 1180})
        tablet.goto(f"/settings/agents/{self.ids['planner']}")
        expect(tablet.get_by_label("Instructions")).to_be_visible()
        back = tablet.locator(".sset-back")
        expect(back).to_have_count(1)
        box = back.bounding_box()
        self.assertGreaterEqual(min(box["width"], box["height"]), 44, f"‹ AI on touch: {box}")

    def test_05b_segmented_choices_size_each_option_to_its_label_and_keep_its_room(self) -> None:
        """#1219: Model (under More, #1419) gives each option its label and 14 px each side, not an equal share of the group, so the longest
        label never fills its pill edge to edge. Where the group has no room for one row (a phone) the options wrap instead of overflowing.
        A plan's models are segments; an API key's are a dropdown (#1218), so the Model group measured here is a Claude plan's."""
        agent = self.api(self.page(), "GET", f"/api/v1/my-agents/{self.ids['planner']}")
        for label, phone, viewport in (("1440", False, None), ("390", True, PHONE), ("320", True, {"width": 320, "height": 640})):
            page = self.page(phone=phone, viewport=viewport)
            self.stub_plan_models(page, agent)
            page.goto(f"/settings/agents/{self.ids['planner']}")
            expect(page.get_by_role("switch", name="Ask me first")).to_be_visible()
            page.get_by_role("button", name="More settings").click()
            # The model choices arrive after the page does.
            expect(page.get_by_role("group", name=re.compile("^Model")).get_by_role("radio").first).to_be_visible()
            groups = page.evaluate("""() => [...document.querySelectorAll('#agent-more [role=radiogroup]')].map((group) => {
              const frame = group.getBoundingClientRect();
              return { name: group.getAttribute('aria-labelledby'), options: [...group.querySelectorAll('[role=radio]')].map((button) => {
                const range = document.createRange(); range.selectNodeContents(button);
                const text = range.getBoundingClientRect(), box = button.getBoundingClientRect();
                return { label: button.textContent, left: text.left - box.left, right: box.right - text.right, lines: range.getClientRects().length,
                  inside: box.left >= frame.left - 0.5 && box.right <= frame.right + 0.5, checked: button.getAttribute('aria-checked') };
              }) };
            })""")
            models = [group for group in groups if str(group["name"]).startswith("model-")]
            self.assertGreaterEqual(len(models), 1, "the Model choice is on the page")
            for group in models:
                self.assertEqual(sum(option["checked"] == "true" for option in group["options"]), 1, group)
                for option in group["options"]:
                    where = f"{label}: {group['name']} / {option['label']}"
                    self.assertGreaterEqual(option["left"], 12, f"{where} keeps 12 px left of its label: {option}")
                    self.assertGreaterEqual(option["right"], 12, f"{where} keeps 12 px right of its label: {option}")
                    self.assertLessEqual(option["left"] + option["right"], 30, f"{where} is as wide as its label and 14 px each side, also alone on a wrapped row: {option}")
                    self.assertEqual(option["lines"], 1, f"{where} stays on one line")
                    self.assertTrue(option["inside"], f"{where} stays inside its group")
            self.assertLessEqual(page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth"), 0, f"{label}: no sideways scroll")
            page.locator("#agent-model").evaluate("el => el.scrollIntoView({ block: 'center' })")
            shot_both(page, f"1219-agent-choices-{label}-{UI_BROWSER}")

    def test_06_another_person_never_sees_an_agent_of_ada(self) -> None:
        ben = self.page("ben")
        self.assertNotIn("Planner", [item["name"] for item in self.api(ben, "GET", "/api/v1/my-agents")["items"]], "Ben never sees Ada's agents")
        self.api(ben, "GET", f"/api/v1/my-agents/{self.ids['planner']}", status=404)
        self.api(ben, "PATCH", f"/api/v1/my-agents/{self.ids['planner']}", {"name": "Mine now"}, status=404)
        self.api(ben, "DELETE", f"/api/v1/my-agents/{self.ids['planner']}", status=404)
        self.api(ben, "GET", f"/api/v1/my-agents/{self.ids['planner']}/memory", status=404)
        ben.goto(f"/settings/agents/{self.ids['planner']}")
        expect(ben.get_by_text("This agent isn’t here")).to_be_visible()

    def test_07_deleting_an_agent_asks_first_and_removes_it_everywhere(self) -> None:
        page = self.page()
        page.goto(f"/settings/agents/{self.ids['planner']}")
        page.get_by_role("button", name="Delete Planner").click()
        expect(page.get_by_text("Its open tasks go back to you")).to_be_visible()
        page.get_by_role("button", name="Keep").click()
        self.assertEqual(len(self.api(page, "GET", "/api/v1/my-agents")["items"]), 2)
        page.get_by_role("button", name="Delete Planner").click()
        page.get_by_role("group", name="Delete Planner").get_by_role("button", name="Delete Planner").click()
        expect(page.get_by_role("list", name="Your agents")).to_be_visible()
        expect(page.get_by_role("list", name="Your agents").get_by_role("link", name=re.compile("^Planner"))).to_have_count(0)
        self.assertEqual([item["name"] for item in self.api(page, "GET", "/api/v1/my-agents")["items"]], ["Assistant"])
        self.api(page, "GET", f"/api/v1/my-agents/{self.ids['planner']}", status=404)

    def test_08_the_only_agent_stays_deleted(self) -> None:
        page = self.page()
        page.goto(f"/settings/agents/{self.ids['assistant']}")
        page.get_by_role("button", name="Delete Assistant").click()
        page.get_by_role("group", name="Delete Assistant").get_by_role("button", name="Delete Assistant").click()
        expect(page.get_by_text("You have no agents. Make one with New agent.")).to_be_visible()
        self.assertEqual(self.api(page, "GET", "/api/v1/my-agents")["items"], [])
        # Opening Settings again, and connecting another key, never bring it back: Assistant is made once, for the first connection.
        page.reload()
        expect(page.get_by_text("You have no agents. Make one with New agent.")).to_be_visible()
        self.api(page, "POST", "/api/v1/background-compute-connections", {"name": "A second key", "provider": "anthropic", "model": "claude-sonnet-5",
                 "apiKey": SECOND_KEY, "dailyBudgetCents": 750, "timeZone": "Europe/Warsaw"}, status=201)
        page.reload()
        expect(page.get_by_text("You have no agents. Make one with New agent.")).to_be_visible()
        self.assertEqual(self.api(page, "GET", "/api/v1/my-agents")["items"], [])

    def test_09_a_guest_has_no_ai_in_settings(self) -> None:
        # A guest has no agents and no AI (AG-2): no AI section, no Connect AI, a plain line at the address, and the server refuses.
        gus = self.page("gus")
        gus.goto("/settings")
        expect(gus.get_by_role("navigation", name="Settings sections").get_by_role("link", name="Account")).to_be_visible()
        expect(gus.get_by_role("navigation", name="Settings sections").get_by_role("link", name="AI", exact=True)).to_have_count(0)
        # Messages lists no agent of a guest's, and the server lists none (#1035).
        expect(gus.locator("[data-agent]")).to_have_count(0)
        gus.goto("/settings/agents")
        expect(gus.get_by_text("Guests don’t have AI.")).to_be_visible()
        expect(gus.get_by_role("region", name="Connect AI", exact=True)).to_have_count(0)
        expect(gus.get_by_role("region", name="Your agents", exact=True)).to_have_count(0)
        # Every other AI address leads a guest to that one line, not to a page of controls (#959).
        for address in ("/settings/ai-connections", "/settings/ai-connections?new=1", "/settings/agents/connect", "/settings/agents/claude-code",
                        "/settings/agents/codex", f"/settings/agents/{self.ids['assistant']}"):
            gus.goto(address)
            expect(gus.get_by_text("Guests don’t have AI.")).to_be_visible()
            self.assertEqual(re.sub(r"^https?://[^/]+", "", gus.url), "/settings/agents", address)
        expect(gus.get_by_role("button", name=re.compile("Add a key|Connect AI|Sign in"))).to_have_count(0)
        self.api(gus, "POST", "/api/v1/my-agents", {"workspaceId": self.ids["workspace"], "name": "Sneaky"}, status=403)
        self.assertEqual(self.api(gus, "GET", "/api/v1/my-agents")["items"], [])
        phone = self.page("gus", phone=True)
        phone.goto("/settings")
        expect(phone.get_by_role("link", name="Company")).to_be_visible()
        expect(phone.get_by_role("link", name=re.compile("^AI\\b"))).to_have_count(0)

    def test_10_a_first_key_saved_on_the_keys_page_shows_the_assistant_on_back_to_ai(self) -> None:
        # Ben has connected nothing. The server makes his Assistant when the key is saved; Back to AI must not show the earlier list (#959).
        ben = self.page("ben")
        ben.goto("/settings/ai-connections?new=1")
        choose(ben.get_by_label("Provider", exact=True), label="Anthropic")
        ben.get_by_label("API key", exact=True).fill(f"sk-ant-api03-{'agents-ui-ben-' * 3}AG03")
        ben.get_by_label("API key", exact=True).blur()
        choose(ben.get_by_label("Model", exact=True), value="claude-sonnet-5")
        ben.get_by_label("Name", exact=True).fill("Ben's Anthropic key")
        ben.get_by_label("Daily budget (USD)", exact=True).last.fill("5")
        ben.get_by_role("button", name="Connect", exact=True).click()
        expect(ben.locator(".background-settings__connection")).to_have_count(1)
        ben.get_by_role("link", name="Back to AI").click()
        expect(ben.get_by_role("list", name="Your agents").get_by_role("link", name=re.compile("^Assistant"))).to_be_visible()
        expect(ben.get_by_text("You have no agents. Make one with New agent.")).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
