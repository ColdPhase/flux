"""Real two-account typing journeys, not a simulated presence implementation.

Public API fixtures, actual cookie-authenticated sockets, Chromium DOM and native
messages. A receiver transport test drops only real server frames. It never
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
from test_app_shell import ORIGIN, UPSTREAM, shot, start_forwarder

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
        cls.browser = cls.pw.chromium.launch()
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
        return page.locator("#dm-composer" if dm else "#project-composer")

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
        bob.get_by_role("button", name=re.compile(r"^Sources")).click()
        bob.get_by_role("button", name="Discuss this version").click()
        expect(bob.locator(".project-convo__citation")).to_contain_text("Low-light observations")
        self.composer(bob).fill("PRIVATE-DRAFT receiver notes")
        self.composer(bob).focus()
        bob.locator(".project-convo__feed").evaluate("el => { el.scrollTop = 120; }")
        before = bob.locator(".project-convo__feed").evaluate("el => ({top:el.scrollTop,height:el.clientHeight,count:el.querySelectorAll('.project-convo__message').length})")
        original = alice.request.get(f"/api/v1/conversations/{self.conversations[0]}").json()
        notice = bob.locator(".typing-notice")
        self.measure("project-input-visible", lambda: self.composer(alice).fill("PRIVATE-DRAFT author notes"), lambda: expect(notice).to_have_text("Alice Rivera is typing…", timeout=2000), 2000)
        expect(alice.locator(".typing-notice")).not_to_contain_text("Alice Rivera")
        expect(self.composer(bob)).to_be_focused()
        expect(self.composer(bob)).to_have_value("PRIVATE-DRAFT receiver notes")
        expect(bob.locator(".project-convo__citation")).to_contain_text("Low-light observations")
        after = bob.locator(".project-convo__feed").evaluate("el => ({top:el.scrollTop,height:el.clientHeight,count:el.querySelectorAll('.project-convo__message').length})")
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
        self.measure("navigation-stop", lambda: alice.get_by_role("link", name=re.compile("^Where should the manual switch go")).click(), lambda: expect(bob.locator(".typing-notice")).not_to_contain_text("Alice Rivera", timeout=750), 750)
        expect(alice).to_have_url(f"{ORIGIN}{self.path(1)}")
        alice.get_by_role("link", name=re.compile("^How should the lamp behave")).click()
        expect(self.composer(alice)).to_have_value("PRIVATE-DRAFT preserved between conversations")
        alice.wait_for_timeout(1800)
        expect(bob.locator(".typing-notice")).not_to_contain_text("Alice Rivera")
        self.composer(alice).fill("A manual switch still works when the sensor is unavailable.")
        expect(bob.locator(".typing-notice")).to_contain_text("Alice Rivera", timeout=2000)
        self.measure("native-send-stop", lambda: self.composer(alice).press("Enter"), lambda: expect(bob.locator(".typing-notice")).not_to_contain_text("Alice Rivera", timeout=750), 750)
        expect(alice.locator(".project-convo__message", has_text="A manual switch still works when the sensor is unavailable.")).to_have_count(1)
        native = alice.request.get(f"/api/v1/conversations/{self.conversations[0]}").json()
        self.assertEqual(sum(message["body"] == "A manual switch still works when the sensor is unavailable." for message in native["messages"]), 1)
        # The existing project feed refetches on focus and its 15-second fallback.
        # Presence remains independent of that durable history refresh.
        expect(bob.locator(".project-convo__message", has_text="A manual switch still works when the sensor is unavailable.")).to_have_count(1, timeout=20000)
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
        expect(self.composer(viewer)).to_be_disabled()
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
        alice.get_by_role("button", name="Ask my assistant").click()
        expect(bob.locator(".typing-notice")).not_to_contain_text("Alice Rivera", timeout=750)
        pulses = sum(frame.get("active") is True for frame in alice.typing_sent)
        alice.get_by_label("Ask your assistant", exact=True).fill("PRIVATE-DRAFT private assistant instructions")
        alice.wait_for_timeout(1800)
        self.assertEqual(sum(frame.get("active") is True for frame in alice.typing_sent), pulses)
        expect(bob.locator(".typing-notice")).not_to_contain_text("Alice Rivera")
        self.composer(alice).press("Escape")
        expect(alice.get_by_label("Reply", exact=True)).to_have_value("PRIVATE-DRAFT private assistant instructions")
        alice.wait_for_timeout(1800)
        self.assertEqual(sum(frame.get("active") is True for frame in alice.typing_sent), pulses, "leaving ask mode does not advertise its restored text")
        self.composer(alice).fill("/ai PRIVATE-DRAFT command-mode prompt")
        expect(alice.get_by_label("Ask your assistant", exact=True)).to_have_value("PRIVATE-DRAFT command-mode prompt")
        alice.wait_for_timeout(1800)
        self.assertEqual(sum(frame.get("active") is True for frame in alice.typing_sent), pulses)
        self.assert_wire(alice, "alice")


if __name__ == "__main__":
    unittest.main(verbosity=2)
