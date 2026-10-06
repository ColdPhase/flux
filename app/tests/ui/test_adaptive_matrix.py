"""Adaptive work layouts from small phones to 4K and ultrawide (#151, F-015 ADAPT-1–ADAPT-4).

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose
application, on the shared realistic fixture in adaptive_fixture.py: two owners, a dense
conversation with a thread, a deep map, active and blocked tasks, wiki prose and three agent
connections (Hubert two, Marek one).

The same journey (Conversation → its thread → Map → List → Tasks → a task in Details → Wiki →
Agents → back) runs at every fixture width from 320 to 5120 CSS px. At each one: no sideways page
scroll, every primary action reachable and unclipped, prose within the readable measure, 44 px
primary targets on coarse pointers, and on wide screens the extra working context the contract
names (docked Details and thread, more cards per board row, all connections on one row).

The transition tests resize, rotate (swap width and height) and emulate a virtual keyboard by
reducing the viewport height during real work, and check that drafts, selection, the reading
anchor and the map camera survive with nothing saved or sent.

These are emulated CSS viewports at 100% browser zoom in headless Chromium. They are not evidence
for a physical 4K or ultrawide display, a real phone keyboard or OS scaling (docs/design/adaptive-
workspaces.md); those sessions remain separate acceptance evidence.
"""

from __future__ import annotations

import re
import unittest

from playwright.sync_api import Locator, Page, expect, sync_playwright

import adaptive_fixture as fx
from test_app_shell import BACK, ORIGIN, UPSTREAM, shot, start_forwarder

# Width × height fixtures (CSS px). Phones and tablets use a coarse (touch) pointer.
MATRIX = [(320, 568), (390, 844), (768, 1024), (1024, 768), (1440, 900), (1920, 1080), (2560, 1440), (3840, 2160), (5120, 1440)]
COARSE_UP_TO = 1024
SHOTS_AT = {320, 390, 768, 1440, 1920, 3840}
TABS = ["Conversation", "Map", "Tasks", "Wiki", "Agents"]
# The readable measure (proposed 2026-10-05, docs/design/adaptive-layout-rules.md): at most 90
# characters, spaces included, on any rendered line of prose.
MEASURE = 90
TARGET = 44

FIXTURE: dict = {}
# The longest measured line per prose surface and viewport, printed after the matrix as evidence.
MEASURED: dict[str, dict[str, int]] = {}
PW = None
BROWSER = None


def setUpModule() -> None:  # noqa: N802 (unittest hook)
    global PW, BROWSER
    if UPSTREAM:
        start_forwarder(ORIGIN, UPSTREAM)
    PW = sync_playwright().start()
    BROWSER = PW.chromium.launch()
    expect.set_options(timeout=10000)
    FIXTURE.update(fx.seed(BROWSER))


def tearDownModule() -> None:  # noqa: N802
    if BROWSER:
        BROWSER.close()
    if PW:
        PW.stop()


# The longest rendered line, in characters (spaces included), over every line of each element.
LONGEST_LINE = r"""(selector) => {
  let longest = 0, sample = '';
  for (const el of document.querySelectorAll(selector)) {
    if (!el.getClientRects().length) continue;
    const lines = new Map();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let i = 0; i < node.textContent.length; i++) {
        const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
        const box = range.getBoundingClientRect();
        if (!box.height) continue;
        const key = Math.round(box.top);
        lines.set(key, (lines.get(key) || '') + node.textContent[i]);
      }
    }
    for (const text of lines.values()) if (text.trim().length > longest) { longest = text.trim().length; sample = text.trim(); }
  }
  return {longest, sample};
}"""

# Names an element for a failure message.
NAME = r"""const name = (n) => !n ? 'nothing' : `${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''}.${String(n.className).trim().split(/\s+/).slice(0, 2).join('.')}${n.getAttribute('aria-label') ? `[${n.getAttribute('aria-label').slice(0, 24)}]` : ''}`;"""

# Brings an element into view inside its own scroller and reports whether all of it is on screen
# and actually hit at its centre and near each edge (nothing clips or covers it).
REACH = r"""(el) => {
  """ + NAME + r"""
  el.scrollIntoView({block: 'nearest', inline: 'nearest'});
  const b = el.getBoundingClientRect();
  const inside = b.width > 0 && b.height > 0 && b.left >= -0.5 && b.right <= innerWidth + 0.5 && b.top >= -0.5 && b.bottom <= innerHeight + 0.5;
  const inset = Math.min(3, b.width / 4, b.height / 4);
  const points = {centre: [b.left + b.width / 2, b.top + b.height / 2], left: [b.left + inset, b.top + b.height / 2], right: [b.right - inset, b.top + b.height / 2],
                  top: [b.left + b.width / 2, b.top + inset], bottom: [b.left + b.width / 2, b.bottom - inset]};
  const covered = {};
  for (const [where, [x, y]] of Object.entries(points)) {
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === el || el.contains(hit))) covered[where] = name(hit);
  }
  const why = {};
  if (Object.keys(covered).length) {
    why.inert = name(el.closest('[inert]'));
    why.interactivity = getComputedStyle(el).interactivity;
  }
  return {inside, hit: !Object.keys(covered).length, covered, ...why, box: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]};
}"""

