"""Words stay whole on small phones, narrow pages and large text (v0.2.1 UI audit: #1358, #1370, #1374), in the engine FLUX_UI_BROWSER names.

- #1358: every row of Settings › AI keeps its words whole at 320 to 430 px and on portrait tablets (800 and 820 px), where the section list takes
  a third of the window: a control drops under its label, names end in an ellipsis, a tag stays whole.
- #1370: with the root font size at 200 % (Android's font scale, large text; set before the page loads) the faces keep their letters inside their
  circles, the space's header keeps its slots (the people and Call fold into its ⋯ as on a narrow window), the phone's title row stays one row and
  the composer shows its whole hint on one line.
- #1374: at 320 and 360 px the composer's hint is one line, the Tasks search shows its whole word, a three-column Wiki table fits its card, and a
  schedule's four actions stay in one row.
"""
from __future__ import annotations

import os
import re
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright

from phone_audit import call, window
from test_app_shell import ORIGIN, UPSTREAM, start_forwarder

PASSWORD = "words stay whole"
STAMP = uuid.uuid4().hex[:8]
UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")
KEY = f"sk-ant-api03-{'phone-g1-text-' * 3}G102"

# A word of the page that a line break cuts in two ("Conne / cted"): its text node's word has client rects on two lines. A page of this app has no
# word too long for its line (an address, a path) in these places, so any broken word is a defect.
BROKEN_WORDS_JS = """(scope) => {
  const broken = [];
  const root = document.querySelector(scope) ?? document.body;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest('.ui-vh, [hidden], script, style, textarea')) continue;
    const style = getComputedStyle(parent);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    for (const match of node.textContent.matchAll(/\\S+/g)) {
      const range = document.createRange();
      range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
      const rects = [...range.getClientRects()].filter((q) => q.width > 0.5 && q.height > 0.5);
      if (rects.length < 2) continue;
      const tops = rects.map((q) => Math.round(q.top / 4));
      if (new Set(tops).size > 1) broken.push(match[0]);
    }
  }
  return broken;
}"""

# Whether a text's whole line fits a field's width (the hint of an empty field), measured in the field's own font.
FITS_JS = """(selector) => {
  const field = document.querySelector(selector);
  if (!field) return null;
  const style = getComputedStyle(field);
  const canvas = document.createElement('canvas').getContext('2d');
  canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const room = field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const width = canvas.measureText(field.placeholder).width;
  const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
  return { hint: field.placeholder, width: Math.ceil(width), room: Math.floor(room), height: field.getBoundingClientRect().height, oneLine: Math.ceil(line + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)) };
}"""

# Every face (a circle with letters): do its letters stay inside it?
FACES_JS = """() => {
  const out = [];
  for (const face of document.querySelectorAll('.ui-avatar, .ws-av, .tb-av, .ref-chip__face, .wiki-face, .sr__ic--person')) {
    const circle = face.getBoundingClientRect();
    if (circle.width < 8 || circle.height < 8) continue;
    const text = [...face.childNodes].find((node) => node.nodeType === 3 && node.textContent.trim());
    if (!text) continue;
    const range = document.createRange(); range.selectNodeContents(text);
    const letters = range.getBoundingClientRect();
    out.push({ face: face.className, letters: text.textContent.trim(), circle: [Math.round(circle.width), Math.round(circle.height)], inside:
      letters.left >= circle.left - 0.5 && letters.right <= circle.right + 0.5 && letters.top >= circle.top - 1 && letters.bottom <= circle.bottom + 1 });
  }
  return out;
}"""


