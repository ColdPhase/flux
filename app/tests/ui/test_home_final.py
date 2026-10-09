"""Browser tests for the final Home (#342, F-026 S1, S13, P1).

Home is a date and a greeting, the top three that need you with the way to the whole Inbox, a
"Continue where you left off" card (the whole card is a link with a round arrow), the projects with
what is new, and a row of key hints; on a phone it also shows a working agent with Stop. Its private
notes moved to the Sketchbook as "Your notes" (see test_home_notes). Checked at 1440x900 and
390x844 (touch), light and dark, against the API. Screenshots (home-final-*.png) go to
FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import re
import time
import unittest
import urllib.parse
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, box, shot, start_forwarder
from test_personal_assistant import mock

PASSWORD = "a calm home for the garden"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.h+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.h+{STAMP}@example.test"),
}
DECISION = "Measure soil moisture first; frost warnings later"
GREETING = re.compile(r"^Good (morning|afternoon|evening), Ada$")


class HomeFinal(unittest.TestCase):
    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    contexts: dict[str, BrowserContext] = {}
    workspace_id = ""
    project_id = ""
    working: dict = {}
    decision: dict = {}

    @classmethod
    def post(cls, who: str, path: str, body: dict | None = None) -> dict:
        response = cls.contexts[who].request.post(path, data=body or {}, headers={"origin": ORIGIN})
        assert response.status in (200, 201, 202), f"{path}: {response.status} {response.text()}"
        return response.json()

    @classmethod
    def queue(cls) -> dict:
        return cls.contexts["ada"].request.get("/api/v1/needs-you").json()

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=15000)
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.contexts[key] = context
        cls.workspace_id = cls.post("ada", "/api/v1/workspaces", {"name": "Riverside Makers"})["id"]
        cls.post("ada", f"/api/v1/workspaces/{cls.workspace_id}/members", {"email": PEOPLE["jonas"][1], "role": "member"})
        cls.project_id = cls.post("ada", f"/api/v1/workspaces/{cls.workspace_id}/projects", {"name": "Community garden sensors", "visibility": "workspace"})["id"]
        cls.post("ada", f"/api/v1/workspaces/{cls.workspace_id}/projects", {"name": "Cargo bike co-op", "visibility": "workspace"})
        cls.working = cls.post("ada", f"/api/v1/projects/{cls.project_id}/work", {
            "title": "Order six capacitive probes from the shortlist", "owner": {"kind": "human", "id": cls.ids["ada"]}, "status": "in_progress"})
        cls.post("ada", f"/api/v1/projects/{cls.project_id}/work", {
            "title": "Design a weatherproof enclosure", "owner": {"kind": "human", "id": cls.ids["ada"]}, "status": "blocked", "blocker": "waiting for sizes"})
        cls.decision = cls.post("jonas", f"/api/v1/projects/{cls.project_id}/decisions", {"title": DECISION, "rationale": "Overwatering is the problem now."})
        cls.post("jonas", f"/api/v1/projects/{cls.project_id}/conversations", {"body": "@Ada Kowalska can you check the shed roof?", "clientMessageId": str(uuid.uuid4())})
        for key, context in cls.contexts.items():
            cls.states[key] = context.storage_state()
        for _ in range(80):
            if len(cls.queue()["items"]) >= 3:
                break
            time.sleep(0.25)

    @classmethod
    def tearDownClass(cls) -> None:
        for context in cls.contexts.values():
            context.close()
        cls.browser.close()
        cls.pw.stop()

    def page(self, *, phone: bool = False, dark: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states["ada"]}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def wait_for(self, check, what: str, seconds: float = 20):
        end = time.time() + seconds
        while time.time() < end:
            value = check()
            if value:
                return value
            time.sleep(0.25)
        raise AssertionError(f"timed out waiting for {what}")

    # ---------------------------------------------------------------- the computer's Home

    def test_01_home_shows_the_top_three_and_where_to_continue(self) -> None:
        page = self.page()
        page.goto("/")
        expect(page.get_by_role("heading", level=2, name=GREETING)).to_be_visible()
        expect(page.locator(".home__date")).to_have_text(re.compile(r"^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),? "))
        need = page.get_by_role("region", name=re.compile("^Needs you"))
        expect(need.get_by_role("heading", name=re.compile(r"^Needs you\s*3$"))).to_be_visible()
        rows = need.locator(".nyc")
        expect(rows).to_have_count(3)
        self.assertEqual(self.queue()["count"], 3)
        expect(rows.nth(0)).to_contain_text("Decision")
        expect(rows.nth(0)).to_contain_text(DECISION)
        expect(rows.nth(0).get_by_role("button", name=re.compile("^Accept"))).to_be_visible()
        expect(rows.nth(0).get_by_role("button", name="Not now")).to_be_visible()
        expect(rows.nth(1)).to_contain_text("Question")
        expect(rows.nth(2)).to_contain_text("is blocked")
        link = page.get_by_role("link", name=re.compile("^Open Inbox"))
        expect(link).to_have_attribute("aria-keyshortcuts", "G I")

        # P1: the whole card is the link, with a round arrow; it continues the task in progress.
        card = page.get_by_role("link", name=re.compile("^Continue where you left off"))
        expect(card).to_contain_text("Order six capacitive probes from the shortlist")
        expect(card).to_contain_text("In progress · #1 · Community garden sensors")
        arrow = card.locator(".home__go")
        expect(arrow).to_be_visible()
        arrow_box = box(page, arrow)
        self.assertEqual(round(arrow_box["width"]), round(arrow_box["height"]))
        self.assertEqual(card.evaluate("element => getComputedStyle(element.querySelector('.home__go')).borderRadius"), "50%")

        # Projects, with what is new, and the key hints.
        projects = page.get_by_role("region", name="Projects")
        expect(projects.get_by_role("link", name=re.compile("^Community garden sensors"))).to_be_visible()
        expect(projects.get_by_role("link", name=re.compile("^Cargo bike co-op"))).to_contain_text("quiet")
        hints = page.locator(".home__keys")
        for text in ("new", "search or run", "Inbox", "hide sidebar"):
            expect(hints).to_contain_text(text)
        page.mouse.move(1000, 880)
        shot(page, "home-final-desktop-1440")

        # The card opens its task in the detail panel on the project.
        arrow_point = {"x": 24, "y": 24}
        card.click(position=arrow_point)
        expect(page).to_have_url(re.compile(rf"/projects/{self.project_id}/tasks"))
        expect(page.locator("#details")).to_contain_text("Order six capacitive probes from the shortlist")

    def test_02_g_then_i_and_open_inbox_lead_to_the_whole_queue(self) -> None:
        page = self.page()
        page.goto("/")
        expect(page.get_by_role("heading", level=2, name=GREETING)).to_be_visible()
        page.keyboard.press("g")
        page.keyboard.press("i")
        expect(page).to_have_url(re.compile(r"/inbox$"))
        expect(page.locator(".nyc")).to_have_count(3)
        page.go_back()
        page.get_by_role("link", name=re.compile("^Open Inbox")).click()
        expect(page).to_have_url(re.compile(r"/inbox$"))

    def test_03_accept_and_not_now_work_from_home_with_undo(self) -> None:
        page = self.page()
        page.goto("/")
        rows = page.get_by_role("region", name=re.compile("^Needs you")).locator(".nyc")
        expect(rows).to_have_count(3)
        rows.nth(0).get_by_role("button", name="Not now").click()
        menu = page.get_by_role("menu", name="Ask me again")
        expect(menu).to_be_visible()
        menu.get_by_role("menuitem", name=re.compile("^Next week")).click()
        expect(page.get_by_role("status").filter(has_text="Back next week")).to_be_visible()
        expect(page.get_by_role("heading", name=re.compile(r"^Needs you\s*2$"))).to_be_visible()
        page.keyboard.press("z")
        expect(page.get_by_role("heading", name=re.compile(r"^Needs you\s*3$"))).to_be_visible()
        rows.nth(0).get_by_role("button", name=re.compile("^Accept")).click()
        expect(page.get_by_role("status").filter(has_text="Accepted")).to_be_visible()
        page.locator(".ui-toast", has_text="Accepted").get_by_role("button", name="Undo").click()
        expect(rows).to_have_count(3)
        status = self.contexts["ada"].request.get(f"/api/v1/decisions/{self.decision['id']}").json()["status"]
        self.assertEqual(status, "proposed", "Undo kept the decision proposed")

    def test_04_nothing_to_do_is_calm(self) -> None:
        for item in self.queue()["items"]:
            response = self.contexts["ada"].request.post(f"/api/v1/needs-you/{urllib.parse.quote(item['key'], safe='')}", data={"action": "done"}, headers={"origin": ORIGIN})
            self.assertEqual(response.status, 200, response.text())
        page = self.page()
        page.goto("/")
        expect(page.get_by_text("Nothing needs you right now. Enjoy the quiet.")).to_be_visible()
        expect(page.get_by_role("heading", name=re.compile(r"^Needs you$"))).to_be_visible()
        shot(page, "home-final-desktop-1440-clear")
        # Bring the queue back for the phone.
        for key in (f"decision:{self.decision['id']}",):
            self.contexts["ada"].request.delete(f"/api/v1/needs-you/{urllib.parse.quote(key, safe='')}", headers={"origin": ORIGIN})
        self.post("jonas", f"/api/v1/projects/{self.project_id}/conversations", {"body": "@Ada Kowalska is the gate code still 1234?", "clientMessageId": str(uuid.uuid4())})
        self.wait_for(lambda: {"decision", "question"} <= {item["kind"] for item in self.queue()["items"]}, "things that need her again")

    # ---------------------------------------------------------------- the phone's Home

    def test_05_phone_home_orders_continue_then_what_needs_you(self) -> None:
        page = self.page(phone=True)
        page.goto("/")
        expect(page.get_by_role("heading", level=2, name=GREETING)).to_be_visible()
        card = page.get_by_role("link", name=re.compile("^Continue where you left off"))
        need = page.get_by_role("region", name=re.compile("^Needs you"))
        expect(card).to_be_visible()
        self.assertLess(box(page, card)["y"], box(page, need)["y"], "Continue comes first on the phone")
        self.assertGreaterEqual(box(page, card.locator(".home__go"))["width"], 44)
        expect(need.get_by_role("link", name=re.compile("^See all"))).to_be_visible()
        row = need.locator(".nyc").first
        for name in (re.compile("^Accept"), "Not now"):
            self.assertGreaterEqual(box(page, row.get_by_role("button", name=name))["height"], 44)
        self.assertLessEqual(page.evaluate("document.scrollingElement.scrollWidth"), PHONE["width"], "no sideways scroll")
        expect(page.locator(".home__keys")).to_be_hidden()
        shot(page, "home-final-phone-390")
        page.get_by_role("link", name=re.compile("^See all")).tap()
        expect(page).to_have_url(re.compile(r"/inbox$"))

    def test_06_phone_home_shows_a_working_agent_with_stop(self) -> None:
        context = self.browser.new_context(base_url=ORIGIN, viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True, service_workers="block")
        self.addCleanup(context.close)
        page = context.new_page()
        email = f"ada.run+{uuid.uuid4().hex}@example.test"

        def api(method: str, path: str, body: dict | None = None, status: int = 200):
            response = page.request.fetch(path, method=method, headers={"origin": ORIGIN}, data=body)
            self.assertEqual(response.status, status, f"{path}: {response.status} {response.text()}")
            return response.json() if response.text() else None

        api("POST", "/api/auth/sign-up/email", {"name": "Ada Kowalska", "email": email, "password": PASSWORD})
        workspace = api("POST", "/api/v1/workspaces", {"name": "Riverside garden"}, 201)
        project = api("POST", f"/api/v1/workspaces/{workspace['id']}/projects", {"name": "Garden sensor trial", "visibility": "restricted"}, 201)
        agent = api("POST", f"/api/v1/workspaces/{workspace['id']}/agents", {"name": "Garden analyst", "owner": "self"}, 201)
        api("POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "agent", "id": agent["id"]}, "role": "viewer"}, 201)
        api("POST", "/api/v1/personal-assistant", {"consentVersion": "o-008-2026-10-02", "agentId": agent["id"], "perRunCents": 6, "dailyCapCents": 100, "timeZone": "Europe/Warsaw"}, 201)
        conversation = api("POST", f"/api/v1/projects/{project['id']}/conversations", {"body": "Which soil sensor should we test in the east bed?", "clientMessageId": str(uuid.uuid4())}, 201)
        mock("/__script", {"reset": True, "delay": 15})
        run = api("POST", f"/api/v1/conversations/{conversation['id']}/assistant-runs", {"clientRunId": str(uuid.uuid4()), "kind": "ask", "prompt": "Compare the readings."}, 202)
        page.goto("/")
        working = page.locator(".home .agentlive")
        expect(working).to_be_visible()
        expect(working).to_contain_text("Your assistant")
        stop = working.get_by_role("button", name="Stop your assistant")
        self.assertGreaterEqual(box(page, stop)["height"], 44)
        shot(page, "home-final-phone-390-working")
        stop.tap()
        end = time.time() + 20
        while time.time() < end:
            if api("GET", f"/api/v1/assistant-runs/{run['id']}")["status"] == "stopped":
                break
            time.sleep(0.25)
        self.assertEqual(api("GET", f"/api/v1/assistant-runs/{run['id']}")["status"], "stopped")
        expect(page.locator(".agentlive")).to_have_count(0)

    def test_07_dark_home(self) -> None:
        page = self.page(dark=True)
        page.goto("/")
        expect(page.get_by_role("heading", level=2, name=GREETING)).to_be_visible()
        expect(page.locator(".nyc").first).to_be_visible()
        page.mouse.move(1000, 880)
        shot(page, "home-final-desktop-1440-dark")
        phone = self.page(phone=True, dark=True)
        phone.goto("/")
        expect(phone.get_by_role("heading", level=2, name=GREETING)).to_be_visible()
        shot(phone, "home-final-phone-390-dark")


if __name__ == "__main__":
    unittest.main()
