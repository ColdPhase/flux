"""Browser tests for search inside files (C-63, #1382): Ctrl+K finds what a PDF, a Word document and a Markdown file say, shows the file's row with a
snippet, opens its message with its preview open (a PDF at the page that matched), and finds nothing for someone who may not read the space or once the
message is removed. The API half (rows, access, the sandbox, agents) is tests/app/file-text.test.ts. Runs through scripts/check_ui.sh test_file_search.
FLUX_UI_BROWSER selects chromium (default) or webkit.
"""

from __future__ import annotations

import io
import os
import re
import time
import unittest
import uuid
import zipfile

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, start_forwarder

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")
SHOTS = os.environ.get("FLUX_UI_SCREENSHOTS")
PASSWORD = "files can be searched too"
STAMP = int(time.time() * 1000)
PEOPLE = {"ada": ("Ada Kowalska", f"ada.files+{STAMP}@example.test"), "jonas": ("Jonas Berg", f"jonas.files+{STAMP}@example.test"),
          "wera": ("Wera Lis", f"wera.files+{STAMP}@example.test")}
# Words nobody else writes, so each finds its file alone.
PDF_WORD, DOCX_WORD, MD_WORD = "zorbalux", "quindrelle", "plimsoleth"


def pdf_bytes(pages: list[str]) -> bytes:
    """A real PDF with one page for each string."""
    objects: list[bytes] = [b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"]
    kids = []
    pages_id = 2 + len(pages) * 2
    for index, text in enumerate(pages):
        stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
        objects.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
        objects.append(b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 612 792] /Contents %d 0 R /Resources << /Font << /F1 1 0 R >> >> >>" % (pages_id, 2 + index * 2))
        kids.append(3 + index * 2)
    objects.append(b"<< /Type /Pages /Count %d /Kids [%s] >>" % (len(kids), b" ".join(b"%d 0 R" % kid for kid in kids)))
    objects.append(b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id)
    out, offsets = b"%PDF-1.4\n", []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1) + b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    return out + b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, len(objects), xref)


def docx_bytes(paragraphs: list[str]) -> bytes:
    body = "".join(f'<w:p><w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>' for text in paragraphs)
    xml = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>'
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", xml)
    return out.getvalue()


