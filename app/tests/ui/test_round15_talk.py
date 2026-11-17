"""Release gate round 15, the conversation, direct messages, the composer and Create (train/v021-38): the last fix wave's P2s.

Runs through scripts/check_ui.sh against the running Compose application, on the engine named by FLUX_UI_BROWSER (run it with chromium
and with webkit), on a computer (1440 x 900) and a phone (390 x 844):

* new P2-1: a task made from My tasks is yours, so it is on My tasks.
* daily P2-4: on the phone, Send leaves the focus (and the keyboard) in the field.
* daily P2-5: the New space window's "Name" is a heading like "People", and the AI and Encrypted rows' words start at one edge.
* look-2 P2-1: at the end of a space, staging two files keeps the newest message in view above the tray.
* look-2 P2-2: Back to a conversation whose place was a decision card comes back to that card, on the phone.
* look-2 P2-3: a `#N` chip in a conversation opens the task's panel beside it, as its card does, and Esc leaves the conversation.
* look-2 P2-4: composers side by side (the stream's and an open thread's) end at one height, in a space and a direct message.
* look-2 P2-5: Create › "+ From a message or thought" keeps the window's height until a word is typed, and says what to type.
* look-2 P2-6: Create task from a long message shows its whole title on the phone (the title wraps).
"""

from __future__ import annotations

import re
import struct
import time
import unittest
import uuid
import zlib

from playwright.sync_api import Browser, Page, expect, sync_playwright

from create_window import dialog, submit_button, title_field
from message_gestures import open_message_menu
from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, start_forwarder

PASSWORD = "round fifteen talk"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.round15+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.round15+{STAMP}@example.test"),
    "ola": ("Ola Nowicka", f"ola.round15+{STAMP}@example.test"),
}
LINES = [("jonas", "The far east bed stayed online all night, first time this month."), ("ola", "The seals arrived, both kinds. Rubber looks better."),
         ("jonas", "Someone left the shed unlocked again, I locked it at six."), ("ola", "The budget draft is in the Wiki, please read it by Friday."),
         ("jonas", "I can be at the garden at nine on Saturday to help with bed four."), ("ola", "Rota for December is up, please check your Saturdays."),
         ("jonas", "The probe in bed four was half out of the soil, I pushed it back in."), ("ola", "Then bed four needs a fresh reading tomorrow."),
         ("jonas", "The gateway rebooted twice last night, I will check the power supply."), ("ola", "Thanks, the spare supply is on the top shelf."),
         ("jonas", "Gateway is fine now, it was the loose plug."), ("ola", "Great, then we keep the old supply as the spare.")]
LONG = "Ada, before Saturday could someone check the whole north row, the probes there read dry every morning even after the rain and two of them are loose."


def png(width: int = 96, height: int = 64) -> bytes:
    """A real PNG with a visible gradient, written without image libraries."""
    rows = b"".join(b"\x00" + bytes(value for x in range(width) for value in ((x * 5) % 256, (y * 8) % 256, 170)) for y in range(height))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


BOXES = """() => Object.fromEntries([...document.querySelectorAll('.composer__box')].filter((b) => b.getClientRects().length)
  .map((b) => [b.querySelector('textarea')?.id, b.getBoundingClientRect().bottom]))"""


