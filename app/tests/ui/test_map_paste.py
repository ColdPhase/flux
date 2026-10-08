"""#252: paste lines, links and images on the map, against the Docker UI and real API.

Every paste fills #149's private draft; nothing shared is written before Save. Contract:
docs/design/thought-drafts.md ("Paste on the map") and docs/development/task-discussions.md
("Map thought images").
"""
from __future__ import annotations

import base64
import re
import struct
import time
import unittest
import uuid
import zlib

from playwright.sync_api import expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

STAMP = int(time.time() * 1000)
PASSWORD = "paste what you have in mind"
LINES = "  Swipe slowly to dim  \r\n\n<b>Hold</b> to switch off\n\t\nDouble tap for a reading light\n"
VIEW_ONLY = "You can look at this map but not add to it."


def png(width: int = 48, height: int = 32) -> bytes:
    """A real PNG with a visible gradient, written without image libraries."""
    rows = b"".join(b"\x00" + bytes(value for x in range(width) for value in ((x * 5) % 256, (y * 8) % 256, 170)) for y in range(height))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


IMAGE = png()
# A paste as the browser delivers it: a ClipboardEvent whose DataTransfer carries text and/or a file,
# dispatched at the focused element (the page itself when nothing is focused).
PASTE = """([text, file]) => {
  const data = new DataTransfer();
  if (text !== null) data.setData('text/plain', text);
  if (file) {
    const bytes = file.size ? new Uint8Array(file.size) : Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
    if (file.size && file.base64) bytes.set(Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0)));
    data.items.add(new File([bytes], file.name, { type: file.type }));
  }
  const target = document.activeElement || document.body;
  target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}"""
NATURAL = "el => el.complete && el.naturalWidth"


