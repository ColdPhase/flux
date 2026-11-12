"""Browser tests for an agent's schedules (#858, F-036 AG-9, mockups AgentsA and AgentReports).

Runs with the other tests/ui journeys through scripts/check_ui.sh, on the TEST-ONLY mock provider (`FLUX_TEST_PERSONAL_RUNS=anthropic-mock`): the
real worker sends runs through the real Anthropic adapter to `tests/ui/anthropic_mock.py`. Nothing here calls a model.

Jo tells her agent in its private chat "Every weekday at 9, summarise what changed in Garden sensors". The agent says in plain words what it
prepared, and the chat shows what it will do with the one tap that turns it on and Change. The schedule is listed in the conversation's header
("Weekdays at 9:00 · Garden summary · 1 schedule"), which opens the one list where it is paused, changed, run now and deleted with Undo; the agent's
page shows the same list. The morning summary is a ready-made one, off until Jo turns it on. A result arrives in the chat as one message, with no
message of Jo's behind it. Computer and phone widths.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import urllib.request
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

NARROW = {"width": 320, "height": 568}

MOCK = os.environ.get("FLUX_ANTHROPIC_MOCK_URL", "http://127.0.0.1:8090")
UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
PASSWORD = "an answer that stays mine"
STAMP = int(time.time() * 1000)
JO = {"name": "Jo Weber", "email": f"jo.weber.sched+{STAMP}@example.test"}
SENTENCE = "Every weekday at 9, summarise what changed in Garden sensors"
BLOCK = '<schedule>{"title": "Garden summary", "text": "Summarise what changed in Garden sensors", "when": {"kind": "weekdays", "at": "09:00"}}</schedule>'
PREPARED = "I prepared a summary of Garden sensors for weekdays at 9."
# The mock fills `{name}` in what it says: a brace is written twice.
SAYS = f"{PREPARED} {BLOCK}".replace("{", "{{").replace("}", "}}")


def mock(path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"{MOCK}{path}", data=data, method="POST" if body is not None else "GET", headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read())


class AgentSchedulesJourney(unittest.TestCase):
    """Tests run in name order and share one account, one space and one agent."""

    pw = None
    browser: Browser
    state: dict = {}
    ids: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)
        mock("/__script", {"reset": True})

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, *, phone: bool = False, narrow: bool = False, zone: str = "Europe/Warsaw") -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": zone}
        if narrow:
            # The smallest phone Flux is held to (docs/design/adaptive-workspaces.md): 320 by 568.
            options.update(viewport=NARROW, device_scale_factor=2, is_mobile=True, has_touch=True)
        elif phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
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

    def chat(self, **kwargs) -> Page:
        page = self.page(**kwargs)
        page.goto(f"/agents/{self.ids['agent']}")
        expect(page.locator("#agent-composer")).to_be_visible()
        return page

    def agent_page(self, **kwargs) -> Page:
        page = self.page(**kwargs)
        page.goto(f"/settings/agents/{self.ids['agent']}")
        expect(page.get_by_role("heading", name="Schedules")).to_be_visible()
        return page

    def say(self, page: Page, words: str) -> None:
        page.locator("#agent-composer").fill(words)
        page.get_by_role("button", name=re.compile("^Send to ")).click()

    def saved_zone(self, page: Page, want: str) -> str:
        """The zone `GET /api/v1/me` holds for Jo once the shell has saved its browser's (it does so without waiting), or the last one read."""
        zone = ""
        for _ in range(50):
            zone = self.api(page, "GET", "/api/v1/me", status=200)["user"]["timeZone"]
            if zone == want:
                break
            page.wait_for_timeout(100)
        return zone

    def no_horizontal_scroll(self, page: Page) -> None:
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"))

    # ---------------------------------------------------------------- tests

    def test_01_jo_has_an_agent_and_a_space(self) -> None:
        page = self.context().new_page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill(JO["name"])
        page.get_by_label("Email").fill(JO["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).state = page.context.storage_state()
        # Her browser is in Warsaw: the shell saved its zone on her, with nothing for her to set (#1168, C-57).
        self.assertEqual(self.saved_zone(page, "Europe/Warsaw"), "Europe/Warsaw")
        ws = self.api(page, "POST", "/api/v1/workspaces", {"name": "Community garden"}, status=201)
        project = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Garden sensors", "visibility": "workspace"}, status=201)
        self.api(page, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": "LoRa for the far beds.", "clientMessageId": str(uuid.uuid4())}, status=201)
        agent = self.api(page, "POST", "/api/v1/my-agents", {"workspaceId": ws["id"]}, status=201)
        type(self).ids = {"workspace": ws["id"], "project": project["id"], "agent": agent["id"]}

    def test_02_a_sentence_to_the_agent_prepares_a_schedule_the_chat_offers_to_turn_on(self) -> None:
        mock("/__script", {"reset": True, "text": SAYS})
        page = self.chat()
        expect(page.locator("[data-schedules-header]")).to_have_count(0)
        self.say(page, SENTENCE)
        working = page.locator("[data-chat-agent]").last
        expect(working).to_contain_text(PREPARED, timeout=30000)
        expect(working).not_to_contain_text("<schedule>")
        ready = page.locator("[data-prepared-schedule]")
        # What it will do, as drawn: its time, its text, Turn on and Change.
        expect(ready).to_contain_text("Weekdays at 9:00")
        expect(ready).to_contain_text("Summarise what changed in Garden sensors")
        expect(ready).to_contain_text("Off until you turn it on.")
        expect(ready.get_by_role("button", name="Change")).to_be_visible()
        header = page.locator("[data-schedules-header]")
        expect(header).to_contain_text("1 schedule")
        shot(page, "schedules-1440-chat-ready")
        ready.get_by_role("button", name="Turn on").click()
        expect(ready).to_contain_text("Turned on")
        expect(ready).not_to_contain_text("Off until you turn it on.")
        jobs = self.api(page, "GET", f"/api/v1/my-agents/{self.ids['agent']}/schedules", status=200)["items"]
        self.assertEqual([(job["title"], job["enabled"], job["agentId"]) for job in jobs], [("Garden summary", True, self.ids["agent"])])
        # Made in Jo's zone, so "9:00" is 9:00 on her clock (#1168): not UTC, where it would run at 10:00 in Warsaw.
        self.assertEqual(jobs[0]["timeZone"], "Europe/Warsaw")
        # Change: what it does is Jo's to edit, and the time of a weekday schedule.
        ready.get_by_role("button", name="Change").click()
        form = ready.get_by_role("form", name="Change Garden summary")
        form.locator("textarea").fill("Summarise what changed in Garden sensors and Rain barrels")
        expect(form).to_contain_text("The web addresses Assistant may read are the ones in your request")
        time_field = form.get_by_label("Time", exact=True)
        time_field.fill("08:30")
        time_field.press("Enter")  # a typed time commits on Enter or on leaving the field
        expect(time_field).to_have_value("8:30")
        form.get_by_role("button", name="Save").click()
        expect(ready).to_contain_text("Weekdays at 8:30")
        expect(ready).to_contain_text("Summarise what changed in Garden sensors and Rain barrels")
        changed = self.api(page, "GET", f"/api/v1/my-agents/{self.ids['agent']}/schedules", status=200)["items"][0]
        self.assertEqual((changed["text"], changed["words"]), ("Summarise what changed in Garden sensors and Rain barrels", "Weekdays at 8:30"))
        self.api(page, "PATCH", f"/api/v1/my-agents/{self.ids['agent']}/schedules/{changed['id']}",
                 {"expectedVersion": changed["version"], "text": "Summarise what changed in Garden sensors", "schedule": {"kind": "weekdays", "at": "09:00"}}, status=200)
        self.no_horizontal_scroll(page)

    def test_03_the_conversation_header_lists_it_and_opens_the_one_list(self) -> None:
        page = self.chat()
        header = page.locator("[data-schedules-header]")
        expect(header).to_contain_text("Weekdays at 9:00 · Garden summary")
        expect(header).to_contain_text("1 schedule")
        shot(page, "schedules-1440-chat-header")
        header.get_by_role("button", name=re.compile("Weekdays at 9:00")).click()
        row = header.locator("[data-schedule]")
        expect(row).to_have_count(1)
        expect(row).to_contain_text("Garden summary")
        expect(row).to_contain_text("Next")
        shot(page, "schedules-1440-chat-header-open")
        # Pause and turn on again.
        row.get_by_role("button", name="Pause Garden summary").click()
        expect(row.get_by_role("button", name="Turn on Garden summary")).to_be_visible()
        expect(row).to_contain_text("Off")
        expect(header).to_contain_text("Off")
        row.get_by_role("button", name="Turn on Garden summary").click()
        expect(row.get_by_role("button", name="Pause Garden summary")).to_be_visible()
        # Delete, then Undo brings it back.
        row.get_by_role("button", name="Delete Garden summary").click()
        expect(header.locator("[data-schedule]")).to_have_count(0)
        header.get_by_role("button", name="Undo", exact=True).click()
        expect(header.locator("[data-schedule]")).to_have_count(1)
        self.no_horizontal_scroll(page)
        # The agent's page shows the same list.
        listed = self.agent_page()
        expect(listed.locator("[data-schedule]")).to_have_count(1)
        expect(listed.locator("[data-schedule]")).to_contain_text("Weekdays at 9:00")
        shot(listed, "schedules-1440-agent-page")

    def test_04_the_morning_summary_is_a_ready_made_schedule_off_until_it_is_turned_on(self) -> None:
        page = self.agent_page()
        starter = page.locator("[data-starter='morning-summary']")
        expect(starter).to_contain_text("Morning summary")
        expect(starter).to_contain_text("Off until you turn it on")
        starter.get_by_role("button", name="Turn on Morning summary").click()
        expect(page.locator("[data-schedule]")).to_have_count(2)
        expect(page.locator("[data-starter]")).to_have_count(0)
        expect(page.locator("[data-schedule]").filter(has_text="Morning summary")).to_contain_text("Weekdays at 9:00")
        jobs = self.api(page, "GET", f"/api/v1/my-agents/{self.ids['agent']}/schedules", status=200)["items"]
        self.assertEqual(sorted(job["title"] for job in jobs), ["Garden summary", "Morning summary"])

    def test_05_run_now_reports_in_the_chat_once_without_a_message_of_jos_and_a_failure_never_pauses_it(self) -> None:
        mock("/__script", {"reset": True, "text": "Fact: two tasks in Garden sensors changed since yesterday."})
        page = self.agent_page()
        row = page.locator("[data-schedule]").filter(has_text="Garden summary")
        row.get_by_role("button", name="Run Garden summary now").click()
        expect(row).to_contain_text("Done: Fact: two tasks in Garden sensors changed since yesterday.", timeout=45000)
        chat = self.chat()
        line = chat.locator("[data-schedule-line='result']")
        expect(line).to_have_count(1)
        # One message of the agent, with the schedule after its name: no message of Jo's that she never sent, and no second copy of the result.
        expect(line).to_contain_text("two tasks in Garden sensors changed since yesterday")
        expect(line.locator(".dm-msg__meta")).to_contain_text("Weekdays at 9:00")
        expect(line.locator(".dm-msg__meta")).to_contain_text("Garden summary")
        expect(chat.locator("[data-chat-me]")).to_have_count(1)
        expect(chat.get_by_text("two tasks in Garden sensors changed since yesterday")).to_have_count(1)
        expect(chat.get_by_role("button", name="Try again")).to_have_count(0)
        shot(chat, "schedules-1440-chat-result")
        # A failed run is told in the chat in the same place, and the schedule stays on.
        mock("/__script", {"reset": True, "status": 500})
        page = self.agent_page()
        row = page.locator("[data-schedule]").filter(has_text="Garden summary")
        row.get_by_role("button", name="Run Garden summary now").click()
        expect(row).to_contain_text(re.compile("Couldn.t run|Stopped answering"), timeout=60000)
        expect(row.get_by_role("button", name="Pause Garden summary")).to_be_visible()
        jobs = self.api(page, "GET", f"/api/v1/my-agents/{self.ids['agent']}/schedules", status=200)["items"]
        self.assertTrue(all(job["enabled"] for job in jobs), "no pause after a failure")
        chat = self.chat()
        failed = chat.locator("[data-schedule-line='failed']")
        expect(failed).to_have_count(1)
        expect(failed).to_contain_text(re.compile("Couldn.t run|Stopped answering"))
        expect(chat.locator("[data-chat-me]")).to_have_count(1)

    def in_view(self, page: Page, locator, what: str) -> None:
        """The element is inside the window, not scrolled away: `to_be_visible` only says it is rendered."""
        box = locator.bounding_box()
        self.assertIsNotNone(box, what)
        height = page.evaluate("window.innerHeight")
        self.assertGreaterEqual(box["y"], 0, f"{what} is above the window")
        self.assertLessEqual(box["y"] + box["height"], height, f"{what} is below the window")

    def test_06_on_the_phone_the_header_line_stays_in_view_and_the_schedules_fit(self) -> None:
        chat = self.chat(phone=True)
        header = chat.locator("[data-schedules-header]")
        expect(header).to_be_visible()
        # Garden summary, and the morning summary that test_04 turned on.
        expect(header).to_contain_text("2 schedules")
        row = header.get_by_role("button", name=re.compile("Weekdays at 9:00"))
        # The chat opens at its newest message, so it is scrolled: the line is still in the window (it is above the history, not part of it).
        expect(chat.locator("[data-schedule-line]").first).to_be_attached()
        feed = chat.locator(".dm__feed")
        self.assertGreater(feed.evaluate("el => el.scrollHeight - el.clientHeight"), 0, "the history is longer than the window")
        self.assertGreater(feed.evaluate("el => el.scrollTop"), 0, "the chat opened at its newest message")
        self.in_view(chat, row, "the schedules line")
        box = row.bounding_box()
        self.assertLessEqual(box["x"] + box["width"], PHONE["width"], "the line fits the phone")
        self.assertGreaterEqual(box["height"], 40, "a touch-sized row")
        self.no_horizontal_scroll(chat)
        # A result's header is one line ("Assistant · 9:00 · Weekdays at 9:00 · Garden summary"), not three columns.
        meta = chat.locator("[data-schedule-line='result'] .dm-msg__meta").first
        meta.scroll_into_view_if_needed()
        self.assertLessEqual(meta.bounding_box()["height"], 24, "the result's header is one line")
        self.assertEqual(meta.evaluate("el => el.children.length"), 2, "the name and the rest of the line")
        self.assertLessEqual(meta.bounding_box()["x"] + meta.bounding_box()["width"], PHONE["width"], "and it ends inside the window, cut by an ellipsis when it is long")
        shot(chat, "schedules-390-chat-header")
        row.click()
        expect(header.locator("[data-schedule]")).to_have_count(2)
        self.in_view(chat, row, "the schedules line with the list open")
        self.in_view(chat, header.locator("[data-schedule]").first, "the first schedule of the open list")
        self.no_horizontal_scroll(chat)
        shot(chat, "schedules-390-chat-header-open")
        page = self.agent_page(phone=True)
        expect(page.locator("[data-schedule]").first).to_be_visible()
        self.no_horizontal_scroll(page)
        shot(page, "schedules-390-agent-page")

    def test_07_at_320_the_header_line_stays_in_view_and_a_long_list_scrolls_inside_its_panel(self) -> None:
        chat = self.chat(narrow=True)
        # A third schedule, so the open list is longer than its panel on the smallest phone.
        self.api(chat, "POST", f"/api/v1/my-agents/{self.ids['agent']}/schedules",
                 {"title": "Evening check", "text": "Say what is left for tomorrow", "schedule": {"kind": "daily", "at": "18:00"}, "timeZone": "Europe/Warsaw"}, status=201)
        chat.reload()
        expect(chat.locator("#agent-composer")).to_be_visible()
        header = chat.locator("[data-schedules-header]")
        expect(header).to_contain_text("3 schedules")
        row = header.get_by_role("button", name=re.compile("3 schedules"))
        self.in_view(chat, row, "the schedules line at 320")
        box = row.bounding_box()
        self.assertLessEqual(box["x"] + box["width"], NARROW["width"], "the line fits 320")
        self.no_horizontal_scroll(chat)
        shot(chat, "schedules-320-chat-header")
        row.click()
        panel = chat.locator(".agc__sched-panel")
        expect(panel).to_be_visible()
        expect(header.locator("[data-schedule]")).to_have_count(3)
        # The line stays where it was and the list scrolls inside its panel: the panel is shorter than its rows, and its last row can be reached.
        self.in_view(chat, row, "the schedules line with the list open at 320")
        self.assertGreater(panel.evaluate("el => el.scrollHeight - el.clientHeight"), 0, "the list is longer than its panel")
        self.assertLessEqual(panel.bounding_box()["height"], NARROW["height"] * 0.46, "the panel leaves the chat its room")
        panel.evaluate("el => { el.scrollTop = el.scrollHeight; }")
        last = header.locator("[data-schedule]").last
        last.get_by_role("button", name=re.compile("^Delete ")).scroll_into_view_if_needed()
        self.in_view(chat, last.get_by_role("button", name=re.compile("^Delete ")), "the last schedule's Delete after scrolling the panel")
        self.in_view(chat, row, "the schedules line after scrolling the panel")
        self.no_horizontal_scroll(chat)
        shot(chat, "schedules-320-chat-header-open")
        # A result's header is one line at 320 too.
        chat.locator(".agc__sched-row").click()
        meta = chat.locator("[data-schedule-line='result'] .dm-msg__meta").first
        meta.scroll_into_view_if_needed()
        self.assertLessEqual(meta.bounding_box()["height"], 24, "the result's header is one line at 320")
        self.assertLessEqual(meta.bounding_box()["x"] + meta.bounding_box()["width"], NARROW["width"], "and ends inside the window at 320")

    def test_08_the_time_shown_is_the_hour_it_runs_on_jos_clock_and_another_zone_names_it(self) -> None:
        # In Warsaw: the list says 9:00 and its next time is 9:00 on the browser's own clock, the hour the schedule runs (#1168).
        page = self.agent_page()
        row = page.locator("[data-schedule]").filter(has_text="Garden summary")
        jobs = self.api(page, "GET", f"/api/v1/my-agents/{self.ids['agent']}/schedules", status=200)["items"]
        garden = next(job for job in jobs if job["title"] == "Garden summary")
        self.assertEqual(garden["timeZone"], "Europe/Warsaw")
        label = garden["next"][0]["label"]
        self.assertRegex(label, r" 9:00$")
        on_clock = page.evaluate("(at) => { const d = new Date(at); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')} ${d.getDay()}`; }", garden["next"][0]["at"])
        hour, weekday = on_clock.split(" ")
        self.assertEqual(hour, "9:00", "the next run is 9:00 on the browser's clock")
        self.assertIn(int(weekday), range(1, 6), "on a weekday")
        expect(row).to_contain_text(f"Weekdays at 9:00 · Next {label}")
        expect(row).not_to_contain_text("Warsaw time")
        # On a trip to New York: the person's zone follows the browser, and a schedule made at home keeps running at 9:00 Warsaw time and says so.
        away = self.page(zone="America/New_York")
        away.goto(f"/agents/{self.ids['agent']}")
        expect(away.locator("#agent-composer")).to_be_visible()
        header = away.locator("[data-schedules-header]")
        expect(header).to_contain_text("Weekdays at 9:00, Warsaw time · Garden summary")
        header.get_by_role("button", name=re.compile("Weekdays at 9:00")).click()
        expect(header.locator("[data-schedule]").filter(has_text="Garden summary")).to_contain_text(f"Weekdays at 9:00, Warsaw time · Next {label}")
        self.assertEqual(self.saved_zone(away, "America/New_York"), "America/New_York")
        shot(away, "schedules-1440-chat-header-new-york")
        # Back home, the zone is Warsaw again, and the list says no zone.
        home = self.chat()
        expect(home.locator("[data-schedules-header]")).to_contain_text("Weekdays at 9:00 · Garden summary")
        self.assertEqual(self.saved_zone(home, "Europe/Warsaw"), "Europe/Warsaw")


if __name__ == "__main__":
    unittest.main()
