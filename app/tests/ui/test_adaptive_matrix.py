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

These are emulated CSS viewports at 100% browser zoom in headless Chromium or WebKit (FLUX_UI_BROWSER). They are not evidence
for a physical 4K or ultrawide display, a real phone keyboard or OS scaling (docs/design/adaptive-
workspaces.md); those sessions remain separate acceptance evidence.
"""

from __future__ import annotations

import os
import re
import unittest
import uuid
from unittest import mock

from playwright.sync_api import Locator, Page, expect, sync_playwright

import adaptive_fixture as fx
from author_columns import assert_author_column
from test_app_shell import show_map_as, open_map_options, ORIGIN, UPSTREAM, UI_BROWSER, open_details, shot, start_forwarder

# Width × height fixtures (CSS px). Phones and tablets use a coarse (touch) pointer.
# Every starting fixture of docs/design/adaptive-workspaces.md, by context: phones, short landscape
# phones, tablets and split views, small laptops, desktops, ultrawide, 4K-sized and tall windows.
MATRIX = [
    (320, 568), (360, 640), (360, 800), (390, 844), (412, 915), (430, 932),
    (640, 360), (844, 390),
    (600, 960), (768, 1024), (820, 1180), (1024, 768),
    (1280, 720), (1280, 800), (1366, 768), (1440, 900),
    (1920, 1080), (2560, 1440),
    (2560, 1080), (3440, 1440), (5120, 1440),
    (3840, 2160), (900, 1600),
]
COARSE_UP_TO = 1024
# Where the phone's half sheet shows every field of a task on opening, above the composer (390×844 as on main).
COMMON_PHONES = {(390, 844), (412, 915), (430, 932)}
# Whole-view captures for visual review: phones, the tablet (820), laptop, the 2560 workspace, 1920, ultrawide and 4K.
SHOTS_AT = {320, 390, 768, 820, 1440, 1920, 2560, 3440, 3840}
TABS = ["Conversation", "Map", "Tasks", "Wiki", "Agents"]
# The phone menu lists Tasks before Map (#341).
PHONE_TABS = ["Conversation", "Tasks", "Map", "Wiki", "Agents"]
# ADAPT-2 caps that stop the wide screens from giving more room (measured by test_07). Each is open until its
# owner's PR lands; the test fails once a cap is gone, so the entry is removed rather than passing silently.
WIDE_CAPS = {
    "the Agents column": "the Agents column stays at 854 px (app/apps/web/src/agents/agents.css; PRs #376 and #417 own it)",
}
# The readable measure (proposed 2026-10-05, docs/design/adaptive-layout-rules.md): at most 90
# characters, spaces included, on any rendered line of prose.
MEASURE = 90
# The most empty space between the newest message of a short stream and its message field (ADAPT-2, tall screens).
MAX_STREAM_GAP = 64
# The most room a long stream's opening adds below its newest message so its top message starts whole (#725;
# WHOLE_MESSAGE_ROOM in app/apps/web/src/app/messageParts.tsx).
WHOLE_MESSAGE_ROOM = 48
# Live editing is the wiki editor whenever it is configured (check_ui.sh sets FLUX_LIVE_EDITING=on by default).
LIVE = os.environ.get("FLUX_LIVE_EDITING", "on") != "off"
TARGET = 44
# Known gaps: criteria the current head does not meet at one fixture, each with the issue that closes it.
# The journey still measures them, and the matrix fails when one stops showing, so a closed gap must be
# removed here rather than silently passing. They are reported as open, not as delivered (#151).
# A gap is excused only for the predicate it names, and only when its own control is at least 44 px and
# one of its overlays (covered_by) covers the hit area; see explained_by_recorded_overlap. Every other
# failure at the same fixture stays a problem.
# The 640×360 Reply gap (a sticky tab bar over the stream) closed with the phone shell (#341): no tab bar.
KNOWN_GAPS: dict[str, dict[str, dict]] = {}
# The overlays a known gap may name. The measurements report which one (if any) covers each point or stops each side.
OVERLAYS = (".ui-tabs__bar", ".project-convo__composer", ".tb-overview")

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
    # FLUX_UI_BROWSER selects the engine, as in the other journeys: chromium (default) or webkit (#461, #151 AC-5).
    BROWSER = getattr(PW, UI_BROWSER).launch()
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
REACH = r"""(el, overlays) => {
  """ + NAME + r"""
  el.scrollIntoView({block: 'nearest', inline: 'nearest'});
  const b = el.getBoundingClientRect();
  const inside = b.width > 0 && b.height > 0 && b.left >= -0.5 && b.right <= innerWidth + 0.5 && b.top >= -0.5 && b.bottom <= innerHeight + 0.5;
  const inset = Math.min(3, b.width / 4, b.height / 4);
  const points = {centre: [b.left + b.width / 2, b.top + b.height / 2], left: [b.left + inset, b.top + b.height / 2], right: [b.right - inset, b.top + b.height / 2],
                  top: [b.left + b.width / 2, b.top + inset], bottom: [b.left + b.width / 2, b.bottom - inset]};
  const covered = {}, overlay = {};
  for (const [where, [x, y]] of Object.entries(points)) {
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === el || el.contains(hit))) {
      covered[where] = name(hit);
      overlay[where] = hit ? overlays.find((s) => hit.closest(s)) || null : null;
    }
  }
  const why = {};
  if (Object.keys(covered).length) {
    why.inert = name(el.closest('[inert]'));
    why.interactivity = getComputedStyle(el).interactivity;
  }
  return {inside, hit: !Object.keys(covered).length, covered, overlay, ...why, box: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]};
}"""

# The element's own hit area, measured from its centre outwards in half-pixel steps along both
# axes until another element (or nothing) is hit. Pseudo-element extensions such as a stretched
# card link count; a neighbouring control or a covering bar ends the target.
TARGET_JS = r"""(el, overlays) => {
  """ + NAME + r"""
  el.scrollIntoView({block: 'nearest', inline: 'nearest'});
  const b = el.getBoundingClientRect();
  const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
  const mine = (x, y) => { const hit = document.elementFromPoint(x, y); return !!hit && (hit === el || el.contains(hit)); };
  const overlayOf = (node) => (node && overlays.find((s) => node.closest(s))) || null;
  const reach = (dx, dy) => { let d = 0; while (d < 60 && mine(cx + dx * (d + 0.5), cy + dy * (d + 0.5))) d += 0.5; const node = document.elementFromPoint(cx + dx * (d + 0.5), cy + dy * (d + 0.5)); return {d, stop: name(node), overlay: overlayOf(node)}; };
  const l = reach(-1, 0), r = reach(1, 0), u = reach(0, -1), dn = reach(0, 1);
  return {size: [Math.round(b.width), Math.round(b.height)], across: l.d + r.d + 0.5, down: u.d + dn.d + 0.5,
          stops: {left: l.stop, right: r.stop, up: u.stop, down: dn.stop},
          overlay: {left: l.overlay, right: r.overlay, up: u.overlay, down: dn.overlay}};
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

# Every finite animation (a view sliding in, a sheet arriving) has finished and a panel that was closing has left the
# page (it stays, invisible and shifted 16 px, until its fade-out resolves): layout is measured at rest, not
# mid-transition. Endless indicators are ignored.
SETTLED = """() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity) && !document.querySelector('.ui-panel.is-leaving')"""

# The CSS boxes that define a view's layout, rounded to whole CSS pixels (absent regions are null).
GEOMETRY = r"""() => {
  const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map((v) => Math.round(v)); };
  return {pane: box('.app__pane'), main: box('.app__main'), feed: box('.project-convo__feed'), canvas: box('.sk-canvas'), board: box('.tb-board'), details: box('#details')};
}"""

# Whether a control, scrolled into view, lies within the window sideways and is the element hit at its centre.
HORIZONTAL = r"""(el) => {
  """ + NAME + r"""
  el.scrollIntoView({block: 'nearest', inline: 'nearest'});
  const b = el.getBoundingClientRect();
  const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
  return {visible: b.width > 0 && b.height > 0, left: b.left >= -0.5, right: b.right <= innerWidth + 0.5, hit: !!hit && (hit === el || el.contains(hit)), covered: hit && !(hit === el || el.contains(hit)) ? name(hit) : null,
          box: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)], window: innerWidth};
}"""

# Every field row of the task in Details (Status, Owner, Came from, Due, ...), brought into view in the panel's own
# scroller: whether it lies fully above the composer, and is the element hit at its centre (nothing covers it).
# With scroll=false nothing is scrolled: it is where the rows are when the panel opens, and "opens" says the row's own line
# (its first 24 px) is above the composer.
TASK_FIELDS = r"""(root, scroll) => {
  const foot = root.querySelector('.wd__foot').getBoundingClientRect().top;
  return [...root.querySelectorAll('.wd-row')].map((row) => {
    if (scroll) row.scrollIntoView({block: 'nearest'});
    const b = row.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + Math.min(b.height / 2, 12));
    return {label: (row.querySelector('dt')?.textContent || '').trim(), above: b.height > 0 && b.bottom <= foot + 0.5, opens: b.height > 0 && b.top + 24 <= foot, hit: !!hit && row.contains(hit),
            box: [Math.round(b.top), Math.round(b.bottom)], composer: Math.round(foot)};
  });
}"""

# The computed size of the first message's text: it must really grow with the person's text size (WCAG 1.4.4).
TEXT_PX = "() => parseFloat(getComputedStyle(document.querySelector('.project-convo__message .message-body')).fontSize)"

# The insets the page resolves: a probe styled with env(safe-area-inset-*).
SAFE_INSETS = """() => {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const value = {top: parseFloat(style.paddingTop), right: parseFloat(style.paddingRight), bottom: parseFloat(style.paddingBottom), left: parseFloat(style.paddingLeft)};
  probe.remove();
  return value;
}"""
# Every control that can be hit inside an inset strip: points every 6 px along each strip, at three depths into it.
UNSAFE_HITS = """(insets) => {
  const W = innerWidth, H = innerHeight, found = new Map();
  const control = 'a[href], button, input, textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [contenteditable=true], [tabindex]:not([tabindex="-1"])';
  // Content that scrolls may pass under an inset, as a list passes under the home indicator, so long as it can be scrolled
  // out of it; a control that stays put there (fixed, sticky or in a box that does not scroll) cannot.
  const scrolls = (el) => {
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.position === 'fixed' || style.position === 'sticky') return false;
      const can = (axis) => /(auto|scroll)/.test(axis === 'y' ? style.overflowY : style.overflowX)
        && (axis === 'y' ? node.scrollHeight > node.clientHeight + 1 : node.scrollWidth > node.clientWidth + 1);
      if (node !== el && (can('y') || can('x'))) return true;
    }
    return false;
  };
  const probe = (x, y, edge) => {
    const el = document.elementFromPoint(x, y)?.closest(control);
    if (!el || scrolls(el)) return;
    const name = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 40);
    const key = `${edge}:${name}`;
    const r = el.getBoundingClientRect();
    if (!found.has(key)) found.set(key, {edge, control: name, at: [x, y], box: [r.left, r.top, r.right, r.bottom].map((v) => Math.round(v * 10) / 10)});
  };
  const depths = (size) => [0.5, size / 2, size - 0.5];
  for (let x = 3; x < W; x += 6) {
    if (insets.top) for (const d of depths(insets.top)) probe(x, d, 'top');
    if (insets.bottom) for (const d of depths(insets.bottom)) probe(x, H - d, 'bottom');
  }
  for (let y = 3; y < H; y += 6) {
    if (insets.left) for (const d of depths(insets.left)) probe(d, y, 'left');
    if (insets.right) for (const d of depths(insets.right)) probe(W - d, y, 'right');
  }
  return [...found.values()];
}"""
# A control's box against the safe rectangle, and whether its centre hits the control itself.
SAFE_BOX = """(el, insets) => {
  const r = el.getBoundingClientRect();
  const inside = r.top >= insets.top - 0.5 && r.left >= insets.left - 0.5 && r.right <= innerWidth - insets.right + 0.5 && r.bottom <= innerHeight - insets.bottom + 0.5;
  const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return {inside, hit: !!at && (el === at || el.contains(at)), box: [r.left, r.top, r.right, r.bottom].map(Math.round), window: [innerWidth, innerHeight]};
}"""

CAMERA = "() => { const c = document.querySelector('.sk-canvas'); return {left: Math.round(c.scrollLeft), top: Math.round(c.scrollTop)}; }"


def explained_by_recorded_overlap(size: str, what: str, predicate: str, observed: dict) -> bool:
    """True only when the failed predicate is one the known gap records and its cause is that gap's own overlay.

    "covered": observed is REACH's result; every point the control fails on must be covered by one of the gap's overlays.
    "target": observed is TARGET_JS's result; the control's own box must reach TARGET px on both axes, so an undersized
    control is never excused, and on each axis that falls short both sides must be stopped by the gap's overlays.
    """
    gap = KNOWN_GAPS.get(size, {}).get(what)
    if gap is None:
        return False
    covers = gap["covered_by"]
    if predicate == "covered":
        return bool(observed["covered"]) and all(observed["overlay"].get(point) in covers for point in observed["covered"])
    if predicate == "target":
        width, height = observed["size"]
        if min(width, height) < TARGET - 0.5:
            return False
        short = (["left", "right"] if observed["across"] < TARGET - 0.5 else []) + (["up", "down"] if observed["down"] < TARGET - 0.5 else [])
        return bool(short) and all(observed["overlay"].get(side) in covers for side in short)
    return False


class AdaptiveBase(unittest.TestCase):
    def page(self, width: int, height: int, *, who: str = "hubert", coarse: bool | None = None, theme: str = "light", dpr: float = 1, state: dict | None = None) -> Page:
        coarse = width <= COARSE_UP_TO if coarse is None else coarse
        context = BROWSER.new_context(base_url=ORIGIN, storage_state=state or FIXTURE["states"][who], viewport={"width": width, "height": height},
                                      color_scheme=theme, locale="en-GB", timezone_id="Europe/Warsaw", device_scale_factor=dpr,
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

    def at_rest(self, page: Page) -> None:
        """Requests have finished and no view is still moving: the header and the stream hold their final size."""
        page.wait_for_load_state("networkidle")
        # Geist loads with font-display: swap; a fallback face sets a different line height (a 3 px shift).
        page.evaluate("document.fonts.ready.then(() => true)")
        self.settle(page)

    def no_sideways_scroll(self, page: Page, surface: str) -> None:
        self.settle(page)
        overflow = page.evaluate(SIDEWAYS)
        self.check(overflow["page"] <= 0, f"{surface} at {self.where(page)}: no horizontal page scroll ({overflow})")
        self.check(overflow["sheet"] <= 0, f"{surface} at {self.where(page)}: nothing overflows the work sheet sideways ({overflow})")

    # Layout checks collect every problem of one journey, so a run reports all of them at once.
    problems: list[str]
    seen_gaps: set[tuple[str, str]]

    def check(self, condition: bool, message: str, overlap: tuple[str, str, str, dict] | None = None) -> None:
        """Records a failed check. overlap = (size, what, predicate, observed) is given only for a predicate a known
        gap may record; the failure then counts as seen, not as a problem, when explained_by_recorded_overlap holds."""
        if condition:
            return
        if overlap is not None and explained_by_recorded_overlap(*overlap):
            self.seen_gaps.add((overlap[0], overlap[1]))
            return
        self.problems.append(message)

    def reachable(self, locator: Locator, what: str) -> dict:
        expect(locator, what).to_be_visible()
        self.settle(locator.page)
        result = locator.evaluate(REACH, list(OVERLAYS))
        self.judge_reach(what, self.where(locator.page), result)
        return result

    def judge_reach(self, what: str, size: str, result: dict) -> None:
        self.check(result["inside"], f"{what} at {size} lies fully inside the viewport: {result}")
        self.check(result["hit"], f"{what} at {size} is not clipped or covered: {result}", (size, what, "covered", result))

    def target(self, page: Page, locator: Locator, what: str) -> None:
        if not page.evaluate("matchMedia('(pointer: coarse)').matches"):
            return
        result = locator.evaluate(TARGET_JS, list(OVERLAYS))
        self.judge_target(what, self.where(page), result)

    def judge_target(self, what: str, size: str, result: dict) -> None:
        # Half-pixel sampling: a 44 px target measures at least 43.5 px.
        self.check(min(result["across"], result["down"]) >= TARGET - 0.5, f"{what} at {size} offers a {TARGET} px touch target: {result}", (size, what, "target", result))

    def primary(self, page: Page, locator: Locator, what: str) -> None:
        self.reachable(locator, what)
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
        self.seen_gaps: set[tuple[str, str]] = set()

    def phone(self, page: Page) -> bool:
        return page.viewport_size["width"] <= 640

    def title_menu(self, page: Page) -> bool:
        """Below 900 px the project title is the view menu: the phone's (#341) and the tablet's (Spokój, #505 AC-2)."""
        return page.viewport_size["width"] <= 900

    def tabs(self, page: Page) -> Locator:
        """The project's views: the header's segmented control, or below 900 px the menu the title opens."""
        if self.title_menu(page):
            return page.get_by_role("dialog").filter(has=page.locator(".phone-menu__list"))
        return page.get_by_role("navigation", name="Project views")

    def open_menu(self, page: Page) -> None:
        if self.title_menu(page) and not self.tabs(page).count():
            page.get_by_role("heading", level=1).get_by_role("button").click()
            expect(self.tabs(page)).to_be_visible()

    def tab(self, page: Page, name: str) -> None:
        self.open_menu(page)
        self.tabs(page).get_by_role("link", name=re.compile(f"^{name}")).click()
        if self.title_menu(page):
            expect(self.tabs(page)).to_have_count(0)
            self.open_menu(page)
        expect(self.tabs(page).get_by_role("link", name=re.compile(f"^{name}"))).to_have_attribute("aria-current", "page")
        if self.title_menu(page):
            page.keyboard.press("Escape")
            expect(self.tabs(page)).to_have_count(0)

    def details_button(self, page: Page) -> Locator:
        """The header's way to Details: More on the computer's one row (#340), the labelled button on the phone."""
        if self.phone(page):
            self.open_menu(page)
            return self.tabs(page).locator(".phone-menu__details")
        return page.locator("header.top").get_by_role("button", name="More", exact=True)

    def card(self, page: Page, title: str) -> Locator:
        return page.locator(".tb-card").filter(has_text=title).get_by_role("button", name=title, exact=True)

    def task_fields_clear_composer(self, page: Page, details: Locator, size: str, *, opens_clear: bool = False) -> None:
        """Every field of the task in Details can be read above its composer: scrolled into the panel's own scroller each row
        lies wholly above the composer and nothing covers it. With opens_clear the rows are also where they are on opening
        (the common phones' half sheet shows them all without scrolling, as main did)."""
        self.settle(page)
        for scroll in ([False, True] if opens_clear else [True]):
            rows = details.evaluate(TASK_FIELDS, scroll)
            self.assertGreaterEqual(len(rows), 4, f"the task's field rows are found at {size}: {rows}")
            for row in rows:
                # On opening a row must at least show its own line above the composer; scrolled into view it lies wholly above it.
                self.check((row["above"] if scroll else row["opens"]) and row["hit"], f"the task field “{row['label']}” at {size}{'' if scroll else ' (before scrolling)'} lies above the composer and is not covered: {row}")

    def shot(self, page: Page, name: str) -> None:
        if page.viewport_size["width"] in SHOTS_AT:
            shot(page, name if UI_BROWSER == "chromium" else f"{name}-{UI_BROWSER}")


class AdaptiveMatrix(AdaptiveBase):
    """ADAPT-1/2/3: one journey across the whole fixture matrix."""

    def test_01_the_same_journey_works_at_every_fixture_width(self) -> None:
        for width, height in MATRIX:
            with self.subTest(width=width, height=height):
                self.problems = []
                self.seen_gaps = set()
                try:
                    self.journey(width, height)
                finally:
                    self.no_problems()
                size = f"{width}×{height}"
                expected = set(KNOWN_GAPS.get(size, {}))
                seen = {gap for at, gap in self.seen_gaps if at == size}
                self.assertEqual(seen, expected, f"at {size} the known gaps still show; remove the closed ones from KNOWN_GAPS")
        for what, values in MEASURED.items():
            print(f"\n  longest line, {what}: " + ", ".join(f"{size} {n}" for size, n in values.items()), end="")

    def journey(self, width: int, height: int, theme: str = "light") -> None:
        page = self.page(width, height, theme=theme)
        pid = self.ids["project"]
        size = f"{width}x{height}"
        # Dark captures are named apart from the light ones (the same journey, the other theme).
        tag = "" if theme == "light" else "-dark"
        wide = width > 1000
        page.goto(f"/projects/{pid}")

        # Conversation: the same places, labels and order at every width (ADAPT-3).
        composer = page.get_by_label("Write a message", exact=True)
        expect(composer).to_be_visible()
        self.open_menu(page)
        expect(self.tabs(page).get_by_role("link")).to_have_count(len(TABS))
        names = [re.sub(r"[,\n].*$", "", label, flags=re.S).strip() for label in self.tabs(page).get_by_role("link").all_inner_texts()]
        self.assertEqual(names, PHONE_TABS if width <= 900 else TABS, f"project views keep their names and order at {size}")
        for name in TABS:
            self.primary(page, self.tabs(page).get_by_role("link", name=re.compile(f"^{name}")), f"the {name} tab")
        if 640 < width <= 900:
            # The tablet's title menu holds only the views; Details stays in More.
            page.keyboard.press("Escape")
            expect(self.tabs(page)).to_have_count(0)
        if width <= 680 and width > 640:
            self.primary(page, page.get_by_role("button", name="Open navigation"), "Open navigation")
        self.primary(page, self.details_button(page), "Details")
        if width <= 640:
            page.keyboard.press("Escape")
            # #341: a conversation has no tab bar; the places are Back and, in the other views, the capsule.
            expect(page.get_by_role("navigation", name="Main places")).to_have_count(0)
            self.primary(page, page.get_by_role("button", name="Back", exact=True), "Back")
        self.no_sideways_scroll(page, "Conversation")
        self.primary(page, composer, "the message field")
        self.primary(page, page.get_by_role("button", name="Send message"), "Send message")
        self.measure(page, ".project-convo__message > .message-bubble > .message-body", "Conversation messages")
        mine_row = page.locator(".project-convo__message.is-mine").first
        their_row = page.locator(".project-convo__message:not(.is-mine)").first
        assert_author_column(self, mine_row, width, f"own author at {size}")
        assert_author_column(self, their_row, width, f"other author at {size}")
        mine, theirs = mine_row.bounding_box(), their_row.bounding_box()
        column = mine_row.locator("..").bounding_box()
        self.assertAlmostEqual(mine["x"] + mine["width"], column["x"] + column["width"], delta=1,
                               msg=f"own messages reach the right of the reading column at {size} (#481)")
        self.assertAlmostEqual(theirs["x"], column["x"], delta=1, msg=f"other authors keep the left column at {size}")
        self.shot(page, f"adapt-{size}{tag}-conversation")

        # Its thread (the source of a reply), docked beside the stream or as a sheet over it.
        question = page.locator(".project-convo__message").filter(has_text="Question for the next session")
        replies = question.locator(".convo-replies__open")
        replies.scroll_into_view_if_needed()
        self.primary(page, replies, "a message's existing thread")
        replies.click()
        thread = page.get_by_role("complementary", name="Replies").or_(page.get_by_role("dialog", name="Replies"))
        expect(thread).to_be_visible()
        self.primary(page, thread.get_by_label("Reply", exact=True), "the reply field")
        self.primary(page, thread.get_by_role("button", name="Send reply"), "Send reply")
        self.primary(page, thread.get_by_role("button", name="Close replies"), "Close replies")
        self.measure(page, "#thread .project-convo__message > .message-bubble > .message-body, #thread .thread__root .message-body", "Replies")
        self.no_sideways_scroll(page, "the thread")
        stream = page.locator(".project-convo__feed").bounding_box()
        drawer = thread.bounding_box()
        if width >= 1440:
            # ADAPT-2: the reply source stays beside the stream instead of replacing it.
            self.assertIn("ui-panel--docked", thread.get_attribute("class"), f"the thread docks beside the stream at {size}")
            self.assertLessEqual(stream["x"] + stream["width"], drawer["x"] + 1, "stream and thread do not overlap")
            self.assertGreaterEqual(stream["width"], 480, "the stream stays readable beside its thread")
        self.shot(page, f"adapt-{size}{tag}-thread")
        thread.get_by_role("button", name="Close replies").click()
        expect(thread).to_have_count(0)

        # Map.
        self.tab(page, "Map")
        expect(page.locator(".sk-node")).to_have_count(len(fx.THOUGHTS))
        tools = page.get_by_role("toolbar", name="Sketch tools")
        for button in tools.get_by_role("button").all():
            self.primary(page, button, f"the map tool “{button.inner_text().strip() or button.get_attribute('aria-label')}”")
        options = open_map_options(page) if page.get_by_role('button', name='Map options', exact=True).is_visible() else None
        for name in ("Map", "List"):
            self.primary(page, page.get_by_role("radio", name=name, exact=True), f"the {name} switch")
        zoom = page.get_by_role("group", name="Zoom")
        for button in zoom.get_by_role("button").all():
            self.primary(page, button, f"the zoom control “{button.get_attribute('aria-label')}”")
        if options is not None:
            options.get_by_role('button', name='Close map options', exact=True).click()
            expect(options).to_have_count(0)
        add = page.get_by_role("button", name="Add a thought", exact=True)
        if add.count():
            self.primary(page, add, "the phone's Add a thought")
        self.measure(page, ".sk-hint, .sk-phone__note", "The map hint")
        self.no_sideways_scroll(page, "Map")
        self.shot(page, f"adapt-{size}{tag}-map")

        # The same thoughts as a list.
        show_map_as(page, "List")
        rows = page.locator(".sk-li-t")
        expect(rows).to_have_count(len(fx.THOUGHTS))
        self.primary(page, rows.first, "a list row")
        self.no_sideways_scroll(page, "List")
        self.shot(page, f"adapt-{size}{tag}-list")
        show_map_as(page, "Map")
        expect(page.locator(".sk-node")).to_have_count(len(fx.THOUGHTS))

        # Tasks: the phone shows the drawn Mine | All list; wider views retain the responsive board.
        self.tab(page, "Tasks")
        if width <= 640:
            expect(page.locator(".tb-board")).to_have_count(0)
            expect(page.locator(".tb-bar")).to_be_hidden()
            expect(page.get_by_role("button", name="New Task", exact=True)).to_have_count(0)
            self.primary(page, page.get_by_role("button", name="Create", exact=True), "Create")
            for button in page.get_by_role("group", name="Whose tasks").get_by_role("button").all():
                self.primary(page, button, "Mine or All")
            row = page.locator(".ws-task").filter(has_text=fx.OPEN_TASK)
            card = row.locator(".ws-item")
            self.primary(page, row.locator(".ws-task__glyph"), "a task's state glyph")
            self.primary(page, card, "a task row")
        else:
            expect(page.locator(".tb-board")).to_be_visible()
            self.primary(page, page.get_by_role("button", name="New Task", exact=True), "New Task")
            for name in ("Board", "List"):
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
        self.shot(page, f"adapt-{size}{tag}-tasks")
        if "a task card" in KNOWN_GAPS.get(f"{width}×{height}", {}):
            card.evaluate("el => el.click()")
        else:
            card.click()

        details = page.locator("#details")
        expect(details.get_by_role("heading", name=fx.OPEN_TASK)).to_be_visible()
        self.task_fields_clear_composer(page, details, size, opens_clear=(width, height) in COMMON_PHONES)
        self.primary(page, details.get_by_role("button", name="Close details"), "Close details")
        if wide:
            # ADAPT-2: the task's details dock beside the board, which keeps its actions.
            self.assertIn("ui-panel--docked", details.get_attribute("class"), f"Details docks at {size}")
            self.primary(page, page.get_by_role("button", name="New Task", exact=True), "New Task beside Details")
            self.assertLessEqual(page.locator(".tb").bounding_box()["x"] + page.locator(".tb").bounding_box()["width"],
                                 details.bounding_box()["x"] + 1, "the board and Details do not overlap")
        self.no_sideways_scroll(page, "Tasks with Details")
        self.shot(page, f"adapt-{size}{tag}-task-details")
        details.get_by_role("button", name="Close details").click()
        expect(details.get_by_role("heading", name=fx.OPEN_TASK)).to_have_count(0)

        # Wiki.
        self.tab(page, "Wiki")
        expect(page.get_by_role("heading", level=2, name=fx.WIKI_PAGE)).to_be_visible()
        self.primary(page, page.get_by_role("link", name="Edit", exact=True), "Edit")
        index = page.get_by_role("navigation", name="Wiki pages")
        self.primary(page, index.get_by_role("link", name=fx.WIKI_PAGE), "the page in the index")
        self.measure(page, ".doc-prose p, .doc-prose li", "Wiki prose")
        if width >= 768:
            nav = index.bounding_box()
            doc = page.locator(".wiki-doc").bounding_box()
            self.assertLessEqual(nav["x"] + nav["width"], doc["x"] + 1, f"the page index sits beside the document at {size}")
        self.no_sideways_scroll(page, "Wiki")
        self.shot(page, f"adapt-{size}{tag}-wiki")

        # Agents: Hubert's two connections and Marek's one, each its own row of one list, and one primary button.
        self.tab(page, "Agents")
        expect(page.get_by_role("heading", level=1, name="Agents")).to_be_visible()
        connections = page.get_by_role("list", name="Agents in this project").get_by_role("listitem")
        expect(connections).to_have_count(3)
        self.primary(page, page.get_by_role("button", name="Hand off a task"), "Hand off a task")
        self.no_sideways_scroll(page, "Agents")
        self.shot(page, f"adapt-{size}{tag}-agents")

        # And back: the Conversation tab returns to the same stream and composer.
        self.tab(page, "Conversation")
        expect(page.get_by_label("Write a message", exact=True)).to_be_visible()
        self.no_sideways_scroll(page, "Conversation after the journey")

    def test_02_wide_screens_keep_the_work_beside_open_details(self) -> None:
        """ADAPT-2: from 1920 px, docked Details costs the map and board nothing they need."""
        pid = self.ids["project"]
        for width, height in [(1920, 1080), (2560, 1080), (2560, 1440), (3440, 1440), (3840, 2160), (5120, 1440)]:
            with self.subTest(width=width, height=height):
                page = self.page(width, height)
                page.goto(f"/projects/{pid}/map/{self.ids['sketch']}")
                expect(page.locator(".sk-node")).to_have_count(len(fx.THOUGHTS))
                before = page.locator(".sk-canvas").bounding_box()["width"]
                open_details(page)
                expect(page.locator("#details.ui-panel--docked")).to_be_visible()
                page.wait_for_timeout(300)
                after = page.locator(".sk-canvas").bounding_box()["width"]
                # F-026: the map fills its pane, so docking Details narrows it; what is left stays a real work surface.
                self.assertLessEqual(after, before + 1)
                self.assertGreaterEqual(after, min(900, width * 0.45), f"the map canvas keeps a usable width beside Details at {width}")
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

    def test_04_on_wide_screens_stream_and_the_one_panel_sit_side_by_side(self) -> None:
        """ADAPT-2 and #488: from 1920 px a reply's source stays beside its thread, and Details take the same
        panel (one panel, no second column) with a way back to the thread; the stream keeps a full measure."""
        for width, height in [(1920, 1080), (2560, 1080), (3440, 1440), (3840, 2160), (5120, 1440)]:
            with self.subTest(width=width, height=height):
                page = self.page(width, height)
                page.goto(f"/projects/{self.ids['project']}")
                question = page.locator(".project-convo__message").filter(has_text="Question for the next session")
                question.locator(".convo-replies__open").click()
                thread = page.get_by_role("complementary", name="Replies").or_(page.get_by_role("dialog", name="Replies"))
                expect(thread).to_be_visible()
                self.assertIn("ui-panel--docked", thread.get_attribute("class"))
                stream = page.locator(".project-convo__feed").bounding_box()
                drawer = thread.bounding_box()
                self.assertLessEqual(stream["x"] + stream["width"], drawer["x"] + 1)
                self.assertGreaterEqual(stream["width"], 600, "the stream keeps a full message measure")
                self.primary(page, page.get_by_label("Write a message", exact=True), "the message field beside the thread")
                self.primary(page, thread.get_by_label("Reply", exact=True), "the reply field beside the stream")
                self.shot(page, f"adapt-{width}x{height}-thread")
                open_details(page)
                details = page.locator("#details.ui-panel--docked")
                expect(details).to_be_visible()
                expect(details.get_by_role("button", name="Thread")).to_be_visible()
                expect(page.locator("#thread")).to_have_count(0)
                panel = details.bounding_box()
                stream = page.locator(".project-convo__feed").bounding_box()
                self.assertLessEqual(stream["x"] + stream["width"], panel["x"] + 1)
                self.assertGreaterEqual(stream["width"], 600, "the stream keeps a full message measure beside Details")
                self.primary(page, page.get_by_label("Write a message", exact=True), "the message field beside Details")
                self.shot(page, f"adapt-{width}x{height}-thread-and-details")
                self.no_problems()


    def test_05_system_scaling_changes_device_pixels_not_the_css_layout(self) -> None:
        """AC-5 / ADAPT-1: a 4K panel at 100%, 150% and 200% system scaling gives the CSS viewports
        3840×2160, 2560×1440 and 1920×1080 at device pixel ratio 1, 1.5 and 2. Each scaled layout is
        compared with the same CSS viewport at ratio 1; the ratio is measured, not inferred from the width."""
        differences = []
        for css_width, css_height, dpr in [(3840, 2160, 1), (2560, 1440, 1.5), (1920, 1080, 2)]:
            scaled = self.scaling_geometry(css_width, css_height, dpr)
            reference = scaled if dpr == 1 else self.scaling_geometry(css_width, css_height, 1)
            for view, boxes in scaled.items():
                for key, value in boxes.items():
                    if value != reference[view][key]:
                        differences.append(f"{view} {key} at {css_width}×{css_height} CSS px, ratio {dpr} != ratio 1: {value} != {reference[view][key]}")
        print(f"\n  scaling: 3840×2160 @1, 2560×1440 @1.5 and 1920×1080 @2 compared with ratio 1; differences: {len(differences)}", end="")
        self.assertEqual(differences, [], "system scaling changes the CSS layout:\n" + "\n".join(differences))

    def scaling_geometry(self, width: int, height: int, dpr: float) -> dict:
        """CSS boxes of the main regions of each project view, plus the sideways overflow, at one ratio."""
        page = self.page(width, height, dpr=dpr)
        page.goto(f"/projects/{self.ids['project']}")
        expect(page.get_by_label("Write a message", exact=True)).to_be_visible()
        self.assertEqual(page.evaluate("devicePixelRatio"), dpr, f"the browser renders at device pixel ratio {dpr}")
        self.at_rest(page)
        geometry = {"Conversation": page.evaluate(GEOMETRY)}
        self.no_sideways_scroll(page, f"Conversation at {width}x{height} @{dpr}")
        self.tab(page, "Map")
        expect(page.locator(".sk-node")).to_have_count(len(fx.THOUGHTS))
        self.at_rest(page)
        geometry["Map"] = page.evaluate(GEOMETRY)
        self.tab(page, "Tasks")
        expect(page.locator(".tb-board")).to_be_visible()
        self.at_rest(page)
        geometry["Tasks"] = page.evaluate(GEOMETRY)
        self.tab(page, "Agents")
        expect(page.get_by_role("heading", level=1, name="Agents")).to_be_visible()
        self.at_rest(page)
        geometry["Agents"] = page.evaluate(GEOMETRY)
        self.no_sideways_scroll(page, f"the views at {width}x{height} @{dpr}")
        return geometry

    def test_06_the_same_journey_in_the_dark_theme(self) -> None:
        """AC-4: the journey runs in the dark theme too, at a phone and an ultrawide width; the captures
        are named with -dark beside the light ones (the light theme is the default)."""
        for width, height in [(390, 844), (3440, 1440)]:
            with self.subTest(width=width, height=height):
                self.problems = []
                try:
                    self.journey(width, height, theme="dark")
                finally:
                    self.no_problems()

    def test_07_wide_screens_gain_room_for_the_map_and_the_agents_column(self) -> None:
        """ADAPT-2: the map fills its pane and grows with the screen. Remaining caps in WIDE_CAPS are
        still measured; the test fails when one is gone, so the entry must be removed."""
        measured: dict[int, dict[str, float]] = {}
        for width, height in [(1920, 1080), (2560, 1440), (3840, 2160)]:
            page = self.page(width, height)
            page.goto(f"/projects/{self.ids['project']}/map/{self.ids['sketch']}")
            expect(page.locator(".sk-node")).to_have_count(len(fx.THOUGHTS))
            self.at_rest(page)
            plane = page.locator(".sk-canvas").bounding_box()["width"]
            pane = page.locator(".sk-page--map").bounding_box()["width"]
            self.assertAlmostEqual(plane, pane, delta=1, msg=f"the map fills the available pane at {width} CSS px")
            self.tab(page, "Agents")
            expect(page.get_by_role("heading", level=1, name="Agents")).to_be_visible()
            self.at_rest(page)
            column = page.locator(".agents").first.bounding_box()["width"]
            measured[width] = {"the map plane": round(plane), "the Agents column": round(column)}
        print("\n  wide surfaces, CSS px at 1920 / 2560 / 3840: " + "; ".join(f"{name} {measured[1920][name]} / {measured[2560][name]} / {measured[3840][name]}" for name in measured[1920]), end="")
        for smaller, larger in ((1920, 2560), (2560, 3840)):
            self.assertGreater(measured[larger]["the map plane"], measured[smaller]["the map plane"], f"the map gains room at {larger} CSS px: {measured}")
        for name in WIDE_CAPS:
            capped = measured[3840][name] - measured[1920][name] <= 1
            self.assertTrue(capped, f"{name} now grows with the screen; remove it from WIDE_CAPS: {measured}")

    def short_world(self) -> dict:
        """Its own person, workspace, project and colleague: the shared fixture's sidebar and project list stay as the other
        tests found them. The project holds two short roots, the first with one reply; a direct message holds two."""
        if getattr(AdaptiveMatrix, "_short", None):
            return AdaptiveMatrix._short
        def sign_up(name: str, email: str):
            context = BROWSER.new_context(base_url=ORIGIN)
            signed_up = context.request.post("/api/auth/sign-up/email", data={"name": name, "email": email, "password": fx.PASSWORD}, headers={"origin": ORIGIN})
            assert signed_up.status == 200, signed_up.text()
            return context
        email = f"ines.short+{fx.STAMP}@example.test"
        other = f"jonas.short+{fx.STAMP}@example.test"
        person, colleague = sign_up("Ines Short", email), sign_up("Jonas Short", other)
        colleague_id = fx.api(colleague, "GET", "/api/v1/me")["user"]["id"]
        workspace = fx.api(person, "POST", "/api/v1/workspaces", {"name": "Short streams"})["id"]
        fx.api(person, "POST", f"/api/v1/workspaces/{workspace}/members", {"email": other, "role": "member"})
        project = fx.api(person, "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": "Short stream, tall screen", "visibility": "restricted"})["id"]
        roots = [fx.api(person, "POST", f"/api/v1/projects/{project}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())})["id"]
                 for body in ("Two sensors on the first board, please.", "Agreed. I will route the second I2C bus.")]
        fx.api(person, "POST", f"/api/v1/conversations/{roots[0]}/messages", {"body": "Both on the first board, then.", "clientMessageId": str(uuid.uuid4())})
        dm = fx.api(person, "POST", f"/api/v1/workspaces/{workspace}/dms", {"participantIds": [colleague_id]})["id"]
        dm_messages = [fx.api(person, "POST", f"/api/v1/dms/{dm}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())})["id"]
                       for body in ("Can we test the lamp tonight?", "Yes, after seven.")]
        # A private reply thread on the first direct message: its root and one reply.
        fx.api(colleague, "POST", f"/api/v1/dms/{dm}/threads/{dm_messages[0]}/replies", {"body": "I will bring the spare driver.", "clientMessageId": str(uuid.uuid4())})
        # A task whose thread holds its first contribution and one reply, for the Agents view's task thread. It lives in a
        # project of its own: a task thread is also a root of its project's conversation, and test_08 counts that stream.
        tasks = fx.api(person, "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": "Short task thread", "visibility": "restricted"})["id"]
        task = fx.api(person, "POST", f"/api/v1/projects/{tasks}/work", {"title": "Mount the lamp sensor"})["id"]
        for body in ("Mount it under the shelf, cable to the left.", "The bracket is in the second drawer."):
            fx.api(person, "POST", f"/api/v1/work/{task}/discussion", {"body": body, "clientMessageId": str(uuid.uuid4()), "kind": "text"})
        state = person.storage_state()
        person.close()
        colleague.close()
        AdaptiveMatrix._short = {"state": state, "project": project, "roots": roots, "dm": dm, "dm_root": dm_messages[0], "task": task, "task_project": tasks}
        return AdaptiveMatrix._short

    def test_08_a_short_stream_stays_connected_to_its_composer_on_tall_screens(self) -> None:
        """ADAPT-2: on a tall screen a short work stream and its composer stay visually connected; the extra height
        must not open a giant empty separation between the newest message and the field."""
        world = self.short_world()
        gaps = {}
        for width, height in [(390, 844), (820, 1180), (900, 1600), (1440, 900), (2560, 1440), (3840, 2160)]:
            with self.subTest(width=width, height=height):
                page = self.page(width, height, state=world["state"])
                page.goto(f"/projects/{world['project']}")
                expect(page.locator(".project-convo__message")).to_have_count(2)
                self.at_rest(page)
                last = page.locator(".project-convo__message").last.bounding_box()
                field = page.get_by_label("Write a message", exact=True).bounding_box()
                gaps[f"{width}×{height}"] = round(field["y"] - (last["y"] + last["height"]))
                self.assertLessEqual(gaps[f"{width}×{height}"], MAX_STREAM_GAP, f"the newest message and the field stay together at {width}×{height}: {gaps}")
        print("\n  space between the newest message and the message field (CSS px): " + ", ".join(f"{size} {gap}" for size, gap in gaps.items()), end="")

    def test_09_a_short_thread_and_a_short_direct_message_stay_connected_to_their_fields(self) -> None:
        """ADAPT-2: the same holds for a thread (its root and one reply), a direct message (two messages), a direct
        message's private reply thread (its root and one reply) and the Agents view's task thread (two messages): the newest
        message sits against its field."""
        world = self.short_world()
        gaps = {"thread": {}, "direct message": {}, "direct message thread": {}, "Agents task thread": {}}
        for width, height in [(390, 844), (820, 1180), (1440, 900), (2560, 1440), (3440, 1440)]:
            with self.subTest(width=width, height=height):
                size = f"{width}×{height}"
                page = self.page(width, height, state=world["state"])
                page.goto(f"/projects/{world['project']}/conversations/{world['roots'][0]}")
                thread = page.locator("#thread")
                expect(thread.locator(".project-convo__message")).to_have_count(1)
                self.at_rest(page)
                last = thread.locator(".project-convo__message").last.bounding_box()
                field = thread.get_by_label("Reply", exact=True).bounding_box()
                gaps["thread"][size] = round(field["y"] - (last["y"] + last["height"]))
                dm = self.page(width, height, state=world["state"])
                dm.goto(f"/dm/{world['dm']}")
                expect(dm.locator(".dm__list > li")).to_have_count(2)
                self.at_rest(dm)
                last = dm.locator(".dm__list > li").last.bounding_box()
                field = dm.locator("#dm-composer").bounding_box()
                gaps["direct message"][size] = round(field["y"] - (last["y"] + last["height"]))
                dm.goto(f"/dm/{world['dm']}?thread={world['dm_root']}")
                panel = dm.locator("[data-dm-thread]")
                expect(panel.locator(".thread__list > li")).to_have_count(1)
                self.at_rest(dm)
                last = panel.locator(".thread__list > li").last.bounding_box()
                field = panel.locator("#dm-thread-composer").bounding_box()
                gaps["direct message thread"][size] = round(field["y"] - (last["y"] + last["height"]))
                agents = self.page(width, height, state=world["state"])
                agents.goto(f"/projects/{world['task_project']}/agents?task={world['task']}")
                thread = agents.get_by_role("region", name="Thread of Mount the lamp sensor")
                expect(thread.locator(".agents-msg")).to_have_count(2)
                self.at_rest(agents)
                last = thread.locator(".agents-msg").last.bounding_box()
                field = thread.get_by_label("Write to this task").bounding_box()
                gaps["Agents task thread"][size] = round(field["y"] - (last["y"] + last["height"]))
                # Every surface is measured before any is judged, so one failure still reports the others.
                for what, values in gaps.items():
                    self.assertLessEqual(values[size], MAX_STREAM_GAP, f"the newest message of the {what} and its field stay together at {size}: {gaps}")
        for what, values in gaps.items():
            print(f"\n  space between the newest message and the field, {what} (CSS px): " + ", ".join(f"{size} {gap}" for size, gap in values.items()), end="")


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
        hold = page.locator(f'.sk-node[data-id="{self.ids["thoughts"]["hold"]}"]')
        # #509: the plane reaches past the thoughts on every side, so a camera away from its origin is
        # one that keeps the selected thought in view: centre it, then move a little.
        hold.evaluate("el => el.scrollIntoView({ block: 'center', inline: 'center' })")
        start = page.evaluate(CAMERA)
        camera = self.set_camera(page, start["left"] + 64, start["top"] + 96)
        self.assertEqual(camera, {"left": start["left"] + 64, "top": start["top"] + 96}, "the fixture map scrolls both ways at 1366 px")
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
        # Read from an earlier message, not the end. A reader is aiming at the stream first: until a
        # reader gives input, the stream keeps settling to its end for two seconds after it opens
        # (openOnWholeMessages); a script's own scroll is not reader input (#155, work/readerIntent.ts).
        target = self.ids["roots"][3]["message"]
        page.locator(".project-convo__feed").hover()
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
        thread = page.get_by_role("complementary", name="Replies").or_(page.get_by_role("dialog", name="Replies"))
        reply = thread.get_by_label("Reply", exact=True)
        reply.fill("Unsent reply: both sensors, separate buses")
        for width, height in ((390, 844), (844, 390), (1440, 900)):
            self.resize(page, width, height)
            expect(thread, f"the thread stays open at {width}×{height}").to_be_visible()
            expect(reply).to_have_value("Unsent reply: both sensors, separate buses")
        self.assertIn("ui-panel--docked", thread.get_attribute("class"), "the thread docks again when the room returns")
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
        note = "The hold gesture needs a second, slower variant."
        if LIVE:
            # The shared working copy: typing is shared as it happens but only Save keeps a version.
            text = page.locator('.cm-content[aria-label="Shared Markdown"]')
            expect(page.locator('[data-live-status="live"]')).to_be_visible()
            text.click()
            page.keyboard.press("Control+End")
            page.keyboard.insert_text(f"\n## Unsaved\n\n{note}\n")
            expect(page.get_by_role("status").filter(has_text="All changes shared")).to_be_visible()
        else:
            text = page.get_by_label("Text (Markdown)")
            expect(text).to_be_visible()
            edited = fx.WIKI_BODY + f"\n## Unsaved\n\n{note}\n"
            text.fill(edited)
        for width, height in ((820, 1180), (390, 844), (844, 390), (390, 844), (1440, 900)):
            self.resize(page, width, height)
            if LIVE:
                expect(text, f"the shared page text stays at {width}×{height}").to_contain_text(note)
            else:
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
        options = open_map_options(page, touch=True)
        for label in ("110%", "125%", "150%"):
            options.get_by_role("button", name="Zoom in").tap()
            expect(options.get_by_role("button", name=f"Zoom {label}, reset to 100%")).to_be_visible()
        options.get_by_role('button', name='Close map options', exact=True).tap()
        expect(options).to_have_count(0)
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
        options = open_map_options(page, touch=True)
        options.get_by_role("button", name="Zoom out").tap()
        expect(options.get_by_role("button", name="Zoom 125%, reset to 100%")).to_be_visible()
        options.get_by_role('button', name='Close map options', exact=True).tap()
        expect(options).to_have_count(0)
        page.wait_for_timeout(250)
        self.assertGreater(page.evaluate(CAMERA)["left"], 0, "a zoom step keeps a sideways place")
        self.assertEqual(self.thoughts(page), len(fx.THOUGHTS), "nothing is saved")
        self.no_problems()

    def test_16_dragging_the_top_thought_on_a_phone_does_not_arrange_the_thought_or_move_the_view(self) -> None:
        """T151-E, S15: the phone camera anchors on the top thought; dragging it neither arranges it nor scrolls the map."""
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
        page.wait_for_timeout(300)
        # S15 (#349): the phone only views and adds; the drag arranges nothing and the view stays put.
        self.assertEqual(node.bounding_box()["y"], start["y"], "the thought stays where it is on a phone")
        self.assertEqual(page.evaluate(CAMERA), camera, "releasing keeps the view")
        after = {t["id"]: (t["x"], t["y"]) for t in self.api(page, "GET", f"/api/v1/sketches/{self.ids['sketch']}")["thoughts"]}
        self.assertEqual(after, stored, "nothing was moved on the shared map")
        self.no_problems()

    def test_17_a_saved_task_opens_on_another_device_but_an_unsent_draft_stays_on_its_own(self) -> None:
        """AC-3 (ADAPT-4): the saved object is the cross-device anchor. The same account on a phone, a colleague on a tablet
        and nobody else: an unsent draft belongs to the device it was written on, and nothing is saved or sent meanwhile.
        The object is opened by the link the app itself hands out (Home, Agents), which the app consumes when it opens."""
        pid, task = self.ids["project"], self.ids["tasks"][fx.OPEN_TASK]
        url = f"/projects/{pid}/tasks?open=work:{task}"
        composer = re.compile("^(Write to this task|First message about this task)$")
        draft = "PRIVATE-DRAFT only on the laptop"
        laptop = self.page(1440, 900, coarse=False)
        before = self.api(laptop, "GET", f"/api/v1/work/{task}/discussion")["messages"]
        laptop.goto(url)
        expect(laptop.locator("#details").get_by_role("heading", name=fx.OPEN_TASK)).to_be_visible()
        laptop.locator("#details").get_by_label(composer).fill(draft)
        laptop.wait_for_timeout(600)
        # Leaving and opening the task again on this device (its link opens it once and is then consumed) finds the draft.
        laptop.goto(f"/projects/{pid}/tasks")
        expect(laptop.locator(".tb-board")).to_be_visible()
        laptop.goto(url)
        expect(laptop.locator("#details").get_by_role("heading", name=fx.OPEN_TASK)).to_be_visible()
        expect(laptop.locator("#details").get_by_label(composer), "the draft is kept on the device it was written on").to_have_value(draft)
        # The same account on another device: a fresh browser context has its own storage.
        phone = self.page(390, 844)
        phone.goto(url)
        expect(phone.locator("#details").get_by_role("heading", name=fx.OPEN_TASK)).to_be_visible()
        expect(phone.locator("#details").get_by_label(composer), "the draft is not synchronised").to_have_value("")
        # A colleague with access opens the same object; a signed-in person without access is told it is not available.
        tablet = self.page(820, 1180, who="marek")
        tablet.goto(url)
        expect(tablet.locator("#details").get_by_role("heading", name=fx.OPEN_TASK)).to_be_visible()
        outsider = BROWSER.new_context(base_url=ORIGIN, viewport={"width": 1440, "height": 900}, locale="en-GB", timezone_id="Europe/Warsaw")
        self.addCleanup(outsider.close)
        signed_up = outsider.request.post("/api/auth/sign-up/email", data={"name": "Lee Park", "email": f"lee.adapt+{fx.STAMP}@example.test", "password": fx.PASSWORD}, headers={"origin": ORIGIN})
        self.assertEqual(signed_up.status, 200, signed_up.text())
        stranger = outsider.new_page()
        stranger.goto(url)
        expect(stranger.get_by_text("This place isn’t available")).to_be_visible()
        expect(stranger.get_by_text(fx.OPEN_TASK), "no access shows nothing of the task").to_have_count(0)
        self.assertEqual(self.api(laptop, "GET", f"/api/v1/work/{task}/discussion")["messages"], before, "nothing was saved or sent")



def reach_result(covered: dict[str, str | None], inside: bool = True) -> dict:
    """REACH's result shape: covered maps each point the control fails on to the overlay covering it, or None."""
    return {"inside": inside, "hit": not covered, "covered": {point: "div.synthetic" for point in covered},
            "overlay": dict(covered), "box": [0, 0, 49, 44]}


def target_result(size: tuple[int, int], across: float, down: float, stops: dict[str, str | None]) -> dict:
    """TARGET_JS's result shape: stops maps each side to the overlay that stops the hit area there, or None."""
    return {"size": list(size), "across": across, "down": down, "stops": {side: "div.synthetic" for side in stops},
            "overlay": dict(stops)}


class AdaptiveReflow(AdaptiveBase):
    """ADAPT-5 (#151 AC-4): browser zoom and text enlargement keep every project view usable.

    Playwright has no browser-zoom setting, so zoom is emulated the way the browser reports it: the window divided by the
    zoom, with the device pixel ratio multiplied by it. 1280×1024 at 400% is the 320×256 CSS viewport of WCAG 1.4.10 and
    1280×720 at 200% is 640×360. Text enlargement sets the root size to 200%, which every type token follows (rem), and the
    test measures that the text really grew. The map's plane is two-dimensional content: it scrolls inside its own region,
    never the page. These are emulations, not a browser's zoom or an operating system's text-size setting."""

    def controls(self, page: Page, view: str) -> list[tuple[str, Locator]]:
        phone = self.phone(page)
        if view == "Conversation":
            return [("the message field", page.get_by_label("Write a message", exact=True)), ("Send message", page.get_by_role("button", name="Send message"))]
        if view == "Tasks":
            return [("Create", page.get_by_role("button", name="Create", exact=True))] if phone else [("New Task", page.get_by_role("button", name="New Task", exact=True))]
        if view == "Wiki":
            return [("Edit", page.get_by_role("link", name="Edit", exact=True))]
        if view == "Agents":
            return [("Hand off a task", page.get_by_role("button", name="Hand off a task"))]
        return []

    def within_window(self, locator: Locator, what: str, where: str) -> None:
        expect(locator, f"{what} at {where}").to_be_visible()
        self.settle(locator.page)
        result = locator.evaluate(HORIZONTAL)
        self.check(result["left"] and result["right"], f"{what} at {where} lies within the window sideways: {result}")
        self.check(result["hit"], f"{what} at {where} is not covered: {result}")

    def walk(self, page: Page, where: str, *, start: bool = True) -> None:
        """Every view of the project: no sideways page scroll, and its primary actions stay reachable by scrolling."""
        if start:
            page.goto(f"/projects/{self.ids['project']}")
        for view in TABS:
            if view != "Conversation":
                self.tab(page, view)
            if view == "Map":
                expect(page.locator(".sk-node")).to_have_count(len(fx.THOUGHTS))
            elif view == "Wiki":
                expect(page.get_by_role("heading", level=2, name=fx.WIKI_PAGE)).to_be_visible()
            elif view == "Agents":
                expect(page.get_by_role("heading", level=1, name="Agents")).to_be_visible()
            elif view == "Tasks":
                expect(page.locator(".tb-board, .ws-task").first).to_be_visible()
            self.at_rest(page)
            for what, locator in self.controls(page, view):
                self.within_window(locator, what, f"{view} {where}")
            self.no_sideways_scroll(page, f"{view} {where}")

    def test_20_browser_zoom_reflows_every_view(self) -> None:
        for window, zoom in (((1280, 1024), 4), ((1280, 720), 2)):
            width, height = window[0] // zoom, window[1] // zoom
            with self.subTest(window=window, zoom=zoom):
                self.problems = []
                page = self.page(width, height, coarse=False, dpr=zoom)
                self.assertEqual(page.evaluate("devicePixelRatio"), zoom)
                try:
                    self.walk(page, f"{width}×{height} CSS px, {window[0]}×{window[1]} at {zoom * 100}%")
                finally:
                    self.no_problems()

    def test_21_text_enlarged_to_200_percent_keeps_every_view_usable(self) -> None:
        for width, height in ((390, 844), (820, 1180), (1440, 900)):
            with self.subTest(width=width, height=height):
                self.problems = []
                page = self.page(width, height)
                try:
                    page.goto(f"/projects/{self.ids['project']}")
                    expect(page.get_by_label("Write a message", exact=True)).to_be_visible()
                    self.at_rest(page)
                    before = page.evaluate(TEXT_PX)
                    page.evaluate("document.documentElement.style.fontSize = '200%'")
                    self.at_rest(page)
                    after = page.evaluate(TEXT_PX)
                    # A changed root size that leaves fixed-pixel text unchanged is not evidence: the message text itself doubles.
                    self.assertGreaterEqual(after, before * 1.9, f"message text grew from {before}px to {after}px at {width}×{height}")
                    self.walk(page, f"{width}×{height} with 200% text", start=False)
                finally:
                    self.no_problems()

    def test_22_safe_areas_keep_every_control_out_of_the_unsafe_edges(self) -> None:
        """MOB/ADAPT-5 safe areas: a notched phone upright (47 px top, 34 px home indicator) and on its side (47 px each
        side, 21 px bottom). Chromium simulates the insets (`Emulation.setSafeAreaInsetsOverride`) and the page must first
        resolve `env(safe-area-inset-*)` to them, so the check cannot pass vacuously. In every view no control that stays put
        (fixed, sticky, or in a box that does not scroll) can be hit inside an inset; scrolling content may pass under one.
        The view's primary controls lie within the safe rectangle and are not covered. WebKit has no
        such override: there the case is skipped with that reason, and real-device insets stay unverified."""
        if UI_BROWSER != "chromium":
            self.skipTest("only Chromium can simulate a safe area (Emulation.setSafeAreaInsetsOverride); WebKit stays unverified")
        for (width, height), insets in (((390, 844), {"top": 47, "right": 0, "bottom": 34, "left": 0}),
                                        ((844, 390), {"top": 0, "right": 47, "bottom": 21, "left": 47})):
            with self.subTest(width=width, height=height):
                self.problems = []
                page = self.page(width, height, coarse=True)
                session = page.context.new_cdp_session(page)
                session.send("Emulation.setSafeAreaInsetsOverride", {"insets": insets})
                page._safe_session = session  # type: ignore[attr-defined]  # a live session keeps the override
                where = f"{width}×{height} with safe areas {insets}"
                try:
                    page.goto(f"/projects/{self.ids['project']}")
                    seen = page.evaluate(SAFE_INSETS)
                    self.assertEqual(seen, insets, f"the page resolves env(safe-area-inset-*) to the simulated insets at {where}")
                    for view in TABS:
                        if view != "Conversation":
                            self.tab(page, view)
                        if view == "Map":
                            expect(page.locator(".sk-node")).to_have_count(len(fx.THOUGHTS))
                        elif view == "Agents":
                            expect(page.get_by_role("heading", level=1, name="Agents")).to_be_visible()
                        self.at_rest(page)
                        hits = page.evaluate(UNSAFE_HITS, insets)
                        self.check(not hits, f"{view} at {where}: no control can be hit inside an inset: {hits}")
                        for what, locator in self.controls(page, view):
                            expect(locator, f"{what} in {view} at {where}").to_be_visible()
                            locator.scroll_into_view_if_needed()
                            self.settle(page)
                            box = locator.evaluate(SAFE_BOX, insets)
                            self.check(box["inside"] and box["hit"], f"{what} in {view} at {where} lies in the safe rectangle, uncovered: {box}")
                finally:
                    self.no_problems()

    def test_23_a_long_stream_opens_with_its_newest_message_against_the_field(self) -> None:
        """#725: a stream that fills its feed opens at its latest with the newest message against the message field. Its
        "whole messages" opening adds at most WHOLE_MESSAGE_ROOM (48 px) below it; on phones it once added 137-147 px."""
        gaps, rooms = {}, {}
        for width, height in [(320, 568), (360, 640), (390, 844), (820, 1180), (1440, 900)]:
            with self.subTest(width=width, height=height):
                page = self.page(width, height)
                page.goto(f"/projects/{self.ids['project']}")
                expect(page.locator(".project-convo__message").first).to_be_visible()
                self.at_rest(page)
                page.wait_for_timeout(600)  # the opening keeps settling while fonts and previews arrive
                measured = page.evaluate("""() => {
                  const feed = document.querySelector('.project-convo__feed');
                  const items = [...feed.querySelectorAll('.project-convo__message, .convo-notice, .convo-object, .convo-fold, .convo-goal')].filter((el) => el.getClientRects().length);
                  const column = document.querySelector('.project-convo__in');
                  // The column's own padding, from a bare copy of it, against what the opening wrote inline.
                  const bare = column.cloneNode(false);
                  bare.removeAttribute('style');
                  bare.style.cssText = 'position:absolute;visibility:hidden;';
                  column.parentElement.appendChild(bare);
                  const own = parseFloat(getComputedStyle(bare).paddingBottom);
                  bare.remove();
                  return {last: items[items.length - 1].getBoundingClientRect().bottom, fills: feed.scrollHeight > feed.clientHeight + 1,
                          atLatest: feed.scrollHeight - feed.clientHeight - feed.scrollTop <= 2,
                          room: column.style.paddingBottom ? Math.round(parseFloat(column.style.paddingBottom) - own) : 0};
                }""")
                field = page.get_by_label("Write a message", exact=True).bounding_box()
                size = f"{width}×{height}"
                gaps[size] = round(field["y"] - measured["last"])
                self.assertTrue(measured["fills"], f"the fixture stream fills its feed at {size}: {measured}")
                self.assertTrue(measured["atLatest"], f"the stream opens at its latest at {size}: {measured}")
                rooms[size] = measured["room"]
                self.assertLessEqual(measured["room"], WHOLE_MESSAGE_ROOM, f"the opening adds at most {WHOLE_MESSAGE_ROOM} px below the newest message at {size}: {rooms}")
                self.assertLessEqual(gaps[size] - measured["room"], MAX_STREAM_GAP, f"without that room the newest message sits against the field at {size}: {gaps}")
        print("\n  space between the newest message and the field in a long stream, CSS px (of it, room for a whole first message): "
              + ", ".join(f"{size} {gap} ({rooms[size]})" for size, gap in gaps.items()), end="")

    def test_24_the_map_opens_at_a_readable_size_and_fit_stays_the_overview(self) -> None:
        """#726: the map opens with thought titles at 12 px or more and their meta lines at 10 px or more (at 1440×900 it
        opened at Fit's 60% floor: 8 and 7 px), its first thought in view. Fit is the explicit overview and still shrinks the
        sketch below that."""
        readable = """() => {
          const scale = (el) => el.getBoundingClientRect().height / el.offsetHeight;
          const px = (sel) => Math.min(...[...document.querySelectorAll(sel)].filter((el) => el.offsetHeight).map((el) => parseFloat(getComputedStyle(el).fontSize) * scale(el)));
          return {title: px('.sk-node .sk-t'), meta: px('.sk-node .sk-k')};
        }"""
        for width, height in [(1280, 800), (1440, 900), (820, 1180)]:
            with self.subTest(width=width, height=height):
                size = f"{width}×{height}"
                page = self.page(width, height)
                page.goto(f"/projects/{self.ids['project']}/map/{self.ids['sketch']}")
                expect(page.locator(".sk-node")).to_have_count(len(fx.THOUGHTS))
                self.at_rest(page)
                text = page.evaluate(readable)
                self.assertGreaterEqual(text["title"], 12, f"thought titles are readable on opening at {size}: {text}")
                self.assertGreaterEqual(text["meta"], 10, f"thought meta lines are readable on opening at {size}: {text}")
                canvas = page.locator(".sk-canvas").bounding_box()
                first = page.locator(".sk-node").filter(has_text=fx.THOUGHTS[0][1]).bounding_box()
                self.assertTrue(canvas["x"] <= first["x"] and first["x"] + first["width"] <= canvas["x"] + canvas["width"]
                                and canvas["y"] <= first["y"] and first["y"] + first["height"] <= canvas["y"] + canvas["height"],
                                f"the first thought is in view on opening at {size}: {first} in {canvas}")
                opened = self.zoom_level(page)
                self.assertGreaterEqual(opened, 90, f"the map opens at a working zoom at {size}")
                if width == 1440:
                    page.get_by_role("button", name="Fit the sketch to the view", exact=True).click()
                    page.wait_for_function("z => !document.querySelector('.sk-zoom__level').textContent.startsWith(z + '%')", arg=opened)
                    self.assertLess(self.zoom_level(page), opened, f"Fit still gives the overview at {size}")

    def zoom_level(self, page: Page) -> int:
        return int(re.search(r"(\d+)%", page.locator(".sk-zoom__level").get_attribute("aria-label") or "").group(1))

    def test_25_a_short_window_rail_scrolls_its_places_and_projects_and_keeps_its_controls(self) -> None:
        """#727: on a window under about 420 px tall (a phone on its side) the rail's middle band, the four places with the
        projects and messages, scrolls as one, so every project is reachable from the rail; the toggle, New and the account
        stay where they are, inside the window, and scrolling the band does not move them."""
        context = BROWSER.new_context(base_url=ORIGIN)
        email = f"rhea.rail+{fx.STAMP}@example.test"
        signed_up = context.request.post("/api/auth/sign-up/email", data={"name": "Rhea Rail", "email": email, "password": fx.PASSWORD}, headers={"origin": ORIGIN})
        self.assertEqual(signed_up.status, 200, signed_up.text())
        workspace = fx.api(context, "POST", "/api/v1/workspaces", {"name": "Short rail"})["id"]
        names = ["Bench supply", "Lamp shade", "Sensor shelf", "Driver board", "Cable loom", "Night test"]
        projects = [fx.api(context, "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": name, "visibility": "restricted"})["id"] for name in names]
        state = context.storage_state()
        context.close()
        controls = """() => Object.fromEntries([['toggle', '.side--rail > .side__toggle'], ['account', '.side--rail .me--compact'], ['new', '.side--rail > :nth-child(2)']]
          .map(([name, sel]) => { const r = document.querySelector(sel).getBoundingClientRect(); return [name, [r.left, r.top, r.right, r.bottom].map(Math.round)]; }))"""
        # The rail is the sidebar from 681 to 900 px wide; a phone on its side and a short tablet split.
        for width, height in [(844, 390), (900, 400)]:
            with self.subTest(width=width, height=height):
                size = f"{width}×{height}"
                page = self.page(width, height, state=state)
                page.goto(f"/projects/{projects[0]}")
                rail = page.locator(".side--rail")
                expect(rail).to_be_visible()
                self.at_rest(page)
                before = page.evaluate(controls)
                shot(page, f"rail-short-{width}x{height}" if UI_BROWSER == "chromium" else f"rail-short-{width}x{height}-{UI_BROWSER}")
                for name, (left, top, right, bottom) in before.items():
                    self.assertTrue(left >= 0 and top >= 0 and right <= width and bottom <= height, f"the rail's {name} lies inside the window at {size}: {before}")
                band = rail.locator(".side__rail-middle")
                scrolls = band.evaluate("el => ({scrollable: el.scrollHeight > el.clientHeight, room: el.clientHeight, overflow: getComputedStyle(el).overflowY})")
                self.assertTrue(scrolls["scrollable"] and scrolls["overflow"] == "auto", f"the rail's places and lists scroll as one band at {size}: {scrolls}")
                tiles = rail.get_by_role("navigation", name="Projects").get_by_role("link")
                expect(tiles).to_have_count(len(names))
                for index, name in enumerate(names):
                    tile = tiles.nth(index)
                    tile.scroll_into_view_if_needed()
                    self.settle(page)
                    box = tile.evaluate(REACH, list(OVERLAYS))
                    self.assertTrue(box["inside"] and box["hit"], f"the project {name} can be reached in the rail at {size}: {box}")
                self.assertEqual(page.evaluate(controls), before, f"scrolling the band moves none of the rail's controls at {size}")
                shot(page, f"rail-short-{width}x{height}-scrolled" if UI_BROWSER == "chromium" else f"rail-short-{width}x{height}-scrolled-{UI_BROWSER}")
                tiles.nth(len(names) - 1).click()
                expect(page).to_have_url(re.compile(f"/projects/{projects[-1]}"))
                self.assertEqual(page.evaluate(controls), before, f"choosing a project keeps the rail's controls in place at {size}")


class KnownGapRules(AdaptiveBase):
    """Negative controls for the known-gap rule (#151, review of PR #454). Browser-free: they drive the same
    judge_reach and judge_target path as the journey, with results shaped like REACH and TARGET_JS report them.
    The recorded overlap stays seen; every other failure at the same fixture or label stays a problem."""

    OVERLAP_REACH = {"top": ".ui-tabs__bar", "bottom": ".project-convo__composer"}
    OVERLAP_STOPS = {"left": None, "right": None, "up": ".ui-tabs__bar", "down": ".project-convo__composer"}
    CARD_OVERLAP = {"centre": ".tb-overview", "left": ".tb-overview", "right": ".tb-overview", "top": ".tb-overview"}
    # The rules are judged against this fixed table, not the live KNOWN_GAPS: a gap that closes in the app
    # leaves KNOWN_GAPS, but the rule must still prove it excuses only the recorded overlap (#342 merge).
    RULE_GAPS = {
        "640×360": {"a message's Reply": {"covered_by": (".ui-tabs__bar", ".project-convo__composer"), "reason": "rule fixture"}},
        "844×390": {
            "a message's Reply": {"covered_by": (".ui-tabs__bar", ".project-convo__composer"), "reason": "rule fixture"},
            "a task card": {"covered_by": (".tb-overview",), "reason": "rule fixture"},
        },
    }

    def setUp(self) -> None:
        super().setUp()
        patcher = mock.patch.dict(KNOWN_GAPS, self.RULE_GAPS, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_01_the_recorded_overlap_is_seen_not_failed(self) -> None:
        self.judge_reach("a message's Reply", "640×360", reach_result(self.OVERLAP_REACH))
        self.judge_target("a message's Reply", "640×360", target_result((49, 44), 49.5, 15, self.OVERLAP_STOPS))
        self.judge_reach("a message's Reply", "844×390", reach_result(self.OVERLAP_REACH))
        self.judge_target("a message's Reply", "844×390", target_result((46, 44), 46.5, 23, self.OVERLAP_STOPS))
        self.judge_reach("a task card", "844×390", reach_result(self.CARD_OVERLAP))
        self.judge_target("a task card", "844×390", target_result((232, 45), 0.5, 0.5, {side: ".tb-overview" for side in ("left", "right", "up", "down")}))
        self.assertEqual(self.problems, [], "the recorded overlap is not a problem")
        self.assertEqual(self.seen_gaps, {("640×360", "a message's Reply"), ("844×390", "a message's Reply"), ("844×390", "a task card")})

    def test_02_an_undersized_control_is_a_problem_under_the_same_overlap(self) -> None:
        self.judge_target("a message's Reply", "640×360", target_result((49, 24), 49.5, 12, self.OVERLAP_STOPS))
        self.judge_target("a task card", "844×390", target_result((232, 24), 0.5, 0.5, {side: ".tb-overview" for side in ("left", "right", "up", "down")}))
        self.assertEqual(len(self.problems), 2, f"a 24 px control is a size problem, not the overlap: {self.problems}")
        self.assertEqual(self.seen_gaps, set())

    def test_03_an_unrelated_stop_is_a_problem(self) -> None:
        unrelated = {"left": None, "right": None, "up": None, "down": None}
        self.judge_target("a message's Reply", "640×360", target_result((49, 44), 49.5, 15, unrelated))
        self.judge_target("a task card", "844×390", target_result((232, 45), 0.5, 0.5, unrelated))
        self.assertEqual(len(self.problems), 2, f"stops that no recorded overlay covers are problems: {self.problems}")
        self.assertEqual(self.seen_gaps, set())

    def test_04_an_unrelated_cover_is_a_problem(self) -> None:
        self.judge_reach("a task card", "844×390", reach_result({"centre": None, "left": None, "right": None, "top": ".tb-overview"}))
        self.judge_reach("a message's Reply", "640×360", reach_result({"top": ".ui-tabs__bar", "bottom": None}))
        self.assertEqual(len(self.problems), 2, f"a cover that is not a recorded overlay is a problem: {self.problems}")
        self.assertEqual(self.seen_gaps, set())

    def test_05_a_viewport_failure_is_a_problem_under_the_overlap(self) -> None:
        self.judge_reach("a message's Reply", "640×360", reach_result(self.OVERLAP_REACH, inside=False))
        self.assertEqual(len(self.problems), 1, f"the viewport failure stays a problem: {self.problems}")
        self.assertIn("lies fully inside the viewport", self.problems[0])
        self.assertEqual(self.seen_gaps, {("640×360", "a message's Reply")}, "the covered predicate of the recorded overlap is still seen")

    def test_06_the_overlap_is_not_excused_elsewhere(self) -> None:
        self.judge_reach("a message's Reply", "1280×720", reach_result(self.OVERLAP_REACH))
        self.judge_target("a message's Reply", "1280×720", target_result((49, 44), 49.5, 15, self.OVERLAP_STOPS))
        self.judge_reach("a list row", "640×360", reach_result(self.OVERLAP_REACH))
        self.judge_target("a message's Reply", "640×360", target_result((49, 44), 49.5, 15, {"left": None, "right": None, "up": ".tb-overview", "down": ".project-convo__composer"}))
        self.assertEqual(len(self.problems), 4, f"no gap at this fixture, another label, or another overlay: {self.problems}")
        self.assertEqual(self.seen_gaps, set())


if __name__ == "__main__":
    unittest.main()
