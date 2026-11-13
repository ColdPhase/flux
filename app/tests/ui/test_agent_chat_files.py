"""Files, photos and videos in an agent's private chat (#1438 point 10, C-64 point 4).

Runs with the other tests/ui journeys through scripts/check_ui.sh, on the TEST-ONLY mock provider (tests/ui/anthropic_mock.py): the real worker
sends the run through the real Anthropic adapter, and the mock calls `flux_view_image` once with the photo Jo sent. Nothing here calls a model.

Jo attaches a photo and a notes file with the paperclip in the chat with her agent and asks about them: her message shows the photo and the file
row as any message does, the agent's run is told both by name and id and looks at the photo, and nobody else opens either file.
"""

from __future__ import annotations

import base64
import json
import os
import re
import time
import unittest
import urllib.request

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

MOCK = os.environ.get("FLUX_ANTHROPIC_MOCK_URL", "http://127.0.0.1:8090")
UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
PASSWORD = "files for my own agent"
STAMP = int(time.time() * 1000)
JO = {"name": "Jo Chatfile", "email": f"jo.chatfile+{STAMP}@example.test"}
KAI = {"name": "Kai Chatfile", "email": f"kai.chatfile+{STAMP}@example.test"}
NOTES = b"Water the beds on Mondays.\n"
# A real 1x1 PNG: a photo the browser can draw.
PHOTO = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
ANSWER = "The photo shows one green square, and the notes say to water on Mondays."


def mock(path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"{MOCK}{path}", data=data, method="POST" if body is not None else "GET", headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read())


