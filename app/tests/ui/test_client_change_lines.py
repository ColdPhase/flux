"""Browser checks of #868 (mcp-cowork LC-2): a local client's task, Wiki page and map changes show their change line and Undo on
the task, page or map they are about, as the assistant's changes do.

Ada's own client (Claude Code, a real OAuth bearer over MCP, as in test_scenarios) changes a task, a page and a map in a space she
shares with Jonas. Each page, at 1440 px and at 390 px, then shows:

- the change line ("Moved #4 to Doing") with "Ada · via Claude Code" and Undo, arriving live while the page is open;
- Undo putting the earlier state back (read from the API) and the line reading "Undone by Ada", struck through;
- "Changed since" after someone else wrote on the same field: nothing is put back, and the note has no "Open it" (Ada is there);
- the same line for Jonas, who reads the space.

Run in Chromium and WebKit (FLUX_UI_BROWSER). Screenshots (868-*.png) go to FLUX_UI_SCREENSHOT_DIR when set.
"""

from __future__ import annotations

import json
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot as save_shot, start_forwarder
from test_scenarios import McpAgent

PASSWORD = "a calm home for the garden"
STAMP = int(time.time() * 1000)
PEOPLE = {"ada": ("Ada Kowalska", f"ada.cl+{STAMP}@example.test"), "jonas": ("Jonas Berg", f"jonas.cl+{STAMP}@example.test"),
          "gus": ("Gus Lindqvist", f"gus.cl+{STAMP}@example.test")}


def shot(page: Page, name: str) -> None:
    save_shot(page, f"868-{name}" if UI_BROWSER == "chromium" else f"868-{name}-{UI_BROWSER}")


