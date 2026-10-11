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
          const face = el.querySelector(':scope > :is(.ui-avatar, .author-face), :scope > .thread__root-meta > :is(.ui-avatar, .author-face)').getBoundingClientRect();
          return {left: bounds.left + parseFloat(style.paddingLeft), right: bounds.right - parseFloat(style.paddingRight),
            bubbleLeft: bubble.left, bubbleRight: bubble.right, faceLeft: face.left, faceRight: face.right,
            overflow: el.scrollWidth > el.clientWidth + 1};
        }""")
        gap = 42 if page.viewport_size["width"] <= 680 else 44
        if mine:
            self.assertAlmostEqual(geometry["faceRight"], geometry["right"], delta=1, msg=str(geometry))
            self.assertAlmostEqual(geometry["bubbleRight"], geometry["right"] - gap, delta=1, msg=str(geometry))
        else:
            self.assertAlmostEqual(geometry["faceLeft"], geometry["left"], delta=1, msg=str(geometry))
            self.assertAlmostEqual(geometry["bubbleLeft"], geometry["left"] + gap, delta=1, msg=str(geometry))
        self.assertFalse(geometry["overflow"], geometry)
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
                thread = page.get_by_role("complementary", name="Replies")
                self.assert_side(page, thread.locator(".thread__root"), who == "ada")
                for key, reply in self.replies.items():
                    row = thread.locator(f"#message-{reply['id']}")
                    self.assert_side(page, row, key == who)
                    # Actions remain keyboard-reachable on either side and do not cover the name.
                    more = row.get_by_role("button", name="Make from this message")
                    more.focus()
                    expect(more).to_be_focused()
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
                    scope = page.get_by_role("complementary", name="Replies") if thread else page.get_by_role("region", name="Messages")
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
