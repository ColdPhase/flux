"""Review regressions for the final Tasks design (PR #375, issue #346).

Three findings, each with a control that fails on the code it was written against:
1. a phone never sends a desktop continuation (another group's cursor) and keeps its own across Next, reload and back;
2. an Undo, or a late completion, from a finished session does nothing in the next session and shows no private text;
3. a list row keeps the visible Agent tag and the agent's named owner, and a person with the same name stays a person.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, start_forwarder

PASSWORD = "a review keeps the work honest"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": {"name": "Ada Kowalska", "email": f"ada.rev+{STAMP}@example.test"},
    "jonas": {"name": "Jonas Berg", "email": f"jonas.rev+{STAMP}@example.test"},
    "alex": {"name": "Alex", "email": f"alex.rev+{STAMP}@example.test"},
    "outsider": {"name": "Olek Obcy", "email": f"olek.rev+{STAMP}@example.test"},
}
PRIVATE = "Renegotiate the private supplier contract"
BLOCKED_N = 55


class TasksReviewJourney(unittest.TestCase):
    """Tests run in name order and share four accounts, an agent and one project."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    people: dict[str, dict] = PEOPLE

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

    def context(self, who: str, *, phone: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "locale": "en-GB", "storage_state": self.states[who]}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=2, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context

    def page(self, who: str, **kwargs) -> Page:
        page = self.context(who, **kwargs).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None, headers: dict | None = None) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def task(self, page: Page, key: str) -> dict:
        return self.api(page, "GET", f"/api/v1/work/{self.ids[key]}", status=200)

    def row(self, page: Page, title: str):
        return page.locator(".ws-task").filter(has_text=title)

    # ---------------------------------------------------------------- the data

    def test_01_a_project_with_many_blocked_tasks_two_alexes_and_a_private_task(self) -> None:
        for key, person in PEOPLE.items():
            context = self.browser.new_context(base_url=ORIGIN)
            self.addCleanup(context.close)
            page = context.new_page()
            page.goto("/sign-up")
            page.get_by_label("Name").fill(person["name"])
            page.get_by_label("Email").fill(person["email"])
            page.get_by_label("Password").fill(PASSWORD)
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            type(self).states[key] = context.storage_state()
            person["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        ada = self.page("ada")
        ws = self.api(ada, "POST", "/api/v1/workspaces", {"name": "Garden makers"}, status=201)
        for key in ("jonas", "alex"):
            self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE[key]["email"], "role": "member"}, status=201)
        project = self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Review project", "visibility": "restricted"}, status=201)
        pid = project["id"]
        for key in ("jonas", "alex"):
            self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": PEOPLE[key]["id"]}, "role": "contributor"}, status=201)
        agent = self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/agents", {"name": "Alex", "owner": "self"}, status=201)
        self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "agent", "id": agent["id"]}, "role": "contributor"}, status=201)
        base = f"/api/v1/projects/{pid}/work"
        me = lambda key: {"kind": "human", "id": PEOPLE[key]["id"]}  # noqa: E731
        many = self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Many chores", "visibility": "restricted"}, status=201)
        for index in range(BLOCKED_N):
            self.api(ada, "POST", f"/api/v1/projects/{many['id']}/work", {"title": f"Blocked chore {index + 1:03d}", "status": "blocked", "blocker": "the next measurement", "owner": me("ada")}, status=201)
        made = {
            "agent_open": self.api(ada, "POST", base, {"title": "Agent open job", "owner": {"kind": "agent", "id": agent["id"]}}, status=201),
            "agent_doing": self.api(ada, "POST", base, {"title": "Agent running job", "status": "in_progress", "owner": {"kind": "agent", "id": agent["id"]}}, status=201),
            "agent_blocked": self.api(ada, "POST", base, {"title": "Agent stuck job", "status": "blocked", "blocker": "a licence key", "owner": {"kind": "agent", "id": agent["id"]}}, status=201),
            "person_alex": self.api(ada, "POST", base, {"title": "Alex the person's job", "owner": me("alex")}, status=201),
            "private": self.api(ada, "POST", base, {"title": PRIVATE, "owner": me("ada")}, status=201),
        }
        type(self).ids = {"project": pid, "many": many["id"], **{key: item["id"] for key, item in made.items()}}
        type(self).people = {**PEOPLE, "numbers": {key: item["number"] for key, item in made.items()}}

    # ---------------------------------------------------------------- 1. phone pagination

    def test_02_a_desktop_continuation_opened_on_a_phone_is_not_sent_to_another_group(self) -> None:
        desktop = self.page("ada")
        desktop.goto(f"/projects/{self.ids['many']}/tasks?status=blocked")
        expect(desktop.locator(".ws-task").first).to_be_visible()
        desktop.get_by_role("navigation", name="Work pages").get_by_role("button", name="Next").click()
        expect(desktop).to_have_url(re.compile("cursor="))
        link = desktop.url
        self.assertIn("status=blocked", link)
        phone = self.page("ada", phone=True)
        statuses: list[int] = []
        phone.on("response", lambda response: statuses.append(response.status) if "/work-view" in response.url else None)
        phone.goto(link)
        expect(phone.locator(".ws-task").first).to_be_visible()
        expect(phone.get_by_text("Work could not be loaded")).to_have_count(0)
        self.assertTrue(statuses and all(status == 200 for status in statuses), f"every phone read succeeded: {statuses}")
        # Resizing a desktop page in the same state behaves the same way.
        resize = self.page("ada")
        resize.goto(link)
        expect(resize.locator(".ws-task").first).to_be_visible()
        resize.set_viewport_size(PHONE)
        expect(resize.locator(".ws-task").first).to_be_visible()
        expect(resize.get_by_text("Work could not be loaded")).to_have_count(0)

    def test_03_a_phone_keeps_its_own_continuation_through_next_reload_and_back(self) -> None:
        page = self.page("ada", phone=True)
        page.goto(f"/projects/{self.ids['many']}/tasks")
        range_ = page.get_by_role("navigation", name="Work pages").locator(".ws-pages__range")
        expect(range_).to_contain_text("1–50 of")
        page.get_by_role("navigation", name="Work pages").get_by_role("button", name="Next").click()
        expect(range_).to_contain_text("51–")
        self.assertIn("cursor=", page.url, "the phone's page is in its address")
        page.reload()
        expect(page.get_by_role("navigation", name="Work pages").locator(".ws-pages__range")).to_contain_text("51–")
        # Leaving for another tab and coming back with the browser's Back returns to the same page of the list.
        page.get_by_role("link", name="Conversation").first.click()
        expect(page).not_to_have_url(re.compile("/tasks"))
        page.go_back()
        expect(page.get_by_role("navigation", name="Work pages").locator(".ws-pages__range")).to_contain_text("51–")

    # ---------------------------------------------------------------- 2. Undo does not outlive its session

    def swap_session(self, page: Page, who: str) -> None:
        page.context.clear_cookies()
        page.context.add_cookies(self.states[who]["cookies"])

    def test_04_undo_from_a_finished_session_does_nothing_in_the_next_one(self) -> None:
        for who in ("jonas", "outsider"):
            with self.subTest(next_session=who):
                page = self.page("ada")
                self.api(page, "PATCH", f"/api/v1/work/{self.ids['private']}", {"status": "open", "clientCommandId": str(uuid.uuid4())},
                         headers={"if-match": f'"{self.task(page, "private")["version"]}"'})
                page.goto(f"/projects/{self.ids['project']}/tasks")
                page.get_by_role("radio", name="List", exact=True).click()
                self.row(page, PRIVATE).locator(".ws-item").focus()
                page.keyboard.press("4")
                toast = page.locator(".ui-toast")
                expect(toast).to_contain_text("done")
                changed = self.task(page, "private")
                self.assertEqual(changed["status"], "done")
                patches: list[str] = []
                page.on("request", lambda request: patches.append(request.url) if request.method == "PATCH" else None)
                self.swap_session(page, who)
                toast.get_by_role("button", name="Undo").click()
                page.wait_for_timeout(1200)
                page.keyboard.press("z")
                page.wait_for_timeout(600)
                self.assertEqual(patches, [], "the stale Undo sends nothing as the next person")
                self.assertNotIn(PRIVATE, page.locator(".ui-toasts").inner_text(), "no private title in a toast")
                self.swap_session(page, "ada")
                self.assertEqual(self.task(page, "private")["version"], changed["version"], "nothing was stored by the stale Undo")

    def test_05_a_late_response_from_a_finished_session_shows_nothing_in_the_next_one(self) -> None:
        page = self.page("ada")
        self.api(page, "PATCH", f"/api/v1/work/{self.ids['private']}", {"status": "open", "clientCommandId": str(uuid.uuid4())},
                 headers={"if-match": f'"{self.task(page, "private")["version"]}"'})
        page.goto(f"/projects/{self.ids['project']}/tasks")
        page.get_by_role("radio", name="List", exact=True).click()
        held: list = []
        def hold(route):
            if route.request.method == "PATCH":
                held.append((route, route.fetch()))
            else:
                route.continue_()
        page.route("**/api/v1/work/*", hold)
        self.row(page, PRIVATE).locator(".ws-item").focus()
        page.keyboard.press("4")
        deadline = time.time() + 8
        while not held and time.time() < deadline:
            page.wait_for_timeout(100)
        self.assertTrue(held, "the change reached the server and its response is held")
        self.swap_session(page, "outsider")
        route, response = held[0]
        route.fulfill(response=response)
        page.wait_for_timeout(1200)
        self.assertEqual(page.locator(".ui-toast").count(), 0, "no completion toast in the next session")
        self.assertNotIn(PRIVATE, page.locator(".ui-toasts").inner_text())
        page.unroute_all(behavior="ignoreErrors")

    # ---------------------------------------------------------------- 3. agents stay agents in rows

    def check_identity(self, page: Page, label: str) -> None:
        for key, title in (("agent_open", "Agent open job"), ("agent_doing", "Agent running job"), ("agent_blocked", "Agent stuck job")):
            row = self.row(page, title)
            expect(row, label).to_be_visible()
            meta = row.locator(".ws-item__s")
            expect(meta.locator(".agent-tag"), f"{label}: {title} shows the Agent tag").to_have_count(1)
            expect(meta, f"{label}: {title} names the owner").to_contain_text("for Ada Kowalska")
            expect(meta, f"{label}: {title} names the agent").to_contain_text("Alex")
        expect(self.row(page, "Alex the person's job").locator(".agent-tag")).to_have_count(0)
        expect(self.row(page, "Alex the person's job").locator(".ws-item__s")).to_contain_text("Alex")
        expect(self.row(page, "Agent stuck job").locator(".ui-pill--inv")).to_have_text("Blocked")

    def test_06_agent_rows_keep_the_agent_tag_the_name_and_the_owner(self) -> None:
        desktop = self.page("ada")
        desktop.goto(f"/projects/{self.ids['project']}/tasks")
        desktop.get_by_role("radio", name="List", exact=True).click()
        self.check_identity(desktop, "desktop")
        phone = self.page("ada", phone=True)
        phone.goto(f"/projects/{self.ids['project']}/tasks")
        self.check_identity(phone, "phone")
        # Reassigning to the person of the same name removes the tag: it was the agent's, not the name's.
        current = self.task(desktop, "agent_blocked")
        self.api(desktop, "PATCH", f"/api/v1/work/{self.ids['agent_blocked']}", {"owner": {"kind": "human", "id": PEOPLE["alex"]["id"]}, "clientCommandId": str(uuid.uuid4())},
                 status=200, headers={"if-match": f'"{current["version"]}"'})
        desktop.reload()
        desktop.get_by_role("radio", name="List", exact=True).click()
        expect(self.row(desktop, "Agent stuck job").locator(".agent-tag")).to_have_count(0)
        expect(self.row(desktop, "Agent stuck job").locator(".ws-item__s")).to_contain_text("Alex")


if __name__ == "__main__":
    unittest.main()
