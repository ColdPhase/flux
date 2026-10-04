"""Browser test for a file-only message in a project conversation (#154, PR #225).

Runs with the other tests/ui journeys through scripts/check_ui.sh. A message posted through the API
with attachments and no text shows its files as downloads, not an empty bubble, and a task made from
it gets a readable title instead of an empty one.
"""

from __future__ import annotations

import time
import unittest
import uuid

from playwright.sync_api import Browser, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UPSTREAM, start_forwarder

PASSWORD = "files need a place"
STAMP = int(time.time() * 1000)
OWNER = {"name": "Ola Wren", "email": f"ola.wren+{STAMP}@example.test"}
BYTES = b"lux,gestures\n5,38%\n"


class FileOnlyMessage(unittest.TestCase):
    pw = None
    browser: Browser

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=10000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def test_a_file_only_message_shows_its_files_and_makes_a_titled_task(self) -> None:
        context = self.browser.new_context(base_url=ORIGIN, viewport=DESKTOP, locale="en-GB")
        self.addCleanup(context.close)
        request = context.request
        headers = {"origin": ORIGIN}
        self.assertEqual(request.post("/api/auth/sign-up/email", data={**OWNER, "password": PASSWORD}, headers=headers).status, 200)

        def post(path: str, body: dict) -> dict:
            response = request.post(path, data=body, headers=headers)
            self.assertIn(response.status, (200, 201), f"{path}: {response.status} {response.text()}")
            return response.json()

        ws = post("/api/v1/workspaces", {"name": "Lamp lab"})
        project = post(f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Low light", "visibility": "restricted"})
        upload = request.post(f"/api/v1/projects/{project['id']}/files?uploadId={uuid.uuid4()}&name=readings.csv",
                              data=BYTES, headers={**headers, "content-type": "application/octet-stream"})
        self.assertEqual(upload.status, 201, upload.text())
        file = upload.json()
        started = post(f"/api/v1/projects/{project['id']}/conversations",
                       {"body": "", "attachmentIds": [file["id"]], "clientMessageId": str(uuid.uuid4())})
        message_id = started["messages"][0]["id"]

        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(f"/projects/{project['id']}/conversations/{started['id']}")
        message = page.locator(f"#message-{message_id}")
        files = message.get_by_role("list", name="1 attached file")
        link = files.get_by_role("link", name="readings.csv")
        expect(link).to_have_attribute("href", f"/api/v1/files/{file['id']}")
        expect(link).to_have_attribute("download", "readings.csv")
        expect(files).to_contain_text(f"{len(BYTES)} B")
        expect(message.locator("> p")).to_have_count(0)
        downloaded = page.request.get(f"/api/v1/files/{file['id']}")
        self.assertEqual(downloaded.body(), BYTES)

        message.hover()
        more = message.get_by_role("button", name="Make from this message")
        if more.count():
            more.click()
        message.get_by_role("button", name="Task", exact=True).click()
        expect(page.get_by_role("alert")).to_have_count(0)
        expect(page.get_by_role("heading", name="1 attached file")).to_be_visible()
        items = request.get(f"/api/v1/projects/{project['id']}/work?limit=100").json()["items"]
        self.assertEqual([item["title"] for item in items], ["1 attached file"])
        self.assertEqual(errors, [], "no uncaught page errors")


if __name__ == "__main__":
    unittest.main()
