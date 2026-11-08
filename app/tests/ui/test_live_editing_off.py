"""#239 review: with the live editing capability off, the wiki and maps are the ordinary ones.

The page asks for the capability once; it never requests a live room, never shows a live editor
first (the earlier "Write together" flash) and keeps the ordinary map's immediate undo.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UI_BROWSER, UPSTREAM, start_forwarder

PASSWORD = "ordinary live-off password"
# Records live-only text the moment any node shows it, so a flash before a fallback is caught.
WATCH = r"""
(() => {
  const seen = window.__liveText = [];
  const words = ['Write together', 'Connecting to the shared working copy', 'Shared working copy', 'Waiting for confirmation', 'Reconnecting to the shared map', 'is here too'];
  const check = () => { const text = document.body ? document.body.innerText : ''; for (const word of words) if (text.includes(word) && !seen.includes(word)) seen.push(word); };
  new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true });
})();
"""


@unittest.skipUnless(os.environ.get('FLUX_LIVE_EDITING') == 'off', 'Explicit operator opt-out lane; normal installs use live editing')
class LiveEditingOffJourney(unittest.TestCase):
    state: dict | None = None
    doc_url = ""
    map_url = ""

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        if cls.browser.browser_type.name != UI_BROWSER:
            raise AssertionError('The explicit-off journey must use the requested browser engine')
        print(f'ACTUAL_UI_ENGINE={cls.browser.browser_type.name}; mode=off', flush=True)
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self) -> tuple[Page, list[str]]:
        # A request a service worker handles cannot be held by a route (#271), and test_02c holds one.
        context = self.browser.new_context(base_url=ORIGIN, viewport=DESKTOP, color_scheme="light", storage_state=self.state, service_workers="block")
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

    def test_02_the_wiki_page_is_ordinary_from_the_first_render_and_saves_versions(self) -> None:
        page, live = self.page()
        page.goto(self.doc_url)
        expect(page.get_by_role("heading", level=2, name="Bench notes")).to_be_visible()
        text = page.locator('.cm-content[aria-label="Page text"]')
        expect(text).to_contain_text("The sensor reads 38% at 5 lux.")
        expect(text).to_have_attribute("contenteditable", "true")
        expect(page.locator('[data-live-status="ordinary"]')).to_be_visible()
        # The page is written where it is read, and the text saves as the next version when the typing rests (#869).
        text.click()
        page.keyboard.press("Control+End")
        page.keyboard.insert_text(" Checked twice.")
        deadline = time.monotonic() + 15
        while True:
            doc = self.api(page, "GET", f"/api/v1/docs/{self.doc_url.rsplit('/', 1)[-1]}", status=200)
            if "Checked twice." in doc["body"] or time.monotonic() > deadline:
                break
            time.sleep(0.25)
        self.assertEqual((doc["body"], doc["version"]), ("The sensor reads 38% at 5 lux. Checked twice.", 2))
        expect(page.locator(".wiki-head__meta").filter(has_text=re.compile(r"^Saved · "))).to_be_visible()
        time.sleep(0.5)
        # Neither a live room request nor live text, not even briefly before a fallback.
        self.assertEqual({"live requests": live, "live text": page.evaluate("window.__liveText")}, {"live requests": [], "live text": []})

    def test_02b_leaving_at_once_saves_the_text(self) -> None:
        # #946 review: without live editing the text saves when the page is left, before the typing has rested.
        page, _ = self.page()
        page.goto(self.doc_url)
        text = page.locator('.cm-content[aria-label="Page text"]')
        expect(text).to_have_attribute("contenteditable", "true")
        text.focus()
        page.keyboard.press("Control+End")
        page.keyboard.insert_text(" Left at once.")
        page.get_by_role("navigation", name="Space views").get_by_role("link", name="Conversation").click()
        deadline = time.monotonic() + 10
        while True:
            doc = self.api(page, "GET", f"/api/v1/docs/{self.doc_url.rsplit('/', 1)[-1]}", status=200)
            if "Left at once." in doc["body"] or time.monotonic() > deadline:
                break
            time.sleep(0.25)
        self.assertIn("Left at once.", doc["body"])

    def test_02c_closing_the_tab_during_a_save_still_saves_the_newer_text(self) -> None:
        # #946 review round 2: a closing tab never starts a save that waits behind the running one, so the newer text
        # goes at once with keepalive. The first save reaches the server and makes its version, but its answer is held
        # (the save is still running in the page) when the tab closes.
        page, _ = self.page()
        page.goto(self.doc_url)
        text = page.locator('.cm-content[aria-label="Page text"]')
        expect(text).to_have_attribute("contenteditable", "true")
        doc_id = self.doc_url.rsplit('/', 1)[-1]
        before = self.api(page, "GET", f"/api/v1/docs/{doc_id}", status=200)["version"]
        held: list = []
        def answer_later(route) -> None:
            held.append((route.request.method, route.fetch().status))
        page.route(lambda url: url.split("?", 1)[0].endswith(f"/api/v1/docs/{doc_id}"), answer_later, times=1)
        text.focus()
        page.keyboard.press("Control+End")
        page.keyboard.insert_text(" First part.")
        deadline = time.monotonic() + 10
        while not held and time.monotonic() < deadline:
            page.wait_for_timeout(100)
        self.assertEqual(held, [("PATCH", 200)], "the version saved by itself was made; its answer is held")
        page.keyboard.insert_text(" Second part, then the tab closed.")
        page.close(run_before_unload=True)
        reader, _ = self.page()
        deadline = time.monotonic() + 10
        while True:
            doc = self.api(reader, "GET", f"/api/v1/docs/{doc_id}", status=200)
            if "then the tab closed." in doc["body"] or time.monotonic() > deadline:
                break
            time.sleep(0.25)
        self.assertIn("First part. Second part, then the tab closed.", doc["body"])
        self.assertEqual(doc["version"], before + 2, "one version for each text, never two of the same")

    def test_02d_a_tab_closed_while_its_save_is_held_never_loses_the_newer_text(self) -> None:
        # #967: the running save is held before it reaches the server and the tab closes with newer text. The held save
        # and the two saves sent as the tab closes reach the server in any order; when every one of them is refused, the
        # copy the tab left on this device brings the text back on the next visit. FLUX_OFF_HELD_ROUNDS sets the rounds.
        project = self.doc_url.split("/")[2]
        reader, _ = self.page()
        outcomes = []
        for round_ in range(int(os.environ.get("FLUX_OFF_HELD_ROUNDS", "6"))):
            with self.subTest(round=round_):
                doc = self.api(reader, "POST", f"/api/v1/projects/{project}/docs", {"title": f"Held save {round_}", "body": "Start text."})
                url = f"/projects/{project}/docs/{doc['id']}"
                page, _ = self.page()
                page.goto(url)
                text = page.locator('.cm-content[aria-label="Page text"]')
                expect(text).to_have_attribute("contenteditable", "true")
                held: list = []
                page.route(lambda link: link.split("?", 1)[0].endswith(f"/api/v1/docs/{doc['id']}"), lambda route: held.append(route), times=1)
                text.focus()
                page.keyboard.press("Control+End")
                page.keyboard.insert_text(f" First part {round_}.")
                deadline = time.monotonic() + 10
                while not held and time.monotonic() < deadline:
                    page.wait_for_timeout(100)
                self.assertTrue(held, "the version saved by itself started and is held")
                page.keyboard.insert_text(f" Second part {round_}.")
                context = page.context
                page.close(run_before_unload=True)
                time.sleep(1.5)
                wanted = f"Start text. First part {round_}. Second part {round_}."
                at_close = wanted in self.api(reader, "GET", f"/api/v1/docs/{doc['id']}", status=200)["body"]
                again = context.new_page()
                again.goto(url)
                expect(again.locator('[data-live-status="ordinary"]')).to_be_visible()
                expect(again.locator('.cm-content[aria-label="Page text"]')).to_contain_text(wanted)
                conflict = again.get_by_role("alert").filter(has_text="while you were writing")
                if not at_close and conflict.count():
                    # The tab's own earlier save made the version the closing saves did not expect.
                    expect(conflict).to_contain_text("Your earlier save became version")
                    conflict.get_by_role("button", name="Keep my text").click()
                deadline = time.monotonic() + 15
                while True:
                    saved_body = self.api(again, "GET", f"/api/v1/docs/{doc['id']}", status=200)["body"]
                    if wanted in saved_body or time.monotonic() > deadline:
                        break
                    time.sleep(0.25)
                self.assertIn(wanted, saved_body)
                again.wait_for_function("() => !Object.keys(localStorage).some((key) => key.startsWith('flux:doc-left:'))", timeout=5000)
                outcomes.append("saved as the tab closed" if at_close else "restored on the next visit")
                again.close()
        print(f"HELD_SAVE_OUTCOMES {outcomes}", flush=True)

    def test_02e_a_save_sent_on_leaving_says_which_version_it_replaced(self) -> None:
        # #967 P3: the running save is held and someone saves meanwhile, so the save sent as the page is left lands on that
        # version; the new version says so. The page is left through the app (the same leave as a closing tab, without a
        # closing browser target that may drop the request).
        project = self.doc_url.split("/")[2]
        page, _ = self.page()
        doc = self.api(page, "POST", f"/api/v1/projects/{project}/docs", {"title": "Replaced as it closed", "body": "Start text."})
        page.goto(f"/projects/{project}/docs/{doc['id']}")
        text = page.locator('.cm-content[aria-label="Page text"]')
        expect(text).to_have_attribute("contenteditable", "true")
        held: list = []
        page.route(lambda link: link.split("?", 1)[0].endswith(f"/api/v1/docs/{doc['id']}"), lambda route: held.append(route), times=1)
        text.focus()
        page.keyboard.press("Control+End")
        page.keyboard.insert_text(" First part.")
        deadline = time.monotonic() + 10
        while not held and time.monotonic() < deadline:
            page.wait_for_timeout(100)
        self.assertTrue(held, "the version saved by itself started and is held")
        other, _ = self.page()
        response = other.request.fetch(f"{ORIGIN}/api/v1/docs/{doc['id']}", method="PATCH", data=json.dumps({"body": "Start text. Saved meanwhile."}),
                                       headers={"origin": ORIGIN, "content-type": "application/json", "if-match": f'"{doc["version"]}"', "idempotency-key": str(uuid.uuid4())})
        self.assertEqual(response.status, 200, response.text())
        page.keyboard.insert_text(" Second part.")
        page.get_by_role("navigation", name="Space views").get_by_role("link", name="Conversation").click()
        deadline = time.monotonic() + 10
        while True:
            current = self.api(other, "GET", f"/api/v1/docs/{doc['id']}", status=200)
            if "Second part." in current["body"] or time.monotonic() > deadline:
                break
            time.sleep(0.25)
        self.assertEqual((current["version"], current["body"]), (doc["version"] + 2, "Start text. First part. Second part."))
        self.assertEqual(current["reason"], f"Saved as the page was left, in place of version {doc['version'] + 1}")

    def test_03_map_is_ordinary_with_immediate_undo(self) -> None:
        page, live = self.page()
        page.goto(self.map_url)
        thought = page.locator(".sk-node", has_text="Distance sensor")
        expect(thought).to_be_visible()
        thought.click()
        thought.press("Delete")
        expect(page.locator(".sk-status")).to_contain_text("Saved")
        expect(thought).to_have_count(0)
        page.get_by_role("toolbar", name="Map tools").get_by_role("button", name="Undo", exact=True).click()
        expect(page.locator(".sk-status")).to_contain_text("Undid: removed a thought")
        expect(page.locator(".sk-node", has_text="Distance sensor")).to_be_visible()
        time.sleep(0.5)
        self.assertEqual({"live requests": live, "live text": page.evaluate("window.__liveText")}, {"live requests": [], "live text": []})

        # Pointer resizing uses one native/measured baseline in the ordinary path too.
        map_id = self.map_url.rsplit('/', 1)[-1]
        before = self.api(page, 'GET', f'/api/v1/sketches/{map_id}', status=200)['thoughts'][0]
        thought.click()
        bounds = thought.bounding_box()
        zoom = bounds['width'] / before['width']
        start_height = max(before['height'], thought.evaluate('el => el.offsetHeight'))
        handle = thought.locator('.sk-resize').bounding_box()
        self.assertIsNotNone(handle)
        try:
            page.mouse.move(handle['x'] + handle['width'] / 2, handle['y'] + handle['height'] / 2)
            page.mouse.down()
            page.mouse.move(handle['x'] + handle['width'] / 2 + 48 * zoom,
                            handle['y'] + handle['height'] / 2 + 24 * zoom, steps=4)
        finally:
            page.mouse.up()
        expect(thought).to_have_attribute('data-thought-version', str(before['version'] + 1))
        resized = self.api(page, 'GET', f'/api/v1/sketches/{map_id}', status=200)['thoughts'][0]
        self.assertEqual((resized['width'], resized['height']), (before['width'] + 48, start_height + 24))
        self.assertEqual((resized['text'], resized['x'], resized['y']), (before['text'], before['x'], before['y']))
        page.get_by_role('toolbar', name='Map tools').get_by_role('button', name='Undo', exact=True).click()
        expect(thought).to_have_attribute('data-thought-version', str(resized['version'] + 1))
        undone = self.api(page, 'GET', f'/api/v1/sketches/{map_id}', status=200)['thoughts'][0]
        self.assertEqual((undone['width'], undone['height']), (before['width'], before['height']))
        self.assertEqual({"live requests": live, "live text": page.evaluate("window.__liveText")}, {"live requests": [], "live text": []})
        print('ORDINARY_RESIZE_CONTROL', {'native': before, 'start_height': start_height,
              'resized': resized, 'undo': undone}, flush=True)
