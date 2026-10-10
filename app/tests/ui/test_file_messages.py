"""Browser tests for files, references and photos inside the message (#154 PR #225, #348 F-026 §6).

Runs with the other tests/ui journeys through scripts/check_ui.sh. A message posted through the API
with attachments and no text shows its files as downloads, not an empty bubble, and a task made from
it gets a readable title instead of an empty one. File rows carry the type icon and Download, photos
form a frameless grid read only through the access-checked route, the viewer is always dark, and the
composer stages thumbnails (#348). FLUX_UI_BROWSER selects chromium (default) or webkit, as in test_settings.
"""

from __future__ import annotations

import os
import re
import struct
import time
import unittest
import uuid
import zlib
from urllib.parse import urlparse

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, start_forwarder

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")

PASSWORD = "files need a place"
STAMP = int(time.time() * 1000)
OWNER = {"name": "Ola Wren", "email": f"ola.wren+{STAMP}@example.test"}
BYTES = b"lux,gestures\n5,38%\n"


class FileOnlyMessage(unittest.TestCase):
    pw = None
    browser: Browser

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

    def test_a_file_only_message_shows_its_files_and_makes_a_titled_task(self) -> None:
        context = self.browser.new_context(base_url=ORIGIN, viewport=DESKTOP, locale="en-GB", service_workers="block")
        self.addCleanup(context.close)
        request = context.request
        headers = {"origin": ORIGIN}
        self.assertEqual(request.post("/api/auth/sign-up/email", data={**OWNER, "password": PASSWORD}, headers=headers).status, 200)

        def post(path: str, body: dict) -> dict:
            response = request.post(path, data=body, headers=headers)
            self.assertIn(response.status, (200, 201), f"{path}: {response.status} {response.text()}")
            return response.json()

        ws = post("/api/v1/workspaces", {"name": "Lamp lab"})
        project = post(f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Low light", "visibility": "restricted"})
        upload = request.post(f"/api/v1/projects/{project['id']}/files?uploadId={uuid.uuid4()}&name=readings.csv",
                              data=BYTES, headers={**headers, "content-type": "application/octet-stream"})
        self.assertEqual(upload.status, 201, upload.text())
        file = upload.json()
        started = post(f"/api/v1/projects/{project['id']}/conversations",
                       {"body": "", "attachmentIds": [file["id"]], "clientMessageId": str(uuid.uuid4())})
        message_id = started["messages"][0]["id"]

        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(f"/projects/{project['id']}/conversations/{started['id']}")
        message = page.locator(f"#message-{message_id}")
        files = message.get_by_role("list", name="1 attached file")
        link = files.get_by_role("link", name="readings.csv")
        expect(link).to_have_attribute("href", f"/api/v1/files/{file['id']}")
        expect(link).to_have_attribute("download", "readings.csv")
        expect(files).to_contain_text(f"{len(BYTES)} B")
        expect(message.locator("> .message-bubble > p")).to_have_count(0)
        downloaded = page.request.get(f"/api/v1/files/{file['id']}")
        self.assertEqual(downloaded.body(), BYTES)

        message.hover()
        more = message.get_by_role("button", name="Make from this message")
        if more.count():
            more.click()
        with page.expect_response(lambda response: response.request.method == "POST" and response.url.endswith(f"/projects/{project['id']}/work")) as created:
            message.get_by_role("button", name="Task", exact=True).click()
        self.assertEqual(created.value.status, 201, created.value.text())
        self.assertEqual(created.value.json()["title"], "1 attached file")
        expect(page.get_by_role("alert")).to_have_count(0)
        items = request.get(f"/api/v1/projects/{project['id']}/work?limit=100").json()["items"]
        self.assertEqual([item["title"] for item in items], ["1 attached file"])
        self.assertEqual(errors, [], "no uncaught page errors")



def png(width: int, height: int, bands: list[tuple[float, tuple[int, int, int]]], post: tuple[int, int, int] | None = None) -> bytes:
    """A real PNG of horizontal bands (sky, hills, soil), with an optional sensor post in the middle."""
    rows = []
    for y in range(height):
        colour = next(c for limit, c in bands if y < limit * height)
        row = bytearray()
        for x in range(width):
            row += bytes(post if post and abs(x - width // 2) < 3 and 0.3 * height < y < 0.85 * height else colour)
        rows.append(b"\x00" + bytes(row))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"".join(rows))) + chunk(b"IEND", b"")


FIELD = png(320, 240, [(0.42, (205, 223, 232)), (0.6, (122, 158, 104)), (0.66, (156, 110, 70)), (1.0, (96, 70, 46))], (90, 90, 90))
BOARD = png(320, 240, [(0.2, (196, 160, 116)), (0.24, (120, 92, 64)), (0.5, (196, 160, 116)), (0.54, (120, 92, 64)), (1.0, (40, 40, 40))])
SHED = png(320, 240, [(0.55, (196, 216, 230)), (0.85, (150, 104, 64)), (1.0, (110, 140, 90))])
BEDS = png(320, 240, [(0.3, (118, 150, 98)), (0.5, (110, 72, 48)), (0.6, (118, 150, 98)), (0.8, (110, 72, 48)), (1.0, (118, 150, 98))])
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n" + b"0" * 310_000
CSV = b"bed,rssi\nfar east,-112\nnorth,-98\n" * 40
VOICE = b"\x00\x00\x00\x18ftypM4A " + b"\x00" * 40_000
NOT_A_PHOTO = b"this is a text file named like a photo\n"
SHOTS = os.environ.get("FLUX_UI_SCREENSHOTS")
# A photo and a log big enough for several progress reports; WebKit has no CDP throttle to slow them down.
PROGRESS_PHOTO = b"\x89PNG\r\n\x1a\n" + os.urandom(3 * 1024 * 1024)
PROGRESS_LOG = b"%PDF-1.4\n" + os.urandom(3 * 1024 * 1024)
# Records each percentage the page renders ("Uploading N%" in a file row or draft, or a photo's data attribute).
PROGRESS_WATCH = """() => {
  const seen = (window.__uploadSeen = []);
  const scan = () => {
    document.querySelectorAll('[data-upload-progress]').forEach((el) => {
      const value = Number(el.dataset.uploadProgress);
      if (seen.at(-1)?.value !== value) seen.push({ where: 'photo', value });
    });
    document.querySelectorAll('small').forEach((el) => {
      const match = /Uploading (\\d+)%/.exec(el.textContent || '');
      if (match && seen.at(-1)?.value !== Number(match[1])) seen.push({ where: 'file', value: Number(match[1]) });
    });
  };
  new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-upload-progress'] });
  scan();
}"""
PEOPLE = {"ada": ("Ada Kowalska", f"ada.files+{STAMP}@example.test"), "jonas": ("Jonas Berg", f"jonas.files+{STAMP}@example.test"),
          "ida": ("Ida Lund", f"ida.files+{STAMP}@example.test")}


class FilesReferencesPhotos(unittest.TestCase):
    """#348: one project with a file message, a photo message, a six-photo message and a renamed non-photo."""

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
        contexts = {}
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            contexts[key] = context

        def post(who: str, path: str, body: dict) -> dict:
            response = contexts[who].request.post(path, data=body, headers={"origin": ORIGIN})
            assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
            return response.json()

        def upload(who: str, name: str, data: bytes) -> str:
            response = contexts[who].request.post(f"/api/v1/projects/{pid}/files?uploadId={uuid.uuid4()}&name={name}", data=data,
                                                  headers={"origin": ORIGIN, "content-type": "application/octet-stream"})
            assert response.status == 201, response.text()
            return response.json()["id"]

        ws = post("ada", "/api/v1/workspaces", {"name": "Community garden"})
        post("ada", f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE["jonas"][1], "role": "member"})
        project = post("ada", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Community garden sensors", "visibility": "restricted"})
        pid = project["id"]
        post("ada", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": cls.ids["jonas"]}, "role": "contributor"})
        post("ada", f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE["ida"][1], "role": "member"})
        post("ada", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": cls.ids["ida"]}, "role": "viewer"})

        def root(who: str, body: str, files: list[tuple[str, bytes]]) -> str:
            ids = [upload(who, name, data) for name, data in files]
            cls.ids.setdefault("photo", ids[0]) if body.startswith("Sensor 3") else None
            started = post(who, f"/api/v1/projects/{pid}/conversations", {"body": body, "attachmentIds": ids, "clientMessageId": str(uuid.uuid4())})
            cls.ids.setdefault("conversation:two", started["messages"][0]["conversationId"]) if body.startswith("Sensor 3") else None
            cls.ids[f"conversation:{started['messages'][0]['id']}"] = started["messages"][0]["conversationId"]
            return started["messages"][0]["id"]

        cls.ids["files"] = root("jonas", "Drawing and range readings from Saturday, see #8 and ask @Ada: https://www.thethingsnetwork.org/docs/gateways/placement-guide/",
                                [("probe-v2-drawing.pdf", PDF), ("lora-range-far-beds.csv", CSV), ("voice-note.m4a", VOICE)])
        cls.ids["two"] = root("jonas", "Sensor 3 is in, far east bed", [("IMG_2041.png", FIELD), ("IMG_2042.png", BOARD)])
        cls.ids["six"] = root("jonas", "All the beds after planting", [(f"bed-{n}.png", data) for n, data in enumerate([SHED, BOARD, BEDS, FIELD, SHED, BEDS])])
        cls.ids["fake"] = root("jonas", "", [("notaphoto.jpg", NOT_A_PHOTO)])
        cls.ids["project"] = pid
        # Real source associations exercise root, thread-root and reply consumers independently.
        cls.ids["files-task"] = post("ada", f"/api/v1/projects/{pid}/work", {
            "title": "Check Saturday range readings", "sources": [{"type": "message", "id": cls.ids["files"]}]})["id"]
        files_conversation = cls.ids[f"conversation:{cls.ids['files']}"]
        cls.ids["photo-reply"] = post("jonas", f"/api/v1/conversations/{files_conversation}/messages", {
            "body": "Reply with the far bed mounting point", "attachmentIds": [upload("jonas", "reply-mount.png", BEDS)],
            "clientMessageId": str(uuid.uuid4())})["id"]
        cls.ids["reply-task"] = post("ada", f"/api/v1/projects/{pid}/work", {
            "title": "Inspect the reply mounting point", "sources": [{"type": "message", "id": cls.ids["photo-reply"]}]})["id"]
        cls.ids["photo-only"] = root("jonas", "", [("bed-without-caption.png", FIELD)])
        task = post("ada", f"/api/v1/projects/{pid}/work", {"title": "Check the mount on sensor 3"})
        cls.ids["task"] = task["id"]
        cls.ids["task-root"] = post("jonas", f"/api/v1/work/{task['id']}/discussion", {"body": "Mount after the rain, see #8 and https://www.thethingsnetwork.org/docs/gateways/placement-guide/", "attachmentIds": [upload("jonas", "IMG_2050.png", BEDS)],
                                                                                   "clientMessageId": str(uuid.uuid4()), "kind": "text"})["id"]
        for context in contexts.values():
            context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str = "ada", phone: bool = False, dark: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who],
                         "color_scheme": "dark" if dark else "light"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(service_workers="block", **options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        page.goto(f"/projects/{self.ids['project']}")
        expect(page.locator(f"#message-{self.ids['two']}")).to_be_visible()
        return page

    def shot(self, page: Page, name: str, target=None) -> None:
        if not SHOTS:
            return
        page.evaluate("document.fonts.ready.then(() => true)")
        page.wait_for_timeout(400)
        (target or page).screenshot(path=os.path.join(SHOTS, f"{name}.png"))

    def message(self, page: Page, key: str):
        return page.locator(f"#message-{self.ids[key]}")

    def assert_caption_below(self, scope, caption_selector: str = ":scope > .message-bubble > p") -> None:
        grid = scope.locator(":scope > .photo-grid")
        caption = scope.locator(caption_selector)
        expect(grid).to_have_count(1)
        expect(caption).to_be_visible()
        # Both reading order and geometry matter: CSS-only reordering is insufficient.
        self.assertTrue(grid.evaluate("(media, caption) => !!(media.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING)", caption.element_handle()), "caption follows the media in document order")
        photo_box, caption_box = grid.bounding_box(), caption.bounding_box()
        self.assertGreaterEqual(caption_box["y"], photo_box["y"] + photo_box["height"] - 0.001, "descriptive caption is below the complete photo/grid")

    def assert_grid_aligned(self, scope) -> None:
        """The photo starts on its caption's left edge, own messages included (F-026 AC-3: one group)."""
        grid = scope.locator(":scope > .photo-grid")
        bubble = scope.locator(":scope > .message-bubble")
        expect(grid).to_have_count(1)
        expect(bubble).to_be_visible()
        self.assertLess(abs(grid.bounding_box()["x"] - bubble.bounding_box()["x"]), 1, "the photo and its caption share one left edge")

    def assert_meta_below_caption(self, scope) -> None:
        """A single photo's name and size come after its caption, not between the photo and the caption (F-026 §6)."""
        meta = scope.locator(":scope > .photo-meta")
        bubble = scope.locator(":scope > .message-bubble")
        expect(meta).to_have_count(1)
        expect(bubble).to_be_visible()
        meta_box, bubble_box = meta.bounding_box(), bubble.bounding_box()
        self.assertGreaterEqual(meta_box["y"], bubble_box["y"] + bubble_box["height"] - 0.001, "the name and size follow the caption")

    def assert_inside_bubble(self, scope, child) -> None:
        expect(scope.locator(":scope > .message-bubble")).to_be_visible()
        expect(child).to_be_visible()
        contained = child.evaluate("e => { const b = e.closest('.message-bubble'); if (!b) return false; const a = b.getBoundingClientRect(), r = e.getBoundingClientRect(); return r.left >= a.left && r.top >= a.top && r.right <= a.right + .001 && r.bottom <= a.bottom + .001; }")
        self.assertTrue(contained, "the complete file/reference card sits inside the message's single bubble")

    def check_files_and_references(self, page: Page, phone: bool) -> None:
        files = self.message(page, "files")
        files.scroll_into_view_if_needed()
        rows = files.get_by_role("list", name="3 attached files")
        pdf = rows.get_by_role("link", name="probe-v2-drawing.pdf")
        expect(pdf).to_have_attribute("download", "probe-v2-drawing.pdf")
        expect(pdf).to_contain_text("PDF · 302.8 KiB")
        expect(pdf).to_contain_text("Download")
        expect(pdf.locator("svg.file-icon[data-kind=pdf] .file-icon__band")).to_have_count(1)
        expect(pdf.locator(".file-icon__label")).to_have_text("PDF")
        csv = rows.get_by_role("link", name="lora-range-far-beds.csv")
        expect(csv).to_contain_text("Table · ")
        expect(csv.locator(".file-icon__label")).to_have_text("CSV")
        expect(csv.locator(".file-icon__band")).to_have_count(0)  # negative control: only PDF has the band
        voice = rows.locator(".voice-note")
        expect(voice.get_by_role("button", name="Play voice-note.m4a")).to_be_visible()
        expect(voice.locator(".voice-note__wave rect")).to_have_count(22)
        expect(voice.get_by_role("link")).to_have_count(0)
        # Text and files are children of one padded surface, rather than adjacent lookalike cards.
        self.assert_inside_bubble(files, rows)
        expect(files.locator(":scope > .message-bubble > p")).to_have_count(1)
        # Inline chips on the text baseline, and the link's preview.
        body = files.locator("> .message-bubble > p")
        expect(body.locator(".ref-chip[data-ref=task]")).to_have_text("#8")
        expect(body.locator(".ref-chip[data-ref=person]")).to_have_text("@Ada")
        expect(body).to_contain_text("see #8 and ask @Ada:")
        for chip in (body.locator(".ref-chip[data-ref=task]"), body.locator(".ref-chip[data-ref=person]")):
            self.assertEqual(chip.evaluate("el => getComputedStyle(el).verticalAlign"), "baseline")
            drift = chip.evaluate("""el => { const r = document.createRange(); const t = el.previousSibling; r.setStart(t, t.length - 1); r.setEnd(t, t.length);
                const a = r.getBoundingClientRect(), b = el.getBoundingClientRect(); return Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2); }""")
            self.assertLessEqual(drift, 3, "chip sits on the text line")
        preview = files.get_by_role("list", name="Link preview").get_by_role("link")
        expect(preview).to_contain_text("thethingsnetwork.org")
        expect(preview).to_contain_text("placement guide")
        expect(preview).to_have_attribute("rel", "noopener noreferrer nofollow")
        expect(self.message(page, "two").locator(".link-previews")).to_have_count(0)  # negative control: no address, no card
        if phone:
            at_least_44(self, voice.get_by_role("button").bounding_box()["height"])
            self.assertLessEqual(page.locator("body").evaluate("el => el.scrollWidth"), PHONE["width"])

    def check_photos(self, page: Page) -> None:
        two = self.message(page, "two")
        two.scroll_into_view_if_needed()
        grid = two.get_by_role("list", name="2 photos")
        tiles = grid.get_by_role("listitem")
        expect(tiles).to_have_count(2)
        expect(grid.locator("img[src^='blob:']")).to_have_count(2)
        self.assertEqual(grid.evaluate("el => getComputedStyle(el).borderTopLeftRadius"), "16px")
        expect(two.locator(".file-row")).to_have_count(0)  # no file frame around a photo
        self.assert_caption_below(two)
        six = self.message(page, "six")
        six.scroll_into_view_if_needed()
        expect(six.get_by_role("list", name="6 photos").get_by_role("listitem")).to_have_count(4)
        expect(six.locator(".photo-grid__more")).to_have_text("+2")
        expect(six.locator(".photo-grid__more")).to_have_count(1)
        self.assert_caption_below(six)
        photo_only = self.message(page, "photo-only")
        expect(photo_only.locator(".photo-grid img[src^='blob:']")).to_have_count(1)
        expect(photo_only.locator(":scope > .message-bubble")).to_be_hidden()
        expect(photo_only.locator(":scope > .photo-meta")).to_contain_text("bed-without-caption.png · ")
        expect(six.locator(".photo-meta")).to_have_count(0)  # several photos: no single name and size line
        self.assertEqual(photo_only.locator(":scope > .message-bubble").evaluate("e => [e.offsetWidth, e.offsetHeight]"), [0, 0], "no empty padded bubble below a captionless photo")
        fake = self.message(page, "fake")
        fake.scroll_into_view_if_needed()
        expect(fake.get_by_role("link", name="notaphoto.jpg")).to_be_visible()  # negative control: bytes decide, not the name
        expect(fake.locator("img")).to_have_count(0)

    def check_viewer(self, page: Page) -> None:
        two = self.message(page, "two")
        opener = two.get_by_role("button", name="Open photo IMG_2041.png, 1 of 2")
        opener.click()
        viewer = page.get_by_role("dialog")
        expect(viewer).to_contain_text("Jonas Berg")
        expect(viewer).to_contain_text("1 of 2")
        expect(viewer).to_contain_text("Sensor 3 is in, far east bed")
        self.assertEqual(viewer.evaluate("el => getComputedStyle(el).backgroundColor"), "rgb(0, 0, 0)")
        box = viewer.bounding_box()
        size = page.viewport_size
        self.assertEqual((round(box["width"]), round(box["height"])), (size["width"], size["height"]), "full screen")
        for name in ("Reply", "Create task", "Share"):
            expect(viewer.get_by_role("button", name=name, exact=True)).to_be_visible()
        expect(viewer.get_by_role("link", name="Save")).to_have_attribute("download", "IMG_2041.png")
        expect(viewer.locator("img[src^='blob:']")).to_be_visible()
        expect(viewer.get_by_role("button", name="Close photo")).to_be_focused()
        page.keyboard.press("ArrowRight")
        expect(viewer).to_contain_text("2 of 2")
        expect(viewer).to_contain_text("IMG_2042.png")
        page.keyboard.press("Tab")
        page.keyboard.press("Shift+Tab")
        self.assertTrue(viewer.evaluate("el => el.contains(document.activeElement)"), "focus stays in the viewer")

    def close_viewer(self, page: Page) -> None:
        page.keyboard.press("Escape")
        expect(page.get_by_role("dialog")).to_have_count(0)

    def test_desktop_light_and_dark(self) -> None:
        for dark in (False, True):
            with self.subTest(dark=dark):
                page = self.page(dark=dark)
                self.check_files_and_references(page, phone=False)
                self.check_photos(page)
                mode = 'dark' if dark else 'light'
                self.shot(page, f"desktop-1440-files-{mode}", self.message(page, "files"))
                self.shot(page, f"desktop-1440-photos-{mode}", self.message(page, "two"))
                self.shot(page, f"desktop-1440-grid-{mode}", self.message(page, "six"))
                self.check_viewer(page)
                self.shot(page, f"viewer-1440-{'dark' if dark else 'light'}")
                self.close_viewer(page)
                expect(self.message(page, "two").get_by_role("button", name="Open photo IMG_2041.png, 1 of 2")).to_be_focused()

    def test_phone_touch_light_and_dark(self) -> None:
        for dark in (False, True):
            with self.subTest(dark=dark):
                page = self.page(phone=True, dark=dark)
                self.check_files_and_references(page, phone=True)
                self.check_photos(page)
                mode = 'dark' if dark else 'light'
                self.shot(page, f"phone-390-files-{mode}", self.message(page, "files"))
                self.shot(page, f"phone-390-photos-{mode}", self.message(page, "two"))
                self.shot(page, f"phone-390-grid-{mode}", self.message(page, "six"))
                self.message(page, "two").get_by_role("button", name="Open photo IMG_2041.png, 1 of 2").tap()
                viewer = page.get_by_role("dialog")
                expect(viewer).to_contain_text("1 of 2")
                self.assertEqual(viewer.evaluate("el => getComputedStyle(el).backgroundColor"), "rgb(0, 0, 0)")
                for control in (viewer.get_by_role("button", name="Reply", exact=True), viewer.get_by_role("button", name="Create task", exact=True),
                                viewer.get_by_role("link", name="Save"), viewer.get_by_role("button", name="Share", exact=True)):
                    at_least_44(self, control.bounding_box()["height"])
                self.shot(page, f"viewer-390-{'dark' if dark else 'light'}")
                viewer.get_by_role("button", name="Create task", exact=True).tap()
                expect(viewer).to_have_count(0)

    def open_in(self, page: Page, scope, name: str):
        opener = scope.get_by_role("button", name=name)
        opener.scroll_into_view_if_needed()
        opener.click()
        viewer = page.get_by_role("dialog", name="Jonas Berg")
        expect(viewer.locator("img[src^='blob:']")).to_be_visible()
        return opener, viewer

    def create_task_from(self, page: Page, viewer, message_id: str) -> None:
        """Create task in the viewer stores a task whose source is that message (read back from the API)."""
        with page.expect_response(lambda r: r.request.method == "POST" and r.url.endswith("/work")) as created:
            viewer.get_by_role("button", name="Create task", exact=True).click()
        expect(viewer).to_have_count(0)
        self.assertEqual(created.value.status, 201, created.value.text())
        work_id = created.value.json()["id"]
        stored = page.request.get(f"/api/v1/projects/{self.ids['project']}/work-associations?messageIds={message_id}&relation=source&limit=100")
        self.assertEqual(stored.status, 200, stored.text())
        body = stored.json()
        self.assertIn(work_id, [row["id"] for row in body["items"]], "the stored task is associated with the photo's message as its source")
        self.assertGreaterEqual(next(item["work"] for item in body["sources"] if item["messageId"] == message_id), 1)

    def test_photo_actions_and_escape_in_threads_details_and_agents(self) -> None:
        """#369 review: Reply/Create task stay on an opening message; Escape closes only the photo."""
        for phone in (False, True):
            with self.subTest(phone=phone, surface="thread"):
                page = self.page("ada", phone=phone)
                page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation:two']}")
                root = page.locator(".thread__root")
                self.assert_caption_below(root)
                opener, viewer = self.open_in(page, root, "Open photo IMG_2041.png, 1 of 2")
                page.keyboard.press("Escape")
                expect(viewer).to_have_count(0)
                expect(root).to_be_visible()  # the thread stays open
                expect(opener).to_be_focused()
                _, viewer = self.open_in(page, root, "Open photo IMG_2041.png, 1 of 2")
                viewer.get_by_role("button", name="Reply", exact=True).click()
                expect(viewer).to_have_count(0)
                expect(page.locator("#thread-composer")).to_be_focused()
                if not phone:
                    _, viewer = self.open_in(page, root, "Open photo IMG_2041.png, 1 of 2")
                    self.create_task_from(page, viewer, self.ids["two"])
            with self.subTest(phone=phone, surface="details"):
                page = self.page("ada", phone=phone)
                page.goto(f"/projects/{self.ids['project']}/tasks?open=work:{self.ids['task']}")
                details = page.get_by_role("region", name="Discussion")
                self.assert_caption_below(details, ":scope > .message-bubble .wd-discussion__body")
                self.assert_meta_below_caption(details)
                expect(details.locator(".wd-discussion__body .ref-chip[data-ref=task]")).to_have_text("#8")
                expect(details.get_by_role("list", name="Link preview")).to_be_visible()
                self.assertEqual(details.locator("a a").count(), 0, "a link in the discussion card is not nested in the card's own link")
                opener, viewer = self.open_in(page, details, "Open photo IMG_2050.png")
                page.keyboard.press("Escape")
                expect(viewer).to_have_count(0)
                expect(details).to_be_visible()  # Escape closed the photo, not Details
                expect(opener).to_be_focused()
                page.keyboard.press("Escape")  # a second Escape still closes Details (negative control)
                expect(details).to_have_count(0)
                page.goto(f"/projects/{self.ids['project']}/tasks?open=work:{self.ids['task']}")
                _, viewer = self.open_in(page, details, "Open photo IMG_2050.png")
                viewer.get_by_role("button", name="Reply", exact=True).click()
                expect(details.get_by_label("Write to this task")).to_be_focused()
                if phone:
                    _, viewer = self.open_in(page, details, "Open photo IMG_2050.png")
                    self.create_task_from(page, viewer, self.ids["task-root"])
            with self.subTest(phone=phone, surface="agents"):
                page = self.page("jonas", phone=phone)
                page.goto(f"/projects/{self.ids['project']}/agents?task={self.ids['task']}")
                thread = page.get_by_role("region", name="Thread of Check the mount on sensor 3")
                agent_root = thread.locator(f'[data-message-id="{self.ids["task-root"]}"]')
                self.assert_caption_below(agent_root)
                self.assert_meta_below_caption(agent_root)
                expect(agent_root.locator(".ref-chip[data-ref=task]")).to_have_text("#8")
                expect(agent_root.get_by_role("list", name="Link preview")).to_be_visible()
                opener, viewer = self.open_in(page, thread, "Open photo IMG_2050.png")
                expect(viewer.get_by_role("button", name="Create task", exact=True)).to_be_visible()
                viewer.get_by_role("button", name="Reply", exact=True).click()
                expect(page.get_by_label("Write to this task")).to_be_focused()
                if not phone:
                    _, viewer = self.open_in(page, thread, "Open photo IMG_2050.png")
                    self.create_task_from(page, viewer, self.ids["task-root"])
            with self.subTest(phone=phone, surface="reader"):
                page = self.page("ida", phone=phone)
                page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation:two']}")
                _, viewer = self.open_in(page, page.locator(".thread__root"), "Open photo IMG_2041.png, 1 of 2")
                expect(viewer.get_by_role("button", name="Save")).to_have_count(0)
                expect(viewer.get_by_role("link", name="Save")).to_be_visible()
                for name in ("Reply", "Create task"):  # a reader cannot reply or add work
                    expect(viewer.get_by_role("button", name=name, exact=True)).to_have_count(0)
                page.keyboard.press("Escape")
            with self.subTest(phone=phone, surface="stream-reader"):
                page = self.page("ida", phone=phone)
                page.goto(f"/projects/{self.ids['project']}")
                _, viewer = self.open_in(page, self.message(page, "two"), "Open photo IMG_2041.png, 1 of 2")
                for name in ("Reply", "Create task"):  # the stream offers no reply either: it does not navigate to one
                    expect(viewer.get_by_role("button", name=name, exact=True)).to_have_count(0)
                expect(viewer.get_by_role("link", name="Save")).to_be_visible()
                page.keyboard.press("Escape")
                expect(viewer).to_have_count(0)
                self.assertEqual(urlparse(page.url).path, f"/projects/{self.ids['project']}", "the stream stays where it is")

    def test_native_references_share_root_and_reply_bubbles(self) -> None:
        for phone in (False, True):
            for dark in (False, True):
                with self.subTest(phone=phone, dark=dark):
                    page = self.page(phone=phone, dark=dark)
                    root = self.message(page, "files")
                    reference = root.locator(f'.ws-chip[data-work-id="{self.ids["files-task"]}"]')
                    root.scroll_into_view_if_needed()
                    self.assert_inside_bubble(root, reference)
                    expect(reference).to_have_count(1)
                    expect(root.locator(":scope > .message-bubble > p")).to_contain_text("Drawing and range readings")
                    if not phone and not dark:
                        # Negative controls reproduce the exact prior defects without mocking the API.
                        reference.evaluate("e => { const card = e.parentElement; card.before(Object.assign(document.createElement('span'), {id: 'reference-slot'})); card.closest('[data-message-id]').append(card); }")
                        try:
                            with self.assertRaises(AssertionError):
                                self.assert_inside_bubble(root, reference)
                        finally:
                            reference.evaluate("e => { const slot = document.getElementById('reference-slot'); slot.replaceWith(e.parentElement); }")
                        self.assert_inside_bubble(root, reference)
                        photo = self.message(page, "two")
                        photo.evaluate("e => e.insertBefore(e.querySelector(':scope > .message-bubble'), e.querySelector(':scope > .photo-grid'))")
                        try:
                            with self.assertRaises(AssertionError):
                                self.assert_caption_below(photo)
                        finally:
                            photo.evaluate("e => e.querySelector(':scope > .photo-grid').after(e.querySelector(':scope > .message-bubble'))")
                        self.assert_caption_below(photo)
                    conversation = self.ids[f"conversation:{self.ids['files']}"]
                    page.goto(f"/projects/{self.ids['project']}/conversations/{conversation}")
                    thread_root = page.locator(".thread__root")
                    self.assert_inside_bubble(thread_root, thread_root.locator(f'.ws-chip[data-work-id="{self.ids["files-task"]}"]'))
                    # The thread's root shows the same inline chip and link preview as the stream (no raw text).
                    expect(thread_root.locator(".ref-chip[data-ref=task]")).to_have_text("#8")
                    expect(thread_root.get_by_role("list", name="Link preview")).to_be_visible()
                    reply = page.locator(f'#message-{self.ids["photo-reply"]}')
                    self.assert_inside_bubble(reply, reply.locator(f'.ws-chip[data-work-id="{self.ids["reply-task"]}"]'))
                    self.assert_caption_below(reply)
                    # The task card under a photo fills the photo's width, not the caption's fit-content width.
                    bubble = reply.locator(":scope > .message-bubble").bounding_box()
                    grid = reply.locator(":scope > .photo-grid").bounding_box()
                    card = reply.locator(f'.ws-chip[data-work-id="{self.ids["reply-task"]}"]').bounding_box()
                    self.assertGreaterEqual(bubble["width"], grid["width"] - 1, "the caption bubble is as wide as the photo")
                    self.assertGreaterEqual(card["width"], bubble["width"] - 26 - 1, "the task card fills its bubble")

    def test_composer_thumbnails_drop_and_photo_states(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                field = page.get_by_label("Write a message", exact=True)
                with page.expect_file_chooser() as chooser:
                    page.get_by_role("button", name="Attach files").click()
                chooser.value.set_files([{"name": "IMG_3001.png", "mimeType": "image/png", "buffer": FIELD},
                                         {"name": "IMG_3002.png", "mimeType": "image/png", "buffer": BOARD},
                                         {"name": "probe-offsets.xlsx", "mimeType": "application/octet-stream", "buffer": b"PK\x03\x04" + b"0" * 12000}])
                draft = page.get_by_role("list", name="Files in your draft")
                expect(draft.get_by_role("listitem")).to_have_count(3)
                expect(draft.get_by_text("Ready, private", exact=False)).to_have_count(3)
                expect(draft.locator(".composer-thumb.is-photo img[src^='blob:']")).to_have_count(2)
                expect(draft.locator(".composer-thumb:not(.is-photo) .file-icon__label")).to_have_text("XLSX")
                orders = draft.locator(".composer-thumb__order")
                if phone:
                    expect(orders).to_have_text(["Sends 1.", "Sends 2.", "Sends 3."])
                    remove = draft.get_by_role("button", name="Remove IMG_3001.png").bounding_box()
                    at_least_44(self, min(remove["width"], remove["height"]))
                else:
                    expect(orders).to_have_count(0)  # numbering is the phone's
                field.fill("Here are the offsets for the volunteers")
                self.shot(page, f"composer-{'390' if phone else '1440'}")
                draft.get_by_role("button", name="Remove probe-offsets.xlsx").click()
                expect(draft.get_by_role("listitem")).to_have_count(2)
                if phone:
                    expect(orders).to_have_text(["Sends 1.", "Sends 2."])
                # Dropping a file onto the conversation attaches it; a drag without files does not.
                target = page.locator(".project-convo")
                transfer = page.evaluate_handle("""() => { const t = new DataTransfer(); t.items.add(new File(['bed,rssi\\n'], 'dropped.csv', { type: 'text/csv' })); return t; }""")
                target.dispatch_event("dragenter", {"dataTransfer": transfer})
                expect(target).to_have_class(lambda_re("is-dropping"))
                target.dispatch_event("drop", {"dataTransfer": transfer})
                expect(draft.get_by_role("listitem")).to_have_count(3)
                expect(draft).to_contain_text("dropped.csv")
                text_only = page.evaluate_handle("() => { const t = new DataTransfer(); t.setData('text/plain', 'just words'); return t; }")
                target.dispatch_event("drop", {"dataTransfer": text_only})
                expect(draft.get_by_role("listitem")).to_have_count(3)
                draft.get_by_role("button", name="Remove dropped.csv").click()
                # Sending: the photos show the state on themselves; a server failure puts Retry on the photo.
                held = []
                page.route("**/api/v1/projects/*/conversations", lambda route: held.append(route) if route.request.method == "POST" else route.continue_())
                if phone:
                    page.get_by_role("button", name="Send message").tap()
                else:
                    field.press("Enter")
                pending = page.locator("[data-client-message-id]").last
                expect(pending.locator(".photo-grid__tile[data-photo-state=sending]")).to_have_count(2)
                expect(pending.locator(".photo-grid__tile img[src^='blob:']")).to_have_count(2)
                self.assert_caption_below(pending)
                self.assert_grid_aligned(pending)
                self.shot(page, f"sending-{'390' if phone else '1440'}", pending)
                for _ in range(50):
                    if held:
                        break
                    page.wait_for_timeout(100)
                held[0].fulfill(status=500, json={"code": "TEST", "message": "Test failure"})
                expect(pending.locator(".photo-grid__tile[data-photo-state=failed]")).to_have_count(2)
                expect(pending.locator(".photo-grid__retry")).to_have_count(2)
                expect(pending.get_by_role("button", name="Retry", exact=True)).to_have_count(1)  # one Retry for assistive technology
                self.shot(page, f"failed-{'390' if phone else '1440'}", pending)
                page.unroute("**/api/v1/projects/*/conversations")
                if phone:
                    retry = pending.locator(".photo-grid__retry").first.bounding_box()
                    at_least_44(self, min(retry["width"], retry["height"]))
                    pending.locator(".photo-grid__retry").first.tap()
                else:
                    pending.locator(".photo-grid__retry").first.click()
                expect(page.locator("[data-client-message-id]")).to_have_count(0)
                sent = page.locator(".project-convo__message").filter(has_text="Here are the offsets for the volunteers").last
                expect(sent.get_by_role("list", name="2 photos").locator("img[src^='blob:']")).to_have_count(2)
                self.assert_grid_aligned(sent)

    def test_upload_progress_shows_a_percentage_until_sending(self) -> None:
        """#348 AC-3: a photo and a file sent while they upload show their real percentage, then "Sending" (WebKit too)."""
        page = self.page()
        if UI_BROWSER == "chromium":
            # Playwright emulates the upload speed only through CDP, so the bytes take a few seconds to go out.
            cdp = page.context.new_cdp_session(page)
            cdp.send("Network.enable")
            cdp.send("Network.emulateNetworkConditions", {"offline": False, "latency": 0, "downloadThroughput": -1, "uploadThroughput": 1024 * 1024})
        # Each file's request waits here until the test lets its bytes go, so the message is sent while they are still uploading.
        held: list = []
        page.route(re.compile(r"/api/v1/projects/[^/]+/files\?"), lambda route: held.append(route) if route.request.method == "POST" else route.continue_())
        # Every percentage the page shows, as it is rendered: a fast upload may finish between two polls.
        page.evaluate(PROGRESS_WATCH)
        with page.expect_file_chooser() as chooser:
            page.get_by_role("button", name="Attach files").click()
        chooser.value.set_files([{"name": "IMG_6001.png", "mimeType": "image/png", "buffer": PROGRESS_PHOTO},
                                 {"name": "bed-log.pdf", "mimeType": "application/pdf", "buffer": PROGRESS_LOG}])
        field = page.get_by_label("Write a message", exact=True)
        field.fill("Photo and log from bed four, sent while they upload")
        field.press("Enter")
        pending = page.locator("[data-client-message-id]").last
        expect(pending.locator("[data-upload-progress='0']")).to_have_count(1)  # the photo tile starts at 0%
        for index in range(2):
            for _ in range(400):
                if len(held) > index:
                    break
                page.wait_for_timeout(25)
            self.assertGreater(len(held), index, "the file request reached the browser")
            held[index].continue_()
        expect(page.locator("[data-client-message-id]")).to_have_count(0, timeout=60000)
        seen = page.evaluate("() => window.__uploadSeen")
        photo = [entry["value"] for entry in seen if entry["where"] == "photo"]
        log = [entry["value"] for entry in seen if entry["where"] == "file"]
        self.assertTrue(any(0 < value < 100 for value in photo), f"the photo tile never showed a percentage between 0 and 100: {photo}")
        self.assertTrue(any(0 < value < 100 for value in log), f"the file row never showed a percentage between 0 and 100: {log}")
        sent = page.locator(".project-convo__message").filter(has_text="Photo and log from bed four").last
        expect(sent.get_by_role("list", name="1 attached file")).to_contain_text("bed-log.pdf")

    def test_photo_waits_offline_on_the_photo(self) -> None:
        page = self.page()
        with page.expect_file_chooser() as chooser:
            page.get_by_role("button", name="Attach files").click()
        chooser.value.set_files([{"name": "IMG_4001.png", "mimeType": "image/png", "buffer": SHED}])
        expect(page.get_by_role("list", name="Files in your draft").get_by_text("Ready, private", exact=False)).to_have_count(1)
        page.get_by_label("Write a message", exact=True).fill("Shed sensor, once I am back in range")
        page.context.set_offline(True)
        page.get_by_label("Write a message", exact=True).press("Enter")
        pending = page.locator("[data-client-message-id]").last
        expect(pending.locator(".photo-grid__tile[data-photo-state=waiting]")).to_contain_text("Sends when you're back")
        self.assert_grid_aligned(pending)
        self.shot(page, "offline-1440", pending)
        page.context.set_offline(False)
        expect(page.locator("[data-client-message-id]")).to_have_count(0, timeout=20000)

    def test_a_reader_who_loses_access_cannot_open_the_file_or_preview(self) -> None:
        page = self.page("jonas")
        two = self.message(page, "two")
        expect(two.locator("img[src^='blob:']")).to_have_count(2)
        owner = self.browser.new_context(base_url=ORIGIN, storage_state=self.states["ada"], service_workers="block")
        self.addCleanup(owner.close)
        photo = self.ids["photo"]
        self.assertEqual(page.request.get(f"/api/v1/files/{photo}").status, 200)
        grant = owner.request.post(f"/api/v1/projects/{self.ids['project']}/grants", data={"principal": {"kind": "human", "id": self.ids["jonas"]}, "role": "denied"}, headers={"origin": ORIGIN})
        self.assertIn(grant.status, (200, 201), grant.text())
        self.addCleanup(lambda: owner.request.post(f"/api/v1/projects/{self.ids['project']}/grants", data={"principal": {"kind": "human", "id": self.ids["jonas"]}, "role": "contributor"}, headers={"origin": ORIGIN}))
        self.assertIn(page.request.get(f"/api/v1/files/{photo}").status, (403, 404), "the download refuses")
        # The page still on screen reads the photo again for the viewer: it shows nothing of it.
        two.get_by_role("button", name="Open photo IMG_2041.png, 1 of 2").click()
        viewer = page.get_by_role("dialog")
        expect(viewer.get_by_role("alert")).to_have_text("You no longer have access to this photo.")
        expect(viewer.locator("img")).to_have_count(0)
        expect(viewer.get_by_role("button", name="Share")).to_be_disabled()
        self.shot(page, "access-lost-1440")
        page.keyboard.press("Escape")
        # A fresh read previews nothing (negative control: the owner still sees both photos).
        page.reload()
        expect(page.locator("img[src^='blob:']")).to_have_count(0)
        mine = owner.new_page()
        mine.goto(f"/projects/{self.ids['project']}")
        expect(mine.locator(f"#message-{self.ids['two']} img[src^='blob:']")).to_have_count(2)


def at_least_44(case: unittest.TestCase, size: float) -> None:
    """The accepted 44 px touch minimum, with only a measurement tolerance of 0.001 px."""
    case.assertGreaterEqual(size, 44 - 0.001, f"{size} px is under the 44 px touch minimum")


class TouchMinimum(unittest.TestCase):
    def test_rejects_anything_under_44_px(self) -> None:
        for size in (43.5, 43.75, 43.99):
            with self.assertRaises(AssertionError):
                at_least_44(self, size)
        for size in (44, 43.9995, 48):
            at_least_44(self, size)


def lambda_re(text: str):
    import re
    return re.compile(rf"(^|\s){re.escape(text)}(\s|$)")


if __name__ == "__main__":
    unittest.main()
