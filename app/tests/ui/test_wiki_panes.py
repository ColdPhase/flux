"""Browser tests for the project wiki as two panes (issue #136, Studio 11.6 UI116-4).

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose
application. A manager and two members share one project with realistic pages. The
page index, its search and its quiet, accessible selection; New page and Import .md (accepted and
refused files); history; downloading a page and exporting the project as real files; sharing a
link; focus mode; unsaved text across pages; phone, small phone and tablet layouts; and measured
Light and Dark contrast. Every write is checked against the API, so the tests prove persisted
behaviour rather than local state.
"""

from __future__ import annotations

import io
import json
import os
import re
import tarfile
import time
import unittest
import uuid
from pathlib import Path

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder
from contrast import MEASURE
from create_window import kind_tab, open_create
from wiki_text import existing_text, saved, saved_version, text_of, type_at_end, wait_until_shared

# WebKit has no clipboard permission to grant (Playwright: "Unknown permission: clipboard-write"): there the page's clipboard is a
# recorder that keeps what was written, so the test reads back exactly what the page copied.
CLIPBOARD_RECORDER = """(() => { let text = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
  writeText: async (value) => { text = String(value); }, readText: async () => text } }); })()"""

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

# The open page in the switcher is marked by its tint, weight, a check and aria-current (#431): no generated ::before box.
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
        cls.browser = getattr(cls.pw, os.environ.get("FLUX_UI_BROWSER", "chromium")).launch()
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
        clipboard = self.browser.browser_type.name == "webkit" and any(str(p).startswith("clipboard") for p in options.get("permissions", []))
        if clipboard:
            options["permissions"] = [p for p in options["permissions"] if not str(p).startswith("clipboard")]
        context = self.browser.new_context(service_workers="block", **options)
        if clipboard:
            context.add_init_script(CLIPBOARD_RECORDER)
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

    def actions(self, page: Page, item: str) -> None:
        """Chooses `item` in the page's ⋯."""
        page.get_by_role("button", name="Page actions").click()
        page.get_by_role("menu", name="Page actions").get_by_role("menuitem", name=item).click()

    def switcher(self, page: Page):
        """Opens the title's page switcher."""
        page.locator(".wiki-page").get_by_role("heading", level=2).get_by_role("button").click()
        return page.get_by_role("dialog", name=f"Pages in {PROJECT}")

    def measure(self, page: Page, selector: str, minimum: float = 4.5, **spec) -> dict:
        # Check opacity and measure in the same browser task: a separate evaluation can land
        # inside the menu's fade after the readiness command observed the pre-animation style.
        measured = page.wait_for_function("""spec => {
          const el = document.querySelector(spec.selector); if (!el) return false;
          for (let n = el; n; n = n.parentElement) if (Number(getComputedStyle(n).opacity) !== 1) return false;
          // A focus ring fades in (outline-color is in --tr): WebKit still reports it transparent more than 250 ms after the
          // focus, so the ring is measured once it has painted, not before.
          if (spec.property === 'outlineColor' && Number((getComputedStyle(el).outlineColor.match(/[\\d.]+/g) || [])[3] ?? 1) === 0) return false;
          return (""" + MEASURE + ")(spec); }", arg={"selector": selector, **spec}, timeout=5000)
        value = measured.json_value()
        measured.dispose()
        self.assertGreaterEqual(value["ratio"], minimum, value)
        return value

    def no_horizontal_overflow(self, page: Page, width: int) -> None:
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), width, "no horizontal page scroll")
        for selector in (".wiki-main", ".wiki-page"):
            overflow = page.evaluate(f"(() => {{ const el = document.querySelector('{selector}'); return el.scrollWidth - el.clientWidth; }})()")
            wide = page.evaluate(f"""(() => {{ const box = document.querySelector('{selector}').getBoundingClientRect();
                return [...document.querySelector('{selector}').querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > box.right + 0.5)
                  .slice(0, 4).map((el) => el.tagName + '.' + el.className + ' ' + Math.round(el.getBoundingClientRect().right - box.right)); }})()""") if overflow > 0 else []
            self.assertLessEqual(overflow, 0, f"{selector} does not overflow sideways (past the edge: {wide})")

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
        for person, role in ((PARTNER, "contributor"), (READER, "contributor")):
            self.api(owner, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "human", "id": person["id"]}, "role": role}, status=201)
        base = f"/api/v1/projects/{project['id']}/docs"
        key = lambda: {"idempotency-key": str(uuid.uuid4())}  # noqa: E731
        wiring = self.api(owner, "POST", base, {"title": WIRING, "body": WIRING_BODY}, status=201, headers=key())
        parts = self.api(owner, "POST", base, {"title": PARTS, "body": PARTS_BODY}, status=201, headers=key())
        lamp_v1 = LAMP_V1 + f"\nThe parts are in [{PARTS}](flux:doc/{parts['id']}).\n"
        lamp = self.api(owner, "POST", base, {"title": LAMP, "body": lamp_v1}, status=201, headers=key())
        partner = self.page("partner")
        self.api(partner, "PATCH", f"/api/v1/docs/{lamp['id']}", {"body": lamp_v1 + PRIVACY}, status=200,
                 headers={"if-match": '"1"', **key()})
        type(self).ids = {"lamp": lamp["id"], "parts": parts["id"], "wiring": wiring["id"]}
        self.assertEqual([item["id"] for item in self.docs(owner)][0], lamp["id"], "the lamp page is the latest change")

    # ---------------------------------------------------------------- the page

    def test_02_wiki_tab_opens_a_page_and_the_title_switches_pages(self) -> None:
        page = self.page("owner")
        page.goto(f"/projects/{self.project_id}/docs")
        expect(page).to_have_url(re.compile(re.escape(self.url("lamp")) + "$"))
        expect(page.get_by_role("heading", level=2, name=LAMP)).to_be_visible()
        expect(page.get_by_role("navigation", name="Wiki pages")).to_have_count(0)
        pages = self.switcher(page)
        expect(pages.get_by_role("link")).to_have_text([WIRING, LAMP, PARTS])
        expect(pages.get_by_role("link", name=LAMP)).to_have_attribute("aria-current", "page")
        self.assertEqual(page.evaluate(DOT, '.wiki-menu__row[aria-current="page"]')["content"], "none", "no pseudo-element dot beside the open page (#431)")
        pages.get_by_label("Find a page").fill("zzz")
        expect(pages).to_contain_text("No page matches “zzz”.")
        pages.get_by_label("Find a page").fill("parts")
        pages.get_by_role("link", name=PARTS).click()
        expect(page.get_by_role("heading", level=2, name=PARTS)).to_be_visible()
        expect(pages).to_have_count(0)
        # The Wiki tab comes back to the page last open in this tab.
        page.goto(f"/projects/{self.project_id}/tasks")
        page.goto(f"/projects/{self.project_id}/docs")
        expect(page).to_have_url(re.compile(re.escape(self.url("parts")) + "$"))

    def test_03_text_is_written_on_the_page_and_versions_save_by_themselves(self) -> None:
        page = self.page("owner")
        page.goto(self.url("parts"))
        text = existing_text(page)
        wait_until_shared(page)
        # The page is edited where it is read: no Write / Preview / Both, no raw Markdown field, no reason or Draft / Published.
        for gone in ("Write", "Preview", "Both", "Draft", "Published", "Save version"):
            expect(page.get_by_role("button", name=gone, exact=True)).to_have_count(0)
        expect(page.get_by_label("Reason for this version")).to_have_count(0)
        expect(page.get_by_label("Text (Markdown)")).to_have_count(0)
        expect(page.locator(".doc-table")).to_have_count(1)  # the table reads as a table until the caret is in it
        before = self.doc(page, self.ids["parts"])
        type_at_end(page, text, "\nThe spare sensor stays in the drawer.")
        doc = saved_version(page, self.ids["parts"], "The spare sensor stays in the drawer.")
        self.assertEqual((doc["version"], doc["reason"], doc["author"]["name"]), (before["version"] + 1, "Edited the text", OWNER["name"]))
        self.assertEqual(doc["body"], text_of(text))
        expect(saved(page)).to_be_visible()
        shot(page, "wiki-written-desktop-1440")
        # A reload reads the page as it was left.
        page.reload()
        wait_until_shared(page)
        expect(text).to_contain_text("The spare sensor stays in the drawer.")

    def test_04_new_page_from_the_switcher(self) -> None:
        page = self.page("owner")
        page.goto(self.url("lamp"))
        pages = self.switcher(page)
        pages.get_by_role("button", name="New page").click()
        pages.get_by_label("Name of the new page").fill("Bench test log")
        page.keyboard.press("Enter")
        expect(page.get_by_role("heading", level=2, name="Bench test log")).to_be_visible()
        created = next(item for item in self.docs(page) if item["title"] == "Bench test log")
        type(self).ids["bench"] = created["id"]
        expect(page).to_have_url(re.compile(re.escape(self.url("bench")) + "$"))
        # The caret is in the new page's text.
        text = existing_text(page)
        wait_until_shared(page)
        expect(text).to_be_focused()
        page.keyboard.insert_text("## Monday\n\n- 38% of gestures at 5 lux with the camera")
        doc = saved_version(page, created["id"], "38% of gestures")
        self.assertEqual(doc["body"], "## Monday\n\n- 38% of gestures at 5 lux with the camera")
        expect(page.locator(".cm-md-h2")).to_have_text("Monday")
        pages = self.switcher(page)
        expect(pages.get_by_role("link", name="Bench test log")).to_have_attribute("aria-current", "page")
        expect(pages.get_by_role("link")).to_have_count(4)

    def typed_ahead_is_kept(self, page: Page, title: str, typed: str) -> None:
        """The new page `title` holds exactly `typed`: in its editor, which has the caret, in its saved version and after a reload."""
        expect(page).to_have_url(re.compile(rf"/projects/{self.project_id}/docs/[0-9a-f-]{{36}}$"))
        # Space and Enter typed while focus was back on the window's opener did not open the Create window again.
        expect(page.get_by_role("dialog")).to_have_count(0)
        text = page.locator(".wiki-page", has=page.get_by_role("heading", level=2, name=title)).locator('.cm-content[aria-label="Page text"]')
        expect(text).to_be_focused()
        created = next(item for item in self.docs(page) if item["title"] == title)
        doc = saved_version(page, created["id"], typed)
        self.assertEqual(doc["body"], typed, "every character typed at once is saved, once and in order")
        expect(saved(page)).to_be_visible()
        page.reload()
        wait_until_shared(page)
        expect(text).to_contain_text(typed.splitlines()[-1])
        self.assertEqual(text_of(text), typed)

    def test_04b_text_typed_at_once_after_create_page_is_kept(self) -> None:
        """#1171: a page made in the Create window opens ready to write. Text typed straight after Create page is pressed, before the
        new page or its editor is there (focus is still on the closing window and then its opener) and before its room has opened,
        is kept: every character is shared and saved, and it is all there after a reload."""
        page = self.page("owner")
        page.goto(self.url("lamp"))
        expect(page.get_by_role("heading", level=2, name=LAMP)).to_be_visible()
        open_create(page)
        kind_tab(page, "Page").click()
        made = page.get_by_role("dialog", name="New page")
        made.get_by_role("textbox", name="Page title").fill("Soldering notes")
        made.get_by_role("button", name=re.compile("^Create page")).click()
        # At once, with no wait for anything and no pause between keys: the window to type into is not there yet.
        typed = "Tin the tip first, then flux the joint and hold the iron for three seconds."
        page.keyboard.type(typed)
        self.typed_ahead_is_kept(page, "Soldering notes", typed)

    def test_04c_title_enter_and_straight_on_keeps_every_key(self) -> None:
        """#1171: the keyboard-only way: type the title, press Enter and keep typing at a person's pace. The first keys land while the
        page is made and opened; none is lost, a new line and a correction (Backspace) included."""
        page = self.page("owner")
        page.goto(self.url("lamp"))
        expect(page.get_by_role("heading", level=2, name=LAMP)).to_be_visible()
        open_create(page)
        kind_tab(page, "Page").click()
        field = page.get_by_role("dialog", name="New page").get_by_role("textbox", name="Page title")
        field.press_sequentially("Flux residue", delay=20)
        field.press("Enter")
        page.keyboard.type("Hello", delay=60)
        page.keyboard.press("Enter")
        page.keyboard.type("Wipe it with alcohol!", delay=60)
        page.keyboard.press("Backspace")
        page.keyboard.type(".", delay=60)
        self.typed_ahead_is_kept(page, "Flux residue", "Hello\nWipe it with alcohol.")

    def choose_file(self, page: Page, name: str, data: bytes, mime: str) -> None:
        with page.expect_file_chooser() as chooser:
            self.actions(page, "Import a Markdown file")
        chooser.value.set_files({"name": name, "mimeType": mime, "buffer": data})

    def test_05_import_markdown_and_refuse_other_files(self) -> None:
        page = self.page("owner")
        page.goto(self.url("lamp"))
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
                alert = page.locator(".wiki-page").get_by_role("alert")
                expect(alert).to_contain_text(message)
                expect(page).to_have_url(re.compile(re.escape(self.url("lamp")) + "$"))
                self.assertEqual(len(self.docs(page)), before, f"{name} created no page")
        shot(page, "wiki-import-refused-desktop-1440")
        # A Markdown file becomes a page; its first heading is the title.
        self.choose_file(page, "bench-notes.md", IMPORTED.encode(), "text/markdown")
        expect(page.get_by_role("heading", level=2, name="Sensor bench notes")).to_be_visible()
        expect(page.get_by_text("Imported “Sensor bench notes”.")).to_be_visible()
        created = next(item for item in self.docs(page) if item["title"] == "Sensor bench notes")
        type(self).ids["imported"] = created["id"]
        expect(page).to_have_url(re.compile(re.escape(self.url("imported")) + "$"))
        expect(page.locator(".wiki-page").get_by_role("alert")).to_have_count(0)
        doc = self.doc(page, created["id"])
        self.assertEqual(doc["body"], IMPORTED.split("\n", 2)[2], "the text after the title, exactly")
        self.assertEqual((doc["version"], doc["reason"], doc["author"]["name"]), (1, "Imported from bench-notes.md", OWNER["name"]))
        wait_until_shared(page)
        expect(page.locator(".wiki-editor .cm-md-strong")).to_have_text("96%")
        self.assertEqual(text_of(existing_text(page)), doc["body"], "the imported Markdown is the page's text, unchanged")
        # Without a heading, the file name names the page; Windows line ends become plain ones.
        self.choose_file(page, "power_budget.md", "Idle: 0.2 W\r\nRunning: 1.4 W\r\n".encode(), "text/plain")
        expect(page.get_by_role("heading", level=2, name="Power budget")).to_be_visible()
        power = next(item for item in self.docs(page) if item["title"] == "Power budget")
        self.assertEqual(self.doc(page, power["id"])["body"], "Idle: 0.2 W\nRunning: 1.4 W\n")
        self.assertEqual(len(self.docs(page)), before + 2)
        shot(page, "wiki-import-desktop-1440")
        # The server saves the import but the answer is lost; choosing the same file again makes no
        # second page: the retry reuses the first attempt's Idempotency-Key (#197 review B3).
        page.goto(self.url("lamp"))
        keys: list[str] = []

        def lose_first(route) -> None:
            if route.request.method != "POST":
                route.continue_()
                return
            keys.append(route.request.headers.get("idempotency-key", ""))
            if len(keys) > 1:
                route.continue_()
                return
            response = route.fetch()
            self.assertEqual(response.status, 201)
            route.abort("failed")

        docs_url = f"**/api/v1/projects/{self.project_id}/docs"
        page.route(docs_url, lose_first)
        retry = "# Retried import\n\nSaved once even when the answer was lost.\n"
        self.choose_file(page, "retried.md", retry.encode(), "text/markdown")
        expect(page.locator(".wiki-page").get_by_role("alert")).to_contain_text("Check the connection and try again")
        with page.expect_response(lambda r: r.request.method == "POST" and r.url.endswith(f"/api/v1/projects/{self.project_id}/docs")) as again:
            self.choose_file(page, "retried.md", retry.encode(), "text/markdown")
        expect(page.get_by_role("heading", level=2, name="Retried import")).to_be_visible()
        page.unroute(docs_url, lose_first)
        self.assertEqual(len(keys), 2)
        self.assertTrue(keys[0], "the import sends an Idempotency-Key")
        self.assertEqual(keys[1], keys[0], "the retry reuses the first attempt's key")
        self.assertEqual(again.value.headers.get("idempotent-replayed"), "true", "the server replayed the saved page")
        self.assertEqual(sum(item["title"] == "Retried import" for item in self.docs(page)), 1, "one page, not two")

    # ---------------------------------------------------------------- history, restore and rename

    def test_06_history_compares_and_restores(self) -> None:
        page = self.page("owner")
        page.goto(self.url("lamp"))
        wait_until_shared(page)
        self.actions(page, "History")
        expect(page).to_have_url(re.compile(re.escape(self.url("lamp", "/history"))))
        expect(page.locator(".wiki-head")).to_contain_text("History · 2 versions")
        versions = page.locator(".doc-versions > li")
        expect(versions).to_have_count(2)
        expect(versions.first).to_contain_text("Edited the text")
        expect(versions.first).to_contain_text(PARTNER["name"])
        expect(versions.first).not_to_contain_text("Published")
        expect(page.get_by_label("Changes in the text").locator(".wiki-chg--added")).to_contain_text(["Privacy"])
        shot(page, "wiki-history-desktop-1440")
        page.get_by_role("link", name="Read version 1").click()
        expect(page).to_have_url(re.compile(re.escape(self.url("lamp", "/versions/1")) + "$"))
        expect(page.locator(".wiki-head__meta")).to_contain_text("Version 1")
        expect(page.locator(".doc-notice").first).to_contain_text("You are reading an earlier version")
        expect(page.locator(".doc-prose")).not_to_contain_text("Privacy")
        expect(page.locator(".cm-content")).to_have_count(0)  # an earlier version is read, not written
        # Restore: version 1 becomes the page again, as the next version that says so.
        page.get_by_role("button", name="Restore this version").click()
        expect(page.get_by_text("Version 1 is the page again.")).to_be_visible(timeout=15000)
        expect(page).to_have_url(re.compile(re.escape(self.url("lamp")) + "$"))
        restored = self.doc(page, self.ids["lamp"])
        first = self.api(page, "GET", f"/api/v1/docs/{self.ids['lamp']}/versions/1", status=200)
        self.assertEqual((restored["version"], restored["reason"], restored["body"]), (3, "Restored version 1", first["body"]))
        expect(existing_text(page)).not_to_contain_text("The image stays on the device")
        # And back, from History's own Restore.
        page.goto(self.url("lamp", "/history?to=2"))
        page.get_by_role("button", name="Restore version 2").click()
        expect(page.get_by_text("Version 2 is the page again.")).to_be_visible(timeout=15000)
        self.assertIn("Privacy", self.doc(page, self.ids["lamp"])["body"])

    def test_07_rename_in_the_title_place(self) -> None:
        page = self.page("owner")
        page.goto(self.url("wiring"))
        wait_until_shared(page)
        self.actions(page, "Rename page")
        field = page.get_by_label("Page title")
        expect(field).to_be_focused()
        expect(field).to_have_value(WIRING)
        field.fill("Wiring the lamp")
        field.press("Enter")
        expect(page.get_by_role("heading", level=2, name="Wiring the lamp")).to_be_visible()
        expect(page.get_by_role("button", name="Page actions")).to_be_focused()
        doc = self.doc(page, self.ids["wiring"])
        self.assertEqual((doc["title"], doc["reason"]), ("Wiring the lamp", "Renamed to “Wiring the lamp”"))
        # Escape keeps the name.
        self.actions(page, "Rename page")
        page.get_by_label("Page title").fill("Not this")
        page.keyboard.press("Escape")
        expect(page.get_by_role("heading", level=2, name="Wiring the lamp")).to_be_visible()
        self.assertEqual(self.doc(page, self.ids["wiring"])["title"], "Wiring the lamp")

    # ---------------------------------------------------------------- export and copy link

    def export(self, page: Page, item: str | None = None) -> tuple[str, bytes]:
        with page.expect_download() as info:
            self.actions(page, "Export")
            if item:
                page.get_by_role("menu", name="Page actions").get_by_role("menuitem", name=re.compile(item)).click()
        download = info.value
        return download.suggested_filename, Path(download.path()).read_bytes()

    def test_08_export_a_page_and_the_whole_space(self) -> None:
        page = self.page("owner")
        page.goto(self.url("lamp"))
        wait_until_shared(page)
        name, data = self.export(page, "^This page as Markdown")
        current = self.doc(page, self.ids["lamp"])
        self.assertEqual(name, "how-the-lamp-works.md")
        self.assertEqual(data.decode("utf-8"), f"# {LAMP}\n\n{current['body'].rstrip()}\n")
        # An earlier version exports as it was written.
        page.goto(self.url("lamp", "/versions/1"))
        name, data = self.export(page, "^Version 1 as Markdown")
        first = self.api(page, "GET", f"/api/v1/docs/{self.ids['lamp']}/versions/1", status=200)
        self.assertEqual(name, "how-the-lamp-works-v1.md")
        self.assertEqual(data.decode("utf-8"), f"# {LAMP}\n\n{first['body'].rstrip()}\n")
        # A manager exports the whole space through the existing export (#123).
        page.goto(self.url("lamp"))
        name, data = self.export(page, "^The whole space")
        self.assertRegex(name, rf"^flux-project-{self.project_id[:8]}-\d{{8}}T\d{{6}}Z\.tar\.gz$")
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as bundle:
            root = name.removesuffix(".tar.gz")
            exported = json.loads(bundle.extractfile(f"{root}/project.json").read())
            page_file = bundle.extractfile(f"{root}/docs/{self.ids['lamp']}.md").read().decode("utf-8")
        self.assertEqual(exported["project"]["name"], PROJECT)
        self.assertEqual(page_file, self.doc(page, self.ids["lamp"])["body"])
        expect(page.get_by_text(f"Exported {PROJECT} as {name}.")).to_be_visible()
        # A contributor's Export is the page itself; the space export stays with managers, as the server decides.
        partner = self.page("partner")
        partner.goto(self.url("parts"))
        wait_until_shared(partner)
        name, data = self.export(partner)
        self.assertEqual(name, "parts-list.md")
        self.assertTrue(data.decode("utf-8").startswith(f"# {PARTS}\n\n"))
        self.api(partner, "GET", f"/api/v1/projects/{self.project_id}/export?format=bundle", status=403)

    def test_09_copy_link_copies_the_exact_link(self) -> None:
        page = self.page("owner", permissions=["clipboard-read", "clipboard-write"])
        page.goto(self.url("lamp"))
        wait_until_shared(page)
        self.actions(page, "Copy link")
        expect(page.get_by_text("Link copied.")).to_be_visible()
        self.assertEqual(page.evaluate("navigator.clipboard.readText()"), f"{ORIGIN}{self.url('lamp')}")
        expect(page.get_by_role("button", name="Page actions")).to_be_focused()
        # The copied link opens the same page for another person with access.
        partner = self.page("partner")
        partner.goto(page.evaluate("navigator.clipboard.readText()"))
        expect(partner.get_by_role("heading", level=2, name=LAMP)).to_be_visible()

    # ---------------------------------------------------------------- phone and tablet

    def test_10_phone_small_phone_and_tablet(self) -> None:
        for size, touch in ((PHONE, True), (SMALL_PHONE, True), (TABLET, True)):
            with self.subTest(width=size["width"]):
                page = self.page("partner", viewport=size, touch=touch)
                page.goto(self.url("lamp"))
                wait_until_shared(page)
                expect(page.get_by_role("heading", level=2, name=LAMP)).to_be_visible()
                self.no_horizontal_overflow(page, size["width"])
                for control in (page.locator(".wiki-page").get_by_role("heading", level=2).get_by_role("button"), page.get_by_role("button", name="Contents"),
                                page.get_by_role("button", name="Page actions")):
                    box = control.bounding_box()
                    self.assertGreaterEqual(box["height"], 44)
                    self.assertLessEqual(box["x"] + box["width"], size["width"])
                pages = self.switcher(page)
                expect(pages.get_by_role("link", name=LAMP)).to_have_attribute("aria-current", "page")
                box = pages.bounding_box()
                self.assertGreaterEqual(box["x"], 0)
                self.assertLessEqual(box["x"] + box["width"], size["width"])
                shot(page, f"wiki-switcher-{size['width']}")
                page.keyboard.press("Escape")
                page.get_by_role("button", name="Contents").click()
                expect(page.get_by_role("menu", name="Contents").get_by_role("menuitem")).to_have_text(["What we want", "What we test", "Running it", "Privacy"])
                self.no_horizontal_overflow(page, size["width"])
                shot(page, f"wiki-contents-{size['width']}")

    def test_11_light_and_dark_contrast(self) -> None:
        for theme in ("light", "dark"):
            with self.subTest(theme=theme):
                page = self.page("owner", theme=theme)
                page.goto(self.url("lamp"))
                expect(page.locator("html")).to_have_attribute("data-theme", theme)
                wait_until_shared(page)
                for selector in (".wiki-head__meta", ".wiki-switch__t", ".wiki-editor .cm-line", ".wiki-editor .cm-md-h2", ".wiki-editor .cm-md-pre"):
                    self.measure(page, selector)
                self.measure(page, ".wiki-head__btn", 3)
                self.measure(page, ".wiki-switch svg", 3)
                page_ref = page.locator(".wiki-editor a.doc-page").first
                expect(page_ref.locator("svg")).to_have_count(1)
                expect(page_ref).not_to_have_css("background-color", "rgba(0, 0, 0, 0)")
                self.measure(page, ".wiki-editor a.doc-page")
                self.switcher(page)
                for selector in (".wiki-menu__row:not([aria-current])", '.wiki-menu__row[aria-current="page"]', ".wiki-find input"):
                    self.measure(page, selector)
                shot(page, f"wiki-desktop-1440-{theme}")
                page.keyboard.press("Escape")
                page.get_by_role("button", name="Page actions").click()
                self.measure(page, ".wiki-actions .wiki-menu__row")
                page.keyboard.press("ArrowDown")
                page.wait_for_timeout(200)
                self.measure(page, ".wiki-actions .wiki-menu__row:focus-visible", 3, property="outlineColor", backgroundSelector=".wiki-actions")
                shot(page, f"wiki-actions-desktop-1440-{theme}")

    # ---------------------------------------------------------------- delete a page (#941)

    def scratch_page(self, owner: Page, title: str) -> dict:
        return self.api(owner, "POST", f"/api/v1/projects/{self.project_id}/docs", {"title": title, "body": "Nothing here to keep."}, status=201,
                        headers={"idempotency-key": str(uuid.uuid4())})

    def test_12_delete_page_asks_first_and_a_citing_message_says_the_page_is_deleted(self) -> None:
        owner = self.page("owner")
        gone = self.scratch_page(owner, "Scratch notes")
        kept_title = "Kept for later"
        kept = self.scratch_page(owner, kept_title)
        conversation = self.api(owner, "POST", f"/api/v1/projects/{self.project_id}/conversations",
                                {"body": "The bench notes are in the Wiki.", "clientMessageId": str(uuid.uuid4())}, status=201)
        cited = self.api(owner, "POST", f"/api/v1/conversations/{conversation['id']}/messages",
                         {"body": "Start with the scratch notes.", "clientMessageId": str(uuid.uuid4()), "source": {"materialId": gone["id"], "version": 1}}, status=201)
        page = self.page("owner")
        page.goto(f"/projects/{self.project_id}/docs/{gone['id']}")
        wait_until_shared(page)
        # The menu names it, and nothing is deleted before the OK.
        page.get_by_role("button", name="Page actions").click()
        expect(page.get_by_role("menu", name="Page actions").get_by_role("menuitem")).to_have_text(["History", "Copy link", "Export", "Import a Markdown file", "Rename page", "Delete page"])
        page.get_by_role("menuitem", name="Delete page").click()
        dialog = page.get_by_role("alertdialog", name="Delete Scratch notes?")
        expect(dialog).to_contain_text("will be deleted for everyone in this space")
        shot(page, "941-page-delete-confirm")
        dialog.get_by_role("button", name="Cancel").click()
        expect(dialog).to_have_count(0)
        expect(page.get_by_role("button", name="Page actions")).to_be_focused()
        self.assertEqual(self.doc(page, gone["id"])["title"], "Scratch notes")
        # The OK deletes it for everyone: the person lands on another page, and the API no longer knows it.
        page.get_by_role("button", name="Page actions").click()
        page.get_by_role("menuitem", name="Delete page").click()
        page.get_by_role("alertdialog", name="Delete Scratch notes?").get_by_role("button", name="Delete page").click()
        expect(page.get_by_text("Deleted “Scratch notes”.")).to_be_visible()
        expect(page).not_to_have_url(re.compile(re.escape(gone["id"])))
        expect(page.get_by_role("heading", level=2).first).to_be_visible()
        self.api(page, "GET", f"/api/v1/docs/{gone['id']}", status=404)
        self.assertNotIn(gone["id"], [item["id"] for item in self.docs(page)])
        self.assertIn(kept["id"], [item["id"] for item in self.docs(page)], "another page stays")
        # The message that cited it keeps its text and says so; there is nothing to open.
        talk = self.page("partner")
        talk.goto(f"/projects/{self.project_id}/conversations/{conversation['id']}")
        message = talk.locator(f"#message-{cited['id']}")
        expect(message).to_contain_text("Start with the scratch notes.")
        expect(message.locator(".wiki-card--gone")).to_contain_text("Page deleted")
        expect(message.locator("a.wiki-card")).to_have_count(0)
        # An earlier version of a page has no Delete.
        earlier = self.page("owner")
        earlier.goto(self.url("lamp", "/versions/1"))
        earlier.get_by_role("button", name="Page actions").click()
        expect(earlier.get_by_role("menu", name="Page actions").get_by_role("menuitem", name="Copy link")).to_be_visible()
        expect(earlier.get_by_role("menuitem", name="Delete page")).to_have_count(0)

    def test_13_delete_page_on_the_phone(self) -> None:
        owner = self.page("owner", viewport=PHONE, touch=True)
        gone = self.scratch_page(owner, "Phone scratch")
        owner.goto(f"/projects/{self.project_id}/docs/{gone['id']}")
        wait_until_shared(owner)
        owner.get_by_role("button", name="Page actions").click()
        owner.get_by_role("menuitem", name="Delete page").click()
        dialog = owner.get_by_role("alertdialog", name="Delete Phone scratch?")
        expect(dialog).to_be_visible()
        for name in ("Cancel", "Delete page"):
            box = dialog.get_by_role("button", name=name).bounding_box()
            self.assertGreaterEqual(box["height"], 44, name)
            self.assertLessEqual(box["x"] + box["width"], PHONE["width"], name)
        box = dialog.bounding_box()
        self.assertGreaterEqual(box["x"], 0)
        self.assertLessEqual(box["x"] + box["width"], PHONE["width"])
        shot(owner, "941-page-delete-confirm-phone")
        dialog.get_by_role("button", name="Delete page").click()
        expect(owner.get_by_text("Deleted “Phone scratch”.")).to_be_visible()
        self.api(owner, "GET", f"/api/v1/docs/{gone['id']}", status=404)

    def delete_page(self, page: Page, doc_id: str) -> None:
        """Deletes the page through the API as `page`'s person, at the version it has now (a save may land a moment before)."""
        for attempt in range(3):
            response = page.request.fetch(f"{ORIGIN}/api/v1/docs/{doc_id}", method="DELETE",
                                          headers={"origin": ORIGIN, "if-match": f'"{self.doc(page, doc_id)["version"]}"', "idempotency-key": str(uuid.uuid4())})
            if response.status != 409:
                self.assertEqual(response.status, 204, response.text())
                return
        self.fail("the page kept changing")

    def test_14_a_page_deleted_while_it_is_open_says_so_and_leaves_the_switcher(self) -> None:
        owner = self.page("owner")
        typed = self.scratch_page(owner, "Shared scratch")
        watched = self.scratch_page(owner, "Watched scratch")
        racing = self.scratch_page(owner, "Racing scratch")
        # Marek wrote on one page and only read another, each in its own tab.
        writing = self.page("partner")
        writing.goto(f"/projects/{self.project_id}/docs/{typed['id']}")
        wait_until_shared(writing)
        type_at_end(writing, existing_text(writing), " Marek's line before the page went.")
        reading = self.page("partner")
        reading.goto(f"/projects/{self.project_id}/docs/{watched['id']}")
        wait_until_shared(reading)
        # Hubert has the Delete dialog of a third page open when Marek deletes it first.
        hubert = self.page("owner")
        hubert.goto(f"/projects/{self.project_id}/docs/{racing['id']}")
        wait_until_shared(hubert)
        hubert.get_by_role("button", name="Page actions").click()
        hubert.get_by_role("menuitem", name="Delete page").click()
        expect(hubert.get_by_role("alertdialog", name="Delete Racing scratch?")).to_be_visible()
        for doc in (typed, watched):
            self.delete_page(owner, doc["id"])
        self.delete_page(writing, racing["id"])
        # The page says it was deleted: no "access ended", no editor, and no switcher entry. The text Marek typed is his to copy.
        gone = writing.locator("[data-page-gone]")
        expect(gone.get_by_role("heading", name="This page was deleted")).to_be_visible()
        expect(gone).to_contain_text("Shared scratch")
        expect(writing.get_by_text("Access ended")).to_have_count(0)
        expect(writing.get_by_text("A private copy from an earlier session")).to_have_count(0)
        expect(writing.get_by_role("textbox", name="Page text")).to_have_count(0)
        expect(gone.get_by_label("Your text from the deleted page")).to_have_value(re.compile(r"Marek's line before the page went\."))
        shot(writing, "941-page-deleted-while-open")
        # A page he only read offers no text, and Hubert's open dialog is gone with the page, with no failure said.
        expect(reading.locator("[data-page-gone]").get_by_role("heading", name="This page was deleted")).to_be_visible()
        expect(reading.get_by_label("Your text from the deleted page")).to_have_count(0)
        expect(hubert.locator("[data-page-gone]").get_by_role("heading", name="This page was deleted")).to_be_visible()
        expect(hubert.get_by_role("alertdialog")).to_have_count(0)
        expect(hubert.get_by_text("That didn’t work")).to_have_count(0)
        # Back to the Wiki lands on another page, and the switcher does not list the deleted ones.
        writing.get_by_role("link", name="Back to the Wiki").click()
        expect(writing.locator("[data-page-gone]")).to_have_count(0)
        expect(writing.get_by_role("heading", level=2).first).to_be_visible()
        pages = self.switcher(writing)
        expect(pages.get_by_role("link").first).to_be_visible()
        for title in ("Shared scratch", "Watched scratch", "Racing scratch"):
            expect(pages.get_by_role("link", name=title)).to_have_count(0)
        for doc in (typed, watched, racing):
            self.api(writing, "GET", f"/api/v1/docs/{doc['id']}", status=404)

    def test_15_a_page_deleted_while_the_switcher_is_open_leaves_it_at_once(self) -> None:
        owner = self.page("owner")
        going = self.scratch_page(owner, "Going scratch")
        staying = self.scratch_page(owner, "Staying scratch")
        reading = self.page("partner")
        reading.goto(f"/projects/{self.project_id}/docs/{staying['id']}")
        wait_until_shared(reading)
        pages = self.switcher(reading)
        expect(pages.get_by_role("link", name="Going scratch")).to_be_visible()
        # Someone else deletes a page while the list is open: the list drops it without being closed or opened again (#1021).
        self.delete_page(owner, going["id"])
        expect(pages.get_by_role("link", name="Going scratch")).to_have_count(0)
        expect(pages.get_by_role("link", name="Staying scratch")).to_have_attribute("aria-current", "page")
        expect(pages).to_be_visible()


if __name__ == "__main__":
    unittest.main()
