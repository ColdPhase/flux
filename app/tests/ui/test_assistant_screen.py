"""Browser tests for the assistant screen and its journeys (F-027 A7, #407; AST-10).

The check_ui.sh stack has no agent runtime, so the owner's enablement, Ask me first and answers are stubbed
responses (as in test_assistant_runtime). This proves the words, the flow and the layout at both widths;
tests/app/assistant-settings.test.ts proves Ask me first against the real store.
"""

from __future__ import annotations

import copy
import json
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, Route, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "my own claude plan"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Brandt", "email": f"ada.screen+{STAMP}@example.test"}
FORBIDDEN = re.compile(r"\b(scope|grant|MCP|token|capability|execute|runtime|transport|OAuth|policy|proposal|payload|slot|job|reaction|cron)\b", re.I)
NOW = "2026-10-16T09:00:00.000Z"
UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")


def pick_suggestion(page: Page, name: str, composer: str = "#thread-composer") -> None:
    """#1224: the assistant's suggestions are rows of the `/` menu, under `/ai`: type "/" in the composer and choose one."""
    page.locator(composer).fill("/")
    page.get_by_role("listbox", name="Actions").get_by_role("option", name=f"Ask your assistant: {name}", exact=True).click()


def menu_clipped_by(page: Page, menu) -> str | None:
    """#1224: what cuts a composer's `/` menu off: the pane or sheet it sits in, or the top of the screen (None when nothing does). The menu
    is as tall as the room above its box, so a short phone sheet scrolls it instead of hiding rows under its header."""
    page.evaluate("() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null)))")
    return menu.evaluate("""(el) => { const r = el.getBoundingClientRect(); if (r.top < -1) return 'the screen';
      for (let p = el.parentElement; p; p = p.parentElement) { if (getComputedStyle(p).overflowY === 'visible') continue;
        const q = p.getBoundingClientRect(); if (q.height && (r.top < q.top - 1 || r.bottom > q.bottom + 1)) return String(p.className || p.tagName); }
      return null; }""")


def suggestions_reachable(test: unittest.TestCase, menu, rows) -> None:
    """The first row is always in view; a suggestion is in view too unless the menu scrolls (then the arrow keys and the finger reach it)."""
    shown = menu.bounding_box()
    first = menu.locator(".cmenu__o").first.bounding_box()
    test.assertGreaterEqual(first["y"], shown["y"] - 1, "the first row is at the top of the menu")
    if not menu.evaluate("(el) => el.scrollHeight > el.clientHeight + 1"):
        for row in rows.all():
            box = row.bounding_box()
            test.assertLessEqual(box["y"] + box["height"], shown["y"] + shown["height"] + 1, "the suggestion is in view")


