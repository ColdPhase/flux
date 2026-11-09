"""A local client's post is its person's own message, marked "via Claude Code" (#1091, mcp-cowork LC-2; the review of #1105).

Ada's Claude Code signs in over a real OAuth/PKCE bearer (the `McpAgent` of test_scenarios) and posts in the project's conversations with
`flux_start_conversation` and `flux_reply_in_conversation`. Each is Ada's own message with the client's name as its mark, so everyone reads
"Ada Kowalska · via Claude Code" and Ada reads "via Claude Code" on her own bubble. A mark is never hidden under the person's name: a post
that follows Ada's own message starts its own author run. On a phone Ada's "⋯" does not sit over the label.

Computer 1440 and phone 390 (Chromium and WebKit through FLUX_UI_BROWSER). Screenshots (via-*.png) go to FLUX_UI_SCREENSHOTS when it is set.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Locator, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot as save_shot, start_forwarder
from test_scenarios import McpAgent

PASSWORD = "a client that says so"
STAMP = int(time.time() * 1000)
PEOPLE = {"ada": ("Ada Kowalska", f"ada.via+{STAMP}@example.test"), "jonas": ("Jonas Berg", f"jonas.via+{STAMP}@example.test")}
ADA_ROOT = "Which sensor for the far beds?"
CLIENT_ROOT = "The ToF sensor reads four metres in the dark."
ADA_REPLY = "I will check the datasheet tonight."
CLIENT_REPLY = "The datasheet agrees: four metres, no image stored."


def shot(page: Page, name: str) -> None:
    save_shot(page, f"via-{name}" if UI_BROWSER == "chromium" else f"via-{name}-{UI_BROWSER}")


def overlap(a: dict, b: dict) -> bool:
    return not (a["x"] + a["width"] <= b["x"] or b["x"] + b["width"] <= a["x"] or a["y"] + a["height"] <= b["y"] or b["y"] + b["height"] <= a["y"])


class ClientVia(unittest.TestCase):
    """Tests run in name order on one shared scene."""

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

    def api(self, who: str, method: str, path: str, body: dict | None = None, status: int | None = None, headers: dict | None = None) -> dict:
        response = self.req[who].request.fetch(f"{ORIGIN}{path}", method=method, data=json.dumps(body) if body is not None else None,
                                               headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})})
        if status is not None:
            self.assertEqual(response.status, status, f"{who} {method} {path}: {response.text()}")
        text = response.text()
        return json.loads(text) if text and text[:1] in "[{" else {}

    def page(self, who: str, *, phone: bool = False) -> Page:
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

    def message(self, page: Page, text: str) -> Locator:
        return page.locator("li.project-convo__message", has_text=text)

    def meta(self, page: Page, text: str) -> Locator:
        return self.message(page, text).locator(".project-convo__message-meta")

    def no_sideways_scroll(self, page: Page) -> None:
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth"), 0, "no horizontal page scroll")

    # ---------------------------------------------------------------- scene

    def test_00_scene(self) -> None:
        ids = type(self).ids
        ws = self.api("ada", "POST", "/api/v1/workspaces", {"name": "Garden lab"}, status=201)
        self.api("ada", "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE["jonas"][1], "role": "member"}, status=201)
        project = self.api("ada", "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Far beds", "visibility": "workspace"}, status=201)
        self.api("ada", "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "human", "id": ids["jonas"]}, "role": "contributor"}, status=201)
        # Ada's Claude Code signs in with one click on the consent page: a real bearer.
        type(self).agent = McpAgent(self, "ada", project["id"])
        agent = self.agent
        ids.update(workspace=ws["id"], project=project["id"])
        root = self.api("ada", "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": ADA_ROOT, "clientMessageId": str(uuid.uuid4())}, status=201)
        ids["root"] = root["id"]
        # The client starts a conversation right after Ada's own root: in the stream the two are consecutive roots of one person.
        started = agent.tool("flux_start_conversation", {"projectId": project["id"], "clientCommandId": str(uuid.uuid4()), "sources": [], "message": {"body": CLIENT_ROOT}})
        ids["started"] = started["conversationId"]
        # In Ada's thread, her own reply and then the client's, again one person's two messages in a row.
        self.api("ada", "POST", f"/api/v1/conversations/{root['id']}/messages", {"body": ADA_REPLY, "clientMessageId": str(uuid.uuid4())}, status=201)
        agent.tool("flux_reply_in_conversation", {"projectId": project["id"], "clientCommandId": str(uuid.uuid4()), "sources": [], "conversationId": root["id"],
                                                  "message": {"body": CLIENT_REPLY}})
        # The server stores both as Ada's, marked with the client's name.
        conversation = self.api("jonas", "GET", f"/api/v1/conversations/{root['id']}", status=200)
        replies = [(m["authorId"] == ids["ada"], m.get("via")) for m in conversation["messages"] if m["body"] in (ADA_REPLY, CLIENT_REPLY)]
        self.assertEqual(replies, [(True, None), (True, "Claude Code")])

    # ---------------------------------------------------------------- computer

    def test_01_computer_the_stream_and_the_thread_say_ada_via_claude_code(self) -> None:
        jonas = self.page("jonas")
        jonas.goto(f"/projects/{self.ids['project']}")
        expect(self.message(jonas, CLIENT_ROOT)).to_be_visible()
        # Ada's own root has no mark; the client's post right after it has its own author run, with the name and the mark.
        expect(self.message(jonas, ADA_ROOT).locator(".project-convo__via")).to_have_count(0)
        expect(self.message(jonas, CLIENT_ROOT)).not_to_have_class(re.compile(r"\bis-continued\b"))
        expect(self.meta(jonas, CLIENT_ROOT)).to_contain_text("Ada Kowalska")
        expect(self.meta(jonas, CLIENT_ROOT).locator(".project-convo__via")).to_have_text("via Claude Code")
        self.assertEqual(jonas.evaluate("el => getComputedStyle(el, '::before').content", self.meta(jonas, CLIENT_ROOT).locator(".project-convo__via").element_handle()), '"· "',
                         "read as one line: Ada Kowalska · via Claude Code")
        shot(jonas, "stream-1440-jonas")
        # Ada reads the mark on her own bubble.
        ada = self.page("ada")
        ada.goto(f"/projects/{self.ids['project']}")
        expect(self.message(ada, CLIENT_ROOT)).to_have_class(re.compile(r"\bis-mine\b"))
        expect(self.meta(ada, CLIENT_ROOT)).to_have_text("via Claude Code")
        shot(ada, "stream-1440-ada")
        # The thread: Jonas reads the client's reply as Ada · via Claude Code, apart from Ada's own reply above it.
        jonas.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['root']}")
        expect(self.message(jonas, CLIENT_REPLY)).to_be_visible()
        expect(self.message(jonas, ADA_REPLY).locator(".project-convo__via")).to_have_count(0)
        expect(self.message(jonas, CLIENT_REPLY)).not_to_have_class(re.compile(r"\bis-continued\b"))
        expect(self.meta(jonas, CLIENT_REPLY)).to_contain_text("Ada Kowalska")
        expect(self.meta(jonas, CLIENT_REPLY).locator(".project-convo__via")).to_have_text("via Claude Code")
        shot(jonas, "thread-1440-jonas")

    # ---------------------------------------------------------------- phone

    def test_02_phone_the_mark_shows_and_the_more_button_is_not_over_it(self) -> None:
        jonas = self.page("jonas", phone=True)
        jonas.goto(f"/projects/{self.ids['project']}")
        expect(self.message(jonas, CLIENT_ROOT)).to_be_visible()
        expect(self.meta(jonas, CLIENT_ROOT)).to_contain_text("Ada Kowalska")
        expect(self.meta(jonas, CLIENT_ROOT).locator(".project-convo__via")).to_have_text("via Claude Code")
        self.no_sideways_scroll(jonas)
        shot(jonas, "stream-390-jonas")
        ada = self.page("ada", phone=True)
        ada.goto(f"/projects/{self.ids['project']}")
        mine = self.message(ada, CLIENT_ROOT)
        expect(mine).to_be_visible()
        label = mine.locator(".project-convo__via")
        expect(label).to_have_text("via Claude Code")
        more = mine.locator(".msg-touch__sr")
        self.assertFalse(overlap(label.bounding_box(), more.bounding_box()), "Ada's ⋯ does not sit over the label")
        self.no_sideways_scroll(ada)
        shot(ada, "stream-390-ada")
        # The thread, Ada's own client reply, and Jonas's.
        ada.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['root']}")
        reply = self.message(ada, CLIENT_REPLY)
        expect(reply).to_be_visible()
        self.assertFalse(overlap(reply.locator(".project-convo__via").bounding_box(), reply.locator(".msg-touch__sr").bounding_box()), "nor in the thread")
        shot(ada, "thread-390-ada")
        jonas.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['root']}")
        expect(self.meta(jonas, CLIENT_REPLY)).to_contain_text("Ada Kowalska")
        expect(self.meta(jonas, CLIENT_REPLY).locator(".project-convo__via")).to_have_text("via Claude Code")
        shot(jonas, "thread-390-jonas")


if __name__ == "__main__":
    unittest.main()