class MapPasteJourney(unittest.TestCase):
    states = {}
    people = {}

    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=10000)
        contexts = {}
        for who, name in (("owner", "Ada Paste"), ("writer", "Jonas Clip"), ("viewer", "Nia Reader")):
            ctx = cls.browser.new_context(base_url=ORIGIN)
            email = f"paste-{who}+{STAMP}@example.test"
            answer = ctx.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert answer.status == 200, answer.text()
            cls.people[who] = {"id": ctx.request.get("/api/v1/me").json()["user"]["id"], "email": email}
            cls.states[who] = ctx.storage_state()
            contexts[who] = ctx
        owner = contexts["owner"]
        answer = owner.request.post("/api/v1/workspaces", data={"name": "Riverside paste studies"}, headers={"origin": ORIGIN})
        assert answer.status == 201, answer.text()
        cls.workspace = answer.json()["id"]
        for who in ("writer", "viewer"):
            answer = owner.request.post(f"/api/v1/workspaces/{cls.workspace}/members", data={"email": cls.people[who]["email"], "role": "member"}, headers={"origin": ORIGIN})
            assert answer.status == 201, answer.text()
        for ctx in contexts.values():
            ctx.close()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def page(self, who="writer", clipboard=False, **options):
        ctx = self.browser.new_context(**{"base_url": ORIGIN, "storage_state": self.states[who], "viewport": DESKTOP, "color_scheme": "light", **options})
        self.addCleanup(ctx.close)
        if clipboard:
            ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=ORIGIN)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        return page

    def api(self, page, method, path, body=None, status=200, headers=None):
        response = page.request.fetch(path, method=method, data=body, headers={"origin": ORIGIN, "idempotency-key": str(uuid.uuid4()), **(headers or {})})
        self.assertEqual(response.status, status, response.text())
        return response.json() if response.text() else None

    def setUp(self):
        self.owner = self.page("owner")
        self.project = self.api(self.owner, "POST", f"/api/v1/workspaces/{self.workspace}/projects", {"name": "Quiet gesture lamp", "visibility": "restricted"}, 201)["id"]
        for who, role in (("writer", "contributor"), ("viewer", "viewer")):
            self.api(self.owner, "POST", f"/api/v1/projects/{self.project}/grants", {"principal": {"kind": "human", "id": self.people[who]["id"]}, "role": role}, 201)
        self.sketch = self.api(self.owner, "POST", f"/api/v1/workspaces/{self.workspace}/sketches", {"title": "Bedside sensing directions", "scope": "project", "projectId": self.project}, 201)["id"]
        self.parent = self.api(self.owner, "POST", f"/api/v1/sketches/{self.sketch}/thoughts", {"text": "Capture a gesture without recording camera images", "x": 0, "y": 0}, 201)["thought"]["id"]
        self.before = self.stored(self.owner)

    def stored(self, page, sketch=None):
        return self.api(page, "GET", f"/api/v1/sketches/{sketch or self.sketch}")

    def wait_stored(self, page, predicate):
        for _ in range(50):
            current = self.stored(page)
            if predicate(current):
                return current
            page.wait_for_timeout(100)
        self.fail("the expected committed API state did not arrive")

    def open(self, page, mode="List", sketch=None):
        page.goto(f"/projects/{self.project}/map/{sketch or self.sketch}")
        expect(page.locator(".sk-head")).to_be_visible()
        page.get_by_role("radio", name=mode, exact=True).click()

    def writes(self, page):
        found = []
        page.on("request", lambda request: found.append((request.method, request.url)) if request.method != "GET" and re.search(r"/api/v1/(sketches|projects/[^/]+/files|files)", request.url) else None)
        return found

    def paste(self, page, text=None, file=None):
        page.evaluate(PASTE, [text, file])

    def image(self, data=IMAGE, name="image.png", kind="image/png"):
        return {"base64": base64.b64encode(data).decode(), "name": name, "type": kind}

    def test_01_keyboard_lines_draft_privately_save_on_confirmation_and_undo_together(self):
        page = self.page(clipboard=True)
        self.open(page)
        writes = self.writes(page)
        page.evaluate("text => navigator.clipboard.writeText(text)", LINES)
        page.locator(f'.sk-li-t[data-id="{self.parent}"]').focus()
        page.keyboard.press("ControlOrMeta+V")
        draft = page.get_by_role("form", name="Pasted thoughts draft")
        expect(draft).to_be_visible()
        rows = draft.get_by_role("textbox")
        expect(rows).to_have_count(3)
        self.assertEqual([rows.nth(i).input_value() for i in range(3)], ["Swipe slowly to dim", "<b>Hold</b> to switch off", "Double tap for a reading light"])
        expect(draft).to_contain_text("3 new thoughts from a paste · Top level · private until saved")
        expect(rows.first).to_be_focused()
        self.assertEqual(writes, [], "a paste writes nothing before Save")
        self.assertEqual(self.stored(page), self.before)
        # The rows are editable and removable before anything is shared, and survive a reload.
        draft.get_by_label("Pasted thought 2 of 3", exact=True).fill("<b>Hold</b> to switch the lamp off")
        draft.get_by_role("button", name="Remove pasted thought 3 of 3").click()
        expect(rows).to_have_count(2)
        page.reload()
        draft = page.get_by_role("form", name="Pasted thoughts draft")
        expect(draft.get_by_role("textbox")).to_have_count(2)
        expect(draft.get_by_label("Pasted thought 2 of 2", exact=True)).to_have_value("<b>Hold</b> to switch the lamp off")
        self.assertEqual(self.stored(self.owner), self.before)
        # A text field keeps its native paste: the shortcut inside a row never starts another draft.
        row = draft.get_by_label("Pasted thought 1 of 2", exact=True)
        row.focus()
        row.press("End")
        page.evaluate("text => navigator.clipboard.writeText(text)", " now")
        page.keyboard.press("ControlOrMeta+V")
        expect(row).to_have_value("Swipe slowly to dim now")
        expect(page.get_by_role("form")).to_have_count(1)
        self.assertEqual(writes, [])
        shot(page, "map-paste-lines-desktop")
        row.press("Enter")
        expect(page.get_by_role("form", name="Pasted thoughts draft")).to_have_count(0)
        expect(page.locator(".sk-status")).to_contain_text("Added 2 thoughts")
        saved = self.wait_stored(self.owner, lambda current: len(current["thoughts"]) == 3)
        added = [t for t in saved["thoughts"] if t["id"] != self.parent]
        self.assertEqual(sorted(t["text"] for t in added), ["<b>Hold</b> to switch the lamp off", "Swipe slowly to dim now"])
        self.assertEqual(saved["links"], [], "pasted rows are top level when nothing is selected")
        self.assertEqual([method for method, url in writes if url.endswith(f"/{self.sketch}/thoughts")], ["POST", "POST"])
        expect(page.locator(f'.sk-li-t[data-id="{added[0]["id"]}"]')).to_contain_text(added[0]["text"])
        # One undo step removes everything the paste added.
        page.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Undo", exact=True).click()
        expect(page.locator(".sk-status")).to_contain_text("Undid: added 2 thoughts")
        restored = self.wait_stored(self.owner, lambda current: len(current["thoughts"]) == 1)
        self.assertEqual(restored["thoughts"], self.before["thoughts"])

    def test_02_line_cap_long_rows_parent_and_busy_states(self):
        page = self.page()
        self.open(page)
        writes = self.writes(page)
        page.locator(f'.sk-li-t[data-id="{self.parent}"]').focus()
        self.paste(page, "\n".join(f"Lamp idea {n}" for n in range(1, 52)))
        expect(page.locator(".sk-status")).to_contain_text("A paste adds at most 50 thoughts and this one has 51 lines. Nothing was added")
        expect(page.get_by_role("form")).to_have_count(0)
        # A row over the thought limit is marked and blocks Save until it is shortened.
        self.paste(page, "Short idea\n" + "x" * 1001)
        draft = page.get_by_role("form", name="Pasted thoughts draft")
        save = draft.get_by_role("button", name="Save 2 thoughts")
        expect(save).to_be_disabled()
        expect(draft).to_contain_text("Over 1,000 characters")
        expect(draft.get_by_label("Pasted thought 2 of 2", exact=True)).to_have_attribute("aria-invalid", "true")
        # While a draft is open, another paste says so instead of replacing it.
        page.locator(f'.sk-li-t[data-id="{self.parent}"]').focus()
        self.paste(page, "Replace my draft?")
        expect(page.locator(".sk-status")).to_contain_text("Finish or cancel your current thought draft first")
        draft.get_by_label("Pasted thought 2 of 2", exact=True).fill("Measured idea")
        expect(save).to_be_enabled()
        draft.get_by_role("button", name="Cancel", exact=True).click()
        expect(page.get_by_role("form")).to_have_count(0)
        self.assertEqual(writes, [])
        self.assertEqual(self.stored(page), self.before)
        # With a thought selected, the rows connect to it on save (the Thought button's rule).
        page.locator(f'.sk-li-t[data-id="{self.parent}"]').click()
        self.paste(page, "Child one\nChild two")
        draft = page.get_by_role("form", name="Pasted thoughts draft")
        expect(draft).to_contain_text("Connected to “Capture a gesture without recording camera images” on save")
        draft.get_by_role("button", name="Save 2 thoughts").click()
        saved = self.wait_stored(page, lambda current: len(current["thoughts"]) == 3)
        children = {t["id"] for t in saved["thoughts"] if t["id"] != self.parent}
        self.assertEqual({link["toId"] for link in saved["links"] if link["fromId"] == self.parent}, children)

    def test_03_link_paste_is_the_url_itself_and_opens_safely(self):
        page = self.page()
        self.open(page)
        outside = []
        page.on("request", lambda request: outside.append(request.url) if "example.test" in request.url else None)
        self.paste(page, "  https://example.test/lamp-notes?draft=2#dusk ")
        draft = page.get_by_role("form", name="New thought draft")
        expect(draft).to_contain_text("New link")
        expect(draft.get_by_label("Thought text")).to_have_value("https://example.test/lamp-notes?draft=2#dusk")
        draft.get_by_label("Thought text").press("Enter")
        saved = self.wait_stored(page, lambda current: len(current["thoughts"]) == 2)
        link = next(t for t in saved["thoughts"] if t["id"] != self.parent)
        self.assertEqual(link["text"], "https://example.test/lamp-notes?draft=2#dusk", "no title is fetched; the URL is the text")
        anchor = page.locator(".sk-li-link")
        expect(anchor).to_have_attribute("href", "https://example.test/lamp-notes?draft=2#dusk")
        expect(anchor).to_have_attribute("target", "_blank")
        expect(anchor).to_have_attribute("rel", "noopener noreferrer")
        expect(anchor).to_contain_text("Open link · example.test")
        page.get_by_role("radio", name="Map", exact=True).click()
        node = page.locator(f'.sk-node[data-id="{link["id"]}"]')
        expect(node).to_contain_text("Link · example.test")
        node.click()
        expect(page.get_by_role("link", name="Open link example.test in a new tab")).to_have_attribute("rel", "noopener noreferrer")
        # Another scheme stays plain text: no link is rendered for it.
        page.locator(".sk-canvas").click(position={"x": 600, "y": 400})
        page.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Thought", exact=True).click()
        page.get_by_role("button", name="Cancel", exact=True).click()
        self.paste(page, "javascript:alert(document.cookie)")
        draft = page.get_by_role("form", name="New thought draft")
        expect(draft).to_contain_text("New thought")
        draft.get_by_role("button", name="Save thought", exact=True).click()
        self.wait_stored(page, lambda current: len(current["thoughts"]) == 3)
        expect(page.locator('a[href^="javascript:"]')).to_have_count(0)
        page.get_by_role("radio", name="List", exact=True).click()
        expect(page.locator(".sk-li-link")).to_have_count(1)
        expect(page.locator('a[href^="javascript:"]')).to_have_count(0)
        self.assertEqual(outside, [], "nothing fetched the pasted page")
        shot(page, "map-paste-link-list-desktop")

    def test_04_image_stays_private_staging_until_saved_then_the_project_reads_it(self):
        page = self.page()
        self.open(page, mode="Map")
        writes = self.writes(page)
        page.locator(".sk-canvas").click(position={"x": 600, "y": 400})
        # The image wins over text that comes with it.
        self.paste(page, "image alt text from the clipboard", self.image())
        draft = page.get_by_role("form", name="New thought draft")
        expect(draft).to_contain_text("New image")
        caption = draft.get_by_label("Image caption")
        expect(caption).to_have_value("Pasted image")
        preview = draft.locator("img.sk-draft__img")
        expect(preview).to_be_visible()
        page.wait_for_function(f"() => {{ const el = document.querySelector('img.sk-draft__img'); return el && ({NATURAL})(el) === 48; }}")
        self.assertEqual([method for method, url in writes], ["POST"], "only the private staging upload")
        self.assertIn(f"/api/v1/projects/{self.project}/files?", writes[0][1])
        self.assertEqual(self.stored(self.owner), self.before)
        file_id = page.evaluate("() => Object.keys(sessionStorage).filter(k => k.startsWith('flux:thought-draft:')).map(k => JSON.parse(sessionStorage.getItem(k)).file.id)[0]")
        self.assertEqual(self.owner.request.get(f"/api/v1/files/{file_id}").status, 404, "nobody else reads private staging")
        page.reload()
        draft = page.get_by_role("form", name="New thought draft")
        expect(draft.locator("img.sk-draft__img")).to_be_visible()
        draft.get_by_label("Image caption").fill("Dusk test print of the lamp")
        shot(page, "map-paste-image-draft-desktop")
        draft.get_by_role("button", name="Save image", exact=True).click()
        expect(page.get_by_role("form", name="New thought draft")).to_have_count(0)
        saved = self.wait_stored(self.owner, lambda current: len(current["thoughts"]) == 2)
        thought = next(t for t in saved["thoughts"] if t["id"] != self.parent)
        self.assertEqual(thought["text"], "Dusk test print of the lamp")
        self.assertEqual(thought["file"]["id"], file_id)
        self.assertEqual([thought["width"], thought["height"]], [240, 200])
        download = self.owner.request.get(f"/api/v1/files/{file_id}")
        self.assertEqual(download.status, 200, "project read after confirmation")
        self.assertEqual(download.body(), IMAGE)
        node = page.locator(f'.sk-node[data-id="{thought["id"]}"]')
        expect(node.locator("img.sk-img")).to_be_visible()
        self.assertEqual(node.locator("img.sk-img").evaluate(NATURAL), 48)
        shot(page, "map-paste-image-map-desktop")
        # Remove and Undo restore the same thought with the same image.
        node.click()
        page.get_by_role("toolbar", name="Selection actions").get_by_role("button", name="Remove from sketch").click()
        self.wait_stored(self.owner, lambda current: len(current["thoughts"]) == 1)
        page.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Undo", exact=True).click()
        restored = self.wait_stored(self.owner, lambda current: len(current["thoughts"]) == 2)
        self.assertEqual(next(t for t in restored["thoughts"] if t["id"] == thought["id"])["file"], thought["file"])
        reader = self.page("viewer")
        self.open(reader)
        expect(reader.locator(f'li[data-id="{thought["id"]}"] img.sk-li-img')).to_be_visible()

    def test_05_viewer_private_map_and_unsupported_files_are_refused_before_any_upload(self):
        reader = self.page("viewer")
        self.open(reader, mode="Map")
        writes = self.writes(reader)
        reader.locator(".sk-canvas").click(position={"x": 600, "y": 400})
        self.paste(reader, "A viewer's idea")
        expect(reader.locator(".sk-status--readonly")).to_have_text(VIEW_ONLY)
        self.paste(reader, None, self.image())
        expect(reader.locator(".sk-status--readonly")).to_have_text(VIEW_ONLY)
        expect(reader.get_by_role("form")).to_have_count(0)
        self.assertEqual(writes, [], "a viewer's paste uploads and writes nothing")
        page = self.page()
        self.open(page)
        writes = self.writes(page)
        refusals = (
            ({"base64": "", "size": 5 * 1024 * 1024 + 1, "name": "huge.png", "type": "image/png"}, "an image on a map is at most 5 MB"),
            (self.image(b'<svg xmlns="http://www.w3.org/2000/svg"/>', "drawing.svg", "image/svg+xml"), "Only PNG, JPEG, GIF or WebP"),
            (self.image(b"lux,gestures\n5,38%\n", "readings.png", "image/png"), "not a PNG, JPEG, GIF or WebP image"),
            (self.image(b"%PDF-1.7", "brief.pdf", "application/pdf"), "Only PNG, JPEG, GIF or WebP"),
        )
        for file, message in refusals:
            self.paste(page, None, file)
            expect(page.locator(".sk-status")).to_contain_text(message)
            expect(page.get_by_role("form")).to_have_count(0)
        self.assertEqual(writes, [], "refused files are never uploaded")
        # Stored files belong to a project: a private map refuses an image but still takes text.
        private = self.api(page, "POST", f"/api/v1/workspaces/{self.workspace}/sketches", {"title": "Jonas's notes", "scope": "private"}, 201)["id"]
        page.goto(f"/map/{private}")
        expect(page.locator(".sk-head")).to_be_visible()
        self.paste(page, None, self.image())
        expect(page.locator(".sk-status")).to_contain_text("Images can be added to a project’s maps only")
        self.assertEqual(writes, [])
        self.paste(page, "Private text still pastes")
        expect(page.get_by_role("form", name="New thought draft").get_by_label("Thought text")).to_have_value("Private text still pastes")
        self.assertEqual(writes, [])

    def test_07_nothing_new_starts_while_a_pasted_image_uploads(self):
        page = self.page()
        self.open(page)
        held = []
        page.route("**/api/v1/projects/*/files?*", lambda route: held.append(route))
        self.paste(page, None, self.image())
        expect(page.locator(".sk-draft--uploading")).to_contain_text("Uploading the pasted image privately")
        for _ in range(50):
            if held:
                break
            page.wait_for_timeout(100)
        self.assertEqual(len(held), 1, "the private upload is in flight")
        # An edit or a new thought started now would be replaced by the image draft when the upload finishes.
        row = page.locator(f'.sk-li-t[data-id="{self.parent}"]')
        row.focus()
        row.press("F2")
        expect(page.locator(".sk-status")).to_contain_text("Wait for the pasted image to finish uploading")
        expect(page.get_by_label("Thought text", exact=True)).to_have_count(0)
        page.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Thought", exact=True).click()
        expect(page.get_by_role("form")).to_have_count(0)
        row.focus()
        self.paste(page, "Another idea while uploading")
        expect(page.locator(".sk-status")).to_contain_text("Wait for the pasted image to finish uploading")
        held[0].continue_()
        draft = page.get_by_role("form", name="New thought draft")
        expect(draft.get_by_label("Image caption")).to_have_value("Pasted image")
        draft.get_by_role("button", name="Cancel", exact=True).click()
        expect(page.get_by_role("form")).to_have_count(0)
        self.assertEqual(self.stored(self.owner), self.before, "a cancelled image leaves nothing shared")

    def test_08_a_failed_row_stops_the_run_keeps_the_rest_and_retries_with_the_same_keys(self):
        page = self.page()
        self.open(page)
        path = f"**/api/v1/sketches/{self.sketch}/thoughts"
        failed = []

        def second_fails(route):
            failed.append((route.request.post_data_json, route.request.headers["idempotency-key"]))
            if len(failed) == 2:
                route.fulfill(status=503, json={"message": "test: temporarily unavailable"})
            else:
                route.continue_()

        page.route(path, second_fails)
        self.paste(page, "Dim at dusk\nHold to switch off\nDouble tap to read")
        draft = page.get_by_role("form", name="Pasted thoughts draft")
        draft.get_by_label("Pasted thought 1 of 3", exact=True).press("Enter")
        expect(page.locator(".sk-status")).to_contain_text("Saved 1 of 3 thoughts. The other 2 are kept in your draft")
        expect(draft.get_by_role("textbox")).to_have_count(2)
        expect(draft.get_by_label("Pasted thought 1 of 2", exact=True)).to_have_value("Hold to switch off")
        expect(draft.get_by_label("Pasted thought 2 of 2", exact=True)).to_have_value("Double tap to read")
        self.assertEqual(len(failed), 2, "the failed row stops the run")
        stored = self.stored(self.owner)
        self.assertEqual(sorted(t["text"] for t in stored["thoughts"] if t["id"] != self.parent), ["Dim at dusk"], "only the confirmed row is shared")
        page.unroute(path, second_fails)
        retried = []
        page.on("request", lambda r: retried.append((r.post_data_json, r.headers["idempotency-key"])) if r.method == "POST" and r.url.endswith(f"/{self.sketch}/thoughts") else None)
        draft.get_by_role("button", name="Save 2 thoughts").click()
        expect(page.get_by_role("form", name="Pasted thoughts draft")).to_have_count(0)
        saved = self.wait_stored(self.owner, lambda current: len(current["thoughts"]) == 4)
        self.assertEqual(sorted(t["text"] for t in saved["thoughts"] if t["id"] != self.parent), ["Dim at dusk", "Double tap to read", "Hold to switch off"])
        self.assertEqual(retried[0], failed[1], "the retry keeps the failed row's thought ID, text and request key")
        self.assertEqual(len(retried), 2)

    def test_06_phone_paste_fills_the_empty_draft_through_the_clipboard_prompt(self):
        page = self.page(clipboard=True, viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        self.open(page)
        writes = self.writes(page)
        page.evaluate("text => navigator.clipboard.writeText(text)", LINES)
        page.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Thought", exact=True).tap()
        page.get_by_role("button", name="Paste lines, a link or an image", exact=True).tap()
        draft = page.get_by_role("form", name="Pasted thoughts draft")
        expect(draft.get_by_role("textbox")).to_have_count(3)
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"])
        for box in [draft.get_by_role("textbox").nth(i).bounding_box() for i in range(3)] + [draft.get_by_role("button", name="Remove pasted thought 1 of 3").bounding_box()]:
            self.assertGreaterEqual(box["height"], 44, "touch targets")
            self.assertLessEqual(box["x"] + box["width"], PHONE["width"])
        self.assertEqual(writes, [])
        shot(page, "map-paste-lines-phone")
        draft.get_by_role("button", name="Save 3 thoughts").tap()
        self.wait_stored(page, lambda current: len(current["thoughts"]) == 4)
        # An image through the same prompt.
        page.evaluate("""async (b64) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
        }""", base64.b64encode(IMAGE).decode())
        page.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Thought", exact=True).tap()
        page.get_by_role("button", name="Paste lines, a link or an image", exact=True).tap()
        draft = page.get_by_role("form", name="New thought draft")
        expect(draft.locator("img.sk-draft__img")).to_be_visible()
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"])
        shot(page, "map-paste-image-phone")
        draft.get_by_role("button", name="Save image", exact=True).tap()
        saved = self.wait_stored(page, lambda current: len(current["thoughts"]) == 5)
        self.assertEqual(sum(1 for t in saved["thoughts"] if t.get("file")), 1)


if __name__ == "__main__":
    unittest.main()
