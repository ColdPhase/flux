"""#228 real two-account/browser/socket Gate 4. Run only against an enabled isolated candidate.

FLUX_LIVE_EDITING_TEST=1 selects this cohort. Capability-off is not a Gate 4 pass.
No injected collaboration transport, fake actors, DOM editor mutation, or mocked markdown.
The latency driver in live_editing_latency.py retains every scheduled observation.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import socket
import threading
import time
import unittest
import uuid

from playwright.async_api import Error, async_playwright, expect
from live_editing_identity import map_input_identity
from test_app_shell import ORIGIN, UI_BROWSER, UPSTREAM, start_forwarder
from native_touch import native_touch_driver, native_touch_sender
from native_ime import NativeImeDisplay


class LiveFixture(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        launch_options = {}
        self.native_ime = None
        if UI_BROWSER == 'webkit' and self._testMethodName == 'test_14_ime_composition_shares_the_committed_text_once':
            self.native_ime = NativeImeDisplay()
            self.addCleanup(self.native_ime.close)
            launch_options = {'headless': False, 'env': self.native_ime.environment}
        with native_touch_driver(UI_BROWSER):
            self.pw = await async_playwright().start()
        self.browser = await getattr(self.pw, UI_BROWSER).launch(**launch_options)
        self.assertEqual(self.browser.browser_type.name, UI_BROWSER)
        print(f"ACTUAL_UI_ENGINE={self.browser.browser_type.name}", flush=True)
        self.contexts = []
        self.errors = []
        self.frames = {"ada": [], "kai": []}
        self.acks = {"ada": {}, "kai": {}}
        self.pages = {}
        stamp = uuid.uuid4().hex
        for key, name in (("ada", "Ada North"), ("kai", "Kai South")):
            context = await self.browser.new_context(base_url=ORIGIN, viewport={"width": 1440, "height": 900}, reduced_motion="reduce", service_workers="block")
            self.contexts.append(context)
            page = await context.new_page()
            page.on("pageerror", lambda error: self.errors.append(str(error)))
            self.record_socket(page, key)
            await page.goto("/sign-up")
            await page.get_by_label("Name", exact=True).fill(name)
            await page.get_by_label("Email", exact=True).fill(f"{key}.live.{stamp}@example.test")
            await page.get_by_label("Password", exact=True).fill("live copies retain exact history")
            await page.get_by_role("button", name="Create account", exact=True).click()
            await expect(page.get_by_role("heading", name="Home", exact=True)).to_be_visible()
            self.pages[key] = page
            me = await self.api(page, "GET", "/api/v1/me")
            setattr(self, f"{key}_id", me["user"]["id"])
            setattr(self, f"{key}_email", f"{key}.live.{stamp}@example.test")
        ada = self.pages["ada"]
        ws = await self.api(ada, "POST", "/api/v1/workspaces", {"name": "Live verification studio"}, 201)
        self.workspace = ws["id"]
        await self.api(ada, "POST", f"/api/v1/workspaces/{self.workspace}/members", {"email": self.kai_email, "role": "member"}, 201)
        project = await self.api(ada, "POST", f"/api/v1/workspaces/{self.workspace}/projects", {"name": "Two people writing", "visibility": "restricted"}, 201)
        self.project = project["id"]
        grant = await self.api(ada, "POST", f"/api/v1/projects/{self.project}/grants", {"principal": {"kind": "human", "id": self.kai_id}, "role": "contributor"}, 201)
        self.project_grant_id = grant["id"]

    async def asyncTearDown(self):
        for context in self.contexts:
            await context.close()
        await self.browser.close()
        await self.pw.stop()
        self.assertEqual(self.errors, [], "No uncaught browser errors")

    def record_socket(self, page, key):
        def opened(socket):
            if "/api/v1/editing?" not in socket.url:
                return
            def frame(direction, payload):
                try:
                    if isinstance(payload, bytes):
                        length = int.from_bytes(payload[:4], "big")
                        value = json.loads(payload[4:4 + length])
                    else:
                        value = json.loads(payload)
                    # Fixture actors only; cookies, passwords, and update bodies are not recorded.
                    recorded = {name: item for name, item in value.items() if name not in ("html", "savedDoc")}
                    self.frames[key].append({"at": time.perf_counter(), "direction": direction, "binary": isinstance(payload, bytes), "header": recorded})
                    if direction == "received" and value.get("type") == "ack":
                        self.acks[key][value["commandId"]] = value
                except (ValueError, KeyError):
                    pass
            socket.on("framesent", lambda payload: frame("sent", payload))
            socket.on("framereceived", lambda payload: frame("received", payload))
        page.on("websocket", opened)

    async def api(self, page, method, path, body=None, status=200, headers=None):
        response = await page.request.fetch(path, method=method,
            headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})},
            data=json.dumps(body) if body is not None else None)
        self.assertEqual(response.status, status, await response.text())
        text = await response.text()
        return json.loads(text) if text else None

    async def create_doc(self, body="A saved starting paragraph."):
        doc = await self.api(self.pages["ada"], "POST", f"/api/v1/projects/{self.project}/docs",
            {"title": "Live field notes", "body": body, "state": "published"}, 201, {"idempotency-key": str(uuid.uuid4())})
        self.doc_id = doc["id"]
        self.doc_url = f"/projects/{self.project}/docs/{self.doc_id}"
        return doc

    async def editor(self, key):
        page = self.pages[key]
        await page.goto(self.doc_url + "/edit")
        await expect(page.locator('[data-live-status="live"]')).to_be_visible()
        field = page.locator('.cm-content[aria-label="Shared Markdown"]')
        await expect(field).to_have_attribute("contenteditable", "true")
        return field

    async def type_text(self, page, field, text):
        await field.click()
        await page.keyboard.press("Control+End")
        await page.keyboard.type(text)
        await expect(page.get_by_role("status").filter(has_text="All changes shared")).to_be_visible()

    async def create_map(self, count=3):
        sketch = await self.api(self.pages["ada"], "POST", f"/api/v1/workspaces/{self.workspace}/sketches",
            {"title": "A practical shared map", "scope": "project", "projectId": self.project}, 201,
            {"idempotency-key": str(uuid.uuid4())})
        self.map_id = sketch["id"]
        self.thoughts = []
        for index in range(count):
            created = await self.api(self.pages["ada"], "POST", f"/api/v1/sketches/{self.map_id}/thoughts",
                {"text": f"Thought {index}: Keep the long field observation readable", "x": 40 + (index % 8) * 245, "y": 40 + (index // 8) * 145},
                201, {"idempotency-key": str(uuid.uuid4())})
            self.thoughts.append(created["thought"])
        for page in self.pages.values():
            await page.goto(f"/map/{self.map_id}")
            await expect(page.locator(f'.sk-node[data-id="{self.thoughts[-1]["id"]}"]')).to_be_visible()
            await expect(page.locator('[data-live-map-status="live"]')).to_be_visible()
        return sketch

    async def map_saved(self, page):
        await expect(page.locator(".sk-status")).to_contain_text("Saved")


class ForwarderTransport(unittest.TestCase):
    """The same-origin forwarder every browser check (and the Gate 4 latency driver) goes through."""

    def test_small_frames_cross_the_forwarder_without_a_delayed_ack_stall(self):
        # Two small writes, and the upstream answers once both arrived. With Nagle's algorithm the
        # forwarder held the second write until the first was acknowledged, and the upstream, with
        # nothing to send yet, delayed that ACK: about 40 ms per exchange (#228 Gate 4).
        upstream = socket.socket()
        upstream.bind(("127.0.0.1", 0))
        upstream.listen(1)
        def serve():
            connection, _ = upstream.accept()
            with connection:
                while True:
                    received = b""
                    while len(received) < 2:
                        chunk = connection.recv(2 - len(received))
                        if not chunk:
                            return
                        received += chunk
                    connection.sendall(b"!")
        threading.Thread(target=serve, daemon=True).start()
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()
        start_forwarder(f"http://127.0.0.1:{port}", f"127.0.0.1:{upstream.getsockname()[1]}")
        client = socket.create_connection(("127.0.0.1", port), timeout=5)
        client.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        rounds = []
        with client:
            for _ in range(40):
                started = time.perf_counter()
                client.sendall(b"a")
                time.sleep(.003)  # The forwarder relays each write on its own.
                client.sendall(b"b")
                self.assertEqual(client.recv(1), b"!")
                rounds.append((time.perf_counter() - started) * 1000)
        upstream.close()
        median = sorted(rounds)[len(rounds) // 2]
        self.assertLess(median, 20, f"Median exchange {median:.1f} ms through the forwarder: {[round(value) for value in rounds]}")


@unittest.skipUnless(os.environ.get("FLUX_LIVE_EDITING_TEST") == "1", "#228 Gate 4 needs explicitly enabled isolated candidate; not verified by capability-off")
class LiveEditingJourney(LiveFixture):
    async def test_00_trusted_input_reload_before_batch_deadline_seals_exact_recovery(self):
        await self.create_doc()
        ada, kai = self.pages['ada'], self.pages['kai']
        # Pause the real page's 40ms timer, not its HTTP/WS transport or native input.
        # This makes the before-batch boundary deterministic; never used by latency.
        await ada.clock.install(time=time.time())
        field = await self.editor('ada')
        await field.click()
        await ada.keyboard.press('Control+End')
        await ada.clock.pause_at(time.time() + 1)
        recovery_key = f'flux:wiki-live:{self.ada_id}:{self.doc_id}'
        capture_key = recovery_key + ':test-pagehide-capture'
        await ada.evaluate("([key,capture]) => window.addEventListener('pagehide', () => sessionStorage.setItem(capture,sessionStorage.getItem(key)||''), {once:true})", [recovery_key, capture_key])
        sent = []
        def socket_opened(socket):
            if '/api/v1/editing?' in socket.url:
                def frame(payload):
                    if isinstance(payload, bytes):
                        length = int.from_bytes(payload[:4], 'big')
                        header = json.loads(payload[4:4 + length])
                        if header.get('operation') == 'text':
                            sent.append((header, payload[4 + length:]))
                socket.on('framesent', frame)
        ada.on('websocket', socket_opened)
        await ada.keyboard.insert_text(' Reloaded before forty milliseconds 🚀.')
        self.assertEqual(await ada.locator('[data-live-wiki-editor]').get_attribute('data-live-command-revision'), '0', 'The fresh transaction is still unsealed')
        await ada.reload(wait_until='domcontentloaded')
        captured = json.loads(await ada.evaluate('key => sessionStorage.getItem(key)', capture_key))
        self.assertIn('Reloaded before forty milliseconds 🚀.', captured['body'])
        self.assertEqual(len(captured['pending']), 1)
        original = captured['pending'][0]
        await ada.clock.resume()
        field = ada.locator('.cm-content[aria-label="Shared Markdown"]')
        await expect(field).to_have_attribute('contenteditable', 'true')
        await expect(field).to_contain_text('Reloaded before forty milliseconds 🚀.')
        await expect(ada.get_by_role('status').filter(has_text='All changes shared')).to_be_visible()
        actual = [(header, chunk) for header, chunk in sent if header.get('uuid') == original['envelope']['uuid']]
        self.assertTrue(actual, 'Reload retransmitted the sealed original UUID')
        for header, _chunk in actual:
            self.assertEqual({key: header[key] for key in original['envelope']}, original['envelope'])
        self.assertEqual(b''.join(chunk for _header, chunk in actual), base64.b64decode(original['bytes']))
        live = await self.api(kai, 'GET', f'/api/v1/docs/{self.doc_id}/live')
        self.assertEqual(live['body'].count('Reloaded before forty milliseconds 🚀.'), 1)
        self.assertEqual((await self.api(kai, 'GET', f'/api/v1/docs/{self.doc_id}'))['version'], 1, 'Reload shares working text but creates no saved version')

    async def test_01_live_characters_named_cursors_own_undo_and_immutable_save(self):
        original = await self.create_doc()
        ada, kai = self.pages["ada"], self.pages["kai"]
        ada_field, kai_field = await self.editor("ada"), await self.editor("kai")
        await self.type_text(ada, ada_field, " Ada’s shared 🚀 notes.")
        await expect(kai_field).to_contain_text("Ada’s shared 🚀 notes.")
        await expect(kai.locator(".editing-people")).to_contain_text("Ada North")
        before_save = await self.api(kai, "GET", f"/api/v1/docs/{self.doc_id}")
        self.assertEqual(before_save["body"], original["body"], "Typing alone does not rewrite saved citations")
        await self.type_text(kai, kai_field, " Kai’s independent observation.")
        await expect(ada_field).to_contain_text("Kai’s independent observation.")
        await ada_field.click()
        await ada.keyboard.press("Control+z")
        await expect(kai_field).not_to_contain_text("Ada’s shared 🚀 notes.")
        await expect(kai_field).to_contain_text("Kai’s independent observation.")
        await ada.get_by_label("Reason for this version").fill("Both people reviewed the field notes")
        await ada.get_by_role("button", name="Save version", exact=True).click()
        await expect(ada.get_by_role("status").filter(has_text="Version 2 saved")).to_be_visible()
        saved = await self.api(kai, "GET", f"/api/v1/docs/{self.doc_id}")
        self.assertEqual(saved["version"], 2)
        self.assertIn("Kai’s independent observation.", saved["body"])
        immutable = await self.api(kai, "GET", f"/api/v1/docs/{self.doc_id}/versions/1")
        self.assertEqual(immutable["body"], original["body"])
        await kai.goto(self.doc_url + "/versions/2")
        await expect(kai.locator("[data-live-reader]")).to_have_count(0)
        self.assertTrue(any(row["header"].get("operation") == "text" for row in self.frames["ada"]), "Real Yjs transport used")

    async def test_02_ordinary_reader_tracks_working_text_and_history_stays_saved(self):
        original = await self.create_doc()
        ada, kai = self.pages["ada"], self.pages["kai"]
        field = await self.editor("ada")
        await kai.goto(self.doc_url)
        await expect(kai.locator("[data-live-reader]")).to_be_visible()
        await self.type_text(ada, field, " Reader sees this **before Save**.")
        await expect(kai.locator(".doc-prose")).to_contain_text("Reader sees this before Save.")
        await expect(kai.locator(".editing-people")).to_contain_text("Ada North")
        self.assertEqual((await self.api(kai, "GET", f"/api/v1/docs/{self.doc_id}"))["body"], original["body"])
        await kai.goto(self.doc_url + "/versions/1")
        await expect(kai.locator(".doc-prose")).not_to_contain_text("Reader sees this")
        self.assertFalse(any(row["direction"] == "sent" and row["header"].get("type") == "cursor" for row in self.frames["kai"]), "Reader never publishes writer presence")

    async def test_03_old_private_draft_never_initializes_shared_replica(self):
        await self.create_doc()
        ada = self.pages["ada"]
        await ada.goto(self.doc_url)
        await ada.evaluate("([key, body]) => sessionStorage.setItem(key, JSON.stringify({title:'Private old title',body,state:'draft',reason:'',base:1}))", [f"flux:doc-edit:{self.ada_id}:{self.doc_id}", "Never automatically shared private text"])
        field = await self.editor("ada")
        await expect(field).not_to_contain_text("Never automatically")
        await ada.get_by_role("button", name="Compare private text").click()
        await expect(ada.get_by_label("Earlier private text")).to_have_value("Never automatically shared private text")
        live = await self.api(self.pages["kai"], "GET", f"/api/v1/docs/{self.doc_id}/live")
        self.assertNotIn("Never automatically", live["body"])

    async def test_04_reconnect_same_replica_reload_fresh_replica(self):
        await self.create_doc()
        ada = self.pages["ada"]
        field = await self.editor("ada")
        await self.type_text(ada, field, " First editor instance.")
        def sent_replicas():
            return [row["header"]["replica"] for row in self.frames["ada"]
                if row["direction"] == "sent" and row["binary"] and row["header"].get("operation") == "text"]
        first = sent_replicas()[0]
        await ada.context.set_offline(True)
        await asyncio.sleep(0.15)
        await ada.context.set_offline(False)
        await expect(ada.locator('[data-live-status="live"]')).to_be_visible()
        await self.type_text(ada, field, " Same surviving replica.")
        second = sent_replicas()[-1]
        self.assertEqual(first, second)
        await ada.reload()
        field = ada.locator('.cm-content[aria-label="Shared Markdown"]')
        await expect(field).to_have_attribute("contenteditable", "true")
        await self.type_text(ada, field, " Fresh reloaded replica.")
        third = sent_replicas()[-1]
        self.assertNotEqual(first, third)

    async def test_05_map_preview_before_pointerup_unrelated_delta_during_drag(self):
        await self.create_map()
        ada, kai = self.pages["ada"], self.pages["kai"]
        first, second = self.thoughts[:2]
        node = ada.locator(f'.sk-node[data-id="{first["id"]}"]')
        peer = kai.locator(f'.sk-node[data-id="{first["id"]}"]')
        bounds = await node.bounding_box()
        await ada.mouse.move(bounds["x"] + 20, bounds["y"] + 20)
        await ada.mouse.down()
        await ada.mouse.move(bounds["x"] + 70, bounds["y"] + 55, steps=4)
        await expect(peer).to_have_attribute("data-live-mover", "Ada North")
        await expect(peer).not_to_have_attribute("data-thought-x", str(first["x"]))
        unchanged = await self.api(kai, "GET", f"/api/v1/sketches/{self.map_id}")
        self.assertEqual(next(item for item in unchanged["thoughts"] if item["id"] == first["id"])["x"], first["x"], "Preview precedes durable pointerup")
        other = kai.locator(f'.sk-node[data-id="{second["id"]}"]')
        await other.focus()
        await kai.keyboard.press("ArrowRight")
        await expect(ada.locator(f'.sk-node[data-id="{second["id"]}"]')).to_have_attribute("data-thought-x", str(second["x"] + 12))
        await ada.mouse.up()
        await self.map_saved(ada)
        await expect(peer).not_to_have_attribute("data-live-mover", "Ada North")
        saved = await self.api(ada, "GET", f"/api/v1/sketches/{self.map_id}")
        self.assertGreater(next(item for item in saved["thoughts"] if item["id"] == first["id"])["x"], first["x"])

    async def test_06_map_own_undo_refuses_peer_change(self):
        await self.create_map(1)
        ada, kai = self.pages["ada"], self.pages["kai"]
        id = self.thoughts[0]["id"]
        await ada.locator(f'.sk-node[data-id="{id}"]').focus()
        await ada.keyboard.press("ArrowRight")
        await self.map_saved(ada)
        await expect(kai.locator(f'.sk-node[data-id="{id}"]')).to_have_attribute("data-thought-x", "52")
        await kai.locator(f'.sk-node[data-id="{id}"]').focus()
        await kai.keyboard.press("ArrowRight")
        await self.map_saved(kai)
        await expect(ada.locator(f'.sk-node[data-id="{id}"]')).to_have_attribute("data-thought-x", "64")
        async with ada.expect_response(lambda response: response.url.endswith(f'/api/v1/sketches/{self.map_id}/live/undo') and response.request.method == 'POST') as response:
            await ada.get_by_role("button", name="Undo", exact=True).click()
        refusal = await response.value
        self.assertEqual(refusal.status, 409)
        self.assertEqual((await refusal.json())['code'], 'EDITING_UNDO_CONFLICT')
        await expect(ada.locator(".sk-status .sk-warn")).to_be_visible()
        await expect(kai.locator(f'.sk-node[data-id="{id}"]')).to_have_attribute("data-thought-x", "64")
        self.assertEqual((await self.api(ada, "GET", f"/api/v1/sketches/{self.map_id}"))["thoughts"][0]["x"], 64)

    async def test_07_phone_tablet_and_private_capture_are_real_browser_journeys(self):
        await self.create_map(3)
        ada, kai = self.pages["ada"], self.pages["kai"]
        await ada.set_viewport_size({"width": 390, "height": 844})
        add = ada.get_by_role("button", name="Add a thought", exact=True)
        await expect(add).to_be_visible()
        self.assertLessEqual(await ada.evaluate("document.documentElement.scrollWidth"), 390)
        await add.click()
        phone_draft = ada.get_by_role("form", name="New thought draft")
        await phone_draft.get_by_label("Thought text").fill("Added from the phone map")
        await phone_draft.get_by_role("button", name="Save thought", exact=True).click()
        await expect(ada.locator(".sk-node")).to_have_count(4)
        await expect(kai.locator(".sk-node")).to_have_count(4)
        phone_readback = await self.api(kai, "GET", f"/api/v1/sketches/{self.map_id}")
        self.assertEqual(len(phone_readback["thoughts"]), 4)
        self.assertIn("Added from the phone map", [thought["text"] for thought in phone_readback["thoughts"]])
        await ada.set_viewport_size({"width": 768, "height": 1024})
        await expect(ada.get_by_role("button", name="Thought", exact=True)).to_be_visible()
        self.assertLessEqual(await ada.evaluate("document.documentElement.scrollWidth"), 768)
        await ada.get_by_role("button", name="Thought", exact=True).click()
        await ada.get_by_role("textbox", name=re.compile("thought", re.I)).fill("Private capture remains private until Save")
        await expect(kai.locator(".sk-node")).to_have_count(4)
        self.assertEqual(len((await self.api(kai, "GET", f"/api/v1/sketches/{self.map_id}"))["thoughts"]), 4)
        # This is desktop browser emulation, never physical Android/iPhone/iPad evidence.

    async def test_08_known_replay_after_reload_keeps_recovered_text_before_editable(self):
        await self.create_doc()
        ada, kai = self.pages["ada"], self.pages["kai"]
        dropped = {"active": True, "uuid": None}
        def intercept(socket):
            server = socket.connect_to_server()
            def received(message):
                if isinstance(message, str):
                    data = json.loads(message)
                    if dropped["active"] and data.get("type") == "ack" and data.get("operation") == "text":
                        dropped["uuid"] = data["commandId"]
                        return  # Real server committed; only this network ACK is discarded.
                socket.send(message)
            server.on_message(received)
        await ada.route_web_socket(re.compile(r".*/api/v1/editing\?kind=wiki.*"), intercept)
        field = await self.editor("ada")
        await kai.goto(self.doc_url)
        await field.click()
        await ada.keyboard.press("Control+End")
        await ada.keyboard.insert_text(" Exact recovered text 🚀.")
        await expect(kai.locator(".doc-prose")).to_contain_text("Exact recovered text 🚀.")
        await expect(ada.get_by_role("status").filter(has_text="waiting to be shared")).to_be_visible()
        self.assertIsNotNone(dropped["uuid"], "Real committed update ACK was dropped")
        dropped["active"] = False
        await ada.reload()
        field = ada.locator('.cm-content[aria-label="Shared Markdown"]')
        await expect(field).to_have_attribute("contenteditable", "true")
        await expect(field).to_contain_text("Exact recovered text 🚀.")
        await expect(ada.get_by_role("status").filter(has_text="All changes shared")).to_be_visible()
        self.assertIsNone(await ada.evaluate("key => sessionStorage.getItem(key)", f"flux:wiki-live:{self.ada_id}:{self.doc_id}"))
        live = await self.api(kai, "GET", f"/api/v1/docs/{self.doc_id}/live")
        self.assertEqual(live["body"].count("Exact recovered text 🚀."), 1)

    async def test_09_postcommit_save_response_loss_replays_exact_save(self):
        await self.create_doc()
        ada = self.pages["ada"]
        field = await self.editor("ada")
        await self.type_text(ada, field, " Shared before uncertain Save.")
        commands = []
        async def lose_response(route):
            commands.append(route.request.post_data_json)
            if len(commands) == 1:
                response = await route.fetch()  # Actual HTTP/core/SQL Save, no fake response.
                self.assertEqual(response.status, 200)
                await route.abort("failed")
            else:
                await route.continue_()
        await ada.route(f"**/api/v1/docs/{self.doc_id}/live/save", lose_response)
        await ada.get_by_label("Reason for this version").fill("Exact uncertain snapshot")
        await ada.get_by_role("button", name="Save version", exact=True).click()
        await expect(ada.get_by_role("alert")).to_contain_text("reached")
        await expect(ada.get_by_label("Reason for this version")).to_be_disabled()
        await ada.get_by_role("button", name="Save version", exact=True).click()
        await expect(ada.get_by_role("status").filter(has_text="Version 2 saved")).to_be_visible()
        self.assertEqual(commands[0], commands[1], "Original snapshot, metadata, UUID and versions survive uncertain commit")
        doc = await self.api(ada, "GET", f"/api/v1/docs/{self.doc_id}")
        self.assertEqual(doc["version"], 2)
        versions = await self.api(ada, "GET", f"/api/v1/docs/{self.doc_id}/versions")
        self.assertEqual(len(versions["items"]), 2)

    async def test_10_definite_save_conflict_releases_attempt_for_explicit_fresh_save(self):
        await self.create_doc()
        ada, kai = self.pages["ada"], self.pages["kai"]
        ada_field, kai_field = await self.editor("ada"), await self.editor("kai")
        await self.type_text(ada, ada_field, " Ada before the snapshot.")
        release = asyncio.Event()
        intercepted = asyncio.Event()
        commands = []
        async def hold_first(route):
            commands.append(route.request.post_data_json)
            if len(commands) == 1:
                intercepted.set()
                await asyncio.wait_for(release.wait(), 5)
            await route.continue_()
        await ada.route(f"**/api/v1/docs/{self.doc_id}/live/save", hold_first)
        await ada.get_by_role("button", name="Save version", exact=True).click()
        await asyncio.wait_for(intercepted.wait(), 5)
        try:
            await self.type_text(kai, kai_field, " Kai after that snapshot.")
        finally:
            release.set()
        await expect(ada.get_by_role("alert")).to_be_visible()
        await expect(ada.get_by_label("Reason for this version")).to_be_enabled()
        await expect(ada.locator('[data-live-status="live"]')).to_be_visible()
        await ada.get_by_role("button", name="Save version", exact=True).click()
        await expect(ada.get_by_role("status").filter(has_text="Version 2 saved")).to_be_visible()
        self.assertNotEqual(commands[0]["clientCommandId"], commands[1]["clientCommandId"])
        self.assertGreater(commands[1]["headSequence"], commands[0]["headSequence"])
        saved = await self.api(ada, "GET", f"/api/v1/docs/{self.doc_id}")
        self.assertIn("Ada before the snapshot.", saved["body"])
        self.assertIn("Kai after that snapshot.", saved["body"])

    async def test_11_quota_and_concurrent_own_undo_keep_100k_body(self):
        await self.create_doc('A' * 99_999 + 'B')
        ada, kai = self.pages['ada'], self.pages['kai']
        field, peer = await self.editor('ada'), await self.editor('kai')
        async def copied_document(page, content):
            # The viewport DOM is virtualized and includes named cursor widgets.
            # Observe the actual editor's handled trusted Copy payload after CodeMirror has
            # populated it. This needs no OS clipboard permission and never changes the editor.
            nonce = str(uuid.uuid4())
            sentinel = 'fresh-copy-' + str(uuid.uuid4())
            await page.bring_to_front()
            await content.evaluate('''(element, {nonce,sentinel}) => {
              window.__liveCopyObservation = {nonce,seen:false,text:sentinel};
              window.__liveCopyListener = event => {
                if (!element.contains(event.target)) return;
                window.__liveCopyObservation = {nonce,seen:true,text:event.clipboardData?.getData('text/plain') ?? null,
                  trusted:event.isTrusted,handled:event.defaultPrevented,types:[...(event.clipboardData?.types ?? [])]};
              };
              // Window bubbling observes the original handler's payload, without intercepting it.
              window.addEventListener('copy',window.__liveCopyListener);
            }''', {'nonce': nonce, 'sentinel': sentinel})
            try:
                await content.click()
                await page.keyboard.press('Control+a')
                await page.keyboard.press('Control+c')
                await page.wait_for_function('nonce => window.__liveCopyObservation?.nonce === nonce && window.__liveCopyObservation.seen',
                                             arg=nonce, timeout=5000)
                observed = await page.evaluate('window.__liveCopyObservation')
                self.assertTrue(observed['trusted'], 'The full-text witness must come from native trusted Copy')
                self.assertTrue(observed['handled'], 'The editor populated the Copy payload before the observer')
                self.assertIn('text/plain', observed['types'])
                text = observed['text']
                self.assertIsInstance(text, str)
                self.assertTrue(text and text != sentinel, 'A fresh complete Copy payload replaced the sentinel')
                self.assertLessEqual(len(text), 100_000)
                return text
            finally:
                await page.evaluate('''() => {
                  window.removeEventListener('copy',window.__liveCopyListener);
                  delete window.__liveCopyListener; delete window.__liveCopyObservation;
                }''')
                await content.click()
                await page.keyboard.press('Control+End')
        async def confirmed_body(key, exact_local=True):
            page = self.pages[key]
            command = await page.locator('[data-live-wiki-editor]').get_attribute('data-live-command')
            self.assertIn(command, self.acks[key], 'The actual local update has its real server ACK')
            receipt = self.acks[key][command]
            live = await self.api(page, 'GET', f'/api/v1/docs/{self.doc_id}/live')
            if not exact_local:
                receipt = max((ack for receipts in self.acks.values() for ack in receipts.values()
                    if ack['generation'] == live['generation']), key=lambda ack: ack['sequence'])
            self.assertEqual((live['generation'], live['sequence'], live['hash']), (receipt['generation'], receipt['sequence'], receipt['hash']))
            return live
        def exact_text(actual, expected):
            self.assertTrue(actual == expected, 'The full copied/public working text must match exactly; cursor labels and viewport truncation are excluded')
        await field.click()
        await ada.keyboard.press('Control+Home')
        await ada.keyboard.press('Delete')
        await expect(ada.get_by_role('status').filter(has_text='All changes shared')).to_be_visible()
        await expect(field).to_contain_text('A' * 32)
        deleted = await confirmed_body('ada')
        exact_text(deleted['body'], 'A' * 99_998 + 'B')
        await expect(kai.locator('[data-live-wiki-editor]')).to_have_attribute('data-live-sequence', str(deleted['sequence']))
        exact_text(await copied_document(ada, field), deleted['body'])
        exact_text(await copied_document(kai, peer), deleted['body'])
        await expect(peer).to_contain_text('B')
        await self.type_text(kai, peer, 'K')
        latest = await confirmed_body('kai')
        before = latest['body']
        exact_text(before, 'A' * 99_998 + 'BK')
        self.assertEqual(len(before), 100_000)
        await expect(ada.locator('[data-live-wiki-editor]')).to_have_attribute('data-live-sequence', str(latest['sequence']))
        await field.click()
        await ada.keyboard.press('Control+z')
        await expect(ada.get_by_role('alert')).to_contain_text('This inverse would exceed')
        exact_text(await copied_document(ada, field), before)
        exact_text(await copied_document(kai, peer), before)
        await expect(field).to_contain_text('BK')
        await expect(peer).to_contain_text('BK')
        await expect(ada.get_by_role('status').filter(has_text='All changes shared')).to_be_visible()
        after_undo = await confirmed_body('ada', exact_local=False)
        exact_text(after_undo['body'], before)
        self.assertEqual(after_undo['generation'], latest['generation'])
        self.assertGreaterEqual(after_undo['sequence'], latest['sequence'])
        await field.click()
        await ada.keyboard.press('Control+End')
        await ada.keyboard.insert_text('N')
        await expect(ada.get_by_role('alert')).to_contain_text('shared text limit')
        exact_text(await copied_document(ada, field), before)
        exact_text(await copied_document(kai, peer), before)
        unchanged = await self.api(kai, 'GET', f'/api/v1/docs/{self.doc_id}/live')
        exact_text(unchanged['body'], before)
        self.assertEqual((unchanged['generation'], unchanged['sequence'], unchanged['hash']), (after_undo['generation'], after_undo['sequence'], after_undo['hash']))

    async def test_12_cancelled_preview_keeps_private_movement_without_native_commit(self):
        await self.create_map(1)
        ada, kai = self.pages['ada'], self.pages['kai']
        thought = self.thoughts[0]
        node = ada.locator(f'.sk-node[data-id="{thought["id"]}"]')
        peer = kai.locator(f'.sk-node[data-id="{thought["id"]}"]')
        await node.focus()
        box = await node.bounding_box()
        await ada.mouse.move(box['x'] + 20, box['y'] + 20)
        await ada.mouse.down()
        await ada.mouse.move(box['x'] + 70, box['y'] + 55)
        await expect(peer).to_have_attribute('data-live-mover', 'Ada North')
        await ada.keyboard.press('Escape')
        await ada.mouse.up()
        await expect(peer).not_to_have_attribute('data-live-mover', 'Ada North')
        await expect(peer).to_have_attribute('data-thought-x', str(thought['x']))
        await expect(ada.locator('.editing-map-recovery')).to_be_visible()
        copy = json.loads(await ada.evaluate('key => sessionStorage.getItem(key)', f'flux:map-gesture:{self.ada_id}:{self.map_id}'))
        self.assertGreater(copy['positions'][0]['x'], thought['x'])
        self.assertEqual((await self.api(kai, 'GET', f'/api/v1/sketches/{self.map_id}'))['thoughts'][0]['version'], thought['version'])
        await ada.reload()
        await expect(ada.locator('.editing-map-recovery')).to_be_visible()
        await expect(ada.locator(f'.sk-node[data-id="{thought["id"]}"]')).to_have_attribute('data-thought-x', str(thought['x']))

    async def test_13_trusted_touch_drag_previews_before_release_on_a_tablet(self):
        # A real touch sequence (native Chromium/WebKit input, pointerType "touch") on an 820 px tablet (F-026 S15 keeps phones view/add only):
        # tap selects, a finger drag on the selected thought moves it, the peer sees the
        # movement before the finger lifts, and the release confirms one durable position.
        await self.create_map(2)
        kai = self.pages["kai"]
        thought = self.thoughts[0]
        tablet = await self.browser.new_context(base_url=ORIGIN, storage_state=await self.pages["ada"].context.storage_state(),
            viewport={"width": 820, "height": 1180}, has_touch=True, is_mobile=True, reduced_motion="reduce", service_workers="block")
        self.contexts.append(tablet)
        page = await tablet.new_page()
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        await page.goto(f"/map/{self.map_id}")
        self.assertFalse(await page.evaluate("matchMedia('(max-width: 640px)').matches"), "accepted tablet viewport is outside the actual phone/compact predicate")
        await expect(page.locator('[data-live-map-status="live"]')).to_be_visible()
        self.assertLessEqual(await page.evaluate("document.documentElement.scrollWidth"), 820,
            "the tablet map stays within its 820px viewport")
        pane = await page.locator('.sk-canvas-wrap').bounding_box()
        canvas = await page.locator('.sk-canvas').bounding_box()
        self.assertIsNotNone(pane)
        self.assertIsNotNone(canvas)
        self.assertGreater(canvas['width'], 0)
        self.assertGreater(canvas['height'], 0)
        self.assertGreaterEqual(canvas['x'], pane['x'] - 1, "the map canvas starts within its tablet pane")
        self.assertGreaterEqual(canvas['y'], pane['y'] - 1, "the map canvas starts within its tablet pane")
        self.assertLessEqual(canvas['x'] + canvas['width'], pane['x'] + pane['width'] + 1,
            "the map canvas ends within its tablet pane")
        self.assertLessEqual(canvas['y'] + canvas['height'], pane['y'] + pane['height'] + 1,
            "the map canvas ends within its tablet pane")
        node = page.locator(f'.sk-node[data-id="{thought["id"]}"]')
        await node.scroll_into_view_if_needed()
        bounds = await node.bounding_box()
        self.assertIsNotNone(bounds)
        self.assertGreaterEqual(bounds['x'], 0, "the selected map thought remains visible on the tablet")
        self.assertLessEqual(bounds['x'] + bounds['width'], 820, "the selected map thought fits the tablet width")
        await node.tap()
        await expect(node).to_have_attribute("aria-pressed", "true")
        box = await node.bounding_box()
        x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        touch = await native_touch_sender(page)
        await touch("touchStart", x, y)
        for step in range(1, 9):
            await touch("touchMove", x + 6 * step, y + 5 * step)
            await page.wait_for_timeout(16)
        peer = kai.locator(f'.sk-node[data-id="{thought["id"]}"]')
        await expect(peer).to_have_attribute("data-live-mover", "Ada North")
        await expect(peer).not_to_have_attribute("data-thought-x", str(thought["x"]))
        unchanged = await self.api(kai, "GET", f"/api/v1/sketches/{self.map_id}")
        self.assertEqual(unchanged["thoughts"][0]["version"], thought["version"], "The finger is still down: nothing is saved yet")
        # The five-second drag lease is renewed only by movement; a held finger nudges before release.
        await touch("touchMove", x + 49, y + 41)
        await touch("touchEnd")
        await expect(page.locator(".sk-status")).to_contain_text("Saved")
        await expect(peer).not_to_have_attribute("data-live-mover", "Ada North")
        saved = next(item for item in (await self.api(kai, "GET", f"/api/v1/sketches/{self.map_id}"))["thoughts"] if item["id"] == thought["id"])
        self.assertEqual(saved["version"], thought["version"] + 1)
        self.assertGreater(saved["y"], thought["y"])
        await expect(peer).to_have_attribute("data-thought-y", str(saved["y"]))

    async def test_14_ime_composition_shares_the_committed_text_once(self):
        # Chromium retains its supported native CDP composition. WebKit uses real GTK Unicode
        # preedit/commit through X11, not synthetic DOM events or an inserted final string.
        await self.create_doc()
        ada, kai = self.pages["ada"], self.pages["kai"]
        ada_field, kai_field = await self.editor("ada"), await self.editor("kai")
        cdp = await ada.context.new_cdp_session(ada) if UI_BROWSER == 'chromium' else None

        async def compose(field):
            await ada.bring_to_front()
            previous_title = await ada.title()
            if self.native_ime:
                marker = 'Flux native IME ' + uuid.uuid4().hex
                await ada.evaluate('title => { document.title = title; }', marker)
                await ada.wait_for_timeout(50)
                self.native_ime.focus_writer(marker)
            try:
                await field.click()
                await ada.keyboard.press('Control+End')
                await field.evaluate('''element => {
                  window.__nativeImeWitness = [];
                  for (const type of ['compositionstart','compositionupdate','compositionend','beforeinput','input'])
                    element.addEventListener(type, event => window.__nativeImeWitness.push({type:event.type,
                      data:event.data, trusted:event.isTrusted, composing:event.isComposing, inputType:event.inputType}), true);
                }''')
                if cdp:
                    for text in ('に', 'にほ', 'にほん'):
                        await cdp.send('Input.imeSetComposition', {'text': text, 'selectionStart': len(text), 'selectionEnd': len(text)})
                        await ada.wait_for_timeout(30)
                    await cdp.send('Input.insertText', {'text': '日本'})
                else:
                    self.assertIsNotNone(self.native_ime, 'WebKit must use its real native IM context')
                    for digits, committed in (('65e5', '日'), ('672c', '本')):
                        before = await ada.evaluate('window.__nativeImeWitness.length')
                        self.native_ime.chord('Control_L', 'Shift_L', 'u')
                        for digit in digits:
                            self.native_ime.key(digit)
                            await ada.wait_for_timeout(20)
                        await ada.wait_for_function('''({before,digits}) => window.__nativeImeWitness.slice(before)
                          .some(event => event.type === 'compositionupdate' && event.trusted && event.data.toLowerCase().includes(digits))''',
                          arg={'before': before, 'digits': digits}, timeout=5000)
                        self.native_ime.key('Return')
                        await ada.wait_for_function('''({before,committed}) => window.__nativeImeWitness.slice(before)
                          .some(event => event.type === 'input' && event.trusted && event.data === committed)''',
                          arg={'before': before, 'committed': committed}, timeout=5000)
                await ada.keyboard.type(' notes')
                witness = await ada.evaluate('window.__nativeImeWitness')
                composition = [event for event in witness if event['type'].startswith('composition')]
                for kind in ('compositionstart', 'compositionupdate', 'compositionend'):
                    self.assertTrue(any(event['type'] == kind for event in composition), f'Missing native {kind}: {witness}')
                for kind in ('compositionstart', 'compositionupdate'):
                    self.assertTrue(any(event['type'] == kind and event['trusted'] for event in composition), witness)
                self.assertTrue(any(event['type'] == 'input' and event['trusted']
                                    and event['data'] in ('日本', '日', '本') for event in witness), witness)
                if self.native_ime:
                    self.assertTrue(all(event['trusted'] for event in composition), witness)
                    self.assertEqual(sum(event['type'] == 'compositionstart' for event in composition), 2, witness)
                    # GTK ends the hexadecimal preedit with empty data before each real commit.
                    # Both nonempty composition ends and committed inputs must identify each
                    # expected character exactly once; native cleanup ends are not extra text.
                    self.assertEqual([event['data'] for event in composition
                                      if event['type'] == 'compositionend' and event['data']], ['日', '本'], witness)
                    self.assertEqual([event['data'] for event in witness if event['type'] == 'input'
                                      and event['inputType'] == 'insertFromComposition'], ['日', '本'], witness)
                    self.assertTrue(all(event['trusted'] for event in witness if event['type'] == 'input'), witness)
                    print('ACTUAL_NATIVE_IME=webkit-gtk-simple-x11; trusted preedit/commit cycles=2', flush=True)
                else:
                    # CDP's observed compositionend has isTrusted=false. It is not a native-end
                    # witness; the original kana preedit, real input and convergence remain required.
                    print('ACTUAL_NATIVE_IME=chromium-cdp; trusted preedit/input; endTrusted=' +
                          str([event['trusted'] for event in composition if event['type'] == 'compositionend']), flush=True)
            finally:
                if self.native_ime:
                    await ada.evaluate('title => { document.title = title; }', previous_title)

        await compose(ada_field)
        await expect(ada.get_by_role("status").filter(has_text="All changes shared")).to_be_visible()
        await expect(kai_field).to_contain_text("日本 notes")
        for page in (ada, kai):
            text = await page.locator('.cm-content[aria-label="Shared Markdown"]').inner_text()
            self.assertEqual(text.count("日本"), 1, text[-80:])
            self.assertNotIn("にほん", text)
        # Each copy also renders the peer's named cursor label inside the content; compare the text itself.
        def shared_text(raw: str) -> str:
            for label in ("Ada North", "Kai South"):
                raw = raw.replace(label, "")
            return "".join(raw.split())
        self.assertEqual(shared_text(await ada_field.inner_text()), shared_text(await kai_field.inner_text()))

        # At the unchanged hard limit, remove eight code units first so even a five-character
        # native hexadecimal preedit stays below it. Two committed characters plus " notes"
        # restore exactly100,000; the saved historical version remains byte-for-byte unchanged.
        boundary = await self.create_doc('r' * 100_000)
        ada_field, kai_field = await self.editor('ada'), await self.editor('kai')
        await ada_field.click()
        await ada.keyboard.press('Control+End')
        for _ in range(8):
            await ada.keyboard.press('Shift+ArrowLeft')
        await ada.keyboard.press('Backspace')
        await compose(ada_field)
        await expect(ada.get_by_role('status').filter(has_text='All changes shared')).to_be_visible()
        # The peer's100k editor virtualizes the beginning while its caret stays there.
        # Reach the committed end through its real keyboard before inspecting that text.
        await kai_field.click()
        await kai.keyboard.press('Control+End')
        await expect(kai_field).to_contain_text('日本 notes')
        expected = 'r' * 99_992 + '日本 notes'
        for page in (ada, kai):
            current = await self.api(page, 'GET', f'/api/v1/docs/{boundary["id"]}/live')
            self.assertEqual(current['body'], expected)
            self.assertEqual(len(current['body']), 100_000)
            saved = await self.api(page, 'GET', f'/api/v1/docs/{boundary["id"]}/versions/1')
            self.assertEqual(saved['body'], 'r' * 100_000)

    async def test_15_a_collaborators_caret_at_the_end_never_takes_the_last_character_selection(self):
        # #228 Gate 4: Shift+ArrowLeft at the end of the text must select the last character even
        # when the other person's named caret sits at that same end position.
        await self.create_doc("Field note ends here")
        ada, kai = self.pages["ada"], self.pages["kai"]
        ada_field, kai_field = await self.editor("ada"), await self.editor("kai")
        shared = """(ending) => {
          const content = document.querySelector('.cm-content'), walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
          let text = '', node; while ((node = walker.nextNode())) if (!node.parentElement.closest('.editing-caret')) text += node.data;
          return text === 'Field note ends he' + ending;
        }"""

        async def replace_last(character: str) -> None:
            await ada.keyboard.press("Control+End")
            await ada.keyboard.press("Shift+ArrowLeft")
            await ada.keyboard.insert_text(character)
            # Both copies hold the same length of text, with this character replacing the last one.
            for page in (ada, kai):
                await page.wait_for_function(shared, arg="r" + character, timeout=5000)

        # Control: Kai's caret at the start, away from the end of the text.
        await kai_field.click()
        await kai.keyboard.press("Control+Home")
        await expect(ada.locator('.editing-caret[aria-label="Kai South\'s cursor"]')).to_have_count(1)
        await ada_field.click()
        await replace_last("A")
        # Kai's caret moves to the very end, the position Ada's own cursor goes to.
        await kai_field.click()
        await kai.keyboard.press("Control+End")
        await ada.wait_for_function("""() => {
          const caret = document.querySelector('.editing-caret[aria-label="Kai South\\'s cursor"]');
          const content = document.querySelector('.cm-content'), walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
          let last = null, node; while ((node = walker.nextNode())) if (node.data.trim() && !node.parentElement.closest('.editing-caret')) last = node;
          if (!caret || !last) return false;
          const range = document.createRange(); range.setStart(last, last.data.length - 1); range.setEnd(last, last.data.length);
          return Math.abs(caret.getBoundingClientRect().left - range.getBoundingClientRect().right) <= 2;
        }""", timeout=5000)
        await ada_field.click()
        for character in "BCDEF":
            await replace_last(character)
        self.assertEqual(await ada_field.locator(".editing-caret").count(), 0, "The named caret is drawn outside the editable text")

    async def test_16_a_peers_live_preview_renders_and_measures_only_the_moved_thought(self):
        # #228 Gate 4: a live preview arrives every 40 ms. The peer re-rendered every thought for each
        # one, and each thought's new ref callback made the ResizeObserver re-measure all of them;
        # with 500 thoughts that kept the peer busy. React's DevTools hook (also called by production
        # builds) tells which thoughts a commit rendered: a thought that bails out keeps its fiber.
        ada, kai = self.pages["ada"], self.pages["kai"]
        await kai.add_init_script("""(() => {
          const observe = ResizeObserver.prototype.observe; window.__observed = 0;
          ResizeObserver.prototype.observe = function (...args) { window.__observed++; return observe.apply(this, args); };
          const fibers = new Map(); window.__rendered = 0;
          window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, isDisabled: false, renderers: new Map(), inject() { return 1; },
            checkDCE() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
            onCommitFiberRoot(_id, root) {
              const stack = [root.current];
              while (stack.length) {
                const fiber = stack.pop();
                const props = fiber.memoizedProps;
                if (fiber.type === 'button' && props && props['data-id'] && String(props.className).startsWith('sk-node')) {
                  if (fibers.has(props['data-id']) && fibers.get(props['data-id']) !== fiber) window.__rendered++;
                  fibers.set(props['data-id'], fiber);
                  continue;
                }
                if (fiber.sibling) stack.push(fiber.sibling);
                if (fiber.child) stack.push(fiber.child);
              }
            } };
        })()""")
        await self.create_map(40)
        target = self.thoughts[0]
        node = ada.locator(f'.sk-node[data-id="{target["id"]}"]')
        peer = kai.locator(f'.sk-node[data-id="{target["id"]}"]')
        await kai.wait_for_timeout(500)
        before = await kai.evaluate("({observed: window.__observed, rendered: window.__rendered})")
        received = len([row for row in self.frames["kai"] if row["direction"] == "received" and row["header"].get("type") == "map-move"])
        bounds = await node.bounding_box()
        await ada.mouse.move(bounds["x"] + 20, bounds["y"] + 20)
        await ada.mouse.down()
        for step in range(1, 25):
            await ada.mouse.move(bounds["x"] + 20 + 4 * step, bounds["y"] + 20 + 2 * step)
            await ada.wait_for_timeout(45)
        await expect(peer).to_have_attribute("data-live-mover", "Ada North")
        await kai.wait_for_timeout(200)
        previews = len([row for row in self.frames["kai"] if row["direction"] == "received" and row["header"].get("type") == "map-move"]) - received
        after = await kai.evaluate("({observed: window.__observed, rendered: window.__rendered})")
        await ada.mouse.up()
        await self.map_saved(ada)
        # Controls: the peer received a stream of previews and the hook saw the moved thought render.
        self.assertGreaterEqual(previews, 8, "The peer received a stream of live previews")
        rendered, observed = after["rendered"] - before["rendered"], after["observed"] - before["observed"]
        self.assertGreaterEqual(rendered, previews // 2, "The DevTools hook observes the moved thought's renders")
        self.assertLess(observed, 8, f"{observed} element observations for {previews} previews of a 40-thought map")
        self.assertLessEqual(rendered, 3 * previews, f"{rendered} thought renders for {previews} previews of a 40-thought map")

        # A stationary live preview still receives both people's real presence
        # heartbeats. They must not recreate or render the moved Thought body.
        # This pause stays inside the unchanged five-second movement lease.
        # The first drag has already committed above; start another real preview.
        bounds = await node.bounding_box()
        await ada.mouse.move(bounds["x"] + 20, bounds["y"] + 20)
        await ada.mouse.down()
        await ada.mouse.move(bounds["x"] + 60, bounds["y"] + 40, steps=3)
        await expect(peer).to_have_attribute("data-live-mover", "Ada North")
        sequence = await ada.locator('.sk-canvas').get_attribute('data-live-own-sequence')
        await expect(peer).to_have_attribute('data-live-preview-sequence', sequence)
        await kai.wait_for_timeout(200)
        presence_before = sum(row['direction'] == 'received' and row['header'].get('type') == 'map-presence'
                              for row in self.frames['kai'])
        quiet_before = await kai.evaluate("({observed: window.__observed, rendered: window.__rendered})")
        await kai.wait_for_timeout(2100)
        presence_after = sum(row['direction'] == 'received' and row['header'].get('type') == 'map-presence'
                             for row in self.frames['kai'])
        self.assertGreaterEqual(presence_after - presence_before, 2, 'Actual presence frames arrived during the stationary preview')
        self.assertEqual(await kai.evaluate("({observed: window.__observed, rendered: window.__rendered})"), quiet_before,
                         'Presence-only updates do not render thought bodies or reobserve nodes')
        await ada.mouse.up()
        await self.map_saved(ada)

        # The first eight thoughts occupy the entire top row. Moving that row used
        # to rebase the plane origin and move every untouched neighbour on both pages.
        # This exercises real trusted input and the existing API/socket/React path.
        await self.create_map(40)
        group = self.thoughts[:8]
        untouched = self.thoughts[8]
        group_ids = {thought["id"] for thought in group}
        for thought in group:
            await ada.locator(f'.sk-node[data-id="{thought["id"]}"]').click(modifiers=["Shift"])
        node = ada.locator(f'.sk-node[data-id="{group[0]["id"]}"]')
        await node.scroll_into_view_if_needed()
        await kai.locator(f'.sk-node[data-id="{group[0]["id"]}"]').scroll_into_view_if_needed()
        async def neighbour_state(page):
            return await page.locator(f'.sk-node[data-id="{untouched["id"]}"]').evaluate("""el => {
              const box=el.getBoundingClientRect(),canvas=document.querySelector('.sk-canvas');
              return {transform:el.style.transform,x:el.dataset.thoughtX,y:el.dataset.thoughtY,
                version:el.dataset.thoughtVersion,mover:el.dataset.liveMover||null,
                left:box.left,top:box.top,scrollLeft:canvas.scrollLeft,scrollTop:canvas.scrollTop};
            }""")
        original_neighbours = {key: await neighbour_state(page) for key,page in self.pages.items()}
        bounds = await node.bounding_box()
        await ada.mouse.move(bounds["x"] + 20, bounds["y"] + 20)
        await ada.mouse.down()
        for step in range(1, 13):
            await ada.mouse.move(bounds["x"] + 20 + 4 * step, bounds["y"] + 20 + 2 * step)
            await ada.wait_for_timeout(45)
            for thought in group:
                await expect(kai.locator(f'.sk-node[data-id="{thought["id"]}"]')).to_have_attribute("data-live-mover", "Ada North")
            for key,page in self.pages.items():
                current = await neighbour_state(page)
                expected = original_neighbours[key]
                for field in ("transform", "x", "y", "version", "mover", "scrollLeft", "scrollTop"):
                    self.assertEqual(current[field], expected[field], f"{key}: untouched neighbour {field} changed during live preview")
                self.assertAlmostEqual(current["left"], expected["left"], delta=0.5)
                self.assertAlmostEqual(current["top"], expected["top"], delta=0.5)
        real_previews = [row for row in self.frames["kai"] if row["direction"] == "received"
            and row["header"].get("type") == "map-move"
            and {position["id"] for position in row["header"].get("positions", [])} == group_ids]
        self.assertGreaterEqual(len(real_previews), 8, "The complete top row was shared before pointerup")
        unchanged = await self.api(kai, "GET", f"/api/v1/sketches/{self.map_id}")
        for thought in unchanged["thoughts"]:
            self.assertEqual(thought["version"], 1, "No preview changed native durable versions")
        for thought in group:
            await expect(ada.locator(f'.sk-node[data-id="{thought["id"]}"]')).to_have_attribute("aria-pressed", "true")
        await ada.mouse.up()
        await self.map_saved(ada)
        saved = await self.api(kai, "GET", f"/api/v1/sketches/{self.map_id}")
        by_id = {thought["id"]: thought for thought in saved["thoughts"]}
        for thought in group:
            self.assertEqual(by_id[thought["id"]]["version"], 2, "The real release commits every selected thought once")
        self.assertEqual(by_id[untouched["id"]]["version"], 1)
        self.assertEqual((by_id[untouched["id"]]["x"], by_id[untouched["id"]]["y"]), (untouched["x"], untouched["y"]))

    async def test_19_successive_peer_previews_keep_content_but_native_edits_refresh_it(self):
        ada, kai = self.pages['ada'], self.pages['kai']
        # Observe production React commits without replacing transport or mutating the DOM.
        # The moving button must render; its memoized text subtree must keep its fiber.
        await kai.add_init_script("""(() => {
          const seen = {shell: new Map(), content: new Map()};
          window.__thoughtRenders = {shell: {}, content: {}};
          window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {supportsFiber: true, isDisabled: false, renderers: new Map(), inject() {return 1;},
            checkDCE() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
            onCommitFiberRoot(_id, root) {
              const stack = [{fiber: root.current, id: null}];
              while (stack.length) {
                const {fiber, id: parentId} = stack.pop(), props = fiber.memoizedProps;
                const shell = fiber.type === 'button' && props?.['data-id'] && String(props.className).startsWith('sk-node');
                const id = shell ? props['data-id'] : parentId;
                const content = id && fiber.type === 'span' && String(props?.className).split(' ').includes('sk-t');
                const kind = shell ? 'shell' : content ? 'content' : null;
                if (kind) {
                  if (seen[kind].has(id) && seen[kind].get(id) !== fiber)
                    window.__thoughtRenders[kind][id] = (window.__thoughtRenders[kind][id] || 0) + 1;
                  seen[kind].set(id, fiber);
                }
                if (fiber.sibling) stack.push({fiber: fiber.sibling, id: parentId});
                if (fiber.child) stack.push({fiber: fiber.child, id});
              }
            }};
        })()""")
        await self.create_map(3)
        first, second = self.thoughts[:2]
        node = ada.locator(f'.sk-node[data-id="{first["id"]}"]')
        peer = kai.locator(f'.sk-node[data-id="{first["id"]}"]')
        bounds = await node.bounding_box()
        try:
            await ada.mouse.move(bounds['x'] + 20, bounds['y'] + 20)
            await ada.mouse.down()
            await ada.mouse.move(bounds['x'] + 60, bounds['y'] + 40, steps=3)
            await expect(peer).to_have_attribute('data-live-mover', 'Ada North')
            sequence = await ada.locator('.sk-canvas').get_attribute('data-live-own-sequence')
            await expect(peer).to_have_attribute('data-live-preview-sequence', sequence)
            before = await kai.evaluate('window.__thoughtRenders')
            initial_x = await peer.get_attribute('data-thought-x')
            for step in range(1, 9):
                previous = await peer.get_attribute('data-live-preview-sequence')
                await ada.mouse.move(bounds['x'] + 60 + step * 6, bounds['y'] + 40 + step * 3)
                await expect(peer).not_to_have_attribute('data-live-preview-sequence', previous)
            after = await kai.evaluate('window.__thoughtRenders')
            self.assertGreaterEqual(after['shell'].get(first['id'], 0) - before['shell'].get(first['id'], 0), 8,
                                    'The observer sees each real movement update render its current geometry/sequence')
            self.assertEqual(after['content'].get(first['id'], 0), before['content'].get(first['id'], 0),
                             'Successive actual movement previews do not render unchanged content')
            await expect(peer).not_to_have_attribute('data-thought-x', initial_x)

            # A real native edit to a neighbour remains visible while the original lease moves.
            changed = await self.api(kai, 'PATCH', f'/api/v1/sketches/{self.map_id}/thoughts/{second["id"]}',
                {'text': 'Native neighbour edit during movement'}, 200,
                {'idempotency-key': str(uuid.uuid4()), 'if-match': f'"{second["version"]}"'})
            for page in self.pages.values():
                await expect(page.locator(f'.sk-node[data-id="{second["id"]}"] .sk-t')).to_have_text(changed['text'])
            self.assertGreater((await kai.evaluate('window.__thoughtRenders'))['content'].get(second['id'], 0),
                               before['content'].get(second['id'], 0), 'The content observer detects native edits')
            previous = await peer.get_attribute('data-live-preview-sequence')
            await ada.mouse.move(bounds['x'] + 130, bounds['y'] + 75)
            await expect(peer).not_to_have_attribute('data-live-preview-sequence', previous)
            await expect(peer).to_have_attribute('data-live-mover', 'Ada North')

            # Editing the moving thought clears its old lease and refreshes its own content.
            changed = await self.api(kai, 'PATCH', f'/api/v1/sketches/{self.map_id}/thoughts/{first["id"]}',
                {'text': 'Native edit replaces the moving thought body', 'height': first['height'] + 160}, 200,
                {'idempotency-key': str(uuid.uuid4()), 'if-match': f'"{first["version"]}"'})
            for page in self.pages.values():
                target = page.locator(f'.sk-node[data-id="{first["id"]}"]')
                await expect(target.locator('.sk-t')).to_have_text(changed['text'])
                await expect(target).to_have_attribute('data-thought-version', str(changed['version']))
                await expect(target).not_to_have_attribute('data-live-mover', 'Ada North')
                self.assertEqual(await target.evaluate('el => el.style.minHeight'), f'{changed["height"]}px')
            self.assertGreater((await kai.evaluate('window.__thoughtRenders'))['content'].get(first['id'], 0),
                               after['content'].get(first['id'], 0))
        finally:
            await ada.mouse.up()

        # Stable input callbacks must use the new native dimensions/version, not their
        # pre-preview thought. Check persisted real keyboard and pointer resize paths.
        await peer.click()
        await peer.press('Alt+ArrowDown')
        await expect(peer).to_have_attribute('data-thought-version', str(changed['version'] + 1))
        await self.map_saved(kai)
        graph = await self.api(kai, 'GET', f'/api/v1/sketches/{self.map_id}')
        keyboard = next(item for item in graph['thoughts'] if item['id'] == first['id'])
        self.assertEqual((keyboard['width'], keyboard['height']), (changed['width'], changed['height'] + 12))
        self.assertEqual((keyboard['text'], keyboard['x'], keyboard['y']),
                         (changed['text'], changed['x'], changed['y']))

        self.assertEqual(await peer.evaluate('el => el.offsetHeight'), keyboard['height'],
                         'The fresh native height exceeds intrinsic content before exact pointer resizing')
        bounds = await peer.bounding_box()
        zoom = bounds['width'] / keyboard['width']
        handle = await peer.locator('.sk-resize').bounding_box()
        self.assertIsNotNone(handle)
        try:
            await kai.mouse.move(handle['x'] + handle['width'] / 2, handle['y'] + handle['height'] / 2)
            await kai.mouse.down()
            await kai.mouse.move(handle['x'] + handle['width'] / 2 + 48 * zoom,
                                 handle['y'] + handle['height'] / 2 + 24 * zoom, steps=4)
        finally:
            await kai.mouse.up()
        await expect(peer).to_have_attribute('data-thought-version', str(keyboard['version'] + 1))
        await self.map_saved(kai)
        graph = await self.api(kai, 'GET', f'/api/v1/sketches/{self.map_id}')
        pointer = next(item for item in graph['thoughts'] if item['id'] == first['id'])
        self.assertEqual((pointer['width'], pointer['height']), (keyboard['width'] + 48, keyboard['height'] + 24))
        self.assertEqual((pointer['text'], pointer['x'], pointer['y']),
                         (changed['text'], changed['x'], changed['y']))
        await expect(node).to_have_attribute('data-thought-version', str(pointer['version']))

        await peer.press('Enter')
        editor = kai.get_by_label('Thought text', exact=True)
        await expect(editor).to_be_focused()
        await expect(editor).to_have_value(pointer['text'])
        await editor.fill('Unsaved text after fresh native resize')
        await editor.press('Escape')
        await expect(editor).to_have_count(0)
        await expect(peer.locator('.sk-t')).to_have_text(pointer['text'])
        graph = await self.api(kai, 'GET', f'/api/v1/sketches/{self.map_id}')
        cancelled = next(item for item in graph['thoughts'] if item['id'] == first['id'])
        self.assertEqual(cancelled, pointer, 'Escape after Enter keeps the exact current native thought/version')
        print('CURRENT_NODE_INPUT_CONTROL', {'native': changed, 'keyboard': keyboard,
              'pointer': pointer, 'cancelled_version': cancelled['version']}, flush=True)

    async def test_20_map_input_identity_matches_locator_and_refuses_invalid_canvas(self):
        ada, kai = self.pages['ada'], self.pages['kai']
        legacy = "el => ({gestureId:el.dataset.liveOwnGesture,generation:el.dataset.liveGeneration,sequence:Number(el.dataset.liveOwnSequence),visibility:document.visibilityState})"
        previous = None
        # Real navigation replaces the whole map/canvas. Each new gesture and each
        # successive trusted input must be read from the current authorized editor.
        for _ in range(2):
            await self.create_map(2)
            thought = self.thoughts[0]
            node = ada.locator(f'.sk-node[data-id="{thought["id"]}"]')
            peer = kai.locator(f'.sk-node[data-id="{thought["id"]}"]')
            bounds = await node.bounding_box()
            try:
                await ada.mouse.move(bounds['x'] + 20, bounds['y'] + 20)
                await ada.mouse.down()
                await ada.mouse.move(bounds['x'] + 65, bounds['y'] + 45, steps=3)
                await expect(peer).to_have_attribute('data-live-mover', 'Ada North')
                first = await map_input_identity(ada)
                self.assertEqual(first, await ada.locator('.sk-canvas').evaluate(legacy))
                self.assertEqual(first['visibility'], 'visible')
                self.assertGreater(first['sequence'], 0)
                self.assertEqual(str(uuid.UUID(first['gestureId'])), first['gestureId'])
                self.assertEqual(str(uuid.UUID(first['generation'])), first['generation'])
                if previous:
                    self.assertNotEqual(first['generation'], previous['generation'], 'A replacement map has its current generation')
                    self.assertNotEqual(first['gestureId'], previous['gestureId'], 'No gesture from the previous canvas is reused')
                await ada.mouse.move(bounds['x'] + 85, bounds['y'] + 55)
                current = await map_input_identity(ada)
                self.assertGreater(current['sequence'], first['sequence'], 'A fresh read sees the next actual pointer input')
                self.assertEqual(current, await ada.locator('.sk-canvas').evaluate(legacy))
                await expect(peer).to_have_attribute('data-live-preview-sequence', str(current['sequence']))
                previous = current
            finally:
                await ada.mouse.up()
            await self.map_saved(ada)

        # Invalid-DOM calibration only: duplicate the real canvas shell, without
        # creating an editor or replacing transport. Both strict reads must refuse it.
        duplicate = await ada.locator('.sk-canvas').evaluate_handle("el => {const copy=el.cloneNode(false);el.parentElement.append(copy);return copy;}")
        try:
            with self.assertRaisesRegex(Error, 'exactly one connected current map canvas'):
                await map_input_identity(ada)
            with self.assertRaisesRegex(Error, 'strict mode violation'):
                await ada.locator('.sk-canvas').evaluate(legacy)
        finally:
            await duplicate.evaluate('el => el.remove()')
            await duplicate.dispose()
        # Actual navigation removes the map, rather than supplying a stale cached canvas.
        await ada.goto('/')
        with self.assertRaisesRegex(Error, 'exactly one connected current map canvas'):
            await map_input_identity(ada)

    async def test_17_ctrl_end_then_shift_left_replaces_the_last_character_of_a_100k_line(self):
        # #228 Gate 4: CodeMirror draws a line longer than 20,000 characters only around the view
        # and the selection. Native Ctrl+End from the middle stopped at undrawn text, so Shift+
        # ArrowLeft selected nothing and the typed character was added; at the 100,000-character
        # limit it was refused and the input lost (the driver's first local-control sample).
        await self.create_doc("A" * 99_999 + "B")
        ada = self.pages["ada"]
        field = await self.editor("ada")
        await field.click()  # In the middle of the one long line, far from its end.
        await ada.keyboard.press("Control+End")
        await ada.keyboard.press("Shift+ArrowLeft")
        await ada.keyboard.insert_text("x")
        editor = ada.locator("[data-live-wiki-editor]")
        await expect(editor).to_have_attribute("data-live-input-revision", "1", timeout=3000)
        await expect(ada.get_by_role("status").filter(has_text="All changes shared")).to_be_visible()
        self.assertEqual(await ada.get_by_role("alert").count(), 0, "No input was refused")
        last = await ada.evaluate("""() => {
          const walker = document.createTreeWalker(document.querySelector('.cm-content'), NodeFilter.SHOW_TEXT);
          let last = '', node; while ((node = walker.nextNode())) if (node.data.trim() && !node.parentElement.closest('.editing-caret')) last = node.data;
          return last.trimEnd().slice(-2);
        }""")
        self.assertEqual(last, "Ax", "The typed character replaced the selected last one")
        # The extending variant selects from the start to the end of the text, undrawn parts included.
        await ada.keyboard.press("Control+Home")
        await ada.keyboard.press("Control+Shift+End")
        await ada.keyboard.insert_text("y")
        await expect(editor).to_have_attribute("data-live-input-revision", "2", timeout=3000)
        await ada.wait_for_function("() => document.querySelector('.cm-content').textContent === 'y'", timeout=3000)
        self.assertEqual(await ada.get_by_role("alert").count(), 0, "No input was refused")

    async def test_18_a_move_by_one_character_in_drawn_text_stays_with_the_browser(self):
        # #228 Gate 4: moving by a character from the editor state put a keyboard selection into
        # the shared cursor at once. The typed character that replaced it came a few milliseconds
        # later, so the selection now and then reached the 40 ms cursor tick and the other person
        # saw the caret one character early (one lost sample in each editor case at 55ba59cf).
        # In drawn text the browser moves the caret, as before; test_17 covers undrawn text.
        await self.create_doc("Field note ends here")
        ada = self.pages["ada"]
        field = await self.editor("ada")
        await field.click()
        await ada.evaluate("""() => { window.__arrows = [];
          window.addEventListener('keydown', (event) => { if (/^(Arrow|Home|End)/.test(event.key)) window.__arrows.push([event.key, event.shiftKey, event.defaultPrevented]); }); }""")
        await ada.keyboard.press("Control+End")
        for key in ("Shift+ArrowLeft", "ArrowRight", "ArrowLeft", "Shift+ArrowRight"):
            await ada.keyboard.press(key)
        await ada.keyboard.insert_text("E")
        await expect(ada.get_by_role("status").filter(has_text="All changes shared")).to_be_visible()
        arrows = await ada.evaluate("window.__arrows")
        # Control: the document end is still the editor's own move, which the probe sees.
        self.assertEqual(arrows[0], ["End", False, True], arrows)
        self.assertEqual([prevented for _, _, prevented in arrows[1:]], [False] * 4, arrows)
        text = await ada.evaluate("() => document.querySelector('.cm-content').textContent")
        self.assertEqual(text, "Field note ends herE", "The browser's selection was replaced")