class PhoneTextFit(unittest.TestCase):
    """Tests run in name order and share one account (Ada) with a company, a space, agents with a schedule and a Wiki page with a table."""

    pw = None
    ids: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)
        context = cls.browser.new_context(base_url=ORIGIN)
        email = f"ada.fit+{STAMP}@example.test"
        response = context.request.post("/api/auth/sign-up/email", data={"name": "Ada Kowalska", "email": email, "password": PASSWORD}, headers={"origin": ORIGIN})
        assert response.status == 200, response.text()
        cls.state = context.storage_state()
        context.close()
        ada = cls.pw.request.new_context(base_url=ORIGIN, storage_state=cls.state, extra_http_headers={"origin": ORIGIN})
        workspace = call(ada, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, 201)
        project = call(ada, "POST", f"/api/v1/workspaces/{workspace['id']}/projects", {"name": "Community garden sensors", "visibility": "restricted"}, 201)
        cls.ids.update(workspace=workspace["id"], project=project["id"])
        for title in ("Order six capacitive probes", "Write the watering rota for December"):
            call(ada, "POST", f"/api/v1/projects/{project['id']}/work", {"title": title}, 201)
        for body in ("Are you at the garden this afternoon? I have the ladder.", "Yes, and the spare cable.", "@Ada Kowalska the volunteer rota is in the Wiki now"):
            call(ada, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())}, 201)
        table = "| Day | Beds | Who |\n| --- | --- | --- |\n| Monday | Raised beds, fence side | Basia |\n| Thursday | Raised beds, far east | Jonas |\n| Saturday | All beds, by the sensors | Everyone |\n"
        page = call(ada, "POST", f"/api/v1/projects/{project['id']}/docs", {"title": "Volunteer rota", "body": f"This month\n\n{table}"}, 201)
        cls.ids["page"] = page["id"]
        call(ada, "POST", "/api/v1/background-compute-connections", {"name": "Ada's Anthropic key", "provider": "anthropic", "model": "claude-sonnet-5",
             "apiKey": KEY, "dailyBudgetCents": 500, "timeZone": "Europe/Warsaw"}, 201)
        call(ada, "POST", "/api/v1/my-agents", {"workspaceId": workspace["id"], "name": "Planner", "instructions": "Split a task into 3 to 5 steps."}, 201)
        mine = call(ada, "GET", "/api/v1/my-agents")["items"]
        cls.ids["assistant"] = next(item["id"] for item in mine if item["name"] == "Assistant")
        call(ada, "POST", f"/api/v1/my-agents/{cls.ids['assistant']}/schedules", {"title": "Monday plan", "text": "Say what the garden space has to do this week",
             "schedule": {"kind": "daily", "at": "08:00"}, "timeZone": "Europe/Warsaw"}, 201)
        ada.dispose()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, width: int, height: int, *, kind: str = "phone", text: int | None = None):
        context = window(self.pw, self.browser, UI_BROWSER, ORIGIN, self.state, width, height, kind=kind, text=text)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        return page

    def no_sideways_scroll(self, page, where: str) -> None:
        self.assertLessEqual(page.evaluate("() => document.documentElement.scrollWidth"), page.viewport_size["width"], f"{where}: the page does not scroll sideways")

    # ------------------------------------------------------------------------------------------------------------------
    # #1358
    # ------------------------------------------------------------------------------------------------------------------

    def test_01_settings_ai_keeps_whole_words(self) -> None:
        for width, height, kind in ((320, 640, "phone"), (375, 667, "phone"), (430, 932, "phone"), (820, 1180, "tablet"), (800, 1280, "tablet")):
            with self.subTest(width=width):
                page = self.page(width, height, kind=kind)
                page.goto("/settings/agents")
                expect(page.get_by_role("list", name="Your agents").get_by_role("link", name=re.compile("^Assistant"))).to_be_visible()
                self.assertEqual(page.evaluate(BROKEN_WORDS_JS, "main"), [], f"Settings › AI at {width}: no word is broken across lines")
                self.no_sideways_scroll(page, f"Settings › AI at {width}")
                # The connection card reads as one line of words: its name, then "Connected".
                card = page.locator("[data-connection]").first
                expect(card).to_contain_text("Connected")
                # A tag stays whole, inside its pill.
                tag = page.locator(".agl__tag").first
                self.assertEqual(tag.evaluate("(el) => el.getBoundingClientRect().height"), 20, "the tag is one line high")

    def test_02_the_agent_page_head_keeps_its_words(self) -> None:
        page = self.page(320, 640)
        page.goto("/settings/agents")
        page.get_by_role("list", name="Your agents").get_by_role("link", name=re.compile("^Planner")).click()
        expect(page.get_by_role("heading", name="Planner", level=2)).to_be_visible()
        self.assertEqual(page.evaluate(BROKEN_WORDS_JS, ".agp__head"), [], "the agent page's head keeps its words at 320")
        sub = page.locator(".agp__sub")
        self.assertGreaterEqual(sub.evaluate("(el) => el.getBoundingClientRect().width"), 200, "its line is not squeezed beside Message Planner")

    # ------------------------------------------------------------------------------------------------------------------
    # #1370
    # ------------------------------------------------------------------------------------------------------------------

    def large_text_conversation(self, width: int, height: int, kind: str):
        page = self.page(width, height, kind=kind, text=200)
        page.goto(f"/projects/{self.ids['project']}")
        expect(page.get_by_text("I have the ladder.").first).to_be_visible()
        self.assertEqual(page.evaluate("() => parseFloat(getComputedStyle(document.documentElement).fontSize)"), 32, "the root font size is 200 %")
        return page

    def assert_faces_whole(self, page, where: str) -> None:
        faces = page.evaluate(FACES_JS)
        self.assertTrue(faces, f"{where}: faces are on the page")
        self.assertEqual([face for face in faces if not face["inside"]], [], f"{where}: every face keeps its letters inside its circle")

    def test_03_large_text_on_the_computer(self) -> None:
        page = self.large_text_conversation(1440, 900, "computer")
        self.assert_faces_whole(page, "the conversation at 1440, 200 % text")
        # The header keeps its slots: the name and the views stay, and the people and Call are in ⋯ as on a narrow window.
        header = page.locator("header.top")
        expect(header.get_by_role("heading", level=1, name="Community garden sensors")).to_be_visible()
        expect(header.get_by_role("tablist", name="Space views")).to_be_visible()
        header.get_by_role("button", name="More").click()
        menu = page.locator(".top__more-menu").first
        expect(menu.get_by_role("menuitem", name="People")).to_be_visible()
        expect(menu.get_by_role("menuitem", name=re.compile("^Call"))).to_be_visible()
        page.keyboard.press("Escape")
        # The composer shows its whole hint on one line.
        fit = page.evaluate(FITS_JS, ".composer__box textarea")
        self.assertLessEqual(fit["width"], fit["room"], f"the hint fits its line: {fit}")
        self.assertLessEqual(fit["height"], fit["oneLine"] + 2, f"the composer is one line high: {fit}")
        self.no_sideways_scroll(page, "1440, 200 % text")

    def test_04_large_text_on_the_phone(self) -> None:
        page = self.large_text_conversation(390, 844, "phone")
        self.assert_faces_whole(page, "the conversation at 390, 200 % text")
        header = page.locator("header.phead")
        expect(header.get_by_role("heading", level=1)).to_be_visible()
        # The title row is Back, the name and ⋯, in that order and not over one another.
        boxes = [header.get_by_role("button", name=name).bounding_box() for name in ("Back", "More")] + [header.get_by_role("heading", level=1).bounding_box()]
        back, more, title = boxes
        self.assertLessEqual(back["x"] + back["width"], title["x"] + 1, "Back ends before the name starts")
        self.assertLessEqual(title["x"] + title["width"], more["x"] + 1, "the name ends before ⋯ starts")
        fit = page.evaluate(FITS_JS, ".composer__box textarea")
        self.assertLessEqual(fit["width"], fit["room"], f"the composer's hint fits its line: {fit}")
        self.assertLessEqual(fit["height"], fit["oneLine"] + 2, f"the composer is one line high: {fit}")
        self.no_sideways_scroll(page, "390, 200 % text")
        # A direct message and an agent's chat take the same text size.
        page.goto(f"/agents/{self.ids['assistant']}")
        expect(page.locator("header.phead").get_by_role("heading", level=1, name="Assistant")).to_be_visible()
        self.no_sideways_scroll(page, "an agent's chat at 390, 200 % text")

    # ------------------------------------------------------------------------------------------------------------------
    # #1374
    # ------------------------------------------------------------------------------------------------------------------

    def test_05_the_composer_hint_is_one_line_on_a_small_phone(self) -> None:
        for width, height in ((320, 640), (360, 800)):
            page = self.page(width, height)
            page.goto(f"/projects/{self.ids['project']}")
            expect(page.get_by_text("I have the ladder.").first).to_be_visible()
            page.wait_for_function("() => document.querySelector('.composer__box textarea')")
            fit = page.evaluate(FITS_JS, ".composer__box textarea")
            self.assertLessEqual(fit["width"], fit["room"], f"the hint fits its line at {width}: {fit}")
            self.assertLessEqual(fit["height"], fit["oneLine"] + 2, f"the composer is one line high at {width}: {fit}")
            self.assertTrue(fit["hint"].startswith("Message"), fit)

    def test_06_the_tasks_search_and_a_wiki_table_are_not_cut(self) -> None:
        page = self.page(320, 640)
        page.goto(f"/projects/{self.ids['project']}/tasks")
        search = page.get_by_label("Search tasks")
        expect(search).to_be_visible()
        fit = page.evaluate(FITS_JS, ".tb-search input")
        self.assertLessEqual(fit["width"], fit["room"], f"the Tasks search shows its whole hint at 320: {fit}")
        bar = page.locator(".tb-bar").bounding_box()
        self.assertLessEqual(bar["x"] + bar["width"], 320, "the control row is inside the window")
        page.goto(f"/projects/{self.ids['project']}/docs/{self.ids['page']}")
        table = page.locator(".doc-table").first
        expect(table).to_be_visible()
        self.assertLessEqual(table.evaluate("(el) => el.scrollWidth - el.clientWidth"), 1, "a three-column table fits its card at 320, so no cell is cut")
        self.no_sideways_scroll(page, "a Wiki page at 320")

    def test_07_a_schedule_s_four_actions_stay_in_one_row(self) -> None:
        for width, height in ((320, 640), (375, 667)):
            page = self.page(width, height)
            page.goto(f"/agents/{self.ids['assistant']}")
            page.locator("[data-schedules-header] button").first.click()
            names = ["Pause Monday plan", "Change Monday plan", "Run Monday plan now", "Delete Monday plan"]
            boxes = [page.get_by_role("button", name=name, exact=True).bounding_box() for name in names]
            self.assertEqual(len({round(box["y"]) for box in boxes}), 1, f"Pause, Change, Run now and Delete are one row at {width}: {boxes}")
            for box in boxes:
                self.assertGreaterEqual(box["height"], 44)


if __name__ == "__main__":
    unittest.main()
