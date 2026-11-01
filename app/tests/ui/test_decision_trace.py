"""Browser tests for the trace a decision leaves in its thread and in the project's conversation (issue #694, F-026 P5).

Runs through scripts/check_ui.sh against the running Compose application; FLUX_UI_BROWSER picks the engine
(chromium by default, webkit for the second pass). Ada manages "Night lamp", Jonas holds a contributor grant and Lee is a
workspace member with no grant. Ada proposes a decision from the composer of a thread (`/decide`), Jonas has the same thread
open and sees the line appear without reloading, accepts it in Details, and Ada sees the state change in her thread. The same
journey runs with two people on computers and with two people on phones. Every step is checked against the API, which also
shows what a person with no access to the project reads: nothing. Screenshots (decision-trace-*.png) go to FLUX_UI_SCREENSHOTS.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "a decision leaves a trace"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.trace+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.trace+{STAMP}@example.test"),
    "lee": ("Lee Park", f"lee.trace+{STAMP}@example.test"),
}
QUESTION_DESKTOP = "Should the lamp wake up when someone waves, or only when they come close?"
QUESTION_PHONE = "Which board do we order for the dark-room test?"
REPLIES = ("A ToF sensor works in the dark.", "The camera failed below 10 lux.", "And it stores no images.")
DECISION_DESKTOP = "Use a ToF distance sensor"
DECISION_PHONE = "Order the second supplier's board"
SOURCELESS = "Keep the lamp base cardboard until the shade is final"


class DecisionTrace(unittest.TestCase):
    """Tests run in name order and share three accounts, one project and two threads."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, os.environ.get("FLUX_UI_BROWSER", "chromium")).launch()
        expect.set_options(timeout=10000)
        contexts: dict[str, BrowserContext] = {}
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            contexts[key] = context

        def post(who: str, path: str, body: dict) -> dict:
            response = contexts[who].request.fetch(path, method="POST", data=body, headers={"origin": ORIGIN})
            assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
            return response.json()

        ws = post("ada", "/api/v1/workspaces", {"name": "Riverside Makers"})
        for key in ("jonas", "lee"):
            post("ada", f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE[key][1], "role": "member"})
        pid = post("ada", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Night lamp", "visibility": "restricted"})["id"]
        post("ada", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": cls.ids["jonas"]}, "role": "contributor"})
        threads = {}
        for key, question in (("desktop", QUESTION_DESKTOP), ("phone", QUESTION_PHONE)):
            root = post("ada", f"/api/v1/projects/{pid}/conversations", {"body": question, "clientMessageId": str(uuid.uuid4())})
            for index, body in enumerate(REPLIES):
                post("jonas" if index % 2 == 0 else "ada", f"/api/v1/conversations/{root['id']}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())})
            threads[key] = root["id"]
        for context in contexts.values():
            context.close()
        cls.ids.update(project=pid, workspace=ws["id"], desktop=threads["desktop"], phone=threads["phone"])

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str, *, phone: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who]}
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
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = 200) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def notices(self, page: Page) -> list[dict]:
        return self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/object-notices?limit=100")["items"]

    @staticmethod
    def thread(page: Page):
        return page.get_by_role("complementary", name="Replies").or_(page.get_by_role("dialog", name="Replies"))

    @staticmethod
    def details(page: Page, phone: bool):
        return page.get_by_role("dialog", name="Details") if phone else page.locator("#details")

    def thread_url(self, key: str) -> str:
        return f"/projects/{self.ids['project']}/conversations/{self.ids[key]}"

    def back_to_thread(self, page: Page, phone: bool) -> None:
        self.details(page, phone).get_by_role("button", name="Thread", exact=True).click()
        expect(self.thread(page)).to_be_visible()

    # ------------------------------------------------------------------------------------- the journey

    def journey(self, key: str, title: str, *, phone: bool) -> None:
        ada, jonas = self.page("ada", phone=phone), self.page("jonas", phone=phone)
        for page in (ada, jonas):
            page.goto(self.thread_url(key))
        a_thread, j_thread = self.thread(ada), self.thread(jonas)
        expect(a_thread.locator(".thread__root")).to_be_visible()
        expect(j_thread.locator(".thread__root")).to_be_visible()
        # Before anything is decided the thread shows its root and replies, and no decision line.
        expect(j_thread.locator(".convo-object")).to_have_count(0)
        self.assertEqual([line for line in self.notices(ada) if line["conversationId"] == self.ids[key]], [], "nothing came of this thread yet")

        # Ada proposes from the thread's composer; the words after /decide become the title and the thread the source.
        composer = a_thread.get_by_label("Reply", exact=True)
        composer.fill(f"/decide {title}")
        a_thread.get_by_role("button", name="Send reply").click()
        panel = self.details(ada, phone)
        expect(panel.get_by_label("Decision")).to_have_value(title)
        expect(panel).to_contain_text(QUESTION_DESKTOP if key == "desktop" else QUESTION_PHONE)
        panel.get_by_label("Why").fill("It works in the dark and keeps no pictures.")
        panel.get_by_role("button", name="Propose decision").click()
        expect(panel.get_by_role("heading", name=title)).to_be_visible()
        lines = self.notices(ada)
        mine = [line for line in lines if line["title"] == title]
        self.assertEqual([(line["kind"], line["status"], line["by"]["id"]) for line in mine], [("decision.proposed", "proposed", self.ids["ada"])])
        self.assertEqual(mine[0]["conversationId"], self.ids[key], "the line belongs to the thread it was proposed in")
        self.assertEqual(mine[0]["sources"][0]["type"], "message")

        # Jonas did nothing: the line is in the thread he has open, with who, what and where it stands.
        proposed = j_thread.locator('.convo-object[data-object-kind="decision.proposed"]', has_text=title)
        expect(proposed).to_have_count(1)
        expect(proposed.locator(".convo-notice__meta")).to_contain_text("Ada Kowalska")
        expect(proposed.locator(".convo-notice__meta")).to_contain_text("proposed a decision")
        expect(proposed.locator(".convo-object__state")).to_have_text("Proposed")
        expect(proposed.get_by_role("button", name=re.compile(rf"^Open decision {re.escape(title)}, proposed$"))).to_be_visible()
        shot(jonas, f"decision-trace-{'phone' if phone else 'desktop'}-thread-proposed")

        # Ada's own thread, after she goes back to it, shows the same line.
        self.back_to_thread(ada, phone)
        expect(a_thread.locator('.convo-object[data-object-kind="decision.proposed"]', has_text=title)).to_have_count(1)
        expect(a_thread.locator(".convo-object .convo-notice__meta").first).to_contain_text("Ada Kowalska · you")

        # Jonas opens the decision from the line and accepts it.
        proposed.get_by_role("button", name=re.compile("^Open decision")).click()
        j_panel = self.details(jonas, phone)
        expect(j_panel.get_by_role("heading", name=title)).to_be_visible()
        j_panel.get_by_role("button", name="Accept", exact=True).click()
        expect(j_panel.locator(".wd-eyebrow")).to_contain_text("Decision · accepted")
        self.back_to_thread(jonas, phone)

        # The card says where it stands now, and Jonas's acceptance is a line of its own right under it: one card, not
        # two identical ones (#763 H11-9).
        decision_id = proposed.get_attribute("data-object-id")
        accepted = j_thread.locator(f'.convo-object[data-object-kind="decision.accepted"][data-object-id="{decision_id}"]')
        expect(accepted).to_have_count(1)
        expect(accepted).to_have_class(re.compile(r"\bis-follow\b"))
        expect(accepted.locator(".convo-notice__meta")).to_contain_text("Jonas Berg · you")
        expect(accepted.locator(".convo-notice__meta")).to_contain_text("accepted it")
        expect(accepted.locator(".convo-object__card")).to_have_count(0)
        expect(j_thread.locator(f'.convo-object[data-object-id="{decision_id}"] .convo-object__state')).to_have_text(["Accepted"])
        shot(jonas, f"decision-trace-{'phone' if phone else 'desktop'}-thread-accepted")

        # Ada, who did nothing since, sees the same change in her thread: the state moved and Jonas's line arrived.
        a_accepted = a_thread.locator(f'.convo-object[data-object-kind="decision.accepted"][data-object-id="{decision_id}"]')
        expect(a_accepted).to_have_count(1)
        expect(a_accepted.locator(".convo-notice__meta")).to_contain_text("Jonas Berg")
        expect(a_accepted.locator(".convo-notice__meta")).not_to_contain_text("you")
        expect(a_thread.locator(f'.convo-object[data-object-id="{decision_id}"] .convo-object__state')).to_have_text(["Accepted"])
        stored = [line for line in self.notices(ada) if line["title"] == title]
        self.assertEqual(sorted((line["kind"], line["status"]) for line in stored), [("decision.accepted", "accepted"), ("decision.proposed", "accepted")])

        # The project's conversation shows both too, between the roots, once the thread is closed.
        a_thread.get_by_role("button", name="Close replies").click()
        expect(self.thread(ada)).to_have_count(0)
        stream = ada.locator(".project-convo__message-list")
        expect(stream.locator(f'.convo-object[data-object-id="{decision_id}"]')).to_have_count(2)
        expect(stream.locator(f'.convo-object[data-object-id="{decision_id}"] .convo-object__card')).to_have_count(1)
        # In the stream the line says where it came from: the thread's opening message, by its author.
        from_root = stream.locator('.convo-object[data-object-kind="decision.proposed"]', has_text=title)
        expect(from_root.locator(".convo-notice__what")).to_contain_text("proposed a decision from")
        # #763 WF-2: Ada reads her own message as "your message".
        expect(from_root.get_by_role("button", name="your message")).to_be_visible()
        shot(ada, f"decision-trace-{'phone' if phone else 'desktop'}-stream")
        # A card opens its decision.
        stream.locator(".convo-object__card", has_text=title).first.click()
        expect(self.details(ada, phone).get_by_role("heading", name=title)).to_be_visible()

    def test_01_on_computers_a_decision_proposed_in_a_thread_shows_there_and_follows_its_state(self) -> None:
        self.journey("desktop", DECISION_DESKTOP, phone=False)

    def test_02_on_phones_the_same_journey_reads_the_same(self) -> None:
        self.journey("phone", DECISION_PHONE, phone=True)

    def test_03_a_thread_shows_only_what_came_of_it_and_a_decision_from_nowhere_shows_in_the_stream(self) -> None:
        ada, jonas = self.page("ada"), self.page("jonas")
        # The phone journey's decision did not leak into the first thread.
        jonas.goto(self.thread_url("desktop"))
        thread = self.thread(jonas)
        expect(thread.locator(".thread__root")).to_be_visible()
        expect(thread.locator(".convo-object", has_text=DECISION_DESKTOP)).to_have_count(1)
        expect(thread.locator(".convo-object.is-follow")).to_have_count(1)
        expect(thread.locator(".convo-object", has_text=DECISION_PHONE)).to_have_count(0)
        # A decision made without a message or thread (from "+") is announced in the stream only, live.
        made = self.api(ada, "POST", f"/api/v1/projects/{self.ids['project']}/decisions", {"title": SOURCELESS}, status=201)
        stream = jonas.locator(".project-convo__message-list")
        line = stream.locator('.convo-object[data-object-kind="decision.proposed"]', has_text=SOURCELESS)
        expect(line).to_have_count(1)
        expect(line.locator(".convo-notice__meta")).to_contain_text("proposed a decision")
        expect(line.locator(".convo-notice__meta")).not_to_contain_text("thread")
        expect(line.locator(".convo-object__state")).to_have_text("Proposed")
        expect(thread.locator(".convo-object", has_text=SOURCELESS)).to_have_count(0)
        self.assertEqual([(l["conversationId"], l["sources"]) for l in self.notices(ada) if l["title"] == SOURCELESS], [(None, [])])
        # A negative result is announced the same way.
        result = self.api(ada, "POST", f"/api/v1/projects/{self.ids['project']}/results", {"title": "The camera fails below 10 lux", "finding": "negative"}, status=201)
        found = stream.locator('.convo-object[data-object-kind="result.recorded"]')
        expect(found).to_have_count(1)
        expect(found.locator(".convo-notice__meta")).to_contain_text("recorded a negative result")
        expect(found.locator(".convo-object__state")).to_have_text("Negative")
        found.get_by_role("button", name=re.compile("^Open result")).click()
        expect(self.details(jonas, False).get_by_role("heading", name=result["title"])).to_be_visible()
        self.assertEqual(made["status"], "proposed")

    def test_04_someone_with_no_access_to_the_project_reads_nothing_of_it(self) -> None:
        lee = self.page("lee")
        denied = lee.request.fetch(f"{ORIGIN}/api/v1/projects/{self.ids['project']}/object-notices", headers={"origin": ORIGIN})
        self.assertEqual(denied.status, 404, "the same answer as for a project that does not exist")
        self.assertNotIn(DECISION_DESKTOP, denied.text())
        lee.goto(f"/projects/{self.ids['project']}")
        expect(lee.get_by_text(DECISION_DESKTOP)).to_have_count(0)
        expect(lee.locator(".convo-object")).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
