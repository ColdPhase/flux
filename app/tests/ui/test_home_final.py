"""Browser tests for the final Home (#342, F-026 S1, S13, P1, #865).

Home is a date and a greeting, "Waiting for you" (the top three of the Inbox, every decision folded into one row, with
the same count and the way to the whole Inbox) and "Continue where you left off"; every row is a link that ends in an
arrow, and nothing on Home acts. On a phone the rows "My tasks (N)" and "My map" follow the waiting items and a working
agent shows with Stop. There is no spaces card, no footer links, no key hints and no assistant banner. Checked at 1440x900
and 390x844 (touch), light and dark, against the API. Screenshots (home-final-*.png) go to FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import re
import time
import unittest
import urllib.parse
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, box, shot, start_forwarder
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
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        assert cls.browser.browser_type.name == UI_BROWSER
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
        need = page.get_by_role("region", name=re.compile("^Waiting for you"))
        expect(need.get_by_role("heading", name=re.compile(r"^Waiting for you\s*3$"))).to_be_visible()
        rows = need.locator(".home__row")
        expect(rows).to_have_count(3)
        self.assertEqual(self.queue()["count"], 3, "the heading's count is the Inbox's")
        # The decision is one row ("N decisions waiting") with no Accept on Home; the others say what they are.
        expect(rows.nth(0)).to_contain_text("1 decision waiting")
        expect(rows.nth(0)).to_contain_text("Community garden sensors")
        expect(rows.nth(0)).to_contain_text("from Jonas Berg")
        expect(rows.nth(1)).to_contain_text("Question")
        expect(rows.nth(2)).to_contain_text("is blocked")
        expect(need.get_by_role("button")).to_have_count(0)
        link = page.get_by_role("link", name=re.compile("^Open Inbox"))
        expect(link).to_have_attribute("aria-keyshortcuts", "G I")

        # P1: Continue where you left off is one row under its own heading and carries the task in progress.
        cont = page.get_by_role("region", name="Continue where you left off")
        card = cont.get_by_role("link")
        expect(card).to_contain_text("Order six capacitive probes from the shortlist")
        expect(card).to_contain_text("Doing · #1 · Community garden sensors")
        # Every row ends in an arrow.
        for row in rows.all() + [card]:
            expect(row.locator(".home__row-go")).to_be_visible()

        # Home has nothing else (#865): no spaces card, footer links, key hints, assistant banner or workspace Wiki.
        expect(page.get_by_role("region", name="Spaces")).to_have_count(0)
        for gone in (".home__projects", ".home__more", ".home__keys", ".home__meet"):
            expect(page.locator(gone)).to_have_count(0)
        expect(page.locator("#content").get_by_text("All my tasks")).to_have_count(0)
        # Home has no Details: a company's people are in Settings › Company, an encrypted space's people and keys in its own settings (#964).
        expect(page.locator("#content .home").get_by_role("button", name="Details", exact=True)).to_have_count(0)
        expect(page.locator("#content").get_by_role("link", name="Wiki", exact=True)).to_have_count(0)
        # The computer's sidebar carries My tasks and My map; Home's rows for them are the phone's.
        expect(page.locator(".home__places")).to_have_count(0)
        page.mouse.move(1000, 880)
        shot(page, "home-final-desktop-1440")

        # The row opens its task in the detail panel on the space.
        card.click()
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

    def test_03_a_row_opens_the_inbox_on_its_item_and_the_action_is_there(self) -> None:
        page = self.page()
        page.goto("/")
        rows = page.get_by_role("region", name=re.compile("^Waiting for you")).locator(".home__row")
        expect(rows).to_have_count(3)
        # The question's row opens the Inbox with that item selected; accepting happens in the Inbox, with Undo.
        rows.nth(1).click()
        expect(page).to_have_url(re.compile(r"/inbox$"))
        selected = page.locator(".nyc.is-selected")
        expect(selected).to_have_count(1)
        expect(selected).to_contain_text("Question")
        page.go_back()
        rows.nth(0).click()
        expect(page.locator(".nyc.is-selected")).to_contain_text(DECISION)
        page.locator(".nyc.is-selected").get_by_role("button", name=re.compile("^Accept")).click()
        expect(page.get_by_role("status").filter(has_text="Accepted")).to_be_visible()
        page.locator(".ui-toast", has_text="Accepted").get_by_role("button", name="Undo").click()
        expect(page.locator(".nyc")).to_have_count(3)
        status = self.contexts["ada"].request.get(f"/api/v1/decisions/{self.decision['id']}").json()["status"]
        self.assertEqual(status, "proposed", "Undo kept the decision proposed")

    def test_04_nothing_to_do_is_calm(self) -> None:
        for item in self.queue()["items"]:
            response = self.contexts["ada"].request.post(f"/api/v1/needs-you/{urllib.parse.quote(item['key'], safe='')}", data={"action": "done"}, headers={"origin": ORIGIN})
            self.assertEqual(response.status, 200, response.text())
        page = self.page()
        page.goto("/")
        expect(page.get_by_text("Nothing is waiting for you.")).to_be_visible()
        expect(page.get_by_role("heading", name=re.compile(r"^Waiting for you$"))).to_be_visible()
        shot(page, "home-final-desktop-1440-clear")
        # Bring the queue back for the phone.
        for key in (f"decision:{self.decision['id']}",):
            self.contexts["ada"].request.delete(f"/api/v1/needs-you/{urllib.parse.quote(key, safe='')}", headers={"origin": ORIGIN})
        self.post("jonas", f"/api/v1/projects/{self.project_id}/conversations", {"body": "@Ada Kowalska is the gate code still 1234?", "clientMessageId": str(uuid.uuid4())})
        self.wait_for(lambda: {"decision", "question"} <= {item["kind"] for item in self.queue()["items"]}, "things that need her again")

    # ---------------------------------------------------------------- the phone's Home

    def test_05_phone_home_orders_waiting_then_my_tasks_and_my_map_then_continue(self) -> None:
        page = self.page(phone=True)
        page.goto("/")
        expect(page.get_by_role("heading", level=2, name=GREETING)).to_be_visible()
        need = page.get_by_role("region", name=re.compile("^Waiting for you"))
        places = page.get_by_role("list", name="Your places")
        cont = page.get_by_role("region", name="Continue where you left off")
        expect(cont).to_be_visible()
        self.assertLess(box(page, need)["y"], box(page, places)["y"], "the waiting items come first on the phone")
        self.assertLess(box(page, places)["y"], box(page, cont)["y"], "My tasks and My map sit between them and Continue")
        # "My tasks (N)": the two tasks Ada owns; "My map" next to it. Both lead where the sidebar's rows do.
        expect(places.get_by_role("link", name=re.compile(r"^My tasks\s*\(2\)"))).to_be_visible()
        expect(places.get_by_role("link", name="My map")).to_be_visible()
        # "Open Inbox" and every row are touch targets (#393 review).
        self.assertGreaterEqual(box(page, need.get_by_role("link", name=re.compile("^Open Inbox")))["height"], 44)
        for row in page.locator(".home__row").all():
            self.assertGreaterEqual(box(page, row)["height"], 44)
        # The tab bar stays at three tabs; nothing else of the sidebar moved onto Home.
        tabs = page.get_by_role("navigation", name="Main places").get_by_role("link")
        expect(tabs).to_have_count(3)
        expect(page.locator(".home__projects")).to_have_count(0)
        self.assertLessEqual(page.evaluate("document.scrollingElement.scrollWidth"), PHONE["width"], "no sideways scroll")
        shot(page, "home-final-phone-390")
        places.get_by_role("link", name=re.compile(r"^My tasks")).tap()
        expect(page).to_have_url(re.compile(r"/tasks$"))
        page.go_back()
        page.get_by_role("link", name=re.compile("^Open Inbox")).tap()
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
        # #854: the model of a connection (Connect AI's default: the TEST-ONLY fixture key); nothing else to agree to.
        api("POST", "/api/v1/my-agents", {"agentId": agent["id"], **api("GET", "/api/v1/personal-assistant/model")["default"]}, 201)
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
        expect(page.locator(".home__row").first).to_be_visible()
        page.mouse.move(1000, 880)
        shot(page, "home-final-desktop-1440-dark")
        phone = self.page(phone=True, dark=True)
        phone.goto("/")
        expect(phone.get_by_role("heading", level=2, name=GREETING)).to_be_visible()
        shot(phone, "home-final-phone-390-dark")


if __name__ == "__main__":
    unittest.main()
