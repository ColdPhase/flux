"""Browser tests for the project wiki as two panes (issue #136, Studio 11.6 UI116-4).

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose
application. A manager, a contributor and a reader share one project with realistic pages. The
page index, its search and its quiet, accessible selection; New page and Import .md (accepted and
refused files); history; downloading a page and exporting the project as real files; sharing a
link; focus mode; unsaved text across pages; phone, small phone and tablet layouts; and measured
Light and Dark contrast. Every write is checked against the API, so the tests prove persisted
behaviour rather than local state.
"""

from __future__ import annotations

import io
import json
import re
import tarfile
import time
import unittest
import uuid
from pathlib import Path

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder
from test_theme_accents import MEASURE

PASSWORD = "wiki pages keep their place"
STAMP = int(time.time() * 1000)
OWNER = {"name": "Hubert Lis", "email": f"hubert.wiki+{STAMP}@example.test"}
PARTNER = {"name": "Marek Wolny", "email": f"marek.wiki+{STAMP}@example.test"}
READER = {"name": "Noa Berg", "email": f"noa.wiki+{STAMP}@example.test"}
PROJECT = "Arduino + AI"
TABLET = {"width": 820, "height": 1180}
SMALL_PHONE = {"width": 320, "height": 640}

LAMP = "How the lamp works"
PARTS = "Parts list"
WIRING = "Connecting the lamp"
LAMP_V1 = """A small project. First we make one gesture work, then we add the rest.

## What we want

Moving a hand closer turns the light on. The gesture should also work in low light.

## What we test

- Gesture recognition in different light
- The delay between the gesture and the light
- Power draw while running

## Running it

```
python capture.py --device 0 --local
```
"""
PRIVACY = """
## Privacy

The image stays on the device. Nothing is sent to the cloud, and processing must work without an internet connection.
"""
PARTS_BODY = """Everything on the bench for the first lamp: an ESP32 board, a VL53L5CX distance sensor, a 12 V LED strip and a solder kit.

| Part | Count | Note |
| --- | ---: | --- |
| ESP32-S3 board | 1 | USB-C |
| VL53L5CX sensor | 2 | one spare |
| LED strip, 12 V | 1 m | warm white |
"""
WIRING_BODY = """Power the strip from the 12 V supply and the board from USB. The sensor shares the board's 3.3 V rail.

1. Connect SDA and SCL to pins 8 and 9.
2. Keep the sensor cable shorter than 20 cm.
"""
IMPORTED = "# Sensor bench notes\n\nThe ToF sensor caught **96%** of gestures at 5 lux.\n\n- Camera: 38%\n- ToF: 96%\n"

# The 3px dot of the open page against its own tint (a non-text mark, WCAG 1.4.11).
DOT = r"""(selector) => {
  const el = document.querySelector(selector);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', {willReadFrequently: true});
  const rgba = (value) => { ctx.clearRect(0,0,1,1); ctx.fillStyle = value; ctx.fillRect(0,0,1,1); const p = ctx.getImageData(0,0,1,1).data; return [p[0],p[1],p[2],p[3]/255]; };
  const over = (a,b) => [0,1,2].map(i => a[i]*a[3] + b[i]*(1-a[3])).concat(1);
  const chain = []; for (let n = el; n; n = n.parentElement) chain.unshift(n);
  const bg = chain.reduce((acc, n) => over(rgba(getComputedStyle(n).backgroundColor), acc), [255,255,255,1]);
  const before = getComputedStyle(el, '::before');
  const fg = over(rgba(before.backgroundColor), bg);
  const lum = (p) => { const c = p.slice(0,3).map(v => { v /= 255; return v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4; }); return c[0]*.2126 + c[1]*.7152 + c[2]*.0722; };
  const l = [lum(fg), lum(bg)].sort((a,b) => b-a);
  return {width: before.width, height: before.height, content: before.content, ratio: (l[0]+.05)/(l[1]+.05)};
}"""