class ClientChangeLines(unittest.TestCase):
    """Tests run in name order on one shared scene; each uses its own task, page and map."""

    pw = None
    browser: Browser
    req: dict[str, BrowserContext] = {}
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    agent: McpAgent | None = None

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

    # ---------------------------------------------------------------- helpers

    def fetch(self, who: str, method: str, path: str, body: dict | None = None):
        return self.req[who].request.fetch(f"{ORIGIN}{path}", method=method, data=json.dumps(body) if body is not None else None,
                                           headers={"origin": ORIGIN, "content-type": "application/json"})

    def api(self, who: str, method: str, path: str, body: dict | None = None, status: int | None = None, headers: dict | None = None):
        response = self.req[who].request.fetch(f"{ORIGIN}{path}", method=method, data=json.dumps(body) if body is not None else None,
                                               headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})})
        if status is not None:
            self.assertEqual(response.status, status, f"{who} {method} {path}: {response.text()}")
        text = response.text()
        return json.loads(text) if text and text[:1] in "[{" else {}

    def page(self, who: str = "ada", *, phone: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "service_workers": "block", "storage_state": self.states[who]}
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

    def no_sideways_scroll(self, page: Page) -> None:
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth"), 0, "no horizontal page scroll")

    def command(self, **arguments) -> dict:
        return {"projectId": self.ids["project"], "clientCommandId": str(uuid.uuid4()), "sources": [], **arguments}

    def task(self, title: str) -> dict:
        return self.api("ada", "POST", f"/api/v1/projects/{self.ids['project']}/work", {"title": title}, status=201)

    def read_task(self, task_id: str) -> dict:
        return self.api("ada", "GET", f"/api/v1/work/{task_id}", status=200)

    def read_doc(self, doc_id: str) -> dict:
        return self.api("ada", "GET", f"/api/v1/docs/{doc_id}", status=200)

    def line(self, page: Page, kind: str):
        return page.locator(f".client-changes[data-client-changes='{kind}'] .assistant-message").first

    def test_00_scene(self) -> None:
        ids = type(self).ids
        ws = self.api("ada", "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, status=201)
        self.api("ada", "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE["jonas"][1], "role": "member"}, status=201)
        # A guest of the company who can read the space (LC-2: everyone who can read the object sees the line, #1116).
        self.api("ada", "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE["gus"][1], "role": "guest"}, status=201)
        project = self.api("ada", "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Community garden sensors", "visibility": "workspace"}, status=201)
        # A guest sees only the spaces they were added to.
        self.api("ada", "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "human", "id": ids["gus"]}, "role": "contributor"}, status=201)
        # Ada's own client signs in with one click on the consent page (#859), which makes its agent and connection.
        type(self).agent = McpAgent(self, "ada", project["id"])
        ids.update(workspace=ws["id"], project=project["id"])

    # ---------------------------------------------------------------- a task

    def check_task(self, phone: bool) -> None:
        label = "390" if phone else "1440"
        task = self.task(f"Calibrate the probes at two soil depths ({label})")
        number = task["number"]
        page = self.page(phone=phone)
        page.goto(f"/projects/{self.ids['project']}/tasks?open=work:{task['id']}")
        panel = page.locator("#details")
        expect(panel.get_by_role("list", name="Task activity")).to_be_visible()
        expect(panel.locator(".client-changes")).to_have_count(0)

        # The client changes the task while the panel is open: the line arrives by itself, with its label and Undo.
        self.agent.tool("flux_update_task", self.command(workId=task["id"], expectedVersion=task["version"], changes={"status": "in_progress"}))
        line = panel.locator(".client-changes[data-client-changes='work'] .assistant-message")
        expect(line).to_have_count(1)
        expect(line).to_contain_text(f"Moved #{number} to Doing")
        expect(line).to_contain_text("Ada · via Claude Code")
        undo = line.get_by_role("button", name="Undo", exact=True)
        expect(undo).to_be_visible()
        line.scroll_into_view_if_needed()
        self.no_sideways_scroll(page)
        shot(page, f"task-line-{label}")
        # The change is said once: by its line with Undo. The timeline below does not name it again as "Claude Code [Agent] for Ada" (#1116).
        expect(panel.locator(".wd-act")).not_to_contain_text("Claude Code")

        # Jonas, who reads the space, sees the same line.
        jonas = self.page("jonas", phone=phone)
        jonas.goto(f"/projects/{self.ids['project']}/tasks?open=work:{task['id']}")
        expect(jonas.locator("#details .client-changes .assistant-message")).to_contain_text(f"Moved #{number} to Doing")

        # Undo puts the status back, and the line reads "Undone by Ada".
        undo.click()
        expect(line.locator("s")).to_contain_text(f"Moved #{number} to Doing")
        expect(line).to_contain_text("Undone by Ada")
        expect(line).not_to_contain_text("Ada Kowalska")  # the first name, as the guide says (#1116)
        expect(line.get_by_role("button", name="Undo", exact=True)).to_have_count(0)
        self.assertEqual(self.read_task(task["id"])["status"], "open")
        shot(page, f"task-undone-{label}")

        # Changed since: the client moves it again, then a person closes it; Undo changes nothing and says so, with no "Open it".
        current = self.read_task(task["id"])
        self.agent.tool("flux_update_task", self.command(workId=task["id"], expectedVersion=current["version"], changes={"status": "in_progress"}))
        newest = panel.locator(".client-changes[data-client-changes='work'] .assistant-message").first
        expect(newest).to_contain_text("Moved #")
        expect(newest.get_by_role("button", name="Undo", exact=True)).to_be_visible()
        current = self.read_task(task["id"])
        self.api("ada", "PATCH", f"/api/v1/work/{task['id']}", {"status": "done"}, status=200, headers={"if-match": f'"{current["version"]}"'})
        newest.get_by_role("button", name="Undo", exact=True).click()
        note = newest.locator(".assistant-message__note")
        expect(note).to_contain_text("Changed since")
        expect(note).not_to_contain_text("Open it")
        self.assertEqual(self.read_task(task["id"])["status"], "done", "nothing was put back")
        shot(page, f"task-changed-since-{label}")

    def test_01_task_1440(self) -> None:
        self.check_task(False)

    def test_02_task_390(self) -> None:
        self.check_task(True)

    def test_07_a_guest_who_can_read_the_space_sees_the_line_as_everyone_does(self) -> None:
        # #1116: the server lists a local client's changes for everyone who can read the object, a guest of the company included (LC-2), and the
        # page hid them from guests. A guest has no AI of their own; what was done to the page they read is on it.
        task = self.task("Calibrate the probes for the guest to read")
        self.agent.tool("flux_update_task", self.command(workId=task["id"], expectedVersion=task["version"], changes={"status": "in_progress"}))
        self.assertEqual(self.api("gus", "GET", f"/api/v1/workspaces/{self.ids['workspace']}", status=200)["role"], "guest", "the person is a guest of the company")
        guest = self.page("gus")
        guest.goto(f"/projects/{self.ids['project']}/tasks?open=work:{task['id']}")
        line = guest.locator("#details .client-changes[data-client-changes='work'] .assistant-message")
        expect(line).to_contain_text(f"Moved #{task['number']} to Doing")
        expect(line).to_contain_text("Ada · via Claude Code")
        # The timeline does not name the same change a second time, under another name (#1116).
        expect(guest.locator("#details .wd-act")).not_to_contain_text("Claude Code")

    # ---------------------------------------------------------------- a Wiki page

    def check_doc(self, phone: bool) -> None:
        label = "390" if phone else "1440"
        first = "Probes sit at 10 cm and 30 cm."
        title = f"Calibration notes ({label})"
        doc = self.api("ada", "POST", f"/api/v1/projects/{self.ids['project']}/docs", {"title": title, "body": first}, status=201)
        doc_id = doc["id"]
        page = self.page(phone=phone)
        page.goto(f"/projects/{self.ids['project']}/docs/{doc_id}")
        expect(page.locator(".wiki-page")).to_be_visible()
        expect(page.locator(".client-changes")).to_have_count(0)

        self.agent.tool("flux_update_doc", self.command(docId=doc_id, expectedVersion=self.read_doc(doc_id)["version"],
                                                       changes={"body": f"{first} Offsets are 0.4 and 0.7.", "reason": "The client adds the offsets"}))
        line = self.line(page, "doc")
        expect(line).to_contain_text(f"Updated the Wiki page {title}")
        expect(line).to_contain_text("Ada · via Claude Code")
        self.no_sideways_scroll(page)
        line.scroll_into_view_if_needed()
        shot(page, f"wiki-line-{label}")

        jonas = self.page("jonas", phone=phone)
        jonas.goto(f"/projects/{self.ids['project']}/docs/{doc_id}")
        expect(self.line(jonas, "doc")).to_contain_text(f"Updated the Wiki page {title}")

        line.get_by_role("button", name="Undo", exact=True).click()
        expect(line).to_contain_text("Undone by Ada")
        self.assertEqual(self.read_doc(doc_id)["body"].strip(), first, "the earlier text is the page again")
        shot(page, f"wiki-undone-{label}")

        # Changed since: the client edits again, a person writes after it.
        current = self.read_doc(doc_id)
        self.agent.tool("flux_update_doc", self.command(docId=doc_id, expectedVersion=current["version"],
                                                       changes={"body": f"{first} Second pass.", "reason": "The client edits again"}))
        newest = self.line(page, "doc")
        expect(newest.get_by_role("button", name="Undo", exact=True)).to_be_visible()
        current = self.read_doc(doc_id)
        self.api("ada", "PATCH", f"/api/v1/docs/{doc_id}", {"body": f"{first} By hand."}, status=200, headers={"if-match": f'"{current["version"]}"'})
        newest.get_by_role("button", name="Undo", exact=True).click()
        expect(newest.locator(".assistant-message__note")).to_contain_text("Changed since")
        expect(newest.locator(".assistant-message__note")).not_to_contain_text("Open it")
        self.assertIn("By hand.", self.read_doc(doc_id)["body"])

    def test_03_wiki_1440(self) -> None:
        self.check_doc(False)

    def test_04_wiki_390(self) -> None:
        self.check_doc(True)

    # ---------------------------------------------------------------- a map

    def check_map(self, phone: bool) -> None:
        label = "390" if phone else "1440"
        sketch = self.api("ada", "POST", f"/api/v1/workspaces/{self.ids['workspace']}/sketches",
                          {"title": f"Soil depth options ({label})", "scope": "project", "projectId": self.ids["project"]}, status=201)
        thought = f"Probe at 10 cm ({label})"
        self.agent.tool("flux_add_thought", self.command(mapId=sketch["id"], thought={"text": thought, "x": 0, "y": 0}))
        page = self.page(phone=phone)
        page.goto(f"/projects/{self.ids['project']}/map/{sketch['id']}")
        line = self.line(page, "map")
        expect(line).to_contain_text(f"Added thought {thought}")
        expect(line).to_contain_text("Ada · via Claude Code")
        expect(line.get_by_role("button", name="Undo", exact=True)).to_be_visible()
        self.no_sideways_scroll(page)
        # The line stands in the map's dock: no thought lies under it.
        box, thought_box = line.bounding_box(), page.locator(".sk-node").first.bounding_box()
        self.assertTrue(box and thought_box and (box["y"] >= thought_box["y"] + thought_box["height"] or box["x"] >= thought_box["x"] + thought_box["width"]
                                                 or box["x"] + box["width"] <= thought_box["x"] or box["y"] + box["height"] <= thought_box["y"]),
                        f"the change line {box} does not cover the thought {thought_box}")
        shot(page, f"map-line-{label}")
        if not phone:
            # The List keeps the line, above its thoughts.
            page.get_by_role("radio", name="List", exact=True).click()
            expect(page.locator(".sk-list-scroll .client-changes[data-client-changes='map']")).to_contain_text(f"Added thought {thought}")
            shot(page, f"map-list-line-{label}")
            page.get_by_role("radio", name="Map", exact=True).click()
            expect(line).to_be_visible()

        jonas = self.page("jonas", phone=phone)
        jonas.goto(f"/projects/{self.ids['project']}/map/{sketch['id']}")
        expect(self.line(jonas, "map")).to_contain_text(f"Added thought {thought}")

        line.get_by_role("button", name="Undo", exact=True).click()
        expect(line).to_contain_text("Undone by Ada")
        texts = [item["text"] for item in self.api("ada", "GET", f"/api/v1/sketches/{sketch['id']}", status=200)["thoughts"]]
        self.assertNotIn(thought, texts, "the thought the client added is gone")
        shot(page, f"map-undone-{label}")

    def test_05_map_1440(self) -> None:
        self.check_map(False)

    def test_06_map_390(self) -> None:
        self.check_map(True)


if __name__ == "__main__":
    unittest.main()
