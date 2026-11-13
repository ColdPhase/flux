"""Browser tests for thought references and for file details in the message (#469, F-026 §6).

Runs with the other tests/ui journeys through scripts/check_ui.sh; FLUX_UI_BROWSER selects chromium (default) or webkit.
A message cites a map thought (a message is no longer citable, #867). Its card carries the object's glyph, its kind, its title and one
line of context, and opens the target; on a touch screen it is at least 44 px tall, and in dark mode its words stay readable. A target the
reader may not open is an "unavailable" card that carries nothing of it. A space's map has no Cite (#1376): its Copy link pasted into a
conversation, a thread or a task's discussion reads as the thought's chip for whoever may read that map, and opens the map with the thought
selected; anyone else sees "Thought not available". A file row names the pages, rows or playing time the server read from its bytes.
"""

from __future__ import annotations

import os
import re
import struct
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from contrast import MEASURE
from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, start_forwarder

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")

PASSWORD = "references need a place"
STAMP = int(time.time() * 1000)
PEOPLE = {"ada": ("Ada Kowalska", f"ada.refs+{STAMP}@example.test"), "jonas": ("Jonas Berg", f"jonas.refs+{STAMP}@example.test"),
          "kai": ("Kai Lund", f"kai.refs+{STAMP}@example.test")}
THOUGHT = "Solar panel on the enclosure?"
BOARD_NOTE = "The deposit for the plot is due on the 12th."
PDF = (b"%PDF-1.4\n1 0 obj\n<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 >>\nendobj\n2 0 obj\n<< /Type /Page /Parent 1 0 R >>\nendobj\n"
       b"3 0 obj\n<< /Type /Page /Parent 1 0 R >>\nendobj\n%%EOF")
CSV = b"bed,reading\nfar east,-112\nnear,-80\nhedge,-95\n"


def wav(seconds: int, rate: int = 8000) -> bytes:
    data = bytes(seconds * rate * 2)
    header = (b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
              + b"data" + struct.pack("<I", len(data)))
    return header + data