class WikiPanesJourney(unittest.TestCase):
    """Tests run in name order and share three accounts and one project."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    project_id: str = ""
    ids: dict[str, str] = {}

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

    def context(self, who: str | None, *, viewport: dict | None = None, touch: bool = False, theme: str | None = None, **extra) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "accept_downloads": True, **extra}
        if touch:
            options.update(viewport=viewport or PHONE, device_scale_factor=3 if (viewport or PHONE)["width"] < 600 else 2, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=viewport or DESKTOP, device_scale_factor=1)
        if who and who in self.states:
            options["storage_state"] = self.states[who]
        context = self.browser.new_context(**options)
        if theme:
            # The person's own remembered appearance on this device (#135/#148).
            context.add_init_script(f"localStorage.setItem('flux.theme', '{theme}')")
        self.addCleanup(context.close)
        return context

    def page(self, who: str | None, **kwargs) -> Page:
        page = self.context(who, **kwargs).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None, headers: dict | None = None) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method,
                                      headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        try:
            return json.loads(response.text()) if response.text() else {}
        except ValueError:
            return {}

    def docs(self, page: Page) -> list[dict]:
        return self.api(page, "GET", f"/api/v1/projects/{self.project_id}/docs?limit=100", status=200)["items"]

    def doc(self, page: Page, doc_id: str) -> dict:
        return self.api(page, "GET", f"/api/v1/docs/{doc_id}", status=200)

    def url(self, key: str, suffix: str = "") -> str:
        return f"/projects/{self.project_id}/docs/{self.ids[key]}{suffix}"

    def index(self, page: Page):
        return page.get_by_role("navigation", name="Wiki pages")

    def measure(self, page: Page, selector: str, minimum: float = 4.5, **spec) -> dict:
        page.wait_for_function("""spec => {
          const el = document.querySelector(spec.selector); if (!el) return false;
          for (let n = el; n; n = n.parentElement) if (Number(getComputedStyle(n).opacity) !== 1) return false;
          return true;
        }""", arg={"selector": selector}, timeout=5000)
        value = page.evaluate(MEASURE, {"selector": selector, **spec})
        self.assertGreaterEqual(value["ratio"], minimum, value)
        return value

    def no_horizontal_overflow(self, page: Page, width: int) -> None:
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), width, "no horizontal page scroll")
        for selector in (".wiki", ".wiki-main", ".wiki-doc"):
            overflow = page.evaluate(f"(() => {{ const el = document.querySelector('{selector}'); return el.scrollWidth - el.clientWidth; }})()")
            self.assertLessEqual(overflow, 0, f"{selector} does not overflow sideways")

    # ---------------------------------------------------------------- set up

    def test_01_people_and_pages(self) -> None:
        for key, person in (("owner", OWNER), ("partner", PARTNER), ("reader", READER)):
            page = self.page(None)
            page.goto("/sign-up")
            page.get_by_label("Name").fill(person["name"])
            page.get_by_label("Email").fill(person["email"])
            page.get_by_label("Password").fill(PASSWORD)
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            type(self).states[key] = page.context.storage_state()
            person["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        owner = self.page("owner")
        ws = self.api(owner, "POST", "/api/v1/workspaces", {"name": "Bedside lamps"}, status=201)
        for person in (PARTNER, READER):
            self.api(owner, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": person["email"], "role": "member"}, status=201)
        project = self.api(owner, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": PROJECT, "visibility": "restricted"}, status=201)
        type(self).project_id = project["id"]
        for person, role in ((PARTNER, "contributor"), (READER, "viewer")):
            self.api(owner, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "human", "id": person["id"]}, "role": role}, status=201)
        base = f"/api/v1/projects/{project['id']}/docs"
        key = lambda: {"idempotency-key": str(uuid.uuid4())}  # noqa: E731
        wiring = self.api(owner, "POST", base, {"title": WIRING, "body": WIRING_BODY}, status=201, headers=key())
        parts = self.api(owner, "POST", base, {"title": PARTS, "body": PARTS_BODY, "state": "published", "reason": "What we ordered"}, status=201, headers=key())
        lamp_v1 = LAMP_V1 + f"\nThe parts are in [{PARTS}](flux:doc/{parts['id']}).\n"
        lamp = self.api(owner, "POST", base, {"title": LAMP, "body": lamp_v1, "state": "published", "reason": "First notes"}, status=201, headers=key())
        partner = self.page("partner")
        self.api(partner, "PATCH", f"/api/v1/docs/{lamp['id']}", {"body": lamp_v1 + PRIVACY, "reason": "Added the privacy section"}, status=200,
                 headers={"if-match": '"1"', **key()})
        type(self).ids = {"lamp": lamp["id"], "parts": parts["id"], "wiring": wiring["id"]}
        self.assertEqual([item["id"] for item in self.docs(owner)][0], lamp["id"], "the lamp page is the latest change")

    # ---------------------------------------------------------------- index and selection

    def test_02_wiki_tab_opens_a_page_with_a_quiet_accessible_selection(self) -> None:
        page = self.page("owner")
        page.goto(f"/projects/{self.project_id}")
        page.get_by_role("navigation", name="Project views").get_by_role("link", name="Wiki").click()
        expect(page, "the Wiki tab opens the latest page").to_have_url(re.compile(re.escape(self.url("lamp")) + "$"))
        expect(page.get_by_role("heading", level=2, name=LAMP)).to_be_visible()
        index = self.index(page)
        items = index.locator(".wiki-page")
        expect(items).to_have_count(3)
        expect(index.locator(".wiki-page__t")).to_have_text([WIRING, LAMP, PARTS])
        expect(index.get_by_role("link", name=WIRING)).to_contain_text("Draft")
        # Exactly one current page, marked by tint, weight and a dot as well as aria-current.
        expect(index.locator('[aria-current="page"]')).to_have_count(1)
        active = index.get_by_role("link", name=LAMP)
        expect(active).to_have_attribute("aria-current", "page")
        expect(index.get_by_role("link", name=PARTS)).not_to_have_attribute("aria-current", "page")
        self.assertEqual(active.evaluate("e => getComputedStyle(e).fontWeight"), "600")
        self.assertEqual(index.get_by_role("link", name=PARTS).evaluate("e => getComputedStyle(e).fontWeight"), "450")
        dot = page.evaluate(DOT, '.wiki-page[aria-current="page"]')
        self.assertEqual((dot["width"], dot["height"]), ("3px", "3px"), "a small marker beside the label")
        self.assertGreaterEqual(dot["ratio"], 3, dot)
        tint = active.evaluate("e => getComputedStyle(e).backgroundColor")
        self.assertNotIn(tint, ("rgba(0, 0, 0, 0)", "transparent"), "the open page has a quiet tint")
        self.assertNotEqual(tint, index.evaluate("e => getComputedStyle(e).backgroundColor"), "the tint differs from the index")
        # Studio 11.6 geometry: a 212px index, a 57px bar and an 820px document with 30px titles.
        self.assertAlmostEqual(index.bounding_box()["width"], 212, delta=1)
        self.assertAlmostEqual(page.locator(".wiki-bar").bounding_box()["height"], 57, delta=1)
        self.assertLessEqual(page.locator(".wiki-doc").bounding_box()["width"], 820.5)
        title = page.get_by_role("heading", level=2, name=LAMP)
        self.assertEqual(title.evaluate("e => [getComputedStyle(e).fontSize, getComputedStyle(e).fontWeight]"), ["30px", "650"])
        prose = page.locator(".doc-prose")
        self.assertEqual(prose.evaluate("e => [getComputedStyle(e).fontSize, getComputedStyle(e).lineHeight]"), ["14px", "25.9px"])
        self.assertEqual(prose.locator("h2").first.evaluate("e => [getComputedStyle(e).fontSize, getComputedStyle(e).fontWeight, getComputedStyle(e).borderBottomStyle]"), ["20px", "600", "none"])
        # Keyboard: from the search field, Tab reaches each page; the open one shows a visible ring.
        search = index.get_by_label("Search the wiki")
        search.focus()
        page.keyboard.press("Tab")
        expect(index.get_by_role("link", name=WIRING)).to_be_focused()
        page.keyboard.press("Tab")
        expect(active).to_be_focused()
        page.wait_for_timeout(250)
        self.assertTrue(active.evaluate("e => e.matches(':focus-visible')"))
        self.assertEqual(active.evaluate("e => [getComputedStyle(e).outlineStyle, getComputedStyle(e).outlineWidth]"), ["solid", "2px"])
        self.measure(page, '.wiki-page[aria-current="page"]', 3, property="outlineColor", backgroundSelector=".wiki-index")
        shot(page, "wiki-desktop-1440-focus-ring")
        page.keyboard.press("Tab")
        expect(index.get_by_role("link", name=PARTS)).to_be_focused()
        page.keyboard.press("Enter")
        expect(page).to_have_url(re.compile(re.escape(self.url("parts")) + "$"))
        expect(page.get_by_role("heading", level=2, name=PARTS)).to_be_visible()
        expect(index.get_by_role("link", name=PARTS)).to_have_attribute("aria-current", "page")
        expect(active).not_to_have_attribute("aria-current", "page")
        # The doc link inside the lamp page shows up as a backlink here.
        expect(page.get_by_role("region", name=re.compile("^Linked from"))).to_contain_text(LAMP)
        # Moving to another tab and back returns to the page last open here.
        page.get_by_role("navigation", name="Project views").get_by_role("link", name=re.compile("^Tasks")).click()
        expect(page).to_have_url(re.compile(r"/tasks"))
        page.get_by_role("navigation", name="Project views").get_by_role("link", name="Wiki").click()
        expect(page).to_have_url(re.compile(re.escape(self.url("parts")) + "$"))

    def test_03_index_search(self) -> None:
        page = self.page("owner")
        page.goto(self.url("lamp"))
        index = self.index(page)
        search = index.get_by_label("Search the wiki")
        # The search reads titles and the first words of each page.
        search.fill("solder")
        expect(index.get_by_role("status")).to_have_text("1 page")
        expect(index.locator(".wiki-page__t")).to_have_text([PARTS])
        search.fill("LAMP")
        expect(index.get_by_role("status")).to_have_text("3 pages")
        expect(index.get_by_role("link", name=LAMP)).to_have_attribute("aria-current", "page")
        search.fill("zeppelin")
        expect(index.get_by_role("status")).to_have_text("No pages match “zeppelin”.")
        expect(index.locator(".wiki-page")).to_have_count(0)
        shot(page, "wiki-search-empty-desktop-1440")
        search.press("Escape")
        expect(search).to_have_value("")
        expect(index.locator(".wiki-page")).to_have_count(3)
        expect(index.get_by_role("status")).to_have_count(0)

    # ---------------------------------------------------------------- new page and import

    def test_04_new_page(self) -> None:
        page = self.page("owner")
        page.goto(self.url("lamp"))
        index = self.index(page)
        index.get_by_role("link", name="New page").click()
        expect(page).to_have_url(re.compile(r"/docs/new$"))
        expect(index.get_by_role("link", name="New page")).to_have_attribute("aria-current", "page")
        expect(index.locator('.wiki-page[aria-current="page"]')).to_have_count(0)
        expect(page.locator(".wiki-bar")).to_contain_text("New page")
        page.get_by_label("Title").fill("Bench test log")
        page.get_by_label("Text (Markdown)").fill("## Monday\n\n- 38% of gestures at 5 lux with the camera\n")
        page.get_by_label("Text (Markdown)").press("Control+s")
        expect(page.get_by_role("heading", level=2, name="Bench test log")).to_be_visible()
        created = next(item for item in self.docs(page) if item["title"] == "Bench test log")
        type(self).ids["bench"] = created["id"]
        expect(page).to_have_url(re.compile(re.escape(self.url("bench")) + "$"))
        doc = self.doc(page, created["id"])
        self.assertEqual((doc["version"], doc["state"], doc["body"]), (1, "draft", "## Monday\n\n- 38% of gestures at 5 lux with the camera\n"))
        expect(index.get_by_role("link", name="Bench test log")).to_have_attribute("aria-current", "page")
        expect(index.get_by_role("link", name="Bench test log")).to_contain_text("Draft")
        expect(index.locator(".wiki-page")).to_have_count(4)

    def choose_file(self, page: Page, name: str, data: bytes, mime: str) -> None:
        with page.expect_file_chooser() as chooser:
            self.index(page).get_by_role("button", name="Import .md").click()
        chooser.value.set_files({"name": name, "mimeType": mime, "buffer": data})

    def test_05_import_markdown_and_refuse_other_files(self) -> None:
        page = self.page("owner")
        page.goto(self.url("lamp"))
        index = self.index(page)
        before = len(self.docs(page))
        refusals = (
            ("photo.png", b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR", "image/png", "“photo.png” is not a Markdown file. Choose a .md file."),
            ("empty.md", b"", "text/markdown", "“empty.md” is empty."),
            ("huge.md", b"a" * 400_001, "text/markdown", "“huge.md” is too large (401 KB). A page holds up to 100,000 characters."),
            ("long.md", b"a" * 100_001, "text/markdown", "“long.md” has 100,001 characters. A page holds up to 100,000."),
            ("broken.md", b"# Notes\n\n\xff\xfe\xfa not text", "text/markdown", "“broken.md” is not readable UTF-8 text"),
        )
        for name, data, mime, message in refusals:
            with self.subTest(file=name):
                self.choose_file(page, name, data, mime)
                alert = index.get_by_role("alert")
                expect(alert).to_contain_text(message)
                expect(index.get_by_role("button", name="Import .md")).to_have_attribute("aria-describedby", alert.get_attribute("id"))
                expect(page).to_have_url(re.compile(re.escape(self.url("lamp")) + "$"))
                self.assertEqual(len(self.docs(page)), before, f"{name} created no page")
        shot(page, "wiki-import-refused-desktop-1440")
        # A Markdown file becomes a draft page; its first heading is the title.
        self.choose_file(page, "bench-notes.md", IMPORTED.encode(), "text/markdown")
        expect(page.get_by_role("heading", level=2, name="Sensor bench notes")).to_be_visible()
        expect(index.get_by_role("alert")).to_have_count(0)
        expect(page.get_by_text("Imported “Sensor bench notes” as a draft page.")).to_be_visible()
        created = next(item for item in self.docs(page) if item["title"] == "Sensor bench notes")
        type(self).ids["imported"] = created["id"]
        expect(page).to_have_url(re.compile(re.escape(self.url("imported")) + "$"))
        doc = self.doc(page, created["id"])
        self.assertEqual(doc["body"], IMPORTED.split("\n", 2)[2], "the text after the title, exactly")
        self.assertEqual((doc["version"], doc["state"], doc["reason"], doc["author"]["name"]), (1, "draft", "Imported from bench-notes.md", OWNER["name"]))
        expect(page.locator(".doc-prose strong")).to_have_text("96%")
        expect(index.get_by_role("link", name="Sensor bench notes")).to_have_attribute("aria-current", "page")
        # Without a heading, the file name names the page; Windows line ends become plain ones.
        self.choose_file(page, "power_budget.md", "Idle: 0.2 W\r\nRunning: 1.4 W\r\n".encode(), "text/plain")
        expect(page.get_by_role("heading", level=2, name="Power budget")).to_be_visible()
        power = next(item for item in self.docs(page) if item["title"] == "Power budget")
        self.assertEqual(self.doc(page, power["id"])["body"], "Idle: 0.2 W\nRunning: 1.4 W\n")
        self.assertEqual(len(self.docs(page)), before + 2)
        shot(page, "wiki-import-desktop-1440")

    # ---------------------------------------------------------------- history and drafts

    def test_06_history_beside_the_index(self) -> None:
        page = self.page("owner")
        page.goto(self.url("lamp"))
        page.get_by_role("link", name=re.compile("^History")).click()
        expect(page).to_have_url(re.compile(re.escape(self.url("lamp", "/history"))))
        index = self.index(page)
        expect(index).to_be_visible()
        expect(index.get_by_role("link", name=LAMP)).to_have_attribute("aria-current", "page")
        expect(page.locator(".wiki-bar")).to_contain_text("History · 2 versions")
        versions = page.locator(".doc-versions > li")
        expect(versions).to_have_count(2)
        expect(versions.first).to_contain_text("Added the privacy section")
        expect(versions.first).to_contain_text(PARTNER["name"])
        expect(page.get_by_label("Changes in the text").locator(".doc-diff__row--added")).to_contain_text(["## Privacy"])
        shot(page, "wiki-history-desktop-1440")
        page.get_by_role("link", name="Read version 1").click()
        expect(page).to_have_url(re.compile(re.escape(self.url("lamp", "/versions/1")) + "$"))
        expect(page.locator(".doc-head__k")).to_have_text("Published · version 1 of 2")
        expect(page.locator(".doc-notice").first).to_contain_text("You are reading an earlier version")
        expect(page.locator(".doc-prose")).not_to_contain_text("Privacy")
        expect(page.locator(".wiki-bar").get_by_role("link", name="Edit")).to_have_count(0)
        page.get_by_role("link", name="Open the current version").click()
        expect(page.locator(".doc-head__k")).to_have_text("Published · version 2")
        page.get_by_role("link", name=re.compile("^History")).click()
        page.get_by_role("link", name="Back to the page").click()
        expect(page).to_have_url(re.compile(re.escape(self.url("lamp")) + "$"))

    def test_07_unsaved_text_survives_moving_between_pages(self) -> None:
        page = self.page("owner")
        page.goto(self.url("parts"))
        expect(page.get_by_role("heading", level=2, name=PARTS)).to_be_visible()
        # "E" opens the editor, as the Edit button announces.
        page.locator(".wiki-doc").click(position={"x": 5, "y": 5})
        page.keyboard.press("e")
        expect(page).to_have_url(re.compile(re.escape(self.url("parts", "/edit")) + "$"))
        text = page.get_by_label("Text (Markdown)")
        text.fill(PARTS_BODY + "| USB-C cable | 1 | for the bench |\n")
        self.index(page).get_by_role("link", name=LAMP).click()
        expect(page.get_by_role("heading", level=2, name=LAMP)).to_be_visible()
        self.index(page).get_by_role("link", name=PARTS).click()
        kept = page.locator(".wiki-bar").get_by_role("link", name="Unsaved changes in this tab")
        expect(kept).to_be_visible()
        shot(page, "wiki-unsaved-desktop-1440")
        kept.click()
        expect(page.get_by_text("Your unsaved text from earlier is back.")).to_be_visible()
        expect(page.get_by_label("Text (Markdown)")).to_have_value(re.compile("USB-C cable"))
        self.assertNotIn("USB-C cable", self.doc(page, self.ids["parts"])["body"], "nothing was saved without the person")
        page.get_by_role("link", name="Cancel").click()
        expect(page.locator(".wiki-bar").get_by_role("link", name="Unsaved changes in this tab")).to_have_count(0)

    # ---------------------------------------------------------------- download, export and share

    def download(self, page: Page, item: str) -> tuple[str, bytes]:
        page.locator(".wiki-bar").get_by_role("button", name="Download").click()
        dialog = page.get_by_role("dialog", name="Download")
        expect(dialog).to_be_visible()
        with page.expect_download() as info:
            dialog.get_by_role("button", name=re.compile(item)).click()
        download = info.value
        return download.suggested_filename, Path(download.path()).read_bytes()

    def test_08_download_a_page_and_export_the_project(self) -> None:
        page = self.page("owner")
        page.goto(self.url("lamp"))
        name, data = self.download(page, "^This page as Markdown")
        current = self.doc(page, self.ids["lamp"])
        self.assertEqual(name, "how-the-lamp-works.md")
        self.assertEqual(data.decode("utf-8"), f"# {LAMP}\n\n{current['body'].rstrip()}\n")
        expect(page.get_by_role("dialog", name="Download")).to_have_count(0)
        expect(page.locator(".wiki-bar").get_by_role("button", name="Download")).to_be_focused()
        # An earlier version downloads as it was written.
        page.goto(self.url("lamp", "/versions/1"))
        name, data = self.download(page, "^Version 1 as Markdown")
        first = self.api(page, "GET", f"/api/v1/docs/{self.ids['lamp']}/versions/1", status=200)
        self.assertEqual(name, "how-the-lamp-works-v1.md")
        self.assertEqual(data.decode("utf-8"), f"# {LAMP}\n\n{first['body'].rstrip()}\n")
        self.assertNotIn("Privacy", data.decode("utf-8"))
        # A manager exports the whole project through the existing export (#123).
        page.goto(self.url("lamp"))
        page.locator(".wiki-bar").get_by_role("button", name="Download").click()
        shot(page, "wiki-download-desktop-1440")
        page.keyboard.press("Escape")
        name, data = self.download(page, "^Export the whole project")
        self.assertRegex(name, rf"^flux-project-{self.project_id[:8]}-\d{{8}}T\d{{6}}Z\.tar\.gz$")
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as bundle:
            names = bundle.getnames()
            root = name.removesuffix(".tar.gz")
            self.assertIn(f"{root}/project.json", names)
            exported = json.loads(bundle.extractfile(f"{root}/project.json").read())
            page_file = bundle.extractfile(f"{root}/docs/{self.ids['lamp']}.md").read().decode("utf-8")
            manifest = json.loads(bundle.extractfile(f"{root}/manifest.json").read())
        self.assertEqual(exported["project"]["name"], PROJECT)
        lamp = next(item for item in exported["docs"] if item["id"] == self.ids["lamp"])
        self.assertEqual([version["reason"] for version in lamp["versions"]], ["First notes", "Added the privacy section"])
        self.assertEqual(page_file, current["body"])
        self.assertIn(f"docs/{self.ids['lamp']}.md", [item["path"] for item in manifest["files"]])
        expect(page.get_by_text(f"Exported {PROJECT} as {name}.")).to_be_visible()

        # A contributor downloads pages; the project export stays with managers, as the server decides.
        partner = self.page("partner")
        partner.goto(self.url("parts"))
        partner.locator(".wiki-bar").get_by_role("button", name="Download").click()
        dialog = partner.get_by_role("dialog", name="Download")
        expect(dialog.get_by_role("button", name="This page as Markdown")).to_be_visible()
        expect(dialog.get_by_role("button", name=re.compile("Export the whole project"))).to_have_count(0)
        expect(dialog).to_contain_text("People who manage this space can also export the whole project.")
        self.api(partner, "GET", f"/api/v1/projects/{self.project_id}/export?format=bundle", status=403)
        partner.keyboard.press("Escape")
        expect(dialog).to_have_count(0)
        # A reader reads and downloads; nothing to write with.
        reader = self.page("reader")
        reader.goto(self.url("parts"))
        expect(reader.get_by_role("heading", level=2, name=PARTS)).to_be_visible()
        expect(self.index(reader).get_by_role("link", name="New page")).to_have_count(0)
        expect(self.index(reader).get_by_role("button", name="Import .md")).to_have_count(0)
        expect(reader.locator(".wiki-bar").get_by_role("link", name="Edit")).to_have_count(0)
        name, data = self.download(reader, "^This page as Markdown")
        self.assertEqual((name, data.decode("utf-8")), ("parts-list.md", f"# {PARTS}\n\n{PARTS_BODY.rstrip()}\n"))

    def test_09_share_copies_the_exact_link(self) -> None:
        page = self.page("owner", permissions=["clipboard-read", "clipboard-write"])
        page.goto(self.url("lamp"))
        share = page.locator(".wiki-bar").get_by_role("button", name="Share this page")
        share.click()
        dialog = page.get_by_role("dialog", name="Share this page")
        expect(dialog).to_contain_text(f"Opens only for people with access to {PROJECT}")
        expect(dialog).to_contain_text("Marek")
        expect(dialog).to_contain_text("Noa")
        copy = dialog.get_by_role("button", name="Copy link")
        expect(copy).to_be_focused()
        expect(dialog.get_by_label("Link to this page")).to_have_value(f"{ORIGIN}{self.url('lamp')}")
        copy.click()
        expect(dialog.get_by_role("status")).to_have_text("Link copied.")
        expect(dialog.get_by_role("button", name="Copied")).to_be_visible()
        self.assertEqual(page.evaluate("navigator.clipboard.readText()"), f"{ORIGIN}{self.url('lamp')}")
        shot(page, "wiki-share-desktop-1440")
        page.keyboard.press("Escape")
        expect(dialog).to_have_count(0)
        expect(share).to_be_focused()
        # The copied link opens the same page for another person with access.
        partner = self.page("partner")
        partner.goto(page.evaluate("navigator.clipboard.readText()"))
        expect(partner.get_by_role("heading", level=2, name=LAMP)).to_be_visible()
        share.click()
        dialog.get_by_role("button", name="See who has access").click()
        expect(page.locator("#details").get_by_role("heading", name="Who can see this")).to_be_visible()

    # ---------------------------------------------------------------- focus mode

    def test_10_focus_mode_and_return(self) -> None:
        page = self.page("owner")
        page.goto(self.url("lamp"))
        index = self.index(page)
        focus = page.locator(".wiki-bar").get_by_role("button", name="Focus on the page")
        expect(focus).to_have_attribute("aria-pressed", "false")
        narrow = page.locator(".wiki-doc").bounding_box()
        focus.click()
        expect(focus).to_have_attribute("aria-pressed", "true")
        expect(index).to_be_hidden()
        expect(focus).to_be_focused()
        wide = page.locator(".wiki-doc").bounding_box()
        self.assertGreater(wide["width"], narrow["width"])
        self.assertLessEqual(wide["width"], 850.5)
        self.assertLess(wide["x"], narrow["x"], "the document takes the room of the page list")
        shot(page, "wiki-focus-desktop-1440")
        # It stays while moving within the wiki and after a reload in this tab.
        page.goto(self.url("parts"))
        expect(page.get_by_role("heading", level=2, name=PARTS)).to_be_visible()
        expect(index).to_be_hidden()
        page.reload()
        focus = page.locator(".wiki-bar").get_by_role("button", name="Focus on the page")
        expect(focus).to_have_attribute("aria-pressed", "true")
        # Keyboard returns: the same button brings the list back and keeps focus.
        focus.focus()
        page.keyboard.press("Enter")
        expect(focus).to_have_attribute("aria-pressed", "false")
        expect(index).to_be_visible()
        expect(focus).to_be_focused()
        expect(index.get_by_role("link", name=PARTS)).to_have_attribute("aria-current", "page")

    # ---------------------------------------------------------------- phone and tablet

    def test_11_phone_puts_the_index_before_the_document(self) -> None:
        page = self.page("partner", touch=True)
        page.goto(f"/projects/{self.project_id}/docs")
        latest = self.docs(page)[0]
        expect(page).to_have_url(re.compile(re.escape(f"/docs/{latest['id']}") + "$"))
        index = self.index(page)
        heading = page.get_by_role("heading", level=2, name=latest["title"])
        expect(heading).to_be_visible()
        self.assertLessEqual(index.bounding_box()["y"] + index.bounding_box()["height"], page.locator(".wiki-bar").bounding_box()["y"] + 1,
                             "the index sits before the document")
        expect(index.get_by_label("Search the wiki")).to_be_visible()
        for control in (index.get_by_role("link", name="New page"), index.get_by_role("button", name="Import .md"), index.get_by_role("link", name=PARTS)):
            box = control.bounding_box()
            self.assertGreaterEqual(box["height"], 44, "touch target")
        for control in page.locator(".wiki-bar").get_by_role("button").all() + [page.locator(".wiki-bar").get_by_role("link", name="Edit")]:
            box = control.bounding_box()
            self.assertGreaterEqual(box["height"], 44, "touch target in the bar")
            self.assertLessEqual(box["x"] + box["width"], PHONE["width"])
        expect(index.locator('[aria-current="page"]')).to_have_count(1)
        self.no_horizontal_overflow(page, PHONE["width"])
        shot(page, "wiki-phone-390-light")
        index.get_by_role("link", name=PARTS).tap()
        expect(page.get_by_role("heading", level=2, name=PARTS)).to_be_visible()
        current = index.get_by_role("link", name=PARTS)
        expect(current).to_have_attribute("aria-current", "page")
        box = current.bounding_box()
        self.assertGreaterEqual(box["x"], 0)
        self.assertLessEqual(box["x"] + box["width"], PHONE["width"], "the open page is scrolled into the strip")
        # The bar stays at the top while reading a long page, and its cards stay on screen.
        index.get_by_role("link", name=LAMP).tap()
        expect(page.get_by_role("heading", level=2, name=LAMP)).to_be_visible()
        self.assertGreater(page.locator(".wiki").evaluate("e => e.scrollHeight - e.clientHeight"), 200)
        page.locator(".wiki").evaluate("e => e.scrollTo(0, e.scrollHeight)")
        page.wait_for_timeout(200)
        self.assertLessEqual(abs(page.locator(".wiki-bar").bounding_box()["y"] - page.locator(".wiki").bounding_box()["y"]), 1)
        page.locator(".wiki-bar").get_by_role("button", name="Download").tap()
        card = page.get_by_role("dialog", name="Download").bounding_box()
        self.assertGreaterEqual(card["x"], 0)
        self.assertLessEqual(card["x"] + card["width"], PHONE["width"])
        shot(page, "wiki-phone-390-download")
        page.keyboard.press("Escape")
        # A search narrows the strip.
        page.locator(".wiki").evaluate("e => e.scrollTo(0, 0)")
        index.get_by_label("Search the wiki").fill("solder")
        expect(index.locator(".wiki-page__t")).to_have_text([PARTS])
        index.get_by_label("Search the wiki").fill("")
        # The smallest phones keep everything, without sideways scrolling.
        page.set_viewport_size(SMALL_PHONE)
        page.wait_for_timeout(200)
        self.no_horizontal_overflow(page, SMALL_PHONE["width"])
        box = index.get_by_role("link", name=LAMP).bounding_box()
        self.assertGreaterEqual(box["x"], 0)
        self.assertLessEqual(box["x"] + box["width"], SMALL_PHONE["width"], "the open page stays in the strip after a resize")
        for control in (index.get_by_role("link", name="New page"), index.get_by_role("button", name="Import .md")):
            expect(control).to_be_visible()
            box = control.bounding_box()
            self.assertGreaterEqual(box["height"], 44)
            self.assertLessEqual(box["x"] + box["width"], SMALL_PHONE["width"])
        for control in page.locator(".wiki-bar").get_by_role("button").all():
            box = control.bounding_box()
            self.assertLessEqual(box["x"] + box["width"], SMALL_PHONE["width"])
        shot(page, "wiki-phone-320-light")
        # Phone editing keeps its Save within reach, and the text field itself stays uncovered (it is
        # what the caret is in): the page strip steps aside and only Cancel / Save stay sticky.
        page.locator(".wiki-bar").get_by_role("link", name="Edit").tap()
        text = page.get_by_label("Text (Markdown)")
        expect(text).to_be_visible()
        self.no_horizontal_overflow(page, SMALL_PHONE["width"])
        expect(page.get_by_role("button", name="Save version")).to_be_in_viewport()
        expect(page.get_by_role("navigation", name="Wiki pages")).to_be_hidden()
        uncovered = text.evaluate("""el => {
          const r = el.getBoundingClientRect();
          const y = Math.min(r.top + 40, window.innerHeight - 120);
          return document.elementFromPoint(r.left + r.width / 2, y) === el;
        }""")
        self.assertTrue(uncovered, "the writing area is not covered by the bar or the save block")
        save = page.get_by_role("button", name="Save version").bounding_box()
        assert save
        self.assertLessEqual(SMALL_PHONE["height"] - save["y"], 90, "only the actions stay at the bottom")
        shot(page, "wiki-phone-320-editor")

    def test_12_phone_dark(self) -> None:
        page = self.page("owner", touch=True, theme="dark")
        page.goto(self.url("lamp"))
        expect(page.get_by_role("heading", level=2, name=LAMP)).to_be_visible()
        self.no_horizontal_overflow(page, PHONE["width"])
        self.measure(page, '.wiki-page[aria-current="page"]')
        self.measure(page, ".doc-prose p")
        shot(page, "wiki-phone-390-dark")

    def test_13_tablet_keeps_two_panes(self) -> None:
        page = self.page("owner", touch=True, viewport=TABLET)
        page.goto(self.url("lamp"))
        expect(page.get_by_role("heading", level=2, name=LAMP)).to_be_visible()
        index = self.index(page).bounding_box()
        main = page.locator(".wiki-main").bounding_box()
        self.assertLessEqual(index["x"] + index["width"], main["x"] + 1, "the index stands beside the document")
        self.assertAlmostEqual(index["width"], 180, delta=7)
        self.assertGreaterEqual(main["width"], 380, "a readable document column")
        self.assertGreaterEqual(self.index(page).get_by_role("link", name=PARTS).bounding_box()["height"], 44)
        self.no_horizontal_overflow(page, TABLET["width"])
        shot(page, "wiki-tablet-820-light")
        page.locator(".wiki-bar").get_by_role("button", name="Focus on the page").tap()
        expect(self.index(page)).to_be_hidden()
        self.assertGreater(page.locator(".wiki-doc").bounding_box()["width"], main["width"] - 1)
        shot(page, "wiki-tablet-820-focus")
        page.locator(".wiki-bar").get_by_role("button", name="Focus on the page").tap()
        expect(self.index(page)).to_be_visible()

    # ---------------------------------------------------------------- contrast

    def test_14_light_and_dark_contrast(self) -> None:
        for theme in ("light", "dark"):
            with self.subTest(theme=theme):
                page = self.page("owner", theme=theme)
                page.goto(self.url("lamp"))
                expect(page.locator("html")).to_have_attribute("data-theme", theme)
                expect(page.get_by_role("heading", level=2, name=LAMP)).to_be_visible()
                for selector in (".wiki-index__eyebrow", ".wiki-page:not([aria-current])", '.wiki-page[aria-current="page"]', ".wiki-page__state",
                                 ".wiki-index__act", ".wiki-bar__meta .doc-head__k", ".wiki-bar__primary", ".wiki-doc__crumb", ".doc-head__t",
                                 ".doc-head__change", ".doc-prose p", ".doc-prose h2", ".doc-prose li", ".doc-prose pre code", ".doc-prose a",
                                 ".doc-links h3", ".doc-audience"):
                    self.measure(page, selector)
                # Icon buttons and the underline search boundary are non-text marks (3:1).
                self.measure(page, ".wiki-bar .ui-icon-btn", 3)
                self.measure(page, ".wiki-search svg", 3)
                dot = page.evaluate(DOT, '.wiki-page[aria-current="page"]')
                self.assertGreaterEqual(dot["ratio"], 3, dot)
                search = self.index(page).get_by_label("Search the wiki")
                search.fill("lamp")
                self.measure(page, ".wiki-search input")
                search.fill("")
                shot(page, f"wiki-desktop-1440-{theme}")
                # The focus ring and links follow each accent family and stay visible in every one.
                for family in ("mint", "sky", "copper"):
                    page.evaluate(f"document.documentElement.dataset.accent = '{family}'")
                    self.index(page).get_by_role("link", name=PARTS).focus()
                    page.keyboard.press("Shift+Tab")
                    expect(self.index(page).get_by_role("link", name=LAMP)).to_be_focused()
                    page.wait_for_timeout(200)
                    self.measure(page, '.wiki-page[aria-current="page"]', 3, property="outlineColor", backgroundSelector=".wiki-index")
                    self.measure(page, ".doc-prose a")
                    self.assertIn("underline", page.locator(".doc-prose a").first.evaluate("e => getComputedStyle(e).textDecorationLine"), "links are more than colour")
                page.locator(".wiki-bar").get_by_role("button", name="Share this page").click()
                for selector in (".wiki-pop__h", ".wiki-pop__who", ".wiki-pop__link .ui-input"):
                    self.measure(page, selector)
                shot(page, f"wiki-share-desktop-1440-{theme}")


if __name__ == "__main__":
    unittest.main()
