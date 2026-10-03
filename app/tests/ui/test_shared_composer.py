"""Authenticated Files/drafts integration (#154/#136), against the real Compose application.

Two people use one task through Agents, Conversation and Tasks/Map Details. Faults deliberately
hold or lose network acknowledgements; assertions compare durable API identity and exact bytes.
"""
from __future__ import annotations

import json
import re
import time
import unittest
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

from playwright.sync_api import expect, sync_playwright
from test_app_shell import ORIGIN, UPSTREAM, shot, start_forwarder

STAMP = int(time.time() * 1000)
PASSWORD = "the same thread keeps exact private files"
PEOPLE = {
    "owner": ("Ada Kowalska", f"ada.shared+{STAMP}@example.test"),
    "writer": ("Jonas Berg", f"jonas.shared+{STAMP}@example.test"),
}


class SharedComposerJourney(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=10000)
        cls.states = {}
        cls.people = {}
        for who, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"name": name, "email": email, "password": PASSWORD}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.people[who] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[who] = context.storage_state()
            context.close()
        context = cls.browser.new_context(base_url=ORIGIN, storage_state=cls.states["owner"])
        ws = context.request.post("/api/v1/workspaces", data={"name": "Exact bytes workshop"}, headers={"origin": ORIGIN}).json()
        response = context.request.post(f"/api/v1/workspaces/{ws['id']}/members", data={"email": PEOPLE["writer"][1], "role": "member"}, headers={"origin": ORIGIN})
        assert response.status == 201, response.text()
        cls.workspace = ws["id"]
        context.close()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def page(self, who="owner", *, width=1440, storage_refused=False):
        context = self.browser.new_context(base_url=ORIGIN, storage_state=self.states[who], viewport={"width": width, "height": 900 if width == 1440 else 844},
                                           is_mobile=width < 681, has_touch=width < 681, locale="en-GB", reduced_motion="reduce")
        self.addCleanup(context.close)
        if storage_refused:
            context.add_init_script("Storage.prototype.setItem = function() { throw new DOMException('Refused', 'QuotaExceededError'); }")
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page, method, path, body=None, status=200):
        response = page.request.fetch(path, method=method, headers={"origin": ORIGIN}, data=body)
        self.assertEqual(response.status, status, response.text())
        return response.json() if response.text() else None

    def scene(self, page):
        project = self.api(page, "POST", f"/api/v1/workspaces/{self.workspace}/projects", {"name": f"Night lamp {uuid.uuid4().hex[:6]}", "visibility": "restricted"}, 201)
        self.api(page, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "human", "id": self.people['writer']}, "role": "contributor"}, 201)
        tasks = [self.api(page, "POST", f"/api/v1/projects/{project['id']}/work", {"title": title}, 201) for title in ("Measure the lamp after dark", "Review the sensor wiring")]
        material = self.api(page, "POST", f"/api/v1/projects/{project['id']}/materials", {"title": "Verified measurements", "body": "38% gestures at 5 lux", "clientMutationId": str(uuid.uuid4())}, 201)
        return project, tasks[0], tasks[1], material

    def open_agents(self, page, project, task):
        page.goto(f"/projects/{project['id']}/agents?task={task['id']}")
        expect(page.get_by_label("Write to this task")).to_be_enabled()

    def choose(self, page, files, container=None):
        target = container or page
        with page.expect_file_chooser() as chooser:
            target.get_by_role("button", name="Attach files", exact=True).click()
        chooser.value.set_files(files)

    def file(self, name="measurements.bin", content=b"\x00\xff\x04\n\x80 exact bytes"):
        return {"name": name, "mimeType": "application/octet-stream", "buffer": content}

    def discussion(self, page, task):
        return self.api(page, "GET", f"/api/v1/work/{task['id']}/discussion")

    def record(self, page, project, task, who="owner"):
        key = f"flux:composer:{self.people[who]}:{project['id']}:task:{task['id']}"
        return page.evaluate("key => JSON.parse(localStorage.getItem(key))", key)

    def root(self, page, task, body="Start with actual measurements"):
        return self.api(page, "POST", f"/api/v1/work/{task['id']}/discussion", {"body": body, "clientMessageId": str(uuid.uuid4()), "kind": "text"}, 201)

    def cite(self, page, project, conversation):
        page.goto(f"/projects/{project['id']}/conversations/{conversation}")
        pane = page.get_by_role("complementary", name="Replies")
        pane.get_by_role("button", name=re.compile("^Sources")).click()
        pane.get_by_role("button", name="Discuss this version").click()
        return pane

    def test_01_file_only_first_root_and_reply_keep_authors_order_and_exact_downloads(self):
        owner = self.page()
        project, a, _, _ = self.scene(owner)
        writer = self.page("writer")
        self.open_agents(owner, project, a)
        first = self.file("01-měřeni.bin")
        second = self.file("02-sensor.txt", b"negative result\r\nno fake caption")
        self.choose(owner, [first, second])
        expect(owner.get_by_text("Ready, private", exact=False)).to_have_count(2)
        staged = self.record(owner, project, a)["files"]
        for item in staged:
            self.assertEqual(writer.request.get(f"/api/v1/files/{item['staged']['id']}").status, 404, "private staging belongs only to uploader")
        owner.get_by_role("button", name="Send to task").click()
        expect(owner.get_by_role("list", name="Files in your draft")).to_have_count(0)
        discussion = self.discussion(owner, a)
        root = discussion["root"]
        self.assertEqual(root["body"], "")
        self.assertEqual(root["authorId"], self.people["owner"])
        self.assertEqual([item["name"] for item in root["files"]], [first["name"], second["name"]])
        self.open_agents(writer, project, a)
        self.choose(writer, [self.file("reply.bin", b"\x01\x02 independently measured")])
        expect(writer.get_by_text("Ready, private", exact=False)).to_have_count(1)
        writer.get_by_role("button", name="Send to task").click()
        expect(writer.get_by_role("list", name="Files in your draft")).to_have_count(0)
        discussion = self.discussion(owner, a)
        reply = discussion["messages"][1]
        self.assertEqual(reply["body"], "")
        self.assertEqual(reply["authorId"], self.people["writer"])
        self.assertEqual(reply["conversationId"], root["conversationId"])
        roots = self.api(owner, "GET", f"/api/v1/projects/{project['id']}/conversation-roots")
        self.assertEqual(next(item["message"] for item in roots["roots"] if item["conversationId"] == root["conversationId"]), root)
        for item, fixture in zip(root["files"], [first, second]):
            download = writer.request.get(f"/api/v1/files/{item['id']}")
            self.assertEqual(download.status, 200)
            self.assertEqual(download.body(), fixture["buffer"])
        writer.goto(f"/projects/{project['id']}/conversations/{root['conversationId']}")
        pane = writer.get_by_role("complementary", name="Replies")
        expect(pane.get_by_role("list", name="Attached files").first.get_by_role("link")).to_have_count(2)
        expect(pane.get_by_role("link", name=re.compile("reply.bin"))).to_be_visible()
        with writer.expect_download() as downloaded:
            pane.get_by_role("link", name=re.compile("01-měřeni.bin")).click()
        self.assertEqual(Path(downloaded.value.path()).read_bytes(), first["buffer"])
        shot(writer, "shared-files-desktop-1440")

    def test_02_lost_response_retries_the_same_task_uuid_from_conversation_and_details(self):
        page = self.page()
        project, a, _, material = self.scene(page)
        root = self.root(page, a)
        pane = self.cite(page, project, root["conversationId"])
        pane.get_by_label("Reply", exact=True).fill("Shared command keeps this reference and attachment")
        self.choose(page, [self.file()], pane)
        expect(pane.get_by_text("Ready, private", exact=False)).to_have_count(1)
        page.get_by_role("navigation", name="Project views").get_by_role("link", name=re.compile("^Agents")).click()
        page.get_by_label("Task", exact=True).select_option(a["id"])
        expect(page.get_by_label("Write to this task")).to_have_value("Shared command keeps this reference and attachment")
        lost = []
        path = f"**/api/v1/work/{a['id']}/discussion"
        def lose(route):
            if route.request.method == "POST" and not lost:
                response = route.fetch()
                self.assertEqual(response.status, 201)
                lost.append(route.request.post_data_json)
                route.fulfill(status=503, body="{}")
            else:
                route.continue_()
        page.route(path, lose)
        page.get_by_role("button", name="Send to task").click()
        expect(page.get_by_role("alert")).to_contain_text("Could not confirm")
        page.reload()
        expect(page.get_by_label("Write to this task")).to_have_value(lost[0]["body"])
        expect(page.get_by_text("Source: Verified measurements · v1")).to_be_visible()
        page.get_by_role("link", name="Open in Conversation", exact=True).click()
        pane = page.get_by_role("complementary", name="Replies")
        expect(pane.get_by_label("Reply", exact=True)).to_have_value(lost[0]["body"])
        retries = []
        page.on("request", lambda request: retries.append(request.post_data_json) if request.method == "POST" and request.url.endswith(f"/work/{a['id']}/discussion") else None)
        pane.get_by_role("button", name="Send reply").click()
        expect(pane.get_by_label("Reply", exact=True)).to_have_value("")
        self.assertEqual(retries[-1], lost[0], "same operation, task, UUID, text, references and ordered files")
        discussion = self.discussion(page, a)
        matching = [item for item in discussion["messages"] if item["body"] == lost[0]["body"]]
        self.assertEqual(len(matching), 1)
        self.assertEqual(matching[0]["source"], {"materialId": material["materialId"], "version": 1})
        page.goto(f"/projects/{project['id']}/tasks?open=work:{a['id']}")
        details = page.get_by_role("region", name="Discussion")
        expect(details.get_by_label("Write to this task")).to_have_value("")
        details.get_by_label("Write to this task").fill("A reply from the Tasks details")
        details.get_by_role("button", name="Send to task").click()
        expect(page.get_by_role("complementary", name="Replies").get_by_text("A reply from the Tasks details", exact=True)).to_be_visible()
        self.assertEqual(self.discussion(page, a)["messages"][-1]["body"], "A reply from the Tasks details")

    def test_03_failed_upload_size_count_and_total_keep_text_existing_files_and_reference(self):
        page = self.page()
        project, a, _, _ = self.scene(page)
        root = self.root(page, a)
        pane = self.cite(page, project, root["conversationId"])
        pane.get_by_label("Reply", exact=True).fill("Keep the careful comparison")
        self.choose(page, [self.file("ready.bin")], pane)
        expect(pane.get_by_text("Ready, private", exact=False)).to_have_count(1)
        def fail_upload(route):
            route.fulfill(status=409, content_type="application/json", body=json.dumps({"code": "UPLOAD_CONFLICT", "message": "Different bytes for the same upload"}))
        page.route("**/api/v1/projects/*/files?*", fail_upload)
        self.choose(page, [self.file("conflict.bin")], pane)
        expect(pane.get_by_role("alert")).to_contain_text("Upload conflicts")
        page.unroute("**/api/v1/projects/*/files?*", fail_upload)
        pane.get_by_role("button", name="Remove conflict.bin").click()
        self.choose(page, [self.file("oversize.bin", b"x" * (5 * 1024 * 1024 + 1))], pane)
        expect(pane.get_by_role("alert")).to_contain_text("at most 5 MiB")
        pane.get_by_role("button", name="Remove oversize.bin").click()
        self.choose(page, [self.file(f"count-{index}.bin") for index in range(10)], pane)
        expect(pane.get_by_role("alert")).to_contain_text("at most 10 files")
        self.choose(page, [self.file(f"large-{index}.bin", b"x" * (5 * 1024 * 1024)) for index in range(4)], pane)
        expect(pane.get_by_role("alert")).to_contain_text("20 MiB")
        expect(pane.get_by_label("Reply", exact=True)).to_have_value("Keep the careful comparison")
        expect(pane.get_by_text("Source: Verified measurements · v1")).to_be_visible()
        record = self.record(page, project, a)
        self.assertEqual(len(record["files"]), 1)
        self.assertEqual(len(record["references"]), 1)
        page.reload()
        expect(page.get_by_role("complementary", name="Replies").get_by_label("Reply", exact=True)).to_have_value(record["body"])

    def test_04_held_upload_and_send_a_b_a_never_clear_or_navigate_b(self):
        page = self.page()
        project, a, b, _ = self.scene(page)
        self.root(page, a)
        self.root(page, b)
        self.open_agents(page, project, a)
        held = []
        def hold(route):
            if not held:
                held.append((route, route.fetch()))
            else:
                route.continue_()
        page.route("**/api/v1/projects/*/files?*", hold)
        page.get_by_label("Write to this task").fill("A's held private bytes")
        self.choose(page, [self.file("held-a.bin")])
        expect(page.get_by_text("Uploading…", exact=False)).to_have_count(1)
        page.get_by_label("Task", exact=True).select_option(b["id"])
        page.get_by_label("Write to this task").fill("B's distinct draft")
        held[0][0].fulfill(response=held[0][1])
        expect(page.get_by_label("Write to this task")).to_have_value("B's distinct draft")
        expect(page.get_by_text("held-a.bin", exact=False)).to_have_count(0)
        page.get_by_label("Task", exact=True).select_option(a["id"])
        expect(page.get_by_label("Write to this task")).to_have_value("A's held private bytes")
        expect(page.get_by_text("Ready, private", exact=False)).to_have_count(1)
        pending = []
        def hold_send(route):
            if route.request.method == "POST" and not pending:
                pending.append((route, route.fetch()))
            else:
                route.continue_()
        page.route(f"**/api/v1/work/{a['id']}/discussion", hold_send)
        page.get_by_role("button", name="Send to task").click()
        page.get_by_label("Task", exact=True).select_option(b["id"])
        expect(page.get_by_label("Write to this task")).to_have_value("B's distinct draft")
        page.get_by_label("Task", exact=True).select_option(a["id"])
        expect(page.get_by_label("Write to this task")).to_have_value("A's held private bytes")
        pending[0][0].fulfill(response=pending[0][1])
        expect(page.get_by_label("Write to this task")).to_have_value("")
        expect(page.get_by_label("Task", exact=True)).to_have_value(a["id"])
        page.get_by_label("Task", exact=True).select_option(b["id"])
        expect(page.get_by_label("Write to this task")).to_have_value("B's distinct draft")
        self.assertEqual(len([m for m in self.discussion(page, a)["messages"] if m["body"] == "A's held private bytes"]), 1)

    def test_05_storage_refusal_retains_the_newest_visit_copy_and_source_across_views(self):
        page = self.page(storage_refused=True)
        project, a, b, _ = self.scene(page)
        root = self.root(page, a)
        pane = self.cite(page, project, root["conversationId"])
        pane.get_by_label("Reply", exact=True).fill("Newest memory copy")
        self.choose(page, [self.file()], pane)
        expect(pane.get_by_text("Ready, private", exact=False)).to_have_count(1)
        expect(pane.get_by_text("This browser refused draft storage", exact=False)).to_be_visible()
        tabs = page.get_by_role("navigation", name="Project views")
        tabs.get_by_role("link", name=re.compile("^Agents")).click()
        page.get_by_label("Task", exact=True).select_option(a["id"])
        expect(page.get_by_label("Write to this task")).to_have_value("Newest memory copy")
        page.get_by_label("Write to this task").fill("The newest second edit")
        page.get_by_label("Task", exact=True).select_option(b["id"])
        page.get_by_label("Write to this task").fill("B stays separate")
        page.get_by_label("Task", exact=True).select_option(a["id"])
        expect(page.get_by_label("Write to this task")).to_have_value("The newest second edit")
        expect(page.get_by_text("Source: Verified measurements · v1")).to_be_visible()
        expect(page.get_by_text("Ready, private", exact=False)).to_have_count(1)

    def test_06_interrupted_upload_reselects_same_bytes_and_uuid_after_reload(self):
        page = self.page()
        project, a, _, _ = self.scene(page)
        self.open_agents(page, project, a)
        lost = []
        def lose(route):
            lost.append(route.request.url)
            response = route.fetch()
            self.assertEqual(response.status, 201)
            route.fulfill(status=503, content_type="application/json", body="{}")
        page.route("**/api/v1/projects/*/files?*", lose)
        page.get_by_label("Write to this task").fill("Recover the unconfirmed private upload")
        self.choose(page, [self.file("uncertain.bin")])
        expect(page.get_by_role("alert")).to_be_visible()
        page.unroute("**/api/v1/projects/*/files?*", lose)
        before = self.record(page, project, a)
        page.reload()
        expect(page.get_by_label("Write to this task")).to_have_value(before["body"])
        # A real same-size, different-byte replay conflicts at the server and keeps its upload identity.
        with page.expect_file_chooser() as chooser:
            page.get_by_role("button", name="Retry upload").click()
        chooser.value.set_files(self.file("uncertain.bin", b"x" * len(self.file()["buffer"])))
        expect(page.get_by_role("alert")).to_contain_text("Upload conflicts")
        conflicted = self.record(page, project, a)
        self.assertEqual(conflicted["body"], before["body"])
        self.assertEqual(conflicted["files"][0]["uploadId"], before["files"][0]["uploadId"])
        page.reload()
        with page.expect_file_chooser() as chooser:
            page.get_by_role("button", name="Retry upload").click()
        chooser.value.set_files(self.file("uncertain.bin"))
        expect(page.get_by_text("Ready, private", exact=False)).to_have_count(1)
        after = self.record(page, project, a)
        self.assertEqual(before["files"][0]["uploadId"], after["files"][0]["uploadId"])
        self.assertEqual(after["files"][0]["staged"]["uploadId"], before["files"][0]["uploadId"])
        page.get_by_role("button", name="Send to task").click()
        expect(page.get_by_label("Write to this task")).to_have_value("")
        self.assertEqual(self.discussion(page, a)["root"]["files"][0]["id"], after["files"][0]["staged"]["id"])

    def test_07_account_project_and_private_helper_scopes_preserve_public_drafts(self):
        page = self.page()
        project, a, _, _ = self.scene(page)
        other, other_a, _, _ = self.scene(page)
        root = self.root(page, a)
        pane = self.cite(page, project, root["conversationId"])
        pane.get_by_label("Reply", exact=True).fill("Public task draft stays public only on send")
        self.choose(page, [self.file("public-on-send.bin")], pane)
        expect(pane.get_by_text("Ready, private", exact=False)).to_have_count(1)
        pane.get_by_role("button", name="Ask my assistant").click()
        expect(pane.get_by_label("Ask your assistant", exact=True)).to_have_value("")
        pane.get_by_label("Ask your assistant", exact=True).fill("Private prompt never becomes the task root")
        pane.get_by_role("button", name="Ask my assistant").click()
        expect(pane.get_by_label("Reply", exact=True)).to_have_value("Public task draft stays public only on send")
        self.open_agents(page, other, other_a)
        expect(page.get_by_label("Write to this task")).to_have_value("")
        page.get_by_label("Write to this task").fill("Other project draft")
        self.open_agents(page, project, a)
        expect(page.get_by_label("Write to this task")).to_have_value("Public task draft stays public only on send")
        page.context.clear_cookies()
        page.context.add_cookies(self.states["writer"]["cookies"])
        self.open_agents(page, project, a)
        expect(page.get_by_label("Write to this task")).to_have_value("")
        expect(page.get_by_role("list", name="Files in your draft")).to_have_count(0)
        self.assertEqual(len(self.discussion(page, a)["messages"]), 1, "private prompt and draft navigation write no contribution")

    def test_08_phone_keyboard_touch_and_reduced_motion_keep_files_and_focus_usable(self):
        for width in (320, 390, 1440):
            with self.subTest(width=width):
                page = self.page(width=width)
                project, a, _, _ = self.scene(page)
                self.open_agents(page, project, a)
                box = page.get_by_label("Write to this task")
                box.fill("The phone keeps this careful night measurement")
                box.press("Shift+Enter")
                self.assertIn("\n", box.input_value())
                self.choose(page, [self.file("a-very-long-readable-measurement-name-after-the-sensor-failed-in-the-dark.bin")])
                expect(page.get_by_text("Ready, private", exact=False)).to_have_count(1)
                page.get_by_role("button", name="Attach files", exact=True).focus()
                self.assertTrue(page.get_by_role("button", name="Attach files", exact=True).evaluate("el => el === document.activeElement"))
                if width < 681:
                    size = page.get_by_role("button", name="Attach files", exact=True).bounding_box()
                    self.assertGreaterEqual(size["height"], 44)
                self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), width)
                self.assertTrue(page.evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"))
                shot(page, f"shared-draft-{width}")
                box.press("Enter")
                expect(box).to_have_value("")
                expect(box).to_be_focused()
                discussion = self.discussion(page, a)
                page.goto(f"/projects/{project['id']}/conversations/{discussion['conversationId']}")
                pane = page.get_by_role("complementary", name="Replies")
                expect(pane.get_by_role("link", name=re.compile("a-very-long"))).to_be_visible()
                pane.get_by_role("button", name="Close replies").focus()
                pane.get_by_role("button", name="Close replies").press("Enter")
                expect(pane).to_have_count(0)
                self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), width)
                shot(page, f"shared-published-{width}")

    def test_09_real_revocation_during_upload_and_send_keeps_the_complete_draft(self):
        owner, writer = self.page(), self.page("writer")
        project, a, _, _ = self.scene(owner)
        root = self.root(owner, a)
        pane = self.cite(writer, project, root["conversationId"])
        pane.get_by_label("Reply", exact=True).fill("Retain the revoked writer's careful comparison")
        self.choose(writer, [self.file("retained.bin")], pane)
        expect(pane.get_by_text("Ready, private", exact=False)).to_have_count(1)
        before = self.record(writer, project, a, "writer")
        def access(role):
            self.api(owner, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "human", "id": self.people['writer']}, "role": role}, 201)
        def revoke_upload(route):
            access("denied")
            response = route.fetch()
            self.assertEqual(response.status, 404)
            route.fulfill(response=response)
        writer.route("**/api/v1/projects/*/files?*", revoke_upload)
        self.choose(writer, [self.file("revoked.bin")], pane)
        key = f"flux:composer:{self.people['writer']}:{project['id']}:task:{a['id']}"
        writer.wait_for_function("key => JSON.parse(localStorage.getItem(key)).files.some(file => file.name === 'revoked.bin' && file.state === 'failed')", arg=key)
        writer.unroute("**/api/v1/projects/*/files?*", revoke_upload)
        access("contributor")
        self.open_agents(writer, project, a)
        expect(writer.get_by_role("alert")).to_contain_text("Upload unavailable")
        kept = self.record(writer, project, a, "writer")
        self.assertEqual(kept["body"], before["body"])
        self.assertEqual(kept["references"], before["references"])
        self.assertEqual(kept["files"][0], before["files"][0])
        writer.get_by_role("button", name="Remove revoked.bin").click()
        command_before = self.record(writer, project, a, "writer")
        def revoke_send(route):
            if route.request.method == "POST":
                access("denied")
                response = route.fetch()
                self.assertEqual(response.status, 404)
                route.fulfill(response=response)
            else:
                route.continue_()
        writer.route(f"**/api/v1/work/{a['id']}/discussion", revoke_send)
        with writer.expect_response(lambda response: response.request.method == "POST" and response.url.endswith(f"/work/{a['id']}/discussion")):
            writer.get_by_role("button", name="Send to task").click()
        writer.unroute(f"**/api/v1/work/{a['id']}/discussion", revoke_send)
        access("contributor")
        self.open_agents(writer, project, a)
        expect(writer.get_by_text("This send is unconfirmed. Retry sends the same command once.", exact=True)).to_be_visible()
        kept = self.record(writer, project, a, "writer")
        for field in ("body", "files", "references", "commandId"):
            self.assertEqual(kept[field], command_before[field])
        self.assertTrue(kept["unconfirmed"])
        self.assertEqual(len(self.discussion(owner, a)["messages"]), 1)
        writer.get_by_role("button", name="Send to task").click()
        expect(writer.get_by_label("Write to this task")).to_have_value("")
        self.assertEqual(self.discussion(owner, a)["messages"][-1]["authorId"], self.people["writer"])

    def test_10_map_details_and_unloaded_old_conversation_retry_one_task_command(self):
        page = self.page()
        project, _, _, _ = self.scene(page)
        sketch = self.api(page, "POST", f"/api/v1/workspaces/{self.workspace}/sketches", {"title": "Night measurement plan", "scope": "project", "projectId": project['id']}, 201)
        thought = self.api(page, "POST", f"/api/v1/sketches/{sketch['id']}/thoughts", {"text": "Measure the negative camera result", "x": 0, "y": 0}, 201)["thought"]
        page.goto(f"/projects/{project['id']}/map/{sketch['id']}")
        page.locator(f".sk-node[data-id='{thought['id']}']").click()
        with page.expect_response(lambda response: response.request.method == "POST" and response.url.endswith(f"/projects/{project['id']}/work")) as created:
            page.get_by_role("button", name="Create work from selected thoughts").click()
        task = created.value.json()
        details = page.get_by_role("region", name="Discussion")
        box = details.get_by_label("First message about this task")
        expect(box).to_be_enabled()
        box.fill("The Map-created task keeps this measurement file")
        self.choose(page, [self.file("map-measurement.bin")], details)
        expect(details.get_by_text("Ready, private", exact=False)).to_have_count(1)
        lost = []
        def lose(route):
            if route.request.method == "POST" and not lost:
                response = route.fetch()
                self.assertEqual(response.status, 201)
                lost.append(route.request.post_data_json)
                route.fulfill(status=503, content_type="application/json", body="{}")
            else:
                route.continue_()
        page.route(f"**/api/v1/work/{task['id']}/discussion", lose)
        details.get_by_role("button", name="Start the discussion").click()
        expect(details.get_by_role("alert")).to_contain_text("Could not confirm")
        discussion = self.discussion(page, task)
        self.api(page, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": "A newer unrelated root", "clientMessageId": str(uuid.uuid4())}, 201)
        # Return real bounded root pages, keeping the older seek in flight while its deep link sends.
        older = []
        first = []
        def bounded(route):
            parts = urlsplit(route.request.url)
            query = parse_qs(parts.query)
            if "before" in query:
                older.append(route)
            else:
                query["limit"] = ["1"]
                response = route.fetch(url=urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query, doseq=True), parts.fragment)))
                first.append(response.json())
                route.fulfill(response=response)
        page.route("**/api/v1/projects/*/conversation-roots*", bounded)
        page.goto(f"/projects/{project['id']}/conversations/{discussion['conversationId']}")
        pane = page.get_by_role("complementary", name="Replies")
        expect(pane.get_by_label("Reply", exact=True)).to_have_value(lost[0]["body"])
        self.assertTrue(first)
        self.assertNotIn(discussion["conversationId"], [root["conversationId"] for root in first[0]["roots"]])
        replay = []
        page.on("request", lambda request: replay.append(request.post_data_json) if request.method == "POST" and request.url.endswith(f"/work/{task['id']}/discussion") else None)
        pane.get_by_role("button", name="Send reply").click()
        expect(pane.get_by_label("Reply", exact=True)).to_have_value("")
        self.assertEqual(replay[-1], lost[0])
        self.assertEqual(len(self.discussion(page, task)["messages"]), 1)
        page.unroute("**/api/v1/projects/*/conversation-roots*", bounded)
        for route in older:
            route.continue_()

    def test_11_expired_staging_failure_keeps_metadata_until_explicit_reselection(self):
        # The API regression separately expires a real stored row. Here an expired-response fault
        # checks the browser's complete recovery record without adding a test-only app endpoint.
        page = self.page()
        project, a, _, _ = self.scene(page)
        root = self.root(page, a)
        pane = self.cite(page, project, root["conversationId"])
        pane.get_by_label("Reply", exact=True).fill("Keep this text and version through staging expiry")
        self.choose(page, [self.file("expired.bin")], pane)
        expect(pane.get_by_text("Ready, private", exact=False)).to_have_count(1)
        original = self.record(page, project, a)
        key = f"flux:composer:{self.people['owner']}:{project['id']}:task:{a['id']}"
        page.evaluate("key => { const value = JSON.parse(localStorage.getItem(key)); value.files[0].staged.expiresAt = '1970-01-01T00:00:00.000Z'; localStorage.setItem(key, JSON.stringify(value)); }", key)
        page.reload()
        pane = page.get_by_role("complementary", name="Replies")
        expect(pane.get_by_text("Staging expired; select this file again", exact=False)).to_be_visible()
        def expire(route):
            if route.request.method == "POST":
                route.fulfill(status=404, content_type="application/json", body=json.dumps({"code": "NOT_FOUND", "message": "Attachment unavailable"}))
            else:
                route.continue_()
        page.route(f"**/api/v1/work/{a['id']}/discussion", expire)
        pane.get_by_role("button", name="Send reply").click()
        expect(pane.get_by_role("alert")).to_contain_text("expired file")
        kept = self.record(page, project, a)
        for field in ("body", "references", "commandId"):
            self.assertEqual(kept[field], original[field])
        self.assertEqual(kept["files"][0]["staged"]["id"], original["files"][0]["staged"]["id"])
        page.unroute(f"**/api/v1/work/{a['id']}/discussion", expire)
        pane.get_by_role("button", name="Remove expired.bin").click()
        self.choose(page, [self.file("expired.bin")], pane)
        expect(pane.get_by_text("Ready, private", exact=False)).to_have_count(1)
        recovered = self.record(page, project, a)
        self.assertNotEqual(recovered["commandId"], original["commandId"])
        self.assertNotEqual(recovered["files"][0]["staged"]["id"], original["files"][0]["staged"]["id"])
        # A real conflicting durable receipt must not silently replace the browser's payload.
        self.api(page, "POST", f"/api/v1/work/{a['id']}/discussion", {"body": "An earlier command with different intent", "clientMessageId": recovered['commandId'], "kind": "text"}, 201)
        pane.get_by_role("button", name="Send reply").click()
        expect(pane.get_by_role("alert")).to_contain_text("conflicts with an earlier command")
        conflicted = self.record(page, project, a)
        for field in ("body", "files", "references", "commandId"):
            self.assertEqual(conflicted[field], recovered[field])
        pane.get_by_label("Reply", exact=True).fill(recovered['body'] + " · confirmed revised intent")
        pane.get_by_role("button", name="Send reply").click()
        expect(pane.get_by_label("Reply", exact=True)).to_have_value("")
        self.assertEqual(self.discussion(page, a)["messages"][-1]["source"], {"materialId": recovered['references'][0]['materialId'], "version": 1})
