"""A project's optional goal in Details and the phone view menu (#520, F-028, docs/product/project-goals.md).

A project without a goal shows nothing extra. People who can write set the goal from Details' "⋯", edit it,
mark it reached (Undo in the toast and in "⋯") and remove it; who did it and when is shown. Viewers read it
without the "⋯". The phone view menu shows the current goal under the project name, as Prostota draws it.
Real accounts and projects through the public API against the running Compose app (scripts/check_ui.sh).
"""

from __future__ import annotations

import json
import os
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, open_details, phone_menu, shot, start_forwarder

PASSWORD = "one sentence we all share"
STAMP = int(time.time() * 1000)
GOAL = "All six beds report moisture"


class ProjectGoalJourney(unittest.TestCase):
    browser: Browser
    states: dict = {}
    ids: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, os.environ.get("FLUX_UI_BROWSER", "chromium")).launch()
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str = "ada", *, phone: bool = False, scheme: str = "light") -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": scheme, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "service_workers": "block"}
        options.update(viewport=PHONE, device_scale_factor=2, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP, device_scale_factor=1)
        if who in self.states:
            options["storage_state"] = self.states[who]
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context.new_page()

    def call(self, page: Page, method: str, path: str, body: dict | None = None, *, status: int = 201, headers: dict | None = None) -> dict:
        sent = {"origin": ORIGIN, **(headers or {})}
        if body is not None:
            sent["content-type"] = "application/json"
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers=sent, data=json.dumps(body) if body is not None else None)
        self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def project(self, page: Page, project_id: str) -> dict:
        return self.call(page, "GET", f"/api/v1/projects/{project_id}", status=200)

    def sign_up(self, who: str, name: str) -> Page:
        page = self.page(who)
        email = f"{who}.goal+{STAMP}@example.test"
        self.call(page, "POST", "/api/auth/sign-up/email", {"email": email, "password": PASSWORD, "name": name}, status=200)
        type(self).states[who] = page.context.storage_state()
        self.ids[f"{who}-email"] = email
        return page

    def ensure_people(self) -> None:
        if "project" in self.ids:
            return
        ada = self.sign_up("ada", "Ada Kowalska")
        self.sign_up("jonas", "Jonas Berg")
        workspace = self.call(ada, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"})
        self.call(ada, "POST", f"/api/v1/workspaces/{workspace['id']}/members", {"email": self.ids["jonas-email"], "role": "member"})
        jonas_id = self.call(self.page("jonas"), "GET", "/api/v1/me", status=200)["user"]["id"]
        project = self.call(ada, "POST", f"/api/v1/workspaces/{workspace['id']}/projects", {"name": "Community garden sensors", "visibility": "restricted"})
        self.call(ada, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "human", "id": jonas_id}, "role": "viewer"})
        self.call(ada, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": "Moisture first. The volunteers keep overwatering the raised beds.", "clientMessageId": str(uuid.uuid4())})
        self.ids.update(workspace=workspace["id"], project=project["id"])

    def assert_same_place(self, before: dict, after: dict) -> None:
        """Spokój rule 7: the control does not move (a panel scroll bar appearing may shift it sideways only)."""
        self.assertEqual(round(before["y"]), round(after["y"]))
        self.assertLessEqual(abs(before["x"] - after["x"]), 16)

    def goal_menu(self, page: Page, *, tap: bool = False):
        button = page.locator("#details").get_by_role("button", name="Goal actions", exact=True)
        button.tap() if tap else button.click()
        return page.get_by_role("menu", name="Goal actions")

    def test_01_a_project_without_a_goal_shows_nothing_extra(self) -> None:
        """#520 AC-7: no goal line in Details, the phone view menu or the conversation; viewers get no "⋯"."""
        self.ensure_people()
        project_id = self.ids["project"]
        self.assertIsNone(self.project(self.page(), project_id)["goal"])
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                page.goto(f"/projects/{project_id}")
                expect(page.get_by_text("Moisture first.")).to_be_visible()
                expect(page.locator(".convo-goal")).to_have_count(0)
                if phone:
                    menu = phone_menu(page, tap=True)
                    expect(menu.locator(".phone-menu__details")).to_have_text("Details, goal and people")
                    expect(menu.locator(".phone-menu__goal")).to_have_count(0)
                    page.keyboard.press("Escape")
                open_details(page, tap=phone)
                details = page.locator("#details")
                expect(details.get_by_role("heading", name="Community garden sensors")).to_be_visible()
                expect(details.locator(".ov-goal")).to_have_count(0)
                expect(details.get_by_text("Goal", exact=True)).to_have_count(0)
                expect(details.get_by_role("button", name="Goal actions")).to_be_visible()
        viewer = self.page("jonas")
        viewer.goto(f"/projects/{project_id}")
        open_details(viewer)
        expect(viewer.locator("#details").get_by_role("heading", name="Community garden sensors")).to_be_visible()
        expect(viewer.locator("#details").get_by_role("button", name="Goal actions")).to_have_count(0)

    def test_02_a_writer_sets_edits_and_marks_the_goal_reached_from_details(self) -> None:
        """#520 AC-1/AC-8: Set a goal, Edit goal, Mark goal reached with Undo; who and when; the "⋯" never moves."""
        self.ensure_people()
        project_id = self.ids["project"]
        page = self.page()
        page.goto(f"/projects/{project_id}")
        open_details(page)
        details = page.locator("#details")
        actions = details.get_by_role("button", name="Goal actions", exact=True)
        place = actions.bounding_box()
        menu = self.goal_menu(page)
        expect(menu.get_by_role("menuitem")).to_have_text(["Set a goal"])
        menu.get_by_role("menuitem", name="Set a goal").click()
        field = details.get_by_role("textbox", name="New goal")
        expect(field).to_be_focused()
        field.fill("All six beds   report moisture")
        details.get_by_role("button", name="Save goal").click()
        line = details.locator(".ov-goal")
        expect(line).to_have_attribute("data-goal-state", "current")
        expect(line).to_contain_text("Goal")
        expect(line).to_contain_text(GOAL)
        expect(line).to_contain_text("Set by you · Today")
        self.assertEqual(self.project(page, project_id)["goal"]["title"], GOAL)
        self.assert_same_place(place, actions.bounding_box())
        shot(page, "520-details-goal-desktop-light")

        # Edit keeps the goal; Escape leaves the field without saving.
        menu = self.goal_menu(page)
        expect(menu.get_by_role("menuitem")).to_have_text(["Edit goal", "Mark goal reached", "Remove goal"])
        menu.get_by_role("menuitem", name="Edit goal").click()
        field = details.get_by_role("textbox", name="Goal")
        expect(field).to_have_value(GOAL)
        field.fill("Something else entirely")
        field.press("Escape")
        expect(line).to_contain_text(GOAL)
        goal_id = self.project(page, project_id)["goal"]["id"]

        # Mark goal reached: the line says who and when, the stream shows the card, and the toast offers Undo.
        self.goal_menu(page).get_by_role("menuitem", name="Mark goal reached").click()
        expect(line).to_have_attribute("data-goal-state", "reached")
        expect(line).to_contain_text("Goal reached")
        expect(line).to_contain_text("you · Today")
        expect(page.locator(".convo-goal--card").get_by_role("heading", name=GOAL)).to_be_visible()
        toast = page.locator(".ui-toast").filter(has_text="Goal marked reached")
        expect(toast).to_be_visible()
        self.assertEqual(self.project(page, project_id)["goal"]["reachedBy"]["name"], "Ada Kowalska")
        self.assert_same_place(place, actions.bounding_box())
        shot(page, "520-details-goal-reached-desktop-light")
        toast.get_by_role("button", name="Undo").click()
        expect(line).to_have_attribute("data-goal-state", "current")
        expect(page.locator(".convo-goal")).to_have_count(0)
        reopened = self.project(page, project_id)["goal"]
        self.assertEqual((reopened["id"], reopened["reachedAt"]), (goal_id, None), "Undo reopens the same goal")

        # Marked again, then "Undo goal reached" from "⋯" does the same.
        self.goal_menu(page).get_by_role("menuitem", name="Mark goal reached").click()
        expect(line).to_have_attribute("data-goal-state", "reached")
        menu = self.goal_menu(page)
        expect(menu.get_by_role("menuitem")).to_have_text(["Set a new goal", "Undo goal reached"])
        menu.get_by_role("menuitem", name="Undo goal reached").click()
        expect(line).to_have_attribute("data-goal-state", "current")
        self.assertIsNone(self.project(page, project_id)["goal"]["reachedAt"])

    def test_03_a_viewer_reads_the_goal_and_the_phone_menu_shows_it_under_the_name(self) -> None:
        """#520 AC-1/AC-8: the goal is shared; viewers read it without actions; phone-viewsmenu as drawn."""
        self.ensure_people()
        project_id = self.ids["project"]
        project = self.project(self.page(), project_id)
        if not project["goal"] or project["goal"]["reachedAt"]:
            self.call(self.page(), "PUT", f"/api/v1/projects/{project_id}/goal", {"title": GOAL}, status=200, headers={"if-match": f'"{project["version"]}"'})
        for scheme in ("light", "dark"):
            with self.subTest(scheme=scheme):
                page = self.page("jonas", phone=True, scheme=scheme)
                page.goto(f"/projects/{project_id}")
                menu = phone_menu(page, tap=True)
                expect(menu.get_by_role("heading", level=2)).to_contain_text("Community garden sensors")
                expect(menu.locator(".phone-menu__goal")).to_have_text(f"Goal: {GOAL}")
                title = menu.locator(".phone-menu__t").bounding_box()
                goal = menu.locator(".phone-menu__goal").bounding_box()
                self.assertLess(title["y"], goal["y"], "the goal sits under the project name")
                shot(page, f"520-phone-viewsmenu-{scheme}")
                menu.locator(".phone-menu__details").tap()
                details = page.locator("#details")
                expect(details.locator(".ov-goal")).to_contain_text(GOAL)
                expect(details.locator(".ov-goal")).to_contain_text("Set by Ada Kowalska")
                expect(details.get_by_role("button", name="Goal actions")).to_have_count(0)
                if scheme == "dark":
                    shot(page, "520-details-goal-phone-dark")
        # A viewer's attempt through the API is refused.
        version = self.project(self.page("jonas"), project_id)["version"]
        self.call(self.page("jonas"), "POST", f"/api/v1/projects/{project_id}/goal/reached", status=403, headers={"if-match": f'"{version}"'})

    def test_04_removing_the_goal_offers_undo_and_a_reached_goal_lets_the_project_go_on(self) -> None:
        """#520 AC-1/AC-5: Remove goal with Undo; after reaching, a new goal can be set and the old one stays history."""
        self.ensure_people()
        project_id = self.ids["project"]
        page = self.page(phone=True)
        page.goto(f"/projects/{project_id}")
        open_details(page, tap=True)
        details = page.locator("#details")
        line = details.locator(".ov-goal")
        expect(line).to_contain_text(GOAL)
        self.goal_menu(page, tap=True).get_by_role("menuitem", name="Remove goal").tap()
        expect(line).to_have_count(0)
        toast = page.locator(".ui-toast").filter(has_text="Goal removed")
        toast.get_by_role("button", name="Undo").tap()
        expect(line).to_contain_text(GOAL)
        self.goal_menu(page, tap=True).get_by_role("menuitem", name="Mark goal reached").tap()
        expect(line).to_have_attribute("data-goal-state", "reached")
        self.goal_menu(page, tap=True).get_by_role("menuitem", name="Set a new goal").tap()
        details.get_by_role("textbox", name="New goal").fill("Two shared cargo bikes by spring")
        details.get_by_role("button", name="Save goal").tap()
        expect(line).to_have_attribute("data-goal-state", "current")
        expect(line).to_contain_text("Two shared cargo bikes by spring")
        goals = self.call(page, "GET", f"/api/v1/projects/{project_id}/goals", status=200)["items"]
        self.assertEqual([(goal["title"], bool(goal["reachedAt"])) for goal in goals], [("Two shared cargo bikes by spring", False), (GOAL, True)])
        # The reached goal stays in the conversation as one line on this device once its card was seen.
        page.goto(f"/projects/{project_id}")
        entry = page.locator(".convo-goal")
        expect(entry).to_have_count(1)
        if entry.locator(".goal").count():
            entry.get_by_role("button", name="Keep going").tap()
        expect(page.locator(".convo-goal__line")).to_contain_text(f"Goal reached · {GOAL} · you")
        # A viewer sees the same moment on their own device, with Keep going and without Write a wrap-up.
        viewer = self.page("jonas")
        viewer.goto(f"/projects/{project_id}")
        card = viewer.locator(".convo-goal--card")
        expect(card.get_by_role("heading", name=GOAL)).to_be_visible()
        expect(card.get_by_role("button", name="Keep going")).to_be_visible()
        expect(card.get_by_role("button", name="Write a wrap-up")).to_have_count(0)
        card.get_by_role("button", name="Keep going").click()
        expect(viewer.locator(".convo-goal__line")).to_contain_text(f"Goal reached · {GOAL} · Ada Kowalska")


if __name__ == "__main__":
    unittest.main()
