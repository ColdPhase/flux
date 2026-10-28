"""Browser tests for "On a schedule" and the morning summary written by the assistant (F-027 A8, #408; AST-7, AST-10.3, AST-2.1).

The check_ui.sh stack composes the TEST-ONLY fixture connection and the Anthropic mock (as test_personal_assistant does), so the
owner's assistant, their schedules and "Run now" are real here: the real API, the real worker and the mock provider. Nothing calls a
model. What this stack cannot be (a subscription account that has not seen the note about background use) and the Home line of a
morning summary that only the worker's 8:30 tick writes are stubbed responses with the exact API shapes; tests/app/assistant-jobs.test.ts
proves the tick, the two workers and the policies against the real database.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import urllib.request
import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from playwright.sync_api import Browser, BrowserContext, Locator, Page, Route, expect, sync_playwright

from app_select import choose, expect_value

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

MOCK = os.environ.get("FLUX_ANTHROPIC_MOCK_URL", "http://127.0.0.1:8090")
PASSWORD = "a schedule that stays mine"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Brandt", "email": f"ada.schedules+{STAMP}@example.test"}
ZONE = "Europe/Warsaw"
FORBIDDEN = re.compile(r"\b(scope|grant|MCP|token|capability|execute|runtime|transport|OAuth|policy|proposal|payload|slot|job|reaction|cron)\b|\bAPI\b(?! key)", re.I)
LABEL = r"(Mon|Tue|Wed|Thu|Fri|Sat|Sun)( \d+ \w+)? \d+:\d\d"
LONG = 60_000
UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")


def mock(path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"{MOCK}{path}", data=data, method="POST" if body is not None else "GET", headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read())


def later(hours: int = 12) -> str:
    """A time of day half a day away, so the stack's own per-minute tick never meets a schedule made here."""
    return (datetime.now(ZoneInfo(ZONE)) + timedelta(hours=hours)).strftime("%H:%M")


