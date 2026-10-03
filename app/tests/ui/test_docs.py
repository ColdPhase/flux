"""Browser tests for project docs and wiki (issue #112, AC-3/AC-5).

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose
application. Two people share one project. One writes a doc in the Markdown editor with a
preview and a link to a result, publishes it and reads it; the other edits concurrently and gets
the conflict instead of a silent overwrite; both read the history with a diff; a result is added
to the doc from its details; the phone reads, edits and compares. Every step is checked against
the API, so the test proves persisted behaviour rather than local state.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "docs keep their history"
STAMP = int(time.time() * 1000)
OWNER = {"name": "Ada Lind", "email": f"ada.docs+{STAMP}@example.test"}
PARTNER = {"name": "Kai Berg", "email": f"kai.docs+{STAMP}@example.test"}
LAPTOP = {"width": 1280, "height": 800}
TITLE = "How the lamp senses gestures"
FINDING = "The camera misses most gestures below 10 lux"
RULE = "Use a ToF distance sensor for gestures"
BODY = """## What we use

The lamp reads hand gestures with a **ToF distance sensor** above the shade. It works in the dark and needs no camera.

- Swipe up or down changes the brightness
- A held palm switches the lamp off
- Two quick waves start the night light

## Numbers from the bench

| Sensor | Gestures caught at 5 lux | Power |
| --- | ---: | ---: |
| Camera | 38% | 1.2 W |
| ToF | 96% | 0.2 W |

> The camera test ran for two evenings in Kai's bedroom.

