"""Browser tests for the agents' thread of a task (#400, F-018 CW-2), in the Agents tab and from the task's Details.

Hubert manages a project with Marek (a contributor) and Vera (a viewer). Hubert's Codex holds a task. The task's agents'
thread opens in the Agents tab's detail panel (computer) or sheet (phone) from the agent's Now card and from the task's
Details link; people with write access write to it and a viewer only reads it; it is a different space from the task's
conversation. Agents cannot write to it yet (their tools are a later gate), so every message here is a person's.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot as save_shot, start_forwarder

PASSWORD = "the agents keep one thread"
STAMP = int(time.time() * 1000)
HUBERT = {"name": "Hubert Nowak", "email": f"hubert.threads+{STAMP}@example.test"}
MAREK = {"name": "Marek Lis", "email": f"marek.threads+{STAMP}@example.test"}
VERA = {"name": "Vera Cole", "email": f"vera.threads+{STAMP}@example.test"}
TASK = "Restore the connection to the lamp"
THREAD = f"Agents’ thread of {TASK}"


def shot(page: Page, name: str) -> None:
    save_shot(page, name if UI_BROWSER == "chromium" else f"{name}-{UI_BROWSER}")


class AgentThreadJourney(unittest.TestCase):
    """Tests run in name order and share three accounts, one project, one agent and one task."""

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
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str | None, *, phone: bool = False, dark: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "service_workers": "block"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        if who and who in self.states:
            options["storage_state"] = self.states[who]
        context: BrowserContext = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
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

    def thread_url(self) -> str:
        return f"/projects/{self.ids['project']}/agents?thread={self.ids['task']}"

    def test_01_the_fixture(self) -> None:
        for key, person in {"hubert": HUBERT, "marek": MAREK, "vera": VERA}.items():
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
        ws = self.api(hubert, "POST", "/api/v1/workspaces", {"name": "Lamp workshop"}, status=201)
        for person in (MAREK, VERA):
            self.api(hubert, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": person["email"], "role": "member"}, status=201)
        pid = self.api(hubert, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Arduino lamp", "visibility": "restricted"}, status=201)["id"]
        for person, role in ((MAREK, "contributor"), (VERA, "viewer")):
            self.api(hubert, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": person["id"]}, "role": role}, status=201)
        agent = self.api(hubert, "POST", f"/api/v1/workspaces/{ws['id']}/agents", {"name": "Codex", "owner": "self"}, status=201)
        self.api(hubert, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "agent", "id": agent["id"]}, "role": "contributor"}, status=201)
        self.api(hubert, "POST", "/api/v1/agent-connections", {"agentId": agent["id"], "selectedProjectIds": [pid],
                 "scopes": ["flux.context.read", "flux.proposal.write"], "name": "Desk laptop", "clientDesignation": "codex"}, status=201)
        task = self.api(hubert, "POST", f"/api/v1/projects/{pid}/work", {"title": TASK, "status": "in_progress", "owner": {"kind": "agent", "id": agent["id"]}}, status=201)
        type(self).ids = {"workspace": ws["id"], "project": pid, "task": task["id"], "agent": agent["id"]}

    def test_02_the_task_details_link_opens_the_thread_in_the_agents_tab(self) -> None:
        page = self.page("hubert")
        page.goto(f"/projects/{self.ids['project']}/tasks?open=work:{self.ids['task']}")
        link = page.get_by_role("link", name=re.compile("^Agents’ thread"))
        expect(link).to_have_text(re.compile("Agents’ thread · 0 messages"))
        link.click()
        expect(page).to_have_url(re.compile(r"/agents\?thread="))
        thread = page.get_by_role("region", name=THREAD)
        expect(thread).to_be_visible()
        expect(thread.get_by_text("Agents’ thread · visible to everyone with access to this project")).to_be_visible()
        expect(thread.get_by_text("No one has written to the agents about this task yet")).to_be_visible()
        # Opening a thread is a read: nothing was created (the thread reports no conversation).
        self.assertIsNone(self.api(page, "GET", f"/api/v1/work/{self.ids['task']}/agent-thread", status=200)["conversation"])
        expect(page.get_by_placeholder("Write to the agents…")).to_be_visible()
        shot(page, "agent-thread-empty-1440")

    def test_03_a_person_writes_and_the_task_conversation_stays_apart(self) -> None:
        page = self.page("hubert")
        page.goto(self.thread_url())
        box = page.get_by_label("Write to the agents")
        box.fill("Codex: please start with the reconnect loop.")
        page.get_by_role("button", name="Send to the agents").click()
        thread = page.get_by_role("region", name=THREAD)
        expect(thread.get_by_text("Codex: please start with the reconnect loop.")).to_be_visible()
        expect(box).to_have_value("")
        expect(thread.locator("[data-client-message-id]")).to_have_count(0)
        stored = self.api(page, "GET", f"/api/v1/work/{self.ids['task']}/agent-thread", status=200)
        self.assertEqual(stored["messageCount"], 1)
        self.assertEqual(stored["conversation"]["messages"][0]["authorId"], HUBERT["id"])
        # The task's own conversation has nothing of it; people's lists stay quiet.
        self.assertEqual(self.api(page, "GET", f"/api/v1/work/{self.ids['task']}/discussion", status=200)["messages"], [])
        self.assertEqual(self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/conversations", status=200)["total"], 0)
        # A reload keeps it; the Details link counts it.
        page.reload()
        expect(page.get_by_role("region", name=THREAD).get_by_text("Codex: please start with the reconnect loop.")).to_be_visible()
        page.goto(f"/projects/{self.ids['project']}/tasks?open=work:{self.ids['task']}")
        expect(page.get_by_role("link", name=re.compile("^Agents’ thread"))).to_have_text(re.compile("Agents’ thread · 1 message$"))
        # Negative control: the task's people thread (`?task=`) is the other space and does not show the message.
        page.goto(f"/projects/{self.ids['project']}/agents?task={self.ids['task']}")
        people = page.get_by_role("region", name=f"Thread of {TASK}")
        expect(people).to_be_visible()
        expect(people.get_by_text("Codex: please start with the reconnect loop.")).to_have_count(0)

    def test_04_the_agents_now_card_opens_the_thread_and_a_colleague_sees_it(self) -> None:
        page = self.page("hubert")
        page.goto(f"/projects/{self.ids['project']}/agents")
        page.get_by_role("list", name="Agents in this project").get_by_role("listitem").first.get_by_role("button").first.click()
        page.get_by_role("button", name="Open the thread of #1").click()
        expect(page).to_have_url(re.compile(r"agents\?.*thread="))
        expect(page.get_by_role("region", name=THREAD).get_by_text("Codex: please start with the reconnect loop.")).to_be_visible()
        marek = self.page("marek")
        marek.goto(self.thread_url())
        expect(marek.get_by_role("region", name=THREAD).get_by_text("Codex: please start with the reconnect loop.")).to_be_visible()
        marek.get_by_label("Write to the agents").fill("Marek: the workshop PC is offline until tonight.")
        marek.get_by_role("button", name="Send to the agents").click()
        expect(marek.get_by_role("region", name=THREAD).get_by_text("workshop PC is offline until tonight")).to_be_visible()
        # The other reader sees it without a reload (the project's one stream).
        expect(page.get_by_role("region", name=THREAD).get_by_text("workshop PC is offline until tonight")).to_be_visible(timeout=8000)

    def test_05_a_viewer_reads_but_cannot_write_and_a_stranger_gets_nothing(self) -> None:
        vera = self.page("vera")
        vera.goto(self.thread_url())
        thread = vera.get_by_role("region", name=THREAD)
        expect(thread.get_by_text("Codex: please start with the reconnect loop.")).to_be_visible()
        expect(vera.get_by_label("Write to the agents")).to_be_disabled()
        expect(vera.get_by_placeholder("You can read this thread but not write to it.")).to_be_visible()
        self.api(vera, "POST", f"/api/v1/work/{self.ids['task']}/agent-thread", {"body": "from a viewer", "clientMessageId": str(uuid.uuid4())}, status=403)
        stranger = self.page(None)
        stranger.goto("/sign-in")
        self.api(stranger, "GET", f"/api/v1/work/{self.ids['task']}/agent-thread", status=401)

    def test_06_a_failed_send_keeps_the_text(self) -> None:
        page = self.page("hubert")
        page.goto(self.thread_url())
        page.route(f"**/api/v1/work/{self.ids['task']}/agent-thread", lambda route: route.abort() if route.request.method == "POST" else route.continue_())
        box = page.get_by_label("Write to the agents")
        box.fill("Kept while Flux is unreachable")
        page.get_by_role("button", name="Send to the agents").click()
        expect(page.locator("[data-client-message-id]")).to_have_count(1)
        # Negative control: once the route is released the same queued message is stored exactly once.
        page.unroute(f"**/api/v1/work/{self.ids['task']}/agent-thread")
        page.get_by_role("button", name="Retry").click()
        expect(page.get_by_role("region", name=THREAD).get_by_text("Kept while Flux is unreachable")).to_have_count(1)
        expect(page.locator("[data-client-message-id]")).to_have_count(0)
        bodies = [m["body"] for m in self.api(page, "GET", f"/api/v1/work/{self.ids['task']}/agent-thread", status=200)["conversation"]["messages"]]
        self.assertEqual(bodies.count("Kept while Flux is unreachable"), 1)

    def test_07_phone_and_dark(self) -> None:
        phone = self.page("hubert", phone=True)
        phone.goto(self.thread_url())
        thread = phone.get_by_role("region", name=THREAD)
        expect(thread).to_be_visible()
        expect(phone.get_by_label("Write to the agents")).to_be_visible()
        expect(phone.get_by_role("list", name="Agents in this project")).to_be_hidden()
        self.assertLessEqual(phone.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth"), 0, "no horizontal scroll at 390px")
        shot(phone, "agent-thread-phone-390")
        dark = self.page("hubert", dark=True)
        dark.goto(self.thread_url())
        expect(dark.get_by_role("region", name=THREAD).get_by_text("Marek: the workshop PC is offline until tonight.")).to_be_visible()
        shot(dark, "agent-thread-dark-1440")
        dark_phone = self.page("hubert", phone=True, dark=True)
        dark_phone.goto(self.thread_url())
        expect(dark_phone.get_by_role("region", name=THREAD)).to_be_visible()
        shot(dark_phone, "agent-thread-phone-dark-390")
        # Closing the sheet returns to the agents list.
        phone.get_by_role("button", name="Close thread").tap()
        expect(phone.get_by_role("list", name="Agents in this project")).to_be_visible()

    def test_08_an_agents_reply_appears_in_the_thread_and_on_its_now_card(self) -> None:
        # The agent's own write (flux_post_agent_thread, guarded and receipted) is proved by the API tests; here the stored
        # first message is shown as the agent's, as the server returns it, to check how the Agents tab reads an agent's line.
        agent = self.ids["agent"]

        def as_agent(route) -> None:
            if route.request.method != "GET":
                route.continue_()
                return
            response = route.fetch()
            body = response.json()
            messages = (body.get("conversation") or {}).get("messages", [])
            if messages:
                messages[-1].update({"authorId": None, "author": {"kind": "agent", "id": agent, "name": "Codex"}, "body": "PR 42 is ready at a1b2c3d."})
            route.fulfill(response=response, json=body)

        page = self.page("hubert")
        page.route(re.compile(rf".*/api/v1/work/{self.ids['task']}/agent-thread(\?.*)?$"), as_agent)
        page.goto(self.thread_url())
        thread = page.get_by_role("region", name=THREAD)
        expect(thread.get_by_text("PR 42 is ready at a1b2c3d.")).to_be_visible()
        expect(thread.locator(".agents-msg--agent")).to_have_count(1)
        # The Now card of the agent shows that latest line.
        page.goto(f"/projects/{self.ids['project']}/agents")
        page.get_by_role("list", name="Agents in this project").get_by_role("listitem").first.get_by_role("button").first.click()
        expect(page.get_by_role("button", name="Open the thread of #1")).to_contain_text("PR 42 is ready at a1b2c3d.")
        shot(page, "agent-thread-agent-reply-now-card-1440")
        phone = self.page("hubert", phone=True)
        phone.route(re.compile(rf".*/api/v1/work/{self.ids['task']}/agent-thread(\\?.*)?$"), as_agent)
        phone.goto(self.thread_url())
        expect(phone.get_by_role("region", name=THREAD).get_by_text("PR 42 is ready at a1b2c3d.")).to_be_visible()
        # The standard 16px side padding: the thread's text is not flush to the screen edge.
        self.assertGreaterEqual(phone.locator(".agents-thread__top").evaluate("el => el.getBoundingClientRect().left"), 15)
        shot(phone, "agent-thread-agent-reply-phone-390")


if __name__ == "__main__":
    unittest.main()
