"""Browser regressions for the #763 Part B audit fixes in Home, Inbox, navigation, Projects, Connect and the phone's Search.

Ada owns a project in which her own agent ("Ada's Claude Code") works on a task and asks her questions over a real MCP bearer
(the same OAuth/PKCE client as test_scenarios). Each test names its finding:

- IN-1/IN-2: an agent's question in Home and the Inbox carries Kreska, the Agent tag, its task and the ready answers; an answer
  applies with Undo, reaches the question itself, and the item leaves Home, the Inbox and the Agents view together; a question
  answered elsewhere leaves Needs you too.
- NV-1: Your tasks, the Wiki, New project and a missing page name themselves, and nothing marks Home current there.
- NV-2: the working-agent card stays in the sidebar on Home (Spokój rule 7); only the phone's Home carries its own.
- NV-4/IN-5: at 768 px the Inbox header keeps ⋯ on screen and the filters head the list.
- NV-5/NV-6: the phone's Projects lists DMs in the projects' card with whole dates, and projects with letter tiles.
- AG-1: the Connect page never scrolls sideways at 1440 px.
- SE-2: the phone has one search: the round Search sheet and `/search` share the chips, Cancel and results.

Run in Chromium and WebKit (FLUX_UI_BROWSER). Screenshots (763b-*.png) go to FLUX_UI_SCREENSHOT_DIR when set.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot as save_shot, start_forwarder
from test_scenarios import ACTION_SCOPES, McpAgent

PASSWORD = "a calm home for the garden"
STAMP = int(time.time() * 1000)
PEOPLE = {"ada": ("Ada Kowalska", f"ada.b1+{STAMP}@example.test"), "jonas": ("Jonas Berg", f"jonas.b1+{STAMP}@example.test")}
TABLET = {"width": 768, "height": 1024}
LONG_DM = "See you at the shed on Saturday, and bring the spare probes, the long cable and the little screwdriver set please"


def shot(page: Page, name: str) -> None:
    save_shot(page, f"763b-{name}" if UI_BROWSER == "chromium" else f"763b-{name}-{UI_BROWSER}")


class HomeInboxNav(unittest.TestCase):
    """Tests run in name order on one shared scene; each leaves it as the next expects."""

    pw = None
    browser: Browser
    req: dict[str, BrowserContext] = {}
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    agent: McpAgent | None = None

    # ---------------------------------------------------------------- scene

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        assert cls.browser.browser_type.name == UI_BROWSER
        expect.set_options(timeout=12000)
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            cls.req[key] = context

    @classmethod
    def tearDownClass(cls) -> None:
        if cls.agent:
            cls.agent.close()
        for context in cls.req.values():
            context.close()
        cls.browser.close()
        cls.pw.stop()

    def fetch(self, who: str, method: str, path: str, body: dict | None = None, headers: dict | None = None):
        return self.req[who].request.fetch(f"{ORIGIN}{path}", method=method, data=json.dumps(body) if body is not None else None,
                                           headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})})

    def api(self, who: str, method: str, path: str, body: dict | None = None, status: int | None = None, headers: dict | None = None):
        response = self.fetch(who, method, path, body, headers)
        if status is not None:
            self.assertEqual(response.status, status, f"{who} {method} {path}: {response.text()}")
        text = response.text()
        return json.loads(text) if text and text[:1] in "[{" else {}

    def page(self, who: str = "ada", *, viewport: dict | None = None, phone: bool = False, dark: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "service_workers": "block", "storage_state": self.states[who]}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=viewport or DESKTOP, device_scale_factor=1, **({"has_touch": True} if viewport == TABLET else {}))
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def no_sideways_scroll(self, page: Page) -> None:
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth"), 0, "no horizontal page scroll")

    def ask(self, question: str) -> dict:
        assert self.agent
        return self.agent.tool("flux_ask_question", {
            "projectId": self.ids["project"], "runtimeSessionId": self.agent.runtime, "peerRequestClass": "execute", "grantId": self.ids["reply_grant"],
            "clientCommandId": str(uuid.uuid4()), "sources": [], "conversationId": self.ids["thread"], "question": question,
            "options": ["Per bed", "One value"], "askUserId": self.ids["ada"]})

    def questions(self) -> list[dict]:
        return self.api("ada", "GET", f"/api/v1/projects/{self.ids['project']}/agent-questions", status=200)["questions"]

    def needs_you(self) -> list[dict]:
        return self.api("ada", "GET", "/api/v1/needs-you", status=200)["items"]

    def wait_for_item(self, key: str) -> None:
        for _ in range(80):
            if any(item["key"] == key for item in self.needs_you()):
                return
            time.sleep(0.25)
        self.fail(f"{key} never reached Needs you")

    def test_00_scene(self) -> None:
        ids = type(self).ids
        ws = self.api("ada", "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, status=201)
        self.api("ada", "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE["jonas"][1], "role": "member"}, status=201)
        project = self.api("ada", "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Community garden sensors", "visibility": "workspace"}, status=201)
        self.api("ada", "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Cargo bike co-op", "visibility": "workspace"}, status=201)
        agent = self.api("ada", "POST", f"/api/v1/workspaces/{ws['id']}/agents", {"name": "Ada's Claude Code", "owner": "self"}, status=201)
        self.api("ada", "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "agent", "id": agent["id"]}, "role": "contributor"}, status=201)
        connection = self.api("ada", "POST", "/api/v1/agent-connections", {"agentId": agent["id"], "name": "Desk laptop", "clientDesignation": "claude_code",
                                                                            "selectedProjectIds": [project["id"]], "scopes": ACTION_SCOPES}, status=201)
        ids.update(workspace=ws["id"], project=project["id"], agent=agent["id"], connection=connection["id"])
        # The task the agent works on, and its thread, where the agent asks.
        task = self.api("ada", "POST", f"/api/v1/projects/{project['id']}/work", {"title": "Calibrate the probes at two soil depths"}, status=201)
        ids["task"], ids["task_number"] = task["id"], str(task["number"])
        self.api("ada", "POST", f"/api/v1/work/{task['id']}/discussion", {"body": "Offsets for the probes", "clientMessageId": str(uuid.uuid4())})
        ids["thread"] = self.api("ada", "GET", f"/api/v1/work/{task['id']}/discussion", status=200)["conversationId"]
        type(self).agent = McpAgent(self, "ada", connection["id"], project["id"])
        grant = self.api("ada", "POST", f"/api/v1/agent-connections/{connection['id']}/action-grants", {
            "clientCommandId": str(uuid.uuid4()), "projectId": project["id"], "operation": "conversation.reply", "peerRequestClass": "execute",
            "maximumUses": 10, "expiresAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 3600))}, status=201)
        ids["reply_grant"] = grant["id"]
        # A second task held by the agent: the working-agent card (S13).
        held = self.api("ada", "POST", f"/api/v1/projects/{project['id']}/work",
                        {"title": "Log the soil moisture at dawn", "status": "in_progress", "owner": {"kind": "agent", "id": agent["id"]}}, status=201)
        ids["held_number"] = str(held["number"])
        # A direct message with a long preview (NV-5).
        dm = self.api("ada", "POST", f"/api/v1/workspaces/{ws['id']}/dms", {"participantIds": [self.ids["jonas"]]})
        self.assertIn("id", dm, dm)
        sent = self.fetch("jonas", "POST", f"/api/v1/dms/{dm['id']}/messages", {"body": LONG_DM, "clientMessageId": str(uuid.uuid4())})
        self.assertIn(sent.status, (200, 201), sent.text())

    # ---------------------------------------------------------------- IN-1 / IN-2

    def test_01_question_has_its_answers_and_leaves_everywhere_once_answered(self) -> None:
        asked = self.ask("Offsets per bed, or one value for all six?")
        key = f"question:{asked['questionId']}"
        self.wait_for_item(key)
        number = self.ids["task_number"]

        page = self.page()
        page.goto("/")
        home = page.get_by_role("list", name="Top of your Inbox")
        row = home.locator(f'.nyc[data-key="{key}"]')
        expect(row).to_be_visible()
        expect(row.locator(".nyc__face .kreska")).to_be_visible()
        expect(row.get_by_text("Agent", exact=True)).to_be_visible()
        expect(row).to_contain_text(f"on #{number}")
        expect(row.get_by_role("button", name="Per bed", exact=True)).to_be_visible()
        expect(row.get_by_role("button", name="One value", exact=True)).to_be_visible()
        expect(row.get_by_role("button", name="Reply")).to_have_count(0)
        shot(page, "home-question-1440")

        page.goto("/inbox")
        card = page.get_by_role("list", name="Needs you").locator(f'.nyc[data-key="{key}"]')
        expect(card).to_contain_text("Offsets per bed, or one value for all six?")
        expect(card).to_contain_text(f"on #{number}")
        shot(page, "inbox-question-1440")
        # An answer leaves at once with Undo; Undo within the window sends nothing.
        card.get_by_role("button", name="Per bed", exact=True).click()
        expect(card).to_have_count(0)
        toast = page.locator(".ui-toast").filter(has_text="Answered: Per bed")
        expect(toast).to_be_visible()
        toast.get_by_role("button", name="Undo").click()
        expect(card).to_be_visible()
        self.assertIsNone(next(item for item in self.questions() if item["id"] == asked["questionId"])["answer"], "Undo sent nothing")
        # Answered for real once the window ends: the question itself holds the answer.
        card.get_by_role("button", name="Per bed", exact=True).click()
        expect(card).to_have_count(0)
        for _ in range(60):
            answer = next(item for item in self.questions() if item["id"] == asked["questionId"])["answer"]
            if answer:
                break
            time.sleep(0.25)
        self.assertEqual((answer or {}).get("optionIndex"), 0, "the answer reached the question")
        self.assertNotIn(key, [item["key"] for item in self.needs_you()])
        page.reload()
        expect(page.locator(f'.nyc[data-key="{key}"]')).to_have_count(0)
        page.goto("/")
        expect(page.locator(f'.nyc[data-key="{key}"]')).to_have_count(0)
        # One source of truth with Agents: no open question there either.
        page.goto(f"/projects/{self.ids['project']}/agents")
        expect(page.get_by_text("No open questions for you")).to_be_visible()

    def test_02_question_answered_elsewhere_leaves_needs_you(self) -> None:
        asked = self.ask("Probe depth at 5 cm, or 10 cm?")
        key = f"question:{asked['questionId']}"
        self.wait_for_item(key)
        page = self.page()
        page.goto("/inbox")
        expect(page.locator(f'.nyc[data-key="{key}"]')).to_be_visible()
        # Answered in the conversation's own card (the same endpoint it uses).
        self.api("ada", "POST", f"/api/v1/agent-questions/{asked['questionId']}/answer", {"optionIndex": 1}, status=200)
        page.reload()
        expect(page.get_by_role("list", name="Needs you").or_(page.get_by_role("heading", name="Nothing needs you right now")).first).to_be_visible()
        expect(page.locator(f'.nyc[data-key="{key}"]')).to_have_count(0)
        self.assertEqual([item for item in self.needs_you() if item["kind"] == "question" and (item.get("from") or {}).get("kind") == "agent"], [])

    def test_03_phone_inbox_question_card_has_touch_answers(self) -> None:
        asked = self.ask("Mount the box at 40 cm, or at 60 cm?")
        key = f"question:{asked['questionId']}"
        self.wait_for_item(key)
        for dark in (False, True):
            page = self.page(phone=True, dark=dark)
            page.goto("/inbox")
            card = page.locator(f'.nyc[data-key="{key}"]')
            expect(card).to_be_visible()
            for name in ("Per bed", "One value"):
                box = card.get_by_role("button", name=name, exact=True).bounding_box()
                assert box
                self.assertGreaterEqual(box["height"], 44, name)
                self.assertLessEqual(box["x"] + box["width"], PHONE["width"], name)
            self.no_sideways_scroll(page)
            shot(page, f"inbox-question-390-{'dark' if dark else 'light'}")
            page.goto("/")
            expect(page.locator(f'.nyc[data-key="{key}"]').get_by_role("button", name="Per bed", exact=True)).to_be_visible()
            self.no_sideways_scroll(page)

    # ---------------------------------------------------------------- NV-1

    def test_04_pages_reached_from_home_name_themselves(self) -> None:
        page = self.page()
        places = page.get_by_role("navigation", name="Places")
        for path, title in (("/tasks", "Your tasks"), ("/docs", "Wiki"), ("/projects/new", "New project"), ("/no-such-page", "Page not found")):
            page.goto(path)
            expect(page.locator("header.top").get_by_role("heading", level=1)).to_have_text(title)
            expect(page.locator("header.top")).not_to_contain_text("Your private notes")
            expect(places.get_by_role("link", name="Home")).not_to_have_attribute("aria-current", "page")
        page.goto("/")
        expect(places.get_by_role("link", name="Home")).to_have_attribute("aria-current", "page")
        phone = self.page(phone=True)
        for path, title in (("/tasks", "Your tasks"), ("/docs", "Wiki"), ("/no-such-page", "Page not found")):
            phone.goto(path)
            expect(phone.locator("header.phead").get_by_role("heading", level=1)).to_have_text(title)
            bar = phone.get_by_role("navigation", name="Main places")
            expect(bar.locator('[aria-current="page"]')).to_have_count(0)
        shot(phone, "tasks-390")

    # ---------------------------------------------------------------- NV-2

    def test_05_working_agent_card_stays_in_the_sidebar_on_home(self) -> None:
        page = self.page()
        side = page.locator("aside.app__side")
        page.goto("/inbox")
        card = side.locator(".agentlive--agent")
        expect(card).to_contain_text("Ada's Claude Code")
        elsewhere = card.bounding_box()
        page.goto("/")
        expect(page.get_by_role("heading", level=2, name=re.compile("^Good"))).to_be_visible()
        expect(card).to_be_visible()
        on_home = card.bounding_box()
        assert elsewhere and on_home
        self.assertEqual((round(on_home["x"]), round(on_home["y"])), (round(elsewhere["x"]), round(elsewhere["y"])), "the card does not move on Home")
        expect(page.get_by_role("region", name="Your agents working now")).to_have_count(0)
        expect(page.locator(".agentlive--agent")).to_have_count(1)
        shot(page, "home-agent-sidebar-1440")
        # The phone has no sidebar: its Home carries the card, under Continue as drawn.
        phone = self.page(phone=True)
        phone.goto("/")
        region = phone.get_by_role("region", name="Your agents working now")
        expect(region.get_by_role("button", name="Stop Ada's Claude Code")).to_be_visible()
        self.no_sideways_scroll(phone)

    # ---------------------------------------------------------------- NV-4 / IN-5

    def test_06_inbox_header_fits_at_768(self) -> None:
        page = self.page(viewport=TABLET)
        page.goto("/inbox")
        more = page.locator("header.top").get_by_role("button", name="More")
        expect(more).to_be_visible()
        box = more.bounding_box()
        assert box
        self.assertLessEqual(box["x"] + box["width"], TABLET["width"], "⋯ is on screen")
        filters = page.get_by_role("tablist", name="Show").or_(page.get_by_role("group", name="Show")).first
        expect(filters).to_be_visible()
        self.assertEqual(page.locator("header.top .nyq__filters").count(), 0, "the filters head the list, not the header")
        filters_box = filters.bounding_box()
        assert filters_box
        self.assertLessEqual(filters_box["x"] + filters_box["width"], TABLET["width"])
        self.no_sideways_scroll(page)
        shot(page, "inbox-768")
        # The computer keeps the summary beside the title, as drawn, with no second line repeating it.
        wide = self.page()
        wide.goto("/inbox")
        expect(wide.locator("header.top .nyq__summary")).to_contain_text("need")
        expect(wide.locator("header.top")).not_to_contain_text("What involves you")

    # ---------------------------------------------------------------- NV-5 / NV-6

    def test_07_phone_projects_rows_fit(self) -> None:
        for dark in (False, True):
            page = self.page(phone=True, dark=dark)
            page.goto("/projects")
            projects = page.get_by_role("list", name="Projects")
            expect(projects.get_by_role("link", name=re.compile("Community garden sensors"))).to_be_visible()
            self.assertEqual(projects.locator(".proj-index__tile").first.inner_text().strip(), "C", "a letter tile, not a sparkle")
            dms = page.get_by_role("list", name="Conversations")
            row = dms.get_by_role("link").first
            expect(row).to_contain_text("Jonas Berg")
            card = dms.bounding_box()
            stamp = row.locator("time")
            when = stamp.bounding_box()
            assert card and when
            self.assertGreaterEqual(card["x"], 0)
            self.assertLessEqual(card["x"] + card["width"], PHONE["width"], "the DM card stays inside the screen")
            self.assertLessEqual(when["x"] + when["width"], card["x"] + card["width"], "the date is inside its row")
            self.assertLessEqual(stamp.evaluate("el => el.scrollWidth - el.clientWidth"), 0, "the date is whole")
            self.no_sideways_scroll(page)
            shot(page, f"projects-390-{'dark' if dark else 'light'}")

    # ---------------------------------------------------------------- AG-1

    def test_08_connect_page_does_not_scroll_sideways(self) -> None:
        # Jonas has no connection yet: the New connection form shows at once, with its selects.
        page = self.page("jonas")
        page.goto("/connect-agent")
        expect(page.get_by_role("combobox").first).to_be_visible()
        self.no_sideways_scroll(page)
        field = page.locator("input.ui-select__field").first
        if field.count():
            self.assertLessEqual(field.evaluate("el => el.getBoundingClientRect().width"), 1)
        shot(page, "connect-1440")

    # ---------------------------------------------------------------- SE-2

    def test_09_phone_has_one_search(self) -> None:
        page = self.page(phone=True)
        page.goto("/")
        page.get_by_role("button", name="Search", exact=True).click()
        sheet = page.get_by_role("dialog", name="Jump to")
        chips = sheet.get_by_role("group", name="Search in").get_by_role("button")
        expect(chips.first).to_be_visible()
        sheet_chips = [text.strip() for text in chips.all_inner_texts()]
        page.keyboard.press("Escape")
        page.goto("/search?q=probes")
        expect(page.get_by_role("dialog", name="Jump to")).to_have_count(0)
        group = page.get_by_role("group", name="Search in")
        expect(group.get_by_role("button")).to_have_count(len(sheet_chips))
        self.assertEqual([text.strip() for text in group.get_by_role("button").all_inner_texts()], sheet_chips, "the same chips")
        field = page.get_by_role("combobox", name="Jump to")
        expect(field).to_have_value("probes")
        expect(page.get_by_role("listbox", name="Results").locator("[role=option].sr").first).to_contain_text("probes")
        expect(page.get_by_role("button", name="Cancel")).to_be_visible()
        self.no_sideways_scroll(page)
        shot(page, "search-page-390")
        # A task-number address opens on the Tasks chip, in its project.
        page.goto(f"/search?q=%23{self.ids['task_number']}&type=work&place=project:{self.ids['project']}")
        expect(page.get_by_role("group", name="Search in").get_by_role("button", name="Tasks")).to_have_attribute("aria-pressed", "true")
        expect(page.locator("[role=option].sr").first).to_contain_text("Calibrate the probes")
        # Nothing matches: the drawn calm moment, and Cancel leads back.
        page.goto("/")
        page.goto("/search?q=zzqxv")
        expect(page.get_by_role("heading", name="Nothing matches “zzqxv”")).to_be_visible()
        page.get_by_role("button", name="Cancel").click()
        expect(page).to_have_url(re.compile(r"/$"))


if __name__ == "__main__":
    unittest.main()
