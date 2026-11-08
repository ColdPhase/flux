"""The Wiki as drawn (#869, design guide "Wiki"): two columns, the title as the page switcher, Contents and ⋯.

Checks the page at 1440x900 and 390x844 in light and dark: there is no pages column and no "On this page" column; the
title opens the space's pages with "Find a page" and "+ New page"; the row above the title keeps its controls in the
same places with one page or many; Contents lists the page's headings (or says "No headings yet") and scrolls to the
one chosen; ⋯ holds the page's actions. The text is edited where it is read: test_wiki_panes covers writing,
History and import, test_live_editing two people at once.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder
from wiki_text import existing_text, wait_until_shared

STAMP = int(time.time() * 1000)
PERSON = {"name": "Ada Kowalska", "email": f"ada.wikifinal+{STAMP}@example.test"}
PASSWORD = "wiki as drawn keeps its shape"
BODY = ("Six capacitive probes send readings over LoRa to one gateway in the shed.\n\n## Parts\n\n"
        "| Part | Qty |\n| --- | ---: |\n| Probe | 6 |\n\n## Range\n\nThe far bed sits 180 m away.\n\n## Power\n\nBatteries last a season.\n")
PAGES = ("Overview", "Hardware", "Sensor placement", "Volunteer guide")
ACTIONS = ["History", "Copy link", "Export", "Import a Markdown file", "Rename page"]


def api_of(page):
    def api(method, path, body=None, headers=None):
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, data=json.dumps(body) if body is not None else None,
                                      headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})})
        assert response.status < 300, response.text()
        return json.loads(response.text() or "{}")
    return api


class WikiFinal(unittest.TestCase):
    browser: Browser
    state: dict
    project_id = ""
    doc_id = ""

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, os.environ.get("FLUX_UI_BROWSER", "chromium")).launch()
        expect.set_options(timeout=8000)
        ctx = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
        page = ctx.new_page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill(PERSON["name"])
        page.get_by_label("Email").fill(PERSON["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        api = api_of(page)
        ws = api("POST", "/api/v1/workspaces", {"name": "Garden"})
        project = api("POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Community garden sensors", "visibility": "restricted"})
        cls.project_id = project["id"]
        for title in PAGES:
            doc = api("POST", f"/api/v1/projects/{project['id']}/docs", {"title": title, "body": BODY}, {"idempotency-key": str(uuid.uuid4())})
            if title == "Hardware":
                cls.doc_id = doc["id"]
        header = "| " + " | ".join(f"Column {i}" for i in range(1, 17)) + " |\n| " + " | ".join("---" for _ in range(16)) + " |\n"
        row = "| " + " | ".join(f"cell {i}" for i in range(1, 16)) + " | LAST |\n"
        cls.wide_id = api("POST", f"/api/v1/projects/{project['id']}/docs", {"title": "Wide table", "body": "Sixteen columns.\n\n" + header + row},
                          {"idempotency-key": str(uuid.uuid4())})["id"]
        cls.plain_id = api("POST", f"/api/v1/projects/{project['id']}/docs", {"title": "Notes without headings", "body": "Only one paragraph here."},
                           {"idempotency-key": str(uuid.uuid4())})["id"]
        # A space with exactly one page: the title row stays where it is with fifty.
        alone = api("POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Single page space", "visibility": "restricted"})
        cls.alone_url = f"/projects/{alone['id']}/docs/" + api("POST", f"/api/v1/projects/{alone['id']}/docs", {"title": "Hardware", "body": BODY},
                                                               {"idempotency-key": str(uuid.uuid4())})["id"]
        cls.state = ctx.storage_state()
        ctx.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def open(self, viewport, theme, touch=False, path=None):
        options = dict(base_url=ORIGIN, viewport=viewport, storage_state=self.state, color_scheme=theme, locale="en-GB")
        if touch:
            options.update(is_mobile=True, has_touch=True, device_scale_factor=2)
        context = self.browser.new_context(**options, service_workers="block")
        self.addCleanup(context.close)
        context.add_init_script(f"localStorage.setItem('flux.theme', '{theme}')")
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        page.goto(path or f"/projects/{self.project_id}/docs/{self.doc_id}")
        expect(page.locator(".wiki-page").get_by_role("heading", level=2)).to_be_visible()
        wait_until_shared(page)
        return page

    def test_computer_two_columns_switcher_and_contents(self) -> None:
        for theme in ("light", "dark"):
            with self.subTest(theme=theme):
                page = self.open(DESKTOP, theme)
                # Two columns: the sidebar and the page. No pages column, no "On this page" column.
                expect(page.get_by_role("navigation", name="Wiki pages")).to_have_count(0)
                expect(page.get_by_role("complementary", name="On this page")).to_have_count(0)
                expect(page.get_by_role("button", name=re.compile("Focus on the page"))).to_have_count(0)
                expect(page.get_by_role("button", name="Write")).to_have_count(0)
                expect(page.get_by_role("button", name="Preview")).to_have_count(0)
                self.assertEqual(page.locator(".wiki-editor").evaluate("e => getComputedStyle(e).fontSize"), "15px")
                self.assertLessEqual(page.locator(".wiki-page").bounding_box()["width"], 760.5)
                expect(page.locator(".wiki-head__meta").filter(has_text=re.compile(r"^Saved · "))).to_be_visible()
                # "Saving…" and "Saved" are not announced at every pause: the save state is in no live region (#950).
                self.assertEqual(page.evaluate("""() => [...document.querySelectorAll('[role=status], [role=alert], [aria-live]:not([aria-live=off])')]
                  .filter((region) => /Sav(ed|ing)/.test(region.textContent)).length"""), 0)
                # The title is the page switcher.
                title = page.get_by_role("heading", level=2, name="Hardware").get_by_role("button", name="Hardware")
                expect(title).to_have_attribute("aria-haspopup", "dialog")
                title.click()
                pages = page.get_by_role("dialog", name="Pages in Community garden sensors")
                expect(pages.get_by_label("Find a page")).to_be_focused()
                expect(pages.get_by_role("link")).to_have_text(["Hardware", "Notes without headings", "Overview", "Sensor placement", "Volunteer guide", "Wide table"])
                expect(pages.get_by_role("link", name="Hardware")).to_have_attribute("aria-current", "page")
                expect(pages.get_by_role("button", name="New page")).to_be_visible()
                pages.get_by_label("Find a page").fill("sens")
                expect(pages.get_by_role("link")).to_have_text(["Sensor placement"])
                shot(page, f"wiki-final-switcher-1440-{theme}")
                page.keyboard.press("Enter")
                expect(page.get_by_role("heading", level=2, name="Sensor placement")).to_be_visible()
                expect(page).to_have_url(re.compile(r"/docs/[0-9a-f-]{36}$"))
                page.go_back()
                expect(page.get_by_role("heading", level=2, name="Hardware")).to_be_visible()
                # Contents: the page's headings; choosing one scrolls the page to it.
                contents = page.get_by_role("button", name="Contents")
                contents.click()
                menu = page.get_by_role("menu", name="Contents")
                expect(menu.get_by_role("menuitem")).to_have_text(["Parts", "Range", "Power"])
                menu.get_by_role("menuitem", name="Power").click()
                expect(menu).to_have_count(0)
                expect(contents).to_be_focused()
                # The page's ⋯: the page's own actions, nothing else.
                page.get_by_role("button", name="Page actions").click()
                expect(page.get_by_role("menu", name="Page actions").get_by_role("menuitem")).to_have_text(ACTIONS)
                shot(page, f"wiki-final-desktop-1440-{theme}")
                page.keyboard.press("Escape")
                expect(page.get_by_role("button", name="Page actions")).to_be_focused()

    def test_the_title_row_keeps_its_places_with_one_page_or_many(self) -> None:
        def places(page):
            controls = {"title": page.locator(".wiki-page").get_by_role("heading", level=2).get_by_role("button"), "contents": page.get_by_role("button", name="Contents"),
                        "actions": page.get_by_role("button", name="Page actions")}
            return {name: (round(box["x"]), round(box["y"])) for name, box in ((name, control.bounding_box()) for name, control in controls.items())}
        for size in (DESKTOP, PHONE):
            with self.subTest(width=size["width"]):
                many = places(self.open(size, "light", touch=size is PHONE))
                one = places(self.open(size, "light", touch=size is PHONE, path=self.alone_url))
                self.assertEqual(many, one, "the switcher, Contents and ⋯ are in the same places with one page or six")

    def test_contents_without_headings_says_so(self) -> None:
        page = self.open(DESKTOP, "light", path=f"/projects/{self.project_id}/docs/{self.plain_id}")
        page.get_by_role("button", name="Contents").click()
        menu = page.get_by_role("menu", name="Contents")
        expect(menu).to_contain_text("No headings yet")
        expect(menu.get_by_role("menuitem")).to_have_count(0)

    def test_contents_respects_the_persons_reduce_motion_choice_and_system(self) -> None:
        page = self.open(DESKTOP, "light")
        body = "## Start\n\n" + ("A season of field measurements needs careful notes.\n\n" * 70) + "## Last readings\n\nKeep the last reading reachable.\n"
        api = api_of(page)
        target = f"/projects/{self.project_id}/docs/" + api("POST", f"/api/v1/projects/{self.project_id}/docs", {"title": "Field readings", "body": body},
                                                             {"idempotency-key": str(uuid.uuid4())})["id"]
        # Observe the requested scroll and its effect, while keeping the native method.
        page.context.add_init_script("""(() => {
          const original = Element.prototype.scrollTo;
          window.contentsScrolls = [];
          Element.prototype.scrollTo = function(options) {
            const before = this.scrollTop;
            const result = original.call(this, options);
            if (this.classList.contains('wiki-main') && options?.behavior !== undefined) window.contentsScrolls.push({behavior: options.behavior, before, after: this.scrollTop});
            return result;
          };
        })()""")

        def jump(expected):
            page.goto(target)
            wait_until_shared(page)
            page.get_by_role("button", name="Contents").click()
            page.get_by_role("menu", name="Contents").get_by_role("menuitem", name="Last readings").click()
            page.wait_for_function("window.contentsScrolls.length > 0")
            event = page.evaluate("window.contentsScrolls[0]")
            self.assertEqual(event["behavior"], expected, event)
            if expected == "auto":
                self.assertGreater(event["after"] - event["before"], 1000, "the jump settles at once")
            page.wait_for_function("document.querySelector('.wiki-main').scrollTop > 1000")
            heading = page.locator(".cm-line", has_text="Last readings")
            expect(heading).to_be_in_viewport()

        page.emulate_media(reduced_motion="no-preference")
        jump("smooth")
        page.goto("/settings")
        switch = page.get_by_role("switch", name="Reduce motion")
        switch.click()
        expect(switch).to_have_attribute("aria-checked", "true")
        jump("auto")
        page.goto("/settings")
        page.get_by_role("switch", name="Reduce motion").press("Space")
        expect(page.get_by_role("switch", name="Reduce motion")).to_have_attribute("aria-checked", "false")
        page.emulate_media(reduced_motion="reduce")
        jump("auto")

    def test_wide_table_scrolls_inside_its_card(self) -> None:
        for size in ({"width": 320, "height": 640}, PHONE, {"width": 820, "height": 900}):
            with self.subTest(width=size["width"]):
                page = self.open(size, "light", touch=size["width"] < 600, path=f"/projects/{self.project_id}/docs/{self.wide_id}")
                card = page.locator(".doc-table")
                expect(card).to_have_count(1)
                self.assertGreater(card.evaluate("e => e.scrollWidth - e.clientWidth"), 100, "the table is wider than its card")
                self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), size["width"], "the page does not widen")
                card.evaluate("e => { e.scrollLeft = e.scrollWidth; }")
                last = page.get_by_role("cell", name="LAST")
                box, frame = last.bounding_box(), card.bounding_box()
                self.assertLessEqual(box["x"] + box["width"], frame["x"] + frame["width"] + 1, "the last column is reachable")
                self.assertGreaterEqual(box["x"], frame["x"] - 1)

    def test_phone_page(self) -> None:
        for theme in ("light", "dark"):
            with self.subTest(theme=theme):
                page = self.open(PHONE, theme, touch=True)
                header = page.locator("header.phead")
                expect(header.get_by_role("heading", level=1, name="Community garden sensors", exact=True)).to_be_visible()
                expect(page.get_by_role("navigation", name="Wiki pages")).to_have_count(0)
                expect(header.get_by_role("button", name="Page actions")).to_have_count(0)  # the header is the same in every view (#507)
                for control in (page.locator(".wiki-page").get_by_role("heading", level=2).get_by_role("button"), page.get_by_role("button", name="Contents"),
                                page.get_by_role("button", name="Page actions")):
                    self.assertGreaterEqual(control.bounding_box()["height"], 44, "a 44 px target")
                self.assertEqual(page.locator(".wiki-editor").evaluate("e => [getComputedStyle(e).fontSize, getComputedStyle(e).lineHeight]"), ["16px", "25px"])
                self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"])
                page.locator(".wiki-page").get_by_role("heading", level=2).get_by_role("button").tap()
                pages = page.get_by_role("dialog", name="Pages in Community garden sensors")
                expect(pages.get_by_role("link", name="Hardware")).to_have_attribute("aria-current", "page")
                box = pages.bounding_box()
                self.assertGreaterEqual(box["x"], 0)
                self.assertLessEqual(box["x"] + box["width"], PHONE["width"])
                shot(page, f"wiki-final-phone-390-{theme}")
                page.keyboard.press("Escape")
                # Writing happens on the page: a tap into the text puts the caret there.
                existing_text(page).locator(".cm-line").first.tap()
                expect(existing_text(page)).to_be_focused()

    def test_phone_copy_link_refusal_keeps_the_exact_link(self) -> None:
        # #933: the phone's ⋯ is the page's own menu (#869); a refused copy leaves the exact link, selected, on the page.
        page = self.open(PHONE, "light", touch=True)
        page.evaluate("Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new DOMException('Test browser refusal', 'NotAllowedError')) } })")
        more = page.get_by_role("button", name="Page actions")
        more.click()
        page.get_by_role("menu", name="Page actions").get_by_role("menuitem", name="Copy link").click()
        link = page.get_by_role("group", name="Link to this page")
        field = link.get_by_label("Link to this page")
        expect(field).to_have_value(f"{ORIGIN}/projects/{self.project_id}/docs/{self.doc_id}")
        expect(field).to_be_focused()
        self.assertTrue(field.evaluate("e => e.selectionStart === 0 && e.selectionEnd === e.value.length"))
        expect(link.get_by_role("status")).to_contain_text("The browser did not allow copying")
        link.get_by_role("button", name="Done").click()
        expect(link).to_have_count(0)
        expect(more).to_be_focused()

    def test_phone_page_actions_hold_only_the_pages_actions(self) -> None:
        # #933: the space's controls (Call, its details and people) live in the space header since #869 and #873; the page's ⋯
        # holds the page's actions in the same order as on the computer.
        page = self.open(PHONE, "light", touch=True)
        more = page.get_by_role("button", name="Page actions")
        more.click()
        menu = page.get_by_role("menu", name="Page actions")
        expect(menu.get_by_role("menuitem")).to_have_text(ACTIONS)
        self.assertTrue(page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
        box = menu.bounding_box()
        self.assertLessEqual(box["x"] + box["width"], PHONE["width"])
        page.keyboard.press("Escape")
        expect(menu).to_have_count(0)
        expect(more).to_be_focused()

    def test_table_regions_never_reparse_literal_attribute_text(self) -> None:
        page = self.open(DESKTOP, "light")
        literal = '<table onmouseover="window.__tableAttributeExecuted = true"> literal </table>'
        # Well-formed HTML may keep '<' in a quoted title while escaping its quotes.
        # This response variant tests client composition, not a server-sanitizer bypass.
        title = literal.replace('"', '&quot;')
        rendered = (f'<p><a href="/inbox" title="{title}">Literal table title</a></p>'
                    '<table><thead><tr><th>Part</th></tr></thead><tbody><tr><td>Probe</td></tr></tbody></table>')

        def reader(route):
            response = route.fetch()
            data = response.json()
            data['html'] = rendered
            route.fulfill(response=response, json=data)

        # A saved version is read as the server rendered it.
        page.route(re.compile(r'.*/api/v1/docs/' + re.escape(self.doc_id) + '$'), reader)
        page.goto(f"/projects/{self.project_id}/docs/{self.doc_id}/versions/1")
        prose = page.locator('.doc-prose')
        expect(prose.get_by_role('link', name='Literal table title')).to_have_attribute('title', literal)
        expect(prose.locator('table')).to_have_count(1)
        expect(prose.locator('.doc-table')).to_have_count(1)
        expect(prose.locator('.doc-table')).to_have_attribute('role', 'region')
        expect(prose.locator('.doc-table')).to_have_attribute('tabindex', '0')
        expect(prose.locator('[onmouseover]')).to_have_count(0)
        self.assertFalse(page.evaluate('Boolean(window.__tableAttributeExecuted)'))


class WikiReferences(unittest.TestCase):
    """Task and decision references in a page, and a reference that is not in the project."""

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, os.environ.get("FLUX_UI_BROWSER", "chromium")).launch()
        expect.set_options(timeout=8000)
        ctx = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
        page = ctx.new_page()
        email = f"ada.wikirefs+{STAMP}@example.test"
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Ada Kowalska")
        page.get_by_label("Email").fill(email)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        api = api_of(page)
        ws = api("POST", "/api/v1/workspaces", {"name": "Garden refs"})
        project = api("POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Refs garden", "visibility": "restricted"})
        other = api("POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Elsewhere", "visibility": "restricted"})
        pid = project["id"]
        task = api("POST", f"/api/v1/projects/{pid}/work", {"title": "Order the probes", "status": "in_progress"})
        accepted = api("POST", f"/api/v1/projects/{pid}/decisions", {"title": "Measure soil moisture first"})
        api("POST", f"/api/v1/decisions/{accepted['id']}/accept", {"expectedVersion": accepted["version"]})
        proposed = api("POST", f"/api/v1/projects/{pid}/decisions", {"title": "Add frost warnings later"})
        parts = api("POST", f"/api/v1/projects/{pid}/docs", {"title": "Parts list", "body": "The bench list."}, {"idempotency-key": str(uuid.uuid4())})
        foreign = api("POST", f"/api/v1/projects/{other['id']}/work", {"title": "Not in this project"})
        agent = api("POST", f"/api/v1/workspaces/{ws['id']}/agents", {"name": "Alex", "owner": "self"})
        cls.agent_id = agent["id"]
        cls.task_id, cls.task_version = task["id"], task["version"]
        cls.proposed_id, cls.proposed_version = proposed["id"], proposed["version"]
        body = (f"Intro.\n\n[Measure soil moisture first](flux:decision/{accepted['id']})\n\n"
                f"[Add frost warnings later](flux:decision/{proposed['id']})\n\n## Parts\n\n"
                f"Probes: [Order the probes](flux:work/{task['id']}) and [Elsewhere](flux:work/{foreign['id']}).\n\n"
                f"The parts are in [Parts list](flux:doc/{parts['id']}).\n")
        doc = api("POST", f"/api/v1/projects/{pid}/docs", {"title": "References", "body": body}, {"idempotency-key": str(uuid.uuid4())})
        cls.url = f"/projects/{pid}/docs/{doc['id']}"
        cls.number = task["number"]
        cls.state = ctx.storage_state()
        ctx.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def other_session(self, method, path, body):
        context = self.browser.new_context(base_url=ORIGIN, service_workers="block", storage_state=self.state)
        self.addCleanup(context.close)
        response = context.request.fetch(f"{ORIGIN}{path}", method=method, data=json.dumps(body),
                                         headers={"origin": ORIGIN, "content-type": "application/json"})
        self.assertLess(response.status, 300, response.text())
        return json.loads(response.text() or "{}")

    def read(self, viewport, touch=False, theme="light"):
        options = dict(base_url=ORIGIN, viewport=viewport, storage_state=self.state, color_scheme=theme, locale="en-GB")
        if touch:
            options.update(is_mobile=True, has_touch=True, device_scale_factor=2)
        context = self.browser.new_context(**options, service_workers="block")
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto(self.url)
        expect(page.get_by_role("heading", level=2, name="References")).to_be_visible()
        return page

    def check(self, page, name, phone):
        page_ref = page.locator('a.doc-page')
        expect(page_ref).to_contain_text('Parts list')
        expect(page_ref.locator('svg')).to_have_count(1)
        task = page.locator("a.doc-task")
        expect(task).to_have_count(1)
        expect(task.locator("svg.ui-glyph--in_progress")).to_have_count(1)
        expect(task).to_contain_text(f"#{self.number}")
        expect(task).to_contain_text("Doing")
        card = page.locator("a.doc-decision")
        expect(card).to_have_count(2)
        first = card.first
        expect(first).to_contain_text("Decision accepted")
        expect(first).to_contain_text("Measure soil moisture first")
        if not phone:
            expect(first.locator(".doc-decision__meta")).to_contain_text("Ada Kowalska")
            expect(first.locator(".doc-decision__meta")).to_contain_text(re.compile(r"\d{1,2} \w{3}|\w{3} \d{1,2}"))
        expect(card.nth(1)).to_contain_text("Decision proposed")
        for reference in (task, card.first, card.nth(1)):
            expect(reference).not_to_have_css("background-color", "rgba(0, 0, 0, 0)")
        # A reference that is not in this project stays plain text, without a glyph or card.
        missing = page.locator(".doc-ref--missing")
        expect(missing).to_have_count(1)
        expect(missing.locator("svg")).to_have_count(0)
        shot(page, name)

    def test_computer(self) -> None:
        page = self.read(DESKTOP)
        self.check(page, "wiki-refs-desktop-1440", False)
        # A card in the page opens its decision, as in reading.
        page.locator("a.doc-decision").first.click()
        expect(page.locator("#details")).to_contain_text("Measure soil moisture first")

    def test_phone_dark(self) -> None:
        self.check(self.read(PHONE, touch=True, theme="dark"), "wiki-refs-phone-390-dark", True)

    def test_a_failed_read_is_retried_without_a_reload(self) -> None:
        context = self.browser.new_context(base_url=ORIGIN, service_workers="block", viewport=DESKTOP, storage_state=self.state)
        self.addCleanup(context.close)
        page = context.new_page()
        calls = []

        def flaky(route):
            calls.append(1)
            route.abort() if len(calls) == 1 else route.continue_()
        page.route("**/work-reference-rows?**", flaky)
        page.goto(self.url)
        expect(page.get_by_role("heading", level=2, name="References")).to_be_visible()
        expect(page.locator('a.doc-page svg')).to_have_count(1)
        # The plain links stay until the read answers; the retry marks them, once each.
        expect(page.locator("a.doc-task")).to_have_count(1, timeout=15000)
        expect(page.locator("a.doc-task .doc-task__mark")).to_have_count(1)
        expect(page.locator("a.doc-decision")).to_have_count(2)

    def test_zz_marks_follow_the_objects_while_the_page_is_unchanged(self) -> None:
        page = self.read(DESKTOP)
        expect(page.locator("a.doc-task svg.ui-glyph--in_progress")).to_have_count(1)
        expect(page.locator("a.doc-decision").nth(1)).to_contain_text("Decision proposed")
        self.other_session("PATCH", f"/api/v1/work/{self.task_id}", {"status": "done", "expectedVersion": self.task_version})
        self.other_session("POST", f"/api/v1/decisions/{self.proposed_id}/accept", {"expectedVersion": self.proposed_version})
        # The page's own refresh (focus), no reload and no change to the page's text.
        page.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(page.locator("a.doc-task svg.ui-glyph--done")).to_have_count(1)
        expect(page.locator("a.doc-task")).to_contain_text("Done")
        expect(page.locator("a.doc-decision").nth(1)).to_contain_text("Decision accepted")
        expect(page.locator("a.doc-task .doc-task__mark")).to_have_count(1)
        expect(page.locator("a.doc-task .doc-task__word")).to_have_count(1)
        expect(page.locator("a.doc-decision .doc-decision__body")).to_have_count(2)

    def test_agents_keep_their_tag_and_owner_on_a_card(self) -> None:
        context = self.browser.new_context(base_url=ORIGIN, service_workers="block", viewport=DESKTOP, storage_state=self.state)
        self.addCleanup(context.close)
        page = context.new_page()
        agent = {"kind": "agent", "id": self.agent_id, "name": "Alex"}

        def rows(route):
            data = route.fetch().json()
            for item in data["items"]:
                if item["kind"] == "decision":
                    item["proposedBy"], item["decidedBy"] = agent, None
                    item["status"], item["decidedAt"] = "proposed", None
            route.fulfill(json=data)
        page.route("**/work-reference-rows?**", rows)
        page.goto(self.url)
        expect(page.locator("a.doc-decision").first.locator(".doc-decision__meta .agent-tag")).to_have_count(1)
        expect(page.locator("a.doc-decision").first.locator(".doc-decision__meta .agent-for")).to_have_text("for Ada Kowalska")

    def test_history_names_an_agent_author_in_the_timeline(self) -> None:
        """An agent's version reads "name · agent" in the timeline (#511). The author is stubbed in the list
        response: a real agent write is not part of this module's fixtures."""
        context = self.browser.new_context(base_url=ORIGIN, service_workers="block", viewport=DESKTOP, storage_state=self.state)
        self.addCleanup(context.close)
        page = context.new_page()
        agent = {"kind": "agent", "id": self.agent_id, "name": "Alex"}

        def versions(route):
            data = route.fetch().json()
            data["items"][0]["author"] = agent
            route.fulfill(json=data)
        page.route(re.compile(r".*/api/v1/docs/[0-9a-f-]{36}/versions(\?.*)?$"), versions)
        page.goto(f"{self.url}/history")
        expect(page.locator(".doc-versions > li").first).to_contain_text("Alex · agent")


if __name__ == "__main__":
    unittest.main()