class AssistantScreen(unittest.TestCase):
    """Tests run in name order and share one account."""

    pw = None
    browser: Browser
    state: dict | None = None
    ids: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, *, phone: bool = False, dark: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "UTC"}
        options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP, device_scale_factor=1)
        if self.state:
            options["storage_state"] = self.state
        context = self.browser.new_context(service_workers="block", **options)
        self.addCleanup(context.close)
        return context

    def page(self, **kwargs) -> Page:
        page = self.context(**kwargs).new_page()
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

    def json(self, route: Route, body: dict, status: int = 200) -> None:
        route.fulfill(status=status, content_type="application/json", body=json.dumps(body))

    # ---------------------------------------------------------------- stubs

    def status(self, page: Page, *, enabled: bool, paused: bool = False, runtime: str = "signed_in") -> dict:
        stub = copy.deepcopy(self.api(page, "GET", "/api/v1/personal-assistant", status=200))
        stub["setup"] = {"provider": "off", "connection": "none", "runtime": {"state": runtime, "payer": "claude_plan", "accountLabel": "a***@example.test", "client": "claude_code"}}
        if enabled:
            # The Claude plan (#854): no budget of Flux's, so no `today`.
            stub.update(state="paused" if paused else "ready", unavailableReason=None, today=None, enablement={
                "ownerUserId": ADA["id"], "connection": "claude_plan", "engine": "runtime", "status": "active", "model": "sonnet",
                "agents": [{"workspaceId": self.ids["workspace"], "agentId": self.ids["agent"]}], "version": 1, "createdAt": NOW, "updatedAt": NOW})
        else:
            stub.update(state="not_enabled", unavailableReason=None, enablement=None, today=None)
        return stub

    def stub_assistant(self, page: Page, *, enabled: bool = True, runtime: str = "signed_in") -> dict:
        """Status, settings, the one Ask me first PATCH and pause/resume, all in memory."""
        world = {"status": self.status(page, enabled=enabled, runtime=runtime), "patches": [], "pauses": [],
                 "agents": {"projectId": self.ids["project"], "connections": []},
                 "settings": {"workspaceId": self.ids["workspace"], "ownerUserId": ADA["id"], "agentId": self.ids["agent"], "connectionId": self.ids["agent"], "mayDo": "act",
                              "version": 1, "createdAt": NOW, "updatedAt": NOW}}

        def status(route: Route) -> None:
            self.json(route, world["status"]) if route.request.method == "GET" else route.continue_()

        def settings(route: Route) -> None:
            self.json(route, world["settings"])

        def may_do(route: Route) -> None:
            patch = json.loads(route.request.post_data or "{}")
            world["patches"].append(patch)
            world["settings"]["mayDo"] = patch["mayDo"]
            self.json(route, {"mayDo": patch["mayDo"]})

        def pause(route: Route) -> None:
            world["pauses"].append(route.request.url.rsplit("/", 1)[-1])
            world["status"]["state"] = "paused" if route.request.url.endswith("/pause") else "ready"
            self.json(route, world["status"])

        def agents(route: Route) -> None:
            self.json(route, world["agents"])

        page.route(re.compile(r".*/api/v1/projects/[0-9a-f-]{36}/agents$"), agents)
        page.route("**/api/v1/personal-assistant", status)
        page.route("**/api/v1/personal-assistant/pause", pause)
        page.route("**/api/v1/personal-assistant/resume", pause)
        page.route(re.compile(r".*/api/v1/workspaces/[0-9a-f-]{36}/assistants/[0-9a-f-]{36}/settings$"), settings)
        page.route(re.compile(r".*/api/v1/agent-connections/[0-9a-f-]{36}$"), may_do)
        return world

    def stub_thread(self, page: Page) -> None:
        """The person's own runs here: none. Nothing is posted in the conversation by an assistant, so there is nothing else to stub."""
        page.route(re.compile(r".*/api/v1/assistant-runs\?(?:limit=\d+|conversationId=[0-9a-f-]{36}&limit=\d+&offset=\d+)$"), lambda route: self.json(route, {"items": [], "total": 0, "limit": 10, "offset": 0}))

    def thread_url(self) -> str:
        return f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}"

    def no_horizontal_scroll(self, page: Page) -> None:
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"))

    def tag(self, phone: bool, dark: bool = False) -> str:
        return f"{'390' if phone else '1440'}-{'dark' if dark else 'light'}"

    # ---------------------------------------------------------------- tests

    def test_01_an_owner_with_a_project(self) -> None:
        page = self.page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill(ADA["name"])
        page.get_by_label("Email").fill(ADA["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).state = page.context.storage_state()
        ADA["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        ws = self.api(page, "POST", "/api/v1/workspaces", {"name": "Lamp studio"}, status=201)
        project = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Gesture lamp", "visibility": "restricted"}, status=201)
        thread = self.api(page, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": "Camera or ToF sensor for the bedside lamp?", "clientMessageId": str(uuid.uuid4())}, status=201)
        agent = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/agents", {"name": "Ada's assistant", "owner": "self"}, status=201)
        type(self).ids = {"workspace": ws["id"], "project": project["id"], "conversation": thread["id"], "agent": agent["id"]}

    def test_08_at_lists_people_only_and_the_assistant_is_asked_with_ai(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                self.stub_assistant(page)
                self.stub_thread(page)
                page.goto(self.thread_url())
                box = page.get_by_placeholder(re.compile("Reply in thread"))
                box.fill("@")
                # `@` mentions people only (#1419): the assistant and the agents are not in it, so with nobody else in the space the list does not open.
                expect(page.get_by_role("listbox", name="Mention")).to_have_count(0)
                box.fill("/")
                actions = page.get_by_role("listbox", name="Actions")
                ai = actions.get_by_role("option").filter(has_text="/ai")
                expect(ai).to_be_visible()
                shot(page, f"slash-list-{self.tag(phone)}")
                ai.click()
                expect(page.get_by_placeholder("Ask your assistant…")).to_be_visible()
                self.stub_thread(page)


if __name__ == "__main__":
    unittest.main()