class AgentChatFiles(unittest.TestCase):
    """Tests run in name order and share two accounts."""

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
        mock("/__script", {"reset": True})

    @classmethod
    def tearDownClass(cls) -> None:
        mock("/__script", {"reset": True})
        cls.browser.close()
        cls.pw.stop()

    def context(self, who: str | None, *, phone: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
        options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP, device_scale_factor=1)
        if who and who in self.states:
            options["storage_state"] = self.states[who]
        context = self.browser.new_context(service_workers="block", **options)
        self.addCleanup(context.close)
        return context

    def page(self, who: str | None, **kwargs) -> Page:
        page = self.context(who, **kwargs).new_page()
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

    def attach(self, page: Page, files: list[dict]) -> list[dict]:
        """The paperclip, as a person uses it; returns what the server staged, as the draft keeps it on this device."""
        with page.expect_file_chooser() as chooser:
            page.get_by_role("button", name="Attach files").click()
        chooser.value.set_files(files)
        draft = page.get_by_role("list", name="Files in your draft")
        expect(draft.get_by_text("Ready, private", exact=False)).to_have_count(len(files))
        kept = page.evaluate("""agent => Object.keys(localStorage).filter((key) => key.startsWith('flux:composer:') && key.endsWith(`:chat:${agent}`))
            .map((key) => JSON.parse(localStorage.getItem(key)))""", self.ids["agent"])
        return [file["staged"] for draft in kept for file in draft.get("files", []) if file.get("staged")]

    def test_01_jo_has_an_agent_and_kai_works_with_her(self) -> None:
        for key, person in (("jo", JO), ("kai", KAI)):
            page = self.page(None)
            page.goto("/sign-up")
            page.get_by_label("Name").fill(person["name"])
            page.get_by_label("Email").fill(person["email"])
            page.get_by_label("Password").fill(PASSWORD)
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            type(self).states[key] = page.context.storage_state()
            person["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        jo = self.page("jo")
        ws = self.api(jo, "POST", "/api/v1/workspaces", {"name": "Garden plots"}, status=201)
        self.api(jo, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": KAI["email"], "role": "member"}, status=201)
        agent = self.api(jo, "POST", "/api/v1/my-agents", {"workspaceId": ws["id"]}, status=201)
        type(self).ids = {"workspace": ws["id"], "agent": agent["id"], "agent_name": agent["name"]}

    def test_02_jo_sends_a_photo_and_a_file_and_the_agent_looks_at_the_photo(self) -> None:
        jo = self.page("jo")
        jo.goto(f"/agents/{self.ids['agent']}")
        expect(jo.locator("#agent-composer")).to_be_visible()
        # The paperclip is a real control in the chat, not the greyed "(not available here)" one.
        expect(jo.get_by_role("button", name=re.compile("not available here"))).to_have_count(0)
        staged = self.attach(jo, [{"name": "plot.png", "mimeType": "image/png", "buffer": PHOTO}, {"name": "notes.txt", "mimeType": "text/plain", "buffer": NOTES}])
        photo = next(item for item in staged if item["name"] == "plot.png")
        self.assertEqual(photo.get("agentId"), self.ids["agent"])
        mock("/__script", {"reset": True, "text": ANSWER, "tool": {"name": "flux_view_image", "input": {"fileId": photo["id"]}}})
        jo.locator("#agent-composer").fill("What is in these?")
        shot(jo, "agent-chat-files-1440-draft")
        jo.get_by_role("button", name=f"Send to {self.ids['agent_name']}").click()
        expect(jo.get_by_role("list", name="Files in your draft")).to_have_count(0)
        mine = jo.locator("[data-chat-me]").filter(has_text="What is in these?")
        expect(mine.locator(".photo-grid__tile[data-photo-state='ready']")).to_have_count(1)
        expect(mine.get_by_role("link", name="Download notes.txt")).to_have_attribute("href", re.compile(r"^/api/v1/files/[0-9a-f-]{36}$"))
        answer = jo.locator("[data-chat-agent]").filter(has_text="water on Mondays")
        expect(answer).to_be_visible(timeout=20000)
        shot(jo, "agent-chat-files-1440-answered")
        # The run was told both files by name and id, and the model was given the photo as image input after it asked.
        sent = [entry["body"] for entry in mock("/__requests")["requests"] if entry["path"] == "/v1/messages"]
        first = json.dumps(sent[0])
        self.assertIn(photo["id"], first)
        self.assertIn("notes.txt", first)
        self.assertTrue(any('"type": "image"' in json.dumps(body) for body in sent[1:]), "the photo reached the model as image input")

    def test_03_a_file_alone_is_a_message_and_the_phone_shows_the_history(self) -> None:
        mock("/__script", {"reset": True, "text": "Got the file."})
        jo = self.page("jo", phone=True)
        jo.goto(f"/agents/{self.ids['agent']}")
        expect(jo.locator("#agent-composer")).to_be_visible()
        with jo.expect_file_chooser() as chooser:
            jo.get_by_role("button", name="Attach files").click()
        chooser.value.set_files([{"name": "alone.txt", "mimeType": "text/plain", "buffer": b"only a file"}])
        # On the phone the picked files are confirmed in a sheet first, as in a space (#348).
        sheet = jo.get_by_role("dialog", name="Choose files to send")
        sheet.get_by_role("button", name="alone.txt").click()
        sheet.get_by_role("button", name="Add 1").click()
        expect(jo.get_by_role("list", name="Files in your draft").get_by_text("Ready, private", exact=False)).to_have_count(1)
        send = jo.get_by_role("button", name=f"Send to {self.ids['agent_name']}")
        expect(send).not_to_have_attribute("aria-disabled", "true")
        send.click()
        mine = jo.locator("[data-chat-me]", has=jo.get_by_role("link", name="Download alone.txt"))
        expect(mine).to_be_visible()
        expect(mine.locator(".dm-msg__body")).to_have_count(0)  # no empty bubble of words above the file
        expect(jo.locator("[data-chat-me] .photo-grid__tile[data-photo-state='ready']")).to_have_count(1)  # the earlier photo, after a fresh load
        self.assertLessEqual(jo.evaluate("document.documentElement.scrollWidth"), jo.evaluate("window.innerWidth"))
        shot(jo, "agent-chat-files-390-history")

    def test_04_nobody_else_opens_the_chats_files(self) -> None:
        jo = self.page("jo")
        runs = self.api(jo, "GET", f"/api/v1/assistant-runs?chatAgentId={self.ids['agent']}", status=200)["items"]
        files = [file for run in runs for file in run.get("files") or []]
        self.assertGreaterEqual(len(files), 3)
        kai = self.page("kai")
        for file in files:
            self.assertEqual(jo.request.get(f"{ORIGIN}/api/v1/files/{file['id']}").status, 200)
            self.assertEqual(kai.request.get(f"{ORIGIN}/api/v1/files/{file['id']}").status, 404, "nobody else opens it")
        # Nor can Kai stage a file in Jo's chat.
        response = kai.request.post(f"{ORIGIN}/api/v1/my-agents/{self.ids['agent']}/files?uploadId=00000000-0000-4000-8000-000000000001&name=x.txt",
                                    headers={"origin": ORIGIN, "content-type": "application/octet-stream"}, data=b"x")
        self.assertEqual(response.status, 404)


if __name__ == "__main__":
    unittest.main()
