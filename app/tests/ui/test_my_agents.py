"""Browser tests for a person's agents (F-036 AG-1, #857): the list in Settings > AI, one agent's page, and Messages.

Runs with the other tests/ui journeys through scripts/check_ui.sh. That stack is composed with the TEST-ONLY switch
`FLUX_TEST_PERSONAL_RUNS=anthropic-mock`: every person has a fixture API key connection, which is not a connection the
person made, so no agent exists until Ada connects AI herself and the server makes Assistant. Nothing here calls a model. Ada makes
a second agent, Planner, gives it instructions, a model, "What it may do" and something to remember, finds it in
Messages and deletes it; Ben, in the same company, never sees any of it. Computer and phone widths.
"""

from __future__ import annotations

import os
import re
import time
import unittest

from playwright.sync_api import Browser, expect, sync_playwright

from app_select import choose
from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

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

    def page(self, who: str = "ada", *, phone: bool = False):
        options = {"service_workers": "block", "base_url": ORIGIN, "storage_state": self.states[who], "locale": "en-GB", "reduced_motion": "reduce"}
        options.update(viewport=PHONE, is_mobile=True, has_touch=True, device_scale_factor=3) if phone else options.update(viewport=DESKTOP)
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
        window.get_by_label("Model", exact=True).fill("claude-sonnet-5")
        window.get_by_label("Name", exact=True).fill("Ada's Anthropic key")
        window.get_by_label("API key", exact=True).fill(KEY)
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

    def test_02_a_new_agent_has_a_name_instructions_a_model_what_it_may_do_and_a_colour(self) -> None:
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
        # A second model, if the connection offers one, is a click; the choice is the one the server kept.
        group = page.get_by_role("group", name=re.compile("^Model"))
        radios = group.get_by_role("radio")
        self.assertGreaterEqual(radios.count(), 1)
        page.get_by_role("radio", name="Ask me first").click()
        expect(page.get_by_role("radio", name="Ask me first")).to_be_checked()
        stored = self.api(page, "GET", f"/api/v1/my-agents/{self.ids['planner']}")
        self.assertEqual((stored["name"], stored["instructions"], stored["mayDo"], stored["answersAi"]), ("Planner", INSTRUCTIONS, "ask", False))
        self.assertIn(stored["colour"], ("clay", "ochre", "sage", "teal", "indigo", "plum", "rose"), "a later agent gets a colour of the palette")
        page.reload()
        expect(page.get_by_label("Instructions")).to_have_value(INSTRUCTIONS)
        expect(page.get_by_role("radio", name="Ask me first")).to_be_checked()
        shot(page, "my-agent-page-1440")

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

    def test_06_another_person_never_sees_an_agent_of_ada(self) -> None:
        ben = self.page("ben")
        self.assertNotIn("Planner", [item["name"] for item in self.api(ben, "GET", "/api/v1/my-agents")["items"]], "Ben never sees Ada's agents")
        self.api(ben, "GET", f"/api/v1/my-agents/{self.ids['planner']}", status=404)
        self.api(ben, "PATCH", f"/api/v1/my-agents/{self.ids['planner']}", {"name": "Mine now"}, status=404)
        self.api(ben, "DELETE", f"/api/v1/my-agents/{self.ids['planner']}", status=404)
        self.api(ben, "GET", f"/api/v1/my-agents/{self.ids['planner']}/memory", status=404)
        ben.goto(f"/settings/agents/{self.ids['planner']}")
        expect(ben.get_by_text("This agent isn’t here.")).to_be_visible()

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
        gus.goto("/settings/agents")
        expect(gus.get_by_text("Guests don’t have AI.")).to_be_visible()
        expect(gus.get_by_role("region", name="Connect AI", exact=True)).to_have_count(0)
        expect(gus.get_by_role("region", name="Your agents", exact=True)).to_have_count(0)
        self.api(gus, "POST", "/api/v1/my-agents", {"workspaceId": self.ids["workspace"], "name": "Sneaky"}, status=403)
        self.assertEqual(self.api(gus, "GET", "/api/v1/my-agents")["items"], [])
        phone = self.page("gus", phone=True)
        phone.goto("/settings")
        expect(phone.get_by_role("link", name="Company")).to_be_visible()
        expect(phone.get_by_role("link", name=re.compile("^AI\\b"))).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