class AssistantSchedules(unittest.TestCase):
    """Tests run in name order and share one account with a real assistant."""

    pw = None
    browser: Browser
    state: dict | None = None
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

    def context(self, *, phone: bool = False, dark: bool = False, signed_in: bool = True) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": ZONE}
        options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP, device_scale_factor=1)
        if signed_in and self.state:
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
        headers = {"origin": ORIGIN, **({"content-type": "application/json"} if body is not None else {})}
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers=headers, data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def json(self, route: Route, body: dict, status: int = 200) -> None:
        route.fulfill(status=status, content_type="application/json", body=json.dumps(body))

    # ---------------------------------------------------------------- helpers

    @property
    def jobs_path(self) -> str:
        return f"/api/v1/workspaces/{self.ids['workspace']}/assistants/{ADA['id']}/schedules"

    def jobs(self, page: Page) -> list[dict]:
        return self.api(page, "GET", self.jobs_path, status=200)["items"]

    def clear(self, page: Page) -> None:
        for job in self.jobs(page):
            self.api(page, "DELETE", f"{self.jobs_path}/{job['id']}", status=200)
        self.api(page, "PATCH", "/api/v1/notification-preferences", {"morningSummary": {"enabled": False}}, status=200)

    def make(self, page: Page, text: str = "Look at the sensor tasks", **extra) -> dict:
        body = {"projectId": self.ids["project"], "text": text, "schedule": {"kind": "daily", "at": later()}, "timeZone": ZONE, **extra}
        return self.api(page, "POST", self.jobs_path, body, status=201)

    def no_horizontal_scroll(self, page: Page) -> None:
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"))

    def tag(self, phone: bool, dark: bool = False) -> str:
        return f"{'390' if phone else '1440'}-{'dark' if dark else 'light'}"

    def card(self, page: Page) -> Locator:
        return page.get_by_role("region", name="On a schedule")

    def row(self, page: Page, title: str) -> Locator:
        return page.locator("[data-schedule]").filter(has_text=title)

    def dialog(self, page: Page, name: str) -> Locator:
        return page.get_by_role("dialog", name=name)

    def box(self, locator: Locator) -> tuple[float, float, float, float]:
        box = locator.bounding_box()
        assert box is not None
        return (round(box["x"], 1), round(box["y"], 1), round(box["width"], 1), round(box["height"], 1))

    def settled(self, page: Page) -> None:
        """Opening motion is over (a dialog scales in), so sizes are final; waits on the animations, not on time."""
        page.wait_for_function("() => document.getAnimations().filter((a) => a.effect && a.effect.getComputedTiming().iterations !== Infinity && a.playState === 'running').length === 0")

    def layout(self, card: Locator, **parts: Locator) -> dict:
        """Where each control is, measured from the card's own corner in one pass once the pane has stopped moving (scrolling or closing a sheet)."""
        card.evaluate("""(node) => new Promise((resolve) => {
          let last = null; let same = 0;
          const tick = () => { const top = node.getBoundingClientRect().top; same = top === last ? same + 1 : 0; last = top; if (same >= 5) resolve(true); else requestAnimationFrame(tick); };
          tick();
        })""")
        handles = [card.element_handle(), *[locator.element_handle() for locator in parts.values()]]
        rects = card.page.evaluate("""(nodes) => nodes.map((node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })""", handles)
        origin = rects[0]
        return {name: (round(rect["x"] - origin["x"], 1), round(rect["y"] - origin["y"], 1), round(rect["width"], 1), round(rect["height"], 1)) for name, rect in zip(parts, rects[1:])}

    def screen(self, page: Page) -> Locator:
        page.goto("/settings/assistant")
        expect(page.get_by_role("heading", name="On a schedule")).to_be_visible()
        self.card(page).scroll_into_view_if_needed()
        return self.card(page)

    # ---------------------------------------------------------------- setup

    def test_01_an_owner_with_a_project_and_a_working_assistant(self) -> None:
        page = self.page(signed_in=False)
        page.goto("/sign-up")
        page.get_by_label("Name").fill(ADA["name"])
        page.get_by_label("Email").fill(ADA["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).state = page.context.storage_state()
        ADA["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        ws = self.api(page, "POST", "/api/v1/workspaces", {"name": "Lamp studio"}, status=201)
        project = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Gesture lamp", "visibility": "restricted"}, status=201)
        thread = self.api(page, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": "Camera or ToF sensor for the bedside lamp?", "clientMessageId": str(uuid.uuid4())}, status=201)
        agent = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/agents", {"name": "Ada's assistant", "owner": "self"}, status=201)
        status = self.api(page, "POST", "/api/v1/personal-assistant", {"consentVersion": "o-008-2026-10-02", "agentId": agent["id"], "perRunCents": 20, "dailyCapCents": 200, "timeZone": ZONE}, status=201)
        self.assertEqual(status["state"], "ready")
        type(self).ids = {"workspace": ws["id"], "project": project["id"], "conversation": thread["id"], "agent": agent["id"]}

    # ---------------------------------------------------------------- the empty part and its two starters

    def test_02_the_morning_summary_is_on_in_two_taps_from_the_empty_part(self) -> None:
        """AST-10.3, first half."""
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                self.clear(page)
                card = self.screen(page)
                expect(card).to_contain_text("Nothing yet. Try one:")
                morning = card.get_by_role("button", name="Let your assistant write your morning summary")
                expect(card.get_by_role("button", name="Weekly review on Monday")).to_be_visible()
                expect(card.get_by_role("button", name="Add", exact=True)).to_be_visible()
                self.no_horizontal_scroll(page)
                shot(page, f"schedules-empty-{self.tag(phone)}")
                morning.click()  # tap 1
                dialog = self.dialog(page, "Morning summary")
                expect(dialog).to_contain_text("Morning summary · 9:00, from Notifications · written by your assistant")
                expect(dialog).to_contain_text("Runs on your Anthropic API key")
                expect(page.get_by_role("switch", name=re.compile("^Morning summary"))).to_have_count(0)
                shot(page, f"schedules-morning-sheet-{self.tag(phone)}")
                dialog.get_by_role("button", name="Turn on").click()  # tap 2
                switch = page.get_by_role("switch", name=re.compile("^Morning summary"))
                expect(switch).to_have_attribute("aria-checked", "true")
                expect(card).to_contain_text("Morning summary · by your assistant" if phone else "Morning summary · written by your assistant")
                expect(card).to_contain_text("Every day at 9:00 (Notifications) · Home")
                expect(card).not_to_contain_text("Nothing yet")
                summary = self.api(page, "GET", "/api/v1/assistant/morning-summary", status=200)
                self.assertTrue(summary["byAssistant"])
                prefs = self.api(page, "GET", "/api/v1/notification-preferences", status=200)
                self.assertTrue(prefs["morningSummary"]["enabled"] and prefs["morningSummary"]["byAssistant"])
                switch.click()  # off again; the row stays where it is for this visit
                expect(switch).to_have_attribute("aria-checked", "false")
                self.assertFalse(self.api(page, "GET", "/api/v1/assistant/morning-summary", status=200)["byAssistant"])

    def test_03_a_weekly_review_on_monday_is_on_in_two_taps(self) -> None:
        """AST-7.1."""
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                self.clear(page)
                card = self.screen(page)
                card.get_by_role("button", name="Weekly review on Monday").click()  # tap 1
                dialog = self.dialog(page, "On a schedule")
                expect(dialog.get_by_label("What should it do?")).not_to_have_value("")
                expect(dialog.get_by_role("radio", name="Every Monday")).to_have_attribute("aria-checked", "true")
                expect(dialog.locator(".asched__next")).to_contain_text("Next: Mon")
                self.assertEqual(len(self.jobs(page)), 0, "nothing exists before Turn on")
                dialog.get_by_role("button", name="Turn on").click()  # tap 2
                row = self.row(page, "Weekly review")
                expect(row).to_have_count(1)
                expect(row.locator(".sset-row__s").first).to_have_text("Every Monday at 9:00 · Next: Mon 9:00")
                expect(row.get_by_role("switch", name="Weekly review")).to_have_attribute("aria-checked", "true")
                [job] = self.jobs(page)
                self.assertEqual((job["enabled"], job["words"], job["timeZone"], job["projectName"]), (True, "Every Monday at 9:00", ZONE, "Gesture lamp"))
                self.assertRegex(job["next"][0]["label"], r"^Mon( \d+ \w+)? 9:00$")
                self.no_horizontal_scroll(page)
                shot(page, f"schedules-row-{self.tag(phone)}")

    # ---------------------------------------------------------------- the sheet

    def test_04_the_sheet_follows_the_drawing_and_cron_is_checked_inline(self) -> None:
        """AST-7.10 and the sheet as drawn, at both widths."""
        for phone, dark in ((False, False), (True, False), (False, True), (True, True)):
            with self.subTest(phone=phone, dark=dark):
                page = self.page(phone=phone, dark=dark)
                self.clear(page)
                card = self.screen(page)
                card.get_by_role("button", name="Add", exact=True).click()
                dialog = self.dialog(page, "On a schedule")
                expect(dialog.get_by_label("What should it do?")).to_be_focused()
                group = dialog.get_by_role("radiogroup", name="When")
                self.settled(page)
                for label in ("Every day", "Weekdays", "Every Monday", "Every hour while I work"):
                    expect(group.get_by_role("radio", name=label)).to_be_visible()
                self.assertGreaterEqual(group.get_by_role("radio").first.bounding_box()["height"], 44)
                expect(group.get_by_role("radio", name="Every day")).to_have_attribute("aria-checked", "true")
                # The third choice follows the chosen weekday.
                group.get_by_role("radio", name="Every Monday").click()
                choose(dialog.get_by_label("Day of the week"), label="Friday")
                expect(group.get_by_role("radio", name="Every Friday")).to_have_attribute("aria-checked", "true")
                choose(dialog.get_by_label("At", exact=True), "16:00")
                expect_value(dialog.get_by_label("Where"), self.ids["project"])
                expect(dialog.locator(".asched__next")).to_have_text(re.compile(rf"^Next: Fri 16:00, {LABEL.replace('(Mon|Tue|Wed|Thu|Fri|Sat|Sun)', 'Fri')}, {LABEL.replace('(Mon|Tue|Wed|Thu|Fri|Sat|Sun)', 'Fri')}$"))
                # The weekdays window "while I work" is 9:00 to 17:00 and editable.
                group.get_by_role("radio", name="Every hour while I work").click()
                expect_value(dialog.get_by_label("From"), "09:00")
                expect_value(dialog.get_by_label("Until"), "17:00")
                group.get_by_role("radio", name="Weekdays").click()
                dialog.get_by_label("What should it do?").fill("List what is blocked")
                self.assertGreaterEqual(dialog.get_by_role("button", name="Turn on").bounding_box()["height"], 44)
                expect(dialog).to_contain_text("Runs on your Anthropic API key")
                text = dialog.inner_text()
                self.assertIsNone(FORBIDDEN.search(text), FORBIDDEN.search(text))
                shot(page, f"schedules-sheet-{self.tag(phone, dark)}")
                # More: the expression, shown back in words and as the next three times; more than once an hour is refused in place.
                dialog.locator("summary").click()
                cron = dialog.get_by_label("Cron expression")
                cron.fill("*/15 * * * *")
                expect(dialog.locator(".asched__cronnote")).to_have_text("At most once an hour")
                expect(dialog.get_by_role("button", name="Turn on")).to_be_disabled()
                cron.fill("0 9 * * 2-4")
                expect(dialog.locator(".asched__cronnote")).to_have_text("In words: At 9:00 on Tuesday, Wednesday and Thursday")
                expect(dialog.locator(".asched__next")).to_have_text(re.compile(rf"^Next: {LABEL}, {LABEL}, {LABEL}$"))
                self.assertEqual(len(dialog.locator(".asched__next").inner_text().split(", ")), 3)
                expect(dialog.get_by_role("button", name="Turn on")).to_be_enabled()
                if not dark:
                    shot(page, f"schedules-sheet-more-{self.tag(phone)}")
                dialog.get_by_role("button", name="Turn on").click()
                row = self.row(page, "List what is blocked")
                expect(row.locator(".sset-row__s").first).to_contain_text("At 9:00 on Tuesday, Wednesday and Thursday · Next:")
                [job] = self.jobs(page)
                self.assertEqual((job["schedule"]["kind"], job["schedule"]["cron"], job["enabled"]), ("cron", "0 9 * * 2-4", True))

    def test_05_run_now_works_then_says_last_done_and_the_history_has_the_line(self) -> None:
        """AST-7.2 from the owner's side: the real worker runs it on the mock provider; the list settles it."""
        mock("/__script", {"text": "Done: nothing to change", "delay": 4})
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                self.clear(page)
                job = self.make(page, "Look at the sensor tasks")
                self.screen(page)
                row = self.row(page, "Look at the sensor tasks")
                switch = row.get_by_role("switch", name="Look at the sensor tasks")
                add = page.get_by_role("button", name="Add", exact=True)
                expect(switch).to_be_visible()
                card = self.card(page)
                idle = self.layout(card, switch=switch, add=add, row=row)
                row.get_by_role("button", name=re.compile("Look at the sensor tasks")).click()
                dialog = self.dialog(page, "Look at the sensor tasks")
                expect(dialog).to_contain_text("Nothing has run yet.")
                self.settled(page)
                shot(page, f"schedules-detail-{self.tag(phone)}")
                dialog.get_by_role("button", name="Run now").click()
                expect(dialog.locator(".asched__facts")).to_contain_text("Working…")
                expect(dialog.get_by_role("button", name="Run now")).to_be_disabled()
                dialog.get_by_role("button", name="Close").click()
                expect(row).to_contain_text("Working…")
                working = self.layout(card, switch=switch, add=add, row=row)
                expect(row).to_contain_text("Last: Done: nothing to change", timeout=LONG)
                done = self.layout(card, switch=switch, add=add, row=row)
                # Rule 7: the controls do not move while the row's state changes.
                self.assertEqual(idle, working, "idle to working")
                self.assertEqual(working, done, "working to done")
                row.get_by_role("button", name=re.compile("Look at the sensor tasks")).click()
                history = self.dialog(page, "Look at the sensor tasks").locator(".asched__history li")
                expect(history).to_have_count(1)
                expect(history.first).to_contain_text("· Done: nothing to change")
                self.assertEqual([item["state"] for item in self.api(page, "GET", f"{self.jobs_path}/{job['id']}/history", status=200)["items"]], ["done"])
                # It was a silent run: nothing was posted in the project's conversation.
                answers = self.api(page, "GET", f"/api/v1/conversations/{self.ids['conversation']}/assistant-answers", status=200)
                self.assertEqual(answers["items"], [])
        mock("/__script", {"reset": True})

    def test_06_pause_edit_and_delete_with_undo(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                self.clear(page)
                job = self.make(page, "Look at the sensor tasks")
                self.screen(page)
                row = self.row(page, "Look at the sensor tasks")
                switch = row.get_by_role("switch", name="Look at the sensor tasks")
                add = page.get_by_role("button", name="Add", exact=True)
                card = self.card(page)
                before = self.layout(card, switch=switch, add=add, row=row)
                # Pause: the switch alone, in its row.
                switch.click()
                expect(switch).to_have_attribute("aria-checked", "false")
                expect(row.locator(".sset-row__s").first).not_to_contain_text("Next:")
                self.assertFalse(self.jobs(page)[0]["enabled"])
                self.assertEqual(before, self.layout(card, switch=switch, add=add, row=row), "pausing moves no control")
                switch.click()
                expect(switch).to_have_attribute("aria-checked", "true")
                expect(row.locator(".sset-row__s").first).to_contain_text("Next:")
                # Edit: the same sheet with Save.
                row.get_by_role("button", name=re.compile("Look at the sensor tasks")).click()
                self.dialog(page, "Look at the sensor tasks").get_by_role("button", name="Edit").click()
                sheet = self.dialog(page, "Change this schedule")
                text = sheet.get_by_label("What should it do?")
                expect(text).to_have_value("Look at the sensor tasks")
                text.fill("Look at the sensor tasks and list what is blocked")
                expect(sheet.get_by_role("button", name="Turn on")).to_have_count(0)
                sheet.get_by_role("button", name="Save").click()
                expect(sheet).to_be_hidden()
                self.assertEqual(self.jobs(page)[0]["text"], "Look at the sensor tasks and list what is blocked")
                self.assertEqual(self.jobs(page)[0]["title"], "Look at the sensor tasks", "the name stays")
                # Delete, then Undo.
                row.get_by_role("button", name=re.compile("Look at the sensor tasks")).click()
                self.dialog(page, "Look at the sensor tasks").get_by_role("button", name="Delete").click()
                expect(row).to_have_count(0)
                undo = page.get_by_role("button", name=re.compile("^Undo"))
                expect(undo).to_be_visible()
                self.assertEqual(self.jobs(page), [])
                undo.click()
                expect(row).to_have_count(1)
                self.assertEqual([item["id"] for item in self.jobs(page)], [job["id"]])
                self.assertTrue(self.jobs(page)[0]["enabled"])

    # ---------------------------------------------------------------- the account note (AST-2.1)

    def test_07_the_note_about_background_use_is_shown_and_its_version_is_sent_with_turn_on(self) -> None:
        """This stack's assistant uses an API key, which has no note: the subscription account's answers are stubbed here;
        tests/app/assistant-jobs.test.ts proves the once-per-account rule against the real store."""
        note = {"note": "Runs on your Claude plan while you're away. Anthropic may limit this use without notice. If your plan says no, it skips that time and tells you.",
                "version": "ast-2.2026-10-09", "meta": "Runs on your Claude plan", "credits": None}
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                self.clear(page)
                posted: list[dict] = []
                summary: list[dict] = []
                page.route(re.compile(r".*/assistants/[0-9a-f-]{36}/background-note$"), lambda route: self.json(route, note))

                def create(route: Route) -> None:
                    if route.request.method != "POST":
                        route.continue_()
                        return
                    body = json.loads(route.request.post_data or "{}")
                    posted.append(body)
                    self.json(route, {"id": str(uuid.uuid4()), "workspaceId": self.ids["workspace"], "projectId": body["projectId"], "projectName": "Gesture lamp", "title": "Tell me what is blocked",
                                      "text": body["text"], "schedule": body["schedule"], "timeZone": ZONE, "words": "Every day at 9:00", "conversationId": None, "enabled": True, "prepared": False,
                                      "preparedRunId": None, "pausedReason": None, "next": [], "last": None, "running": False, "version": 1, "createdAt": "2026-10-17T09:00:00.000Z",
                                      "updatedAt": "2026-10-17T09:00:00.000Z"}, 201)

                def morning(route: Route) -> None:
                    if route.request.method != "PUT":
                        route.continue_()
                        return
                    summary.append(json.loads(route.request.post_data or "{}"))
                    self.json(route, {"byAssistant": True})
                page.route(re.compile(r".*/assistants/[0-9a-f-]{36}/schedules$"), create)
                page.route(re.compile(r".*/api/v1/assistant/morning-summary$"), morning)
                card = self.screen(page)
                card.get_by_role("button", name="Add", exact=True).click()
                dialog = self.dialog(page, "On a schedule")
                dialog.get_by_label("What should it do?").fill("Tell me what is blocked")
                expect(dialog.get_by_role("note")).to_have_text(note["note"])
                expect(dialog).to_contain_text("Runs on your Claude plan")
                shot(page, f"schedules-note-{self.tag(phone)}")
                dialog.get_by_role("button", name="Turn on").click()
                expect(dialog).to_be_hidden()
                self.assertEqual(len(posted), 1)
                self.assertEqual((posted[0]["noteVersion"], posted[0]["enabled"]), ("ast-2.2026-10-09", True))
                # The morning summary's starter shows the same note and sends the same version.
                self.clear(page)
                card = self.screen(page)
                card.get_by_role("button", name="Let your assistant write your morning summary").click()
                sheet = self.dialog(page, "Morning summary")
                expect(sheet.get_by_role("note")).to_have_text(note["note"])
                sheet.get_by_role("button", name="Turn on").click()
                expect(page.get_by_role("switch", name=re.compile("^Morning summary"))).to_be_visible()
                self.assertEqual(summary[0]["noteVersion"], "ast-2.2026-10-09")
                self.assertTrue(summary[0]["on"])

    # ---------------------------------------------------------------- Home and Notifications

    def test_08_home_shows_the_one_line_and_notifications_offers_the_row(self) -> None:
        line = "Good morning, Ada. Jonas is waiting on you for #8, and 2 tasks are due today."
        for phone, dark in ((False, False), (True, False), (False, True), (True, True)):
            with self.subTest(phone=phone, dark=dark):
                page = self.page(phone=phone, dark=dark)
                page.route(re.compile(r".*/api/v1/assistant/morning-summary$"), lambda route: self.json(route, {"byAssistant": True, "line": line, "day": "2026-10-17"}))
                page.goto("/")
                expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
                summary = page.get_by_test_id("morning-line")
                expect(summary).to_contain_text(line)
                expect(summary.get_by_role("link")).to_have_attribute("href", "/inbox")
                # It sits under the greeting, before everything else, and is not part of the Inbox's "Needs you".
                hello = page.locator(".home__hello").bounding_box()
                self.assertGreater(summary.bounding_box()["y"], hello["y"])
                self.assertLess(summary.bounding_box()["y"], page.get_by_role("heading", name="Needs you").bounding_box()["y"])
                self.no_horizontal_scroll(page)
                shot(page, f"schedules-home-{self.tag(phone, dark)}")
        # Nothing written: nothing is shown.
        page = self.page()
        page.route(re.compile(r".*/api/v1/assistant/morning-summary$"), lambda route: self.json(route, {"byAssistant": True, "line": None, "day": None}))
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        expect(page.get_by_test_id("morning-line")).to_have_count(0)

    def test_09_notifications_has_the_assistant_row_under_the_morning_summary(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                self.clear(page)
                self.api(page, "PATCH", "/api/v1/notification-preferences", {"morningSummary": {"enabled": True, "at": "08:30"}}, status=200)
                page.goto("/settings/notifications")
                expect(page.get_by_role("switch", name=re.compile("^Morning summary"))).to_have_attribute("aria-checked", "true")
                switch = page.get_by_role("switch", name="Let your assistant write your morning summary")
                expect(switch).to_have_attribute("aria-checked", "false")
                shot(page, f"schedules-notifications-{self.tag(phone)}")
                switch.click()
                note = page.get_by_text("Written by Ada's assistant")
                expect(note).to_be_visible()
                expect(note.get_by_role("link", name="Change ›")).to_have_attribute("href", "/settings/assistant")
                expect(switch).to_have_count(0)
                self.assertTrue(self.api(page, "GET", "/api/v1/assistant/morning-summary", status=200)["byAssistant"])
                # The same row on the assistant screen says when.
                self.screen(page)
                expect(self.card(page)).to_contain_text("Every day at 8:30 (Notifications) · Home")
                # Turning the plain summary off turns the assistant's off with it.
                self.api(page, "PATCH", "/api/v1/notification-preferences", {"morningSummary": {"enabled": False}}, status=200)
                self.assertFalse(self.api(page, "GET", "/api/v1/assistant/morning-summary", status=200)["byAssistant"])

    # ---------------------------------------------------------------- "Set up by asking"

    def test_10_the_owner_sees_ready_under_their_answer_and_turns_it_on_with_one_tap(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                run_id = str(uuid.uuid4())
                other_run = str(uuid.uuid4())

                # Computer: the answer already says "Ready: …" (the assistant had no words of its own); phone: it wrote a sentence.
                body = "Ready: Weekly wins, Every Friday at 16:00." if not phone else "I set that up for you."

                def answer(owner: str, name: str, run: str) -> dict:
                    return {"runId": run, "conversationId": self.ids["conversation"], "projectId": self.ids["project"], "audience": {"kind": "project", "projectId": self.ids["project"]},
                            "assistant": {"ownerUserId": owner, "label": f"{name}'s assistant"}, "askedBy": {"id": owner, "name": name},
                            "request": {"kind": "ask", "prompt": "Every Friday at 16:00 list what we finished this week"}, "body": body,
                            "truncated": False, "provenance": {"provider": "anthropic", "model": "claude-code"}, "sources": [], "proposalId": None, "committedAt": "2026-10-17T09:00:00.000Z"}
                answers = [answer(ADA["id"], "Ada", run_id), answer(str(uuid.uuid4()), "Jonas", other_run)]
                page.route(re.compile(r".*/api/v1/conversations/[0-9a-f-]{36}/assistant-answers\?.*"), lambda route: self.json(route, {"items": answers, "total": 2, "limit": 100, "offset": 0}))

                def job(enabled: bool) -> dict:
                    return {"id": "3f1c1b1e-0000-4000-8000-000000000001", "workspaceId": self.ids["workspace"], "projectId": self.ids["project"], "projectName": "Gesture lamp", "title": "Weekly wins",
                            "text": "List what we finished this week", "schedule": {"kind": "weekly", "at": "16:00", "weekday": 5}, "timeZone": ZONE, "words": "Every Friday at 16:00",
                            "conversationId": None, "enabled": enabled, "prepared": not enabled, "preparedRunId": run_id, "pausedReason": None,
                            "next": [{"at": "2026-10-23T14:00:00.000Z", "label": "Fri 16:00"}] if enabled else [], "last": None, "running": False, "version": 2 if enabled else 1,
                            "createdAt": "2026-10-17T09:00:00.000Z", "updatedAt": "2026-10-17T09:00:00.000Z"}
                patched: list[dict] = []
                page.route(re.compile(r".*/assistants/[0-9a-f-]{36}/schedules$"), lambda route: self.json(route, {"items": [job(False)]}))

                def turn_on(route: Route) -> None:
                    patched.append(json.loads(route.request.post_data or "{}"))
                    self.json(route, job(True))
                page.route(re.compile(r".*/assistants/[0-9a-f-]{36}/schedules/[0-9a-f-]{36}$"), turn_on)
                page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
                ready = page.locator("[data-prepared-schedule]")
                expect(ready).to_have_count(1)
                if phone:
                    expect(ready).to_contain_text("Ready: Weekly wins, Every Friday at 16:00")
                else:
                    expect(ready).to_contain_text("Off until you turn it on")
                    expect(page.locator("[data-answer-run]").filter(has_text="Ada's assistant")).to_contain_text("Ready: Weekly wins, Every Friday at 16:00.")
                # Only under the owner's own answer, never under another person's.
                expect(page.locator("[data-answer-run]").filter(has_text="Jonas")).not_to_contain_text("Turn on")
                self.assertGreaterEqual(ready.get_by_role("button", name="Turn on").bounding_box()["height"], 44)
                shot(page, f"schedules-ready-{self.tag(phone)}")
                ready.get_by_role("button", name="Turn on").click()
                expect(ready).to_contain_text("Weekly wins, Every Friday at 16:00: on")
                self.assertEqual(patched, [{"expectedVersion": 1, "enabled": True}])

    # ---------------------------------------------------------------- words

    def test_11_no_screen_of_this_part_uses_an_internal_word(self) -> None:
        """AST-10.2: scope, grant, token, job, reaction, cron (outside More) and API (outside "API key") are never on screen."""
        for phone, dark in ((False, False), (True, False), (False, True), (True, True)):
            with self.subTest(phone=phone, dark=dark):
                page = self.page(phone=phone, dark=dark)
                self.clear(page)
                self.make(page, "Look at the sensor tasks", title="Weekly review")
                self.screen(page)
                expect(self.row(page, "Weekly review")).to_be_visible()
                text = page.locator(".pane-in").inner_text()
                self.assertIn("Weekly review", text)
                self.assertIsNone(FORBIDDEN.search(text), FORBIDDEN.search(text))
                shot(page, f"schedules-screen-{self.tag(phone, dark)}")
                self.row(page, "Weekly review").get_by_role("button", name=re.compile("Weekly review")).click()
                detail = self.dialog(page, "Weekly review")
                expect(detail.get_by_role("button", name="Run now")).to_be_visible()
                self.settled(page)
                self.assertIsNone(FORBIDDEN.search(detail.inner_text()), detail.inner_text())
                for name in ("Run now", "Edit", "Delete"):
                    self.assertGreaterEqual(detail.get_by_role("button", name=name).bounding_box()["height"], 44, name)
                self.assertGreaterEqual(detail.get_by_role("switch", name="On", exact=True).locator("xpath=ancestor::*[contains(@class,'sset-row')][1]").bounding_box()["height"], 44)
                if dark:
                    shot(page, f"schedules-detail-{self.tag(phone, dark)}")
        self.clear(self.page())


    # ---------------------------------------------------------------- in a conversation

    def test_12_runs_of_one_schedule_in_a_row_fold_into_one_line_until_a_person_posts(self) -> None:
        """AST-7.11: "Ada's assistant · Hourly tidy · 2 updates" opens to each run's own message; a person's message ends the fold."""
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                schedule = {"id": str(uuid.uuid4()), "title": "Hourly tidy"}
                runs = [str(uuid.uuid4()) for _ in range(3)]
                self.api(page, "POST", f"/api/v1/conversations/{self.ids['conversation']}/messages", {"body": f"Thanks, that helps {phone}", "clientMessageId": str(uuid.uuid4())}, status=201)

                def answer(run: str, at: str) -> dict:
                    return {"runId": run, "conversationId": self.ids["conversation"], "projectId": self.ids["project"], "audience": {"kind": "project", "projectId": self.ids["project"]},
                            "assistant": {"ownerUserId": ADA["id"], "label": "Ada's assistant"}, "askedBy": {"id": ADA["id"], "name": "Ada"},
                            "request": {"kind": "scheduled", "prompt": "Tidy the sensor tasks"}, "body": f"Renamed the probe task ({run[:4]}).", "truncated": False,
                            "provenance": {"provider": "anthropic", "model": "claude-code"}, "sources": [], "proposalId": None, "committedAt": at, "schedule": schedule}
                answers = [answer(runs[0], "2026-01-01T09:00:00.000Z"), answer(runs[1], "2026-01-01T10:00:00.000Z"), answer(runs[2], "2099-01-01T09:00:00.000Z")]
                page.route(re.compile(r".*/api/v1/conversations/[0-9a-f-]{36}/assistant-answers\?.*"), lambda route: self.json(route, {"items": answers, "total": 3, "limit": 100, "offset": 0}))
                page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
                fold = page.locator("[data-schedule-fold]")
                expect(fold).to_have_count(1)
                expect(fold).to_contain_text("Ada's assistant")
                expect(fold).to_contain_text("Hourly tidy · 2 updates")
                expect(fold.get_by_role("button", name=re.compile("Hourly tidy"))).to_have_attribute("aria-expanded", "false")
                for run in runs[:2]:
                    expect(fold.locator(f"[data-answer-run='{run}']")).to_be_hidden()
                # The run after a person's message stands on its own.
                expect(page.locator(f"[data-answer-run='{runs[2]}']")).to_be_visible()
                self.assertEqual(page.locator(f"[data-answer-run='{runs[2]}']").evaluate("(node) => !!node.closest('[data-schedule-fold]')"), False)
                self.assertGreaterEqual(fold.get_by_role("button", name=re.compile("Hourly tidy")).bounding_box()["height"], 32)
                shot(page, f"schedules-fold-{self.tag(phone)}")
                fold.get_by_role("button", name=re.compile("Hourly tidy")).click()
                expect(fold.get_by_role("button", name=re.compile("Hourly tidy"))).to_have_attribute("aria-expanded", "true")
                for run in runs[:2]:
                    expect(fold.locator(f"[data-answer-run='{run}']")).to_be_visible()
                self.no_horizontal_scroll(page)

    def test_13_a_plan_limit_offers_do_it_at_the_reset_time_and_makes_a_one_off(self) -> None:
        """AST-7 "Do it later": one tap makes a one-off schedule of the same request, posting in its conversation."""
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                self.clear(page)
                real = self.api(page, "GET", "/api/v1/personal-assistant", status=200)
                stub = json.loads(json.dumps(real))
                stub["setup"] = {"provider": "off", "connection": "none", "runtime": {"state": "signed_in", "payer": "claude_plan", "accountLabel": "a***@example.test"}}
                stub["enablement"].update(engine="runtime", connectionId=None)
                reset = datetime.now(ZoneInfo("UTC")) + timedelta(hours=2)
                run = {"id": str(uuid.uuid4()), "clientRunId": str(uuid.uuid4()), "workspaceId": self.ids["workspace"], "projectId": self.ids["project"], "conversationId": self.ids["conversation"],
                       "kind": "ask", "prompt": "Summarize the sensor notes", "target": None, "continuesRunId": None, "retryOfRunId": None, "status": "unavailable", "stoppedAtStage": None,
                       "stopRequested": False, "stopAcknowledged": False, "engine": "runtime", "endReason": "plan_limit", "planLimitResetsAt": reset.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                       "cost": {"state": "reserved", "reservedMicros": 0, "chargedMicros": 0, "inputTokens": None, "outputTokens": None},
                       "answer": None, "createdAt": "2026-10-16T09:00:00.000Z", "dispatchedAt": "2026-10-16T09:00:01.000Z", "completedAt": "2026-10-16T09:01:00.000Z"}
                page.route("**/api/v1/personal-assistant", lambda route: self.json(route, stub) if route.request.method == "GET" else route.continue_())
                page.route(re.compile(r".*/api/v1/conversations/[0-9a-f-]{36}/assistant-runs$"), lambda route: self.json(route, run, 202))
                page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
                page.locator("#thread-composer").fill("/ai Summarize the sensor notes")
                page.get_by_role("button", name="Send to your assistant").click()
                working = page.locator(".assistant-working")
                clock = reset.astimezone(ZoneInfo(ZONE)).strftime("%H:%M")
                expect(working).to_contain_text(f"until {clock}.")
                button = working.get_by_role("button", name=f"Do it at {clock}")
                expect(button).to_be_visible()
                self.assertGreaterEqual(button.bounding_box()["height"], 32)
                shot(page, f"schedules-do-it-at-{self.tag(phone)}")
                button.click()
                expect(working).to_contain_text(f"I’ll do it at {clock}.")
                jobs = self.jobs(page)
                self.assertEqual(len(jobs), 1)
                self.assertEqual([jobs[0]["schedule"]["kind"], jobs[0]["text"], jobs[0]["conversationId"], jobs[0]["enabled"]], ["once", "Summarize the sensor notes", self.ids["conversation"], True])
                self.assertTrue(jobs[0]["words"].startswith("Once, "))
                self.assertEqual(jobs[0]["schedule"]["at"], reset.strftime("%Y-%m-%dT%H:%M:%S.000Z"), "it runs at the plan's reset time")
                self.no_horizontal_scroll(page)
        self.clear(self.page())


if __name__ == "__main__":
    unittest.main()
