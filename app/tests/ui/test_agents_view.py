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
# The page's sockets are recorded; while __fluxDown is set, every new one fails before it opens.
RECORD_SOCKETS = """(() => {
  const Native = window.WebSocket;
  window.__fluxSockets = [];
  window.__fluxDown = false;
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args);
      window.__fluxSockets.push(this);
      if (window.__fluxDown) this.close();
    }
  };
})()"""
STREAM_OPEN = "() => window.__fluxSockets.some((ws) => ws.url.includes('/api/v1/stream') && ws.readyState === 1)"
NEWEST_PLACEMENT = """() => {
  const items = [...document.querySelectorAll('.agents-thread__list > li')];
  const last = items[items.length - 1].getBoundingClientRect();
  const composer = document.querySelector('.agents-composer').getBoundingClientRect();
  const hit = document.elementFromPoint(last.left + 8, last.top + last.height / 2);
  return { lastBottom: last.bottom, composerTop: composer.top, visible: !!hit && !!hit.closest('.agents-thread__list') };
}"""


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
        # Tests 04c, 04d and 09 change requests with page.route, which Playwright does not apply reliably to a
        # page controlled by a service worker: a send went to the server unrouted with the app's worker in
        # control (#271). Playwright's documented remedy is blocking service workers; pwa.e2e.ts covers the
        # worker itself, and nothing here depends on it.
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "service_workers": "block"}
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
        # Sending is instant (#264): the message shows at once and is stored a moment later.
        expect(thread.locator("[data-client-message-id]")).to_have_count(0)
        discussion = self.api(page, "GET", f"/api/v1/work/{self.ids['task']}/discussion", status=200)
        self.assertEqual(discussion["root"]["body"], "I'll take the reconnect bug with Codex; Claude Code reviews it.")
        self.assertEqual(discussion["root"]["authorId"], HUBERT["id"])
        marek = self.open_agents("marek")
        expect(marek.get_by_role("region", name=f"Thread of {TASK}").get_by_text("I'll take the reconnect bug with Codex")).to_be_visible()
        reply = marek.get_by_label("Write to this task")
        reply.fill("OK. Workshop PC is offline until tonight.")
        marek.get_by_role("button", name="Send to task").click()
        expect(marek.get_by_role("region", name=f"Thread of {TASK}").get_by_text("Workshop PC is offline until tonight")).to_be_visible()
        expect(marek.locator("[data-client-message-id]")).to_have_count(0)
        page.reload()
        expect(page.get_by_role("region", name=f"Thread of {TASK}").get_by_text("Workshop PC is offline until tonight")).to_be_visible()
        discussion = self.api(page, "GET", f"/api/v1/work/{self.ids['task']}/discussion", status=200)
        bodies = [discussion["root"]["body"], *[m["body"] for m in discussion["messages"] if m["id"] != discussion["root"]["id"]]]
        self.assertEqual(bodies.count("OK. Workshop PC is offline until tonight."), 1, "one send, one message")

    def thread(self, page: Page):
        return page.get_by_role("region", name=f"Thread of {TASK}")

    def contribute(self, who: str, body: str) -> None:
        self.api(self.page(who), "POST", f"/api/v1/work/{self.ids['task']}/discussion", {"body": body, "clientMessageId": str(uuid.uuid4()), "kind": "text"}, status=201)

    def test_03b_another_persons_contribution_arrives_without_reload(self) -> None:
        # Both have the thread open; neither reloads (#183 B1). Live within a few seconds, well
        # before the 15 s fallback refresh, so this is the event stream at work.
        hubert = self.open_agents("hubert")
        expect(self.thread(hubert).get_by_text("Workshop PC is offline until tonight")).to_be_visible()
        box = hubert.get_by_label("Write to this task")
        box.fill("Then I'll flash it tonight.")
        marek = self.open_agents("marek")
        expect(self.thread(marek).get_by_text("Workshop PC is offline until tonight")).to_be_visible()
        marek.get_by_label("Write to this task").fill("Independent review: Marek repaired the cable")
        marek.get_by_role("button", name="Send to task").click()
        expect(self.thread(marek).get_by_text("Independent review: Marek repaired the cable")).to_have_count(1)
        expect(self.thread(hubert).get_by_text("Independent review: Marek repaired the cable")).to_have_count(1, timeout=6000)
        expect(box).to_have_value("Then I'll flash it tonight.")
        # The reply goes to the same thread and each message shows once in both views.
        hubert.get_by_role("button", name="Send to task").click()
        expect(box).to_have_value("")
        expect(self.thread(hubert).get_by_text("Then I'll flash it tonight.")).to_have_count(1)
        expect(self.thread(marek).get_by_text("Then I'll flash it tonight.")).to_have_count(1, timeout=6000)
        expect(self.thread(marek).get_by_text("Independent review: Marek repaired the cable")).to_have_count(1)
        expect(self.thread(hubert).get_by_text("Independent review: Marek repaired the cable")).to_have_count(1)

    def test_03c_a_dropped_stream_recovers_what_was_missed(self) -> None:
        hubert = self.page("hubert")
        # The page's sockets are recorded; while the network is "down" every new one fails before it opens.
        hubert.add_init_script(RECORD_SOCKETS)
        hubert.goto(f"/projects/{self.ids['project']}/agents")
        expect(self.thread(hubert).get_by_text("Then I'll flash it tonight.")).to_be_visible()
        hubert.wait_for_function(STREAM_OPEN)
        # The connection drops and stays down while Marek writes; then the network returns.
        hubert.evaluate("() => { window.__fluxDown = true; window.__fluxSockets.forEach((ws) => ws.close()); }")
        self.contribute("marek", "Cable ordered while your link was down")
        hubert.wait_for_timeout(1500)
        hubert.evaluate("() => { window.__fluxDown = false; }")
        expect(self.thread(hubert).get_by_text("Cable ordered while your link was down")).to_have_count(1, timeout=12000)
        hubert.wait_for_function(STREAM_OPEN)
        self.assertGreaterEqual(hubert.evaluate("() => window.__fluxSockets.length"), 2, "the stream reconnected")

    def test_03d_new_messages_keep_an_earlier_reader_in_place_and_follow_one_at_the_end(self) -> None:
        page = self.open_agents("hubert", phone=True)
        thread = self.thread(page)
        expect(thread.get_by_text("Cable ordered while your link was down")).to_be_visible()
        pane = page.locator(".agents-scroll")
        self.assertGreater(pane.evaluate("el => el.scrollHeight - el.clientHeight"), 100, "the phone pane scrolls")
        pane.evaluate("el => { el.scrollTop = 0; }")
        self.contribute("marek", "Reading earlier? This one waits below.")
        expect(thread.get_by_text("Reading earlier? This one waits below.")).to_have_count(1, timeout=6000)
        self.assertLessEqual(pane.evaluate("el => el.scrollTop"), 2, "a reader of earlier messages is not moved")
        pane.evaluate("el => { el.scrollTop = el.scrollHeight; }")
        self.contribute("marek", "At the end, this one comes into view.")
        expect(thread.get_by_text("At the end, this one comes into view.")).to_have_count(1, timeout=6000)
        page.wait_for_timeout(200)
        placement = page.evaluate(NEWEST_PLACEMENT)
        self.assertTrue(placement["visible"], "the newest message is visible, not under the composer")
        self.assertLessEqual(placement["lastBottom"], placement["composerTop"] + 1)

    def test_03e_losing_access_hides_an_open_thread_and_keeps_the_draft(self) -> None:
        marek = self.open_agents("marek")
        expect(self.thread(marek).get_by_text("At the end, this one comes into view.")).to_be_visible()
        box = marek.get_by_label("Write to this task")
        box.fill("Unsent note from Marek")
        hubert = self.page("hubert")
        grants = self.api(hubert, "GET", f"/api/v1/projects/{self.ids['project']}/grants", status=200)
        grant = next(item for item in grants if item["principal"]["kind"] == "human" and item["principal"]["id"] == MAREK["id"])
        # A DELETE has no body, so it carries no JSON content type.
        revoked = hubert.request.fetch(f"{ORIGIN}/api/v1/projects/{self.ids['project']}/grants/{grant['id']}", method="DELETE", headers={"origin": ORIGIN})
        self.assertEqual(revoked.status, 204, revoked.text())
        try:
            # No event reaches someone who lost access; returning to the tab refetches.
            marek.evaluate("() => window.dispatchEvent(new Event('focus'))")
            expect(self.thread(marek).get_by_role("alert")).to_contain_text("You can no longer read this task")
            expect(self.thread(marek).get_by_text("At the end, this one comes into view.")).to_have_count(0)
            expect(box).to_be_disabled()
            expect(box).to_have_value("Unsent note from Marek")
        finally:
            self.api(hubert, "POST", f"/api/v1/projects/{self.ids['project']}/grants", {"principal": {"kind": "human", "id": MAREK["id"]}, "role": "contributor"}, status=201)
        marek.evaluate("() => window.dispatchEvent(new Event('focus'))")
        expect(self.thread(marek).get_by_text("At the end, this one comes into view.")).to_be_visible()
        expect(box).to_be_enabled()
        expect(box).to_have_value("Unsent note from Marek")
        box.fill("")

    def test_03f_a_real_outage_with_a_burst_recovers_without_reload(self) -> None:
        # #183 review B2: the device goes offline (HTTP and WebSocket), another person writes 66
        # messages, the device comes back. Its own task keeps the shared thread's window unchanged.
        hubert = self.page("hubert")
        task = self.api(hubert, "POST", f"/api/v1/projects/{self.ids['project']}/work", {"title": "Measure the lamp after dark"}, status=201)
        marek = self.page("marek")
        self.api(marek, "POST", f"/api/v1/work/{task['id']}/discussion", {"body": "Starting the night measurements.", "clientMessageId": str(uuid.uuid4()), "kind": "text"}, status=201)
        hubert.add_init_script(RECORD_SOCKETS)
        hubert.goto(f"/projects/{self.ids['project']}/agents?task={task['id']}")
        thread = hubert.get_by_role("region", name="Thread of Measure the lamp after dark")
        expect(thread.get_by_text("Starting the night measurements.")).to_be_visible()
        hubert.wait_for_function(STREAM_OPEN)
        box = hubert.get_by_label("Write to this task")
        box.fill("Draft kept through the outage")
        hubert.context.set_offline(True)
        hubert.evaluate("() => window.__fluxSockets.forEach((ws) => ws.close())")
        for index in range(1, 67):
            self.api(marek, "POST", f"/api/v1/work/{task['id']}/discussion", {"body": f"Reading {index:02d} while Hubert is offline", "clientMessageId": str(uuid.uuid4()), "kind": "text"}, status=201)
        hubert.wait_for_timeout(1500)
        expect(hubert.get_by_text("Flux can’t be reached")).to_have_count(0)
        hubert.context.set_offline(False)
        # Back online: the stream reconnects at once and the thread pages in the whole burst.
        expect(thread.get_by_text("Reading 66 while Hubert is offline")).to_be_visible(timeout=12000)
        expect(thread.get_by_text("Reading 01 while Hubert is offline")).to_have_count(1)
        expect(thread.locator(".agents-thread__list > li")).to_have_count(67)
        expect(hubert.get_by_text("Flux can’t be reached")).to_have_count(0)
        expect(box).to_have_value("Draft kept through the outage")
        hubert.wait_for_function(STREAM_OPEN)
        box.fill("")
        # Done, so the later tests still open on the original task (the view opens the first open one).
        current = self.api(hubert, "GET", f"/api/v1/work/{task['id']}", status=200)
        closed = hubert.request.fetch(f"{ORIGIN}/api/v1/work/{task['id']}", method="PATCH", data=json.dumps({"status": "done"}),
                                      headers={"origin": ORIGIN, "content-type": "application/json", "if-match": f'"{current["version"]}"'})
        self.assertEqual(closed.status, 200, closed.text())

    def test_04_a_draft_survives_leaving_the_view(self) -> None:
        page = self.open_agents("hubert")
        page.get_by_label("Write to this task").fill("Half-written note about the firmware")
        page.get_by_role("navigation", name="Project views").get_by_role("link", name=re.compile("^Tasks")).click()
        page.get_by_role("navigation", name="Project views").get_by_role("link", name=re.compile("^Agents")).click()
        expect(page.get_by_label("Write to this task")).to_have_value("Half-written note about the firmware")

    def test_04b_a_draft_belongs_to_its_account(self) -> None:
        page = self.open_agents("hubert")
        page.get_by_label("Write to this task").fill("Hubert's private half-thought")
        # Another account signs in within the same browser storage: Hubert's unsent text is not theirs.
        page.context.clear_cookies()
        page.context.add_cookies(self.states["marek"]["cookies"])
        page.goto(f"/projects/{self.ids['project']}/agents")
        expect(page.get_by_role("heading", level=1, name="Working together")).to_be_visible()
        expect(page.get_by_label("Write to this task")).to_have_value("")

    def test_04c_a_lost_response_is_retried_without_a_duplicate(self) -> None:
        page = self.open_agents("hubert")
        path = f"/api/v1/work/{self.ids['task']}/discussion"
        lost: list[str] = []

        def lose_first(route) -> None:
            if route.request.method != "POST" or lost:
                route.continue_()
                return
            route.fetch()  # the server commits the contribution ...
            lost.append(route.request.post_data or "")
            route.fulfill(status=503, body="{}")  # ... but the browser never learns it

        page.route(f"**{path}", lose_first)
        box = page.get_by_label("Write to this task")
        box.fill("Firmware 1.4 fixes the reconnect loop.")
        box.press("Enter")
        # Sending is instant (#264): the field empties at once and the message itself says it was not sent.
        queued = self.thread(page).locator("[data-client-message-id]").filter(has_text="Firmware 1.4 fixes the reconnect loop.")
        expect(queued.get_by_role("alert")).to_contain_text("Not sent")
        expect(box).to_have_value("")
        page.reload()
        # The unsent message and its command survive the reload.
        expect(queued.get_by_role("alert")).to_contain_text("Not sent")
        expect(box).to_have_value("")
        queued.get_by_role("button", name="Retry").click()
        expect(queued).to_have_count(0)
        expect(self.thread(page).get_by_text("Firmware 1.4 fixes the reconnect loop.")).to_have_count(1)
        discussion = self.api(page, "GET", path, status=200)
        bodies = [discussion["root"]["body"], *[m["body"] for m in discussion["messages"] if m["id"] != discussion["root"]["id"]]]
        self.assertEqual(bodies.count("Firmware 1.4 fixes the reconnect loop."), 1, "the retry reused the first attempt's message id")
        self.assertEqual(len(lost), 1, "exactly one attempt lost its response")

    def test_04d_a_failed_send_is_visible_on_a_phone(self) -> None:
        page = self.open_agents("hubert", phone=True)
        page.route(f"**/api/v1/work/{self.ids['task']}/discussion", lambda route: route.abort() if route.request.method == "POST" else route.continue_())
        page.get_by_label("Write to this task").fill("Battery check tonight")
        page.get_by_role("button", name="Send to task").click()
        # No answer from Flux (#264): the message waits on the page and the quiet line says why.
        queued = self.thread(page).locator("[data-client-message-id]").filter(has_text="Battery check tonight")
        expect(queued).to_contain_text("Waiting to send")
        expect(page.get_by_text("Flux isn’t responding. Messages wait here and send when it’s back.")).to_be_visible()
        queued.get_by_role("button", name="Remove").click()
        expect(page.get_by_label("Write to this task")).to_have_value("Battery check tonight")
        page.get_by_label("Write to this task").fill("")

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
        # The sections stack: the thread never starts above the task picker or the connections.
        boxes = page.evaluate("""() => ['.agents__connections', '.agents__task', '.agents-thread'].map((s) => {
          const r = document.querySelector(s).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; })""")
        self.assertLessEqual(boxes[0]["bottom"], boxes[1]["top"] + 1, "connections end before the task picker")
        self.assertLessEqual(boxes[1]["bottom"], boxes[2]["top"] + 1, "the task picker ends before the thread")
        # Every message is reachable: the view scrolls, and at its end the newest message sits above
        # the sticky composer instead of under it (independent delta review of 466daf8).
        thread = page.get_by_role("region", name=f"Thread of {TASK}")
        expect(thread.get_by_role("listitem").nth(2)).to_be_attached()
        # Opened without any manual scroll, the thread already shows its newest message above the composer.
        page.wait_for_timeout(300)
        placed = page.evaluate(NEWEST_PLACEMENT)
        self.assertLessEqual(placed["lastBottom"], placed["composerTop"] + 1, "on open, the newest message ends above the composer")
        self.assertTrue(placed["visible"], "on open, the newest message is not covered by the composer")
        page.locator(".agents-scroll").evaluate("el => { el.scrollTop = 0; }")
        page.locator(".agents-scroll").evaluate("el => { el.scrollTop = el.scrollHeight; }")
        page.wait_for_timeout(200)
        placed = page.evaluate(NEWEST_PLACEMENT)
        self.assertLessEqual(placed["lastBottom"], placed["composerTop"] + 1, "the newest message ends above the composer")
        self.assertTrue(placed["visible"], "the newest message is not covered by the composer")
        # A message just sent is shown above the composer too.
        page.get_by_label("Write to this task").fill("Phone check: the newest reply stays in view.")
        page.get_by_role("button", name="Send to task").click()
        expect(thread.get_by_text("Phone check: the newest reply stays in view.")).to_be_visible()
        page.wait_for_timeout(300)
        placed = page.evaluate(NEWEST_PLACEMENT)
        self.assertLessEqual(placed["lastBottom"], placed["composerTop"] + 1, "after a send, the newest message ends above the composer")
        self.assertTrue(placed["visible"], "after a send, the newest message is not covered by the composer")
        shot(page, "agents-phone-390")

    def test_07_the_thread_links_to_conversation_and_stays_by_the_composer(self) -> None:
        page = self.open_agents("hubert")
        thread = page.get_by_role("region", name=f"Thread of {TASK}")
        expect(thread.get_by_text("Workshop PC is offline until tonight")).to_be_visible()
        # The caption only names where the same thread is shown, and links to it.
        expect(thread.get_by_text("the same one shown in Conversation", exact=False)).to_be_visible()
        expect(thread.get_by_text("Conversation and Tasks")).to_have_count(0)
        thread.get_by_role("link", name="Open in Conversation").click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['project']}/conversations/"))
        expect(page.get_by_text("Workshop PC is offline until tonight").first).to_be_visible()
        # On a tall screen a short thread sits next to its composer, not a screen away from it.
        tall = self.open_agents("hubert")
        tall.set_viewport_size({"width": 1080, "height": 1920})
        last = tall.get_by_role("region", name=f"Thread of {TASK}").get_by_role("listitem").last.bounding_box()
        composer = tall.get_by_label("Write to this task").bounding_box()
        assert last and composer
        self.assertLess(composer["y"] - (last["y"] + last["height"]), 120, "the composer follows the last message")
        shot(tall, "agents-tall-1080x1920")

    def test_08_revoked_connection_leaves_the_open_view(self) -> None:
        # #183 N1: another person revokes their connection while Hubert has the view open. A
        # revocation publishes no stream event, so returning to the tab refetches the list.
        page = self.open_agents("hubert")
        connections = page.get_by_role("list", name="Agent connections in this project").get_by_role("listitem")
        expect(connections).to_have_count(3)
        page.evaluate("() => { window.__fluxSameDocument = true; }")
        marek = self.page("marek")
        mine = self.api(marek, "GET", "/api/v1/agent-connections", status=200)
        items = mine["connections"] if isinstance(mine, dict) and "connections" in mine else mine
        active = [c for c in items if not c.get("revokedAt")]
        self.assertEqual(len(active), 1, "Marek has one current connection")
        # A DELETE has no body, so it carries no JSON content type.
        response = marek.request.fetch(f"{ORIGIN}/api/v1/agent-connections/{active[0]['id']}", method="DELETE", headers={"origin": ORIGIN})
        self.assertEqual(response.status, 204, response.text())
        page.evaluate("() => window.dispatchEvent(new Event('focus'))")
        expect(connections).to_have_count(2, timeout=20000)
        self.assertFalse(any("Workshop PC" in text for text in connections.all_inner_texts()), "Marek's revoked connection is gone")
        self.assertTrue(page.evaluate("() => window.__fluxSameDocument === true"), "the list changed without a reload")

    def test_09_an_expired_session_reads_offline_without_a_reload(self) -> None:
        # The server lists only unexpired sessions, so a session_open entry can only be stale in an
        # open view. The UI suite cannot open a real client session (no OAuth client or database
        # access here), so every read of the list, the loader's and each refetch, is answered with
        # one connection in a session that ends a few seconds from now. The server never says
        # offline: "Offline" can only come from the client comparing expiresAt with its clock on
        # the 15 s tick. No focus or reload is triggered.
        page = self.page("hubert")
        # The 15 s refetch can be in flight as the test ends: stop answering it before the context closes.
        self.addCleanup(lambda: page.unroute_all(behavior="ignoreErrors"))
        reads: list[str] = []

        def session_ending_soon(route) -> None:
            if route.request.method != "GET":
                route.continue_()
                return
            response = route.fetch()
            body = response.json()
            target = next(item for item in body["connections"] if item["name"] == "Desk laptop")
            target["state"] = "session_open"
            target["session"] = {"startedAt": started, "expiresAt": expires}
            target["lastActivity"] = {"operation": "work.create", "at": started}
            reads.append(route.request.url)
            route.fulfill(response=response, json=body)

        # The browser runs in this container, so it shares this clock.
        now = time.time()
        started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 60))
        expires = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + 6))
        page.route(f"**/api/v1/projects/{self.ids['project']}/agents", session_ending_soon)
        page.goto(f"/projects/{self.ids['project']}/agents")
        expect(page.get_by_role("heading", level=1, name="Working together")).to_be_visible()
        page.evaluate("() => { window.__fluxSameDocument = true; }")
        desk = page.get_by_role("list", name="Agent connections in this project").get_by_role("listitem").filter(has_text="Desk laptop")
        expect(desk).to_contain_text("Session open since")
        expect(desk).to_have_attribute("data-state", "session_open")
        expect(desk.locator(".agents-conn__icon")).to_have_attribute("data-expression", "idle")
        expect(desk).to_contain_text("Offline", timeout=25000)
        expect(desk).to_have_attribute("data-state", "offline")
        expect(desk).not_to_contain_text("Session open since")
        self.assertTrue(page.evaluate("() => window.__fluxSameDocument === true"), "no reload")
        self.assertGreaterEqual(len(reads), 1)


if __name__ == "__main__":
    unittest.main()