class RoundFifteenTalk(unittest.TestCase):
    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

    @classmethod
    def call(cls, who: str, method: str, path: str, body: dict | None = None) -> dict:
        context = cls.browser.new_context(base_url=ORIGIN, storage_state=cls.states[who], service_workers="block")
        try:
            response = context.request.fetch(path, method=method, data=body, headers={"origin": ORIGIN})
            assert response.status in (200, 201, 204), f"{method} {path}: {response.status} {response.text()}"
            return response.json() if response.text() else {}
        finally:
            context.close()

    @classmethod
    def say(cls, who: str, project: str, body: str) -> dict:
        return cls.call(who, "POST", f"/api/v1/projects/{project}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())})

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        assert cls.browser.browser_type.name == UI_BROWSER
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}", flush=True)
        expect.set_options(timeout=15000)
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            context.close()
        cls.ids["ws"] = cls.call("ada", "POST", "/api/v1/workspaces", {"name": "Garden club"})["id"]
        for key in ("jonas", "ola"):
            cls.call("ada", "POST", f"/api/v1/workspaces/{cls.ids['ws']}/members", {"email": PEOPLE[key][1], "role": "member"})

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def space(self, name: str, lines: list[tuple[str, str]]) -> str:
        project = self.call("ada", "POST", f"/api/v1/workspaces/{self.ids['ws']}/projects", {"name": f"{name} {uuid.uuid4().hex[:6]}", "visibility": "workspace"})["id"]
        for who, body in lines:
            self.say(who, project, body)
        return project

    def page(self, who: str, viewport: dict = DESKTOP) -> Page:
        phone = viewport == PHONE
        context = self.browser.new_context(service_workers="block", base_url=ORIGIN, locale="en-GB", timezone_id="Europe/Warsaw",
                                           storage_state=self.states[who], viewport=viewport, device_scale_factor=1,
                                           **({"is_mobile": True, "has_touch": True} if phone and UI_BROWSER != "firefox" else {}))
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def settle(self, page: Page) -> None:
        page.evaluate("() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null)))")
        page.wait_for_timeout(300)

    def open_new(self, page: Page) -> None:
        """New from the sidebar (a conversation's composer has the focus, so C would type)."""
        page.get_by_role("complementary", name="Sidebar").get_by_role("button", name="New", exact=True).click()

    def message(self, page: Page, text: str):
        return page.locator(".project-convo__message", has_text=text).last

    # ---------------------------------------------------------------- new P2-1: a task made from My tasks is yours

    def test_01_a_task_made_from_my_tasks_is_yours(self) -> None:
        self.space("Mine", LINES[:2])
        page = self.page("ada")
        page.goto("/tasks")
        expect(page.get_by_role("heading", name="My tasks").first).to_be_visible()
        page.wait_for_timeout(800)
        self.open_new(page)
        expect(title_field(page)).to_be_focused()
        # The Owner starts as you, before anything is chosen.
        expect(dialog(page).locator(".create__chip", has=page.get_by_role("combobox", name="Owner"))).to_contain_text("(you)")
        title_field(page).fill("Buy two spare probes")
        submit_button(page).click()
        expect(dialog(page)).to_have_count(0)
        page.goto("/tasks")
        expect(page.get_by_text("Buy two spare probes")).to_be_visible()

    # ---------------------------------------------------------------- daily P2-4: Send keeps the keyboard

    def test_02_send_on_a_phone_keeps_the_focus_in_the_field(self) -> None:
        dm = self.call("ada", "POST", f"/api/v1/workspaces/{self.ids['ws']}/dms", {"participantIds": [self.ids["jonas"]]})["id"]
        self.call("jonas", "POST", f"/api/v1/dms/{dm}/messages", {"body": "Can you come in at seven on Saturday?", "clientMessageId": str(uuid.uuid4())})
        page = self.page("ada", PHONE)
        page.goto(f"/dm/{dm}")
        field = page.locator("#dm-composer")
        expect(field).to_be_visible()
        field.tap()
        expect(field).to_be_focused()
        field.fill("Yes, I will be there.")
        page.locator(".dm__composer .composer__send").tap()
        expect(page.locator(".dm-msg", has_text="Yes, I will be there.")).to_be_visible()
        expect(field).to_be_focused()
        expect(field).to_have_value("")

    # ---------------------------------------------------------------- daily P2-5: the New space window lines up

    def test_03_the_new_space_window_has_one_kind_of_label_and_one_edge(self) -> None:
        page = self.page("ada")
        page.goto("/projects")
        expect(page.get_by_role("list", name="Spaces")).to_be_visible()
        self.open_new(page)
        expect(page.get_by_role("tab", name="Space")).to_be_visible()
        page.get_by_role("tab", name="Space").click()
        form = page.locator("form.newspace")
        expect(form.get_by_label("Space name")).to_be_visible()
        self.settle(page)
        name = form.locator(".ui-field__label", has_text="Name").first
        people = form.locator(".newspace__label").first
        for prop in ("font-weight", "font-size", "color"):
            self.assertEqual(name.evaluate(f"e => getComputedStyle(e)['{prop}']"), people.evaluate(f"e => getComputedStyle(e)['{prop}']"), f"Name and People share {prop}")
        head = form.locator(".newspace__head").bounding_box()
        label = name.bounding_box()
        assert head and label
        self.assertGreaterEqual(label["y"] - (head["y"] + head["height"]), 12, "the Name label has room under the head's line")
        words = form.locator(".newspace__switches .sset-row__t").evaluate_all("els => els.map((e) => e.getBoundingClientRect().left)")
        self.assertEqual(len(words), 2)
        self.assertAlmostEqual(words[0], words[1], delta=1, msg="AI's and Encrypted's words start at one edge")

    # ---------------------------------------------------------------- look-2 P2-1: staged files never hide the end

    def test_04_staging_files_at_the_end_keeps_the_newest_message_in_view(self) -> None:
        project = self.space("Staged", LINES * 3)
        for viewport in (DESKTOP, PHONE):
            with self.subTest(phone=viewport == PHONE):
                page = self.page("ada", viewport)
                page.goto(f"/projects/{project}")
                last = self.message(page, LINES[-1][1])
                expect(last).to_be_in_viewport()
                page.wait_for_timeout(1500)
                field = page.get_by_label("Write a message", exact=True)
                field.fill("Photo of the new seals and the order list for the shed, please check the sizes before Friday.")
                page.locator(".project-convo__composer input[type=file]").first.set_input_files([
                    {"name": "IMG_2061.png", "mimeType": "image/png", "buffer": png()},
                    {"name": "flour-order-november.txt", "mimeType": "text/plain", "buffer": b"flour,kg\nrye,25\nwheat,50\n"}])
                expect(page.get_by_role("list", name="Files in your draft").get_by_text("Ready to send", exact=False)).to_have_count(2)
                self.settle(page)
                page.wait_for_timeout(500)
                box = last.bounding_box()
                feed = page.locator(".project-convo__feed").bounding_box()
                assert box and feed
                self.assertLessEqual(box["y"] + box["height"], feed["y"] + feed["height"] + 1, f"the newest message stays above the tray: {box} / {feed}")

    # ---------------------------------------------------------------- look-2 P2-2: Back keeps the place on a phone

    def test_05_back_comes_back_to_a_decision_card_on_the_phone(self) -> None:
        project = self.space("Back", LINES[:6])
        decision = self.call("ada", "POST", f"/api/v1/projects/{project}/decisions", {"title": "Rubber seals for every gateway box", "rationale": "They last longer."})
        for index in range(60):
            self.say("jonas" if index % 2 else "ola", project, f"Bed check {index + 1:02}: the soil is fine, nothing to water today.")
        page = self.page("ada", PHONE)
        page.goto(f"/projects/{project}")
        expect(self.message(page, "Bed check 60")).to_be_visible()
        card = page.locator(f'.convo-object[data-object-id="{decision["id"]}"]')
        for _ in range(6):
            if card.count():
                break
            page.get_by_role("button", name="Load earlier messages").click()
            page.wait_for_timeout(1200)
        expect(card).to_have_count(1)
        feed = page.locator(".project-convo__feed")
        # The decision card is the first thing in view: the reader's place.
        feed.evaluate("(feed, card) => { feed.scrollTop += card.getBoundingClientRect().top - feed.getBoundingClientRect().top + 4; }", card.element_handle())
        page.wait_for_timeout(1000)
        place = card.bounding_box()
        assert place
        page.get_by_role("tab", name="Wiki").click()
        expect(page).to_have_url(re.compile(r"/docs"))
        page.wait_for_timeout(800)
        page.go_back()
        expect(page).to_have_url(re.compile(rf"/projects/{project}$"))
        expect(card).to_be_in_viewport(timeout=4000)
        back = card.bounding_box()
        assert back
        self.assertAlmostEqual(back["y"], place["y"], delta=6, msg="the card is where it was")

    # ---------------------------------------------------------------- look-2 P2-3: #N opens the panel in place

    def test_06_a_task_chip_opens_its_panel_beside_the_conversation(self) -> None:
        project = self.space("Chips", LINES[:2])
        task = self.call("ada", "POST", f"/api/v1/projects/{project}/work", {"title": "Order rye flour"})
        self.say("jonas", project, f"Please see #{task['number']} (the rye) before Friday.")
        page = self.page("ada")
        page.goto(f"/projects/{project}")
        chip = self.message(page, "Please see").locator(".ref-chip--task")
        expect(chip).to_have_text(f"#{task['number']}")
        chip.click()
        panel = page.locator("#details .wd--task")
        expect(panel).to_be_visible()
        expect(panel).to_contain_text("Order rye flour")
        expect(page).to_have_url(re.compile(rf"/projects/{project}(\?|$)"))
        expect(page.locator(".project-convo__feed")).to_be_visible()
        page.keyboard.press("Escape")
        expect(panel).to_have_count(0)
        expect(page).not_to_have_url(re.compile(r"/tasks"))
        expect(self.message(page, "Please see")).to_be_visible()

    # ---------------------------------------------------------------- look-2 P2-4: composers side by side at one height

    def test_07_composers_side_by_side_end_at_one_height(self) -> None:
        project = self.space("Threads", LINES[:3])
        root = self.say("jonas", project, "Short update: the second gateway works from the shed roof.")
        conversation = root.get("id") or root["conversation"]["id"]
        for who, body in (("ada", "Nice. Does the hedge matter?"), ("jonas", "The hedge, I think.")):
            self.call(who, "POST", f"/api/v1/conversations/{conversation}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())})
        page = self.page("ada")
        page.goto(f"/projects/{project}")
        expect(page.locator("#project-composer")).to_be_visible()
        self.settle(page)
        alone = page.evaluate(BOXES)["project-composer"]
        self.message(page, "Short update").locator(".convo-replies__open").click()
        expect(page.locator("#thread-composer")).to_be_visible()
        self.settle(page)
        boxes = page.evaluate(BOXES)
        self.assertAlmostEqual(boxes["thread-composer"], boxes["project-composer"], delta=1, msg=f"a space and its thread: {boxes}")
        dm = self.call("ada", "POST", f"/api/v1/workspaces/{self.ids['ws']}/dms", {"participantIds": [self.ids["ola"]]})["id"]
        first = self.call("ola", "POST", f"/api/v1/dms/{dm}/messages", {"body": "Can you send me the rota?", "clientMessageId": str(uuid.uuid4())})
        self.call("ada", "POST", f"/api/v1/dms/{dm}/threads/{first['id']}/replies", {"body": "Yes, tonight.", "clientMessageId": str(uuid.uuid4())})
        page.goto(f"/dm/{dm}")
        expect(page.locator("#dm-composer")).to_be_visible()
        self.settle(page)
        self.assertAlmostEqual(page.evaluate(BOXES)["dm-composer"], alone, delta=1, msg="a direct message's composer ends where a space's does")
        self.assertEqual(page.locator(".dm__composer").first.evaluate("e => getComputedStyle(e).borderTopWidth"), "0px", "no rule above it, as a space's")
        page.locator(".dm-replies").first.click()
        expect(page.locator("#dm-thread-composer")).to_be_visible()
        self.settle(page)
        boxes = page.evaluate(BOXES)
        self.assertAlmostEqual(boxes["dm-thread-composer"], boxes["dm-composer"], delta=1, msg=f"a direct message and its thread: {boxes}")

    # ---------------------------------------------------------------- look-2 P2-5: the link search grows only for results

    def test_08_from_a_message_keeps_the_window_until_a_word_is_typed(self) -> None:
        project = self.space("Link", LINES[:3])
        page = self.page("ada")
        page.goto(f"/projects/{project}")
        expect(self.message(page, LINES[2][1])).to_be_visible()
        self.open_new(page)
        expect(title_field(page)).to_be_focused()
        window = page.locator(".create").first
        height = window.evaluate("e => e.getBoundingClientRect().height")
        dialog(page).get_by_role("button", name="+ From a message or thought").click()
        search = dialog(page).get_by_role("searchbox", name="Search messages and thoughts")
        expect(search).to_be_focused()
        expect(dialog(page).get_by_text("Type a few words of the message or the thought.")).to_be_visible()
        self.settle(page)
        self.assertLessEqual(window.evaluate("e => e.getBoundingClientRect().height") - height, 60, "no empty room under an empty search")
        search.fill("shed")
        expect(dialog(page).get_by_role("list", name="Messages and thoughts").get_by_role("button")).not_to_have_count(0)

    # ---------------------------------------------------------------- look-2 P2-6: the whole title on the phone

    def test_09_a_long_title_wraps_on_the_phone(self) -> None:
        project = self.space("Long", [("ola", LONG)])
        page = self.page("ada", PHONE)
        page.goto(f"/projects/{project}")
        message = self.message(page, "before Saturday could someone")
        expect(message).to_be_visible()
        menu = open_message_menu(message, phone=True)
        menu.get_by_role("menuitem", name="Create task").click()
        field = title_field(page)
        expect(field).to_be_visible()
        self.settle(page)
        value = field.input_value()
        self.assertGreater(len(value), 40, f"the title carries the message's words: {value!r}")
        shown = field.evaluate("e => ({ tag: e.tagName, sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight })")
        self.assertLessEqual(shown["sw"], shown["cw"] + 1, f"no words run out of sight sideways: {shown}")
        self.assertLessEqual(shown["sh"], shown["ch"] + 1, f"every line of it shows: {shown}")
        # Enter still creates the task, as in a one-line field.
        field.press("End")
        field.press("Enter")
        expect(dialog(page)).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
