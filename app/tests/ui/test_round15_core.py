"""Round 15 of the v0.2.1 release gate, area "core" (My tasks, offline, the Inbox, Search, the panels opened from the Inbox): one regression per P2.

Run once with FLUX_UI_BROWSER=chromium and once with webkit. Each test measures the running application:
- a task made while on My tasks starts with you as its owner and shows on My tasks (new P2-1);
- offline, Home keeps what it last loaded (no "This couldn't be loaded"), and a space read before opens inside the shell, never the
  whole-app "Flux can't be reached" (new P2-2, daily P3-9, look-1 P2-5); the phone's offline line stands above the "+" (look-1 P2-4);
- the phone's expanded Inbox card has Not now and Done as buttons, not only behind a swipe (daily P2-3);
- the phone's sheet of a blocked task opened from the Inbox shows its title, not only the "Waiting for" card (look-1 P2-1);
- at 200 % a decision with a discussion opened from the Inbox shows its title, not the end of the discussion (look-1 P2-2);
- "Open" on what an agent run waits for lands on its waiting changes (AI P2-3), and one change is approved with "Approve" (AI P3).
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder

PASSWORD = "a calm round for the garden"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.r15+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.r15+{STAMP}@example.test"),
}
SPACE = "Community garden sensors"
DECISION = "Borrow two sensors from the school instead of buying more"
BLOCKED = "Book the hall power for the demo table"
BLOCKER = ("the hall's key is with the caretaker until Thursday morning, and the caretaker needs a signed form from the board before he "
           "hands it over, so someone from the board has to sign it first and bring it to the office on Wednesday afternoon")
QUESTION = "is the gate code still 1234 after the change last week?"
OWN_TASK = "Calibrate the probes in the raised beds"
NOW = "2026-11-17T09:00:00.000Z"


class Round15Core(unittest.TestCase):
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    contexts: dict[str, BrowserContext] = {}

    @classmethod
    def post(cls, who: str, path: str, body: dict) -> dict:
        response = cls.contexts[who].request.post(path, data=body, headers={"origin": ORIGIN})
        assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
        return response.json()

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=15000)
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.contexts[key] = context
        workspace = cls.post("ada", "/api/v1/workspaces", {"name": "Riverside Makers"})["id"]
        cls.post("ada", f"/api/v1/workspaces/{workspace}/members", {"email": PEOPLE["jonas"][1], "role": "member"})
        project = cls.post("ada", f"/api/v1/workspaces/{workspace}/projects", {"name": SPACE, "visibility": "workspace"})["id"]
        cls.ids["project"] = project
        decision = cls.post("jonas", f"/api/v1/projects/{project}/decisions", {"title": DECISION, "rationale": "It saves 36 EUR, and the school has spare ESP32 kits."})
        for body in ("The school says the kits are free until March.", "I can pick them up on Thursday with the van.",
                     "Do they come with the probes or only the boards?", "Boards and probes, but no cases. We have spare cases in the workshop.",
                     "Good, the last class ends at 15:00, so come after that.", "Then Thursday after three it is. I will bring the crates."):
            cls.post("jonas", f"/api/v1/decisions/{decision['id']}/discussion", {"body": body, "clientMessageId": str(uuid.uuid4())})
        cls.post("jonas", f"/api/v1/projects/{project}/work", {
            "title": BLOCKED, "owner": {"kind": "human", "id": cls.ids["jonas"]}, "status": "blocked",
            "blocker": BLOCKER, "waitingFor": {"kind": "human", "id": cls.ids["ada"]}})
        cls.post("ada", f"/api/v1/projects/{project}/work", {"title": OWN_TASK, "owner": {"kind": "human", "id": cls.ids["ada"]}})
        cls.post("jonas", f"/api/v1/projects/{project}/conversations", {"body": f"@Ada Kowalska {QUESTION}", "clientMessageId": str(uuid.uuid4())})
        # A thread Ada started, with replies she has not read: it opens on the first of them, far above its end.
        thread = cls.post("ada", f"/api/v1/projects/{project}/conversations", {"body": "Can someone tidy the sensor tasks before Saturday?", "clientMessageId": str(uuid.uuid4())})
        cls.ids["thread"] = thread["id"]
        for index in range(14):
            cls.post("jonas", f"/api/v1/conversations/{thread['id']}/messages", {"body": f"Note {index + 1}: the probe on bed {index + 1} reads a little high after the rain.", "clientMessageId": str(uuid.uuid4())})
        for key, context in cls.contexts.items():
            cls.states[key] = context.storage_state()
        for _ in range(80):
            items = cls.contexts["ada"].request.get("/api/v1/needs-you").json()["items"]
            if len(items) >= 3:
                break
            time.sleep(0.25)

    @classmethod
    def tearDownClass(cls) -> None:
        for context in cls.contexts.values():
            context.close()
        cls.browser.close()
        cls.pw.stop()

    def page(self, viewport: dict, touch: bool = False, zoom: float | None = None, errors_ok: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "viewport": viewport, "locale": "en-GB", "service_workers": "block", "storage_state": self.states["ada"]}
        if touch:
            options.update(is_mobile=UI_BROWSER == "chromium", has_touch=True)
        if zoom:
            options.update(viewport={"width": int(viewport["width"] / zoom), "height": int(viewport["height"] / zoom)}, device_scale_factor=zoom)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        if not errors_ok:
            errors: list[str] = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def test_01_a_task_made_on_my_tasks_is_yours_and_shows_there(self) -> None:
        page = self.page(DESKTOP)
        page.goto("/tasks")
        expect(page.locator(".home-tasks, .ui-empty").first).to_be_visible()
        expect(page.get_by_text(OWN_TASK)).to_be_visible()
        page.keyboard.press("c")
        dialog = page.get_by_role("dialog", name="Task")
        expect(dialog).to_be_visible()
        title = f"Order the spare cases {STAMP}"
        dialog.locator(".create__title").fill(title)
        dialog.get_by_role("button", name="Create task").click()
        expect(dialog).to_have_count(0)
        # It is Ada's: listed on My tasks at once, as the page she made it on promises.
        expect(page.locator(".pane-scroll").get_by_text(title)).to_be_visible()
        made = [item for item in self.contexts["ada"].request.get(f"/api/v1/projects/{self.ids['project']}/work?limit=100").json()["items"] if item["title"] == title]
        self.assertEqual(len(made), 1)
        self.assertEqual((made[0]["owner"]["kind"], made[0]["owner"]["id"]), ("human", self.ids["ada"]))
        shot(page, f"round15-my-tasks-new-task-{UI_BROWSER}")

    def test_02_offline_home_and_a_space_read_before_keep_what_was_loaded(self) -> None:
        page = self.page(DESKTOP, errors_ok=True)
        page.goto("/")
        expect(page.locator("section.home__need .home__rows")).to_be_visible()
        places = page.get_by_role("navigation", name="Places")
        page.get_by_role("link", name=SPACE).first.click()
        expect(page.get_by_role("heading", level=1, name=SPACE)).to_be_visible()
        places.get_by_role("link", name=re.compile("^Inbox")).click()
        expect(page.locator(".nyq__list .nyc").first).to_be_visible()
        page.context.set_offline(True)
        expect(page.locator("[data-offline-notice]")).to_be_visible()
        places.get_by_role("link", name="Home", exact=True).click()
        # Home shows what it last loaded, as the offline line says, never "This couldn't be loaded".
        expect(page.locator("section.home__need .home__rows")).to_be_visible()
        expect(page.get_by_text("This couldn’t be loaded")).to_have_count(0)
        shot(page, f"round15-offline-home-{UI_BROWSER}")
        # A space read before opens inside the shell: the sidebar stays, never the whole-app "Flux can't be reached".
        page.get_by_role("link", name=SPACE).first.click()
        expect(page.get_by_role("heading", level=1, name=SPACE)).to_be_visible()
        expect(page.get_by_text("Flux can’t be reached")).to_have_count(0)
        expect(places).to_be_visible()
        shot(page, f"round15-offline-space-{UI_BROWSER}")
        page.context.set_offline(False)
        expect(page.locator("[data-offline-notice]")).to_have_count(0)

    def test_03_phone_offline_keeps_my_tasks_count_and_its_line_clears_the_plus(self) -> None:
        page = self.page(PHONE, touch=True, errors_ok=True)
        page.goto("/")
        mine = page.locator(".home__places").get_by_role("link", name=re.compile("^My tasks"))
        expect(mine).to_contain_text(re.compile(r"\(\d+\)"))
        count = re.search(r"\(\d+\)", mine.inner_text()).group(0)
        self.assertNotEqual(count, "(0)", "Ada owns a task")
        tabs = page.get_by_role("navigation", name="Main places")
        tabs.get_by_role("link", name=re.compile("^Inbox")).click()
        expect(page.locator(".nyq__list .nyc").first).to_be_visible()
        page.context.set_offline(True)
        notice = page.locator("[data-offline-notice]")
        expect(notice).to_be_visible()
        fab = page.locator(".phone-fab")
        expect(fab).to_be_visible()
        line, plus = notice.bounding_box(), fab.bounding_box()
        self.assertLessEqual(line["y"] + line["height"], plus["y"] + 0.5, f"the offline line stands above the +: {line} {plus}")
        shot(page, f"round15-offline-phone-inbox-{UI_BROWSER}")
        tabs.get_by_role("link", name="Home").click()
        # "My tasks (0)" was said for tasks that could not be read: offline it keeps the count it last read.
        expect(mine).to_contain_text(count)
        expect(mine).not_to_contain_text("(0)")
        page.context.set_offline(False)

    def test_04_the_phone_card_has_not_now_and_done_as_buttons(self) -> None:
        page = self.page(PHONE, touch=True)
        page.goto("/inbox")
        card = page.locator(".nyq__list .nyc").filter(has_text="gate code")
        expect(card).to_be_visible()
        if card.get_attribute("aria-current") != "true":
            box = card.locator(".nyc__card").bounding_box()
            page.touchscreen.tap(box["x"] + 10, box["y"] + box["height"] / 2)
            expect(card).to_have_attribute("aria-current", "true")
        actions = card.locator(".nyc__actions")
        for name in ("Not now", "Done"):
            button = actions.get_by_role("button", name=name, exact=True)
            expect(button).to_be_visible()
            expect(button).to_be_in_viewport()
            self.assertGreaterEqual(button.bounding_box()["height"], 44)
        shot(page, f"round15-phone-card-buttons-{UI_BROWSER}")
        actions.get_by_role("button", name="Done", exact=True).tap()
        expect(page.get_by_role("status").filter(has_text="Marked done")).to_be_visible()
        page.get_by_role("button", name="Undo").tap()
        expect(card).to_have_count(1)

    def test_05_the_phone_sheet_of_a_blocked_task_shows_its_title(self) -> None:
        page = self.page(PHONE, touch=True)
        page.goto("/inbox")
        card = page.locator(".nyq__list .nyc").filter(has_text=BLOCKED)
        expect(card).to_be_visible()
        card.locator(".nyc__open").tap()
        sheet = page.locator(".ui-detent-sheet .wd__scroll")
        expect(sheet).to_be_visible()
        title = sheet.locator(".details__title")
        expect(title).to_contain_text(BLOCKED)
        page.wait_for_timeout(400)
        room, box = sheet.bounding_box(), title.bounding_box()
        self.assertGreaterEqual(box["y"], room["y"] - 0.5, f"the task's title is in view at the sheet's top: {box} {room}")
        shot(page, f"round15-phone-blocked-sheet-{UI_BROWSER}")

    def test_06_at_200_percent_a_discussed_decision_opens_at_its_title(self) -> None:
        page = self.page(DESKTOP, zoom=2)
        page.goto("/inbox")
        card = page.locator(".nyq__list .nyc").filter(has_text=DECISION)
        expect(card).to_be_visible()
        card.locator(".nyc__open").click()
        panel = page.locator("#details .wd__scroll").first
        expect(panel).to_be_visible()
        title = panel.locator(".details__title")
        expect(title).to_contain_text(DECISION)
        page.wait_for_timeout(600)
        room, box = panel.bounding_box(), title.bounding_box()
        self.assertGreaterEqual(box["y"], room["y"] - 0.5, f"the decision's title is in view: {box} {room}")
        self.assertLessEqual(box["y"] + box["height"], room["y"] + room["height"], f"the decision's title is in view: {box} {room}")
        shot(page, f"round15-decision-200-{UI_BROWSER}")

    def test_07_open_on_what_an_agent_run_waits_for_lands_on_it(self) -> None:
        page = self.page(PHONE, touch=True)
        run = str(uuid.uuid4())
        change = {"id": str(uuid.uuid4()), "runId": run, "projectId": self.ids["project"], "conversationId": self.ids["thread"],
                  "operation": "work.update", "objectType": "work", "objectId": str(uuid.uuid4()), "objectTitle": "#8 Calibrate the probes", "state": "waiting",
                  "waitReason": "ask", "phrase": "change task", "verb": "Change", "line": "Waits for your OK: you asked it to check with you first.",
                  "forPerson": None, "tells": [], "agentName": "Assistant", "via": None, "done": "changed task #8 Calibrate the probes", "decidedBy": None,
                  "owner": {"id": self.ids["ada"], "name": PEOPLE["ada"][0]}, "runState": "done", "before": None, "after": None, "undoable": False, "version": 1, "createdAt": NOW}
        waiting = {"key": f"assistant:{run}", "kind": "question", "title": "1 thing waits for you", "detail": "change 1 task",
                   "project": {"id": self.ids["project"], "name": SPACE}, "from": None, "at": NOW,
                   "url": f"/projects/{self.ids['project']}/conversations/{self.ids['thread']}", "decision": None, "blocked": None, "reason": "question",
                   "snoozeTask": None, "assistantChanges": {"runId": run, "agentName": "Assistant", "summary": "change 1 task", "changes": [
                       {"id": change["id"], "version": 1, "phrase": "change task", "verb": "Change", "objectTitle": "#8 Calibrate the probes",
                        "line": change["line"], "waitReason": "ask", "forPerson": None, "tells": [], "after": None}]}}
        page.route(re.compile(r".*/api/v1/needs-you(\?.*)?$"), lambda route: route.fulfill(status=200, content_type="application/json",
                   body=json.dumps({"items": [waiting], "count": 1, "later": 0, "doneToday": 0})))
        page.route(re.compile(r".*/api/v1/conversations/[0-9a-f-]{36}/assistant-changes$"), lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps({"items": [change]})))
        page.goto("/inbox")
        card = page.locator(f'.nyc[data-key="assistant:{run}"]')
        expect(card).to_have_attribute("aria-current", "true")
        # What one run waits for is said in its own words, with the title in quotes, and one thing is approved, not "all".
        expect(card).to_contain_text("Change task “#8 Calibrate the probes”")
        expect(card.get_by_role("button", name="Approve", exact=True)).to_be_visible()
        expect(card.get_by_role("button", name="Approve all", exact=True)).to_have_count(0)
        shot(page, f"round15-run-card-{UI_BROWSER}")
        card.get_by_role("button", name="Open", exact=True).tap()
        expect(page).to_have_url(re.compile(re.escape(f"#waiting-{run}") + "$"))
        waits = page.locator(f'.assistant-waiting[data-run="{run}"]')
        expect(waits).to_be_visible()
        expect(waits.get_by_role("button", name="Approve", exact=True).first).to_be_in_viewport()
        shot(page, f"round15-run-open-{UI_BROWSER}")


if __name__ == "__main__":
    unittest.main()
