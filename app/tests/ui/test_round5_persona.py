"""Persona round 5 (personas-28, train/v021-28): nothing misleading, one way of saying one thing.

Runs through scripts/check_ui.sh against the running Compose application, on the engine named by FLUX_UI_BROWSER (run it with chromium
and with webkit), on a computer (1440 x 900) and a phone (390 x 844):

* P2 4: a question asked before someone joined reaches them from its asker, with the asker's face, not the joiner's.
* Undo: the "N new" line stops counting a task whose creation was undone; the undone task's panel names the person as every list does
  ("Name (you)") and mentions an unsent draft only when there is one; an undone status change leaves no line in the task's history.
* A blocked task is said one way on the board, the panel, My tasks and the Inbox, whose row does not repeat its title.
* The phone's Spaces list shows the line just sent in a direct message without a reload.
* Words: the company's invite sentence says how long the link works, as the space's does; Remove and Restore say "no longer in" and "back
  in", with a full stop; New space says who you are in it; the decision form's plain words; the waiting line says whose turn in words;
  "Decision proposed" does not cover the new decision's card.
"""

from __future__ import annotations

import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from create_window import create_other, open_decision
from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, start_forwarder

PASSWORD = "round five persona words"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "piotr": ("Piotr Nowak", f"piotr.round5+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.round5+{STAMP}@example.test"),
    "ola": ("Ola Nowicka", f"ola.round5+{STAMP}@example.test"),
    "tomek": ("Tomek Wiśniewski", f"tomek.round5+{STAMP}@example.test"),
    "basia": ("Basia Wrona", f"basia.round5+{STAMP}@example.test"),
}
QUESTION = "Ola, could you check the delivery van tyres on Monday?"


