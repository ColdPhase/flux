"""Authenticated Files/drafts integration (#154/#136), against the real Compose application.

Two people use one task through Conversation and Tasks/Map Details (a space has no Agents view, F-038). Faults deliberately
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
from create_window import submit_button
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
            context = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"name": name, "email": email, "password": PASSWORD}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.people[who] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[who] = context.storage_state()
            context.close()
        context = cls.browser.new_context(service_workers="block", base_url=ORIGIN, storage_state=cls.states["owner"])
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
        context = self.browser.new_context(service_workers="block", base_url=ORIGIN, storage_state=self.states[who], viewport={"width": width, "height": 900 if width == 1440 else 844},
                                           is_mobile=width < 681, has_touch=width <= 1024, locale="en-GB", reduced_motion="reduce")
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

    def enter_agents(self, page, project):
        """Moves to the project's Tasks in the same page visit. A space has no Agents view (F-036 AG-4, F-038); a task's thread, composer
        and requests are in the task's Details, which these tests use wherever they used the view."""
        page.evaluate("([url]) => { history.pushState({}, '', url); window.dispatchEvent(new PopStateEvent('popstate')); }", [f"/projects/{project['id']}/tasks"])

    def switch_to(self, page, project, task):
        """Moves to a task's Details in the same page visit (a task link does the same) without waiting for it to show."""
        # A history entry of its own (the router tells entries apart by their key), as a link would make.
        page.evaluate("""([url]) => { const idx = ((history.state && history.state.idx) || 0) + 1;
            history.pushState({ usr: null, key: Math.random().toString(36).slice(2), idx }, '', url); window.dispatchEvent(new PopStateEvent('popstate', { state: history.state })); }""",
                      [f"/projects/{project['id']}/tasks?open=work:{task['id']}"])

    def open_thread(self, page, project, task):
        """Opens a task's Details in the same page visit and waits for that task's, not the last one's."""
        self.switch_to(page, project, task)
        expect(page.locator("#details").get_by_role("heading", name=task["title"])).to_be_visible()
        expect(self.box(page)).to_be_visible()

    def open_agents(self, page, project, task):
        """Loads the page afresh with the task's Details open. A reload closes Details (the address's open flag is used once), so a test
        that reloads opens it again with this."""
        page.goto(f"/projects/{project['id']}/tasks?open=work:{task['id']}")
        expect(page.locator("#details").get_by_role("heading", name=task["title"])).to_be_visible()
        expect(self.box(page)).to_be_enabled()

    def box(self, scope):
        """The task's one composer in its Details: the first message of a task nobody wrote about reads differently."""
        return scope.get_by_label(re.compile(r"^(Write to this task|First message about this task)$"))

    def send_button(self, scope):
        return scope.get_by_role("button", name=re.compile(r"^(Send to task|Start the discussion)$"))

    def choose(self, page, files, container=None):
        target = container or page
        with page.expect_file_chooser() as chooser:
            target.get_by_role("button", name="Attach files", exact=True).click()
        chooser.value.set_files(files)
        if len(files) > 1 and (page.viewport_size or {}).get("width", 1440) <= 640:
            # On a phone several files open the numbered picker (#348 AC-4); tapping them in order attaches them in that order.
            sheet = page.get_by_role("dialog", name="Choose files to send")
            for item in files:
                sheet.get_by_role("button", name=item["name"]).click()
            sheet.get_by_role("button", name=f"Add {len(files)}").click()

    def file(self, name="measurements.bin", content=b"\x00\xff\x04\n\x80 exact bytes"):
        return {"name": name, "mimeType": "application/octet-stream", "buffer": content}

    def stored(self, page):
        """Sending is instant (#264): the field empties at once; this waits until no message is still queued."""
        expect(page.locator("[data-client-message-id]")).to_have_count(0)

    def discussion(self, page, task):
        return self.api(page, "GET", f"/api/v1/work/{task['id']}/discussion")

    def record(self, page, project, task, who="owner"):
        key = f"flux:composer:{self.people[who]}:{project['id']}:task:{task['id']}"
        return page.evaluate("key => JSON.parse(localStorage.getItem(key))", key)

    def root(self, page, task, body="Start with actual measurements"):
        return self.api(page, "POST", f"/api/v1/work/{task['id']}/discussion", {"body": body, "clientMessageId": str(uuid.uuid4()), "kind": "text"}, 201)

    def cite(self, page, project, conversation):
        page.goto(f"/projects/{project['id']}/conversations/{conversation}")
        pane = page.get_by_role("complementary", name="Replies").or_(page.get_by_role("dialog", name="Replies"))
        # "/source" opens the saved sources, as the old Sources button did (F-026 S5).
        field = pane.get_by_label("Reply", exact=True)
        field.fill("/source")
        field.press("Enter")
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
        self.send_button(owner).click()
        expect(owner.get_by_role("list", name="Files in your draft")).to_have_count(0)
        self.stored(owner)
        discussion = self.discussion(owner, a)
        root = discussion["root"]
        self.assertEqual(root["body"], "")
        self.assertEqual(root["authorId"], self.people["owner"])
        self.assertEqual([item["name"] for item in root["files"]], [first["name"], second["name"]])
        self.open_agents(writer, project, a)
        self.choose(writer, [self.file("reply.bin", b"\x01\x02 independently measured")])
        expect(writer.get_by_text("Ready, private", exact=False)).to_have_count(1)
        self.send_button(writer).click()
        expect(writer.get_by_role("list", name="Files in your draft")).to_have_count(0)
        self.stored(writer)
        discussion = self.discussion(owner, a)
        reply = discussion["messages"][1]
        self.assertEqual(reply["body"], "")
        self.assertEqual(reply["authorId"], self.people["writer"])
        self.assertEqual(reply["conversationId"], root["conversationId"])
        roots = self.api(owner, "GET", f"/api/v1/projects/{project['id']}/conversation-roots")
        self.assertNotIn(root["conversationId"], [item["conversationId"] for item in roots["roots"]], "the discussion is in the task, not a root of the stream (#868)")
        for item, fixture in zip(root["files"], [first, second]):
            download = writer.request.get(f"/api/v1/files/{item['id']}")
            self.assertEqual(download.status, 200)
            self.assertEqual(download.body(), fixture["buffer"])
        writer.goto(f"/projects/{project['id']}/conversations/{root['conversationId']}")
        pane = writer.get_by_role("complementary", name="Replies").or_(writer.get_by_role("dialog", name="Replies"))
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
        self.enter_agents(page, project)
        self.open_thread(page, project, a)
        expect(self.box(page)).to_have_value("Shared command keeps this reference and attachment")
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
        self.send_button(page).click()
        # Sending is instant (#264): the field empties and the message itself says it was not sent.
        queued = page.locator("[data-client-message-id]")
        expect(queued.get_by_role("alert")).to_contain_text("Not sent")
        expect(self.box(page)).to_have_value("")
        self.open_agents(page, project, a)
        # The unsent message keeps its command, text, source and files across the reload.
        expect(queued.get_by_role("alert")).to_contain_text("Not sent")
        expect(queued).to_contain_text(lost[0]["body"])
        expect(queued.get_by_text("Source: Verified measurements · v1")).to_be_visible()
        expect(self.box(page)).to_have_value("")
        page.get_by_role("link", name="Open in Conversation", exact=True).click()
        pane = page.get_by_role("complementary", name="Replies").or_(page.get_by_role("dialog", name="Replies"))
        expect(pane.get_by_label("Reply", exact=True)).to_have_value("")
        retries = []
        page.on("request", lambda request: retries.append(request.post_data_json) if request.method == "POST" and request.url.endswith(f"/work/{a['id']}/discussion") else None)
        # The same task's queue shows in its Conversation thread; Retry there repeats the command.
        pane.locator("[data-client-message-id]").get_by_role("button", name="Retry").click()
        self.stored(page)
        self.assertEqual(retries[-1], lost[0], "same operation, task, UUID, text, references and ordered files")
        discussion = self.discussion(page, a)
        matching = [item for item in discussion["messages"] if item["body"] == lost[0]["body"]]
        self.assertEqual(len(matching), 1)
        self.assertEqual(matching[0]["source"], {"materialId": material["materialId"], "version": 1})
        page.goto(f"/projects/{project['id']}/tasks?open=work:{a['id']}")
        details = page.locator("#details")
        expect(details.get_by_label("Write to this task")).to_have_value("")
        details.get_by_label("Write to this task").fill("A reply from the Tasks details")
        details.get_by_role("button", name="Send to task").click()
        # The message stays in the task's Activity (#488); the panel does not navigate away from the task.
        expect(details.get_by_role("list", name="Task activity").get_by_text("A reply from the Tasks details", exact=True)).to_be_visible()
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
        expect(page.get_by_role("complementary", name="Replies").or_(page.get_by_role("dialog", name="Replies")).get_by_label("Reply", exact=True)).to_have_value(record["body"])

    def test_04_held_upload_and_send_a_b_a_never_clear_or_navigate_b(self):
        page = self.page()
        project, a, b, _ = self.scene(page)
        self.root(page, a)
        self.root(page, b)
        self.open_agents(page, project, a)
        self.addCleanup(lambda: page.unroute_all(behavior="ignoreErrors"))
        held = []
        def hold(route):
            if not held:
                held.append((route, route.fetch()))
                page.evaluate("window.__fluxHeldUploadReady = true")
            else:
                route.continue_()
        page.route("**/api/v1/projects/*/files?*", hold)
        self.box(page).fill("A's held private bytes")
        self.choose(page, [self.file("held-a.bin")])
        expect(page.get_by_text(re.compile("Uploading"))).to_have_count(1)  # "Uploading 0%" once the upload starts (#348 AC-3)
        page.wait_for_function("() => window.__fluxHeldUploadReady === true", timeout=10000)
        self.open_thread(page, project, b)
        self.box(page).fill("B's distinct draft")
        held[0][0].fulfill(response=held[0][1])
        expect(self.box(page)).to_have_value("B's distinct draft")
        expect(page.get_by_text("held-a.bin", exact=False)).to_have_count(0)
        self.open_thread(page, project, a)
        expect(self.box(page)).to_have_value("A's held private bytes")
        expect(page.get_by_text("Ready, private", exact=False)).to_have_count(1)
        pending = []
        def hold_send(route):
            if route.request.method == "POST" and not pending:
                pending.append((route, route.fetch()))
                page.evaluate("window.__fluxHeldSendReady = true")
            else:
                route.continue_()
        page.route(f"**/api/v1/work/{a['id']}/discussion", hold_send)
        self.send_button(page).click()
        page.wait_for_function("() => window.__fluxHeldSendReady === true", timeout=10000)
        # Sending is instant (#264): A's field empties at once while its message is held. The server already
        # stored it, so the live refresh may show the stored copy in place of the queued one: never both.
        expect(self.box(page)).to_have_value("")
        expect(page.locator("#details").get_by_role("region", name="Activity").get_by_text("A's held private bytes")).to_have_count(1)
        self.open_thread(page, project, b)
        expect(self.box(page)).to_have_value("B's distinct draft")
        expect(page.get_by_text("A's held private bytes")).to_have_count(0)
        self.open_thread(page, project, a)
        expect(self.box(page)).to_have_value("")
        # Held after the server stored it: Details lists the stored message once in its activity; the queued copy stays in "Messages you
        # are sending" until the server answers, so there is never a second stored copy. (The Agents view merged the two; Details, which
        # has shown its queue apart from its activity since #264, does not.)
        activity = page.locator("#details").get_by_role("region", name="Activity")
        expect(activity.locator(".wd-act").get_by_text("A's held private bytes")).to_have_count(1)
        expect(activity.locator(".wd-pending").get_by_text("A's held private bytes")).to_have_count(1)
        pending[0][0].fulfill(response=pending[0][1])
        self.stored(page)
        expect(page.locator("#details").get_by_role("region", name="Activity").get_by_text("A's held private bytes")).to_have_count(1)
        expect(self.box(page)).to_have_value("")
        expect(page.locator("#details").get_by_role("heading", name=a["title"])).to_be_visible()  # the late reply did not move Details to another task
        self.open_thread(page, project, b)
        expect(self.box(page)).to_have_value("B's distinct draft")
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
        self.enter_agents(page, project)
        self.open_thread(page, project, a)
        expect(self.box(page)).to_have_value("Newest memory copy")
        self.box(page).fill("The newest second edit")
        self.open_thread(page, project, b)
        self.box(page).fill("B stays separate")
        self.open_thread(page, project, a)
        expect(self.box(page)).to_have_value("The newest second edit")
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
        self.box(page).fill("Recover the unconfirmed private upload")
        self.choose(page, [self.file("uncertain.bin")])
        expect(page.get_by_role("alert")).to_be_visible()
        page.unroute("**/api/v1/projects/*/files?*", lose)
        before = self.record(page, project, a)
        self.open_agents(page, project, a)
        expect(self.box(page)).to_have_value(before["body"])
        # A real same-size, different-byte replay conflicts at the server and keeps its upload identity.
        with page.expect_file_chooser() as chooser:
            page.get_by_role("button", name="Retry upload").click()
        chooser.value.set_files(self.file("uncertain.bin", b"x" * len(self.file()["buffer"])))
        expect(page.get_by_role("alert")).to_contain_text("Upload conflicts")
        conflicted = self.record(page, project, a)
        self.assertEqual(conflicted["body"], before["body"])
        self.assertEqual(conflicted["files"][0]["uploadId"], before["files"][0]["uploadId"])
        self.open_agents(page, project, a)
        with page.expect_file_chooser() as chooser:
            page.get_by_role("button", name="Retry upload").click()
        chooser.value.set_files(self.file("uncertain.bin"))
        expect(page.get_by_text("Ready, private", exact=False)).to_have_count(1)
        after = self.record(page, project, a)
        self.assertEqual(before["files"][0]["uploadId"], after["files"][0]["uploadId"])
        self.assertEqual(after["files"][0]["staged"]["uploadId"], before["files"][0]["uploadId"])
        self.send_button(page).click()
        expect(self.box(page)).to_have_value("")
        self.stored(page)
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
        pane.get_by_label("Reply", exact=True).fill("/ai ")
        expect(pane.get_by_label("Ask your assistant", exact=True)).to_have_value("")
        pane.get_by_label("Ask your assistant", exact=True).fill("Private prompt never becomes the task root")
        pane.get_by_role("button", name="Stop asking your assistant").click()
        expect(pane.get_by_label("Reply", exact=True)).to_have_value("Public task draft stays public only on send")
        self.open_agents(page, other, other_a)
        expect(self.box(page)).to_have_value("")
        self.box(page).fill("Other project draft")
        self.open_agents(page, project, a)
        expect(self.box(page)).to_have_value("Public task draft stays public only on send")
        page.context.clear_cookies()
        page.context.add_cookies(self.states["writer"]["cookies"])
        self.open_agents(page, project, a)
        expect(self.box(page)).to_have_value("")
        expect(page.get_by_role("list", name="Files in your draft")).to_have_count(0)
        self.assertEqual(len(self.discussion(page, a)["messages"]), 1, "private prompt and draft navigation write no contribution")

    def test_08_phone_keyboard_touch_and_reduced_motion_keep_files_and_focus_usable(self):
        for width in (320, 390, 834, 1440):
            with self.subTest(width=width):
                page = self.page(width=width)
                project, a, _, _ = self.scene(page)
                self.open_agents(page, project, a)
                box = self.box(page)
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
                touch = width <= 1024
                if touch:
                    self.send_button(page).click()  # on a touch screen Enter is a new line
                else:
                    box.press("Enter")
                expect(box).to_have_value("")
                if not touch:
                    expect(box).to_be_focused()
                self.stored(page)
                discussion = self.discussion(page, a)
                page.goto(f"/projects/{project['id']}/conversations/{discussion['conversationId']}")
                pane = page.get_by_role("complementary", name="Replies").or_(page.get_by_role("dialog", name="Replies"))
                expect(pane.get_by_role("link", name=re.compile("a-very-long"))).to_be_visible()
                pane.get_by_role("button", name="Close replies").focus()
                pane.get_by_role("button", name="Close replies").press("Enter")
                expect(pane).to_have_count(0)
                self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), width)
                shot(page, f"shared-published-{width}")
                expect(page.get_by_role('button', name=re.compile('^Sources'))).to_have_count(0)
                pane = self.cite(page, project, discussion['conversationId'])
                pane.get_by_label('Reply', exact=True).fill('Compare these two files with the saved measurements')
                self.choose(page, [self.file('01-negative-measurement.bin'), self.file('02-sensor-wiring.bin')], pane)
                expect(pane.get_by_text('Ready, private', exact=False)).to_have_count(2)
                expect(pane.locator('.composer-files__ref')).to_contain_text('Source: Verified measurements · v1')
                self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), width)
                shot(page, f'shared-reply-draft-{width}')
                field = pane.get_by_label('Reply', exact=True)
                field.fill('/source')
                field.press('Enter')
                expect(page.get_by_role('heading', name=f"Sources · saved for {project['name']}", exact=True)).to_be_visible()
                shot(page, f'shared-sources-{width}')

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
        def revoke():
            """The writer's access ends the way an admin ends it: the grant is removed (a space has two roles, #903)."""
            grants = self.api(owner, "GET", f"/api/v1/projects/{project['id']}/grants")
            self.api(owner, "DELETE", f"/api/v1/projects/{project['id']}/grants/{next(item['id'] for item in grants if item['principal']['id'] == self.people['writer'])}", status=204)
        def revoke_upload(route):
            revoke()
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
                revoke()
                response = route.fetch()
                self.assertEqual(response.status, 404)
                route.fulfill(response=response)
            else:
                route.continue_()
        writer.route(f"**/api/v1/work/{a['id']}/discussion", revoke_send)
        with writer.expect_response(lambda response: response.request.method == "POST" and response.url.endswith(f"/work/{a['id']}/discussion")):
            self.send_button(writer).click()
        # A refusal returns the complete draft, with its command, to the emptied field (#264).
        expect(self.box(writer)).to_have_value(command_before["body"])
        writer.unroute(f"**/api/v1/work/{a['id']}/discussion", revoke_send)
        access("contributor")
        self.open_agents(writer, project, a)
        expect(writer.get_by_text("This send is unconfirmed. Retry sends the same command once.", exact=True)).to_be_visible()
        kept = self.record(writer, project, a, "writer")
        for field in ("body", "files", "references", "commandId"):
            self.assertEqual(kept[field], command_before[field])
        self.assertTrue(kept["unconfirmed"])
        self.assertEqual(len(self.discussion(owner, a)["messages"]), 1)
        self.send_button(writer).click()
        expect(self.box(writer)).to_have_value("")
        self.stored(writer)
        self.assertEqual(self.discussion(owner, a)["messages"][-1]["authorId"], self.people["writer"])

    def test_10_map_details_and_unloaded_old_conversation_retry_one_task_command(self):
        page = self.page()
        project, _, _, _ = self.scene(page)
        sketch = self.api(page, "POST", f"/api/v1/workspaces/{self.workspace}/sketches", {"title": "Night measurement plan", "scope": "project", "projectId": project['id']}, 201)
        thought = self.api(page, "POST", f"/api/v1/sketches/{sketch['id']}/thoughts", {"text": "Measure the negative camera result", "x": 0, "y": 0}, 201)["thought"]
        # #867: the Map has no Create task; the task has the thought as its source and opens in Details beside the map.
        task = self.api(page, "POST", f"/api/v1/projects/{project['id']}/work", {"title": "Measure the negative camera result", "sources": [{"type": "thought", "id": thought["id"]}]}, 201)
        page.goto(f"/projects/{project['id']}/map/{sketch['id']}?open=work:{task['id']}")
        details = page.locator("#details")
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
        # Sending is instant (#264): Details shows the message as not sent, with its command kept.
        expect(details.locator("[data-client-message-id]").get_by_role("alert")).to_contain_text("Not sent")
        expect(box).to_have_value("")
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
        def bounded_view(route):
            # The conversation's first read carries its newest roots (#1109): they are the same bounded first page.
            parts = urlsplit(route.request.url)
            window = route.fetch(url=urlunsplit((parts.scheme, parts.netloc, parts.path.replace("/conversation-view", "/conversation-roots"), "limit=1", "")))
            response = route.fetch()
            body = response.json()
            body["roots"] = window.json()
            first.append(body["roots"])
            route.fulfill(response=response, json=body)
        page.route("**/api/v1/projects/*/conversation-roots*", bounded)
        page.route("**/api/v1/projects/*/conversation-view", bounded_view)
        page.goto(f"/projects/{project['id']}/conversations/{discussion['conversationId']}")
        pane = page.get_by_role("complementary", name="Replies").or_(page.get_by_role("dialog", name="Replies"))
        expect(pane.get_by_label("Reply", exact=True)).to_have_value("")
        queued = pane.locator("[data-client-message-id]")
        expect(queued.get_by_role("alert")).to_contain_text("Not sent")
        self.assertTrue(first)
        self.assertNotIn(discussion["conversationId"], [root["conversationId"] for root in first[0]["roots"]])
        replay = []
        page.on("request", lambda request: replay.append(request.post_data_json) if request.method == "POST" and request.url.endswith(f"/work/{task['id']}/discussion") else None)
        queued.get_by_role("button", name="Retry").click()
        self.stored(page)
        expect(pane.get_by_label("Reply", exact=True)).to_have_value("")
        self.assertEqual(replay[-1], lost[0])
        self.assertEqual(len(self.discussion(page, task)["messages"]), 1)
        page.unroute("**/api/v1/projects/*/conversation-roots*", bounded)
        page.unroute("**/api/v1/projects/*/conversation-view", bounded_view)
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
        pane = page.get_by_role("complementary", name="Replies").or_(page.get_by_role("dialog", name="Replies"))
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
        self.stored(page)
        self.assertEqual(self.discussion(page, a)["messages"][-1]["source"], {"materialId": recovered['references'][0]['materialId'], "version": 1})

    def test_12_a_slow_switch_between_tasks_never_writes_to_the_wrong_task(self):
        # A task's composer lives in its Details (F-038); switching tasks while the next one is still being read must leave the old
        # composer unusable, write nothing anywhere and, on a cancelled or failed switch, change neither task's private draft.
        page = self.page()
        self.addCleanup(lambda: page.unroute_all(behavior="ignoreErrors"))
        project, a, b, _ = self.scene(page)
        c = self.api(page, "POST", f"/api/v1/projects/{project['id']}/work", {"title": "A switch nobody finishes"}, 201)
        d = self.api(page, "POST", f"/api/v1/projects/{project['id']}/work", {"title": "A task whose read fails"}, 201)
        roots = [self.root(page, task) for task in (a, b)]
        for task, root in zip((a, b), roots):
            pane = self.cite(page, project, root['conversationId'])
            pane.get_by_label("Reply", exact=True).fill(f"The complete private draft for {task['id']}")
            self.choose(page, [self.file(f"{task['id']}.bin")], pane)
            expect(pane.get_by_text("Ready, private", exact=False)).to_have_count(1)
        before_a, before_b = self.record(page, project, a), self.record(page, project, b)
        self.open_agents(page, project, a)
        writes = []
        page.on("request", lambda request: writes.append(request.url) if request.method == "POST" and ("/files?" in request.url or request.url.endswith("/discussion")) else None)

        def detail(task):
            return f"**/api/v1/projects/{project['id']}/work-objects/work/{task['id']}*"

        def hold(task):
            held = []
            def handler(route):
                if not held:
                    held.append((route, route.fetch()))
                else:
                    route.continue_()
            page.route(detail(task), handler)
            return held

        def wait_held(held):
            deadline = time.time() + 10
            while not held and time.time() < deadline:
                page.wait_for_timeout(50)
            self.assertTrue(held, "the task's read was held")

        # B is read slowly: A's composer is gone at once, B's is not there yet, and nothing is written meanwhile.
        held = hold(b)
        self.switch_to(page, project, b)
        wait_held(held)
        expect(self.box(page)).to_have_count(0)
        expect(self.send_button(page)).to_have_count(0)
        shot(page, "shared-task-switch-pending-1440")
        self.assertEqual(self.record(page, project, a), before_a)
        self.assertEqual(self.record(page, project, b), before_b)
        self.assertEqual(writes, [])
        self.assertEqual(len(self.discussion(page, a)['messages']), 1)
        self.assertEqual(len(self.discussion(page, b)['messages']), 1)
        held[0][0].fulfill(response=held[0][1])
        box = self.box(page)
        expect(box).to_be_enabled()
        expect(box).to_have_value(before_b['body'])
        self.assertEqual(self.record(page, project, b), before_b)
        box.fill("B can be edited only in B's mounted composer")
        edited_b = self.record(page, project, b)
        self.assertNotEqual(edited_b['commandId'], before_b['commandId'])
        self.assertEqual(edited_b['files'], before_b['files'])
        self.assertEqual(edited_b['references'], before_b['references'])
        self.assertEqual(self.record(page, project, a), before_a)
        self.open_thread(page, project, a)
        expect(self.box(page)).to_have_value(before_a['body'])
        self.assertEqual(self.record(page, project, a), before_a)
        page.unroute_all(behavior="ignoreErrors")

        # A switch to C that the person leaves for A before it arrives: C's late answer neither opens C nor touches a draft.
        held = hold(c)
        self.switch_to(page, project, c)
        wait_held(held)
        expect(self.box(page)).to_have_count(0)
        self.open_thread(page, project, a)
        expect(self.box(page)).to_have_value(before_a['body'])
        held[0][0].fulfill(response=held[0][1])
        page.wait_for_timeout(300)
        expect(page.locator("#details").get_by_role("heading", name=a["title"])).to_be_visible()
        expect(self.box(page)).to_have_value(before_a['body'])
        self.assertEqual(self.record(page, project, a), before_a)
        self.assertEqual(self.record(page, project, b), edited_b)
        page.unroute_all(behavior="ignoreErrors")

        # A read that fails shows an honest failure, never an editable composer of the task before it.
        def fail(route):
            route.fulfill(status=503, content_type="application/json", body=json.dumps({"code": "UNAVAILABLE", "message": "Controlled unavailable read"}))
        page.route(detail(d), fail)
        self.switch_to(page, project, d)
        expect(page.locator("#details").get_by_role("heading", name="Not available")).to_be_visible()
        expect(self.box(page)).to_have_count(0)
        self.assertEqual(self.record(page, project, a), before_a)
        self.assertEqual(self.record(page, project, b), edited_b)
        self.assertEqual(writes, [])
        page.unroute(detail(d), fail)
        self.open_agents(page, project, b)
        expect(self.box(page)).to_have_value(edited_b['body'])
        self.assertEqual(self.record(page, project, a), before_a)

    def test_13_signout_clears_device_and_visit_drafts_before_a_late_upload(self):
        for refused_write in (False, True):
            with self.subTest(storage_refused=refused_write):
                page = self.page()
                self.addCleanup(lambda page=page: page.unroute_all(behavior="ignoreErrors"))
                project, task, _, _ = self.scene(page)
                root = self.root(page, task)
                pane = self.cite(page, project, root['conversationId'])
                pane.get_by_label("Reply", exact=True).fill("Private text with a saved source before signing out")
                self.choose(page, [self.file("private-before-signout.bin")], pane)
                expect(pane.get_by_text("Ready, private", exact=False)).to_have_count(1)
                persisted = self.record(page, project, task)
                if refused_write:
                    page.evaluate("() => { Storage.prototype.setItem = function() { throw new DOMException('Refused', 'QuotaExceededError'); }; }")
                    pane.get_by_label("Reply", exact=True).fill("Newest private visit copy after storage refused writes")
                newest = pane.get_by_label("Reply", exact=True).input_value()
                def fail(route):
                    route.fulfill(status=503, content_type="application/json", body="{}")
                page.route("**/api/auth/sign-out", fail)
                page.get_by_role("button", name=re.compile("account and sign out")).click()
                with page.expect_response(lambda response: response.url.endswith("/api/auth/sign-out")) as response:
                    page.get_by_role("button", name="Sign out", exact=True).click()
                self.assertEqual(response.value.status, 503)
                # Sign-out is a navigation (#195): a failure lands on the sign-out page, which says so.
                expect(page).to_have_url(re.compile(r"/sign-out$"))
                expect(page.get_by_role("heading", name="Sign out of Flux?")).to_be_visible()
                expect(page.get_by_role("alert")).to_be_visible()
                self.assertEqual(self.record(page, project, task), persisted)
                page.unroute("**/api/auth/sign-out", fail)
                # Back in the conversation, the failed sign-out has kept the newest text.
                page.go_back()
                expect(pane.get_by_label("Reply", exact=True)).to_have_value(newest)
                self.assertEqual(self.record(page, project, task), persisted)
                held = []
                def hold_upload(route):
                    result = route.fetch()
                    self.assertEqual(result.status, 201)
                    held.append((route, result))
                    page.evaluate("window.__fluxSignoutUploadReady = true")
                page.route(f"**/api/v1/projects/{project['id']}/files?*", hold_upload)
                self.choose(page, [self.file("private-late-signout.bin")], pane)
                page.wait_for_function("() => window.__fluxSignoutUploadReady === true")
                page.get_by_role("button", name=re.compile("account and sign out")).click()
                with page.expect_response(lambda response: response.url.endswith("/api/auth/sign-out")) as response:
                    page.get_by_role("button", name="Sign out", exact=True).click()
                self.assertEqual(response.value.status, 200)
                expect(page.get_by_role("heading", name="Sign in", exact=True)).to_be_visible()
                self.assertIsNone(self.record(page, project, task))
                held[0][0].fulfill(response=held[0][1])
                page.unroute_all(behavior="ignoreErrors")
                self.assertIsNone(self.record(page, project, task), "a late upload cannot repersist a retired record")
                page.get_by_label("Email", exact=True).fill(PEOPLE['owner'][1])
                page.get_by_label("Password", exact=True).fill(PASSWORD)
                page.get_by_role("button", name="Sign in", exact=True).click()
                expect(page.get_by_role("heading", name="Sign in", exact=True)).to_have_count(0)
                # Use the app's project link so the visit-local store survives the login round trip.
                page.locator(f'a[href^="/projects/{project["id"]}"]').first.click()
                self.enter_agents(page, project)
                self.open_thread(page, project, task)
                expect(self.box(page)).to_have_value("")
                expect(page.get_by_role("list", name="Files in your draft")).to_have_count(0)
                self.assertEqual(len(self.discussion(page, task)['messages']), 1)
                # The next storage variant needs this real replacement session;
                # successful logout revoked the original shared fixture cookie.
                self.states['owner'] = page.context.storage_state()

    def test_14_device_signout_retires_the_same_private_composer_in_another_tab(self):
        page = self.page()
        project, task, _, _ = self.scene(page)
        root = self.root(page, task)
        pane = self.cite(page, project, root['conversationId'])
        text = 'Private source and bytes must leave every signed-out tab'
        pane.get_by_label('Reply', exact=True).fill(text)
        self.choose(page, [self.file('other-tab-private.bin')], pane)
        expect(pane.get_by_text('Ready, private', exact=False)).to_have_count(1)
        other = page.context.new_page()
        self.open_agents(other, project, task)
        expect(self.box(other)).to_have_value(text)
        before = self.record(other, project, task)
        def fail(route):
            route.fulfill(status=503, content_type='application/json', body='{}')
        page.route('**/api/auth/sign-out', fail)
        page.get_by_role('button', name=re.compile('account and sign out')).click()
        with page.expect_response(lambda response: response.url.endswith('/api/auth/sign-out')) as response:
            page.get_by_role('button', name='Sign out', exact=True).click()
        self.assertEqual(response.value.status, 503)
        # Sign-out is a navigation (#195): a failure lands on the sign-out page, which offers to try again.
        expect(page).to_have_url(re.compile(r'/sign-out$'))
        expect(page.get_by_role('heading', name='Sign out of Flux?')).to_be_visible()
        expect(self.box(other)).to_have_value(text)
        self.assertEqual(self.record(other, project, task), before)
        page.unroute('**/api/auth/sign-out', fail)
        with page.expect_response(lambda response: response.url.endswith('/api/auth/sign-out')) as response:
            page.get_by_role('button', name='Sign out', exact=True).click()
        self.assertEqual(response.value.status, 200)
        expect(page.get_by_role('heading', name='Sign in', exact=True)).to_be_visible()
        expect(other.get_by_role('heading', name='Sign in', exact=True)).to_be_visible()
        self.assertIsNone(self.record(other, project, task))
        expect(self.box(other)).to_have_count(0)
        page.get_by_label('Email', exact=True).fill(PEOPLE['writer'][1])
        page.get_by_label('Password', exact=True).fill(PASSWORD)
        page.get_by_role('button', name='Sign in', exact=True).click()
        expect(page.get_by_role('heading', name='Sign in', exact=True)).to_have_count(0)
        self.open_agents(other, project, task)
        expect(self.box(other)).to_have_value('')
        expect(other.get_by_role('list', name='Files in your draft')).to_have_count(0)
        self.assertIsNone(self.record(other, project, task))
