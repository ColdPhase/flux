"""Browser tests for All my tasks (#190 HOME-2, reached from Home's My work since #272 FF-2): the work you own across your projects.

Runs with the other tests/ui modules through scripts/check_ui.sh against the running Compose
application. Ada runs two workspaces; Nia works in a project of each. Home's Tasks lists only
Nia's own unfinished work, grouped by project in the project Tasks order, reads every page,
forgets a project whose grant is gone and never shows Nia's tasks to the next account in the same
tab. Screenshots (home-tasks-*.png) go to FLUX_UI_SCREENSHOTS.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "tasks of my own on Home"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.tasks+{STAMP}@example.test"),
    "nia": ("Nia Berg", f"nia.tasks+{STAMP}@example.test"),
    "olek": ("Olek Wiatr", f"olek.tasks+{STAMP}@example.test"),
}
BATCH = 101


class HomeTasksJourney(unittest.TestCase):
    """Tests run in name order and share three accounts, two workspaces and two projects."""

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
        expect.set_options(timeout=10000)
        contexts: dict[str, BrowserContext] = {}
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            contexts[key] = context

        def call(who: str, method: str, path: str, body: dict | None = None) -> dict:
            response = contexts[who].request.fetch(path, method=method, data=body, headers={"origin": ORIGIN})
            assert response.status in (200, 201), f"{method} {path}: {response.status} {response.text()}"
            return response.json()

        studio = call("ada", "POST", "/api/v1/workspaces", {"name": "Lamp studio"})
        club = call("ada", "POST", "/api/v1/workspaces", {"name": "Bike club"})
        for ws in (studio, club):
            call("ada", "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE["nia"][1], "role": "member"})
        lamp = call("ada", "POST", f"/api/v1/workspaces/{studio['id']}/projects", {"name": "Gesture lamp", "visibility": "restricted"})
        bike = call("ada", "POST", f"/api/v1/workspaces/{club['id']}/projects", {"name": "Bike light", "visibility": "restricted"})
        grant = call("ada", "POST", f"/api/v1/projects/{bike['id']}/grants", {"principal": {"kind": "human", "id": cls.ids["nia"]}, "role": "contributor"})
        call("ada", "POST", f"/api/v1/projects/{lamp['id']}/grants", {"principal": {"kind": "human", "id": cls.ids["nia"]}, "role": "contributor"})
        nia = {"kind": "human", "id": cls.ids["nia"]}

        def work(project: dict, title: str, **extra) -> dict:
            return call("ada", "POST", f"/api/v1/projects/{project['id']}/work", {"title": title, "owner": nia, "clientCommandId": str(uuid.uuid4()), **extra})

        work(lamp, "Order the wide-angle lens")
        work(lamp, "Mount the PIR sensor", status="in_progress")
        work(lamp, "Calibrate the camera at 5 lux", status="blocked", blocker="Waiting for the lens")
        work(lamp, "Write the night-mode note", status="blocked")
        work(lamp, "Old wiring sketch", status="done")
        call("ada", "POST", f"/api/v1/projects/{lamp['id']}/work", {"title": "Ada's own soldering", "clientCommandId": str(uuid.uuid4()),
                                                                    "owner": {"kind": "human", "id": cls.ids["ada"]}})
        work(bike, "Wire the dynamo")
        # More than one page of the assigned-work API (100 per request).
        for index in range(BATCH):
            work(lamp, f"Batch check {index:03}")
        cls.ids.update(lamp=lamp["id"], bike=bike["id"], bike_grant=grant["id"])
        for context in contexts.values():
            context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str | None, *, phone: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
        options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP)
        if who:
            options["storage_state"] = self.states[who]
        context = self.browser.new_context(**options)
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

    def tasks(self, page: Page):
        return page.get_by_role("region", name="Your tasks")

    def group(self, page: Page, name: str):
        return self.tasks(page).locator(".home-tasks__place").filter(has=page.get_by_role("heading", level=3, name=name, exact=True))

    # ---------------------------------------------------------------- your work, every page, in order

    def test_01_your_unfinished_work_across_workspaces_in_project_order(self) -> None:
        page = self.page("nia")
        page.goto("/tasks")
        tasks = self.tasks(page)
        expect(tasks).to_be_visible()
        # Two workspaces, every page: 4 + 101 unfinished in the lamp, 1 in the bike light.
        lamp, bike = self.group(page, "Gesture lamp"), self.group(page, "Bike light")
        expect(lamp.get_by_role("link")).to_have_count(4 + BATCH)
        expect(bike.get_by_role("link")).to_have_count(1)
        names = [heading.inner_text() for heading in tasks.get_by_role("heading", level=3).all()]
        self.assertEqual(names, ["Bike light", "Gesture lamp"], "projects in name order")
        # The project Tasks order: in progress, then blocked, then open.
        statuses = [label.inner_text() for label in lamp.locator(".home-tasks__status").all()]
        self.assertEqual(statuses[0], "In progress")
        self.assertEqual(statuses[1:3], ["Blocked", "Blocked"])
        self.assertTrue(all(status == "Open" for status in statuses[3:]))
        blocked = lamp.get_by_role("link", name=re.compile("Calibrate the camera at 5 lux"))
        expect(blocked).to_contain_text("Waiting for the lens")
        expect(lamp.get_by_role("link", name=re.compile("Write the night-mode note"))).to_contain_text("No reason was recorded.")
        # Only Nia's own unfinished work.
        expect(tasks).not_to_contain_text("Old wiring sketch")
        expect(tasks).not_to_contain_text("Ada's own soldering")
        shot(page, "home-tasks-desktop-1440")
        # Each row opens the task in its project.
        blocked.click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['lamp']}/tasks"))
        expect(page.locator("#details").get_by_role("heading", name="Calibrate the camera at 5 lux")).to_be_visible()

    # ---------------------------------------------------------------- access is current

    def test_02_a_lost_grant_removes_its_tasks_on_the_next_read(self) -> None:
        page = self.page("nia")
        page.goto("/tasks")
        expect(self.group(page, "Bike light").get_by_role("link")).to_have_count(1)
        ada = self.page("ada")
        self.api(ada, "POST", f"/api/v1/projects/{self.ids['bike']}/grants",
                 {"principal": {"kind": "human", "id": self.ids["nia"]}, "role": "denied"}, status=201)
        page.reload()
        expect(self.group(page, "Gesture lamp").get_by_role("link")).to_have_count(4 + BATCH)
        expect(self.tasks(page)).not_to_contain_text("Wire the dynamo")
        expect(self.tasks(page)).not_to_contain_text("Bike light")

    # ---------------------------------------------------------------- one account at a time

    def test_03_the_next_account_in_the_tab_never_sees_the_previous_tasks(self) -> None:
        page = self.page("nia")
        page.goto("/tasks")
        expect(self.tasks(page)).to_contain_text("Mount the PIR sensor")
        # Nia's next read is answered only after Olek has signed in to this tab, and as a real success
        # with her tasks: a late answer for the previous account must never be shown (#211 review B2).
        late: list = []

        def answer_late(route) -> None:
            if late:
                route.continue_()
                return
            late.append((route, route.fetch()))

        assigned = re.compile(r"/work/assigned")
        page.route(assigned, answer_late)
        page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        for _ in range(60):
            if late:
                break
            page.wait_for_timeout(50)
        self.assertEqual(len(late), 1, "Nia's tasks were being read again")
        self.assertEqual(late[0][1].status, 200)
        # Signing out is on Settings, opened from the person at the foot of the sidebar (#272 FF-4).
        page.get_by_role("link", name=re.compile("^Nia Berg.*Settings and sign out")).click()
        page.get_by_role("button", name=re.compile("^Sign out")).click()
        expect(page).to_have_url(re.compile("/sign-in"))
        page.get_by_label("Email").fill(PEOPLE["olek"][1])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Sign in").click()
        expect(page.get_by_role("heading", name="Hi, Olek.")).to_be_visible()
        # Home's My work reads the same tasks (#272 FF-2): Olek owns none.
        expect(page.get_by_role("region", name="My work", exact=True)).to_contain_text("Nothing of yours is in progress.")
        page.get_by_role("link", name="All my tasks").click()
        expect(page.get_by_role("heading", name="Nothing is waiting for you")).to_be_visible()
        route, response = late[0]
        try:
            route.fulfill(response=response)
        except Exception:  # the page already gave up on it when the account changed
            pass
        page.unroute(assigned)
        page.wait_for_timeout(800)
        self.assertNotIn("Mount the PIR sensor", page.content())
        expect(page.get_by_role("heading", name="Nothing is waiting for you")).to_be_visible()
        # The sidebar offers the same link when there are no projects; this one is the empty state's.
        expect(page.locator("#content").get_by_role("link", name="Create a project")).to_have_attribute("href", "/projects/new")
        # Nor does Home's My work show them.
        page.get_by_role("navigation", name="Places").get_by_role("link", name="Home").click()
        expect(page.get_by_role("region", name="My work", exact=True)).to_contain_text("Nothing of yours is in progress.")
        self.assertNotIn("Mount the PIR sensor", page.content())

    # ---------------------------------------------------------------- phone

    # Before test_03, which signs Nia out and so ends the session her saved state holds.
    def test_02b_phone(self) -> None:
        page = self.page("nia", phone=True)
        page.goto("/tasks")
        lamp = self.group(page, "Gesture lamp")
        expect(lamp.get_by_role("link").first).to_contain_text("Mount the PIR sensor")
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"], "no horizontal scroll")
        first = lamp.get_by_role("link").first.bounding_box()
        assert first
        self.assertGreaterEqual(first["height"], 44, "touch target")
        shot(page, "home-tasks-phone-390")


if __name__ == "__main__":
    unittest.main()
