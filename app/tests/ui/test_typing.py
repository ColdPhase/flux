"""Real two-account typing journeys, not a simulated presence implementation.

Public API fixtures, actual cookie-authenticated sockets, Chromium or WebKit DOM
(FLUX_UI_BROWSER, default chromium) and native messages. A receiver transport test drops only real server frames. It never
fabricates identity, availability or people. Timing observations are individual
regressions, not the contract's outstanding 128-socket performance acceptance.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import time
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright
from test_app_shell import ORIGIN, UPSTREAM, UI_BROWSER, shot as save_shot, start_forwarder


def shot(page, name):
    """Screenshots of the other engine are named apart (FLUX_UI_BROWSER, #461)."""
    save_shot(page, name if UI_BROWSER == "chromium" else f"{name}-{UI_BROWSER}")


PASSWORD = "quiet activity in a real conversation"
STAMP = uuid.uuid4().hex[:12]
PEOPLE = {"alice": "Alice Rivera", "bob": "Bob Nowak", "viewer": "Nia Okafor", "outsider": "Lee Park"}


class TypingJourney(unittest.TestCase):
    states = {}
    ids = {}
    observations = []

    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)
        for key, name in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": f"typing-{key}-{STAMP}@example.test", "name": name, "password": PASSWORD}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            context.close()
        owner = cls.browser.new_context(base_url=ORIGIN, storage_state=cls.states["alice"])

        def post(path, body, status=201):
            response = owner.request.post(path, data=body, headers={"origin": ORIGIN})
            assert response.status == status, response.text()
            return response.json()

        cls.workspace = post("/api/v1/workspaces", {"name": "Riverside library"})["id"]
        for key in ("bob", "viewer", "outsider"):
            post(f"/api/v1/workspaces/{cls.workspace}/members", {"email": f"typing-{key}-{STAMP}@example.test", "role": "member"})
        cls.project = post(f"/api/v1/workspaces/{cls.workspace}/projects", {"name": "Reading corner lamp", "visibility": "restricted"})["id"]
        for key, role in (("bob", "contributor"), ("viewer", "viewer")):
            post(f"/api/v1/projects/{cls.project}/grants", {"principal": {"kind": "human", "id": cls.ids[key]}, "role": role})
        cls.material = post(f"/api/v1/projects/{cls.project}/materials", {"title": "Low-light observations", "body": "20 gestures per light level; a distance sensor preserves privacy.", "clientMutationId": str(uuid.uuid4())})
        cls.conversations = []
        for title in ("How should the lamp behave in low light?", "Where should the manual switch go?"):
            conversation = post(f"/api/v1/projects/{cls.project}/conversations", {"body": title, "clientMessageId": str(uuid.uuid4())})
            cls.conversations.append(conversation["id"])
        for index in range(99):
            post(f"/api/v1/conversations/{cls.conversations[0]}/messages", {"body": f"Observation {index + 1}: the reading corner stays quiet. Test the distance sensor at this light level before choosing a threshold.", "clientMessageId": str(uuid.uuid4()), **({"source": {"materialId": cls.material["materialId"], "version": cls.material["version"]}} if index == 98 else {})})
        cls.dm = post(f"/api/v1/workspaces/{cls.workspace}/dms", {"participantIds": [cls.ids["bob"]]})["id"]
        post(f"/api/v1/dms/{cls.dm}/messages", {"body": "Let's keep the first lamp test between us until it works in low light.", "clientMessageId": str(uuid.uuid4())})
        owner.close()

    @classmethod
    def tearDownClass(cls):
        destination = os.environ.get("FLUX_UI_SCREENSHOTS")
        if destination:
            Path(destination, "typing-observations.json").write_text(json.dumps({"browser": cls.browser.version, "origin": ORIGIN, "observations": cls.observations}, indent=2) + "\n")
        cls.browser.close()
        cls.pw.stop()

    def page(self, who, *, viewport=None, video=False, transport=None):
        options = {"base_url": ORIGIN, "storage_state": self.states[who], "viewport": viewport or {"width": 1280, "height": 800}, "device_scale_factor": 1, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "reduced_motion": "reduce"}
        if video and os.environ.get("FLUX_UI_SCREENSHOTS"):
            options["record_video_dir"] = os.environ["FLUX_UI_SCREENSHOTS"]
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        if transport:
            context.route_web_socket("**/api/v1/typing", transport)
        page = context.new_page()
        sent, received, errors = [], [], []

        def socket_opened(socket):
            if socket.url.endswith("/api/v1/typing"):
                socket.on("framesent", lambda value: sent.append(json.loads(value)))
                socket.on("framereceived", lambda value: received.append(json.loads(value)))

        page.on("websocket", socket_opened)
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        page.typing_sent = sent
        page.typing_received = received
        return page

    def path(self, index=0):
        return f"/projects/{self.project}/conversations/{self.conversations[index]}"

    def open(self, who, *, dm=False, **options):
        page = self.page(who, **options)
        page.goto(f"/dm/{self.dm}" if dm else self.path())
        expect(page.locator(".typing-notice")).to_have_attribute("data-availability", "ready")
        return page

    def composer(self, page, *, dm=False):
        # A conversation URL opens the project's stream with that conversation's thread beside it (#195,
        # UI116-1); typing belongs to the thread's reply composer, not the stream's new-message composer.
        return page.locator("#dm-composer" if dm else "#thread-composer")

    def thread(self, page):
        return page.locator("#thread")

    def open_thread(self, page, index):
        """Opens another conversation's thread from its root in the stream (its reply count, or Reply)."""
        root = page.locator(f'li[data-conversation-id="{self.conversations[index]}"]')
        replies = root.locator(".convo-replies__open")
        root.hover()
        (replies if replies.count() else root.get_by_role("button", name="Reply in thread", exact=True)).click()

    def measure(self, name, action, assertion, maximum):
        start = time.monotonic()
        action()
        assertion()
        elapsed = (time.monotonic() - start) * 1000
        self.observations.append({"case": name, "milliseconds": round(elapsed, 3), "maximum": maximum})
        self.assertLessEqual(elapsed, maximum, name)

    def grant(self, owner, who, role):
        response = owner.request.post(f"/api/v1/projects/{self.project}/grants", data={"principal": {"kind": "human", "id": self.ids[who]}, "role": role}, headers={"origin": ORIGIN})
        self.assertEqual(response.status, 201, response.text())

    def assert_wire(self, page, who):
        self.assertTrue(page.typing_received, "actual server frames observed")
        self.assertEqual(page.typing_received[0], {"type": "identity", "id": self.ids[who]})
        for frame in page.typing_sent:
            self.assertIn(frame["type"], ("watch", "active"))
            self.assertEqual(set(frame), {"type", "context"} if frame["type"] == "watch" else {"type", "active"})
        for frame in page.typing_received:
            self.assertEqual(set(frame), {"type", "id"} if frame["type"] == "identity" else {"type", "context", "availability", "people"})
        self.assertNotIn("PRIVATE-DRAFT", json.dumps(page.typing_sent + page.typing_received))

    def test_01_project_input_blur_expiry_and_unchanged_renewal(self):
        alice = self.open("alice", video=True)
        bob = self.open("bob")
        # The receiver keeps its draft, selected source, keyboard focus and scroll.
        # "/source" opens the saved sources (F-026 S5: no Sources button in the composer).
        self.composer(bob).fill("/source")
        self.composer(bob).press("Enter")
        self.thread(bob).get_by_role("button", name="Discuss this version").click()
        expect(self.thread(bob).locator(".composer-files__ref")).to_contain_text("Low-light observations")
        self.composer(bob).fill("PRIVATE-DRAFT receiver notes")
        self.composer(bob).focus()
        bob.locator(".thread__feed").evaluate("el => { el.scrollTop = 120; }")
        before = bob.locator(".thread__feed").evaluate("el => ({top:el.scrollTop,height:el.clientHeight,count:el.querySelectorAll('.project-convo__message').length})")
        original = alice.request.get(f"/api/v1/conversations/{self.conversations[0]}").json()
        notice = bob.locator(".typing-notice")
        self.measure("project-input-visible", lambda: self.composer(alice).fill("PRIVATE-DRAFT author notes"), lambda: expect(notice).to_have_text("Alice Rivera is typing…", timeout=2000), 2000)
        expect(alice.locator(".typing-notice")).not_to_contain_text("Alice Rivera")
        expect(self.composer(bob)).to_be_focused()
        expect(self.composer(bob)).to_have_value("PRIVATE-DRAFT receiver notes")
        expect(self.thread(bob).locator(".composer-files__ref")).to_contain_text("Low-light observations")
        after = bob.locator(".thread__feed").evaluate("el => ({top:el.scrollTop,height:el.clientHeight,count:el.querySelectorAll('.project-convo__message').length})")
        self.assertEqual(before, after)
        bob.evaluate("""() => { window.typingChanges = 0; window.typingObserver = new MutationObserver(() => window.typingChanges++); window.typingObserver.observe(document.querySelector('.typing-notice'), {childList:true,characterData:true,subtree:true}); }""")
        bob.wait_for_timeout(2100)
        self.assertEqual(bob.evaluate("window.typingChanges"), 0, "unchanged heartbeat does not repeat live-region text")
        shot(bob, "typing-project-1280-active-source-draft")
        self.measure("project-blur-stop", lambda: self.composer(alice).blur(), lambda: expect(notice).not_to_contain_text("Alice Rivera", timeout=750), 750)
        self.composer(alice).fill("PRIVATE-DRAFT idle author")
        expect(notice).to_contain_text("Alice Rivera", timeout=2000)
        self.measure("project-idle-expiry", lambda: None, lambda: expect(notice).not_to_contain_text("Alice Rivera", timeout=6000), 6000)
        final = alice.request.get(f"/api/v1/conversations/{self.conversations[0]}").json()
        self.assertEqual(original["messages"], final["messages"], "typing creates no native history")
        self.assert_wire(alice, "alice")
        self.assert_wire(bob, "bob")

    def test_02_scope_navigation_restores_draft_without_activity_and_send_stops(self):
        alice = self.open("alice")
        bob = self.open("bob")
        self.composer(alice).fill("PRIVATE-DRAFT preserved between conversations")
        expect(bob.locator(".typing-notice")).to_contain_text("Alice Rivera", timeout=2000)
        self.measure("navigation-stop", lambda: self.open_thread(alice, 1), lambda: expect(bob.locator(".typing-notice")).not_to_contain_text("Alice Rivera", timeout=750), 750)
        expect(alice).to_have_url(f"{ORIGIN}{self.path(1)}")
        self.open_thread(alice, 0)
        expect(self.composer(alice)).to_have_value("PRIVATE-DRAFT preserved between conversations")
        alice.wait_for_timeout(1800)
        expect(bob.locator(".typing-notice")).not_to_contain_text("Alice Rivera")
        self.composer(alice).fill("A manual switch still works when the sensor is unavailable.")
        expect(bob.locator(".typing-notice")).to_contain_text("Alice Rivera", timeout=2000)
        self.measure("native-send-stop", lambda: self.composer(alice).press("Enter"), lambda: expect(bob.locator(".typing-notice")).not_to_contain_text("Alice Rivera", timeout=750), 750)
        expect(self.thread(alice).locator(".project-convo__message", has_text="A manual switch still works when the sensor is unavailable.")).to_have_count(1)
        # Sending is instant (#264): the reply shows at once and is stored a moment later.
        expect(self.thread(alice).locator("[data-client-message-id]")).to_have_count(0)
        native = alice.request.get(f"/api/v1/conversations/{self.conversations[0]}").json()
        self.assertEqual(sum(message["body"] == "A manual switch still works when the sensor is unavailable." for message in native["messages"]), 1)
        # The reader's open thread reads the reply from the live event stream (#733), not the 15-second fallback.
        expect(self.thread(bob).locator(".project-convo__message", has_text="A manual switch still works when the sensor is unavailable.")).to_have_count(1, timeout=2000)
        expect(self.composer(alice)).to_have_value("")

    def test_03_dm_is_exact_scope_and_send_is_durable_once(self):
        alice = self.open("alice", dm=True)
        bob = self.open("bob", dm=True)
        unrelated = self.open("viewer")
        self.measure("dm-input-visible", lambda: self.composer(alice, dm=True).fill("We can test the lamp tonight."), lambda: expect(bob.locator(".typing-notice")).to_have_text("Alice Rivera is typing…", timeout=2000), 2000)
        expect(unrelated.locator(".typing-notice")).not_to_contain_text("Alice Rivera")
        shot(bob, "typing-dm-1280-active")
        self.measure("dm-send-stop", lambda: self.composer(alice, dm=True).press("Enter"), lambda: expect(bob.locator(".typing-notice")).not_to_contain_text("Alice Rivera", timeout=750), 750)
        expect(bob.locator(".dm-msg__body", has_text="We can test the lamp tonight.")).to_have_count(1)
        self.assert_wire(alice, "alice")

    def test_04_reader_observes_and_current_access_revocation_clears(self):
        alice = self.open("alice")
        viewer = self.open("viewer")
        expect(self.composer(viewer)).to_have_count(0)
        expect(self.thread(viewer).locator(".project-convo__read-only")).to_be_visible()
        self.composer(alice).fill("PRIVATE-DRAFT current reader test")
        expect(viewer.locator(".typing-notice")).to_contain_text("Alice Rivera", timeout=2000)
        self.assertFalse(any(frame.get("type") == "active" for frame in viewer.typing_sent))
        try:
            self.measure("reader-revocation-request-to-dom", lambda: self.grant(alice, "viewer", "denied"), lambda: expect(viewer.get_by_text("Alice Rivera is typing…", exact=True)).to_have_count(0, timeout=2000), 2000)
        finally:
            self.grant(alice, "viewer", "viewer")

    def test_05_receiver_loses_application_frames_and_expires(self):
        state = {"drop": False, "dropped": 0}

        def transport(socket):
            server = socket.connect_to_server()

            def received(payload):
                if state["drop"]:
                    state["dropped"] += 1
                else:
                    socket.send(payload)

            server.on_message(received)

        alice = self.open("alice")
        bob = self.open("bob", transport=transport)
        self.composer(alice).fill("PRIVATE-DRAFT receiver stall")
        expect(bob.locator(".typing-notice")).to_contain_text("Alice Rivera", timeout=2000)
        state["drop"] = True
        self.measure("receiver-frame-stall", lambda: None, lambda: expect(bob.locator(".typing-notice")).to_have_text("Typing activity unavailable", timeout=6000), 6000)
        self.assertGreater(state["dropped"], 0, "only actual server frames were withheld")
        expect(bob.locator(".typing-notice")).not_to_contain_text("Alice Rivera")
        state["drop"] = False
        expect(bob.locator(".typing-notice")).to_have_attribute("data-availability", "ready", timeout=10000)
        self.composer(alice).blur()
        expect(bob.locator(".typing-notice")).not_to_contain_text("Alice Rivera", timeout=750)

    def test_06_viewport_matrix_static_notice_keeps_layout_and_focus(self):
        alice = self.open("alice")
        for width in (320, 390, 820, 1280):
            with self.subTest(width=width):
                bob = self.open("bob", viewport={"width": width, "height": 844})
                input_box = self.composer(bob)
                input_box.focus()
                before = input_box.bounding_box()
                self.composer(alice).fill(f"PRIVATE-DRAFT viewport {width}")
                expect(bob.locator(".typing-notice")).to_have_text("Alice Rivera is typing…", timeout=2000)
                self.assertEqual(before, input_box.bounding_box())
                expect(input_box).to_be_focused()
                self.assertLessEqual(bob.locator("body").evaluate("el => el.scrollWidth"), width)
                self.assertEqual(bob.locator(".typing-notice").evaluate("el => getComputedStyle(el).animationName"), "none")
                self.assertEqual(bob.locator(".typing-notice").get_attribute("aria-live"), "polite")
                shot(bob, f"typing-project-{width}-static")
                self.composer(alice).blur()
                expect(bob.locator(".typing-notice")).not_to_contain_text("Alice Rivera", timeout=750)
                bob.context.close()

    def test_07_reconnect_acknowledges_cookie_account_before_any_new_pulse(self):
        for dm in (False, True):
            with self.subTest(dm=dm):
                state = {"connections": 0, "servers": [], "pages": [], "identities": [], "owners": {}, "commands": []}

                def transport(socket):
                    server = socket.connect_to_server()
                    state["connections"] += 1
                    connection = state["connections"]
                    state["servers"].append(server)
                    state["pages"].append(socket)

                    def received(payload):
                        frame = json.loads(payload)
                        if frame["type"] == "identity":
                            state["identities"].append(frame["id"])
                            state["owners"][connection] = frame["id"]
                        socket.send(payload)

                    def sent(payload):
                        state["commands"].append((connection, json.loads(payload)))
                        server.send(payload)

                    socket.on_message(sent)
                    server.on_message(received)

                alice = self.open("alice", dm=dm, transport=transport)
                self.composer(alice, dm=dm).fill("PRIVATE-DRAFT belonging only to Alice")
                # Actual shared-cookie switch and real reconnect, without fabricated ACKs.
                alice.context.add_cookies(self.states["bob"]["cookies"])
                # Close the browser half of the relay explicitly; closing only
                # the intercepted upstream does not certify browser disconnection.
                state["pages"][0].close(code=1001, reason="transport interruption")
                state["servers"][0].close(code=1001, reason="transport interruption")
                expect(self.composer(alice, dm=dm)).to_have_value("", timeout=20000)
                expect(alice.locator(".typing-notice")).to_have_attribute("data-availability", "ready", timeout=15000)
                self.assertIn(self.ids["bob"], state["identities"])
                self.assertGreaterEqual(state["connections"], 2)
                self.assertFalse(any(state["owners"].get(connection) == self.ids["bob"] and frame.get("type") == "active" for connection, frame in state["commands"]), "account reconciliation never publishes the previous account's draft")
                self.composer(alice, dm=dm).fill("PRIVATE-DRAFT belonging only to Bob")
                alice.context.add_cookies(self.states["alice"]["cookies"])
                alice.reload()
                expect(self.composer(alice, dm=dm)).to_have_value("PRIVATE-DRAFT belonging only to Alice")
                alice.context.close()

    def test_08_failed_stop_retires_generation_before_late_real_frames(self):
        state = {"connections": 0, "failed": False, "late": 0}

        def transport(socket):
            server = socket.connect_to_server()
            state["connections"] += 1
            first = state["connections"] == 1

            def received(payload):
                if first:
                    if state["failed"]:
                        state["late"] += 1
                    socket.send(payload)
                # New transports have their real ACK withheld in this fault fixture.

            server.on_message(received)

        alice = self.open("alice", transport=transport)
        bob = self.open("bob")
        self.composer(alice).fill("PRIVATE-DRAFT first active author")
        expect(bob.locator(".typing-notice")).to_contain_text("Alice Rivera", timeout=2000)
        self.composer(bob).fill("PRIVATE-DRAFT incoming person")
        expect(alice.locator(".typing-notice")).to_contain_text("Bob Nowak", timeout=2000)
        # Fault injection at the real browser send boundary. Keep the old native
        # socket open briefly so genuine checked frames arrive after send throws.
        alice.evaluate("""() => {
          const send = WebSocket.prototype.send, close = WebSocket.prototype.close;
          let fail = true, hold = true;
          WebSocket.prototype.send = function(value) {
            if (fail && this.url.endsWith('/api/v1/typing') && value === JSON.stringify({type:'active',active:false})) { fail = false; throw new Error('controlled send failure'); }
            return send.call(this, value);
          };
          WebSocket.prototype.close = function(...args) {
            if (hold && this.url.endsWith('/api/v1/typing')) { hold = false; setTimeout(() => close.apply(this, args), 2000); return; }
            return close.apply(this, args);
          };
        }""")
        state["failed"] = True
        self.composer(alice).blur()
        expect(alice.locator(".typing-notice")).to_have_text("Typing activity unavailable", timeout=750)
        alice.wait_for_timeout(1200)
        self.assertGreater(state["late"], 0, "late frames are actual server output")
        expect(alice.locator(".typing-notice")).to_have_text("Typing activity unavailable")

    def test_09_private_assistant_composer_never_publishes_human_typing(self):
        alice = self.open("alice")
        bob = self.open("bob")
        self.composer(alice).fill("PRIVATE-DRAFT ordinary reply before asking")
        expect(bob.locator(".typing-notice")).to_contain_text("Alice Rivera", timeout=2000)
        self.composer(alice).fill("/ai ")
        expect(bob.locator(".typing-notice")).not_to_contain_text("Alice Rivera", timeout=750)
        pulses = sum(frame.get("active") is True for frame in alice.typing_sent)
        alice.get_by_label("Ask your assistant", exact=True).fill("PRIVATE-DRAFT private assistant instructions")
        alice.wait_for_timeout(1800)
        self.assertEqual(sum(frame.get("active") is True for frame in alice.typing_sent), pulses)
        expect(bob.locator(".typing-notice")).not_to_contain_text("Alice Rivera")
        self.composer(alice).press("Escape")
        # Since #195 the private prompt keeps its own draft: leaving ask mode restores the public reply draft.
        expect(alice.get_by_label("Reply", exact=True)).to_have_value("PRIVATE-DRAFT ordinary reply before asking")
        alice.wait_for_timeout(1800)
        self.assertEqual(sum(frame.get("active") is True for frame in alice.typing_sent), pulses, "leaving ask mode does not advertise its restored text")
        self.composer(alice).fill("/ai PRIVATE-DRAFT command-mode prompt")
        expect(alice.get_by_label("Ask your assistant", exact=True)).to_have_value("PRIVATE-DRAFT command-mode prompt")
        alice.wait_for_timeout(1800)
        self.assertEqual(sum(frame.get("active") is True for frame in alice.typing_sent), pulses)
        self.assert_wire(alice, "alice")

    def test_10_task_views_share_one_presence_without_durable_effects(self):
        """AC-2: the Agents task thread and the task's thread in Conversation are one typing scope (the
        accepted discussion root): a person writing in both views is shown once, and nothing is stored."""
        owner = self.page("alice")
        work = owner.request.post(f"/api/v1/projects/{self.project}/work", data={"title": "Measure the lamp at 5 lux", "clientCommandId": str(uuid.uuid4())}, headers={"origin": ORIGIN})
        self.assertEqual(work.status, 201, work.text())
        work = work.json()
        root = owner.request.post(f"/api/v1/work/{work['id']}/discussion", data={"body": "Start with the reading corner at dusk.", "clientMessageId": str(uuid.uuid4()), "kind": "text"}, headers={"origin": ORIGIN})
        self.assertEqual(root.status, 201, root.text())
        conversation = root.json()["conversationId"]
        before = owner.request.get(f"/api/v1/work/{work['id']}/discussion").json()
        owner.context.close()

        def agents(who):
            page = self.page(who)
            page.goto(f"/projects/{self.project}/agents?task={work['id']}")
            expect(page.locator(".agents-thread .typing-notice")).to_have_attribute("data-availability", "ready")
            return page

        def thread(who):
            page = self.page(who)
            page.goto(f"/projects/{self.project}/conversations/{conversation}")
            expect(page.locator("#thread .typing-notice")).to_have_attribute("data-availability", "ready")
            return page

        alice_agents, alice_thread = agents("alice"), thread("alice")
        bob_thread, bob_agents = thread("bob"), agents("bob")
        self.measure("task-agents-input-visible", lambda: alice_agents.locator("#agents-draft").fill("PRIVATE-DRAFT from the Agents view"),
                     lambda: expect(bob_thread.locator("#thread .typing-notice")).to_have_text("Alice Rivera is typing…", timeout=2000), 2000)
        expect(bob_agents.locator(".agents-thread .typing-notice")).to_have_text("Alice Rivera is typing…", timeout=2000)
        # The same person writing in both views at once is one person typing, in both of Bob's views.
        self.composer(alice_thread).fill("PRIVATE-DRAFT from the Conversation thread")
        alice_thread.wait_for_timeout(600)
        expect(bob_thread.locator("#thread .typing-notice")).to_have_text("Alice Rivera is typing…")
        expect(bob_agents.locator(".agents-thread .typing-notice")).to_have_text("Alice Rivera is typing…")
        # Her own views never show her as typing; Bob writing in the thread reaches her Agents view.
        expect(alice_agents.locator(".agents-thread .typing-notice")).not_to_contain_text("Alice Rivera")
        self.composer(bob_thread).fill("PRIVATE-DRAFT Bob in the thread")
        expect(alice_agents.locator(".agents-thread .typing-notice")).to_have_text("Bob Nowak is typing…", timeout=2000)
        self.composer(bob_thread).blur()
        expect(alice_agents.locator(".agents-thread .typing-notice")).not_to_contain_text("Bob Nowak", timeout=750)
        alice_agents.locator("#agents-draft").blur(); self.composer(alice_thread).blur()
        self.measure("task-views-blur-stop", lambda: None, lambda: expect(bob_thread.locator("#thread .typing-notice")).not_to_contain_text("Alice Rivera", timeout=750), 750)
        expect(bob_agents.locator(".agents-thread .typing-notice")).not_to_contain_text("Alice Rivera", timeout=750)
        verifier = self.page("alice")
        after = verifier.request.get(f"/api/v1/work/{work['id']}/discussion").json()
        self.assertEqual(before["messages"], after["messages"], "typing in task views stores no discussion message")
        for page, who in ((alice_agents, "alice"), (alice_thread, "alice"), (bob_thread, "bob"), (bob_agents, "bob")):
            self.assert_wire(page, who)

    def test_11_virtual_keyboard_height_keeps_notice_static_focus_and_draft(self):
        """AC-5: a phone keyboard shortens the visual viewport; the typing line stays static and the
        receiver's focus, caret and draft stay where they were."""
        alice = self.open("alice")
        bob = self.open("bob", viewport={"width": 390, "height": 844})
        box = self.composer(bob)
        box.fill("PRIVATE-DRAFT receiver on a phone")
        box.evaluate("el => { el.focus(); el.setSelectionRange(8, 13); }")
        # The on-screen keyboard: the layout viewport keeps its width and loses ~45% of its height.
        bob.set_viewport_size({"width": 390, "height": 460})
        self.composer(alice).fill("PRIVATE-DRAFT author while the keyboard is open")
        expect(bob.locator(".typing-notice")).to_have_text("Alice Rivera is typing…", timeout=2000)
        self.assertEqual(box.evaluate("el => [document.activeElement === el, el.selectionStart, el.selectionEnd, el.value]"), [True, 8, 13, "PRIVATE-DRAFT receiver on a phone"])
        self.assertEqual(bob.locator(".typing-notice").evaluate("el => getComputedStyle(el).animationName"), "none")
        notice = bob.locator(".typing-notice").bounding_box(); field = box.bounding_box()
        self.assertTrue(notice and field and notice["y"] + notice["height"] <= 460 and field["y"] + field["height"] <= 460, "composer and notice stay above the keyboard")
        shot(bob, "typing-project-390-virtual-keyboard")
        self.composer(alice).blur()
        expect(bob.locator(".typing-notice")).not_to_contain_text("Alice Rivera", timeout=750)

    def open_at(self, who, index=0, *, conversation_path=None, **options):
        """A thread opened by URL, with no earlier page load: its sockets only ever belong to this scope."""
        page = self.page(who, **options)
        page.goto(conversation_path or self.path(index))
        expect(page.locator("#thread .typing-notice")).to_have_attribute("data-availability", "ready")
        return page

    def work_with_root(self, title):
        """A task with its accepted discussion root (the task's one thread), through the public API."""
        owner = self.page("alice")
        work = owner.request.post(f"/api/v1/projects/{self.project}/work", data={"title": title, "clientCommandId": str(uuid.uuid4())}, headers={"origin": ORIGIN})
        self.assertEqual(work.status, 201, work.text())
        work = work.json()
        root = owner.request.post(f"/api/v1/work/{work['id']}/discussion", data={"body": "Start with the reading corner at dusk.", "clientMessageId": str(uuid.uuid4()), "kind": "text"}, headers={"origin": ORIGIN})
        self.assertEqual(root.status, 201, root.text())
        conversation = root.json()["conversationId"]
        owner.context.close()
        return work, conversation

    def panel(self, who, task, *, viewport=None):
        """The task in the one detail panel (F-026 P10), beside the Tasks view."""
        page = self.page(who, viewport=viewport)
        page.goto(f"/projects/{self.project}/tasks?open=work:{task}")
        return page

    def test_12_the_task_panel_shares_the_task_threads_presence_and_nothing_else(self):
        """AC-2: the composer in the task panel (Details) is the third view of the task's one thread. Writing there
        shows one person typing in the panel and in the task's thread in Conversation, never to the writer, never in
        another conversation, and it ends on blur and on send. Nothing is stored for it."""
        work, conversation = self.work_with_root("Place the manual switch")
        bare = self.page("alice")
        created = bare.request.post(f"/api/v1/projects/{self.project}/work", data={"title": "Sand the lamp base", "clientCommandId": str(uuid.uuid4())}, headers={"origin": ORIGIN})
        self.assertEqual(created.status, 201, created.text())
        bare_id = created.json()["id"]
        alice = self.panel("alice", work["id"])
        bob = self.panel("bob", work["id"])
        for page in (alice, bob):
            expect(page.locator("#details .typing-notice")).to_have_attribute("data-availability", "ready")
        thread = self.open_at("bob", conversation_path=f"/projects/{self.project}/conversations/{conversation}")
        elsewhere = self.open_at("viewer", 1)  # another conversation's thread: the same project, a different scope
        before = alice.request.get(f"/api/v1/work/{work['id']}/discussion").json()
        field = alice.locator("#details").get_by_label("Write to this task")
        notice = bob.locator("#details .typing-notice")
        bob_field = bob.locator("#details").get_by_label("Write to this task")
        bob_field.fill("PRIVATE-DRAFT receiver in the panel")
        bob_field.focus()
        box_before = bob_field.bounding_box()
        self.measure("task-panel-input-visible", lambda: field.fill("PRIVATE-DRAFT author in the task panel"), lambda: expect(notice).to_have_text("Alice Rivera is typing…", timeout=2000), 2000)
        expect(thread.locator("#thread .typing-notice")).to_have_text("Alice Rivera is typing…", timeout=2000)
        # Her own panel never shows her; the receiver's draft, focus and box stay where they were.
        expect(alice.locator("#details .typing-notice")).not_to_contain_text("Alice Rivera")
        expect(bob_field).to_be_focused()
        expect(bob_field).to_have_value("PRIVATE-DRAFT receiver in the panel")
        self.assertEqual(box_before, bob_field.bounding_box(), "the typing line takes no room from the box")
        expect(elsewhere.locator("#thread .typing-notice")).not_to_contain_text("Alice Rivera")
        # The same person writing in the panel and in the task's thread in Conversation is one person typing.
        alice_thread = self.open_at("alice", conversation_path=f"/projects/{self.project}/conversations/{conversation}")
        self.composer(alice_thread).fill("PRIVATE-DRAFT from the Conversation thread")
        alice_thread.wait_for_timeout(600)
        expect(notice).to_have_text("Alice Rivera is typing…")
        expect(thread.locator("#thread .typing-notice")).to_have_text("Alice Rivera is typing…")
        self.composer(alice_thread).blur()
        self.measure("task-panel-blur-stop", lambda: field.blur(), lambda: expect(notice).not_to_contain_text("Alice Rivera", timeout=750), 750)
        expect(thread.locator("#thread .typing-notice")).not_to_contain_text("Alice Rivera", timeout=750)
        # Sending ends it at once and stores exactly the one message that was sent.
        field.fill("Start with the reading corner at dusk, then the manual switch.")
        expect(notice).to_have_text("Alice Rivera is typing…", timeout=2000)
        self.measure("task-panel-send-stop", lambda: field.press("Enter"), lambda: expect(notice).not_to_contain_text("Alice Rivera", timeout=750), 750)
        expect(alice.locator("#details .wd-act__bubble", has_text="then the manual switch")).to_have_count(1, timeout=10000)
        after = alice.request.get(f"/api/v1/work/{work['id']}/discussion").json()
        self.assertEqual(len(after["messages"]), len(before["messages"]) + 1, "only the sent message is stored")
        # Frames carry names and a boolean, never draft text; the other conversation's reader only ever heard its own scope.
        for page, who in ((alice, "alice"), (bob, "bob"), (thread, "bob")):
            self.assert_wire(page, who)
        self.assertEqual({frame["context"]["id"] for frame in elsewhere.typing_received if frame["type"] == "snapshot"}, {self.conversations[1]})
        # On a phone the task is a sheet: the same line, the same scope, and the box does not move.
        phone = self.panel("bob", work["id"], viewport={"width": 390, "height": 844})
        phone_field = phone.locator("#details").get_by_label("Write to this task")
        expect(phone.locator("#details .typing-notice")).to_have_attribute("data-availability", "ready")
        phone_box = phone_field.bounding_box()
        field.fill("PRIVATE-DRAFT author, watched from a phone")
        expect(phone.locator("#details .typing-notice")).to_have_text("Alice Rivera is typing…", timeout=2000)
        self.assertEqual(phone_box, phone_field.bounding_box(), "the typing line takes no room from the phone sheet's box")
        field.blur()
        expect(phone.locator("#details .typing-notice")).not_to_contain_text("Alice Rivera", timeout=750)
        # A task with no first message has no thread: the line is an empty, aria-hidden spacer and no socket is opened.
        quiet = self.panel("alice", bare_id)
        label = quiet.locator("#details").get_by_label("First message about this task")
        expect(label).to_be_visible()
        label.fill("PRIVATE-DRAFT before any thread exists")
        quiet.wait_for_timeout(1800)
        self.assertEqual((quiet.typing_sent, quiet.typing_received), ([], []), "no root and no socket just to show presence")
        spacer = quiet.locator("#details .wd__foot .typing-notice")
        self.assertEqual(spacer.get_attribute("aria-hidden"), "true")
        self.assertEqual(spacer.bounding_box()["height"], notice.bounding_box()["height"], "the same line height with and without a thread")

    def test_13_typing_is_scoped_to_the_thread_the_stream_has_no_scope(self):
        """AC-2: a person writing in one thread is invisible in another thread and in the stream, which has no
        conversation of its own: the stream shows no typing line and opens no typing socket."""
        alice = self.open_at("alice", 0)
        same = self.open_at("bob", 0)
        other = self.open_at("viewer", 1)
        stream = self.page("bob")
        stream.goto(f"/projects/{self.project}")
        expect(stream.get_by_label("Write a message", exact=True)).to_be_visible()
        self.composer(alice).fill("PRIVATE-DRAFT in the first thread only")
        expect(same.locator("#thread .typing-notice")).to_have_text("Alice Rivera is typing…", timeout=2000)
        other.wait_for_timeout(1500)
        expect(other.locator("#thread .typing-notice")).not_to_contain_text("Alice Rivera")
        self.assertEqual(stream.locator(".typing-notice").count(), 0, "the stream shows no typing line")
        self.assertEqual((stream.typing_sent, stream.typing_received), ([], []), "the stream opens no typing socket")
        self.assertEqual({frame["context"]["id"] for frame in other.typing_received if frame["type"] == "snapshot"}, {self.conversations[1]})
        self.assertEqual({frame["context"]["id"] for frame in same.typing_received if frame["type"] == "snapshot"}, {self.conversations[0]})
        # Opening the second thread moves the writer's scope: the first thread's reader hears the stop.
        self.measure("thread-switch-stop", lambda: self.open_thread(alice, 1), lambda: expect(same.locator("#thread .typing-notice")).not_to_contain_text("Alice Rivera", timeout=750), 750)
        self.assert_wire(alice, "alice")

    def test_14_another_members_message_arrives_live_with_the_end_of_typing(self):
        """#733: with two people in one open thread, the other person's message arrives within about a second of
        Send, together with the end of their typing line, in the thread and as a new root in the stream; it does
        not wait for the 15-second fallback refresh."""
        alice = self.open("alice")
        bob = self.open("bob")
        notice = bob.locator("#thread .typing-notice")
        for attempt in range(2):
            body = f"Live arrival {attempt + 1}: the clip holds the cable on the base, front left."
            self.composer(alice).fill(body)
            expect(notice).to_have_text("Alice Rivera is typing…", timeout=2000)
            arrived = self.thread(bob).locator(".project-convo__message", has_text=body)
            start = time.monotonic()
            self.composer(alice).press("Enter")
            expect(notice).not_to_contain_text("Alice Rivera", timeout=2000)
            stopped = (time.monotonic() - start) * 1000
            expect(arrived).to_have_count(1, timeout=2000)
            elapsed = (time.monotonic() - start) * 1000
            self.observations.append({"case": f"thread-message-arrival-{attempt + 1}", "milliseconds": round(elapsed, 3), "typing_stop": round(stopped, 3), "maximum": 2000})
            self.assertLessEqual(elapsed, 2000, "the reply reaches the open thread from the live stream")
            self.assertLessEqual(elapsed - stopped, 1500, "the typing line and the message change together")
        # A new conversation from the other member reaches the stream's roots the same way.
        root = f"Live root {STAMP}: should the lamp dim before it switches off?"
        stream = self.page("bob")
        stream.goto(f"/projects/{self.project}")
        expect(stream.get_by_label("Write a message", exact=True)).to_be_visible()
        stream.wait_for_timeout(500)
        start = time.monotonic()
        response = alice.request.post(f"/api/v1/projects/{self.project}/conversations", data={"body": root, "clientMessageId": str(uuid.uuid4())}, headers={"origin": ORIGIN})
        self.assertEqual(response.status, 201, response.text())
        expect(stream.get_by_text(root, exact=True)).to_have_count(1, timeout=2000)
        elapsed = (time.monotonic() - start) * 1000
        self.observations.append({"case": "stream-root-arrival", "milliseconds": round(elapsed, 3), "maximum": 2000})
        self.assertLessEqual(elapsed, 2000, "a new conversation reaches the open stream from the live stream")


if __name__ == "__main__":
    unittest.main(verbosity=2)