# The element's own hit area, measured from its centre outwards in half-pixel steps along both
# axes until another element (or nothing) is hit. Pseudo-element extensions such as a stretched
# card link count; a neighbouring control or a covering bar ends the target.
TARGET_JS = r"""(el) => {
  """ + NAME + r"""
  el.scrollIntoView({block: 'nearest', inline: 'nearest'});
  const b = el.getBoundingClientRect();
  const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
  const mine = (x, y) => { const hit = document.elementFromPoint(x, y); return !!hit && (hit === el || el.contains(hit)); };
  const reach = (dx, dy) => { let d = 0; while (d < 60 && mine(cx + dx * (d + 0.5), cy + dy * (d + 0.5))) d += 0.5; return {d, stop: name(document.elementFromPoint(cx + dx * (d + 0.5), cy + dy * (d + 0.5)))}; };
  const l = reach(-1, 0), r = reach(1, 0), u = reach(0, -1), dn = reach(0, 1);
  return {size: [Math.round(b.width), Math.round(b.height)], across: l.d + r.d + 0.5, down: u.d + dn.d + 0.5,
          stops: {left: l.stop, right: r.stop, up: u.stop, down: dn.stop}};
}"""

SIDEWAYS = r"""() => {
  """ + NAME + r"""
  const main = document.querySelector('.app__main');
  const edge = main ? main.getBoundingClientRect() : null;
  const wider = [];
  if (main) for (const el of main.querySelectorAll('*')) {
    const box = el.getBoundingClientRect();
    if (box.width && (box.right > edge.right + 0.5 || box.left < edge.left - 0.5)) wider.push(`${name(el)} ${Math.round(box.left)}–${Math.round(box.right)}`);
  }
  return {page: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
          sheet: main ? main.scrollWidth - main.clientWidth : 0, sheetEdge: edge ? [Math.round(edge.left), Math.round(edge.right)] : null, wider: wider.slice(0, 6)};
}"""

FIRST_IN_VIEW = r"""() => {
  const feed = document.querySelector('.project-convo__feed');
  const top = feed.getBoundingClientRect().top;
  for (const item of feed.querySelectorAll('.project-convo__message, .convo-notice')) {
    const box = item.getBoundingClientRect();
    if (box.bottom > top + 1) return {id: item.id, offset: Math.round(box.top - top)};
  }
  return null;
}"""

# Every finite animation (a view sliding in, a sheet arriving) has finished: layout is measured at
# rest, not mid-transition. Endless indicators are ignored.
SETTLED = """() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity)"""

CAMERA = "() => { const c = document.querySelector('.sk-canvas'); return {left: Math.round(c.scrollLeft), top: Math.round(c.scrollTop)}; }"


class AdaptiveBase(unittest.TestCase):
    def page(self, width: int, height: int, *, who: str = "hubert", coarse: bool | None = None, theme: str = "light") -> Page:
        coarse = width <= COARSE_UP_TO if coarse is None else coarse
        context = BROWSER.new_context(base_url=ORIGIN, storage_state=FIXTURE["states"][who], viewport={"width": width, "height": height},
                                      color_scheme=theme, locale="en-GB", timezone_id="Europe/Warsaw", device_scale_factor=1,
                                      has_touch=coarse, is_mobile=coarse and width <= 640)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    @property
    def ids(self) -> dict:
        return FIXTURE["ids"]

    def api(self, page: Page, method: str, path: str, body: dict | None = None) -> dict:
        return fx.api(page.context, method, path, body)

    def where(self, page: Page) -> str:
        size = page.viewport_size
        return f"{size['width']}×{size['height']}"

    def settle(self, page: Page) -> None:
        page.wait_for_function(SETTLED, timeout=5000)

    def no_sideways_scroll(self, page: Page, surface: str) -> None:
        self.settle(page)
        overflow = page.evaluate(SIDEWAYS)
        self.check(overflow["page"] <= 0, f"{surface} at {self.where(page)}: no horizontal page scroll ({overflow})")
        self.check(overflow["sheet"] <= 0, f"{surface} at {self.where(page)}: nothing overflows the work sheet sideways ({overflow})")

    # Layout checks collect every problem of one journey, so a run reports all of them at once.
    problems: list[str]

    def check(self, condition: bool, message: str) -> None:
        if not condition:
            self.problems.append(message)

    def reachable(self, locator: Locator, what: str) -> dict:
        expect(locator, what).to_be_visible()
        self.settle(locator.page)
        result = locator.evaluate(REACH)
        self.check(result["inside"], f"{what} lies fully inside the viewport: {result}")
        self.check(result["hit"], f"{what} is not clipped or covered: {result}")
        return result

    def target(self, page: Page, locator: Locator, what: str) -> None:
        if not page.evaluate("matchMedia('(pointer: coarse)').matches"):
            return
        result = locator.evaluate(TARGET_JS)
        # Half-pixel sampling: a 44 px target measures at least 43.5 px.
        self.check(min(result["across"], result["down"]) >= TARGET - 0.5, f"{what} at {self.where(page)} offers a {TARGET} px touch target: {result}")

    def primary(self, page: Page, locator: Locator, what: str) -> None:
        self.reachable(locator, f"{what} at {self.where(page)}")
        self.target(page, locator, what)

    def measure(self, page: Page, selector: str, what: str) -> int:
        self.settle(page)
        result = page.evaluate(LONGEST_LINE, selector)
        self.assertGreater(result["longest"], 0, f"{what} has rendered text at {self.where(page)}")
        self.check(result["longest"] <= MEASURE, f"{what} at {self.where(page)} keeps a readable measure: {result}")
        MEASURED.setdefault(what, {})[self.where(page)] = result["longest"]
        return result["longest"]

    def no_problems(self) -> None:
        problems, self.problems = self.problems, []
        if problems:
            self.fail(f"{len(problems)} layout problem(s):\n" + "\n".join(problems))

    def setUp(self) -> None:
        self.problems = []

    def tabs(self, page: Page) -> Locator:
        return page.get_by_role("navigation", name="Project views")

    def tab(self, page: Page, name: str) -> None:
        self.tabs(page).get_by_role("link", name=re.compile(f"^{name}")).click()
        expect(self.tabs(page).get_by_role("link", name=re.compile(f"^{name}"))).to_have_attribute("aria-current", "page")

    def details_button(self, page: Page) -> Locator:
        return page.locator("header.top").get_by_role("button", name="Details", exact=True)

    def card(self, page: Page, title: str) -> Locator:
        return page.locator(".tb-card").filter(has_text=title).get_by_role("button", name=title, exact=True)

    def shot(self, page: Page, name: str) -> None:
        if page.viewport_size["width"] in SHOTS_AT:
            shot(page, name)


