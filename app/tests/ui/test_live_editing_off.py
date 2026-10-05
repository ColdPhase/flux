"""#239 review: with the live editing capability off, the wiki and maps are the ordinary ones.

The page asks for the capability once; it never requests a live room, never shows a live editor
first (the earlier "Write together" flash) and keeps the ordinary map's immediate undo.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UPSTREAM, start_forwarder

PASSWORD = "ordinary live-off password"
# Records live-only text the moment any node shows it, so a flash before a fallback is caught.
WATCH = r"""
(() => {
  const seen = window.__liveText = [];
  const words = ['Write together', 'Connecting to the shared working copy', 'Shared working copy', 'Waiting for confirmation', 'Reconnecting to the shared map'];
  const check = () => { const text = document.body ? document.body.innerText : ''; for (const word of words) if (text.includes(word) && !seen.includes(word)) seen.push(word); };
  new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true });
})();
"""


class LiveEditingOffJourney(unittest.TestCase):
    state: dict | None = None
    doc_url = ""
    map_url = ""

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

    def page(self) -> tuple[Page, list[str]]:
        context = self.browser.new_context(base_url=ORIGIN, viewport=DESKTOP, color_scheme="light", storage_state=self.state)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        live: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("request", lambda request: live.append(request.url) if re.search(r"/live(/|\?|$)", request.url) else None)
        page.add_init_script(WATCH)
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page, live

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int = 201) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, data=json.dumps(body) if body is not None else None,
                                      headers={"origin": ORIGIN, "content-type": "application/json", "idempotency-key": str(uuid.uuid4())})
        self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def test_01_setup(self) -> None:
        page, _ = self.page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Olga Ordinary")
        page.get_by_label("Email").fill(f"olga-{uuid.uuid4().hex[:10]}@example.test")
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).state = page.context.storage_state()
        self.assertEqual(self.api(page, "GET", "/api/v1/live-editing/capabilities", status=200), {"status": "unavailable"})
        ws = self.api(page, "POST", "/api/v1/workspaces", {"name": "Ordinary studio"})
        project = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Ordinary lamp", "visibility": "restricted"})
        type(self).doc_url = f"/projects/{project['id']}/docs/" + self.api(page, "POST", f"/api/v1/projects/{project['id']}/docs", {"title": "Bench notes", "body": "The sensor reads 38% at 5 lux."})["id"]
        sketch = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/sketches", {"title": "Sensor map", "scope": "project", "projectId": project["id"]})
        self.api(page, "POST", f"/api/v1/sketches/{sketch['id']}/thoughts", {"text": "Distance sensor", "x": 80, "y": 80})
        type(self).map_url = f"/map/{sketch['id']}"

    def test_02_wiki_reader_and_editor_are_ordinary_from_the_first_render(self) -> None:
        page, live = self.page()
        shown: list[str] = []
        page.goto(self.doc_url)
        expect(page.get_by_role("heading", level=2, name="Bench notes")).to_be_visible()
        expect(page.get_by_text("The sensor reads 38% at 5 lux.")).to_be_visible()
        page.get_by_role("link", name="Edit").click()
        expect(page.get_by_label("Text (Markdown)")).to_have_value("The sensor reads 38% at 5 lux.")
        shown.extend(page.evaluate("window.__liveText"))
        # A directly opened editor is ordinary from its first render too.
        page.goto(self.doc_url + "/edit")
        expect(page.get_by_label("Text (Markdown)")).to_have_value("The sensor reads 38% at 5 lux.")
        time.sleep(0.5)
        shown.extend(page.evaluate("window.__liveText"))
        self.assertEqual(live, [], "an ordinary wiki never asks for a live room")
        self.assertEqual(shown, [], "no live editor text, not even briefly")

    def test_03_map_is_ordinary_with_immediate_undo(self) -> None:
        page, live = self.page()
        page.goto(self.map_url)
        thought = page.locator(".sk-node", has_text="Distance sensor")
        expect(thought).to_be_visible()
        thought.click()
        thought.press("Delete")
        expect(page.locator(".sk-status")).to_contain_text("Saved")
        expect(thought).to_have_count(0)
        page.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Undo", exact=True).click()
        expect(page.locator(".sk-status")).to_contain_text("Undid: removed a thought")
        expect(page.locator(".sk-node", has_text="Distance sensor")).to_be_visible()
        time.sleep(0.5)
        self.assertEqual(live, [], "an ordinary map never asks for a live room")
        self.assertEqual(page.evaluate("window.__liveText"), [], "no live map text, not even briefly")