class RoundFive(unittest.TestCase):
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
        cls.ids["ws"] = cls.call("piotr", "POST", "/api/v1/workspaces", {"name": "Bakery"})["id"]
        # Ola joins later (test_01).
        for key in ("jonas", "tomek", "basia"):
            cls.call("piotr", "POST", f"/api/v1/workspaces/{cls.ids['ws']}/members", {"email": PEOPLE[key][1], "role": "member"})
        cls.ids["shift"] = cls.call("piotr", "POST", f"/api/v1/workspaces/{cls.ids['ws']}/projects", {"name": "Morning shift", "visibility": "workspace"})["id"]
        cls.ids["feed"] = cls.call("piotr", "POST", f"/api/v1/workspaces/{cls.ids['ws']}/projects", {"name": "Long feed", "visibility": "workspace"})["id"]
        # A feed long enough to read above its end.
        for index in range(36):
            who = "piotr" if index % 2 else "jonas"
            cls.call(who, "POST", f"/api/v1/projects/{cls.ids['feed']}/conversations",
                     {"body": f"Shift note {index + 1}: the ovens, the trays and the flour for Saturday.", "clientMessageId": str(uuid.uuid4())})

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

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

    def task(self, who: str, title: str, **body) -> dict:
        return self.call(who, "POST", f"/api/v1/projects/{self.ids['shift']}/work", {"title": title, "clientCommandId": str(uuid.uuid4()), **body})

    def patch(self, who: str, task: dict, body: dict) -> dict:
        context = self.browser.new_context(base_url=ORIGIN, storage_state=self.states[who], service_workers="block")
        try:
            response = context.request.fetch(f"/api/v1/work/{task['id']}", method="PATCH", data={"clientCommandId": str(uuid.uuid4()), **body},
                                             headers={"origin": ORIGIN, "If-Match": f"\"{task['version']}\""})
            assert response.status == 200, response.text()
            return response.json()
        finally:
            context.close()

    # ---------------------------------------------------------------- P2 4

    def test_01_a_question_asked_before_someone_joined_comes_from_its_asker(self) -> None:
        self.call("jonas", "POST", f"/api/v1/projects/{self.ids['shift']}/conversations", {"body": QUESTION, "clientMessageId": str(uuid.uuid4())})
        # Piotr adds Ola to the company; Jonas asked.
        self.call("piotr", "POST", f"/api/v1/workspaces/{self.ids['ws']}/members", {"email": PEOPLE["ola"][1], "role": "member"})
        ola = self.page("ola")
        ola.goto("/inbox")
        row = ola.locator(".nyc").filter(has_text="delivery van tyres").first
        expect(row).to_be_visible(timeout=30000)
        expect(row.locator(".nyc__eyebrow--row")).to_have_text("Question · Jonas Berg · Morning shift")
        expect(row.locator(".nyc__face").first).to_have_text("JB")
        expect(row).not_to_contain_text("Ola Nowicka")
        expect(row).not_to_contain_text("Piotr Nowak")
        # Home says the same.
        ola.goto("/")
        need = ola.get_by_role("region", name=re.compile("^Waiting for you"))
        home_row = need.locator(".home__row").filter(has_text="delivery van tyres")
        expect(home_row).to_contain_text("Jonas Berg")
        expect(home_row).not_to_contain_text("Ola Nowicka")

    # ---------------------------------------------------------------- Undo

    def test_02_the_new_line_stops_counting_a_task_whose_creation_was_undone(self) -> None:
        feed = self.ids["feed"]
        jonas = self.page("jonas")
        jonas.goto(f"/projects/{feed}")
        expect(jonas.locator(".project-convo__message-list li").filter(has_text="Shift note 36")).to_be_visible()
        # Jonas reads above the end.
        jonas.locator(".project-convo__feed").evaluate("(feed) => { feed.scrollTop = 0; }")
        jonas.wait_for_timeout(400)
        made = self.call("piotr", "POST", f"/api/v1/projects/{feed}/work", {"title": "Clean the proofing baskets", "clientCommandId": str(uuid.uuid4())})
        line = jonas.locator(".convo-newbelow__b")
        expect(line).to_have_text("1 new")
        self.call("piotr", "POST", f"/api/v1/work/{made['id']}/creation-undo", {"clientCommandId": str(uuid.uuid4()), "expectedVersion": made["version"]})
        expect(jonas.locator(f'.convo-notice[data-work-id="{made["id"]}"]')).to_have_count(0)
        expect(line).to_have_count(0)

    def test_03_an_undone_task_names_its_reader_as_every_list_does(self) -> None:
        made = self.task("piotr", "Order the rye flour")
        self.call("piotr", "POST", f"/api/v1/work/{made['id']}/creation-undo", {"clientCommandId": str(uuid.uuid4()), "expectedVersion": made["version"]})
        page = self.page("piotr")
        page.goto(f"/projects/{self.ids['shift']}/tasks?open=work:{made['id']}")
        history = page.locator('[data-task-lifecycle="creation_reverted"]')
        expect(history).to_contain_text("Creation undone by Piotr Nowak (you) today.")
        # The history line beside it has the same form.
        expect(page.locator(".wd-act__item[data-activity='reverted']")).to_contain_text("Piotr Nowak (you)")
        # No draft was written: none is mentioned, and the panel does not say "undone" again at its foot (audit 3274a05).
        expect(page.locator(".wd-foot__note")).to_have_count(0)

    def test_04_an_undone_change_leaves_no_line_in_the_history(self) -> None:
        made = self.task("piotr", "Sweep the bakery yard")
        done = self.patch("piotr", made, {"status": "done"})
        self.patch("piotr", done, {"status": "open", "restore": True})
        page = self.page("piotr")
        page.goto(f"/projects/{self.ids['shift']}/tasks?open=work:{made['id']}")
        activity = page.get_by_role("list", name="Task activity", exact=True)
        expect(activity.locator(".wd-act__item[data-activity='created']")).to_be_visible()
        expect(activity.locator(".wd-act__item[data-activity='status']")).to_have_count(0)
        expect(activity).not_to_contain_text("marked it")

    # ---------------------------------------------------------------- Inbox and lists

    def test_05_a_blocked_task_reads_one_way_everywhere(self) -> None:
        words = "Waiting for Jonas Berg · the new seals"
        made = self.task("piotr", "Seal the lids", owner={"kind": "human", "id": self.ids["piotr"]})
        blocked = self.patch("piotr", made, {"status": "blocked", "blocker": "the new seals", "waitingFor": {"kind": "human", "id": self.ids["jonas"]}})
        number = blocked["number"]
        page = self.page("piotr")
        page.goto(f"/projects/{self.ids['shift']}/tasks")
        page.get_by_role("radio", name="Board", exact=True).click()
        expect(page.locator(f".tb-card[data-card-id='{made['id']}'] .tb-card__blocker")).to_have_text(words)
        page.goto(f"/projects/{self.ids['shift']}/tasks?open=work:{made['id']}")
        expect(page.locator(".wd-blocker__text")).to_have_text(words)
        page.goto("/tasks")
        expect(page.locator(".home-tasks__item").filter(has_text="Seal the lids").locator(".home-tasks__why")).to_have_text(words)
        page.goto("/inbox")
        row = page.locator(".nyc").filter(has_text="Seal the lids").first
        expect(row.locator(".nyc__open")).to_have_text(f"#{number} Seal the lids")
        expect(row.locator(".nyc__snippet")).to_have_text(words)
        self.assertEqual(row.inner_text().count("Seal the lids"), 1, "the row says the title once")

    def test_06_a_message_just_sent_shows_on_the_phones_spaces_list(self) -> None:
        dm = self.call("tomek", "POST", f"/api/v1/workspaces/{self.ids['ws']}/dms", {"participantIds": [self.ids["piotr"]]})
        self.call("piotr", "POST", f"/api/v1/dms/{dm['id']}/messages", {"body": "Can you come in at 7 on Saturday?", "clientMessageId": str(uuid.uuid4())})
        page = self.page("tomek", PHONE)
        page.goto("/projects")
        row = page.locator(".proj-index__one").filter(has_text="Can you come in at 7 on Saturday?")
        expect(row).to_be_visible()
        # In the app, never a new page load: the shell's data is what the list shows.
        row.tap()
        expect(page).to_have_url(re.compile(rf"/dm/{dm['id']}"))
        composer = page.get_by_label(re.compile("^Message "))
        composer.fill("I will bring coffee too")
        page.get_by_role("button", name="Send message").tap()
        expect(page.locator(".dm__list")).to_contain_text("I will bring coffee too")
        page.wait_for_timeout(800)
        page.go_back()
        expect(page).to_have_url(re.compile(r"/projects$"))
        expect(page.locator(".proj-index__one").filter(has_text="I will bring coffee too")).to_be_visible()

    # ---------------------------------------------------------------- Words

    def test_07_the_company_invite_says_how_long_its_link_works(self) -> None:
        page = self.page("piotr")
        page.goto("/settings/company?invite=1")
        invite = page.get_by_role("region", name="Invite people")
        invite.get_by_role("button", name="Create invite link").click()
        expect(page.get_by_role("status").filter(has_text="Invite link created")).to_contain_text("It works once, for 7 days")

    def test_08_remove_and_restore_say_it_the_same_way(self) -> None:
        page = self.page("piotr")
        page.goto("/settings/company")
        page.get_by_role("button", name="Remove Basia Wrona from Bakery").click()
        page.get_by_role("group", name="Remove Basia Wrona").get_by_role("button", name="Remove", exact=True).click()
        expect(page.get_by_text("Basia Wrona is no longer in Bakery.", exact=True)).to_be_visible()
        page.get_by_role("list", name="People who were removed").get_by_role("button", name="Restore").click()
        expect(page.get_by_text("Basia Wrona is back in Bakery.", exact=True)).to_be_visible()

    def test_09_new_space_and_the_decision_form_say_it_plainly(self) -> None:
        page = self.page("jonas")
        page.goto(f"/projects/{self.ids['shift']}")
        decision = open_decision(page)
        expect(decision.get_by_placeholder("Why (optional)")).to_be_visible()
        expect(decision).to_contain_text("Everyone who can accept it sees it in their Inbox")
        expect(decision).not_to_contain_text("right call")
        page.keyboard.press("Escape")
        page.get_by_role("complementary", name="Sidebar").get_by_role("button", name="New", exact=True).click()
        create_other(page, "Space")
        expect(page.get_by_role("dialog", name="New space")).to_contain_text("You’re in it as its admin.")

    def test_10_the_waiting_line_says_whose_turn_in_words(self) -> None:
        self.call("piotr", "POST", f"/api/v1/projects/{self.ids['shift']}/decisions", {"title": "Bake the rye on Fridays"})
        page = self.page("jonas")
        page.goto("/inbox")
        page.locator(".nyc").filter(has_text="Bake the rye on Fridays").first.locator(".nyc__open").click()
        line = page.locator(".nyc__waiting").first
        expect(line).to_contain_text("Waiting for you")
        expect(line.locator(".ui-avatar--me")).to_have_count(0)
        self.assertTrue(line.inner_text().strip().startswith("Waiting for you"), line.inner_text())

    def test_11_decision_proposed_does_not_cover_the_new_card(self) -> None:
        feed = self.ids["feed"]
        page = self.page("piotr")
        page.goto(f"/projects/{feed}")
        expect(page.locator(".project-convo__message-list li").filter(has_text="Shift note 36")).to_be_visible()
        # Reading above the end, as Jonas was.
        page.locator(".project-convo__feed").evaluate("(feed) => { feed.scrollTop = Math.max(0, feed.scrollHeight - feed.clientHeight - 500); }")
        decision = open_decision(page)
        decision.get_by_role("textbox", name="Decision", exact=True).fill("Borrow the school's van on market days")
        decision.get_by_role("button", name=re.compile("^Propose decision")).click()
        expect(decision).to_have_count(0)
        card = page.locator("#content [data-decision-card]").filter(has_text="Borrow the school's van on market days")
        expect(card).to_be_focused()
        toast = page.locator(".ui-toast").filter(has_text="Decision proposed")
        expect(toast).to_be_visible()
        page.wait_for_timeout(1200)
        card_box, toast_box = card.bounding_box(), toast.bounding_box()
        self.assertLessEqual(card_box["y"] + card_box["height"], toast_box["y"] + 1, f"the card {card_box} stands clear of the toast {toast_box}")

    def test_11b_decision_proposed_never_covers_the_new_card_while_it_settles(self) -> None:
        """From the moment the new card has focus, sampled every 100 ms while the toast comes in and settles (J55)."""
        page = self.page("piotr")
        page.goto(f"/projects/{self.ids['feed']}")
        expect(page.locator(".project-convo__message-list li").filter(has_text="Shift note 36")).to_be_visible()
        decision = open_decision(page)
        decision.get_by_role("textbox", name="Decision", exact=True).fill("Open the market stall at eight")
        decision.get_by_role("textbox", name="Decision", exact=True).press("Control+Enter")
        card = page.locator("#content [data-decision-card]").filter(has_text="Open the market stall at eight")
        expect(card).to_be_focused()
        samples = page.evaluate("""async () => {
          const card = document.activeElement; const out = [];
          for (let i = 0; i < 16; i += 1) {
            const toast = [...document.querySelectorAll('.ui-toast')].find((el) => el.textContent.includes('Decision proposed'));
            if (toast) out.push(Math.round(card.getBoundingClientRect().bottom - toast.getBoundingClientRect().top));
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return out;
        }""")
        self.assertTrue(samples, "the toast showed")
        self.assertLessEqual(max(samples), 1, f"the card's bottom over the toast's top, px, every 100 ms: {samples}")

    # ---------------------------------------------------------------- the full screen audit at 3274a05

    def test_12_a_thread_with_a_task_card_never_scrolls_sideways_on_touch(self) -> None:
        shift = self.ids["shift"]
        root = self.call("piotr", "POST", f"/api/v1/projects/{shift}/conversations", {"body": "Sensors for the cold room", "clientMessageId": str(uuid.uuid4())})
        reply = self.call("jonas", "POST", f"/api/v1/conversations/{root['id']}/messages",
                          {"body": "Then let us order six of the small probes and keep two spare for the walk-in fridge.", "clientMessageId": str(uuid.uuid4())})
        self.call("jonas", "POST", f"/api/v1/projects/{shift}/work", {"title": "Order six small probes", "sources": [{"type": "message", "id": reply["id"]}],
                                                                      "clientCommandId": str(uuid.uuid4())})
        for size in (PHONE, {"width": 1180, "height": 820}):
            with self.subTest(width=size["width"]):
                context = self.browser.new_context(service_workers="block", base_url=ORIGIN, locale="en-GB", storage_state=self.states["piotr"], viewport=size,
                                                   device_scale_factor=1, has_touch=True, is_mobile=True)
                self.addCleanup(context.close)
                page = context.new_page()
                page.goto(f"/projects/{shift}/messages/{reply['id']}")
                feed = page.locator(".thread__feed")
                message = page.locator(f"#message-{reply['id']}")
                expect(message.locator(".msg-tasks")).to_be_visible()
                page.wait_for_timeout(300)
                widths = feed.evaluate("(el) => [el.scrollWidth, el.clientWidth]")
                self.assertLessEqual(widths[0], widths[1], f"{size['width']}: the thread does not scroll sideways {widths}")
                dots, edge = message.locator("button.msg-touch__sr").bounding_box(), feed.bounding_box()
                self.assertLessEqual(dots["x"] + dots["width"], edge["x"] + edge["width"] + 0.5, f"{size['width']}: the ⋯ stays inside the thread {dots} {edge}")

    def test_13_one_form_of_a_name_in_the_stream_and_the_decision_panel(self) -> None:
        space = self.call("piotr", "POST", f"/api/v1/workspaces/{self.ids['ws']}/projects", {"name": "Names", "visibility": "workspace"})["id"]
        self.call("piotr", "POST", f"/api/v1/projects/{space}/conversations", {"body": "Saturday prep starts at six.", "clientMessageId": str(uuid.uuid4())})
        for title in ("Order flour", "Clean the trays", "Book the van"):
            self.call("piotr", "POST", f"/api/v1/projects/{space}/work", {"title": title, "clientCommandId": str(uuid.uuid4())})
        decision = self.call("piotr", "POST", f"/api/v1/projects/{space}/decisions", {"title": "Bake on Friday nights"})
        page = self.page("piotr")
        page.goto(f"/projects/{space}")
        expect(page.locator(".convo-fold .convo-fold__s")).to_have_text(" · Piotr Nowak (you) created 3 tasks")
        page.goto(f"/projects/{space}?open=decision:{decision['id']}")
        expect(page.locator(".wd-decision-rows")).to_contain_text("Piotr Nowak (you)")
        # Jonas accepts: the line under the card is in the card line's type.
        context = self.browser.new_context(base_url=ORIGIN, storage_state=self.states["jonas"], service_workers="block")
        accepted = context.request.post(f"/api/v1/decisions/{decision['id']}/accept", data={}, headers={"origin": ORIGIN, "If-Match": f"\"{decision['version']}\""})
        context.close()
        self.assertEqual(accepted.status, 200, accepted.text)
        jonas = self.page("jonas")
        jonas.goto(f"/projects/{space}")
        line = jonas.locator(".convo-object.is-follow .convo-notice__meta strong")
        expect(line).to_contain_text("Jonas Berg (you)")
        card = jonas.locator(".convo-notice__card > .convo-notice__meta strong").first
        look = "(el) => { const s = getComputedStyle(el); return [s.fontSize, s.fontWeight, s.color]; }"
        self.assertEqual(line.evaluate(look), card.evaluate(look), "the acceptance line and the card's line share their type")

    def test_14_people_are_listed_in_one_order(self) -> None:
        page = self.page("piotr")
        page.goto("/settings/company")
        company = page.locator(".people--page .people__item[data-person]")
        expect(company.first).to_contain_text("Piotr Nowak")
        names = lambda rows: [row.locator("b").first.inner_text().replace(" (you)", "") for row in rows.all()]  # noqa: E731
        listed = names(company)
        page.goto(f"/projects/{self.ids['shift']}/settings")
        space = page.locator(".spset .sset-row[data-person]")
        expect(space.first).to_contain_text("Piotr Nowak")
        in_space = names(space)
        self.assertEqual([name for name in listed if name in in_space], in_space, f"one order: {listed} and {in_space}")


if __name__ == "__main__":
    unittest.main()
