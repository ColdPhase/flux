"""Browser tests for a space's Wiki pages (issue #112, AC-3/AC-5; #869).

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose
application. Two people share one space. One writes a page where it is read, with a link to a
decision, and the version saves by itself; the other writes at the same time and nothing is lost
(with live editing both see each other's text; without it the later save meets the earlier one and
the person chooses); both read the history with a diff; a decision is added to the page from its
details; the phone writes and compares. Every step is checked against the API, so the test proves
persisted behaviour rather than local state.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from app_select import choose, expect_value

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder
from wiki_text import existing_text, has_text, saved, wait_until_shared

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
LIVE = os.environ.get('FLUX_LIVE_EDITING', 'on') != 'off'


class DocsJourney(unittest.TestCase):
    """Tests run in name order and share two accounts and one project."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    project_id: str = ""
    finding_id: str = ""
    decision_id: str = ""
    doc_id: str = ""

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        if cls.browser.browser_type.name != UI_BROWSER:
            raise AssertionError('The Docs journey must use the requested browser engine')
        print(f'ACTUAL_UI_ENGINE={cls.browser.browser_type.name}; mode={"on" if LIVE else "off"}', flush=True)
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
        return page.get_by_role("navigation", name="Space views").get_by_role("link", name=name)

    def saved_doc(self, page: Page, snippet: str, timeout: float = 60.0, doc_id: str | None = None) -> dict:
        """The page once a saved version holds `snippet`: versions save by themselves when the typing rests (#869)."""
        deadline = time.monotonic() + timeout
        while True:
            doc = self.doc(page, doc_id)
            if snippet in doc["body"] or time.monotonic() > deadline:
                self.assertIn(snippet, doc["body"], "a version saved by itself")
                return doc
            time.sleep(0.25)

    def type_end(self, page: Page, value: str) -> None:
        text = existing_text(page)
        wait_until_shared(page)
        text.focus()
        page.keyboard.press("Control+End")
        page.keyboard.insert_text(value)

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
        self.assertEqual(self.api(owner, "GET", "/api/v1/live-editing/capabilities", status=200),
                         {"status": "configured" if LIVE else "unavailable"})
        ws = self.api(owner, "POST", "/api/v1/workspaces", {"name": "Lamp studio"}, status=201)
        self.api(owner, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": PARTNER["email"], "role": "member"}, status=201)
        project = self.api(owner, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Gesture lamp", "visibility": "restricted"}, status=201)
        self.api(owner, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "human", "id": PARTNER["id"]}, "role": "contributor"}, status=201)
        type(self).project_id = project["id"]
        base = f"/api/v1/projects/{project['id']}"
        self.api(owner, "POST", f"{base}/conversations", {"body": "Camera or distance sensor? Let us test both in the dark.", "clientMessageId": str(uuid.uuid4())}, status=201)
        partner = self.page("partner")
        finding = self.api(partner, "POST", f"{base}/decisions", {"title": FINDING, "rationale": "38% of 20 gestures at 5 lux over two evenings."}, status=201)
        self.api(owner, "POST", f"/api/v1/decisions/{finding['id']}/accept", {}, status=200, headers={"if-match": '"1"'})
        type(self).finding_id = finding["id"]
        rule = self.api(owner, "POST", f"{base}/decisions", {"title": RULE, "rationale": "It works in the dark and draws a sixth of the power."}, status=201)
        self.api(owner, "POST", f"/api/v1/decisions/{rule['id']}/accept", {}, status=200, headers={"if-match": '"1"'})
        type(self).decision_id = rule["id"]

    # ---------------------------------------------------------------- write, preview, link, publish

    def test_02_write_a_page_in_place_with_a_link(self) -> None:
        page = self.page("owner")
        page.goto(f"/projects/{self.project_id}")
        self.tab(page, "Wiki").click()
        expect(page.get_by_role("heading", name="No pages yet")).to_be_visible()
        page.get_by_role("button", name="New page").click()
        page.get_by_role("textbox", name="Name of the new page").fill(TITLE)
        page.keyboard.press("Enter")
        expect(page.get_by_role("heading", level=2, name=TITLE)).to_be_visible()
        text = existing_text(page)
        wait_until_shared(page)
        expect(text).to_be_focused()
        page.keyboard.insert_text(BODY + "The decision: ")
        # The link picker: keyboard only, filtered to objects of this space.
        page.keyboard.press("Control+k")
        picker = page.get_by_role("dialog", name="Link to something in this space")
        picker.get_by_role("combobox", name="Find a Wiki page, decision, task, map or message", exact=True).fill("ToF distance")
        expect(picker.get_by_role("listbox", name="Matches").get_by_role("option").first).to_contain_text(RULE)
        picker.get_by_role("combobox", name="Find a Wiki page, decision, task, map or message", exact=True).press("Enter")
        has_text(text, f"[{RULE}](flux:decision/{self.decision_id})")
        expect(text).to_be_focused()
        shot(page, "docs-writing-desktop-1440")
        stored = self.api(page, "GET", f"/api/v1/projects/{self.project_id}/docs", status=200)["items"]
        self.assertEqual(len(stored), 1)
        type(self).doc_id = stored[0]["id"]
        doc = self.saved_doc(page, f"flux:decision/{self.decision_id}")
        self.assertEqual((doc["reason"], doc["author"]["name"]), ("Edited the text", OWNER["name"]))
        self.assertTrue(any(link["role"] == "mentions" and link["to"]["id"] == self.decision_id for link in doc["links"]))
        # Away from the caret the page reads as the page: the table is a table, the reference is its chip.
        text.evaluate("el => el.blur()")
        expect(page.locator(".wiki-editor .doc-table td").nth(1)).to_have_text("38%")
        expect(page.locator(".wiki-editor .cm-md-h2").first).to_have_text("What we use")
        chip = page.locator('.wiki-editor a.doc-ref[data-ref-type="decision"]')
        expect(chip).to_have_text(RULE)
        # A reference to a decision opens its details in the panel.
        chip.click()
        expect(page.locator("#details").get_by_role("heading", name=RULE)).to_be_visible()
        expect(page.locator("#details")).to_contain_text(TITLE)
        page.keyboard.press("Escape")
        shot(page, "docs-reader-desktop-1440")

    # ---------------------------------------------------------------- two people at once

    def test_03_two_people_write_at_once_and_nothing_is_lost(self) -> None:
        if LIVE:
            self.shared_concurrent_edit()
            return
        page = self.page("partner")
        page.goto(f"/projects/{self.project_id}/docs/{self.doc_id}")
        wait_until_shared(page)
        # Meanwhile Ada saves a change of her own.
        owner = self.page("owner")
        before = self.doc(owner)
        theirs = before["body"] + "\n## Open questions\n\n- Does the sensor see through a frosted shade?\n"
        self.api(owner, "PATCH", f"/api/v1/docs/{self.doc_id}", {"body": theirs}, status=200,
                 headers={"if-match": f'"{before["version"]}"', "idempotency-key": str(uuid.uuid4())})
        self.type_end(page, "\nKai checked the power readings.\n")
        conflict = page.get_by_role("alert").filter(has_text="saved this page while you were writing")
        expect(conflict).to_contain_text(OWNER["name"])
        expect(conflict).to_contain_text("Your text is still here")
        # What Keep does, and theirs to compare first (#946 review B2).
        expect(conflict).to_contain_text("“Keep my text” saves your text as the next version, in place of theirs.")
        expect(conflict.get_by_role("link", name="See their change")).to_have_attribute(
            "href", f"/projects/{self.project_id}/docs/{self.doc_id}/history?from={before['version']}&to={before['version'] + 1}")
        expect(page.locator(".wiki-head__meta").filter(has_text="Not saved · this page changed")).to_be_visible()
        shot(page, "docs-conflict-desktop-1440")
        self.assertEqual(self.doc(page)["version"], before["version"] + 1, "the stale save changed nothing")
        # Kai keeps his text on top of Ada's version and carries her addition over himself.
        conflict.get_by_role("button", name="Keep my text").click()
        expect(conflict).to_have_count(0)
        # The version that holds Kai's text says whose version it replaced (#967).
        deadline = time.monotonic() + 15
        while True:
            kept = page.request.get(f"{ORIGIN}/api/v1/docs/{self.doc_id}/versions/{before['version'] + 2}")
            if kept.status == 200 or time.monotonic() > deadline:
                break
            time.sleep(0.25)
        self.assertEqual(kept.json()["reason"], f"In place of {OWNER['name']}’s version {before['version'] + 1}")
        self.type_end(page, "\n## Open questions\n\n- Does the sensor see through a frosted shade?\n")
        deadline = time.monotonic() + 60  # the next version follows the 30 s spacing
        while True:
            current = self.doc(page)
            if ("Kai checked the power readings." in current["body"] and "frosted shade" in current["body"]) or time.monotonic() > deadline:
                break
            time.sleep(0.25)
        self.assertIn("Kai checked the power readings.", current["body"])
        self.assertIn("frosted shade", current["body"])
        self.assertIn("Open questions", self.api(page, "GET", f"/api/v1/docs/{self.doc_id}/versions/{before['version'] + 1}", status=200)["body"],
                      "Ada's version stays as she wrote it")
        # Kai changes the agreed text; the next version holds it.
        existing_text(page).focus()
        page.keyboard.press("Control+a")
        page.keyboard.insert_text(current["body"].replace("Two quick waves start the night light", "Two quick waves start the night light at 5% brightness"))
        self.saved_doc(page, "5% brightness")

    def shared_concurrent_edit(self) -> None:
        """Normal installation: both people see each other's text as it is typed, and the saved versions keep both."""
        partner, owner = self.page("partner"), self.page("owner")
        url = f"/projects/{self.project_id}/docs/{self.doc_id}"
        for page in (partner, owner):
            page.goto(url)
            expect(page.locator('[data-live-status="live"]')).to_be_visible()
        theirs, mine = existing_text(owner), existing_text(partner)
        self.type_end(partner, "\nKai checked the power readings.\n")
        self.type_end(owner, "\n## Open questions\n\n- Does the sensor see through a frosted shade?\n")
        for field in (mine, theirs):
            expect(field).to_contain_text("Kai checked the power readings.")
            expect(field).to_contain_text("frosted shade")
        expect(owner.get_by_role("status").filter(has_text="Kai is here too")).to_be_visible()
        current = self.saved_doc(owner, "frosted shade")
        current = self.saved_doc(owner, "Kai checked the power readings.")
        self.assertIn("frosted shade", current["body"])
        versions = self.versions(owner)
        self.assertTrue(all(item["reason"] == "Edited the text" for item in versions[:-1]), versions)
        names = {actor["name"] for item in versions for actor in item.get("contributors", [])}
        self.assertEqual(names, {OWNER["name"], PARTNER["name"]}, "each saved version names who wrote in it")
        saved_before = current["version"]
        earlier = self.api(owner, "GET", f"/api/v1/docs/{self.doc_id}/versions/{saved_before}", status=200)
        # Kai changes the agreed text later; the version saved before stays as it was.
        mine.focus()
        partner.keyboard.press("Control+a")
        partner.keyboard.insert_text(current["body"].replace("Two quick waves start the night light", "Two quick waves start the night light at 5% brightness"))
        expect(theirs).to_contain_text("at 5% brightness")
        latest = self.saved_doc(partner, "5% brightness", timeout=60)
        self.assertIn("frosted shade", latest["body"])
        self.assertGreater(latest["version"], saved_before)
        self.assertEqual(self.api(owner, "GET", f"/api/v1/docs/{self.doc_id}/versions/{saved_before}", status=200)["body"], earlier["body"])
        self.assertNotIn("5% brightness", earlier["body"])

    # ---------------------------------------------------------------- history and diff

    def test_04_history_shows_every_version_and_a_diff(self) -> None:
        for viewport, name in ((DESKTOP, "1440"), (LAPTOP, "1280")):
            page = self.page("owner", viewport=viewport)
            page.goto(f"/projects/{self.project_id}/docs/{self.doc_id}/history")
            versions = page.locator(".doc-versions > li")
            expect(versions).to_have_count(len(self.versions(page)))
            expect(versions.first).to_contain_text("Edited the text")
            expect(versions.first).to_contain_text(PARTNER["name"])
            diff = page.get_by_label("Changes in the text")
            # The rendered comparison reads as the page: added words are marked where they stand, headings are headings.
            expect(diff.locator("li", has_text="Two quick waves")).to_contain_text("at 5% brightness")
            expect(diff.locator("li ins")).to_contain_text(["at 5% brightness"])
            choose(page.get_by_label("Compare with"), "1")
            expect(page.get_by_role("heading", name=re.compile("^v1 → v"))).to_be_visible()
            expect(diff.locator(".wiki-chg--added", has_text="Open questions")).to_have_count(1)
            shot(page, f"docs-history-desktop-{name}")
        # An earlier version reads as written, and says so.
        page.goto(f"/projects/{self.project_id}/docs/{self.doc_id}/versions/1")
        expect(page.locator(".doc-notice").first).to_contain_text("You are reading an earlier version")
        expect(page.locator(".wiki-body")).not_to_contain_text("Open questions")
        shot(page, "docs-reader-earlier-desktop-1280")

    # ---------------------------------------------------------------- from a decision

    def test_05_add_a_decision_to_the_doc(self) -> None:
        page = self.page("partner")
        before = self.doc(page)["version"]
        page.goto(f"/projects/{self.project_id}/tasks?open=decision:{self.finding_id}")
        panel = page.locator("#details")
        expect(panel).not_to_contain_text("Shown on the Wiki page")  # a decision on no page says nothing about the Wiki (#871)
        panel.get_by_role("button", name="Add to a Wiki page").click()
        expect_value(panel.get_by_label("Wiki page", exact=True), self.doc_id)
        shot(page, "docs-add-from-decision-desktop-1440")
        panel.get_by_role("button", name="Add the card").click()
        # The form closes back to the decision with one toast; Open leads to the page (#763 D4).
        expect(page.get_by_text(f"Added to “{TITLE}”")).to_be_visible()
        page.get_by_role("button", name="Open", exact=True).click()
        expect(page.get_by_role("heading", level=2, name=TITLE)).to_be_visible()
        doc = self.doc(page)
        self.assertEqual((doc["version"], doc["reason"]), (before + 1, f"Added the decision “{FINDING}”"))
        self.assertIn(f"[{FINDING}](flux:decision/{self.finding_id})", doc["body"])
        self.assertTrue(any(link["role"] == "source" and link["to"]["id"] == self.finding_id for link in doc["links"]))
        decision = self.api(page, "GET", f"/api/v1/decisions/{self.finding_id}", status=200)
        self.assertTrue(any(link["from"]["type"] == "doc" and link["from"]["id"] == self.doc_id for link in decision["links"]))
        # The decision now shows the doc it is in.
        page.goto(f"/projects/{self.project_id}/tasks?open=decision:{self.finding_id}")
        expect(page.locator("#details").get_by_role("link", name=re.compile(TITLE))).to_be_visible()

    # ---------------------------------------------------------------- phone

    def test_06_phone_writes_and_compares(self) -> None:
        page = self.page("partner", phone=True)
        page.goto(f"/projects/{self.project_id}/docs")
        expect(page.get_by_role("heading", level=2, name=TITLE)).to_be_visible()
        scroll_width = page.evaluate("document.querySelector('.pane-scroll').scrollWidth - document.querySelector('.pane-scroll').clientWidth")
        self.assertLessEqual(scroll_width, 0, "no horizontal page scroll on the phone")
        shot(page, "docs-reader-phone-390")
        wait_until_shared(page)
        existing_text(page).locator(".cm-line").last.tap()
        page.keyboard.press("Control+End")
        page.keyboard.insert_text("\n## Next\n\n- Order two ToF sensors for the second lamp\n")
        doc = self.saved_doc(page, "Order two ToF sensors")
        self.assertEqual(doc["reason"], "Edited the text")
        expect(saved(page)).to_be_visible()
        shot(page, "docs-writing-phone-390")
        page.get_by_role("button", name="Page actions").tap()
        page.get_by_role("menu", name="Page actions").get_by_role("menuitem", name="History").tap()
        expect(page.get_by_label("Changes in the text").locator(".wiki-chg--added")).to_contain_text(["Next"])
        shot(page, "docs-history-phone-390")

    # ---------------------------------------------------------------- hostile text

    def test_07_hostile_markdown_does_not_run(self) -> None:
        page = self.page("owner")
        body = ("<img src=x onerror=\"alert('img')\">\n\n[click me](javascript:alert('link'))\n\n"
                "<script>alert('script')</script>\n\n[data](data:text/html,<script>alert(1)</script>)\n\n"
                f"[missing](flux:doc/{uuid.uuid4()})")
        doc = self.api(page, "POST", f"/api/v1/projects/{self.project_id}/docs", {"title": "Pasted from an email", "body": body}, status=201)
        page.goto(f"/projects/{self.project_id}/docs/{doc['id']}")
        wait_until_shared(page)
        # Written where it is read, the page is its text: nothing in it becomes an element that runs.
        prose = page.locator(".wiki-editor")
        expect(prose).to_contain_text("<script>alert('script')</script>")
        # CodeMirror's own zero-size `img.cm-widgetBuffer` marks are its, not the text's.
        self.assertEqual(prose.locator("img:not(.cm-widgetBuffer), script, iframe, [onerror]").count(), 0)
        self.assertEqual(prose.locator("a").count(), 0, "no hostile link became clickable")
        expect(prose.locator(".doc-ref--missing")).to_have_text("missing")
        # The saved version reads as the server sanitized it, and says which link leads nowhere.
        page.goto(f"/projects/{self.project_id}/docs/{doc['id']}/versions/1")
        prose = page.locator(".doc-prose")
        expect(prose).to_contain_text("<script>alert('script')</script>")
        self.assertEqual(prose.locator("img, script, iframe").count(), 0)
        self.assertEqual(prose.locator("a").count(), 0, "no hostile link became clickable")
        expect(page.locator(".doc-notice", has_text="not in this space or no longer exists")).to_be_visible()

    # ---------------------------------------------------------------- history reads like the page (#511)

    def test_08_history_reads_like_the_page_and_keeps_the_exact_text(self) -> None:
        owner = self.page("owner")
        first = ("## Sensors\n\n- Capacitive soil probe\n- DS18B20 probe\n\n## Radio\n\n"
                 "The far beds report over LoRa. Range is not tested yet.\n\n| Bed | Distance |\n| --- | ---: |\n| Far east | 120 m |\n")
        second = ("## Sensors\n\n- Capacitive soil probe\n- DS18B20 probe\n- Shed gateway\n\n## Radio\n\n"
                  "The far beds report over LoRa. Two sensors reached the gateway from 140 m.\n\n| Bed | Distance |\n| --- | ---: |\n| Far east | 140 m |\n| Shed | 60 m |\n")
        doc = self.api(owner, "POST", f"/api/v1/projects/{self.project_id}/docs", {"title": "Garden radio", "body": first}, status=201)
        self.api(owner, "PATCH", f"/api/v1/docs/{doc['id']}", {"body": second}, status=200,
                 headers={"if-match": '"1"', "idempotency-key": str(uuid.uuid4())})
        page = self.page("owner")
        page.goto(f"/projects/{self.project_id}/docs/{doc['id']}")
        wait_until_shared(page)
        page_h2 = page.locator(".wiki-editor .cm-md-h2").first.evaluate("el => getComputedStyle(el).fontSize + '/' + getComputedStyle(el).fontWeight")
        page.get_by_role("button", name="Page actions").click()
        page.get_by_role("menu", name="Page actions").get_by_role("menuitem", name="History").click()

        # AC-2: versions are a timeline (version, summary, author, date); the header reads "v1 → v2 · +N −M".
        versions = page.locator(".doc-versions > li")
        expect(versions).to_have_count(2)
        expect(versions.first).to_contain_text("Edited the text")
        expect(versions.first).to_contain_text(f"v2 · {OWNER['name']}")
        expect(versions.last).to_contain_text("v1 · ")
        expect(page.get_by_role("heading", name=re.compile(r"^v1 → v2 · \+\d+ −\d+$"))).to_be_visible()
        expect(page.locator(".doc-versions .doc-version[aria-current='true']")).to_contain_text("Edited the text")

        # AC-1: the changes are the page itself, in its typography: headings, a list, a table.
        diff = page.get_by_label("Changes in the text")
        expect(diff.locator(".doc-prose h2")).to_have_text(["Sensors", "Radio"])
        self.assertEqual(diff.locator(".doc-prose h2").first.evaluate("el => getComputedStyle(el).fontSize + '/' + getComputedStyle(el).fontWeight"), page_h2)
        expect(diff.locator("li.wiki-chg--added")).to_have_text(["Shed gateway"])
        expect(diff.locator("p ins")).to_have_text(["Two sensors reached the gateway from 140 m"])
        expect(diff.locator("p del")).to_have_text(["Range is not tested yet"])
        table = diff.locator(".doc-table table")
        expect(table).to_have_count(1)
        expect(table.locator("th")).to_have_text(["Bed", "Distance"])
        expect(table.locator("td ins")).to_have_text(["140"])
        expect(table.locator("td del")).to_have_text(["120"])
        expect(table.locator("tr.wiki-chg--added")).to_contain_text("Shed")
        for raw in ("| ---", "## ", "- Shed gateway"):
            self.assertNotIn(raw, diff.inner_text(), "the rendered view shows no raw Markdown")
        # Added text has a soft fill and an underline; removed text is struck through in --t3.
        look = diff.locator("p ins").evaluate("""el => { const s = getComputedStyle(el); return { line: s.textDecorationLine, fill: s.backgroundColor }; }""")
        self.assertIn("underline", look["line"])
        self.assertNotIn(look["fill"], ("rgba(0, 0, 0, 0)", "transparent"))
        struck = diff.locator("p del").evaluate("""el => { const s = getComputedStyle(el); const probe = document.createElement('span'); probe.style.color = 'var(--t3)'; document.body.append(probe);
            const t3 = getComputedStyle(probe).color; probe.remove(); return { line: s.textDecorationLine, color: s.color, t3 }; }""")
        self.assertIn("line-through", struck["line"])
        self.assertEqual(struck["color"], struck["t3"], "removed text is --t3")
        shot(page, "wiki-history-rendered-desktop-1440-light")

        # AC-2: "Rendered | Markdown" keeps the exact text.
        rendered = page.get_by_role("button", name="Rendered")
        markdown = page.get_by_role("button", name="Markdown", exact=True)
        expect(rendered).to_have_attribute("aria-pressed", "true")
        markdown.click()
        expect(markdown).to_have_attribute("aria-pressed", "true")
        expect(page.locator(".doc-diff__row--added")).to_contain_text(["- Shed gateway"])
        expect(page.locator(".doc-diff__row--added", has_text="| Shed | 60 m |")).to_have_count(1)
        expect(diff.locator(".doc-prose")).to_have_count(0)
        shot(page, "wiki-history-markdown-desktop-1440-light")
        rendered.click()
        expect(diff.locator(".doc-prose h2")).to_have_count(2)
        page.emulate_media(color_scheme="dark")
        shot(page, "wiki-history-rendered-desktop-1440-dark")
        page.emulate_media(color_scheme="light")

        # Restore brings the earlier text back as the page, for everyone writing in it, as the next version that says so.
        page.get_by_role("button", name="Restore version 1").click()
        expect(page.get_by_text("Version 1 is the page again.")).to_be_visible(timeout=15000)
        expect(page).to_have_url(re.compile(re.escape(f"/docs/{doc['id']}") + "$"))
        restored = self.doc(owner, doc["id"])
        self.assertEqual((restored["version"], restored["body"], restored["reason"]), (3, first, "Restored version 1"))

        # The phone reads the same comparison in one column, without sideways scrolling.
        phone = self.page("owner", phone=True)
        phone.goto(f"/projects/{self.project_id}/docs/{doc['id']}/history?from=2&to=3")
        changes = phone.get_by_label("Changes in the text")
        expect(changes.locator(".doc-prose h2")).to_have_text(["Sensors", "Radio"])
        expect(phone.get_by_role("heading", name=re.compile(r"^v2 → v3"))).to_be_visible()
        self.assertLessEqual(phone.evaluate("document.documentElement.scrollWidth"), PHONE["width"])
        shot(phone, "wiki-history-rendered-phone-390-light")
        phone.emulate_media(color_scheme="dark")
        shot(phone, "wiki-history-rendered-phone-390-dark")

    def test_09_history_of_hostile_text_does_not_run(self) -> None:
        """The rendered comparison is built from the server's sanitized HTML only (#511): nothing in it runs."""
        page = self.page("owner")
        first = "Plain start.\n\n<img src=x onerror=\"alert('img')\">\n\n[click me](javascript:alert('link'))\n"
        second = first + "\n<script>alert('script')</script>\n\n| a | b |\n| --- | --- |\n| <b onmouseover=alert(1)>x</b> | y |\n"
        doc = self.api(page, "POST", f"/api/v1/projects/{self.project_id}/docs", {"title": "Hostile history", "body": first}, status=201)
        self.api(page, "PATCH", f"/api/v1/docs/{doc['id']}", {"body": second}, status=200,
                 headers={"if-match": '"1"', "idempotency-key": str(uuid.uuid4())})
        page.goto(f"/projects/{self.project_id}/docs/{doc['id']}/history")
        changes = page.get_by_label("Changes in the text")
        expect(changes).to_contain_text("<script>alert('script')</script>")
        self.assertEqual(changes.locator("img, script, iframe, [onerror], [onmouseover]").count(), 0)
        self.assertEqual(changes.locator("a").count(), 0, "no hostile link became clickable")


if __name__ == "__main__":
    unittest.main()
