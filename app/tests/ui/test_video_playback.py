"""Browser tests for videos that play inside Flux (C-61, #1352): the row with its poster, the dark viewer with the browser's own controls,
seeking by byte ranges, a browser that cannot play the file, the composer's poster and limits, and the phone.

Runs through scripts/check_ui.sh test_video_playback (FLUX_UI_BROWSER selects chromium, the default, or webkit). The test stack gives the
API FLUX_VIDEO_MAX_MIB=12. The API half (ranges, limits, sniffing, access, posters) is tests/app/video-files.test.ts.

What a test browser decodes depends on its build: Playwright's Chromium and its Linux WebKit ship without some proprietary codecs (H.264/AAC
above all). The tests ask the browser what it plays (`canPlayType`), print it, and assert what Flux must do in each case: play and seek
where the browser can, and say "This browser can't play this video." with Download where it cannot. The VP9 WebM fixture is the one a
Chromium of the test image plays; a file whose codec nothing plays (the MOV with its codec's name changed) is the deterministic negative.
"""

from __future__ import annotations

import os
import re
import time
import unittest
import uuid
from pathlib import Path

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, start_forwarder
from test_file_messages import png

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")
SHOTS = os.environ.get("FLUX_UI_SCREENSHOTS")
PASSWORD = "videos need a place"
STAMP = int(time.time() * 1000)
PEOPLE = {"ada": ("Ada Nowak", f"ada.video+{STAMP}@example.test"), "jonas": ("Jonas Berg", f"jonas.video+{STAMP}@example.test")}
FIXTURES = Path(__file__).parent / "fixtures" / "video"
MP4, WEBM, MOV = ((FIXTURES / name).read_bytes() for name in ("clip.mp4", "clip.webm", "clip.mov"))
# A MOV whose video codec has a name no browser knows: a container that sniffs as a video and plays nowhere.
ODD_CODEC = MOV.replace(b"avc1", b"zzz1")
MIB = 1024 * 1024
MIME = {"webm": 'video/webm; codecs="vp9, opus"', "mp4": 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'}


class VideoPlayback(unittest.TestCase):
    """One space with four sent videos: a WebM with a poster, an MP4, a MOV, and a MOV no browser can play."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    plays: dict[str, str] = {}

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
        # What this browser decodes (the build decides): printed, so the run says what it could and could not play.
        probe = cls.browser.new_page()
        for kind, mime in MIME.items():
            cls.plays[kind] = probe.evaluate("mime => document.createElement('video').canPlayType(mime)", mime)
        probe.close()
        print(f"\n{UI_BROWSER} canPlayType: {cls.plays}")

        def post(path: str, body: dict) -> dict:
            response = contexts["ada"].request.post(path, data=body, headers={"origin": ORIGIN})
            assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
            return response.json()

        ws = post("/api/v1/workspaces", {"name": "Garden films"})
        post(f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE["jonas"][1], "role": "member"})
        project = post(f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Garden films", "visibility": "restricted"})
        pid = cls.ids["project"] = project["id"]
        post(f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": cls.ids["jonas"]}, "role": "contributor"})

        def send(key: str, name: str, data: bytes, poster: bytes | None = None) -> None:
            response = contexts["ada"].request.post(f"/api/v1/projects/{pid}/files?uploadId={uuid.uuid4()}&name={name}", data=data,
                                                    headers={"origin": ORIGIN, "content-type": "application/octet-stream"})
            assert response.status == 201, response.text()
            staged = response.json()
            assert staged["video"] in ("mp4", "webm", "mov"), staged
            if poster:
                made = contexts["ada"].request.post(f"/api/v1/projects/{pid}/files/{staged['id']}/poster", data=poster,
                                                    headers={"origin": ORIGIN, "content-type": "application/octet-stream"})
                assert made.status == 201, made.text()
            started = post(f"/api/v1/projects/{pid}/conversations", {"body": "", "attachmentIds": [staged["id"]], "clientMessageId": str(uuid.uuid4())})
            cls.ids[key] = started["messages"][0]["id"]
            cls.ids[f"{key}:file"] = staged["id"]
            cls.ids[f"{key}:conversation"] = started["id"]

        bands = [(0.5, (88, 140, 200)), (1.0, (60, 120, 70))]
        send("webm", "Garden walk.webm", WEBM, poster=png(320, 180, bands))
        send("mp4", "Greenhouse tour.mp4", MP4)
        send("mov", "Compost heap.mov", MOV)
        send("odd", "Odd codec.mov", ODD_CODEC)
        for context in contexts.values():
            context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str = "jonas", phone: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who]}
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
        expect(page.locator(f"#message-{self.ids['odd']}")).to_be_visible()
        return page

    def shot(self, page: Page, name: str) -> None:
        if SHOTS:
            page.wait_for_timeout(400)
            page.screenshot(path=os.path.join(SHOTS, f"{name}.png"))

    def row(self, page: Page, key: str, name: str):
        return page.locator(f"#message-{self.ids[key]}").locator(".file-row").filter(has_text=name)

    def test_the_row_shows_its_poster_and_plays_and_seeks_from_ranges_in_the_viewer(self) -> None:
        page = self.page()
        row = self.row(page, "webm", "Garden walk.webm")
        # The poster the sender's browser drew stands in for the page icon, read through the access-checked route like any picture.
        poster = row.locator(".file-row__poster img[src^='blob:']")
        expect(poster).to_be_visible()
        self.assertTrue(poster.evaluate("image => image.naturalWidth > 0 && image.naturalWidth <= 640"), "the poster is a decoded picture of at most 640 px")
        expect(row.locator(".file-row__play")).to_be_visible()
        expect(row.get_by_role("button", name="Play Garden walk.webm")).to_contain_text("Video · 0:02 · ")
        expect(row.get_by_role("link", name="Download Garden walk.webm")).to_have_attribute("href", f"/api/v1/files/{self.ids['webm:file']}")
        # An MP4 sent without a poster keeps the page icon and the same row.
        plain = self.row(page, "mp4", "Greenhouse tour.mp4")
        expect(plain.locator(".file-icon[data-kind=video]")).to_be_visible()
        expect(plain.locator(".file-row__poster")).to_have_count(0)
        self.shot(page, "video-row-1440")

        answers: list[tuple[int, str | None, str | None]] = []
        page.on("response", lambda response: answers.append((response.status, response.request.headers.get("range"), response.headers.get("content-range")))
                if response.url.endswith(f"/api/v1/files/{self.ids['webm:file']}/video") else None)
        row.get_by_role("button", name="Play Garden walk.webm").click()
        viewer = page.get_by_role("dialog")
        expect(viewer).to_be_visible()
        expect(viewer.locator(".photo-viewer__who strong")).to_have_text("Garden walk.webm")
        expect(viewer.locator(".photo-viewer__who span")).to_contain_text("Video · ")
        video = viewer.locator("video.file-viewer__video")
        if not self.plays["webm"]:
            # A browser without VP9 says so, with Download as the one button (still a deterministic outcome of the same file).
            expect(viewer.get_by_text("This browser can't play this video.")).to_be_visible()
            return
        expect(video).to_have_attribute("src", f"/api/v1/files/{self.ids['webm:file']}/video")
        for attribute in ("controls", "playsinline"):
            self.assertTrue(video.evaluate(f"v => v.hasAttribute('{attribute}')"), attribute)
        page.wait_for_function("() => { const v = document.querySelector('video.file-viewer__video'); return v && v.readyState >= 1; }")
        self.assertAlmostEqual(video.evaluate("v => v.duration"), 2.0, delta=0.3)
        # It waits for Play (the drawing: the poster until Play), so opening it never starts sound by itself.
        self.assertTrue(video.evaluate("v => v.paused && !v.autoplay && v.currentTime === 0"), "the video waits for Play")
        self.shot(page, "video-viewer-1440")
        # It seeks: the browser asked the server for byte ranges, and the server answered 206 with the exact Content-Range.
        video.evaluate("v => { v.currentTime = 1.5; }")
        page.wait_for_function("() => { const v = document.querySelector('video.file-viewer__video'); return !v.seeking && v.currentTime >= 1.4; }")
        partial = [item for item in answers if item[0] == 206]
        if UI_BROWSER == "chromium":
            self.assertTrue(partial, f"the browser used range requests: {answers}")
            self.assertTrue(all(item[1] and item[1].startswith("bytes=") for item in partial), partial)
            self.assertTrue(all(re.fullmatch(r"bytes \d+-\d+/\d+", item[2] or "") for item in partial), partial)
        # Playwright's Linux WebKit (GStreamer) fetches a small file whole, with no Range header; Safari's own media stack asks for
        # `bytes=0-1` first and cannot play without the 206. The server's side of that, whichever browser asked, is answered here and
        # for every shape of range in tests/app/video-files.test.ts.
        first = page.request.get(f"/api/v1/files/{self.ids['webm:file']}/video", headers={"range": "bytes=0-1"})
        self.assertEqual(first.status, 206)
        self.assertRegex(first.headers["content-range"], r"^bytes 0-1/\d+$")
        self.assertEqual(first.headers["content-type"], "video/webm")
        self.assertEqual(first.headers["accept-ranges"], "bytes")
        self.assertEqual(first.body(), WEBM[:2])
        # And it plays.
        video.evaluate("v => { v.muted = true; v.currentTime = 0.2; return v.play(); }")
        page.wait_for_function("() => document.querySelector('video.file-viewer__video').currentTime > 0.7", timeout=15000)
        # Escape closes it, stops it and its download, and focus goes back to the row.
        page.keyboard.press("Escape")
        expect(viewer).to_have_count(0)
        expect(page.locator("video.file-viewer__video")).to_have_count(0)
        expect(row.get_by_role("button", name="Play Garden walk.webm")).to_be_focused()

    def test_a_browser_that_cannot_play_the_video_says_so_and_offers_download(self) -> None:
        page = self.page()
        # No browser has a decoder for this codec's name; the container itself is a MOV by its bytes (the server accepted it as one).
        self.row(page, "odd", "Odd codec.mov").get_by_role("button", name="Play Odd codec.mov").click()
        viewer = page.get_by_role("dialog")
        expect(viewer.get_by_text("This browser can't play this video.")).to_be_visible()
        download = viewer.locator(".file-viewer__state").get_by_role("link", name="Download")
        expect(download).to_have_attribute("href", f"/api/v1/files/{self.ids['odd:file']}")
        expect(download).to_have_attribute("download", "Odd codec.mov")
        expect(viewer.get_by_role("alert")).to_have_count(0)
        # Readable on the viewer's black: the viewer's own light text, not the grey of a light sheet.
        light = viewer.get_by_text("This browser can't play this video.").evaluate(
            "p => getComputedStyle(p).color.match(/[\\d.]+/g).slice(0, 3).map(Number).every(c => c > 200)")
        self.assertTrue(light, "the message is light on the black stage")
        self.shot(page, "video-unsupported-1440")
        # The download itself is the whole file, as sent.
        self.assertEqual(page.request.get(f"/api/v1/files/{self.ids['odd:file']}").body(), ODD_CODEC)
        page.keyboard.press("Escape")
        expect(viewer).to_have_count(0)

    def test_an_mp4_and_a_mov_play_where_the_browser_has_the_codec_and_say_so_where_it_does_not(self) -> None:
        page = self.page()
        for key, name in (("mp4", "Greenhouse tour.mp4"), ("mov", "Compost heap.mov")):
            with self.subTest(file=name):
                self.row(page, key, name).get_by_role("button", name=f"Play {name}").click()
                viewer = page.get_by_role("dialog")
                if self.plays["mp4"]:
                    page.wait_for_function("() => { const v = document.querySelector('video.file-viewer__video'); return v && (v.readyState >= 1 || v.error); }")
                    self.assertAlmostEqual(viewer.locator("video").evaluate("v => v.duration"), 2.0, delta=0.3)
                else:
                    expect(viewer.get_by_text("This browser can't play this video.")).to_be_visible()
                page.keyboard.press("Escape")
                expect(viewer).to_have_count(0)

    def test_the_composer_draws_a_poster_sends_a_video_over_five_mib_and_refuses_one_over_the_cap(self) -> None:
        page = self.page("ada")
        field = page.get_by_label("Write a message", exact=True)
        with page.expect_file_chooser() as chooser:
            page.get_by_role("button", name="Attach files").click()
        # Bigger than the 5 MiB of a file and under this stack's 12 MiB video cap: the container of the WebM, then filler.
        filler = 6 * MIB - len(WEBM) - 9
        long_clip = WEBM + b"\xec\x01" + filler.to_bytes(7, "big") + b"\x00" * filler  # an EBML Void element after the Segment
        chooser.value.set_files([{"name": "Long walk.webm", "mimeType": "video/webm", "buffer": long_clip},
                                 {"name": "Too long.mp4", "mimeType": "video/mp4", "buffer": MP4 + b"\x00" * (13 * MIB)}])
        draft = page.get_by_role("list", name="Files in your draft")
        expect(draft.get_by_role("listitem")).to_have_count(2)
        too_long = draft.get_by_role("listitem").filter(has_text="Too long.mp4")
        expect(too_long.get_by_role("alert")).to_have_text("A video can be at most 12 MiB.")
        long = draft.get_by_role("listitem").filter(has_text="Long walk.webm")
        expect(long).to_contain_text("Ready, private")
        expect(long).to_contain_text("Video · ")
        expect(page.get_by_text("videos 12 MiB", exact=False)).to_be_visible()
        too_long.get_by_role("button", name="Remove Too long.mp4").click()
        if self.plays["webm"] and UI_BROWSER == "chromium":
            expect(long.locator("img[src^='blob:']")).to_be_visible(timeout=20000)
        self.shot(page, "video-composer-1440")
        field.fill("A long walk through the beds")
        field.press("Enter")
        message = page.locator(".message-bubble").filter(has_text="A long walk through the beds").last
        expect(message.get_by_role("button", name="Play Long walk.webm")).to_be_visible()
        # Chromium draws the first frame of the clip. Playwright's Linux WebKit (GStreamer) paints a canvas of a video black; Flux then keeps
        # the page icon rather than a black poster, so a poster there is either absent or a real frame (Safari itself is not under test).
        poster = message.locator(".file-row__poster img[src^='blob:']")
        if UI_BROWSER == "webkit":
            page.wait_for_timeout(4000)
        if self.plays["webm"] and (UI_BROWSER == "chromium" or poster.count()):
            expect(poster).to_be_visible(timeout=20000)
            # A frame of the video, not a black rectangle: the clip's colour bars at 0.1 s are bright.
            brightness = poster.evaluate("""async image => {
                await image.decode();
                const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
                const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
                const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
                let total = 0; for (let i = 0; i < data.length; i += 4) total += (data[i] + data[i + 1] + data[i + 2]) / 3;
                return total / (data.length / 4);
            }""")
            self.assertGreater(brightness, 40, f"the poster drawn in {UI_BROWSER} shows the video's first frame (mean brightness {brightness:.1f})")

    def test_the_phone_draws_the_same_row_and_a_viewer_that_fills_the_screen(self) -> None:
        page = self.page(phone=True)
        row = self.row(page, "webm", "Garden walk.webm")
        row.scroll_into_view_if_needed()
        box = row.bounding_box()
        self.assertGreaterEqual(box["height"], 55.9, "the row keeps its 56 px")
        self.assertLessEqual(box["x"] + box["width"], PHONE["width"] + 0.5, "the row fits the phone")
        expect(row.locator(".file-row__poster")).to_be_visible()
        self.shot(page, "video-row-390")
        row.get_by_role("button", name="Play Garden walk.webm").click()
        viewer = page.get_by_role("dialog")
        expect(viewer).to_be_visible()
        close = viewer.get_by_role("button", name="Close preview").bounding_box()
        self.assertGreaterEqual(min(close["width"], close["height"]), 43.999, "the touch minimum")
        stage = viewer.locator(".photo-viewer__stage").bounding_box()
        self.assertLessEqual(stage["width"], PHONE["width"] + 0.5)
        if self.plays["webm"]:
            video = viewer.locator("video.file-viewer__video")
            expect(video).to_be_visible()
            page.wait_for_function("() => document.querySelector('video.file-viewer__video').readyState >= 1")
            inside = video.bounding_box()
            self.assertLessEqual(inside["width"], stage["width"] + 0.5)
            self.assertLessEqual(inside["height"], stage["height"] + 0.5)
            self.assertTrue(video.evaluate("v => v.hasAttribute('controls') && v.hasAttribute('playsinline')"))
        self.shot(page, "video-viewer-390")


if __name__ == "__main__":
    unittest.main()