class FileSearch(unittest.TestCase):
    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    contexts: dict[str, BrowserContext] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            cls.contexts[key] = context

        def post(who: str, path: str, body: dict) -> dict:
            response = cls.contexts[who].request.post(path, data=body, headers={"origin": ORIGIN})
            assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
            return response.json()

        ws = post("ada", "/api/v1/workspaces", {"name": "Studio"})
        for other in ("jonas", "wera"):
            post("ada", f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE[other][1], "role": "member"})
        pid = post("ada", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Contracts", "visibility": "restricted"})["id"]
        post("ada", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": cls.ids["jonas"]}, "role": "contributor"})
        cls.ids["project"] = pid

        def root(key: str, body: str, name: str, data: bytes) -> None:
            upload = cls.contexts["ada"].request.post(f"/api/v1/projects/{pid}/files?uploadId={uuid.uuid4()}&name={name}", data=data,
                                                      headers={"origin": ORIGIN, "content-type": "application/octet-stream"})
            assert upload.status == 201, upload.text()
            started = post("ada", f"/api/v1/projects/{pid}/conversations", {"body": body, "attachmentIds": [upload.json()["id"]], "clientMessageId": str(uuid.uuid4())})
            cls.ids[key] = started["messages"][0]["id"]
            cls.ids[f"conversation:{key}"] = started["id"]
            cls.ids[f"file:{key}"] = upload.json()["id"]

        root("pdf", "The supplier's contract", "supplier-contract.pdf",
             pdf_bytes(["Cover page of the supplier contract", f"Clause nine says the {PDF_WORD} must be calibrated every spring.", "Signatures"]))
        root("docx", "Minutes of Tuesday", "board-minutes.docx", docx_bytes(["Board minutes", f"Agreed: the {DOCX_WORD} budget is approved."]))
        root("md", "Notes for the lab", "lab-notes.md", f"# Lab notes\n\nThe {MD_WORD} section is finished.\n".encode())
        # The worker reads each file a moment after its message is sent: wait until all three are found, as Ada.
        deadline = time.time() + 90
        pending = {PDF_WORD, DOCX_WORD, MD_WORD}
        while pending and time.time() < deadline:
            for word in list(pending):
                found = cls.contexts["ada"].request.get(f"/api/v1/search?q={word}").json()["items"]
                if any(item["kind"] == "file" and item["snippet"] for item in found):
                    pending.discard(word)
            if pending:
                time.sleep(0.5)
        assert not pending, f"the worker did not read the files in time: {pending}"

    @classmethod
    def tearDownClass(cls) -> None:
        for context in cls.contexts.values():
            context.close()
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str, phone: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who], "service_workers": "block"}
        options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def shot(self, page: Page, name: str) -> None:
        if SHOTS:
            page.evaluate("document.fonts.ready.then(() => true)")
            page.wait_for_timeout(500)
            page.screenshot(path=os.path.join(SHOTS, f"{name}-{UI_BROWSER}.png"))

    def jump(self, page: Page, query: str):
        expect(page.get_by_role("button", name="Search", exact=True)).to_be_visible()
        page.keyboard.press("Control+k")
        dialog = page.get_by_role("dialog", name="Search", exact=True)
        expect(dialog).to_be_visible()
        field = dialog.get_by_role("combobox", name="Search", exact=True)
        expect(field).to_be_focused()
        field.fill(query)
        return dialog, field

    def test_01_a_pdf_is_found_by_what_it_says_and_opens_at_the_page(self) -> None:
        page = self.page("jonas")
        page.goto("/")
        dialog, field = self.jump(page, PDF_WORD)
        row = dialog.get_by_role("option", name=re.compile("supplier-contract.pdf"))
        expect(row).to_have_count(1)
        expect(dialog.locator(".jump__sh", has_text="Files")).to_be_visible()
        expect(row).to_contain_text("Page 2")
        expect(row.locator(".sr__meta")).to_contain_text("Clause nine says the")
        expect(row.locator(".sr__hit")).to_have_text(re.compile(PDF_WORD))
        expect(row.locator(".file-icon")).to_be_visible()
        expect(row).to_have_attribute("aria-selected", "true")
        self.shot(page, "file-search-pdf")
        field.press("Enter")
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['project']}/conversations/{self.ids['conversation:pdf']}\?file={self.ids['file:pdf']}&page=2#message-{self.ids['pdf']}"))
        viewer = page.get_by_role("dialog", name="supplier-contract.pdf")
        expect(viewer).to_be_visible()
        # Flux's own PDF viewer draws it, and opens at the page that matched: page two's top edge is at the top of the viewer, page one's is above it.
        inside = page.frame_locator(".file-viewer iframe")
        expect(inside.locator(".page canvas").first).to_be_attached()
        frame = next(f for f in page.frames if f.url.endswith("/pdf-viewer/index.html"))
        top = lambda index: frame.evaluate("(i) => document.querySelectorAll('.page')[i].getBoundingClientRect().top", index)  # noqa: E731
        deadline = time.time() + 8
        while time.time() < deadline and not -4 <= top(1) < 40:
            page.wait_for_timeout(100)
        self.assertTrue(-4 <= top(1) < 40, f"page two is at the top of the viewer ({top(1)})")
        self.assertLess(top(0), 0, "and page one is above it")
        expect(page.locator(f"#message-{self.ids['pdf']}")).to_be_visible()
        expect(viewer.get_by_role("button", name="Close preview")).to_be_focused()  # the message being shown does not take the focus from the dialog
        self.shot(page, "file-search-opened")
        page.keyboard.press("Escape")
        expect(viewer).to_have_count(0)
        try:
            expect(page).to_have_url(re.compile(r"^(?!.*[?&]file=)"))  # closing the preview takes it out of the address
        except AssertionError as error:
            raise AssertionError(f"the address after closing is {page.url}") from error
        self.assertIn(f"#message-{self.ids['pdf']}", page.url)
        expect(page.locator(f"#message-{self.ids['pdf']}")).to_be_visible()

    def test_02_a_word_document_and_a_markdown_file_open_their_preview(self) -> None:
        page = self.page("ada")
        page.goto("/")
        dialog, field = self.jump(page, MD_WORD)
        expect(dialog.get_by_role("option", name=re.compile("lab-notes.md"))).to_have_count(1)
        field.press("Enter")
        viewer = page.get_by_role("dialog", name="lab-notes.md")
        expect(viewer).to_be_visible()
        expect(viewer).to_contain_text(MD_WORD)
        page.keyboard.press("Escape")
        expect(viewer).to_have_count(0)
        # A DOCX has no preview of its own: its row is still found by what it says, and opens its message.
        page.goto("/")
        dialog, field = self.jump(page, DOCX_WORD)
        row = dialog.get_by_role("option", name=re.compile("board-minutes.docx"))
        expect(row).to_have_count(1)
        expect(row.locator(".sr__meta")).to_contain_text("budget is approved")
        field.press("Enter")
        expect(page.locator(f"#message-{self.ids['docx']}")).to_be_visible()
        expect(page.get_by_role("dialog", name="board-minutes.docx")).to_have_count(0)

    def test_03_someone_who_may_not_read_the_space_finds_nothing(self) -> None:
        page = self.page("wera")
        page.goto("/")
        dialog, field = self.jump(page, PDF_WORD)
        expect(dialog.get_by_role("option")).to_have_count(0)
        expect(dialog.locator(".jump__sh", has_text="Files")).to_have_count(0)
        self.assertEqual(self.contexts["wera"].request.get(f"/api/v1/search?q={PDF_WORD}").json()["items"], [])

    def test_04_the_phone_shows_the_same_row_in_its_sheet(self) -> None:
        page = self.page("jonas", phone=True)
        page.goto("/")
        page.get_by_role("button", name="Search", exact=True).click()
        sheet = page.get_by_role("dialog", name="Search", exact=True)
        expect(sheet).to_be_visible()
        sheet.get_by_role("combobox", name="Search", exact=True).fill(DOCX_WORD)
        row = sheet.get_by_role("option", name=re.compile("board-minutes.docx"))
        expect(row).to_be_visible()
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"), "no horizontal scroll")
        self.assertGreaterEqual(row.bounding_box()["height"], 44)
        self.shot(page, "file-search-phone")

    def test_99_a_removed_message_takes_its_file_out_of_search_at_once(self) -> None:
        response = self.contexts["ada"].request.delete(f"/api/v1/conversations/{self.ids['conversation:md']}/messages/{self.ids['md']}", headers={"origin": ORIGIN})
        self.assertIn(response.status, (200, 204), response.text())
        page = self.page("ada")
        page.goto("/")
        dialog, field = self.jump(page, MD_WORD)
        expect(dialog.get_by_role("option", name=re.compile("lab-notes.md"))).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
