"""Browser tests for the H-11 returning-user findings fixed before the v0.1 release (#763).

Runs through scripts/check_ui.sh against the running Compose application, on the engine named by
FLUX_UI_BROWSER (run it with chromium and with webkit). Tomasz owns a project; Marta, a member, saw
it and Home, then while she was away Tomasz gave her a task with a due day, proposed a rule and
proposed and accepted another at once. It checks what Marta sees, on a computer (1440 x 900) and a
phone (390 x 844, touch):

* H11-5: What matters and Home's "Continue where you left off" lead to the task that became hers, with
  its due day; it comes before the rule waiting for her.
* H11-8: a Details panel shows its object across the views of one project and closes when she goes to
  another page (Inbox); Back brings it back.
* H11-9: a decision proposed and accepted together is one card with a line under it, not two
  identical cards; the owner's face in the task panel shows her initials, not "M(" from "(you)".
* A phone's long press keeps the five drawn items and puts "Add to map" and "Details" under "More…".
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from message_gestures import long_press
from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder

PASSWORD = "back from a week away"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "tomasz": ("Tomasz Wiśniewski", f"tomasz.h11+{STAMP}@example.test"),
    "marta": ("Marta Nowak", f"marta.h11+{STAMP}@example.test"),
}
MESSAGE = "Pilot results are in: most volunteers booked a shift in 40 seconds"
TASK = "Design the reminder email"
DUE = "4 Nov 2026"
OPEN_RULE = "Drop shift swapping"
DECIDED = "Launch on 21 November"
DRAWN = ["Reply in thread", "Create task", "Hand off to an agent", "Cite", "Copy text"]


class ReturnFixes(unittest.TestCase):
    """Tests run in name order and share two accounts and one project."""

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
        assert cls.browser.browser_type.name == UI_BROWSER
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}", flush=True)
        expect.set_options(timeout=10000)
        contexts = {}
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            contexts[key] = context

        def call(who: str, method: str, path: str, body: dict | None = None, headers: dict | None = None) -> dict:
            response = contexts[who].request.fetch(path, method=method, data=json.dumps(body) if body is not None else None,
                                                   headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})})
            assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
            return response.json() if response.text() else {}

        ws = call("tomasz", "POST", "/api/v1/workspaces", {"name": "Northside Food Bank"})
        call("tomasz", "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE["marta"][1], "role": "member"})
        pid = call("tomasz", "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Volunteer sign-up", "visibility": "restricted"})["id"]
        call("tomasz", "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": cls.ids["marta"]}, "role": "contributor"})
        root = call("tomasz", "POST", f"/api/v1/projects/{pid}/conversations", {"body": MESSAGE, "clientMessageId": str(uuid.uuid4())})
        task = call("tomasz", "POST", f"/api/v1/projects/{pid}/work", {"title": TASK})
        # Marta was here: her Home and project points are saved at what she saw.
        for query, place in (("place=home", {"type": "home"}), (f"place=project&id={pid}", {"type": "project", "id": pid})):
            mark = call("marta", "GET", f"/api/v1/return?{query}")["mark"]
            call("marta", "PUT", "/api/v1/return-points", {"place": place, "mark": mark})
        # While she is away.
        call("tomasz", "PATCH", f"/api/v1/work/{task['id']}", {"owner": {"kind": "human", "id": cls.ids["marta"]}, "dueOn": "2026-11-04"}, {"if-match": f"\"{task['version']}\""})
        decided = call("tomasz", "POST", f"/api/v1/projects/{pid}/decisions", {"title": DECIDED, "rationale": "The pilot went well"})
        call("tomasz", "POST", f"/api/v1/decisions/{decided['id']}/accept", {}, {"if-match": "\"1\""})
        call("tomasz", "POST", f"/api/v1/projects/{pid}/decisions", {"title": OPEN_RULE, "rationale": "Few volunteers use it"})
        for context in contexts.values():
            context.close()
        cls.ids.update(project=pid, workspace=ws["id"], conversation=root["id"], message=root["messages"][0]["id"], task=task["id"], decided=decided["id"])

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str = "marta", *, phone: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who]}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(service_workers="block", **options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    @staticmethod
    def inbox(page: Page) -> None:
        page.locator(".side__item[href='/inbox']").click()
        expect(page).to_have_url(re.compile(r"/inbox$"))

    # ---------------------------------------------------------------- H11-5, H11-8: What matters

    def test_01_what_matters_leads_to_the_given_task_with_its_due_day_and_closes_on_another_page(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}")
        expect(page.get_by_role("region", name="Since you left")).to_be_visible()
        page.get_by_role("region", name="Since you left").get_by_role("button", name="What matters", exact=True).click()
        panel = page.locator("#details")
        expect(panel.get_by_role("heading", name="What matters")).to_be_visible()
        step = panel.locator(".since__next")
        expect(step).to_contain_text(f"Pick up “{TASK}”")
        expect(step).to_contain_text(f"Tomasz gave it to you. Due {DUE}.")
        given = panel.get_by_role("link", name=re.compile(f"^Tomasz gave you a task: {TASK}"))
        expect(given).to_have_count(0)  # the next step is not repeated in the list
        expect(panel.get_by_role("link", name=re.compile(f"Proposed rule: {OPEN_RULE}"))).to_be_visible()
        shot(page, "h11-what-matters-due")
        # Another page: the recap does not follow her there.
        self.inbox(page)
        expect(panel.get_by_role("heading", name="What matters")).to_have_count(0)
        expect(panel.locator(".since__next")).to_have_count(0)
        shot(page, "h11-inbox-no-stale-panel")

    # ---------------------------------------------------------------- H11-5, H11-9, H11-8: Home and the task panel

    def test_02_home_continues_with_the_given_task_and_its_panel_stays_within_the_project(self) -> None:
        page = self.page()
        page.goto("/")
        card = page.get_by_role("link", name=re.compile("^Continue where you left off"))
        expect(card).to_contain_text(f"Pick up “{TASK}”")
        expect(card).to_contain_text(f"Due {DUE}")
        shot(page, "h11-home-continue-due")
        card.click()
        expect(page).to_have_url(re.compile(f"/projects/{self.ids['project']}"))
        panel = page.locator("#details")
        owner = panel.locator(".wd-row", has=page.locator("dt", has_text="Owner"))
        expect(owner).to_be_visible()
        # H11-9: the face is her initials; the "(you)" of the label is not one.
        expect(owner.locator(".ui-avatar")).to_have_text("MN")
        expect(owner).to_contain_text("Marta Nowak (you)")
        expect(panel.locator(".wd-row", has=page.locator("dt", has_text="Due"))).to_contain_text(DUE)
        shot(page, "h11-task-owner-face")
        # Another view of the same project keeps the task beside it.
        page.locator("nav[aria-label='Project views']").get_by_role("link", name="Tasks").click()
        expect(page).to_have_url(re.compile(f"/projects/{self.ids['project']}/tasks"))
        expect(owner).to_be_visible()
        # Another page closes it, with no "‹ back" trail left in the panel.
        self.inbox(page)
        expect(owner).to_have_count(0)
        expect(panel.get_by_role("button", name=re.compile("^(Task|Decision|Result|Back)$"))).to_have_count(0)
        # Back returns to the page where the task was open, with its panel (#592).
        page.go_back()
        expect(page).to_have_url(re.compile(f"/projects/{self.ids['project']}/tasks"))
        expect(owner).to_be_visible()

    # ---------------------------------------------------------------- H11-9: one decision card

    def test_03_a_decision_proposed_and_accepted_together_is_one_card(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}")
        stream = page.locator(".project-convo__message-list")
        lines = stream.locator(f".convo-object[data-object-id='{self.ids['decided']}']")
        expect(lines).to_have_count(2)
        expect(lines.locator(".convo-object__card")).to_have_count(1)
        expect(lines.locator(".convo-object__state")).to_have_text(["Accepted"])
        follow = stream.locator(f".convo-object.is-follow[data-object-kind='decision.accepted'][data-object-id='{self.ids['decided']}']")
        expect(follow.locator(".convo-notice__meta")).to_contain_text("Tomasz Wiśniewski")
        expect(follow.locator(".convo-notice__meta")).to_contain_text("accepted it")
        expect(stream.locator(".convo-object__card", has_text=DECIDED)).to_have_count(1)
        # The other proposal, alone, keeps its own card.
        expect(stream.locator(".convo-object__card", has_text=OPEN_RULE)).to_have_count(1)
        shot(page, "h11-one-decision-card")

    # ---------------------------------------------------------------- phone message menu

    def test_04_a_phone_long_press_keeps_five_items_and_puts_map_and_details_under_more(self) -> None:
        page = self.page(phone=True)
        page.goto(f"/projects/{self.ids['project']}")
        bubble = page.locator(f"#message-{self.ids['message']} .message-bubble > .message-body")
        expect(bubble).to_be_visible()
        bubble.scroll_into_view_if_needed()
        long_press(bubble)
        menu = page.get_by_role("menu", name="Message actions")
        expect(menu).to_be_visible()
        names = [text.strip() for text in menu.get_by_role("menuitem").all_inner_texts()]
        self.assertEqual(names, [*DRAWN, "More…"], "the five drawn items, then More…")
        menu.get_by_role("menuitem", name="More…").click()
        expect(menu).to_be_visible()
        names = [text.strip() for text in menu.get_by_role("menuitem").all_inner_texts()]
        self.assertEqual(names, ["Add to map", "Details"])
        expect(menu.get_by_role("menuitem", name="Add to map")).to_be_focused()
        for box in menu.get_by_role("menuitem").evaluate_all("items => items.map(el => el.getBoundingClientRect().height)"):
            self.assertGreaterEqual(box, 44, "a touch target")
        shot(page, "h11-phone-menu-more")
        menu.get_by_role("menuitem", name="Details").click()
        expect(menu).to_have_count(0)
        sheet = page.get_by_role("dialog", name="Details")
        expect(sheet).to_be_visible()
        # Add to map is there too and leads to the project's map.
        page.keyboard.press("Escape")
        expect(sheet).to_have_count(0)
        bubble.scroll_into_view_if_needed()
        long_press(bubble)
        expect(menu).to_be_visible()
        menu.get_by_role("menuitem", name="More…").click()
        menu.get_by_role("menuitem", name="Add to map").click()
        expect(page).to_have_url(re.compile(f"/projects/{self.ids['project']}/map/"))


if __name__ == "__main__":
    unittest.main()
