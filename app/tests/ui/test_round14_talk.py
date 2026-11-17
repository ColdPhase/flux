"""Release gate round 14, the conversation, direct messages and Create (train/v021-37): what a person sees there is never cut or hidden.

Runs through scripts/check_ui.sh against the running Compose application, on the engine named by FLUX_UI_BROWSER (run it with chromium
and with webkit), on a computer (1440 x 900) and a phone (390 x 844):

* P2 (new 4, look-b B5): a staged file's line, "Image · 1.2 KB · Ready to send", is whole in its tile; the tile is as wide as its words,
  and on a touch screen the order number stands before the name, off the photo.
* P2 (daily 5): Create task from a long message shows the message's chip and "+ From a message or thought" whole above the footer's line.
* P2 (look-b B2): right after Create task the new task's card is whole above the composer and the toast, also in a conversation that
  opened at "New" with everything new in view.
* P3: a direct message's column and composer are a space's; "N replies · last 9:40" under a direct message's root; one divider where
  what is new starts a day ("New · Today"); the composer's ring is its edge.
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
from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, start_forwarder

PASSWORD = "round fourteen talk"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.round14+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.round14+{STAMP}@example.test"),
    "ola": ("Ola Nowicka", f"ola.round14+{STAMP}@example.test"),
}
EARLIER = [("jonas", "The far east bed stayed online all night, first time this month."), ("ola", "The seals arrived, both kinds. Rubber looks better."),
           ("jonas", "Someone left the shed unlocked again, I locked it at six."), ("ola", "The budget draft is in the Wiki, please read it by Friday."),
           ("jonas", "I can be at the garden at nine on Saturday to help with bed four."), ("ola", "Rota for December is up, please check your Saturdays."),
           ("jonas", "The probe in bed four was half out of the soil, I pushed it back in."), ("ola", "Then bed four needs a fresh reading tomorrow."),
           ("jonas", "The gateway rebooted twice last night, I will check the power supply."), ("ola", "Thanks, the spare supply is on the top shelf.")]
NEWER = [("jonas", "Gateway is fine now, it was the loose plug."), ("ola", "Great, then we keep the old supply as the spare."),
         ("jonas", "I will label it so nobody takes it for the fair."), ("ola", "Good, and put the spare probes in the same box."),
         ("jonas", "Done, the box is on the top shelf by the door.")]
LONG = "Kick-off: the spring fair is on 17 April. We need a stand plan, a volunteer list and a budget by December, and two tables near the power."


def png(width: int = 96, height: int = 64) -> bytes:
    """A real PNG with a visible gradient, written without image libraries."""
    rows = b"".join(b"\x00" + bytes(value for x in range(width) for value in ((x * 5) % 256, (y * 8) % 256, 170)) for y in range(height))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


class RoundFourteenTalk(unittest.TestCase):
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

    # ---------------------------------------------------------------- P2: a staged file's line is whole

    def test_01_a_staged_file_says_ready_to_send_whole(self) -> None:
        project = self.space("Staged", EARLIER[:3])
        for viewport in (DESKTOP, PHONE):
            phone = viewport == PHONE
            with self.subTest(phone=phone):
                page = self.page("ada", viewport)
                page.goto(f"/projects/{project}")
                field = page.get_by_label("Write a message", exact=True)
                expect(field).to_be_visible()
                field.fill("Photo of the new seals and the order list.")
                page.locator(".project-convo__composer input[type=file]").first.set_input_files([
                    {"name": "IMG_2061.png", "mimeType": "image/png", "buffer": png()},
                    {"name": "flour-order-november.txt", "mimeType": "text/plain", "buffer": b"flour,kg\nrye,25\nwheat,50\n"}])
                draft = page.get_by_role("list", name="Files in your draft")
                expect(draft.get_by_text("Ready to send", exact=False)).to_have_count(2)
                expect(draft.locator(".composer-thumb.is-photo img")).to_have_count(1)
                self.settle(page)
                tiles = draft.locator("li.composer-thumb")
                for index in range(2):
                    tile = tiles.nth(index)
                    line = tile.locator(".composer-files__name small")
                    # Nothing of the line is cut: every word of it is inside the tile ("Ready to s…" in round 14).
                    cut = line.evaluate("el => el.scrollWidth - el.clientWidth")
                    self.assertLessEqual(cut, 1, f"tile {index}: the line is cut by {cut} px ({line.inner_text()!r})")
                    words = line.evaluate("""el => { const range = document.createRange(); range.selectNodeContents(el); const r = range.getBoundingClientRect();
                      const box = el.closest('li').getBoundingClientRect(); return { right: r.right, tile: box.right, text: el.textContent }; }""")
                    self.assertLessEqual(words["right"], words["tile"] - 6, f"tile {index}: the line runs to the tile's edge: {words}")
                    self.assertIn("Ready to send", words["text"])
                if phone:
                    # On a touch screen the order number is off the photo, before the name.
                    photo = tiles.nth(0).locator(".composer-thumb__face").bounding_box()
                    order = tiles.nth(0).locator(".composer-thumb__order").bounding_box()
                    assert photo and order
                    apart = order["x"] >= photo["x"] + photo["width"] or order["y"] >= photo["y"] + photo["height"] or order["x"] + order["width"] <= photo["x"] or order["y"] + order["height"] <= photo["y"]
                    self.assertTrue(apart, f"the order number stands off the photo: {order} over {photo}")

    # ---------------------------------------------------------------- P2: Create from a long message shows its chips whole

    def test_02_create_from_a_long_message_shows_every_chip_above_the_footer(self) -> None:
        project = self.space("Fair", [("ola", LONG)])
        page = self.page("ada")
        page.goto(f"/projects/{project}")
        message = page.locator(".project-convo__message", has_text="Kick-off: the spring fair")
        expect(message).to_be_visible()
        message.hover()
        message.get_by_role("button", name="Create task", exact=True).click()
        expect(dialog(page)).to_be_visible()
        expect(title_field(page)).to_be_visible()
        self.settle(page)
        window = dialog(page)
        foot = window.locator(".create__foot:visible").bounding_box()
        link = window.get_by_role("button", name="+ From a message or thought").bounding_box()
        chip = window.locator(".create__chip--link").first.bounding_box()
        assert foot and link and chip
        for name, box in (("the message's chip", chip), ("+ From a message or thought", link)):
            self.assertLessEqual(box["y"] + box["height"], foot["y"] + 0.5, f"{name} ends above the footer's line: {box} / footer {foot}")
        scroll = window.locator(".create__scroll:visible")
        self.assertLessEqual(scroll.evaluate("el => el.scrollHeight - el.clientHeight"), 1, "nothing of the window hides under its footer")
        # The words of the title start on the column's edge, where the chips start (one inset, round 14).
        title = window.locator(".create__title:visible").evaluate("el => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft)")
        self.assertAlmostEqual(title, chip["x"], delta=1, msg="the title's words start where the chips start")

    # ---------------------------------------------------------------- P2: the new task's card is whole after Create

    def test_03_the_new_task_card_is_whole_above_the_composer_and_toast(self) -> None:
        project = self.space("Beds", EARLIER)
        page = self.page("ada")
        # Ada reads the space to its end and goes to Messages in the app; five messages arrive meanwhile; she comes back, and the space
        # opens at "New" with all of it in view: at its end, though she never scrolled there (round 14, look-b B2).
        page.goto(f"/projects/{project}")
        expect(page.locator(".project-convo__message", has_text=EARLIER[-1][1])).to_be_visible()
        page.mouse.move(600, 400)
        for _ in range(6):
            page.mouse.wheel(0, 1500)
            page.wait_for_timeout(100)
        page.wait_for_timeout(1500)
        page.evaluate("(path) => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate', { state: {} })); }", "/dm")
        page.wait_for_timeout(1000)
        for who, body in NEWER:
            self.say(who, project, body)
        page.wait_for_timeout(1000)
        page.evaluate("(path) => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate', { state: {} })); }", f"/projects/{project}")
        expect(page.locator(".project-convo__message", has_text=NEWER[-1][1])).to_be_visible()
        expect(page.get_by_role("separator", name="New")).to_have_count(1)
        page.wait_for_timeout(2500)
        self.settle(page)
        page.get_by_role("complementary", name="Sidebar").get_by_role("button", name="New", exact=True).click()
        expect(title_field(page)).to_be_visible()
        title_field(page).fill("Label the spare power supply")
        submit_button(page).click()
        expect(dialog(page)).to_have_count(0)
        toast = page.locator(".ui-toast", has_text="created")
        expect(toast).to_be_visible()
        card = page.locator(".project-convo__message-list > li", has_text="Label the spare power supply")
        expect(card).to_be_visible()
        page.wait_for_timeout(1200)
        box = card.bounding_box()
        composer = page.locator(".project-convo__composer .composer__box").bounding_box()
        above = toast.bounding_box()
        assert box and composer and above
        self.assertLessEqual(box["y"] + box["height"], composer["y"], f"the card ends above the composer: {box} / {composer}")
        overlaps = box["x"] < above["x"] + above["width"] and above["x"] < box["x"] + box["width"]
        if overlaps:
            self.assertLessEqual(box["y"] + box["height"], above["y"] + 0.5, f"the card ends above the toast: {box} / {above}")

    # ---------------------------------------------------------------- P3s

    def test_04_a_direct_message_reads_in_a_space_column_with_one_thread_line(self) -> None:
        dm = self.call("ada", "POST", f"/api/v1/workspaces/{self.ids['ws']}/dms", {"participantIds": [self.ids["jonas"]]})["id"]
        root = self.call("jonas", "POST", f"/api/v1/dms/{dm}/messages", {"body": "Ms. Novak says yes: two kits on Thursday.", "clientMessageId": str(uuid.uuid4())})
        for who, body in (("ada", "Brilliant. Can you take the car?"), ("jonas", "Yes, I will bring them to the shed."), ("ada", "Thanks! I will tell the others.")):
            self.call(who, "POST", f"/api/v1/dms/{dm}/threads/{root['id']}/replies", {"body": body, "clientMessageId": str(uuid.uuid4())})
        project = self.space("Width", EARLIER[:2])
        page = self.page("ada")
        page.goto(f"/projects/{project}")
        space_box = page.locator(".project-convo__composer .composer__box").bounding_box()
        page.goto(f"/dm/{dm}")
        replies = page.locator(".dm-replies")
        expect(replies).to_contain_text(re.compile(r"3 replies\s*· last \d{1,2}:\d{2}"))
        dm_box = page.locator(".dm__composer .composer__box").bounding_box()
        assert space_box and dm_box
        self.assertAlmostEqual(dm_box["width"], space_box["width"], delta=1, msg="a direct message's composer is a space's")
        self.assertAlmostEqual(dm_box["x"], space_box["x"], delta=1, msg="and stands where a space's stands")
        replies.click()
        thread = page.locator(".dm-thread")
        # One line between the message and its replies, "3 replies · Today", and no empty rule above a day line.
        expect(thread.locator(".thread__hint:not([role=status])")).to_have_text("3 replies · Today")
        expect(thread.locator(".thread__list .message-day")).to_have_count(0)
        # The composer's ring is its own edge, never a second outline with a gap round it.
        offset = page.locator("#dm-composer").evaluate("el => { el.focus(); return getComputedStyle(el.closest('.composer__box')).outlineOffset; }")
        self.assertEqual(offset, "-1px")

    def test_05_new_on_a_new_day_is_one_divider(self) -> None:
        dm = self.call("jonas", "POST", f"/api/v1/workspaces/{self.ids['ws']}/dms", {"participantIds": [self.ids["ola"]]})["id"]
        for body in ("Welcome back! Lots happened in the garden.", "Can you come in at seven on Saturday?"):
            self.call("jonas", "POST", f"/api/v1/dms/{dm}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())})
        for viewport in (DESKTOP, PHONE):
            with self.subTest(phone=viewport == PHONE):
                page = self.page("ola", viewport)
                page.goto(f"/dm/{dm}")
                divider = page.get_by_role("separator", name="New")
                expect(divider).to_have_count(1)
                expect(divider).to_have_text("New · Today")
                # No day line stacked over it.
                expect(page.locator(".dm__list .message-day")).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
