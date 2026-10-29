"""Browser tests for thought and message references and for file details in the message (#469, F-026 §6).

Runs with the other tests/ui journeys through scripts/check_ui.sh; FLUX_UI_BROWSER selects chromium (default) or webkit.
A message cites a map thought or another message. Its card carries the object's glyph, its kind, its title and one line of
context, and opens the target; on a touch screen it is at least 44 px tall, and in dark mode its words stay readable. A target the
reader may not open is an "unavailable" card that carries nothing of it. Cite in a message's menu, and Cite on the map, put the
citation in the composer as a tile that can be taken out; the sent message carries the card. A file row names the pages, rows or
playing time the server read from its bytes.
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
DM_NOTE = "Call me before you answer the landlord"
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
        note = post("ada", f"/api/v1/projects/{board}/conversations", {"body": BOARD_NOTE, "clientMessageId": str(uuid.uuid4())})
        cls.ids.update(note=note["messages"][0]["id"], note_conversation=note["id"])
        dm = post("ada", f"/api/v1/workspaces/{ws['id']}/dms", {"participantIds": [cls.ids["jonas"]]})
        dm_message = post("ada", f"/api/v1/dms/{dm['id']}/messages", {"body": DM_NOTE, "clientMessageId": str(uuid.uuid4())})
        cls.ids.update(dm=dm["id"], dm_message=dm_message["id"])

        def root(who: str, body: str, references: list[dict], files: list[str] | None = None) -> str:
            payload = {"body": body, "clientMessageId": str(uuid.uuid4()), "references": references}
            if files:
                payload["attachmentIds"] = files
            return post(who, f"/api/v1/projects/{open_project}/conversations", payload)["messages"][0]["id"]

        cls.ids["jonas_root"] = root("jonas", "What about this one?", [{"kind": "thought", "id": thought}])
        cls.ids["both"] = root("ada", "Two things to look at", [{"kind": "thought", "id": thought}, {"kind": "message", "id": cls.ids["note"]}])
        cls.ids["private"] = root("ada", "And a private chat", [{"kind": "message", "id": cls.ids["dm_message"]}])
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

    def card(self, page: Page, message: str, kind: str):
        return page.locator(f"#message-{self.ids[message]} .ref-card[data-ref='{kind}']")

    def test_a_cards_show_kind_title_and_context_and_open_their_target(self) -> None:
        page = self.page("ada")
        thought = self.card(page, "both", "thought")
        expect(thought).to_be_visible()
        expect(thought).to_have_attribute("data-ref-state", "available")
        expect(thought.locator("small")).to_have_text("Map thought · Enclosure ideas")
        expect(thought.locator("strong")).to_have_text(THOUGHT)
        expect(thought.locator(".ref-card__ctx")).to_have_text("Ada")
        expect(thought.locator("svg")).to_have_count(1)
        message = self.card(page, "both", "message")
        expect(message.locator("small")).to_have_text("Cited message · Board matters")
        expect(message.locator("strong")).to_have_text(BOARD_NOTE)
        expect(message.locator(".ref-card__ctx")).to_have_text(re.compile(r"^Ada · \d"))
        # The card opens its target: the thought on its map, the message in its own project.
        thought.click()
        expect(page).to_have_url(re.compile(rf"/map/{self.ids['sketch']}#thought-{self.ids['thought']}$"))
        page.go_back()
        self.card(page, "both", "message").click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['board']}/conversations/{self.ids['note_conversation']}#message-{self.ids['note']}$"))
        # A message of a direct message opens that conversation.
        page.goto(f"/projects/{self.ids['project']}")
        expect(self.card(page, "private", "message").locator("small")).to_have_text("Cited message · Direct message")
        self.card(page, "private", "message").click()
        expect(page).to_have_url(re.compile(rf"/dm/{self.ids['dm']}#message-{self.ids['dm_message']}$"))

    def test_b_an_unavailable_card_carries_nothing_of_its_target(self) -> None:
        for who, expected in (("kai", {"message": "unavailable", "private": "unavailable"}), ("jonas", {"message": "unavailable", "private": "available"})):
            with self.subTest(who=who):
                page = self.page(who)
                cited = self.card(page, "both", "message")
                expect(cited).to_have_attribute("data-ref-state", expected["message"])
                expect(cited).to_have_attribute("role", "note")
                expect(cited.locator("strong")).to_have_text("Not available to you")
                expect(cited.locator("small")).to_have_text("Cited message")
                self.assertEqual(page.locator(f"#message-{self.ids['both']} a.ref-card[data-ref='message']").count(), 0, "no link to a message the reader cannot open")
                expect(self.card(page, "private", "message")).to_have_attribute("data-ref-state", expected["private"])
                # The map thought is in the open project: every member reads it.
                expect(self.card(page, "both", "thought")).to_have_attribute("data-ref-state", "available")
                html = page.content()
                for secret in (BOARD_NOTE, self.ids["note"], self.ids["board"], self.ids["note_conversation"]):
                    self.assertNotIn(secret, html, f"{who}'s page does not hold {secret!r}")
                if who == "kai":
                    self.assertNotIn(DM_NOTE, html)
                    self.assertNotIn(self.ids["dm_message"], html)
                    self.assertNotIn(self.ids["dm"], html)
                raw = page.request.get(f"/api/v1/projects/{self.ids['project']}/conversation-roots").text()
                self.assertNotIn(BOARD_NOTE, raw)
                self.assertNotIn(self.ids["note"], raw)
                if who == "kai":
                    self.assertNotIn(DM_NOTE, raw)

    def test_c_phone_cards_are_touch_sized_and_dark_cards_are_readable(self) -> None:
        for who, phone, dark in (("ada", False, True), ("ada", True, False), ("ada", True, True), ("kai", True, False), ("kai", False, True)):
            with self.subTest(who=who, phone=phone, dark=dark):
                page = self.page(who, phone=phone, dark=dark)
                self.assertEqual(page.evaluate("matchMedia('(prefers-color-scheme: dark)').matches"), dark)
                for kind in ("thought", "message"):
                    card = self.card(page, "both", kind)
                    card.scroll_into_view_if_needed()
                    expect(card).to_be_visible()
                    box = card.bounding_box()
                    if phone:
                        self.assertGreaterEqual(box["height"], 44, (kind, box))
                    self.assertLessEqual(box["x"] + box["width"], page.viewport_size["width"] + 0.5, "the card stays inside the screen")
                    unavailable = who != "ada" and kind == "message"
                    parts = ("strong", "small") if unavailable else ("strong", "small", ".ref-card__ctx")
                    for part in parts:
                        selector = f"#message-{self.ids['both']} .ref-card[data-ref='{kind}'] {part}"
                        page.wait_for_function("""selector => {
                          const target = document.querySelector(selector);
                          if (!target) return false;
                          for (let node=target; node; node=node.parentElement)
                            if (Number(getComputedStyle(node).opacity) !== 1) return false;
                          return true;
                        }""", arg=selector)
                        value = page.evaluate(MEASURE, {"selector": selector})
                        self.assertGreaterEqual(value["ratio"], 4.5, (who, phone, dark, selector, value))
                if dark:
                    background = page.evaluate("getComputedStyle(document.body).backgroundColor")
                    channels = [int(v) for v in re.findall(r"\d+", background)[:3]]
                    self.assertLess(sum(channels) / 3, 90, f"dark theme page background {background}")

    def test_d_cite_a_message_in_the_composer_then_send_it(self) -> None:
        page = self.page("ada")
        message = page.locator(f"#message-{self.ids['jonas_root']}")
        message.hover()
        message.get_by_role("button", name="More actions").click()
        page.get_by_role("menuitem", name="Cite").click()
        tile = page.locator(".composer-cite")
        expect(tile).to_have_count(1)
        expect(tile.locator("small")).to_have_text("Cited message · Jonas Berg")
        expect(tile.locator("strong")).to_have_text("What about this one?")
        expect(page.locator("#project-composer")).to_have_value("")
        # The tile comes out with its ×, and then nothing is cited.
        tile.get_by_role("button", name=re.compile("^Remove citation")).click()
        expect(tile).to_have_count(0)
        message.hover()
        message.get_by_role("button", name="More actions").click()
        page.get_by_role("menuitem", name="Cite").click()
        expect(tile).to_have_count(1)
        page.locator("#project-composer").fill("Replying to this, not to the map idea")
        with page.expect_request(lambda request: request.method == "POST" and request.url.endswith(f"/projects/{self.ids['project']}/conversations")) as sent:
            page.locator("#project-composer").press("Enter")
        self.assertEqual(sent.value.post_data_json["references"], [{"kind": "message", "id": self.ids["jonas_root"]}])
        expect(tile).to_have_count(0)
        mine = page.locator(".project-convo__message", has_text="Replying to this, not to the map idea")
        card = mine.locator(".ref-card[data-ref='message']")
        expect(card).to_have_count(1)
        expect(card.locator("strong")).to_have_text("What about this one?")
        expect(card.locator("small")).to_have_text("Cited message · Garden sensors")
        # Reloaded, the card is the same: it comes from the server, made for this reader.
        page.reload()
        expect(page.locator(".project-convo__message", has_text="Replying to this, not to the map idea").locator(".ref-card[data-ref='message'] strong")).to_have_text("What about this one?")

    def test_e_cite_the_selected_thought_from_the_map(self) -> None:
        page = self.page("ada", path=f"/map/{self.ids['sketch']}")
        tools = page.get_by_role("toolbar", name="Sketch tools")
        cite = tools.get_by_role("button", name="Cite the selected thought in the conversation")
        expect(cite).to_have_attribute("aria-disabled", "true")
        page.locator(f".sk-node[data-id='{self.ids['thought']}']").click()
        expect(cite).to_have_attribute("aria-disabled", "false")
        cite.click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['project']}$"))
        tile = page.locator(".composer-cite")
        expect(tile.locator("small")).to_have_text("Map thought · Enclosure ideas")
        expect(tile.locator("strong")).to_have_text(THOUGHT)
        page.locator("#project-composer").fill("Looking at this idea on the map")
        with page.expect_request(lambda request: request.method == "POST" and request.url.endswith(f"/projects/{self.ids['project']}/conversations")) as sent:
            page.locator("#project-composer").press("Enter")
        self.assertEqual(sent.value.post_data_json["references"], [{"kind": "thought", "id": self.ids["thought"]}])
        card = page.locator(".project-convo__message", has_text="Looking at this idea on the map").locator(".ref-card[data-ref='thought']")
        expect(card.locator("strong")).to_have_text(THOUGHT)

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


if __name__ == "__main__":
    unittest.main()
