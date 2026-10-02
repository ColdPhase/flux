"""Browser tests for the project Agents view (Studio 11.6 UI116-2, issue #136).

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose
application. Hubert connects two clients (Codex and Claude Code) and Marek one, all selected for
one restricted project. Agents lists all three as separate entries with their owner and a
truthful state, and its composer writes to the same canonical task thread the API returns.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "two agents share one lamp"
STAMP = int(time.time() * 1000)
HUBERT = {"name": "Hubert Nowak", "email": f"hubert.n+{STAMP}@example.test"}
MAREK = {"name": "Marek Lis", "email": f"marek.l+{STAMP}@example.test"}
OUTSIDER = {"name": "Lee Park", "email": f"lee.agents+{STAMP}@example.test"}
TASK = "Restore the connection to the lamp"


class AgentsViewJourney(unittest.TestCase):
    """Tests run in name order and share three accounts and one project."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, who: str | None, *, phone: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
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

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None) -> dict | list:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def connect(self, page: Page, workspace: str, project: str, agent_name: str, connections: list[tuple[str, str]]) -> None:
        agent = self.api(page, "POST", f"/api/v1/workspaces/{workspace}/agents", {"name": agent_name, "owner": "self"}, status=201)
        hubert = self.page("hubert")
        self.api(hubert, "POST", f"/api/v1/projects/{project}/grants", {"principal": {"kind": "agent", "id": agent["id"]}, "role": "contributor"}, status=201)
        for name, client in connections:
            self.api(page, "POST", "/api/v1/agent-connections", {"agentId": agent["id"], "selectedProjectIds": [project],
                     "scopes": ["flux.context.read", "flux.proposal.write"], "name": name, "clientDesignation": client}, status=201)

    def open_agents(self, who: str, **kwargs) -> Page:
        page = self.page(who, **kwargs)
        page.goto(f"/projects/{self.ids['project']}/agents")
        expect(page.get_by_role("heading", level=1, name="Working together")).to_be_visible()
        return page

    def test_01_two_owners_connect_three_agents(self) -> None:
        for key, person in {"hubert": HUBERT, "marek": MAREK, "outsider": OUTSIDER}.items():
            page = self.page(None)
            page.goto("/sign-up")
            page.get_by_label("Name").fill(person["name"])
            page.get_by_label("Email").fill(person["email"])
            page.get_by_label("Password").fill(PASSWORD)
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            type(self).states[key] = page.context.storage_state()
            person["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        hubert = self.page("hubert")
        marek = self.page("marek")
        ws = self.api(hubert, "POST", "/api/v1/workspaces", {"name": "Lamp workshop"}, status=201)
        for person in (MAREK, OUTSIDER):
            self.api(hubert, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": person["email"], "role": "member"}, status=201)
        project = self.api(hubert, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Arduino lamp", "visibility": "restricted"}, status=201)
        pid = project["id"]
        self.api(hubert, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": MAREK["id"]}, "role": "contributor"}, status=201)
        self.connect(hubert, ws["id"], pid, "Hubert's coding agent", [("Desk laptop", "codex"), ("Travel laptop", "claude_code")])
        self.connect(marek, ws["id"], pid, "Marek's coding agent", [("Workshop PC", "claude_code")])
        task = self.api(hubert, "POST", f"/api/v1/projects/{pid}/work", {"title": TASK, "status": "in_progress"}, status=201)
        type(self).ids = {"workspace": ws["id"], "project": pid, "task": task["id"]}

    def test_02_every_connection_is_its_own_entry_with_owner_and_state(self) -> None:
        page = self.open_agents("hubert")
        tabs = page.get_by_role("navigation", name="Project views")
        expect(tabs.get_by_role("link", name=re.compile("^Agents"))).to_have_attribute("aria-current", "page")
        connections = page.get_by_role("list", name="Agent connections in this project").get_by_role("listitem")
        expect(connections).to_have_count(3)
        texts = connections.all_inner_texts()
        self.assertEqual(sum("Hubert Nowak (you)" in text for text in texts), 2, "both of Hubert's agents are listed")
        self.assertTrue(any("Codex" in text and "Desk laptop" in text for text in texts))
        self.assertTrue(any("Claude Code" in text and "Travel laptop" in text for text in texts))
        self.assertTrue(any("Claude Code" in text and "Marek Lis" in text and "Workshop PC" in text for text in texts))
        for text in texts:
            self.assertRegex(text, "Not signed in", "a configured connection never looks busy")
        api = self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/agents", status=200)
        self.assertEqual(len(api["connections"]), 3)
        shot(page, "agents-desktop-1440")
        marek = self.open_agents("marek")
        texts = marek.get_by_role("list", name="Agent connections in this project").get_by_role("listitem").all_inner_texts()
        self.assertEqual(sum("(you)" in text for text in texts), 1, "Marek owns exactly one of them")

    def test_03_the_composer_writes_to_the_task_thread(self) -> None:
        page = self.open_agents("hubert")
        expect(page.get_by_label("Task", exact=True)).to_have_value(self.ids["task"])
        expect(page.get_by_text("No one has written about this task yet")).to_be_visible()
        box = page.get_by_label("Write to this task")
        box.fill("I'll take the reconnect bug with Codex; Claude Code reviews it.")
        box.press("Enter")
        thread = page.get_by_role("region", name=f"Thread of {TASK}")
        expect(thread.get_by_text("I'll take the reconnect bug with Codex")).to_be_visible()
        expect(box).to_have_value("")
        discussion = self.api(page, "GET", f"/api/v1/work/{self.ids['task']}/discussion", status=200)
        self.assertEqual(discussion["root"]["body"], "I'll take the reconnect bug with Codex; Claude Code reviews it.")
        self.assertEqual(discussion["root"]["authorId"], HUBERT["id"])
        marek = self.open_agents("marek")
        expect(marek.get_by_text("I'll take the reconnect bug with Codex")).to_be_visible()
        reply = marek.get_by_label("Write to this task")
        reply.fill("OK. Workshop PC is offline until tonight.")
        marek.get_by_role("button", name="Send to task").click()
        expect(marek.get_by_text("Workshop PC is offline until tonight")).to_be_visible()
        page.reload()
        expect(page.get_by_text("Workshop PC is offline until tonight")).to_be_visible()
        discussion = self.api(page, "GET", f"/api/v1/work/{self.ids['task']}/discussion", status=200)
        bodies = [discussion["root"]["body"], *[m["body"] for m in discussion["messages"] if m["id"] != discussion["root"]["id"]]]
        self.assertEqual(bodies.count("OK. Workshop PC is offline until tonight."), 1, "one send, one message")

    def test_04_a_draft_survives_leaving_the_view(self) -> None:
        page = self.open_agents("hubert")
        page.get_by_label("Write to this task").fill("Half-written note about the firmware")
        page.get_by_role("navigation", name="Project views").get_by_role("link", name=re.compile("^Tasks")).click()
        page.get_by_role("navigation", name="Project views").get_by_role("link", name=re.compile("^Agents")).click()
        expect(page.get_by_label("Write to this task")).to_have_value("Half-written note about the firmware")

    def test_05_outsiders_cannot_open_the_view(self) -> None:
        outsider = self.page("outsider")
        self.api(outsider, "GET", f"/api/v1/projects/{self.ids['project']}/agents", status=404)
        outsider.goto(f"/projects/{self.ids['project']}/agents")
        expect(outsider.get_by_role("heading", level=1, name="Working together")).to_have_count(0)

    def test_06_phone_keeps_entries_and_composer_usable(self) -> None:
        page = self.open_agents("hubert", phone=True)
        expect(page.get_by_role("list", name="Agent connections in this project").get_by_role("listitem")).to_have_count(3)
        expect(page.get_by_label("Write to this task")).to_be_visible()
        overflow = page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
        self.assertLessEqual(overflow, 0, "no horizontal page scroll at 390px")
        shot(page, "agents-phone-390")


if __name__ == "__main__":
    unittest.main()
