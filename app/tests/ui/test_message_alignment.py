"""#481: messages belong to their author's side in the project stream and replies.

Real accounts and persisted messages/references. Only the first send response is held then
failed to exercise the actual outbox; retry reaches the API. Agent identity/geometry is
covered with real agent writes by task-discussion-actors.e2e.ts.
"""

from __future__ import annotations

import re
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright

from author_columns import assert_author_column
from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder

PASSWORD = "messages belong to their authors"
NAMES = {"ada": "Ada Kowalska", "jonas": "Jonas Berg"}


class MessageAlignment(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)
        cls.states, cls.ids, contexts = {}, {}, {}
        stamp = uuid.uuid4().hex[:12]
        for key, name in NAMES.items():
            context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
            response = context.request.post("/api/auth/sign-up/email", data={
                "email": f"alignment-{key}-{stamp}@example.test", "password": PASSWORD, "name": name,
            }, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key], contexts[key] = context.storage_state(), context
        owner = contexts["ada"]
        workspace = cls.post(owner, "/api/v1/workspaces", {"name": "Community garden"})
        cls.post(owner, f"/api/v1/workspaces/{workspace['id']}/members", {
            "email": f"alignment-jonas-{stamp}@example.test", "role": "member",
        })
        project = cls.post(owner, f"/api/v1/workspaces/{workspace['id']}/projects", {
            "name": "Garden sensors", "visibility": "workspace",
        })
        cls.project = project["id"]
        material = cls.post(owner, f"/api/v1/projects/{cls.project}/materials", {
            "title": "Readings from the raised beds", "body": "Bed 4 dries earlier than bed 2.",
            "clientMutationId": str(uuid.uuid4()),
        })
        cls.source = {"materialId": material["materialId"], "version": material["version"]}
        cls.roots, cls.replies = {}, {}
        for key in NAMES:
            cls.roots[key] = cls.post(contexts[key], f"/api/v1/projects/{cls.project}/conversations", {
                "body": "Should the first sensors measure soil moisture?" if key == "ada" else "Start with the raised beds.",
                "clientMessageId": str(uuid.uuid4()), **({"source": cls.source} if key == "ada" else {}),
            })
        for key in ("jonas", "ada"):
            cls.replies[key] = cls.post(contexts[key], f"/api/v1/conversations/{cls.roots['ada']['id']}/messages", {
                "body": "I can compare the probes tomorrow." if key == "jonas" else "I will bring the readings.",
                "clientMessageId": str(uuid.uuid4()),
            })
        cls.post(owner, f"/api/v1/projects/{cls.project}/work", {
            "title": "Compare the two probes", "clientCommandId": str(uuid.uuid4()),
        })
        cls.short = cls.post(owner, f"/api/v1/projects/{cls.project}/conversations", {
            "body": "@Jon", "clientMessageId": str(uuid.uuid4()),
        })
        cls.short_reply = cls.post(owner, f"/api/v1/conversations/{cls.short['id']}/messages", {
            "body": "Jon", "clientMessageId": str(uuid.uuid4()),
        })
        for message in (cls.short["messages"][0], cls.short_reply):
            cls.post(owner, f"/api/v1/projects/{cls.project}/work", {
                "title": "Raised beds by the fence: the volunteers need a readable blocked task card",
                "sources": [{"type": "message", "id": message["id"]}],
                "clientCommandId": str(uuid.uuid4()),
            })
        cls.dm = cls.post(owner, f"/api/v1/workspaces/{workspace['id']}/dms", {"participantIds": [cls.ids["jonas"]]})
        cls.dm_messages = []
        for key, body in (("jonas", "The school can lend us two ESP32 kits from the robotics club."),
                          ("ada", "Great. Let us keep it between us until she confirms."),
                          ("ada", "I will check with the volunteers tomorrow.")):
            cls.dm_messages.append(cls.post(contexts[key], f"/api/v1/dms/{cls.dm['id']}/messages", {
                "body": body, "clientMessageId": str(uuid.uuid4()),
            }))
        group_project = cls.post(owner, f"/api/v1/workspaces/{workspace['id']}/projects", {"name": "Probe planning", "visibility": "workspace"})
        cls.group_project = group_project["id"]
        cls.groups = []
        for key, body in (("ada", "I can bring the probes."), ("ada", "And the spare batteries."),
                          ("jonas", "I will ask the volunteers."), ("jonas", "We can meet by the raised beds.")):
            started = cls.post(contexts[key], f"/api/v1/projects/{cls.group_project}/conversations", {
                "body": body, "clientMessageId": str(uuid.uuid4()),
            })
            cls.groups.append(started["messages"][0])
        cls.group_thread = cls.post(owner, f"/api/v1/projects/{cls.group_project}/conversations", {
            "body": "Could we test the moisture readings together?", "clientMessageId": str(uuid.uuid4()),
        })
        cls.group_replies = []
        for body in ("Saturday morning works.", "I will bring a notebook."):
            cls.group_replies.append(cls.post(owner, f"/api/v1/conversations/{cls.group_thread['id']}/messages", {
                "body": body, "clientMessageId": str(uuid.uuid4()),
            }))
        for context in contexts.values():
            context.close()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    @staticmethod
    def post(context, path, body):
        response = context.request.post(path, data=body, headers={"origin": ORIGIN})
        assert response.status in (200, 201), response.text()
        return response.json()

    def page(self, who="ada", *, phone=False, dark=False):
        context = self.browser.new_context(base_url=ORIGIN, storage_state=self.states[who],
            viewport=PHONE if phone else DESKTOP, is_mobile=phone, has_touch=phone,
            color_scheme="dark" if dark else "light", locale="en-GB", reduced_motion="reduce",
            service_workers="block")
        self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def assert_side(self, page, row, mine):
        """Inspect actual bubble/face edges against the reading column, independent of CSS classes."""
        expect(row).to_be_visible()
        row.scroll_into_view_if_needed()
        assert_author_column(self, row, page.viewport_size["width"], "own" if mine else "other")
        geometry = row.evaluate("""el => {
          const parent = el.parentElement, style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
          const bubble = el.querySelector(':scope > .message-bubble').getBoundingClientRect();
          const face = el.querySelector(':scope > :is(.ui-avatar, .author-face), :scope > .thread__root-meta > :is(.ui-avatar, .author-face)')?.getBoundingClientRect();
          return {left: bounds.left + parseFloat(style.paddingLeft), right: bounds.right - parseFloat(style.paddingRight),
            bubbleLeft: bubble.left, bubbleRight: bubble.right, faceLeft: face?.left, faceRight: face?.right};
        }""")
        gap = 42 if page.viewport_size["width"] <= 680 else 44
        if mine:
            self.assertAlmostEqual(geometry["bubbleRight"], geometry["right"], delta=1, msg=str(geometry))
        else:
            self.assertAlmostEqual(geometry["faceLeft"], geometry["left"], delta=1, msg=str(geometry))
            self.assertAlmostEqual(geometry["bubbleLeft"], geometry["left"] + gap, delta=1, msg=str(geometry))
        self.assertGreaterEqual(geometry["bubbleLeft"], geometry["left"] - 1, geometry)
        self.assertLessEqual(geometry["bubbleRight"], geometry["right"] + 1, geometry)
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.viewport_size["width"])

    def test_01_saved_messages_follow_the_viewer_in_stream_and_thread(self):
        for who, phone, dark in (("ada", False, False), ("ada", True, False), ("ada", False, True),
                                  ("ada", True, True), ("jonas", False, False), ("jonas", True, False)):
            with self.subTest(who=who, phone=phone, dark=dark):
                page = self.page(who, phone=phone, dark=dark)
                page.goto(f"/projects/{self.project}")
                for key, root in self.roots.items():
                    row = page.locator(f"#message-{root['messages'][0]['id']}")
                    self.assert_side(page, row, key == who)
                event = page.locator(".convo-notice").filter(has_text="Compare the two probes")
                assert_author_column(self, event, page.viewport_size["width"], "neutral task notice")
                card = page.locator(f"#message-{self.roots['ada']['messages'][0]['id']} .wiki-card")
                expect(card).to_have_attribute("href", f"/materials/{self.source['materialId']}/versions/1")
                self.assertTrue(card.evaluate("""el => {const r=el.getBoundingClientRect(), b=el.closest('.message-bubble').getBoundingClientRect();
                    return r.left >= b.left && r.right <= b.right;}"""), "the reference stays within its bubble")
                if who == "ada":
                    shot(page, f"message-alignment-stream-{'phone' if phone else 'desktop'}-{'dark' if dark else 'light'}-{UI_BROWSER}")
                root = page.locator(f"#message-{self.roots['ada']['messages'][0]['id']}")
                root.get_by_role("button", name=re.compile(r"^2 replies")).click()
                thread = page.get_by_role("complementary", name="Replies").or_(page.get_by_role("dialog", name="Replies"))
                self.assert_side(page, thread.locator(".thread__root"), who == "ada")
                for key, reply in self.replies.items():
                    row = thread.locator(f"#message-{reply['id']}")
                    self.assert_side(page, row, key == who)
                    # Actions remain keyboard-reachable on either side and do not cover the name.
                    more = row.get_by_role("button", name="Message actions" if phone else "More actions", exact=True)
                    more.focus()
                    expect(more).to_be_focused()
                    if key == who:
                        continue
                    self.assertTrue(row.locator(".project-convo__message-meta strong").evaluate("""el => {
                      const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                      return !!hit && el.contains(hit);
                    }"""), "the author remains readable beside the action control")
                if who == "ada":
                    shot(page, f"message-alignment-thread-{'phone' if phone else 'desktop'}-{'dark' if dark else 'light'}-{UI_BROWSER}")
                thread.get_by_role("button", name="Close replies").click()
                expect(root.get_by_role("button", name=re.compile(r"^2 replies"))).to_be_focused()
                if who == "ada" and not phone and not dark:
                    card.click()
                    expect(page).to_have_url(re.compile(f"/materials/{self.source['materialId']}/versions/1$"))
                page.context.close()

    def test_02_queued_failed_and_retried_messages_stay_on_the_right(self):
        for phone in (False, True):
            for thread in (False, True):
                with self.subTest(phone=phone, thread=thread):
                    page = self.page(phone=phone)
                    suffix = f"/conversations/{self.roots['ada']['id']}" if thread else ""
                    page.goto(f"/projects/{self.project}{suffix}")
                    scope = page.get_by_role("complementary", name="Replies").or_(page.get_by_role("dialog", name="Replies")) if thread else page.get_by_role("region", name="Messages")
                    field = page.locator("#thread-composer" if thread else "#project-composer")
                    body = f"The probe is ready for tomorrow {uuid.uuid4().hex[:6]}."
                    path = f"/api/v1/conversations/{self.roots['ada']['id']}/messages" if thread else f"/api/v1/projects/{self.project}/conversations"
                    held = []

                    def hold(route):
                        if route.request.method == "POST":
                            held.append(route)
                        else:
                            route.continue_()

                    page.route(f"**{path}", hold)
                    field.fill(body)
                    page.get_by_role("button", name="Send reply" if thread else "Send message", exact=True).click()
                    queued = scope.locator("[data-client-message-id]").filter(has_text=body)
                    expect(queued).to_have_attribute("data-send-state", "sending")
                    self.assert_side(page, queued, True)
                    self.assertEqual(len(held), 1, "the real send is held at the HTTP boundary")
                    held[0].fulfill(status=503, content_type="application/json", body='{"error":{"code":"TEST_SEND_FAILED","message":"Probe message was not saved."}}')
                    expect(queued).to_have_attribute("data-send-state", "failed")
                    self.assert_side(page, queued, True)
                    shot(page, f"message-alignment-failed-{'thread' if thread else 'stream'}-{'phone' if phone else 'desktop'}-{UI_BROWSER}")
                    page.unroute(f"**{path}", hold)
                    with page.expect_response(lambda response: response.request.method == "POST" and response.url.endswith(path)) as saved:
                        queued.get_by_role("button", name="Retry", exact=True).click()
                    self.assertEqual(saved.value.status, 201, saved.value.text())
                    result = saved.value.json()
                    message = result if thread else result["messages"][0]
                    stored = scope.locator(f"#message-{message['id']}")
                    self.assert_side(page, stored, True)
                    expect(queued).to_have_count(0)
                    page.reload()
                    self.assert_side(page, scope.locator(f"#message-{message['id']}"), True)
                    page.context.close()


    def test_03_one_word_reference_keeps_a_readable_width(self):
        for width in (320, 375, 390):
            for dark in (False, True):
                with self.subTest(width=width, dark=dark):
                    page = self.page(phone=True, dark=dark)
                    page.set_viewport_size({"width": width, "height": 844})
                    page.goto(f"/projects/{self.project}")
                    root = page.locator(f"#message-{self.short['messages'][0]['id']}")
                    self.assert_reference_width(page, root)
                    root.get_by_role("button", name=re.compile(r"^1 reply")).click()
                    thread = page.get_by_role("complementary", name="Replies").or_(page.get_by_role("dialog", name="Replies"))
                    self.assert_reference_width(page, thread.locator(".thread__root"))
                    self.assert_reference_width(page, thread.locator(f"#message-{self.short_reply['id']}"))
                    shot(page, f"spokoj-one-word-{width}-{'dark' if dark else 'light'}-{UI_BROWSER}")
                    page.context.close()

    def test_04_shared_bubble_and_grouping_matrix(self):
        for width, height in ((390, 844), (820, 1180), (1440, 900), (2560, 1440)):
            for dark in (False, True):
                with self.subTest(width=width, dark=dark):
                    page = self.page(phone=width == 390, dark=dark)
                    page.set_viewport_size({"width": width, "height": height})
                    for surface, path, selector in (
                        ("project", f"/projects/{self.project}", f"#message-{self.short['messages'][0]['id']}"),
                        ("thread", f"/projects/{self.project}/conversations/{self.short['id']}", f"#thread #message-{self.short_reply['id']}"),
                        ("dm", f"/dm/{self.dm['id']}", f"#message-{self.dm_messages[-1]['id']} .dm-msg__main"),
                    ):
                        page.goto(path)
                        row = page.locator(selector)
                        bubble = row.locator(":scope > .message-bubble")
                        expect(bubble).to_be_visible()
                        style = bubble.evaluate("""el => {
                          const s=getComputedStyle(el), probe=document.createElement('i');
                          probe.style.background='var(--own)'; probe.style.color='var(--t1)'; document.body.append(probe);
                          const p=getComputedStyle(probe), result={background:s.backgroundColor,color:s.color,own:p.backgroundColor,ink:p.color,image:s.backgroundImage};
                          probe.remove(); return result;
                        }""")
                        self.assertEqual(style["background"], style["own"], style)
                        self.assertEqual(style["color"], style["ink"], style)
                        self.assertEqual(style["image"], "none", style)
                        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), width)
                        shot(page, f"spokoj-{surface}-{width}-{'dark' if dark else 'light'}-{UI_BROWSER}")
                    first = page.locator(f"#message-{self.dm_messages[-2]['id']}")
                    last = page.locator(f"#message-{self.dm_messages[-1]['id']}")
                    expect(first.locator(".message-time")).to_have_count(0)
                    expect(last.locator(".message-time")).to_have_count(1)
                    expect(page.locator(".dm-msg.is-mine .dm-msg__meta, .dm-msg.is-mine .ui-avatar")).to_have_count(0)
                    a, b = first.locator(".message-bubble").bounding_box(), last.locator(".message-bubble").bounding_box()
                    self.assertAlmostEqual(b["y"] - a["y"] - a["height"], 4, delta=1)
                    self.assertNotRegex(last.locator("time").inner_text(), r"^0\d:")
                    expect(page.get_by_text("Unsent text stays in this tab", exact=False)).to_be_hidden()
                    page.context.close()

    def test_05_project_and_thread_author_runs_have_four_pixel_bubble_gaps(self):
        for phone in (False, True):
            page = self.page(phone=phone)
            page.goto(f"/projects/{self.group_project}")
            for first, last in (self.groups[:2], self.groups[2:]):
                self.assert_run(page, page.locator(f"#message-{first['id']}"), page.locator(f"#message-{last['id']}"))
            page.goto(f"/projects/{self.group_project}/conversations/{self.group_thread['id']}")
            self.assert_run(page, page.locator(f"#message-{self.group_replies[0]['id']}"), page.locator(f"#message-{self.group_replies[1]['id']}"))
            page.context.close()

    def assert_run(self, page, first, last):
        first.scroll_into_view_if_needed()
        expect(first.locator(".message-time")).to_have_count(0)
        expect(last.locator(".message-time")).to_have_count(1)
        expect(last.locator(":scope > .author-face, :scope > .project-convo__message-meta")).to_have_count(0)
        a, b = first.locator(".message-bubble").bounding_box(), last.locator(".message-bubble").bounding_box()
        self.assertAlmostEqual(b["y"] - a["y"] - a["height"], 4, delta=1)
        if not page.evaluate("matchMedia('(hover: none)').matches"):
            last.hover()
            toolbar = last.locator(".msg-acts").bounding_box()
            self.assertTrue(toolbar["x"] + toolbar["width"] <= b["x"] or b["x"] + b["width"] <= toolbar["x"], "hover controls stay beside the bubble")

    def assert_reference_width(self, page, row):
        card = row.locator(".message-bubble .ws-chip").first
        expect(card).to_be_visible()
        row.scroll_into_view_if_needed()
        measured = card.evaluate("""card => {
          const bubble = card.closest('.message-bubble'), b = bubble.getBoundingClientRect(), c = card.getBoundingClientRect();
          const style = getComputedStyle(bubble), title = card.querySelector('.ws-chip__t'), state = card.querySelector('.ws-chip__k');
          return {bubble:b.width, card:c.width, available:bubble.parentElement.clientWidth,
            padding:parseFloat(style.paddingLeft)+parseFloat(style.paddingRight),
            titleLines:getComputedStyle(title).whiteSpace, ellipsis:getComputedStyle(title).textOverflow,
            stateWidth:state.getBoundingClientRect().width, right:b.right, left:b.left};
        }""")
        self.assertGreaterEqual(measured["bubble"], min(300, measured["available"]) - 1, measured)
        self.assertAlmostEqual(measured["card"], measured["bubble"] - measured["padding"], delta=1, msg=str(measured))
        self.assertEqual(measured["titleLines"], "nowrap")
        self.assertEqual(measured["ellipsis"], "ellipsis")
        self.assertGreater(measured["stateWidth"], 12)
        self.assertGreaterEqual(measured["left"], 0)
        self.assertLessEqual(measured["right"], page.viewport_size["width"])
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.viewport_size["width"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