class MessageReferences(unittest.TestCase):
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

        def upload(who: str, project: str, name: str, data: bytes) -> str:
            response = contexts[who].request.post(f"/api/v1/projects/{project}/files?uploadId={uuid.uuid4()}&name={name}", data=data,
                                                  headers={"origin": ORIGIN, "content-type": "application/octet-stream"})
            assert response.status == 201, response.text()
            return response.json()["id"]

        ws = post("ada", "/api/v1/workspaces", {"name": "Community garden"})
        for key in ("jonas", "kai"):
            post("ada", f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE[key][1], "role": "member"})
        open_project = post("ada", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Garden sensors", "visibility": "workspace"})["id"]
        board = post("ada", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Board matters", "visibility": "restricted"})["id"]
        cls.ids.update(workspace=ws["id"], project=open_project, board=board)
        sketch = post("ada", f"/api/v1/workspaces/{ws['id']}/sketches", {"title": "Enclosure ideas", "scope": "project", "projectId": open_project})["id"]
        thought = post("ada", f"/api/v1/sketches/{sketch}/thoughts", {"text": THOUGHT, "x": 80, "y": 80})["thought"]["id"]
        cls.ids.update(sketch=sketch, thought=thought)
        # A thought of the restricted board's own map: Ada reads it, Jonas and Kai do not.
        board_sketch = post("ada", f"/api/v1/workspaces/{ws['id']}/sketches", {"title": "Board notes", "scope": "project", "projectId": board})["id"]
        note = post("ada", f"/api/v1/sketches/{board_sketch}/thoughts", {"text": BOARD_NOTE, "x": 80, "y": 80})["thought"]["id"]
        cls.ids.update(note=note, board_sketch=board_sketch)

        def root(who: str, body: str, references: list[dict], files: list[str] | None = None) -> str:
            payload = {"body": body, "clientMessageId": str(uuid.uuid4()), "references": references}
            if files:
                payload["attachmentIds"] = files
            return post(who, f"/api/v1/projects/{open_project}/conversations", payload)["messages"][0]["id"]

        cls.ids["jonas_root"] = root("jonas", "What about this one?", [{"kind": "thought", "id": thought}])
        cls.ids["both"] = root("ada", "Two things to look at", [{"kind": "thought", "id": thought}, {"kind": "thought", "id": cls.ids["note"]}])
        cls.ids["files"] = root("ada", "Drawing, readings and a note", [], [
            upload("ada", open_project, "probe-v2-drawing.pdf", PDF), upload("ada", open_project, "lora-range-far-beds.csv", CSV),
            upload("ada", open_project, "voice-note.wav", wav(3)), upload("ada", open_project, "plain-notes.txt", b"a,b\n1,2\n"),
            upload("ada", open_project, "not-really.pdf", b"hello world")])
        for context in contexts.values():
            context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str = "ada", phone: bool = False, dark: bool = False, path: str | None = None) -> Page:
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
        page.goto(path or f"/projects/{self.ids['project']}")
        return page

    def card(self, page: Page, message: str, kind: str, index: int = 0):
        return page.locator(f"#message-{self.ids[message]} .ref-card[data-ref='{kind}']").nth(index)

    def test_a_cards_show_kind_title_and_context_and_open_their_target(self) -> None:
        page = self.page("ada")
        thought = self.card(page, "both", "thought")
        expect(thought).to_be_visible()
        expect(thought).to_have_attribute("data-ref-state", "available")
        expect(thought.locator("small")).to_have_text("Thought · Enclosure ideas")
        expect(thought.locator("strong")).to_have_text(THOUGHT)
        expect(thought.locator(".ref-card__ctx")).to_have_text("Ada")
        expect(thought.locator("svg")).to_have_count(1)
        board = self.card(page, "both", "thought", 1)
        expect(board.locator("small")).to_have_text("Thought · Board notes")
        expect(board.locator("strong")).to_have_text(BOARD_NOTE)
        expect(board.locator(".ref-card__ctx")).to_have_text("Ada")
        # The card opens its target: the thought on its map, the board's thought on the board's map.
        thought.click()
        expect(page).to_have_url(re.compile(rf"/map/{self.ids['sketch']}#thought-{self.ids['thought']}$"))
        page.goto(f"/projects/{self.ids['project']}")
        self.card(page, "both", "thought", 1).click()
        expect(page).to_have_url(re.compile(rf"/map/{self.ids['board_sketch']}#thought-{self.ids['note']}$"))

    def test_b_an_unavailable_card_carries_nothing_of_its_target(self) -> None:
        for who in ("kai", "jonas"):
            with self.subTest(who=who):
                page = self.page(who)
                cited = self.card(page, "both", "thought", 1)
                expect(cited).to_have_attribute("data-ref-state", "unavailable")
                expect(cited).to_have_attribute("role", "note")
                expect(cited.locator("strong")).to_have_text("Not available to you")
                expect(cited.locator("small")).to_have_text("Thought")
                self.assertEqual(page.locator(f"#message-{self.ids['both']} a.ref-card").count(), 1, "no link to a thought the reader cannot open")
                # The map thought of the open project is read by every member.
                expect(self.card(page, "both", "thought")).to_have_attribute("data-ref-state", "available")
                html = page.content()
                for secret in (BOARD_NOTE, self.ids["note"], self.ids["board"], self.ids["board_sketch"]):
                    self.assertNotIn(secret, html, f"{who}'s page does not hold {secret!r}")
                raw = page.request.get(f"/api/v1/projects/{self.ids['project']}/conversation-roots").text()
                self.assertNotIn(BOARD_NOTE, raw)
                self.assertNotIn(self.ids["note"], raw)

    def test_c_phone_cards_are_touch_sized_and_dark_cards_are_readable(self) -> None:
        for who, phone, dark in (("ada", False, True), ("ada", True, False), ("ada", True, True), ("kai", True, False), ("kai", False, True)):
            with self.subTest(who=who, phone=phone, dark=dark):
                page = self.page(who, phone=phone, dark=dark)
                self.assertEqual(page.evaluate("matchMedia('(prefers-color-scheme: dark)').matches"), dark)
                for index in (0, 1):
                    kind = "thought"
                    card = self.card(page, "both", kind, index)
                    card.evaluate("(el, n) => el.setAttribute('data-card-index', String(n))", index)
                    card.scroll_into_view_if_needed()
                    expect(card).to_be_visible()
                    box = card.bounding_box()
                    if phone:
                        self.assertGreaterEqual(box["height"], 44, (kind, box))
                    self.assertLessEqual(box["x"] + box["width"], page.viewport_size["width"] + 0.5, "the card stays inside the screen")
                    unavailable = who != "ada" and index == 1
                    parts = ("strong", "small") if unavailable else ("strong", "small", ".ref-card__ctx")
                    for part in parts:
                        selector = f"#message-{self.ids['both']} .ref-card[data-card-index='{index}'] {part}"
                        page.wait_for_function("""selector => {
                          const target = document.querySelector(selector);
                          if (!target) return false;
                          for (let node=target; node; node=node.parentElement)
                            if (Number(getComputedStyle(node).opacity) !== 1) return false;
                          return true;
                        }""", arg=selector)
                        value = page.evaluate(MEASURE, {"selector": selector})
                        self.assertGreaterEqual(value["ratio"], 4.5, (who, phone, dark, selector, value))
                if phone and who == "ada":
                    # The title identifies the target: on a phone it wraps to two lines and is not cut (visual review of #704).
                    for message, kind, index in (("both", "thought", 0), ("both", "thought", 1)):
                        title = self.card(page, message, kind, index).locator("strong")
                        title.scroll_into_view_if_needed()
                        cut = title.evaluate("el => ({ tall: el.scrollHeight > el.clientHeight + 1, wide: el.scrollWidth > el.clientWidth + 1, lines: Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight)) })")
                        self.assertFalse(cut["tall"] or cut["wide"], (message, kind, cut))
                        self.assertLessEqual(cut["lines"], 2, (message, kind, cut))
                if dark:
                    background = page.evaluate("getComputedStyle(document.body).backgroundColor")
                    channels = [int(v) for v in re.findall(r"\d+", background)[:3]]
                    self.assertLess(sum(channels) / 3, 90, f"dark theme page background {background}")

    def test_e_copy_link_on_a_space_map_reads_as_the_thoughts_chip_where_it_is_pasted(self) -> None:
        page = self.page("ada", path=f"/projects/{self.ids['project']}/map/{self.ids['sketch']}")
        page.evaluate("() => { window.__copied = []; navigator.clipboard.writeText = (text) => { window.__copied.push(text); return Promise.resolve(); }; }")
        tools = page.get_by_role("toolbar", name="Map tools")
        expect(tools).to_be_visible()
        expect(page.get_by_role("button", name=re.compile("^Cite"))).to_have_count(0)
        page.locator(f".sk-node[data-id='{self.ids['thought']}']").click()
        page.get_by_role("button", name="Copy link", exact=True).click()
        link = f"{ORIGIN}/projects/{self.ids['project']}/map/{self.ids['sketch']}#thought-{self.ids['thought']}"
        page.wait_for_function("() => window.__copied.length === 1")
        self.assertEqual(page.evaluate("window.__copied[0]"), link)
        board_link = f"{ORIGIN}/projects/{self.ids['board']}/map/{self.ids['board_sketch']}#thought-{self.ids['note']}"
        # Pasted into a space's conversation, a thread's reply and a task's discussion.
        context = self.browser.new_context(base_url=ORIGIN, storage_state=self.states["ada"])
        self.addCleanup(context.close)
        def post(path: str, body: dict) -> dict:
            response = context.request.post(path, data=body, headers={"origin": ORIGIN, "idempotency-key": str(uuid.uuid4())})
            assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
            return response.json()
        body = f"See {link} and {board_link}"
        root = post(f"/api/v1/projects/{self.ids['project']}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())})
        reply = post(f"/api/v1/conversations/{root['id']}/messages", {"body": f"Also {link}", "clientMessageId": str(uuid.uuid4())})
        task = post(f"/api/v1/projects/{self.ids['project']}/work", {"title": "Mount the panel"})
        post(f"/api/v1/work/{task['id']}/discussion", {"body": f"Here: {link}", "clientMessageId": str(uuid.uuid4())})
        places = {
            "conversation": (f"/projects/{self.ids['project']}", f"#message-{root['messages'][0]['id']}"),
            "thread": (f"/projects/{self.ids['project']}/conversations/{root['id']}", f"[data-message-id='{reply['id']}'], #message-{reply['id']}"),
            "task": (f"/projects/{self.ids['project']}/tasks?open=work:{task['id']}", "[aria-label='Task activity']"),
        }
        for who in ("ada", "kai"):
            for place, (path, scope) in places.items():
                with self.subTest(who=who, place=place):
                    page = self.page(who, path=path)
                    chip = page.locator(scope).locator(f"a.ref-chip--thought[href$='#thought-{self.ids['thought']}']").first
                    expect(chip).to_be_visible()
                    expect(chip).to_have_attribute("data-ref-state", "available")
                    expect(chip).to_contain_text(THOUGHT)
                    expect(page.locator(scope).locator(".msg-link")).to_have_count(0)
                    expect(page.locator(scope).locator(".link-preview")).to_have_count(0)
                    if place == "conversation":
                        board = page.locator(scope).locator(".ref-chip--thought").nth(1)
                        if who == "ada":
                            expect(board).to_contain_text(BOARD_NOTE)
                        else:
                            expect(board).to_have_attribute("data-ref-state", "unavailable")
                            expect(board).to_have_text("Thought not available")
                            self.assertNotIn(BOARD_NOTE, page.content())
                    if who == "ada" and place == "task":
                        chip.click()
                        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['project']}/map/{self.ids['sketch']}#thought-{self.ids['thought']}$"))
                        expect(page.locator(f".sk-node[data-id='{self.ids['thought']}']")).to_have_attribute("aria-pressed", "true")

    def test_f_a_file_row_names_its_pages_rows_or_playing_time(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page("jonas", phone=phone)
                rows = page.locator(f"#message-{self.ids['files']} .file-row")
                expect(rows).to_have_count(5)
                expect(rows.nth(0).locator("small")).to_have_text(re.compile(r"^PDF · 2 pages · \d+ B$"))
                expect(rows.nth(1).locator("small")).to_have_text(re.compile(r"^Table · 3 rows · \d+ B$"))
                expect(rows.nth(2).locator(".voice-note__line")).to_contain_text("0:03")
                expect(rows.nth(3).locator("small")).to_have_text(re.compile(r"^Document · \d+ B$"))
                # A name alone says nothing: a ".pdf" that is not one has no pages.
                expect(rows.nth(4).locator("small")).to_have_text(re.compile(r"^PDF · \d+ B$"))

    def test_g_a_voice_note_plays_and_pauses_for_its_reader(self) -> None:
        """#469: actual playback of a stored voice note (the server read its 3 s from the bytes; the player must agree)."""
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page("jonas", phone=phone)
                heard: list[str] = []
                page.on("pageerror", lambda error: heard.append(f"pageerror {error}"))
                page.on("console", lambda message: heard.append(f"{message.type}: {message.text}") if message.type in ("error", "warning") else None)
                page.wait_for_load_state("networkidle")
                selector = f"#message-{self.ids['files']} .voice-note"
                note = page.locator(selector)
                expect(note.locator(".voice-note__line")).to_contain_text("0:03")
                note.get_by_role("button", name=re.compile("^Play voice-note.wav")).click()
                # The element is looked up on every poll: what matters is the one on the page, not one held from before.
                state = "(() => { const a = document.querySelector(%r + ' audio'); return a ? { paused: a.paused, t: a.currentTime, ready: a.readyState, net: a.networkState, error: a.error ? a.error.code : null, src: (a.currentSrc || a.src || '').slice(0, 10), duration: a.duration } : null; })()" % selector
                try:
                    page.wait_for_function("() => { const s = %s; return !!s && s.t > 0.2 && !s.paused; }" % state, timeout=15000)
                except Exception:
                    self.fail(f"the voice note did not start playing after one press: {page.evaluate('() => ' + state)} at {page.url}, {page.locator('.voice-note').count()} voice notes, {page.locator('audio').count()} audio elements; heard {heard}; page says {page.locator('body').inner_text()[:300]!r}")
                seen = page.evaluate("() => " + state)
                self.assertIsNone(seen["error"], seen)
                self.assertAlmostEqual(seen["duration"], 3.0, delta=0.2, msg="the player agrees with the duration the server read")
                note.get_by_role("button", name=re.compile("^Pause voice-note.wav")).click()
                self.assertTrue(page.evaluate("() => " + state)["paused"])


if __name__ == "__main__":
    unittest.main()
