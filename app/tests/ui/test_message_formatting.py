"""Browser test: a message shows bold, italic, inline code, code blocks, lists and quotes (#1247, F-026 §6 "Formatted text in a message").

One renderer draws the words of a message in a space, a direct message and an agent's answer. This module posts a message with every element
through the public API (the stored body is the Markdown text, unchanged), opens it in each place at 1440 and 390 px in light and dark, and
checks the drawn elements, the horizontal scroll and Copy of a code block, the keys Ctrl/⌘ B and I in the composer, the one-line preview and that
text that tries to become HTML stays text. The agent's answer comes from the TEST-ONLY mock provider (`FLUX_TEST_PERSONAL_RUNS=anthropic-mock`);
no real model is called, so what a real model writes under the new brief is not proved here. Chromium by default; `FLUX_UI_BROWSER=webkit` for WebKit.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import urllib.request
import uuid

from playwright.sync_api import Browser, BrowserContext, Locator, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, UI_BROWSER, shot, start_forwarder

MOCK = os.environ.get("FLUX_ANTHROPIC_MOCK_URL", "http://127.0.0.1:8090")
PASSWORD = "a calm long passphrase"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.format+{STAMP}@example.test"),
    "ben": ("Ben Okafor", f"ben.format+{STAMP}@example.test"),
}
KEY = f"sk-ant-api03-{'format-ui-one-' * 3}FM01"
CODE = "def reading(probe):\n    return probe.read()  # one long line that needs the block to scroll sideways on a phone, not the page"
# Every element of the subset, with a mention, a task, a Wiki page and an address inside the marks.
BODY = (
    "**Soil moisture** is low in *bed 4*, so run `calibrate --bed 4` before Friday.\n\n"
    "- Check the probe in **#12**\n"
    "- Ask @Ben Okafor about [[Calibration]]\n"
    "- Readings: *https://example.com/probes*\n\n"
    "1. Dry the probe\n"
    "2. Read it twice\n\n"
    "> Ben Okafor:\n"
    "> Sensors drop out when the hedge is wet\n\n"
    f"```python\n{CODE}\n```\n"
    "Not formatted: # a heading, <b>html</b>, [a link](https://example.test) and 2 * 3 * 4."
)
REPLY = "**Heads up:** the *hedge* is wet again, see `rain.log`."
HOSTILE = (
    '<img src=x onerror="window.__pwned=1"> <script>window.__pwned=2</script> [click](javascript:window.__pwned=3)\n'
    '**<b onmouseover="window.__pwned=4">bold?</b>** `</code><iframe src="javascript:window.__pwned=5"></iframe>`\n'
    "```html\n<a href=\"javascript:window.__pwned=6\" id=\"evil\">code</a>\n```"
)


def mock(path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"{MOCK}{path}", data=data, method="POST" if body is not None else "GET", headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read())


class MessageFormatting(unittest.TestCase):
    """Tests run in name order and share two accounts, one space, one direct message and one agent."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=15000)
        mock("/__script", {"reset": True, "text": BODY})
        for who, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"name": name, "email": email, "password": PASSWORD}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[who] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[who] = context.storage_state()
            context.close()
        ada = cls.browser.new_context(service_workers="block", base_url=ORIGIN, storage_state=cls.states["ada"])
        post = lambda path, body: ada.request.post(path, data=body, headers={"origin": ORIGIN})  # noqa: E731
        workspace = post("/api/v1/workspaces", {"name": "Format workshop"})
        assert workspace.status == 201, workspace.text()
        cls.ids["workspace"] = workspace.json()["id"]
        added = post(f"/api/v1/workspaces/{cls.ids['workspace']}/members", {"email": PEOPLE["ben"][1], "role": "member"})
        assert added.status == 201, added.text()
        project = post(f"/api/v1/workspaces/{cls.ids['workspace']}/projects", {"name": "Garden sensors", "visibility": "workspace"})
        assert project.status == 201, project.text()
        cls.ids["project"] = project.json()["id"]
        ada.close()

    @classmethod
    def tearDownClass(cls) -> None:
        mock("/__script", {"reset": True})
        cls.browser.close()
        cls.pw.stop()

    def context(self, who: str = "ada", *, phone: bool = False, dark: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "storage_state": self.states[who], "reduced_motion": "reduce"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(service_workers="block", **options)
        if UI_BROWSER == "chromium":
            context.grant_permissions(["clipboard-read", "clipboard-write"], origin=ORIGIN)
        self.addCleanup(context.close)
        return context

    def page(self, who: str = "ada", **kwargs) -> Page:
        page = self.context(who, **kwargs).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, who: str, method: str, path: str, body: dict | None = None, status: int = 200):
        context = self.context(who)
        response = context.request.fetch(path, method=method, headers={"origin": ORIGIN}, data=body)
        self.assertEqual(response.status, status, response.text())
        return response.json() if response.text() else None

    def tag(self, name: str) -> str:
        return f"{name}-{UI_BROWSER}"

    def look(self, page: Page, name: str, *, phone: bool, dark: bool) -> None:
        shot(page, self.tag(f"{name}-{'390' if phone else '1440'}-{'dark' if dark else 'light'}"))

    # ------------------------------------------------------------------------------------------------ what is drawn

    def check_drawn(self, body: Locator, *, phone: bool, copy: bool = False) -> None:
        """Every element of the subset is drawn, in the face and weight the design gives it, and no mark is left in the text."""
        text = body.inner_text()
        for raw in ("**", "```", "`calibrate", "*bed 4*", "\n- ", "\n1. ", "> Ben"):
            self.assertNotIn(raw, text, f"the mark {raw!r} is not shown")
        for shown in ("Soil moisture", "bed 4", "calibrate --bed 4", "Dry the probe", "Read it twice", "Sensors drop out when the hedge is wet", "def reading(probe):"):
            self.assertIn(shown, text)
        # What is not in the subset stays as typed.
        for typed in ("# a heading", "<b>html</b>", "[a link](https://example.test)", "2 * 3 * 4"):
            self.assertIn(typed, text)
        style = lambda element: element.evaluate("el => { const s = getComputedStyle(el); return { weight: Number(s.fontWeight), style: s.fontStyle, family: s.fontFamily, space: s.whiteSpace, size: parseFloat(s.fontSize) }; }")  # noqa: E731
        bold = body.locator("strong.msg-strong").first
        expect(bold).to_have_text("Soil moisture")
        self.assertGreaterEqual(style(bold)["weight"], 600)
        self.assertEqual(style(body.locator("em.msg-em").first)["style"], "italic")
        code = body.locator("code.msg-code")
        expect(code).to_have_text("calibrate --bed 4")
        self.assertIn("Mono", style(code)["family"])
        # References stay chips and links inside the marks; in code nothing is one.
        expect(body.locator("strong .ref-chip--task")).to_have_text("#12")
        expect(body.locator("li .ref-chip--wiki")).to_have_text("Calibration")
        expect(body.locator("em a.msg-link")).to_have_attribute("href", "https://example.com/probes")
        expect(body.locator("ul.msg-list > li")).to_have_count(3)
        expect(body.locator("ol.msg-list > li")).to_have_count(2)
        expect(body.locator("blockquote.msg-quote")).to_have_count(1)
        # The code block: mono, never wrapped, scrolling on its own region, and Copy.
        block = body.locator(".msg-codeblock")
        pre = block.locator("pre.msg-codeblock__pre")
        expect(block.locator(".msg-codeblock__lang")).to_have_text("python")
        expect(pre).to_have_text(CODE)
        figures = style(pre)
        self.assertEqual(figures["space"], "pre")
        self.assertIn("Mono", figures["family"])
        scroll = pre.evaluate("el => ({ wide: el.scrollWidth, shown: el.clientWidth })")
        if phone:
            self.assertGreater(scroll["wide"], scroll["shown"], "a long line scrolls sideways inside the block on a phone")
            pre.evaluate("el => { el.scrollLeft = 40; }")
            self.assertGreater(pre.evaluate("el => el.scrollLeft"), 0)
            pre.evaluate("el => { el.scrollLeft = 0; }")
        page_width = body.page.evaluate("() => ({ wide: document.documentElement.scrollWidth, shown: document.documentElement.clientWidth })")
        self.assertLessEqual(page_width["wide"], page_width["shown"], "the page itself does not scroll sideways")
        self.assertEqual(pre.get_attribute("tabindex"), "0", "the scrolling block can be reached with the keyboard")
        if copy:
            button = block.get_by_role("button", name="Copy code")
            button.click()
            expect(button).to_have_text("Copied")
            if UI_BROWSER == "chromium":
                self.assertEqual(body.page.evaluate("() => navigator.clipboard.readText()"), CODE)

    # ------------------------------------------------------------------------------------------------ a space

    def test_01_a_space_draws_the_message_and_stores_it_unchanged(self) -> None:
        sent = self.api("ada", "POST", f"/api/v1/projects/{self.ids['project']}/conversations", {"body": BODY, "clientMessageId": str(uuid.uuid4())}, status=201)
        self.assertEqual(sent["messages"][0]["body"], BODY, "the stored body is the typed text")
        self.api("ben", "POST", f"/api/v1/projects/{self.ids['project']}/conversations", {"body": REPLY, "clientMessageId": str(uuid.uuid4())}, status=201)
        for phone in (False, True):
            for dark in (False, True):
                page = self.page(phone=phone, dark=dark)
                page.goto(f"/projects/{self.ids['project']}")
                mine = page.locator(".message-body", has_text="Soil moisture").first
                expect(mine).to_be_visible()
                self.check_drawn(mine, phone=phone, copy=not dark and not phone)
                theirs = page.locator(".message-body", has_text="Heads up:")
                expect(theirs.locator("strong")).to_have_text("Heads up:")
                expect(theirs.locator("em")).to_have_text("hedge")
                expect(theirs.locator("code")).to_have_text("rain.log")
                mine.scroll_into_view_if_needed()
                self.look(page, "space", phone=phone, dark=dark)

    def test_02_copy_text_and_previews_drop_the_marks(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}")
        mine = page.locator(".project-convo__message", has=page.locator(".message-body", has_text="Soil moisture")).first
        mine.hover()
        mine.get_by_role("button", name="More").first.click()
        page.get_by_role("menuitem", name="Copy text").click()
        if UI_BROWSER == "chromium":
            copied = page.evaluate("() => navigator.clipboard.readText()")
            self.assertTrue(copied.startswith("Soil moisture is low in bed 4, so run calibrate --bed 4 before Friday."), copied)
            self.assertNotIn("**", copied)
            self.assertNotIn("```", copied)
            self.assertIn("- Check the probe in #12", copied)
            self.assertIn("1. Dry the probe", copied)
            self.assertIn(CODE, copied)

    # ------------------------------------------------------------------------------------------------ keys in the composer

    def test_03_ctrl_b_and_i_wrap_the_selection_and_take_the_marks_off(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}")
        field = page.get_by_label("Write a message")
        field.fill("make this bold now")
        field.evaluate("el => el.setSelectionRange(5, 9)")  # "this"
        field.press("Control+b")
        expect(field).to_have_value("make **this** bold now")
        self.assertEqual(field.evaluate("el => el.value.slice(el.selectionStart, el.selectionEnd)"), "this", "the words stay selected")
        field.press("Control+b")
        expect(field).to_have_value("make this bold now")
        field.press("Control+i")  # ⌘ on a Mac sends the same through `metaKey`
        expect(field).to_have_value("make *this* bold now")
        field.press("Control+i")
        expect(field).to_have_value("make this bold now")
        field.press("Meta+b")
        expect(field).to_have_value("make **this** bold now")
        field.evaluate("el => el.setSelectionRange(el.value.length, el.value.length)")
        field.press("Control+i")  # nothing selected: the pair of marks, caret between
        expect(field).to_have_value("make **this** bold now**")
        self.assertEqual(field.evaluate("el => el.selectionStart"), len("make **this** bold now*"))
        field.fill("")

    # ------------------------------------------------------------------------------------------------ a direct message

    def test_04_a_direct_message_draws_the_message_and_its_preview_is_plain(self) -> None:
        dm = self.api("ada", "POST", f"/api/v1/workspaces/{self.ids['workspace']}/dms", {"participantIds": [self.ids["ben"]]}, status=201)
        type(self).ids["dm"] = dm["id"]
        self.api("ada", "POST", f"/api/v1/dms/{self.ids['dm']}/messages", {"body": BODY, "clientMessageId": str(uuid.uuid4())}, status=201)
        for phone in (False, True):
            for dark in (False, True):
                page = self.page(phone=phone, dark=dark)
                page.goto(f"/dm/{self.ids['dm']}")
                body = page.locator(".dm-msg__body", has_text="Soil moisture").first
                expect(body).to_be_visible()
                self.check_drawn(body, phone=phone, copy=phone and not dark)
                self.look(page, "dm", phone=phone, dark=dark)
        page = self.page("ben")
        page.goto("/dm")
        preview = page.get_by_role("list", name="Conversations").locator(".dm-index__text span").first
        expect(preview).to_contain_text("Soil moisture is low in bed 4")
        self.assertNotIn("**", preview.inner_text())
        self.assertNotIn("```", preview.inner_text())

    # ------------------------------------------------------------------------------------------------ an agent's answer

    def test_05_an_agent_answer_is_drawn_like_a_message(self) -> None:
        page = self.page()
        self.api("ada", "POST", "/api/v1/background-compute-connections", {"name": "Ada's key", "provider": "anthropic", "model": "claude-sonnet-5",
                 "apiKey": KEY, "dailyBudgetCents": 500, "timeZone": "Europe/Warsaw"}, status=201)
        agent = self.api("ada", "GET", "/api/v1/my-agents")["items"][0]["id"]
        for phone in (False, True):
            for dark in (False, True):
                page = self.page(phone=phone, dark=dark)
                # The chat sends once it has read this agent's own status.
                with page.expect_response(lambda response: response.url.endswith(f"/api/v1/my-agents/{agent}/status") and response.status == 200):
                    page.goto(f"/agents/{agent}")
                page.wait_for_timeout(300)  # the response is in; React keeps it within a frame
                composer = page.get_by_role("textbox", name=re.compile(r"^Message "))
                expect(composer).to_be_visible()
                expect(page.get_by_text("Checking your assistant")).to_have_count(0)
                chat = page.get_by_role("list", name=re.compile(r"^Your chat with "))
                answers = chat.locator(".assistant-answer__body", has_text="Soil moisture")
                earlier = answers.count()
                composer.fill(f"What is on for the beds {'on the phone' if phone else 'today'}{' (dark)' if dark else ''}?")
                composer.press("Enter") if not phone else page.get_by_role("button", name="Send to Assistant").tap()
                expect(answers).to_have_count(earlier + 1, timeout=45000)
                answer = answers.last
                expect(answer).to_be_visible()
                self.check_drawn(answer, phone=phone)
                self.look(page, "agent-answer", phone=phone, dark=dark)

    # ------------------------------------------------------------------------------------------------ nothing runs

    def test_06_text_that_looks_like_html_or_a_script_stays_text(self) -> None:
        self.api("ben", "POST", f"/api/v1/projects/{self.ids['project']}/conversations", {"body": HOSTILE, "clientMessageId": str(uuid.uuid4())}, status=201)
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}")
        body = page.locator(".message-body", has_text="onerror").first
        expect(body).to_be_visible()
        # The hostile characters are on the page as words, and nothing in the message is an element it did not come from.
        text = body.inner_text()
        for typed in ('<img src=x onerror="window.__pwned=1">', "<script>window.__pwned=2</script>", "[click](javascript:window.__pwned=3)", '<b onmouseover="window.__pwned=4">bold?</b>',
                      '</code><iframe src="javascript:window.__pwned=5"></iframe>', '<a href="javascript:window.__pwned=6" id="evil">code</a>'):
            self.assertIn(typed, text)
        elements = body.evaluate("el => [...el.querySelectorAll('*')].map(node => node.tagName.toLowerCase())")
        self.assertEqual(sorted(set(elements) - {"strong", "code", "pre", "div", "span", "svg", "path", "rect", "button", "em", "ul", "ol", "li", "blockquote", "cite", "a"}), [],
                         f"only the renderer's own elements: {elements}")
        for risky in ("img", "script", "iframe", "object", "embed", "form", "input"):
            self.assertEqual(body.locator(risky).count(), 0, risky)
        self.assertEqual(body.evaluate("el => [...el.querySelectorAll('*')].flatMap(node => [...node.attributes].map(a => a.name)).filter(name => name.startsWith('on'))"), [])
        self.assertEqual(body.locator("a[href^='javascript']").count(), 0)
        self.assertIsNone(page.evaluate("() => window.__pwned ?? null"), "no hostile line ran")
        body.locator("strong").hover()
        self.assertIsNone(page.evaluate("() => window.__pwned ?? null"))


if __name__ == "__main__":
    unittest.main()
