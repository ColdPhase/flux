"""PM essentials (#1519, founder decisions of 2026-11-14, #1424 item 9): a due day in Create, a thought that becomes a task from the thought itself,
and the tasks a person gave to others on My tasks.

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose application. Ada and Kai share a space with a map.
Screenshots (1519-*.png) go to FLUX_UI_SCREENSHOTS.
"""

from __future__ import annotations

import json
import re
import time
import unittest

from playwright.sync_api import Browser, Page, expect, sync_playwright

from create_window import dialog, linked_labels, open_from_tasks, submit_button
from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder

STAMP = int(time.time() * 1000)
PASSWORD = "a due day and a thought to act on"
PEOPLE = {"ada": ("Ada Lind", f"ada.pm+{STAMP}@example.test"), "kai": ("Kai Berg", f"kai.pm+{STAMP}@example.test")}
THOUGHT = "Ask the council about the allotment water meter"
GIVEN = "Book the village hall for the seed swap"
GIVEN_DAY = "2031-05-01"


def quote(text: str) -> str:
    return f"“{text[:47] + '…' if len(text) > 48 else text}”"


class PmEssentials(unittest.TestCase):
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
        contexts = {}
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"name": name, "email": email, "password": PASSWORD}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            contexts[key] = context

        def call(who: str, method: str, path: str, body: dict | None = None) -> dict:
            response = contexts[who].request.fetch(path, method=method, data=json.dumps(body) if body is not None else None,
                                                   headers={"origin": ORIGIN, "content-type": "application/json"})
            assert response.status in (200, 201), f"{method} {path}: {response.status} {response.text()}"
            return response.json()

        ws = call("ada", "POST", "/api/v1/workspaces", {"name": "Allotment club"})
        call("ada", "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE["kai"][1], "role": "member"})
        project = call("ada", "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Seed swap", "visibility": "workspace"})
        sketch = call("ada", "POST", f"/api/v1/workspaces/{ws['id']}/sketches", {"title": "Ideas", "scope": "project", "projectId": project["id"]})
        thought = call("ada", "POST", f"/api/v1/sketches/{sketch['id']}/thoughts", {"text": THOUGHT, "x": 0, "y": 0})
        call("ada", "POST", f"/api/v1/projects/{project['id']}/work", {"title": GIVEN, "owner": {"kind": "human", "id": cls.ids["kai"]}, "dueOn": GIVEN_DAY})
        call("ada", "POST", f"/api/v1/projects/{project['id']}/work", {"title": "Ada keeps this one", "owner": {"kind": "human", "id": cls.ids["ada"]}})
        cls.ids.update(workspace=ws["id"], project=project["id"], sketch=sketch["id"], thought=thought["thought"]["id"])
        for context in contexts.values():
            context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str, *, phone: bool = False, dark: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "service_workers": "block", "storage_state": self.states[who]}
        options.update(viewport=PHONE, device_scale_factor=2, is_mobile=UI_BROWSER == "chromium", has_touch=True) if phone else options.update(viewport=DESKTOP)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def tasks_of_project(self, page: Page) -> list[dict]:
        response = page.request.fetch(f"{ORIGIN}/api/v1/projects/{self.ids['project']}/work-view?purpose=tasks&group=all&kinds=work&limit=100", headers={"origin": ORIGIN})
        self.assertEqual(response.status, 200, response.text())
        return response.json()["items"]

    # ---------------------------------------------------------------- a due day in Create

    def test_01_a_task_can_have_its_due_day_in_create(self) -> None:
        for phone in (False, True):
            page = self.page("ada", phone=phone)
            page.goto(f"/projects/{self.ids['project']}/tasks")
            title = f"Order the compost bins {'phone' if phone else 'computer'}"
            open_from_tasks(page).fill(title)
            window = dialog(page)
            chip = window.get_by_role("button", name="Due, add a date")
            expect(chip).to_be_visible()
            self.assertGreaterEqual(chip.bounding_box()["height"], 43.9 if phone else 28, "the Due chip is a real target")
            shot(page, f"1519-create-due-empty-{'phone' if phone else 'computer'}")
            chip.tap() if phone else chip.click()
            # The date field with its calendar, as the task panel's Due has; Tomorrow saves at once.
            tomorrow = page.get_by_role("button", name="Tomorrow", exact=True)
            expect(tomorrow).to_be_visible()
            tomorrow.tap() if phone else tomorrow.click()
            expect(window).to_be_visible()  # choosing a day does not close the window
            chosen = window.get_by_role("button", name=re.compile(r"^Due \d"))
            expect(chosen).to_be_visible()
            shot(page, f"1519-create-due-set-{'phone' if phone else 'computer'}")
            submit = submit_button(page)
            submit.tap() if phone else submit.click()
            expect(dialog(page)).to_have_count(0)
            stored = next(item for item in self.tasks_of_project(page) if item["title"] == title)
            self.assertRegex(stored["dueOn"] or "", r"^\d{4}-\d{2}-\d{2}$", "the day was stored with the task")
            expect(page.locator("#details")).to_contain_text("Due")
        # A task made without a day has none.
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}/tasks")
        open_from_tasks(page).fill("Water the beds")
        submit_button(page).click()
        expect(dialog(page)).to_have_count(0)
        self.assertIsNone(next(item for item in self.tasks_of_project(page) if item["title"] == "Water the beds")["dueOn"])

    # ---------------------------------------------------------------- a thought becomes a task

    def test_02_a_thought_becomes_a_task_from_the_thought_itself(self) -> None:
        for phone in (False, True):
            page = self.page("ada", phone=phone)
            page.goto(f"/projects/{self.ids['project']}/map/{self.ids['sketch']}")
            node = page.locator(f'.sk-node[data-id="{self.ids["thought"]}"]')
            expect(node).to_be_visible()
            node.tap() if phone else node.click()
            if phone:
                page.get_by_role("button", name="Thought actions").tap()
                action = page.get_by_role("dialog", name="Thought actions").get_by_role("button", name="Make a task")
            else:
                action = page.get_by_role("toolbar", name="Selection actions").get_by_role("button", name="Make a task")
            expect(action).to_be_visible()
            shot(page, f"1519-make-a-task-{'phone' if phone else 'computer'}")
            action.tap() if phone else action.click()
            window = dialog(page)
            expect(window).to_be_visible()
            expect(window.get_by_label("Title", exact=True)).to_have_value(THOUGHT)
            expect(linked_labels(page)).to_have_count(1)
            expect(linked_labels(page).first).to_contain_text(quote(THOUGHT))
            shot(page, f"1519-make-a-task-window-{'phone' if phone else 'computer'}")
            submit = submit_button(page)
            submit.tap() if phone else submit.click()
            expect(dialog(page)).to_have_count(0)
        # The thought now has its tasks (both were linked to it), and stays on the map.
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}/map/{self.ids['sketch']}")
        expect(page.locator(f'.sk-node[data-id="{self.ids["thought"]}"] + .sk-work-slot .sk-work')).to_have_attribute("aria-label", f"2 tasks linked to {quote(THOUGHT)}")

    def test_03_a_thought_in_the_list_offers_make_a_task_too(self) -> None:
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}/map/{self.ids['sketch']}")
        expect(page.locator(".sk-canvas")).to_be_visible()
        page.get_by_role("radio", name="List", exact=True).click()
        row = page.locator(f'.sk-li-t[data-id="{self.ids["thought"]}"]')
        expect(row).to_be_visible()
        row.click()
        page.get_by_role("button", name=re.compile("^More")).first.click()
        item = page.get_by_role("button", name="Make a task")
        expect(item).to_be_visible()
        item.click()
        expect(dialog(page)).to_be_visible()
        expect(dialog(page).get_by_label("Title", exact=True)).to_have_value(THOUGHT)
        page.keyboard.press("Escape")

    # ---------------------------------------------------------------- tasks I gave others

    def test_04_my_tasks_shows_due_days_and_the_tasks_you_gave_others(self) -> None:
        for phone, dark in ((False, False), (True, True)):
            page = self.page("ada", phone=phone, dark=dark)
            page.goto("/tasks")
            mine = page.get_by_role("region", name="My tasks")
            expect(mine).to_be_visible()
            gave = page.get_by_role("region", name="Tasks you gave others")
            expect(gave).to_be_visible()
            row = gave.get_by_role("link").filter(has_text=GIVEN)
            expect(row).to_have_count(1)
            expect(row).to_contain_text("Kai Berg")
            expect(row).to_contain_text("Due 1 May 2031")
            # What Ada made for herself is on her own list, not on the other one.
            expect(gave.get_by_text("Ada keeps this one")).to_have_count(0)
            expect(mine.get_by_text("Ada keeps this one")).to_be_visible()
            self.assertEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"), "no sideways scroll")
            shot(page, f"1519-my-tasks-gave-{'phone' if phone else 'computer'}-{'dark' if dark else 'light'}")
        # Kai has the task on his own list with its day, and nothing he gave.
        kai = self.page("kai")
        kai.goto("/tasks")
        expect(kai.get_by_role("region", name="My tasks").get_by_role("link").filter(has_text=GIVEN)).to_contain_text("Due 1 May 2031")
        expect(kai.get_by_role("region", name="Tasks you gave others")).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
