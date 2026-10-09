"""Browser tests for work, decisions and results linked to conversations (issue #101, AC-5/AC-6).

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose
application. Two people sign up in their own browser contexts and share one project. From
messages they create work in one action, propose and accept a decision, attach a negative result
that finishes the experiment and pivot with parking; one of them works on a phone. Every step is
checked against the API, so the test proves persisted behaviour rather than local state.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from author_columns import assert_author_column
from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, open_details, shot, start_forwarder, view_tab

PASSWORD = "decisions need reasons"
STAMP = int(time.time() * 1000)
OWNER = {"name": "Ada Lind", "email": f"ada.lind+{STAMP}@example.test"}
PARTNER = {"name": "Kai Berg", "email": f"kai.berg+{STAMP}@example.test"}
IDEA = "Test the camera in low light before we commit to it"
FINDING = "Camera caught 38% of gestures at 5 lux, so it fails in a dark bedroom"
PIVOT = "Switch to a ToF distance sensor"


class WorkDecisionsJourney(unittest.TestCase):
    """Tests run in name order and share two accounts and one project."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    project_id: str = ""
    conversation_id: str = ""
    messages: dict[str, str] = {}

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

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def work(self, page: Page) -> dict:
        return {
            "work": self.api(page, "GET", f"/api/v1/projects/{self.project_id}/work?limit=100", status=200)["items"],
            "decisions": self.api(page, "GET", f"/api/v1/projects/{self.project_id}/decisions?limit=100", status=200)["items"],
            "results": self.api(page, "GET", f"/api/v1/projects/{self.project_id}/results?limit=100", status=200)["items"],
        }

    def open_conversation(self, who: str, **kwargs) -> Page:
        page = self.page(who, **kwargs)
        page.goto(f"/projects/{self.project_id}/conversations/{self.conversation_id}")
        expect(page.locator(f"#message-{self.messages['idea']}")).to_be_visible()
        return page

    def details(self, page: Page):
        return page.locator("#details")

    # ---------------------------------------------------------------- set up two people

    def test_01_two_people_share_a_project(self) -> None:
        for key, person in (("owner", OWNER), ("partner", PARTNER)):
            page = self.page(None)
            page.goto("/sign-up")
            page.get_by_label("Name").fill(person["name"])
            page.get_by_label("Email").fill(person["email"])
            page.get_by_label("Password").fill(PASSWORD)
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            type(self).states[key] = page.context.storage_state()
            person["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        owner = self.page("owner")
        ws = self.api(owner, "POST", "/api/v1/workspaces", {"name": "Lamp studio"}, status=201)
        self.api(owner, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": PARTNER["email"], "role": "member"}, status=201)
        project = self.api(owner, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Gesture lamp", "visibility": "restricted"}, status=201)
        self.api(owner, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "human", "id": PARTNER["id"]}, "role": "contributor"}, status=201)
        type(self).project_id = project["id"]
        thread = self.api(owner, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": IDEA, "clientMessageId": str(uuid.uuid4())}, status=201)
        type(self).conversation_id = thread["id"]
        partner = self.page("partner")
        reply = self.api(partner, "POST", f"/api/v1/conversations/{thread['id']}/messages", {"body": FINDING, "clientMessageId": str(uuid.uuid4())}, status=201)
        pivot = self.api(owner, "POST", f"/api/v1/conversations/{thread['id']}/messages", {"body": PIVOT, "clientMessageId": str(uuid.uuid4())}, status=201)
        type(self).messages = {"idea": thread["messages"][0]["id"], "finding": reply["id"], "pivot": pivot["id"]}

    # ---------------------------------------------------------------- create from a message

    def test_02_create_work_from_a_message_in_one_action(self) -> None:
        page = self.open_conversation("owner")
        # The computer's header is one row without a state line (#340); the project starts empty.
        expect(page.get_by_label("Current state")).to_have_count(0)
        self.assertEqual(self.work(page), {"work": [], "decisions": [], "results": []})
        message = page.locator(f"#message-{self.messages['idea']}")
        message.hover()
        message.get_by_role("button", name="Task", exact=True).click()
        panel = self.details(page)
        expect(panel.get_by_role("heading", name=IDEA)).to_be_visible()
        expect(panel.get_by_label("Status")).to_have_value("open")
        expect(panel).to_contain_text("Everyone with access to Gesture lamp")
        expect(panel.get_by_role("link", name=re.compile("^Message: Test the camera"))).to_be_visible()
        # The source stays in place, and the work shows up under it.
        expect(message.locator(".project-convo__message-meta ~ p").first).to_have_text(IDEA)
        expect(message.get_by_role("button", name=f"Work: {IDEA}")).to_be_visible()
        # The panel's controls change the stored work (If-Match under the hood).
        panel.get_by_label("Status").select_option("in_progress")
        expect(panel.locator(".wd-eyebrow")).to_contain_text("In progress")
        # Details names the task by its number in the project (#276).
        expect(panel.locator(".wd-eyebrow")).to_have_text(re.compile(r"^Task #[1-9]\d* · Gesture lamp · In progress"))
        expect(panel.locator(".wd-eyebrow .ui-task-number")).to_have_text("#1")
        expect(message.locator(".ws-chip .ui-task-number")).to_have_text("#1")
        self.assertTrue(message.locator(".ws-chip").evaluate("node => node.querySelector('.ui-task-number').compareDocumentPosition(node.querySelector('.ws-chip__t')) & Node.DOCUMENT_POSITION_FOLLOWING"), "the number leads the title in a task reference")
        panel.get_by_label("Owner").select_option(f"human:{PARTNER['id']}")
        expect(message.get_by_role("button", name=f"Work: {IDEA}")).to_contain_text("Kai Berg")
        stored = self.work(page)["work"]
        self.assertEqual(len(stored), 1, "one action creates exactly one work item")
        item = stored[0]
        self.assertEqual((item["title"], item["status"], item["owner"]["id"]), (IDEA, "in_progress", PARTNER["id"]))
        self.assertEqual([(link["role"], link["to"]) for link in item["links"]], [("source", {"type": "message", "id": self.messages["idea"]})])
        thread = self.api(page, "GET", f"/api/v1/conversations/{self.conversation_id}", status=200)
        self.assertEqual([m["body"] for m in thread["messages"]], [IDEA, FINDING, PIVOT], "no message was moved or copied")
        shot(page, "work-desktop-1440-created")

    # ---------------------------------------------------------------- propose and accept, by keyboard

    def test_03_propose_and_accept_a_decision_with_the_keyboard(self) -> None:
        page = self.open_conversation("owner")
        message = page.locator(f"#message-{self.messages['idea']}")
        message.get_by_role("button", name="Decision", exact=True).focus()
        page.keyboard.press("Enter")
        panel = self.details(page)
        expect(panel.get_by_role("heading", name="Propose a decision")).to_be_visible()
        expect(panel.get_by_label("Decision")).to_have_value(IDEA)
        panel.get_by_label("Decision").fill("Use a camera for gesture control")
        panel.get_by_label("Why").fill("It recognises the richest set of gestures")
        # Native rule choices and their page controls are now keyboard reachable.
        expect(panel.get_by_role("button", name="Propose decision", exact=True)).to_be_enabled()
        panel.get_by_role("button", name="Propose decision", exact=True).focus()
        page.keyboard.press("Enter")
        expect(panel.locator(".wd-eyebrow")).to_contain_text("Proposed decision")
        self.assertEqual(self.work(page)["decisions"][0]["status"], "proposed")
        shot(page, "decision-desktop-1440-proposed")
        panel.get_by_role("button", name="Accept decision").focus()
        page.keyboard.press("Enter")
        expect(panel.locator(".wd-eyebrow")).to_contain_text("Current rule")
        expect(panel).to_contain_text("Ada Lind")
        decision = self.work(page)["decisions"][0]
        self.assertEqual((decision["status"], decision["decidedBy"]["id"]), ("accepted", OWNER["id"]))
        self.assertEqual([link["to"]["id"] for link in decision["links"] if link["role"] == "source"], [self.messages["idea"]])
        page.keyboard.press("Escape")
        expect(message.get_by_role("button", name="Decision: Use a camera for gesture control")).to_be_visible()

    # ---------------------------------------------------------------- negative result, other person

    def test_04_attach_a_negative_result_that_finishes_the_experiment(self) -> None:
        page = self.open_conversation("partner")
        message = page.locator(f"#message-{self.messages['finding']}")
        message.hover()
        # A reply sits in the thread beside the stream (UI116-1); its actions open from one ⋯ in its corner.
        message.get_by_role("button", name="Make from this message").click()
        message.get_by_role("button", name="Result", exact=True).click()
        panel = self.details(page)
        expect(panel.get_by_role("heading", name="Attach a result")).to_be_visible()
        panel.get_by_label("Finding").fill("The camera cannot track gestures below 10 lux")
        panel.get_by_text("Negative", exact=True).click()
        panel.get_by_label("Evidence").fill("38% of 20 gestures at 5 lux")
        panel.get_by_label("For work").select_option(label=IDEA)
        panel.get_by_label(f"This finishes “{IDEA}”").check()
        panel.get_by_role("button", name="Attach result").click()
        expect(panel.locator(".wd-eyebrow")).to_contain_text("Negative result")
        expect(panel.get_by_role("button", name=re.compile(IDEA))).to_be_visible()
        expect(message.get_by_role("button", name="Result: The camera cannot track gestures below 10 lux")).to_be_visible()
        stored = self.work(page)
        self.assertEqual(stored["results"][0]["finding"], "negative")
        self.assertEqual(stored["work"][0]["status"], "done", "a negative result finished the experiment")
        shot(page, "result-desktop-1440-negative")

        page.get_by_role("navigation", name="Project views").get_by_role("link", name="Tasks").click()
        expect(page).to_have_url(re.compile(r"/tasks$"))
        # Finished work, decisions and results are grouped in the List (#136; the board shows work by status).
        page.get_by_role("radio", name="List", exact=True).click()
        expect(page.get_by_role("region", name=re.compile("^Finished"))).to_contain_text(IDEA)
        expect(page.get_by_role("region", name=re.compile("^Decisions"))).to_contain_text("Use a camera for gesture control")
        expect(page.get_by_role("region", name=re.compile("^Results"))).to_contain_text("The camera cannot track gestures")

    # ---------------------------------------------------------------- pivot parks work

    def test_05_pivot_keeps_history_and_parks_obsolete_work(self) -> None:
        page = self.page("owner")
        page.goto(f"/projects/{self.project_id}/tasks")
        page.get_by_role("radio", name="List", exact=True).click()
        page.get_by_label("New task").fill("Mount the camera in the lamp head")
        page.get_by_role("button", name="Add task").click()
        panel = self.details(page)
        expect(panel.get_by_role("heading", name="Mount the camera in the lamp head")).to_be_visible()
        page.get_by_label("New task").fill("Design the diffuser")
        page.get_by_role("button", name="Add task").click()
        expect(panel.get_by_role("heading", name="Design the diffuser")).to_be_visible()

        # Attaching a result to work opened that task's own conversation (#154), now the project's newest one:
        # open the original conversation explicitly.
        page.goto(f"/projects/{self.project_id}/conversations/{self.conversation_id}")
        message = page.locator(f"#message-{self.messages['pivot']}")
        message.hover()
        message.get_by_role("button", name="Make from this message").click()
        message.get_by_role("button", name="Decision", exact=True).click()
        panel.get_by_label("Why").fill("The camera failed in low light; a ToF sensor works in the dark and stores no images")
        panel.get_by_label("Replaces").select_option(label="Use a camera for gesture control")
        panel.get_by_role("button", name="Propose decision").click()
        expect(panel.get_by_role("heading", name="Accept as a pivot")).to_be_visible()
        panel.get_by_role("radiogroup", name="Mount the camera in the lamp head").get_by_label("Park").check()
        panel.get_by_role("radiogroup", name="Design the diffuser").get_by_label("Still applies").check()
        shot(page, "decision-desktop-1440-pivot")
        panel.get_by_role("button", name="Accept and pivot").click()
        expect(panel.locator(".wd-eyebrow")).to_contain_text("Current rule")
        expect(panel.get_by_role("region", name="At this pivot")).to_contain_text("parked")

        stored = self.work(page)
        by_title = {item["title"]: item for item in stored["work"]}
        self.assertEqual(by_title["Mount the camera in the lamp head"]["status"], "open", "parked work keeps its status")
        self.assertIsNotNone(by_title["Mount the camera in the lamp head"]["parked"])
        self.assertIsNone(by_title["Design the diffuser"]["parked"])
        rules = {item["title"]: item for item in stored["decisions"]}
        self.assertEqual(rules["Use a camera for gesture control"]["status"], "superseded")
        self.assertEqual(rules["Use a camera for gesture control"]["rationale"], "It recognises the richest set of gestures")

        page.get_by_role("navigation", name="Project views").get_by_role("link", name="Tasks").click()
        expect(page.get_by_role("region", name=re.compile("^Parked by a pivot"))).to_contain_text("Mount the camera in the lamp head")
        expect(page.get_by_role("region", name=re.compile("^Decisions"))).to_contain_text("Earlier rule")
        page.keyboard.press("Escape")
        shot(page, "tasks-desktop-1440")

    # ---------------------------------------------------------------- phone

    def test_06_phone_creates_work_and_reads_the_tasks_tab(self) -> None:
        page = self.open_conversation("partner", phone=True)
        message = page.locator(f"#message-{self.messages['finding']}")
        # On touch one quiet button per message opens its actions.
        expect(message.get_by_role("button", name="Task", exact=True)).to_have_count(0)
        more = message.get_by_role("button", name="Make from this message")
        box = more.bounding_box()
        assert box
        self.assertGreaterEqual(box["height"], 44, "touch target")
        shot(page, "work-phone-390-conversation")
        more.tap()
        create = message.get_by_role("button", name="Task", exact=True)
        self.assertGreaterEqual(create.bounding_box()["height"], 44, "touch target")
        create.tap()
        sheet = page.get_by_role("dialog", name="Details")
        expect(sheet.get_by_role("heading", name=FINDING)).to_be_visible()
        expect(sheet).to_contain_text("Everyone with access to Gesture lamp")
        shot(page, "work-phone-390-details")
        sheet.get_by_role("button", name="Close details").tap()
        expect(message.get_by_role("button", name=f"Work: {FINDING}")).to_be_visible()
        view_tab(page, "Tasks", tap=True)
        expect(page.get_by_role("region", name=re.compile("^Open"))).to_contain_text(FINDING)
        shot(page, "tasks-phone-390")
        titles = [item["title"] for item in self.work(page)["work"]]
        self.assertEqual(titles.count(FINDING), 1)

    # ---------------------------------------------------------------- beyond one page

    def test_07_more_than_a_hundred_records_remain_reachable_through_native_pages(self) -> None:
        page = self.page("owner")
        spaces = self.api(page, "GET", "/api/v1/workspaces", status=200)
        project = self.api(page, "POST", f"/api/v1/workspaces/{spaces[0]['id']}/projects", {"name": "Big lamp", "visibility": "restricted"}, status=201)
        base = f"/api/v1/projects/{project['id']}"
        rule = self.api(page, "POST", f"{base}/decisions", {"title": "Oldest rule: battery powered"}, status=201)
        self.api(page, "POST", f"/api/v1/decisions/{rule['id']}/accept", {"expectedVersion": 1}, status=200)
        expected={("decision",rule["id"])}
        for index in range(1, 102):
            item=self.api(page, "POST", f"{base}/decisions", {"title": f"Idea {index:03d}"}, status=201)
            expected.add(("decision",item["id"]))
        for index in range(1, 102):
            item=self.api(page, "POST", f"{base}/work", {"title": f"Work item {index:03d}"}, status=201)
            expected.add(("work",item["id"]))
        self.assertEqual(self.api(page, "GET", f"{base}/work?limit=1", status=200)["total"], 101)
        page.goto(f"/projects/{project['id']}/tasks")
        page.get_by_role("radio", name="List", exact=True).click()
        # The project's state is in Details (#340): the rule in force, found among 101 tasks.
        open_details(page)
        expect(page.locator("#details").get_by_role("region", name="Now in this project").get_by_role("button", name=re.compile("^Current rule"))).to_contain_text("Oldest rule: battery powered")
        page.get_by_role("button", name="Close details", exact=True).click()
        views=page.get_by_role("navigation",name="Task views")
        expect(views.get_by_role("button",name=re.compile("^Open"))).to_contain_text("101")
        expect(views.get_by_role("button",name=re.compile("^Needs you"))).to_contain_text("101")
        pager=page.get_by_role("navigation",name="Work pages");seen=set();sizes=[]
        for index in range(5):
            before=index*50
            expect(pager).to_contain_text(f"{before+1}–{min(before+50,203)} of 203 objects")
            rows=page.locator(".ws-tasks [data-work-id]").evaluate_all("els=>els.map(el=>[el.dataset.workKind,el.dataset.workId])")
            self.assertLessEqual(len(rows),50);sizes.append(len(rows));seen.update(tuple(row) for row in rows)
            if index<4:pager.get_by_role("button",name="Next",exact=True).click()
        self.assertEqual(sizes,[50,50,50,50,3])
        self.assertEqual(seen,expected,"every native work and decision remains reachable beyond the first hundred")
        expect(pager.get_by_role("button",name="Next",exact=True)).to_be_disabled()
        pager.get_by_role("button",name="Previous",exact=True).click()
        expect(pager).to_contain_text("151–200 of 203 objects")

    # ---------------------------------------------------------------- phone task views (#136 AC-2)

    def test_08_phone_finds_own_blocked_work_and_returns_to_the_same_view(self) -> None:
        owner = self.page("owner")
        base = f"/api/v1/projects/{self.project_id}/work"
        mine = "Solder the ToF sensor board for the second prototype enclosure"
        theirs = "Order spare ToF sensors"
        me = {"kind": "human", "id": PARTNER["id"]}
        self.api(owner, "POST", base, {"title": mine, "status": "blocked", "blocker": "the sensor delivery", "owner": me}, status=201)
        self.api(owner, "POST", base, {"title": theirs, "status": "blocked", "blocker": "a supplier reply", "owner": {"kind": "human", "id": OWNER["id"]}}, status=201)
        self.api(owner, "POST", base, {"title": "Measure the lamp current", "status": "in_progress", "owner": me}, status=201)

        page = self.page("partner", phone=True)
        page.goto(f"/projects/{self.project_id}/tasks")
        page.get_by_role("radio", name="List", exact=True).tap()
        views = page.get_by_role("navigation", name="Task views")
        expect(views.get_by_role("button", name="All", exact=True)).to_have_attribute("aria-pressed", "true")
        # Whole labels with their counts, no clipped column; every view is a 44 px touch target.
        blocked = views.get_by_role("button", name=re.compile("^Blocked"))
        expect(blocked).to_contain_text("2")
        self.assertGreaterEqual(blocked.bounding_box()["height"], 44, "touch target")
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"], "no sideways page scroll")
        shot(page, "tasks-phone-390-views")

        blocked.tap()
        expect(blocked).to_have_attribute("aria-pressed", "true")
        self.assertIn("status=blocked", page.url)
        expect(page.get_by_role("region", name=re.compile("^Open"))).to_have_count(0)
        region = page.get_by_role("region", name=re.compile("^Blocked"))
        expect(region).to_contain_text(mine)
        expect(region).to_contain_text(theirs)

        views.get_by_label("Only mine").check()
        self.assertIn("show=mine", page.url)
        expect(region).to_contain_text(mine)
        expect(region).not_to_contain_text(theirs)
        expect(region).to_contain_text("waiting for the sensor delivery")
        shot(page, "tasks-phone-390-mine-blocked")

        # Opening the work and coming back from another view keeps the chosen view.
        region.get_by_role("button", name=re.compile(re.escape(mine))).tap()
        sheet = page.get_by_role("dialog", name="Details")
        expect(sheet.get_by_role("heading", name=mine)).to_be_visible()
        sheet.get_by_role("button", name="Close details").tap()
        expect(blocked).to_have_attribute("aria-pressed", "true")
        view_tab(page, "Conversation", tap=True)
        # The Conversation tab opens the newest conversation, which is the task thread that the earlier result opened (#154).
        expect(page.locator(".project-convo__message-list")).to_be_visible()
        page.go_back()
        expect(page.get_by_role("navigation", name="Task views").get_by_role("button", name=re.compile("^Blocked"))).to_have_attribute("aria-pressed", "true")
        expect(page.get_by_role("navigation", name="Task views").get_by_label("Only mine")).to_be_checked()
        # The Tasks tab itself also returns to the chosen view.
        view_tab(page, "Conversation", tap=True)
        view_tab(page, "Tasks", tap=True)
        # The outgoing Tasks DOM can remain while the requested route loads.
        # Check the completed destination before treating its retained controls as proof.
        expect(page).to_have_url(re.compile(r"/tasks\?(?=[^#]*status=blocked)(?=[^#]*show=mine)"))
        expect(page.get_by_role("navigation", name="Task views").get_by_role("button", name=re.compile("^Blocked"))).to_have_attribute("aria-pressed", "true")
        self.assertIn("show=mine", page.url)

        # An empty view says so and offers the way back instead of a blank screen.
        page.goto(f"/projects/{self.project_id}/tasks?status=parked&show=mine")
        expect(page.get_by_role("navigation", name="Task views").get_by_role("button", name=re.compile("^Parked"))).to_have_attribute("aria-pressed", "true")
        expect(page.locator(".ws-none")).to_contain_text("Nothing of yours in parked right now.")
        page.get_by_role("button", name="Show everyone’s").tap()
        expect(page.get_by_role("navigation", name="Task views").get_by_label("Only mine")).not_to_be_checked()

        # Keyboard on desktop: views are buttons in reading order with a visible pressed state.
        desk = self.page("partner")
        desk.goto(f"/projects/{self.project_id}/tasks?status=in_progress")
        expect(desk.get_by_role("navigation", name="Task views").get_by_role("button", name=re.compile("^In progress"))).to_have_attribute("aria-pressed", "true")
        expect(desk.get_by_role("region", name=re.compile("^In progress"))).to_contain_text("Measure the lamp current")
        shot(desk, "tasks-desktop-1440-in-progress")

    # ---------------------------------------------------------------- common author column (F-026, superseding #136 AC-1)

    def assert_columns(self, page: Page, label: str) -> None:
        # Opening Details slides the pane; measure once it has settled.
        page.wait_for_function("""() => new Promise((resolve) => {
          const el = document.querySelector('.thread__in');
          const first = el.getBoundingClientRect().x;
          setTimeout(() => resolve(el.getBoundingClientRect().x === first), 250);
        })""")
        # One project conversation (UI116-1): the root is in the stream and its replies in the thread
        # beside it (over it on a phone). Every author keeps the same full face/name column.
        feed = page.locator(".thread__in").bounding_box()
        mine = page.locator(f"#message-{self.messages['finding']} > p").bounding_box()
        theirs = page.locator(f"#message-{self.messages['pivot']} > p").bounding_box()
        stream = page.locator(".project-convo__in").bounding_box()
        root = page.locator(f"#message-{self.messages['idea']} > p").bounding_box()
        assert feed and mine and theirs and stream and root
        for key in ("finding", "pivot", "idea"):
            message = page.locator(f"#message-{self.messages[key]}")
            assert_author_column(self, message, page.viewport_size["width"], f"{label}: {key}")
            meta = message.locator(".project-convo__message-meta").bounding_box()
            bubble = message.locator(":scope > p").bounding_box()
            self.assertAlmostEqual(bubble["x"], meta["x"], delta=1, msg=f"{label}: {key} starts at the author-name edge")
        self.assertAlmostEqual(mine["x"], theirs["x"], delta=1, msg=f"{label}: own and other messages share one left edge")
        own_fill = page.locator(f"#message-{self.messages['finding']} > p").evaluate("el => getComputedStyle(el).backgroundColor")
        other_fill = page.locator(f"#message-{self.messages['pivot']} > p").evaluate("el => getComputedStyle(el).backgroundColor")
        self.assertNotEqual(own_fill, other_fill, f"{label}: the own-message treatment still distinguishes it")
        self.assertLessEqual(mine["x"] + mine["width"], feed["x"] + feed["width"] + 1, f"{label}: inside the pane")
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.viewport_size["width"], f"{label}: no sideways scroll")
        # Linked work, decisions and results stay inside their column and the viewport on both sides.
        for column, pane in ((".project-convo__in", stream), (".thread__in", feed)):
            chips = page.locator(f"{column} .project-convo__message .ws-chip")
            self.assertGreater(chips.count(), 0, f"{label}: {column} has linked objects")
            for index in range(chips.count()):
                box = chips.nth(index).bounding_box()
                assert box
                self.assertGreaterEqual(box["x"], pane["x"] - 1, f"{label}: linked object {index} starts inside {column}")
                self.assertLessEqual(box["x"] + box["width"], pane["x"] + pane["width"] + 1, f"{label}: linked object {index} ends inside {column}")
                self.assertLessEqual(box["x"] + box["width"], page.viewport_size["width"], f"{label}: linked object {index} is not cut off")

    def test_09_authors_share_the_full_avatar_column_on_every_viewport(self) -> None:
        page = self.open_conversation("partner")
        expect(page.locator(f"#message-{self.messages['finding']}")).to_have_class(re.compile("is-mine"))
        expect(page.locator(f"#message-{self.messages['pivot']}")).not_to_have_class(re.compile("is-mine"))
        expect(page.locator(f"#message-{self.messages['idea']}")).not_to_have_class(re.compile("is-mine"))
        # Complete names and genuine own-message identity remain visible.
        expect(page.locator(f"#message-{self.messages['finding']}")).to_contain_text("Kai Berg · you")
        expect(page.locator(f"#message-{self.messages['idea']}")).to_contain_text("Ada Lind")
        self.assert_columns(page, "desktop")
        # Hover actions never cover the author or time on either side.
        for key in ("finding", "idea"):
            message = page.locator(f"#message-{self.messages[key]}")
            message.hover()
            acts = message.locator(".ws-acts").bounding_box()
            for part in (message.locator(".project-convo__message-meta strong"), message.locator(".project-convo__message-meta time")):
                box = part.bounding_box()
                assert acts and box
                apart = acts["x"] + acts["width"] <= box["x"] or box["x"] + box["width"] <= acts["x"] or acts["y"] + acts["height"] <= box["y"] or box["y"] + box["height"] <= acts["y"]
                self.assertTrue(apart, f"{key}: actions clear of the meta line")
        shot(page, "conversation-author-column-1440")
        # Narrowed beside an open panel.
        page.locator(f"#message-{self.messages['finding']}").get_by_role("button", name=re.compile("^Work: ")).first.click()
        expect(page.locator("#details")).to_be_visible()
        self.assert_columns(page, "beside details")
        shot(page, "conversation-author-column-1440-details")
        phone = self.open_conversation("partner", phone=True)
        self.assert_columns(phone, "phone")
        shot(phone, "conversation-author-column-390")

    # ---------------------------------------------------------------- reading position (#136 AC-2)

    def test_10_each_task_view_keeps_its_reading_position(self) -> None:
        owner = self.page("owner")
        me = {"kind": "human", "id": PARTNER["id"]}
        for index in range(1, 46):
            self.api(owner, "POST", f"/api/v1/projects/{self.project_id}/work",
                     {"title": f"Blocked step {index:02d}: check the ToF bracket", "status": "blocked", "blocker": "parts", "owner": me}, status=201)
        page = self.page("partner", phone=True)
        page.goto(f"/projects/{self.project_id}/tasks")
        page.get_by_role("radio", name="List", exact=True).tap()
        views = page.get_by_role("navigation", name="Task views")
        views.get_by_role("button", name=re.compile("^Blocked")).tap()
        pane = page.locator(".pane-scroll").first
        expect(page.get_by_role("region", name=re.compile("^Blocked"))).to_contain_text("Blocked step 45")
        pane.evaluate("(el) => { el.scrollTop = 850; }")
        page.wait_for_timeout(300)
        saved = pane.evaluate("(el) => el.scrollTop")
        self.assertGreater(saved, 600, "the list is long enough to scroll")
        # Through the Conversation tab and back through the Tasks tab.
        view_tab(page, "Conversation", tap=True)
        expect(page.locator(".project-convo__message-list")).to_be_visible()
        view_tab(page, "Tasks", tap=True)
        expect(page.get_by_role("navigation", name="Task views").get_by_role("button", name=re.compile("^Blocked"))).to_have_attribute("aria-pressed", "true")
        page.wait_for_timeout(300)
        self.assertLess(abs(page.locator(".pane-scroll").first.evaluate("(el) => el.scrollTop") - saved), 8, "the Tasks tab returns to the same reading position")
        # Switching view and back, pressing the buttons directly (no automatic scrolling into view).
        page.get_by_role("navigation", name="Task views").get_by_role("button", name=re.compile("^Open")).evaluate("(button) => button.click()")
        page.wait_for_timeout(300)
        page.get_by_role("navigation", name="Task views").get_by_role("button", name=re.compile("^Blocked")).evaluate("(button) => button.click()")
        page.wait_for_timeout(300)
        self.assertLess(abs(page.locator(".pane-scroll").first.evaluate("(el) => el.scrollTop") - saved), 8, "switching views keeps each view's position")


if __name__ == "__main__":
    unittest.main()