class AdaptiveMatrix(AdaptiveBase):
    """ADAPT-1/2/3: one journey across the whole fixture matrix."""

    def test_01_the_same_journey_works_at_every_fixture_width(self) -> None:
        for width, height in MATRIX:
            with self.subTest(width=width, height=height):
                self.problems = []
                try:
                    self.journey(width, height)
                finally:
                    self.no_problems()
        for what, values in MEASURED.items():
            print(f"\n  longest line, {what}: " + ", ".join(f"{size} {n}" for size, n in values.items()), end="")

    def journey(self, width: int, height: int) -> None:
        page = self.page(width, height)
        pid = self.ids["project"]
        size = f"{width}x{height}"
        wide = width > 1000
        page.goto(f"/projects/{pid}")

        # Conversation: the same places, labels and order at every width (ADAPT-3).
        composer = page.get_by_label("Write a message", exact=True)
        expect(composer).to_be_visible()
        expect(self.tabs(page).get_by_role("link")).to_have_count(len(TABS))
        names = [re.sub(r",.*$", "", label).strip() for label in self.tabs(page).get_by_role("link").all_inner_texts()]
        self.assertEqual(names, TABS, f"project views keep their names and order at {size}")
        for name in TABS:
            self.primary(page, self.tabs(page).get_by_role("link", name=re.compile(f"^{name}")), f"the {name} tab")
        if width <= 640:
            # Inside a project a phone's top-left control leads back to all projects (#272 FF-3, HIG-26).
            self.primary(page, page.locator("header.top").get_by_role("button", name=BACK), "Back")
        elif width <= 680:
            self.primary(page, page.get_by_role("button", name="Open navigation"), "Open navigation")
        if width <= 640:
            # #266 PF-1 / #272 PF-1: the phone's bottom bar keeps the five main places at hand, the current one marked.
            places = page.get_by_role("navigation", name="Main places")
            expect(places.get_by_role("link")).to_have_count(5)
            expect(places.locator('[aria-current="page"]')).to_have_count(1)
            for place in places.get_by_role("link").all():
                self.primary(page, place, f"the bottom bar's {place.inner_text().strip()}")
        self.primary(page, self.details_button(page), "Details")
        self.no_sideways_scroll(page, "Conversation")
        self.primary(page, composer, "the message field")
        self.primary(page, page.get_by_role("button", name="Send message"), "Send message")
        self.measure(page, ".project-convo__message > p", "Conversation messages")
        mine = page.locator(".project-convo__message.is-mine").first.bounding_box()
        theirs = page.locator(".project-convo__message:not(.is-mine)").first.bounding_box()
        self.assertGreater(mine["x"] + mine["width"], theirs["x"] + theirs["width"], f"own messages sit right at {size}")
        self.assertLess(theirs["x"], mine["x"], f"other people's messages sit left at {size}")
        self.shot(page, f"adapt-{size}-conversation")

        # Its thread (the source of a reply), docked beside the stream or as a sheet over it.
        question = page.locator(".project-convo__message").filter(has_text="Question for the next session")
        replies = question.locator(".convo-replies__open")
        replies.scroll_into_view_if_needed()
        self.primary(page, question.get_by_role("button", name="Reply", exact=True), "a message's Reply")
        replies.click()
        thread = page.get_by_role("complementary", name="Replies")
        expect(thread).to_be_visible()
        self.primary(page, thread.get_by_label("Reply", exact=True), "the reply field")
        self.primary(page, thread.get_by_role("button", name="Send reply"), "Send reply")
        self.primary(page, thread.get_by_role("button", name="Close replies"), "Close replies")
        self.measure(page, "#thread .project-convo__message > p, #thread .thread__root p", "Replies")
        self.no_sideways_scroll(page, "the thread")
        stream = page.locator(".project-convo__feed").bounding_box()
        drawer = thread.bounding_box()
        if width >= 1440:
            # ADAPT-2: the reply source stays beside the stream instead of replacing it.
            self.assertIn("thread--docked", thread.get_attribute("class"), f"the thread docks beside the stream at {size}")
            self.assertLessEqual(stream["x"] + stream["width"], drawer["x"] + 1, "stream and thread do not overlap")
            self.assertGreaterEqual(stream["width"], 480, "the stream stays readable beside its thread")
        self.shot(page, f"adapt-{size}-thread")
        thread.get_by_role("button", name="Close replies").click()
        expect(thread).to_have_count(0)

        # Map.
        self.tab(page, "Map")
        expect(page.locator(".sk-node")).to_have_count(len(fx.THOUGHTS))
        tools = page.get_by_role("toolbar", name="Sketch tools")
        for button in tools.get_by_role("button").all():
            self.primary(page, button, f"the map tool “{button.inner_text().strip() or button.get_attribute('aria-label')}”")
        for name in ("Map", "List"):
            self.primary(page, page.get_by_role("radio", name=name, exact=True), f"the {name} switch")
        zoom = page.get_by_role("group", name="Zoom")
        for button in zoom.get_by_role("button").all():
            self.primary(page, button, f"the zoom control “{button.get_attribute('aria-label')}”")
        self.measure(page, ".sk-help", "The map hint")
        self.no_sideways_scroll(page, "Map")
        self.shot(page, f"adapt-{size}-map")

        # The same thoughts as a list.
        page.get_by_role("radio", name="List", exact=True).click()
        rows = page.locator(".sk-li-t")
        expect(rows).to_have_count(len(fx.THOUGHTS))
        self.primary(page, rows.first, "a list row")
        self.no_sideways_scroll(page, "List")
        self.shot(page, f"adapt-{size}-list")
        page.get_by_role("radio", name="Map", exact=True).click()
        expect(page.locator(".sk-node")).to_have_count(len(fx.THOUGHTS))

        # Tasks: a readable active/blocked route on narrow boards, every column on wide ones.
        self.tab(page, "Tasks")
        expect(page.locator(".tb-board")).to_be_visible()
        self.primary(page, page.get_by_role("button", name="New Task", exact=True), "New Task")
        for name in ("Kanban", "List"):
            self.primary(page, page.get_by_role("radiogroup", name="Show tasks as").get_by_role("radio", name=name, exact=True), f"the {name} switch")
        overview = page.get_by_role("navigation", name="Task status")
        board_width = page.locator(".tb").bounding_box()["width"]
        if board_width < 700:
            expect(overview).to_be_visible()
            expect(overview).to_contain_text("1 blocked")
            for button in overview.get_by_role("button").all():
                self.primary(page, button, "a status overview button")
            overview.get_by_role("button", name=re.compile("^In progress")).click()
        else:
            expect(overview).to_be_hidden()
            for column in ("Open", "In progress", "Done"):
                region = page.get_by_role("region", name=re.compile(f"^{column}"))
                expect(region).to_be_visible()
                box = region.bounding_box()
                pane = page.locator(".app__pane").bounding_box()
                self.assertGreaterEqual(box["x"], pane["x"] - 1, f"the {column} column starts inside the pane at {size}")
                self.assertLessEqual(box["x"] + box["width"], pane["x"] + pane["width"] + 1, f"the whole {column} column is in view at {size}")
        card = self.card(page, fx.OPEN_TASK)
        self.primary(page, card, "a task card")
        self.no_sideways_scroll(page, "Tasks")
        self.shot(page, f"adapt-{size}-tasks")
        card.click()
        details = page.locator("#details")
        expect(details.get_by_role("heading", name=fx.OPEN_TASK)).to_be_visible()
        self.primary(page, details.get_by_role("button", name="Close details"), "Close details")
        if wide:
            # ADAPT-2: the task's details dock beside the board, which keeps its actions.
            self.assertIn("ui-panel--docked", details.get_attribute("class"), f"Details docks at {size}")
            self.primary(page, page.get_by_role("button", name="New Task", exact=True), "New Task beside Details")
            self.assertLessEqual(page.locator(".tb").bounding_box()["x"] + page.locator(".tb").bounding_box()["width"],
                                 details.bounding_box()["x"] + 1, "the board and Details do not overlap")
        self.no_sideways_scroll(page, "Tasks with Details")
        self.shot(page, f"adapt-{size}-task-details")
        details.get_by_role("button", name="Close details").click()
        expect(details.get_by_role("heading", name=fx.OPEN_TASK)).to_have_count(0)

        # Wiki.
        self.tab(page, "Wiki")
        expect(page.get_by_role("heading", level=2, name=fx.WIKI_PAGE)).to_be_visible()
        self.primary(page, page.locator(".wiki-bar").get_by_role("link", name="Edit", exact=True), "Edit")
        index = page.get_by_role("navigation", name="Wiki pages")
        self.primary(page, index.get_by_role("link", name=fx.WIKI_PAGE), "the page in the index")
        self.measure(page, ".doc-prose p, .doc-prose li", "Wiki prose")
        if width >= 768:
            nav = index.bounding_box()
            doc = page.locator(".wiki-doc").bounding_box()
            self.assertLessEqual(nav["x"] + nav["width"], doc["x"] + 1, f"the page index sits beside the document at {size}")
        self.no_sideways_scroll(page, "Wiki")
        self.shot(page, f"adapt-{size}-wiki")

        # Agents: Hubert's two connections and Marek's one, each its own entry.
        self.tab(page, "Agents")
        expect(page.get_by_role("heading", level=1, name="Working together")).to_be_visible()
        connections = page.get_by_role("list", name="Agent connections in this project").get_by_role("listitem")
        expect(connections).to_have_count(3)
        if wide:
            tops = {round(box["y"]) for box in (item.bounding_box() for item in connections.all())}
            self.assertEqual(len(tops), 1, f"all three connections share one row at {size}")
        self.primary(page, page.get_by_label("Task", exact=True), "the task selector")
        self.primary(page, page.get_by_label("Write to this task"), "the task message field")
        self.primary(page, page.get_by_role("button", name="Send to task"), "Send to task")
        self.no_sideways_scroll(page, "Agents")
        self.shot(page, f"adapt-{size}-agents")

        # And back: the Conversation tab returns to the same stream and composer.
        self.tab(page, "Conversation")
        expect(page.get_by_label("Write a message", exact=True)).to_be_visible()
        self.no_sideways_scroll(page, "Conversation after the journey")

    def test_02_wide_screens_keep_the_work_beside_open_details(self) -> None:
        """ADAPT-2: from 1920 px, docked Details costs the map and board nothing they need."""
        pid = self.ids["project"]
        for width, height in [(1920, 1080), (2560, 1440), (3840, 2160), (5120, 1440)]:
            with self.subTest(width=width, height=height):
                page = self.page(width, height)
                page.goto(f"/projects/{pid}/map/{self.ids['sketch']}")
                expect(page.locator(".sk-node")).to_have_count(len(fx.THOUGHTS))
                before = page.locator(".sk-canvas").bounding_box()["width"]
                self.details_button(page).click()
                expect(page.locator("#details.ui-panel--docked")).to_be_visible()
                page.wait_for_timeout(300)
                after = page.locator(".sk-canvas").bounding_box()["width"]
                self.assertGreaterEqual(after, before - 1, f"the map canvas keeps its width beside Details at {width}")
                self.assertLessEqual(page.locator(".sk-canvas").bounding_box()["x"] + after, page.locator("#details").bounding_box()["x"] + 1)
                page.goto(f"/projects/{pid}/tasks")
                expect(page.locator(".tb-board")).to_be_visible()
                self.assertTrue(page.get_by_role("navigation", name="Task status").is_hidden(), "all columns stay beside Details")
                self.shot(page, f"adapt-{width}x{height}-tasks-beside-details")
                self.no_problems()

    def test_03_wider_boards_show_more_cards_per_row(self) -> None:
        """ADAPT-2: the Open column's three cards take three rows at 1440 px and one at 3840 px."""
        rows = {}
        for width, height in [(1440, 900), (3840, 2160)]:
            page = self.page(width, height)
            page.goto(f"/projects/{self.ids['project']}/tasks")
            expect(page.locator(".tb-board")).to_be_visible()
            column = page.get_by_role("region", name=re.compile("^Open"))
            expect(column.locator(".tb-card")).to_have_count(3)
            rows[width] = len({round(card.bounding_box()["y"]) for card in column.locator(".tb-card").all()})
        self.assertEqual(rows[1440], 3, rows)
        self.assertEqual(rows[3840], 1, rows)

    def test_04_on_wide_screens_stream_thread_and_details_sit_side_by_side(self) -> None:
        """ADAPT-2: a reply's source, its thread and Details are readable together from 1920 px."""
        for width, height in [(1920, 1080), (3840, 2160), (5120, 1440)]:
            with self.subTest(width=width, height=height):
                page = self.page(width, height)
                page.goto(f"/projects/{self.ids['project']}")
                question = page.locator(".project-convo__message").filter(has_text="Question for the next session")
                question.locator(".convo-replies__open").click()
                thread = page.get_by_role("complementary", name="Replies")
                expect(thread).to_be_visible()
                self.details_button(page).click()
                expect(page.locator("#details.ui-panel--docked")).to_be_visible()
                page.wait_for_timeout(300)
                self.assertIn("thread--docked", thread.get_attribute("class"))
                stream = page.locator(".project-convo__feed").bounding_box()
                drawer = thread.bounding_box()
                details = page.locator("#details").bounding_box()
                self.assertLessEqual(stream["x"] + stream["width"], drawer["x"] + 1)
                self.assertLessEqual(drawer["x"] + drawer["width"], details["x"] + 1)
                self.assertGreaterEqual(stream["width"], 600, "the stream keeps a full message measure")
                self.primary(page, page.get_by_label("Write a message", exact=True), "the message field beside thread and Details")
                self.primary(page, thread.get_by_label("Reply", exact=True), "the reply field beside Details")
                self.shot(page, f"adapt-{width}x{height}-thread-and-details")
                self.no_problems()