"""


class DocsJourney(unittest.TestCase):
    """Tests run in name order and share two accounts and one project."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    project_id: str = ""
    result_id: str = ""
    decision_id: str = ""
    doc_id: str = ""

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, who: str | None, *, phone: bool = False, viewport: dict | None = None) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=viewport or DESKTOP, device_scale_factor=1)
        if who and who in self.states:
            options["storage_state"] = self.states[who]
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context

    def page(self, who: str | None, **kwargs) -> Page:
        page = self.context(who, **kwargs).new_page()
        errors: list[str] = []
        dialogs: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("dialog", lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        self.addCleanup(lambda: self.assertEqual(dialogs, [], "no script ran a dialog"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None, headers: dict | None = None) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method,
                                      headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def doc(self, page: Page, doc_id: str | None = None) -> dict:
        return self.api(page, "GET", f"/api/v1/docs/{doc_id or self.doc_id}", status=200)

    def versions(self, page: Page) -> list[dict]:
        return self.api(page, "GET", f"/api/v1/docs/{self.doc_id}/versions", status=200)["items"]

    def tab(self, page: Page, name: str):
        return page.get_by_role("navigation", name="Project views").get_by_role("link", name=name)

    # ---------------------------------------------------------------- set up

    def test_01_two_people_share_a_project(self) -> None:
        for key, person in (("owner", OWNER), ("partner", PARTNER)):
            page = self.page(None)
            page.goto("/sign-up")
            page.get_by_label("Name").fill(person["name"])
            page.get_by_label("Email").fill(person["email"])
            page.get_by_label("Password").fill(PASSWORD)
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            type(self).states[key] = page.context.storage_state()
            person["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        owner = self.page("owner")
        ws = self.api(owner, "POST", "/api/v1/workspaces", {"name": "Lamp studio"}, status=201)
        self.api(owner, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": PARTNER["email"], "role": "member"}, status=201)
        project = self.api(owner, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Gesture lamp", "visibility": "restricted"}, status=201)
        self.api(owner, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "human", "id": PARTNER["id"]}, "role": "contributor"}, status=201)
        type(self).project_id = project["id"]
        base = f"/api/v1/projects/{project['id']}"
        self.api(owner, "POST", f"{base}/conversations", {"body": "Camera or distance sensor? Let us test both in the dark.", "clientMessageId": str(uuid.uuid4())}, status=201)
        partner = self.page("partner")
        result = self.api(partner, "POST", f"{base}/results", {"title": FINDING, "finding": "negative", "evidence": "38% of 20 gestures at 5 lux over two evenings."}, status=201)
        type(self).result_id = result["id"]
        rule = self.api(owner, "POST", f"{base}/decisions", {"title": RULE, "rationale": "It works in the dark and draws a sixth of the power."}, status=201)
        self.api(owner, "POST", f"/api/v1/decisions/{rule['id']}/accept", {}, status=200, headers={"if-match": '"1"'})
        type(self).decision_id = rule["id"]

    # ---------------------------------------------------------------- write, preview, link, publish

    def test_02_write_a_doc_with_preview_and_a_link(self) -> None:
        page = self.page("owner")
        page.goto(f"/projects/{self.project_id}")
        self.tab(page, "Wiki").click()
        expect(page.get_by_role("heading", name="No pages yet")).to_be_visible()
        page.get_by_role("link", name="New page").click()
        page.get_by_label("Title").fill(TITLE)
        text = page.get_by_label("Text (Markdown)")
        text.fill(BODY + "The decision: ")
        text.press("End")
        # The link picker: keyboard only, filtered to objects of this project.
        text.press("Control+k")
        picker = page.get_by_role("dialog", name="Link to something in this project")
        picker.get_by_role("combobox").fill("ToF distance")
        expect(picker.get_by_role("option").first).to_contain_text(RULE)
        picker.get_by_role("combobox").press("Enter")
        expect(text).to_have_value(re.compile(re.escape(f"[{RULE}](flux:decision/{self.decision_id})")))
        # Both panes on a wide screen; the preview is rendered by the server.
        preview = page.get_by_label("Preview")
        expect(preview.get_by_role("heading", name="Numbers from the bench")).to_be_visible()
        expect(preview.locator("table td").nth(1)).to_have_text("38%")
        expect(preview.get_by_role("link", name=RULE)).to_have_attribute("data-ref-type", "decision")
        page.get_by_role("radio", name="Published").click()
        page.get_by_label("What changed").fill("First notes from the bench test")
        shot(page, "docs-editor-desktop-1440")
        text.press("Control+s")

        expect(page.get_by_role("heading", level=2, name=TITLE)).to_be_visible()
        stored = self.api(page, "GET", f"/api/v1/projects/{self.project_id}/docs", status=200)["items"]
        self.assertEqual(len(stored), 1)
        type(self).doc_id = stored[0]["id"]
        doc = self.doc(page)
        self.assertEqual((doc["version"], doc["state"], doc["reason"], doc["author"]["name"]), (1, "published", "First notes from the bench test", OWNER["name"]))
        self.assertTrue(any(link["role"] == "mentions" and link["to"]["id"] == self.decision_id for link in doc["links"]))
        expect(page.locator(".doc-head__k")).to_contain_text("Published · version 1")
        expect(page.locator(".doc-prose table")).to_be_visible()
        # A reference to a decision opens its details in the panel.
        page.locator(".doc-prose").get_by_role("link", name=RULE).click()
        expect(page.locator("#details").get_by_role("heading", name=RULE)).to_be_visible()
        expect(page.locator("#details")).to_contain_text(TITLE)
        page.keyboard.press("Escape")
        shot(page, "docs-reader-desktop-1440")

    # ---------------------------------------------------------------- concurrent edit

    def test_03_a_concurrent_edit_is_never_overwritten(self) -> None:
        page = self.page("partner")
        page.goto(f"/projects/{self.project_id}/docs/{self.doc_id}")
        page.get_by_role("link", name="Edit").click()
        text = page.get_by_label("Text (Markdown)")
        expect(text).to_have_value(re.compile("What we use"))
        text.fill(self.doc(page)["body"].replace("Two quick waves start the night light", "Two quick waves start the night light at 5% brightness"))
        page.get_by_label("What changed").fill("Night light brightness")
        # Meanwhile Ada saves a change of her own.
        owner = self.page("owner")
        theirs = self.doc(owner)["body"] + "\n## Open questions\n\n- Does the sensor see through a frosted shade?\n"
        self.api(owner, "PATCH", f"/api/v1/docs/{self.doc_id}", {"body": theirs, "reason": "Added open questions"}, status=200,
                 headers={"if-match": '"1"', "idempotency-key": str(uuid.uuid4())})
        page.get_by_role("button", name="Save version").click()
        conflict = page.get_by_role("alert")
        expect(conflict).to_contain_text("Ada Lind saved version 2 while you were editing")
        expect(conflict).to_contain_text("Nothing was overwritten")
        conflict.get_by_role("button", name="Show their changes and yours").click()
        expect(conflict.locator(".doc-diff__row--added")).to_contain_text(["## Open questions"])
        shot(page, "docs-conflict-desktop-1440")
        self.assertEqual(self.doc(page)["version"], 2, "the stale save changed nothing")
        # Kai keeps his text on top of Ada's version and carries her addition over himself.
        conflict.get_by_role("button", name="Keep my text on top of version 2").click()
        expect(page.get_by_role("alert")).to_have_count(0)
        text.fill(text.input_value().rstrip("\n") + "\n\n## Open questions\n\n- Does the sensor see through a frosted shade?\n")
        page.get_by_role("button", name="Save version").click()
        expect(page.locator(".doc-head__k")).to_have_text("Published · version 3")
        history = self.versions(page)
        self.assertEqual([item["reason"] for item in history], ["Night light brightness", "Added open questions", "First notes from the bench test"])
        v2 = self.api(page, "GET", f"/api/v1/docs/{self.doc_id}/versions/2", status=200)
        self.assertIn("Open questions", v2["body"], "Ada's version stays as she wrote it")
        self.assertNotIn("5% brightness", v2["body"])
        current = self.doc(page)["body"]
        self.assertIn("5% brightness", current)
        self.assertIn("frosted shade", current)

    # ---------------------------------------------------------------- history and diff

    def test_04_history_shows_every_version_and_a_diff(self) -> None:
        for viewport, name in ((DESKTOP, "1440"), (LAPTOP, "1280")):
            page = self.page("owner", viewport=viewport)
            page.goto(f"/projects/{self.project_id}/docs/{self.doc_id}")
            page.get_by_role("link", name=re.compile("^History")).click()
            versions = page.locator(".doc-versions > li")
            expect(versions).to_have_count(3)
            expect(versions.first).to_contain_text("Night light brightness")
            expect(versions.first).to_contain_text(PARTNER["name"])
            diff = page.get_by_label("Changes in the text")
            expect(diff.locator(".doc-diff__row--added ins")).to_contain_text(["at 5% brightness"])
            expect(diff.locator(".doc-diff__row--removed").first).to_contain_text("Two quick waves")
            page.get_by_label("Compare with").select_option("1")
            expect(page.get_by_role("heading", name="Version 1 → 3")).to_be_visible()
            expect(diff.locator(".doc-diff__row--added")).to_contain_text(["## Open questions"])
            shot(page, f"docs-history-desktop-{name}")
        # An earlier version reads as written, and says so.
        page.goto(f"/projects/{self.project_id}/docs/{self.doc_id}/versions/1")
        expect(page.locator(".doc-notice").first).to_contain_text("You are reading an earlier version")
        expect(page.locator(".doc-prose")).not_to_contain_text("Open questions")
        shot(page, "docs-reader-earlier-desktop-1280")

    # ---------------------------------------------------------------- from a result

    def test_05_add_a_result_to_the_doc(self) -> None:
        page = self.page("partner")
        page.goto(f"/projects/{self.project_id}/tasks")
        page.get_by_role("region", name=re.compile("^Results")).get_by_role("button", name=re.compile(FINDING)).click()
        panel = page.locator("#details")
        expect(panel).to_contain_text("Not in a doc yet.")
        panel.get_by_role("button", name="Add to docs").click()
        expect(panel.get_by_label("Doc", exact=True)).to_have_value(self.doc_id)
        shot(page, "docs-add-from-result-desktop-1440")
        panel.get_by_role("button", name="Add section").click()
        expect(page.get_by_role("heading", level=2, name=TITLE)).to_be_visible()
        expect(page.locator(".doc-head__why")).to_have_text(f"Added the result “{FINDING}”")
        expect(page.locator(".doc-prose").get_by_role("heading", name=f"Result: {FINDING}")).to_be_visible()
        expect(page.get_by_role("region", name=re.compile("^Added from"))).to_contain_text(FINDING)
        doc = self.doc(page)
        self.assertEqual(doc["version"], 4)
        self.assertTrue(any(link["role"] == "source" and link["to"]["id"] == self.result_id for link in doc["links"]))
        result = self.api(page, "GET", f"/api/v1/results/{self.result_id}", status=200)
        self.assertTrue(any(link["from"]["type"] == "doc" and link["from"]["id"] == self.doc_id for link in result["links"]))
        # The result now shows the doc it is in.
        page.goto(f"/projects/{self.project_id}/tasks")
        page.get_by_role("region", name=re.compile("^Results")).get_by_role("button", name=re.compile(FINDING)).click()
        expect(page.locator("#details").get_by_role("link", name=re.compile(TITLE))).to_be_visible()

    # ---------------------------------------------------------------- phone

    def test_06_phone_reads_edits_and_compares(self) -> None:
        page = self.page("partner", phone=True)
        page.goto(f"/projects/{self.project_id}/docs")
        row = page.get_by_role("link", name=re.compile(TITLE))
        expect(row).to_be_visible()
        self.assertGreaterEqual(row.bounding_box()["height"], 44, "touch target")
        shot(page, "docs-list-phone-390")
        row.tap()
        expect(page.get_by_role("heading", level=2, name=TITLE)).to_be_visible()
        scroll_width = page.evaluate("document.querySelector('.pane-scroll').scrollWidth - document.querySelector('.pane-scroll').clientWidth")
        self.assertLessEqual(scroll_width, 0, "no horizontal page scroll on the phone")
        shot(page, "docs-reader-phone-390")
        edit = page.get_by_role("link", name="Edit")
        self.assertGreaterEqual(edit.bounding_box()["height"], 44)
        edit.tap()
        text = page.get_by_label("Text (Markdown)")
        text.fill(text.input_value() + "\n## Next\n\n- Order two ToF sensors for the second lamp\n")
        page.get_by_role("button", name="Preview").tap()
        expect(page.get_by_label("Preview").get_by_role("heading", name="Next")).to_be_visible()
        shot(page, "docs-editor-preview-phone-390")
        page.get_by_role("button", name="Save version").tap()
        expect(page.locator(".doc-head__k")).to_have_text("Published · version 5")
        self.assertEqual(self.doc(page)["reason"], "Edited the text")
        page.get_by_role("link", name=re.compile("^History")).tap()
        expect(page.get_by_label("Changes in the text").locator(".doc-diff__row--added")).to_contain_text(["## Next"])
        shot(page, "docs-history-phone-390")

    # ---------------------------------------------------------------- hostile text

    def test_07_hostile_markdown_does_not_run(self) -> None:
        page = self.page("owner")
        body = ("<img src=x onerror=\"alert('img')\">\n\n[click me](javascript:alert('link'))\n\n"
                "<script>alert('script')</script>\n\n[data](data:text/html,<script>alert(1)</script>)\n\n"
                f"[missing](flux:doc/{uuid.uuid4()})")
        doc = self.api(page, "POST", f"/api/v1/projects/{self.project_id}/docs", {"title": "Pasted from an email", "body": body}, status=201)
        page.goto(f"/projects/{self.project_id}/docs/{doc['id']}")
        prose = page.locator(".doc-prose")
        expect(prose).to_contain_text("<script>alert('script')</script>")
        self.assertEqual(prose.locator("img, script, iframe").count(), 0)
        self.assertEqual(prose.locator("a").count(), 0, "no hostile link became clickable")
        expect(prose.locator(".doc-ref--missing")).to_have_text("missing")
        expect(page.locator(".doc-notice")).to_contain_text("not in this project or no longer exists")


if __name__ == "__main__":
    unittest.main()