class AdaptiveTransitions(AdaptiveBase):
    """ADAPT-4: in-place resize, rotation and keyboard changes keep the work (T151-C/E)."""

    def thoughts(self, page: Page) -> int:
        return len(self.api(page, "GET", f"/api/v1/sketches/{self.ids['sketch']}")["thoughts"])

    def open_map(self, page: Page) -> Locator:
        page.goto(f"/projects/{self.ids['project']}/map/{self.ids['sketch']}")
        expect(page.locator(".sk-node")).to_have_count(len(fx.THOUGHTS))
        return page.locator(".sk-canvas")

    def resize(self, page: Page, width: int, height: int) -> None:
        page.set_viewport_size({"width": width, "height": height})
        # Let media queries, container sizes and ResizeObservers settle.
        page.wait_for_timeout(250)

    def set_camera(self, page: Page, left: int, top: int) -> dict:
        page.locator(".sk-canvas").evaluate(f"el => {{ el.scrollLeft = {left}; el.scrollTop = {top}; }}")
        page.wait_for_timeout(100)
        return page.evaluate(CAMERA)

    def in_canvas(self, page: Page, thought: str, what: str) -> None:
        where = page.evaluate("""(id) => {
          const c = document.querySelector('.sk-canvas').getBoundingClientRect();
          const n = document.querySelector(`.sk-node[data-id="${id}"]`).getBoundingClientRect();
          const box = (b) => [b.left, b.top, b.right, b.bottom].map(Math.round);
          return {inside: n.left >= c.left - 1 && n.right <= c.right + 1 && n.top >= c.top - 1 && n.bottom <= c.bottom + 1, canvas: box(c), thought: box(n)};
        }""", self.ids["thoughts"][thought])
        self.check(where["inside"], f"{what}: {where}")

    def test_10_the_map_camera_survives_crossing_the_phone_breakpoint(self) -> None:
        """T151-E: the continuous resize series from #223 keeps the desktop camera, zoom and selection."""
        page = self.page(1366, 900, coarse=False)
        canvas = self.open_map(page)
        page.get_by_role("button", name=re.compile(r"^Zoom \d+%, reset to 100%")).click()
        expect(page.get_by_role("button", name="Zoom 100%, reset to 100%")).to_be_visible()
        camera = self.set_camera(page, 64, 96)
        self.assertEqual(camera, {"left": 64, "top": 96}, "the fixture map scrolls both ways at 1366 px")
        hold = page.locator(f'.sk-node[data-id="{self.ids["thoughts"]["hold"]}"]')
        hold.click()
        expect(hold).to_have_attribute("aria-pressed", "true")
        for width in (1280, 1024, 981, 980, 820, 641, 640, 390, 320, 640, 820, 1024, 1366):
            self.resize(page, width, 900)
            expect(hold).to_have_attribute("aria-pressed", "true")
            if width <= 640:
                # The phone shows the same thoughts as two columns; the selected one stays in view.
                self.in_canvas(page, "hold", f"the selected thought stays in view at {width} px")
        self.assertEqual(page.evaluate(CAMERA), camera, "the desktop camera returns after the phone projection")
        expect(page.get_by_role("button", name="Zoom 100%, reset to 100%")).to_be_visible()
        expect(canvas).to_be_visible()
        self.assertEqual(self.thoughts(page), len(fx.THOUGHTS), "resizing saves nothing")
        self.no_problems()

    def test_11_rotation_keeps_the_map_camera_in_both_orientations(self) -> None:
        """T151-E: a width/height swap and back keeps the camera, including where the browser clamps it."""
        # A phone turned between landscape (the plane) and portrait (two columns).
        page = self.page(844, 390, coarse=True)
        self.open_map(page)
        landscape = self.set_camera(page, 120, 60)
        self.assertEqual(landscape, {"left": 120, "top": 60})
        self.resize(page, 390, 844)
        portrait = self.set_camera(page, 0, 140)
        self.resize(page, 844, 390)
        self.assertEqual(page.evaluate(CAMERA), landscape, "landscape returns to its camera")
        self.resize(page, 390, 844)
        self.assertEqual(page.evaluate(CAMERA), portrait, "portrait returns to its camera")
        # A tablet turned with the camera at the far corner, which the taller canvas cannot reach.
        tablet = self.page(1024, 768, coarse=True)
        canvas = self.open_map(tablet)
        tablet.get_by_role("button", name=re.compile(r"^Zoom \d+%, reset to 100%")).click()
        corner = canvas.evaluate("el => { el.scrollLeft = el.scrollWidth; el.scrollTop = el.scrollHeight; return {left: Math.round(el.scrollLeft), top: Math.round(el.scrollTop)}; }")
        tablet.wait_for_timeout(100)
        self.resize(tablet, 768, 1024)
        clamped = tablet.evaluate(CAMERA)
        self.assertLess(clamped["top"], corner["top"], f"the fixture makes the portrait canvas clamp the camera: {corner} → {clamped}")
        self.resize(tablet, 1024, 768)
        self.assertEqual(tablet.evaluate(CAMERA), corner, "the camera returns to the corner after turning back")
        self.assertEqual(self.thoughts(tablet), len(fx.THOUGHTS))

    def test_12_a_private_thought_draft_survives_resize_rotation_and_keyboard(self) -> None:
        page = self.page(1440, 900, coarse=False)
        self.open_map(page)
        tea = page.locator(f'.sk-node[data-id="{self.ids["thoughts"]["tof"]}"]')
        tea.click()
        expect(tea).to_have_attribute("aria-pressed", "true")
        page.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Thought", exact=True).click()
        draft = page.get_by_role("form", name="New thought draft").get_by_label("Thought text")
        text = "Unsent: measure the radar again with the curtain closed"
        draft.fill(text)
        for width, height in ((820, 1180), (390, 844), (844, 390), (390, 844), (390, 480), (390, 844), (1440, 900)):
            self.resize(page, width, height)
            expect(draft, f"the private draft stays at {width}×{height}").to_have_value(text)
            expect(draft, f"focus stays in the draft at {width}×{height}").to_be_focused()
            expect(tea).to_have_attribute("aria-pressed", "true")
        self.assertEqual(self.thoughts(page), len(fx.THOUGHTS), "no transition saves the private draft")

    def test_13_the_conversation_keeps_its_draft_reading_place_and_thread(self) -> None:
        page = self.page(1440, 900, coarse=False)
        page.goto(f"/projects/{self.ids['project']}")
        composer = page.get_by_label("Write a message", exact=True)
        expect(composer).to_be_visible()
        before = self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/conversations?limit=50")
        # Read from an earlier message, not the end.
        target = self.ids["roots"][3]["message"]
        page.locator(f"#message-{target}").evaluate("el => el.scrollIntoView({block: 'start'})")
        page.wait_for_timeout(300)
        place = page.evaluate(FIRST_IN_VIEW)
        self.assertEqual(place["id"], f"message-{target}")
        text = "Unsent: the supplier also offered a faster board, worth asking"
        composer.fill(text)
        for width, height in ((1024, 768), (820, 1180), (390, 844), (844, 390), (390, 844), (1440, 900)):
            self.resize(page, width, height)
            expect(composer, f"the draft stays at {width}×{height}").to_have_value(text)
            expect(composer).to_be_focused()
            self.assertEqual(page.evaluate(FIRST_IN_VIEW)["id"], place["id"], f"the reading place stays at {width}×{height}")
        # A keyboard over the lower half of a phone (emulated as a shorter viewport) keeps Send reachable.
        self.resize(page, 390, 844)
        self.resize(page, 390, 470)
        expect(composer).to_have_value(text)
        expect(composer).to_be_focused()
        self.reachable(page.get_by_role("button", name="Send message"), "Send above the emulated keyboard")
        self.assertEqual(page.evaluate(FIRST_IN_VIEW)["id"], place["id"], "the reading place stays above the keyboard")
        self.resize(page, 390, 844)
        # A reply draft in the thread survives the thread moving between sheet and docked.
        self.resize(page, 1440, 900)
        question = page.locator(".project-convo__message").filter(has_text="Question for the next session")
        question.locator(".convo-replies__open").click()
        thread = page.get_by_role("complementary", name="Replies")
        reply = thread.get_by_label("Reply", exact=True)
        reply.fill("Unsent reply: both sensors, separate buses")
        for width, height in ((390, 844), (844, 390), (1440, 900)):
            self.resize(page, width, height)
            expect(thread, f"the thread stays open at {width}×{height}").to_be_visible()
            expect(reply).to_have_value("Unsent reply: both sensors, separate buses")
        self.assertIn("thread--docked", thread.get_attribute("class"), "the thread docks again when the room returns")
        after = self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/conversations?limit=50")
        self.assertEqual(len(after["items"]), len(before["items"]), "no transition sends a message")
        root = self.ids["roots"][2]["conversation"]
        messages = self.api(page, "GET", f"/api/v1/conversations/{root}")
        self.assertEqual(len(messages["messages"]), 1 + len(fx.REPLIES), "no transition sends the reply")
        self.no_problems()

    def test_14_wiki_edits_and_open_task_details_survive_resizing(self) -> None:
        page = self.page(1440, 900, coarse=False)
        doc = self.ids["doc"]
        version = self.api(page, "GET", f"/api/v1/docs/{doc}")["version"]
        page.goto(f"/projects/{self.ids['project']}/docs/{doc}/edit")
        text = page.get_by_label("Text (Markdown)")
        expect(text).to_be_visible()
        edited = fx.WIKI_BODY + "\n## Unsaved\n\nThe hold gesture needs a second, slower variant.\n"
        text.fill(edited)
        for width, height in ((820, 1180), (390, 844), (844, 390), (390, 844), (1440, 900)):
            self.resize(page, width, height)
            expect(text, f"the unsaved page text stays at {width}×{height}").to_have_value(edited)
        self.assertEqual(self.api(page, "GET", f"/api/v1/docs/{doc}")["version"], version, "resizing saves nothing")
        # A task open in Details stays the selected object as Details docks, overlays and becomes a sheet.
        page.goto(f"/projects/{self.ids['project']}/tasks")
        expect(page.locator(".tb-board")).to_be_visible()
        self.card(page, fx.OPEN_TASK).click()
        heading = page.locator("#details").get_by_role("heading", name=fx.OPEN_TASK)
        expect(heading).to_be_visible()
        for width, height in ((820, 1180), (390, 844), (1440, 900)):
            self.resize(page, width, height)
            expect(heading, f"the task stays open in Details at {width}×{height}").to_be_visible()

    def test_15_a_zoomed_in_phone_map_keeps_its_sideways_place(self) -> None:
        """T151-E: zoomed in, the phone's two columns scroll sideways; selecting, the keyboard and a zoom step keep that place."""
        page = self.page(390, 844)
        canvas = self.open_map(page)
        for label in ("110%", "125%", "150%"):
            page.get_by_role("button", name="Zoom in").click()
            expect(page.get_by_role("button", name=f"Zoom {label}, reset to 100%")).to_be_visible()
        right = canvas.evaluate("""(c) => {
          const box = c.getBoundingClientRect();
          let best = null;
          for (const n of c.querySelectorAll('.sk-node')) {
            const b = n.getBoundingClientRect();
            const x = b.left - box.left + c.scrollLeft;
            if (!best || x > best.x + 1 || (Math.abs(x - best.x) <= 1 && b.top < best.top)) best = {id: n.dataset.id, x, top: b.top - box.top + c.scrollTop};
          }
          return best;
        }""")
        camera = self.set_camera(page, round(right["x"]) - 16, max(0, round(right["top"]) - 40))
        self.assertGreater(camera["left"], 0, "the zoomed-in phone map scrolls sideways")
        node = page.locator(f'.sk-node[data-id="{right["id"]}"]')
        visible = "(n) => { const c = n.closest('.sk-canvas').getBoundingClientRect(); const b = n.getBoundingClientRect(); return b.left >= c.left - 1 && b.right <= c.right + 1; }"
        self.assertTrue(node.evaluate(visible), "the right-hand thought is in view before it is selected")
        node.tap()
        expect(node).to_have_attribute("aria-pressed", "true")
        page.wait_for_timeout(250)
        self.assertEqual(page.evaluate(CAMERA)["left"], camera["left"], "selecting keeps the sideways place")
        self.check(node.evaluate(visible), "the selected thought stays in view")
        self.resize(page, 390, 520)
        self.assertEqual(page.evaluate(CAMERA)["left"], camera["left"], "a keyboard keeps the sideways place")
        self.resize(page, 390, 844)
        self.assertEqual(page.evaluate(CAMERA)["left"], camera["left"], "closing the keyboard keeps the sideways place")
        page.get_by_role("button", name="Zoom out").click()
        expect(page.get_by_role("button", name="Zoom 125%, reset to 100%")).to_be_visible()
        page.wait_for_timeout(250)
        self.assertGreater(page.evaluate(CAMERA)["left"], 0, "a zoom step keeps a sideways place")
        self.assertEqual(self.thoughts(page), len(fx.THOUGHTS), "nothing is saved")
        self.no_problems()

    def test_16_dragging_the_top_thought_on_a_phone_moves_the_thought_not_the_view(self) -> None:
        """T151-E: the phone camera anchors on the top thought; dragging that thought must not scroll the map with it."""
        page = self.page(390, 844)
        canvas = self.open_map(page)
        self.set_camera(page, 0, 160)
        top = canvas.evaluate("""(c) => {
          const box = c.getBoundingClientRect();
          let best = null;
          for (const n of c.querySelectorAll('.sk-node')) {
            const b = n.getBoundingClientRect();
            if (b.bottom > box.top + 1 && (!best || b.top < best.top)) best = {id: n.dataset.id, top: b.top};
          }
          return best.id;
        }""")
        stored = {t["id"]: (t["x"], t["y"]) for t in self.api(page, "GET", f"/api/v1/sketches/{self.ids['sketch']}")["thoughts"]}
        node = page.locator(f'.sk-node[data-id="{top}"]')
        node.click()
        expect(node).to_have_attribute("aria-pressed", "true")
        page.wait_for_timeout(250)
        camera, start = page.evaluate(CAMERA), node.bounding_box()
        x, y = start["x"] + 20, start["y"] + 12
        page.mouse.move(x, y)
        page.mouse.down()
        for step in range(1, 7):
            page.mouse.move(x, y + 25 * step, steps=3)
            page.wait_for_timeout(50)
            self.assertEqual(page.evaluate(CAMERA), camera, f"the view stays still {25 * step} px into the drag")
        page.mouse.up()
        expect(page.locator(".sk-status")).to_contain_text("Moved")
        page.wait_for_timeout(300)
        self.assertGreater(node.bounding_box()["y"], start["y"], "the dragged thought moves down on screen")
        self.assertEqual(page.evaluate(CAMERA), camera, "dropping keeps the view")
        moved = {t["id"]: (t["x"], t["y"]) for t in self.api(page, "GET", f"/api/v1/sketches/{self.ids['sketch']}")["thoughts"]}
        self.assertEqual(moved[top][1], stored[top][1] + 150, "the drop saves the dragged distance")
        # Put the shared fixture back.
        page.keyboard.press("Control+z")
        expect(page.locator(".sk-status")).to_contain_text("Undid")
        page.wait_for_timeout(300)
        restored = {t["id"]: (t["x"], t["y"]) for t in self.api(page, "GET", f"/api/v1/sketches/{self.ids['sketch']}")["thoughts"]}
        self.assertEqual(restored[top], stored[top], "undo puts the thought back")
        self.no_problems()


if __name__ == "__main__":
    unittest.main()
