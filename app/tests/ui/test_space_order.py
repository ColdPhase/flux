"""The Spaces list is the person's own (#1250, v0.2.1): drag to reorder on a computer, long press then drag on touch, ⋯ › Move up / Move down for
the keyboard; Everyone stays first and never moves; the order is the same after a reload and shows in a second tab without animation; a new
space goes to the end; unread spaces are bold until opened; "Mark all as read" in the Spaces heading's ⋯ and in the Inbox, with Undo, leaves
what needs an action in the Inbox.

Motion is judged frame by frame (as motion_evidence.py samples rows): only `transform` and `opacity` change, the layout of every row stays where
it is until the drop, the other rows slide over `--dur-1` on `--ease-out`, Everyone never moves, nothing jumps when the drop ends, and with
reduced motion every move is instant. Run once per engine: `FLUX_UI_BROWSER=chromium|webkit ./scripts/check_ui.sh test_space_order`.

The people are real accounts of the stack's one company (check_ui.sh sets it up with its Everyone space, company_setup.py); the company owner
makes the spaces. Playwright has no long press, so a touch is dispatched as the pointer events a touch screen sends (message_gestures.py); one
Chromium check sends real touch events through CDP, which is the only way to see that a held finger that then moves does not scroll.
"""
from __future__ import annotations

import os
import re
import time
import unittest
import uuid
from pathlib import Path

from playwright.sync_api import BrowserContext, Page, expect, sync_playwright

from light_motion_fixture import RECORDER, TRANSFORM_ONLY, clear, numbers, ready, recorded
from message_gestures import centre, touch
from test_app_shell import ORIGIN, UI_BROWSER, UPSTREAM, start_forwarder
from test_work_pagination import api

# A 44 px touch target, less a 0.01 px sub-pixel tolerance (coordinator's approval, train 15): WebKit lays a box that starts on a
# fractional pixel out to 43.99999 px while it settles. This is not a smaller target: anything under 43.99 px still fails.
TARGET_PX = 44 - 0.01
PASSWORD = "an order of my own for the spaces"
NAMES = ["Release check", "Garden", "Barrel", "Library", "Tool shed"]
LIST = "nav[aria-labelledby='side-projects'] ul.side__list"
PHONE_LIST = "ul[aria-label='Spaces']"
ROW = "li[data-space-id]"
EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)"

# Every row of the list on each animation frame while a drag, a drop or a move runs: where it is (visual and layout), how it is posed and
# which transition it has. `list` is true while the list is being dragged (`data-reordering`). `glide` is the sidebar's traveling highlight
# (the selected space's pill) and `open` the selected row's link, `null` where the list has none.
SAMPLER = r"""
({ list, row }) => {
  const sample = window.__sample = { on: true, frames: [], transitions: [] };
  const root = document.querySelector(list);
  // The transitions the rows run, as the engine reports them (not as the frames happen to catch them: an engine may run a transform
  // transition on its compositor and not update the page's own values in between, and a busy page skips frames).
  const logged = (event) => {
    const li = event.target; if (!li.matches || !li.matches(row)) return;
    const a = event.type === 'transitionrun' ? li.getAnimations().find((x) => x.transitionProperty === event.propertyName) : null;
    sample.transitions.push({ type: event.type, name: (li.querySelector('.side__label, .set-row__t') || li).textContent.trim(), property: event.propertyName, elapsed: event.elapsedTime,
      duration: a ? a.effect.getTiming().duration : null, easing: a ? a.effect.getTiming().easing : null });
  };
  for (const type of ['transitionrun', 'transitionend', 'transitioncancel']) root.addEventListener(type, logged, true);
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); const li = el.closest('li');
    return { top: r.top, height: r.height, visibility: s.visibility, opacity: Number(s.opacity), ground: s.backgroundColor, running: el.getAnimations().length,
      lifted: !!li && li.classList.contains('is-lifted'), rowGround: li ? getComputedStyle(li).backgroundColor : '' }; };
  const read = (t) => ({ t, list: root.hasAttribute('data-reordering'), slot: !!root.querySelector('.reorder-slot'), glide: box(root.querySelector('.side__glide')), open: box(root.querySelector('.side__project.is-open')), rows: [...root.querySelectorAll(row)].map((li) => {
    const r = li.getBoundingClientRect(); const s = getComputedStyle(li);
    return { id: li.dataset.spaceId, name: (li.querySelector('.side__label, .set-row__t') || li).textContent.trim(), top: r.top, left: r.left, width: r.width, height: r.height, offsetTop: li.offsetTop, offsetHeight: li.offsetHeight,
      transform: s.transform, opacity: Number(s.opacity), shadow: s.boxShadow, ground: s.backgroundColor, property: s.transitionProperty, duration: s.transitionDuration,
      easing: s.transitionTimingFunction, lifted: li.classList.contains('is-lifted'), sliding: li.classList.contains('is-sliding') }; }) });
  const start = performance.now();
  const step = () => { if (!sample.on) return; sample.frames.push(read(performance.now() - start)); requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
"""


OUT = Path(os.environ.get("FLUX_UI_SCREENSHOTS", "/screenshots"))


def y_of(transform: str) -> float:
    """The vertical translation of a computed transform ('none' is 0)."""
    if transform == "none":
        return 0.0
    return float(transform.replace("matrix(", "").replace(")", "").split(",")[5])


class SpaceOrder(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}", flush=True)
        expect.set_options(timeout=12000)
        stamp = uuid.uuid4().hex[:8]
        cls.owner = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
        api(cls.owner, "POST", "/api/auth/sign-in/email", {"email": "company-setup@example.test", "password": "company setup for the checks"})
        cls.company = next(item["id"] for item in api(cls.owner, "GET", "/api/v1/workspaces") if item.get("company"))
        cls.ada = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
        email = f"order-ada-{stamp}@example.test"
        api(cls.ada, "POST", "/api/auth/sign-up/email", {"name": "Ada Order", "email": email, "password": PASSWORD})
        cls.ada_id = api(cls.ada, "GET", "/api/v1/me")["user"]["id"]
        api(cls.owner, "POST", f"/api/v1/workspaces/{cls.company}/members", {"email": email, "role": "member"}, 201)
        cls.spaces: dict[str, str] = {}
        for name in NAMES:
            space = api(cls.owner, "POST", f"/api/v1/workspaces/{cls.company}/projects", {"name": name, "visibility": "restricted"}, 201)["id"]
            api(cls.owner, "POST", f"/api/v1/projects/{space}/grants", {"principal": {"kind": "human", "id": cls.ada_id}, "role": "contributor"}, 201)
            cls.spaces[name] = space
        listed = api(cls.ada, "GET", f"/api/v1/workspaces/{cls.company}/projects?limit=100")["items"]
        cls.everyone = next(item["id"] for item in listed if item["visibility"] == "workspace")
        cls.state = cls.ada.storage_state()

    @classmethod
    def tearDownClass(cls):
        for context in (cls.ada, cls.owner):
            context.close()
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        """Every test starts with the spaces of the fixture only, in the order they were made in, and everything read."""
        for item in api(self.ada, "GET", f"/api/v1/workspaces/{self.company}/projects?limit=100")["items"]:
            if item["visibility"] != "workspace" and item["id"] not in self.spaces.values():
                api(self.owner, "DELETE", f"/api/v1/projects/{item['id']}", {}, 204)
        api(self.ada, "PUT", "/api/v1/me/space-order", {"order": []})
        api(self.ada, "POST", "/api/v1/me/read-all", {})

    # ------------------------------------------------------------------ helpers
    def context(self, *, phone: bool = False, reduced: bool = False, viewport: dict | None = None, touch_screen: bool = False, scheme: str = "light") -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "storage_state": self.state, "locale": "en-GB", "service_workers": "block", "color_scheme": scheme,
                         "reduced_motion": "reduce" if reduced else "no-preference", "viewport": viewport or ({"width": 390, "height": 844} if phone else {"width": 1440, "height": 900})}
        if phone or touch_screen:
            options.update(is_mobile=True, has_touch=True)
        context = self.browser.new_context(**options)
        context.add_init_script(RECORDER)
        self.addCleanup(context.close)
        return context

    def open(self, context: BrowserContext, url: str = "/") -> Page:
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        page.goto(url)
        ready(page)
        return page

    def names(self, page: Page) -> list[str]:
        return page.eval_on_selector_all(f"{LIST} {ROW}", "(rows) => rows.map((li) => li.querySelector('.side__label').textContent.trim())")

    def phone_names(self, page: Page) -> list[str]:
        return page.eval_on_selector_all("ul[aria-label='Spaces'] li[data-space-id]", "(rows) => rows.map((li) => li.querySelector('.set-row__t').textContent.trim())")

    def until(self, read, expected, timeout: int = 10000) -> None:
        """Waits for `read()` to return `expected` (a save and a live event take a moment)."""
        waited = 0
        while True:
            value = read()
            if value == expected:
                return
            if waited >= timeout:
                self.assertEqual(value, expected)
            time.sleep(0.1)
            waited += 100

    def server_order(self) -> list[str]:
        return api(self.ada, "GET", "/api/v1/me/space-order")["order"]

    def ids(self, *names: str) -> list[str]:
        return [self.spaces[name] for name in names]

    def row(self, page: Page, name: str):
        return page.locator(f"{LIST} {ROW}").filter(has=page.locator(".side__label", has_text=re.compile(f"^{re.escape(name)}$")))

    def drag(self, page: Page, name: str, to: str, *, hold: int = 260, above: bool = False, release_at: tuple[float, float] | None = None, finish: bool = True) -> None:
        """A mouse drag of the row `name` to where the row `to` is (just above its middle when `above`)."""
        source, target = self.row(page, name).locator("a").bounding_box(), self.row(page, to).locator("a").bounding_box()
        assert source and target
        x, y = source["x"] + source["width"] / 2, source["y"] + source["height"] / 2
        goal = target["y"] + target["height"] / 2 + (-12 if above else 0)
        page.mouse.move(x, y)
        page.mouse.down()
        for step in range(1, 13):
            page.mouse.move(x - 6 * step / 12, y + (goal - y) * step / 12)
            page.wait_for_timeout(16)
        page.wait_for_timeout(hold)
        if release_at:
            page.mouse.move(*release_at)
            page.wait_for_timeout(60)
        if finish:
            page.mouse.up()

    def settle(self, page: Page) -> None:
        expect(page.locator(f"{LIST}[data-reordering]")).to_have_count(0)
        page.wait_for_timeout(150)

    def sample(self, page: Page, list_: str = LIST) -> None:
        page.evaluate(SAMPLER, {"list": list_, "row": ROW})

    def frames(self, page: Page) -> list[dict]:
        return page.evaluate("() => { window.__sample.on = false; return window.__sample.frames; }")

    def slides(self, page: Page, name: str | None = None) -> list[dict]:
        """The transitions the sampled list's rows ran, in order (`transitionrun`, `transitionend`, `transitioncancel`)."""
        found = page.evaluate("() => window.__sample.transitions")
        return [item for item in found if name is None or item["name"] == name]

    def assert_slid_on_the_token(self, page: Page, name: str) -> None:
        """The row slid: a `transform` transition over --dur-1 on --ease-out that ran its full 120 ms and nothing else."""
        slides = self.slides(page, name)
        runs = [item for item in slides if item["type"] == "transitionrun"]
        self.assertTrue(runs, f"{name} slid: {slides}")
        for run in runs:
            self.assertEqual((run["property"], run["duration"]), ("transform", 120), name)
            self.assertEqual([round(n, 2) for n in numbers(run["easing"])], [0.22, 1, 0.36, 1], name)
        ends = [item for item in slides if item["type"] == "transitionend"]
        self.assertTrue(ends and all(abs(item["elapsed"] - 0.12) < 0.001 for item in ends), f"{name} ran its 120 ms: {slides}")

    def row_in(self, frame: dict, name: str) -> dict:
        return next(row for row in frame["rows"] if row["name"] == name)

    def assert_calm(self, frames: list[dict]) -> None:
        """What a drag, a drop and a glide back must never do: move a row in the layout, change its size, scale it, or move Everyone."""
        dragging = [frame for frame in frames if frame["list"]]
        self.assertTrue(dragging, "frames were sampled while the list was being dragged")
        first = dragging[0]
        for frame in dragging:
            for row in frame["rows"]:
                before = next(item for item in first["rows"] if item["id"] == row["id"])
                self.assertEqual((row["offsetTop"], row["offsetHeight"]), (before["offsetTop"], before["offsetHeight"]), f"{row['name']}: the layout of a row stays where it is while the list is dragged")
                self.assertAlmostEqual(row["width"], before["width"], delta=0.01, msg=f"{row['name']} keeps its width (nothing scales)")
                self.assertAlmostEqual(row["height"], before["height"], delta=0.01, msg=f"{row['name']} keeps its height (nothing scales)")
                self.assertAlmostEqual(row["left"], before["left"], delta=0.01, msg=f"{row['name']} stays in its column")
                self.assertEqual(row["opacity"], 1, "no row fades")
                self.assertNotIn("scale", row["transform"].lower())
                self.assertTrue(row["transform"] == "none" or row["transform"].startswith("matrix(1, 0, 0, 1, 0,"), f"{row['name']} moves only up and down: {row['transform']}")
        for frame in frames:
            everyone = self.row_in(frame, "Everyone")
            self.assertEqual(everyone["transform"], "none", "Everyone never moves")
            self.assertAlmostEqual(everyone["top"], self.row_in(frames[0], "Everyone")["top"], delta=0.01)
            self.assertFalse(everyone["lifted"])

    # ------------------------------------------------------------------ a mouse
    def test_a_drag_reorders_the_list_and_the_order_is_kept_and_shown_in_a_second_tab(self):
        context = self.context()
        page, other = self.open(context), self.open(context)
        self.assertEqual(self.names(page), ["Everyone", *NAMES], "the spaces are as they were made")
        self.sample(other)
        self.drag(page, "Library", "Release check")
        self.settle(page)
        expected = ["Everyone", "Library", "Release check", "Garden", "Barrel", "Tool shed"]
        self.assertEqual(self.names(page), expected)
        # Saved on the server, per person, without Everyone.
        self.until(self.server_order, self.ids("Library", "Release check", "Garden", "Barrel", "Tool shed"))
        # The second tab has it live: nobody reloaded it, and its rows did not move to get there.
        self.until(lambda: self.names(other), expected)
        frames = self.frames(other)
        for frame in frames:
            self.assertFalse(frame["list"] or frame["slot"], "the other tab never shows a drag")
            self.assertTrue(all(row["transform"] == "none" for row in frame["rows"]), "the other tab's rows take their places without sliding")
        self.assertEqual([entry for entry in recorded(other) if entry["target"].startswith("li.side__row")], [], "no animation runs in the other tab")
        page.reload()
        ready(page)
        self.assertEqual(self.names(page), expected, "the order survives a reload")
        self.assertEqual(self.names(other), expected)

    def test_frames_of_a_drag_only_move_transform_the_others_slide_on_the_token_and_nothing_jumps_at_the_drop(self):
        page = self.open(self.context())
        pitch = self.row(page, "Garden").bounding_box()["y"] - self.row(page, "Release check").bounding_box()["y"]
        self.sample(page)
        self.drag(page, "Library", "Release check", hold=350)
        self.settle(page)
        frames = self.frames(page)
        self.assert_calm(frames)
        dragging = [frame for frame in frames if frame["list"]]
        # The dragged row is lifted: the --el fill and the --sh-pop shadow; the slot it will land in is shown.
        lifted = [self.row_in(frame, "Library") for frame in dragging if self.row_in(frame, "Library")["lifted"]]
        self.assertTrue(lifted and all(row["shadow"] != "none" and row["ground"] == "rgb(255, 255, 255)" for row in lifted), lifted[:1])
        self.assertTrue(all("0px 0px 0px 1px" in row["shadow"] for row in lifted), f"the lift has its --line2 ring, which carries it in the dark: {lifted[0]['shadow']}")
        self.assertTrue(any(frame["slot"] for frame in dragging))
        # It follows the pointer on translateY and goes up by three rows.
        self.assertAlmostEqual(min(y_of(self.row_in(frame, "Library")["transform"]) for frame in dragging), -3 * pitch, delta=pitch / 2 + 4)
        # The rows it passed slide out of its way: a transform over --dur-1 on --ease-out, in more than one frame, to one row's pitch.
        for name in ("Release check", "Garden", "Barrel"):
            series = [(frame["t"], y_of(self.row_in(frame, name)["transform"])) for frame in dragging]
            self.assertAlmostEqual(series[-1][1], pitch, delta=1.5, msg=f"{name} ends one row lower, under the dragged row's gap")
            started = next(t for t, y in series if abs(y) > 0.5)
            ended = next(t for t, y in series if abs(y - pitch) < 0.5)
            self.assertLessEqual(ended - started, 220, f"{name} takes about --dur-1 (120 ms)")
            self.assert_slid_on_the_token(page, name)
            sliding = next(row for row in (self.row_in(frame, name) for frame in dragging) if row["sliding"])
            self.assertEqual((sliding["property"], sliding["duration"], sliding["easing"]), ("transform", "0.12s", EASE_OUT), name)
        # Tool shed was never passed: it stays.
        self.assertTrue(all(self.row_in(frame, "Tool shed")["transform"] == "none" for frame in dragging))
        # The drop: the row settles into the gap over --dur-1; when the list is changed nothing jumps (every row is where it was drawn).
        change = next(i for i, frame in enumerate(frames) if i and frames[i - 1]["list"] and not frame["list"])
        before, after = frames[change - 1], frames[change]
        for row in before["rows"]:
            self.assertAlmostEqual(row["top"], self.row_in(after, row["name"])["top"], delta=1.5, msg=f"{row['name']} does not jump when the drop ends")
        self.assertTrue(all(row["transform"] == "none" for row in after["rows"]), "the inline transforms are gone with the drop")
        # Everything that animated is a transform: the page's own record names no other property.
        for entry in recorded(page):
            if entry["target"].startswith("li."):
                self.assertTrue(set(entry["props"]) <= TRANSFORM_ONLY, entry)

    def assert_highlight_rides_along(self, frames: list[dict], pitch: float) -> None:
        """The selected space's highlight while its list is dragged and after the drop: the open row draws its own pill and goes with its row,
        the traveling highlight waits, and when the drop ends it stands on the row's place at once, without a motion of its own."""
        dragging = [frame for frame in frames if frame["list"]]
        self.assertTrue(dragging)
        for frame in dragging:
            self.assertEqual(frame["glide"]["visibility"], "hidden", "the traveling highlight is not left behind in the old slot")
            opened = frame["open"]
            ground = opened["rowGround"] if opened["lifted"] else opened["ground"]
            self.assertEqual(ground, "rgb(255, 255, 255)", "the open row draws its own pill, so it goes with its row")
        tops = [frame["open"]["top"] for frame in dragging]
        self.assertGreater(max(tops) - min(tops), pitch / 2, "the open row's pill moved with its row")
        change = next(i for i, frame in enumerate(frames) if i and frames[i - 1]["list"] and not frame["list"])
        after = frames[change:]
        self.assertTrue(after)
        for frame in after:
            self.assertEqual(frame["glide"]["visibility"], "visible")
            self.assertAlmostEqual(frame["glide"]["top"], frame["open"]["top"], delta=1.5, msg="the highlight is on the open row from the first frame after the drop")
            self.assertEqual(frame["glide"]["running"], 0, "the highlight has no motion of its own after the drop")
        self.assertAlmostEqual(after[0]["glide"]["top"], after[-1]["glide"]["top"], delta=1.5, msg="and it does not move afterwards")

    def test_the_open_spaces_highlight_goes_with_its_row_in_a_drag_and_lands_with_it_without_a_second_motion(self):
        page = self.open(self.context(), f"/projects/{self.spaces['Garden']}")
        expect(page.locator(f"{LIST}.has-glide .side__project.is-open")).to_have_count(1)
        page.wait_for_timeout(400)
        pitch = self.row(page, "Garden").bounding_box()["y"] - self.row(page, "Release check").bounding_box()["y"]
        glide = page.locator(f"{LIST} .side__glide")
        self.assertAlmostEqual(glide.bounding_box()["y"], self.row(page, "Garden").locator("a").bounding_box()["y"], delta=1.5, msg="at rest the highlight is on the open row")
        # The open row itself is dragged down past two others.
        self.sample(page)
        self.drag(page, "Garden", "Library", hold=350)
        self.settle(page)
        frames = self.frames(page)
        moved = self.names(page)
        self.assertGreater(moved.index("Garden"), 2, f"Garden went down: {moved}")
        self.assert_highlight_rides_along(frames, pitch)
        self.assert_calm(frames)
        self.until(self.server_order, [self.spaces[name] for name in moved[1:]])
        # Another row is dragged past the open one: the open row slides out of its way and its pill slides with it.
        name_above = moved[-1]
        self.sample(page)
        self.drag(page, name_above, moved[1], hold=350)
        self.settle(page)
        frames = self.frames(page)
        after = self.names(page)
        self.assertEqual(after[1], name_above)
        self.assertEqual(after.index("Garden"), moved.index("Garden") + 1, "Garden was passed once and is one place lower")
        self.assert_highlight_rides_along(frames, pitch)
        # The rows' own transitions are the only motion: no frame has the highlight anywhere but its row, and only a click moves it.
        self.row(page, "Barrel").locator("a").click()
        expect(page.locator(f"{LIST} .side__project.is-open")).to_have_attribute("data-glide-id", self.spaces["Barrel"])

    def test_a_drag_never_passes_everyone_and_clamps_to_the_list(self):
        page = self.open(self.context())
        self.drag(page, "Garden", "Everyone", above=True)
        self.settle(page)
        self.assertEqual(self.names(page)[:3], ["Everyone", "Garden", "Release check"], "above Everyone is the first place after it")

    def test_escape_and_a_release_outside_the_list_glide_the_row_back(self):
        page = self.open(self.context())
        self.sample(page)
        self.drag(page, "Library", "Release check", finish=False)
        expect(page.locator(f"{LIST}[data-reordering]")).to_have_count(1)
        page.keyboard.press("Escape")
        page.mouse.up()
        self.settle(page)
        self.assertEqual(self.names(page), ["Everyone", *NAMES], "Esc cancels the drag")
        # Released over the page, outside the list.
        self.drag(page, "Library", "Release check", release_at=(900, 400))
        self.settle(page)
        self.assertEqual(self.names(page), ["Everyone", *NAMES], "a release outside the list cancels it")
        frames = self.frames(page)
        self.assert_calm(frames)
        self.assertEqual(page.eval_on_selector_all(f"{LIST} {ROW}", "(rows) => rows.map((li) => getComputedStyle(li).transform)"), ["none"] * 6, "every row is back in its place")
        self.assertEqual(self.server_order(), [], "a cancelled drag saves nothing")

    def test_a_click_still_opens_the_space_and_a_drag_does_not(self):
        page = self.open(self.context())
        self.row(page, "Garden").locator("a").click()
        expect(page).to_have_url(re.compile(f"/projects/{self.spaces['Garden']}"))
        self.drag(page, "Barrel", "Garden")
        self.settle(page)
        expect(page).to_have_url(re.compile(f"/projects/{self.spaces['Garden']}"))
        self.assertEqual(self.names(page), ["Everyone", "Release check", "Barrel", "Garden", "Library", "Tool shed"])

    def test_a_new_space_goes_to_the_end(self):
        page = self.open(self.context())
        self.drag(page, "Library", "Release check")
        self.settle(page)
        self.until(self.server_order, self.ids("Library", "Release check", "Garden", "Barrel", "Tool shed"))
        fresh = api(self.owner, "POST", f"/api/v1/workspaces/{self.company}/projects", {"name": "Newest space", "visibility": "restricted"}, 201)["id"]
        api(self.owner, "POST", f"/api/v1/projects/{fresh}/grants", {"principal": {"kind": "human", "id": self.ada_id}, "role": "contributor"}, 201)
        self.addCleanup(lambda: api(self.owner, "DELETE", f"/api/v1/projects/{fresh}", {}, 204))
        page.reload()
        ready(page)
        self.assertEqual(self.names(page), ["Everyone", "Library", "Release check", "Garden", "Barrel", "Tool shed", "Newest space"])

    def test_a_long_list_scrolls_itself_near_its_edge_while_a_row_is_dragged(self):
        page = self.open(self.context(viewport={"width": 1440, "height": 520}))
        area = page.locator(".side__scroll")
        box = area.bounding_box()
        assert box
        self.assertGreater(area.evaluate("(el) => el.scrollHeight - el.clientHeight"), 20, "the sidebar scrolls in a window this low")
        start = self.row(page, "Release check").locator("a").bounding_box()
        assert start
        page.mouse.move(start["x"] + 80, start["y"] + start["height"] / 2)
        page.mouse.down()
        page.mouse.move(start["x"] + 82, start["y"] + start["height"] / 2 + 30, steps=4)
        page.mouse.move(start["x"] + 82, box["y"] + box["height"] - 8, steps=6)
        page.wait_for_timeout(700)
        self.assertGreater(area.evaluate("(el) => el.scrollTop"), 10, "the list scrolled itself")
        page.keyboard.press("Escape")
        self.settle(page)
        self.assertEqual(self.names(page), ["Everyone", *NAMES])

    # ------------------------------------------------------------------ the keyboard
    def menu_move(self, page: Page, name: str, item: str) -> None:
        button = page.get_by_role("button", name=f"More for {name}", exact=True)
        button.focus()
        page.keyboard.press("Enter")
        menu = page.get_by_role("menu", name=f"More for {name}", exact=True)
        expect(menu).to_be_visible()
        menu.get_by_role("menuitem", name=item, exact=True).click()

    def test_the_keyboard_moves_a_row_one_step_keeps_the_focus_and_says_where_it_went(self):
        page = self.open(self.context())
        # Everyone has no ⋯; the first movable row has no Move up and the last no Move down.
        self.assertEqual(page.get_by_role("button", name="More for Everyone").count(), 0)
        self.row(page, "Release check").locator(".side__more").focus()
        page.keyboard.press("Enter")
        menu = page.get_by_role("menu", name="More for Release check", exact=True)
        self.assertEqual(menu.get_by_role("menuitem").all_inner_texts(), ["Move down"])
        page.keyboard.press("Escape")
        self.row(page, "Tool shed").locator(".side__more").focus()
        page.keyboard.press("Enter")
        self.assertEqual(page.get_by_role("menu", name="More for Tool shed", exact=True).get_by_role("menuitem").all_inner_texts(), ["Move up"])
        page.keyboard.press("Escape")
        clear(page)
        self.sample(page)
        self.menu_move(page, "Garden", "Move up")
        page.wait_for_timeout(400)
        frames = self.frames(page)
        self.assertEqual(self.names(page), ["Everyone", "Garden", "Release check", "Barrel", "Library", "Tool shed"])
        expect(page.get_by_role("status").filter(has_text="moved to position")).to_have_text("Garden, moved to position 2 of 6")
        self.assertEqual(page.evaluate("document.activeElement.getAttribute('aria-label')"), "More for Garden", "the focus stays on the row's ⋯")
        self.until(self.server_order, self.ids("Garden", "Release check", "Barrel", "Library", "Tool shed"))
        # The two rows that swapped slide over --dur-1 on --ease-out, with a transform and nothing else (the same `is-sliding` transition as
        # in a drag, which every engine reads the same way); Everyone does not move.
        for name in ("Garden", "Release check"):
            self.assert_slid_on_the_token(page, name)
            self.assertEqual(self.row_in(frames[-1], name)["transform"], "none", f"{name} ends in its place")
        for frame in frames:
            self.assertEqual(self.row_in(frame, "Everyone")["transform"], "none")
            self.assertEqual(self.row_in(frame, "Everyone")["top"], self.row_in(frames[0], "Everyone")["top"])
        self.assertEqual([entry for entry in recorded(page) if entry["target"].startswith("li.side__row")], [], "no script animation: the rows use the transition")
        # Move down from the same row.
        self.menu_move(page, "Garden", "Move down")
        self.until(self.server_order, self.ids("Release check", "Garden", "Barrel", "Library", "Tool shed"))
        page.reload()
        ready(page)
        self.assertEqual(self.names(page), ["Everyone", "Release check", "Garden", "Barrel", "Library", "Tool shed"])

    def test_with_reduced_motion_every_move_is_instant(self):
        page = self.open(self.context(reduced=True))
        self.sample(page)
        self.drag(page, "Library", "Release check", hold=250)
        self.settle(page)
        frames = self.frames(page)
        self.assertEqual(self.names(page), ["Everyone", "Library", "Release check", "Garden", "Barrel", "Tool shed"])
        dragging = [frame for frame in frames if frame["list"]]
        for name in ("Release check", "Garden", "Barrel"):
            ys = {round(y_of(self.row_in(frame, name)["transform"])) for frame in dragging}
            self.assertEqual(len(ys), 2, f"{name} goes from its place to its gap in one frame: {sorted(ys)}")
            self.assertTrue(all(self.row_in(frame, name)["duration"] == "0s" for frame in dragging if self.row_in(frame, name)["sliding"]))
        change = next(i for i, frame in enumerate(frames) if i and frames[i - 1]["list"] and not frame["list"])
        for row in frames[change - 1]["rows"]:
            self.assertAlmostEqual(row["top"], self.row_in(frames[change], row["name"])["top"], delta=1.5)
        self.assertEqual(self.slides(page), [], "no row runs a transition")
        clear(page)
        self.sample(page)
        self.menu_move(page, "Garden", "Move up")
        page.wait_for_timeout(300)
        moves = self.frames(page)
        for name in ("Garden", "Release check"):
            self.assertEqual(len({round(self.row_in(frame, name)["top"]) for frame in moves}), 2, f"{name} is at once where it goes")
        self.assertEqual(self.slides(page), [], "the keyboard move runs no transition either")
        self.assertEqual([entry for entry in recorded(page) if entry["kind"] == "script" and entry["props"] == ["transform"] and entry["duration"] > 0], [])

    # ------------------------------------------------------------------ unread, and Mark all as read
    def unread_state(self, page: Page, name: str) -> tuple[str, str, bool]:
        link = self.row(page, name).locator("a")
        return link.evaluate("(a) => [getComputedStyle(a).fontWeight, getComputedStyle(a).color, !!a.querySelector('.side__dot')]")

    def say(self, name: str, text: str) -> str:
        return api(self.owner, "POST", f"/api/v1/projects/{self.spaces[name]}/conversations", {"body": text, "clientMessageId": str(uuid.uuid4())}, 201)["id"]

    def propose(self, name: str, title: str) -> None:
        """A decision Ada can accept: it needs her, and it is in her Inbox at once (it is read from the rows, not written by the worker)."""
        api(self.owner, "POST", f"/api/v1/projects/{self.spaces[name]}/decisions", {"title": title, "rationale": "So that it is not forgotten."}, 201)

    def test_unread_spaces_are_bold_until_opened_and_the_dot_is_for_what_needs_you(self):
        self.say("Garden", "The sensors arrived.")
        self.say("Library", "Shelves are up.")
        self.propose("Barrel", "Cover the barrel in winter")
        page = self.open(self.context())
        expect(self.row(page, "Garden").locator("a.is-unread")).to_have_count(1)
        read, unread = self.unread_state(page, "Tool shed"), self.unread_state(page, "Garden")
        self.assertEqual((read[0], unread[0]), ("500", "600"))
        self.assertNotEqual(read[1], unread[1], "unread is the primary colour, read the quiet one")
        t1, t2 = page.evaluate("() => { const s = getComputedStyle(document.documentElement); const probe = (v) => { const e = document.createElement('i'); e.style.color = `var(${v})`; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; }; return [probe('--t1'), probe('--t2')]; }")
        self.assertEqual((unread[1], read[1]), (t1, t2))
        self.assertFalse(unread[2], "news alone has no dot")
        self.assertTrue(self.unread_state(page, "Barrel")[2], "a decision Ada can accept is what the dot is for")
        self.assertEqual(self.unread_state(page, "Tool shed")[0], "500")
        self.assertEqual(self.row(page, "Garden").locator("a").get_attribute("aria-label"), "Garden, new activity")
        self.assertEqual(self.row(page, "Barrel").locator("a").get_attribute("aria-label"), "Barrel, new activity, needs you", "the dot has its words for a screen reader")
        self.assertIsNone(self.row(page, "Tool shed").locator("a").get_attribute("aria-label"))
        # Opening a space reads it: it is no longer bold once the person has been there and left.
        self.row(page, "Garden").locator("a").click()
        expect(page).to_have_url(re.compile(f"/projects/{self.spaces['Garden']}"))
        page.wait_for_timeout(500)
        page.get_by_role("navigation", name="Places").get_by_role("link", name="Home").click()
        expect(self.row(page, "Garden").locator("a:not(.is-unread)")).to_have_count(1)
        self.assertEqual(self.unread_state(page, "Garden")[0], "500")
        self.assertEqual(self.unread_state(page, "Library")[0], "600", "what was not opened stays bold")

    def test_mark_all_as_read_from_the_spaces_menu_and_from_the_inbox_keeps_what_needs_you_and_can_be_undone(self):
        self.say("Garden", "The sensors arrived.")
        self.say("Library", "Shelves are up.")
        self.propose("Barrel", "Cover the barrel in winter")
        page = self.open(self.context())
        expect(page.locator(f"{LIST} a.is-unread")).to_have_count(3)
        page.get_by_role("button", name="More for Spaces", exact=True).click()
        page.get_by_role("menuitem", name="Mark all as read", exact=True).click()
        toast = page.locator(".ui-toast").filter(has_text="Marked all as read")
        expect(toast).to_be_visible()
        self.assertEqual(toast.locator(".ui-toast__action").evaluate("(el) => getComputedStyle(el).boxShadow"), "none", "no ring around Undo: the separator is its divider")
        expect(page.locator(f"{LIST} a.is-unread")).to_have_count(0)
        self.assertTrue(self.unread_state(page, "Barrel")[2], "the decision still has its dot")
        toast.get_by_role("button", name="Undo").click()
        expect(page.locator(f"{LIST} a.is-unread")).to_have_count(3)
        # The Inbox: the same action, and its action items are still there afterwards.
        page.get_by_role("navigation", name="Places").get_by_role("link", name=re.compile("^Inbox")).click()
        expect(page.get_by_role("list", name="Needs you").get_by_text(re.compile("Cover the barrel in winter"))).to_be_visible()
        page.get_by_role("button", name="More", exact=True).click()
        page.get_by_role("menuitem", name="Mark all as read", exact=True).click()
        expect(page.locator(".ui-toast").filter(has_text="Marked all as read")).to_be_visible()
        expect(page.locator(f"{LIST} a.is-unread")).to_have_count(0)
        expect(page.get_by_role("list", name="Needs you").get_by_text(re.compile("Cover the barrel in winter"))).to_be_visible()
        self.assertGreaterEqual(api(self.ada, "GET", "/api/v1/needs-you")["count"], 1, "the decision still needs Ada")

    def test_undo_does_not_make_a_space_unread_that_was_opened_after_mark_all_as_read(self):
        self.say("Garden", "The sensors arrived.")
        self.say("Library", "Shelves are up.")
        page = self.open(self.context())
        expect(page.locator(f"{LIST} a.is-unread")).to_have_count(2)
        page.get_by_role("button", name="More for Spaces", exact=True).click()
        page.get_by_role("menuitem", name="Mark all as read", exact=True).click()
        toast = page.locator(".ui-toast").filter(has_text="Marked all as read")
        expect(toast).to_be_visible()
        expect(page.locator(f"{LIST} a.is-unread")).to_have_count(0)
        # Garden is opened while the toast is up; no new activity arrives there.
        self.row(page, "Garden").locator("a").click()
        expect(page).to_have_url(re.compile(f"/projects/{self.spaces['Garden']}"))
        page.wait_for_timeout(400)
        toast.get_by_role("button", name="Undo").click()
        page.get_by_role("navigation", name="Places").get_by_role("link", name="Home").click()
        expect(self.row(page, "Library").locator("a.is-unread")).to_have_count(1)
        expect(self.row(page, "Garden").locator("a:not(.is-unread)")).to_have_count(1)
        self.assertEqual(api(self.ada, "GET", "/api/v1/return?place=project&id=" + self.spaces["Garden"])["items"], [], "the space that was opened stays read")
        self.assertTrue(api(self.ada, "GET", "/api/v1/return?place=project&id=" + self.spaces["Library"])["items"], "the one that was not comes back")

    # ------------------------------------------------------------------ touch
    def phone_row(self, page: Page, name: str):
        return page.locator("ul[aria-label='Spaces'] li[data-space-id]").filter(has=page.locator(".set-row__t", has_text=re.compile(f"^{re.escape(name)}$")))

    def long_press_drag(self, page: Page, name: str, to: str, *, hold: int = 620, steps: int = 10, release: bool = True) -> None:
        link = self.phone_row(page, name).locator("a")
        x, y = centre(link)
        _, goal = centre(self.phone_row(page, to).locator("a"))
        touch(link, "pointerdown", x, y)
        page.wait_for_timeout(hold)
        for step in range(1, steps + 1):
            touch(link, "pointermove", x, y + (goal - y) * step / steps)
            page.wait_for_timeout(16)
        page.wait_for_timeout(260)
        if release:
            touch(link, "pointerup", x, goal)

    def test_a_long_press_then_a_drag_reorders_the_phones_spaces_and_a_swipe_only_scrolls(self):
        page = self.open(self.context(phone=True), "/projects")
        expect(self.phone_row(page, "Library")).to_be_visible()
        self.assertEqual(self.phone_names(page), ["Everyone", *NAMES])
        # A finger that moves before the long press is a scroll: nothing lifts, not even when the press time passes.
        link = self.phone_row(page, "Library").locator("a")
        x, y = centre(link)
        touch(link, "pointerdown", x, y)
        touch(link, "pointermove", x, y - 40)
        page.wait_for_timeout(650)
        self.assertEqual(page.locator(".is-lifted").count(), 0)
        touch(link, "pointerup", x, y - 40)
        self.assertEqual(self.phone_names(page), ["Everyone", *NAMES])
        self.assertEqual(self.server_order(), [])
        # A long press and then a drag.
        self.sample(page, PHONE_LIST)
        self.long_press_drag(page, "Library", "Release check")
        expect(page.locator("ul[aria-label='Spaces'][data-reordering]")).to_have_count(0)
        page.wait_for_timeout(200)
        frames = self.frames(page)
        self.assertEqual(self.phone_names(page), ["Everyone", "Library", "Release check", "Garden", "Barrel", "Tool shed"])
        self.until(self.server_order, self.ids("Library", "Release check", "Garden", "Barrel", "Tool shed"))
        dragging = [frame for frame in frames if frame["list"]]
        self.assertTrue(dragging and any(row["lifted"] for frame in dragging for row in frame["rows"]), "the row lifted after the long press")
        for frame in dragging:
            for row in frame["rows"]:
                self.assertTrue(row["transform"] == "none" or row["transform"].startswith("matrix(1, 0, 0, 1, 0,"))
                self.assertEqual(row["opacity"], 1)
            everyone = next(row for row in frame["rows"] if row["name"].startswith("Everyone"))
            self.assertEqual(everyone["transform"], "none")
        page.reload()
        ready(page)
        self.assertEqual(self.phone_names(page), ["Everyone", "Library", "Release check", "Garden", "Barrel", "Tool shed"], "the order is the same after a reload")
        # A tap still opens a space; a long press that is let go without moving opens nothing.
        link = self.phone_row(page, "Barrel").locator("a")
        x, y = centre(link)
        touch(link, "pointerdown", x, y)
        page.wait_for_timeout(600)
        touch(link, "pointerup", x, y)
        page.wait_for_timeout(200)
        expect(page).to_have_url(re.compile("/projects$"))
        self.phone_row(page, "Barrel").locator("a").tap()
        expect(page).to_have_url(re.compile(f"/projects/{self.spaces['Barrel']}"))

    def test_the_phones_spaces_follow_the_same_order_and_a_second_device_sees_it(self):
        api(self.ada, "PUT", "/api/v1/me/space-order", {"order": self.ids("Tool shed", "Barrel", "Library", "Garden", "Release check")})
        phone = self.open(self.context(phone=True), "/projects")
        expect(self.phone_row(phone, "Tool shed")).to_be_visible()
        self.assertEqual(self.phone_names(phone), ["Everyone", "Tool shed", "Barrel", "Library", "Garden", "Release check"])
        computer = self.open(self.context())
        self.assertEqual(self.names(computer), ["Everyone", "Tool shed", "Barrel", "Library", "Garden", "Release check"])
        # The phone's ⋯ is always shown; the keyboard and a screen reader use it the same way.
        phone.get_by_role("button", name="More for Barrel", exact=True).focus()
        phone.keyboard.press("Enter")
        phone.get_by_role("menuitem", name="Move up", exact=True).click()
        self.until(self.server_order, self.ids("Barrel", "Tool shed", "Library", "Garden", "Release check"))
        self.until(lambda: self.names(computer), ["Everyone", "Barrel", "Tool shed", "Library", "Garden", "Release check"])

    def assert_more_is_a_touch_target(self, button, row_end: list[dict]) -> None:
        """The row's ⋯ on a touch screen: drawn, tappable, 44 px, and clear of what the row shows at its end."""
        self.assertEqual(button.evaluate("(el) => { const s = getComputedStyle(el.closest('.top__more')); return [s.opacity, s.pointerEvents]; }"), ["1", "auto"], "always shown on touch")
        box = button.bounding_box()
        assert box
        self.assertGreaterEqual(min(box["width"], box["height"]), TARGET_PX, "a 44 px target")
        for other in row_end:
            self.assertLessEqual(other["x"] + other["width"], box["x"] + 1, "the dot, the count and the chevron stay clear of the ⋯")

    def test_on_a_touch_screen_move_up_and_down_are_a_tap_away_on_the_phones_tab_and_the_tablets_drawer(self):
        self.propose("Barrel", "Cover the barrel in winter")
        OUT.mkdir(parents=True, exist_ok=True)
        # The phone's Spaces tab: the ⋯ is on every row but Everyone's, and a tap moves the row (a gesture is never the only way, #343).
        page = self.open(self.context(phone=True), "/projects")
        expect(self.phone_row(page, "Barrel")).to_be_visible()
        self.assertEqual(page.get_by_role("button", name="More for Everyone").count(), 0)
        row = self.phone_row(page, "Barrel")
        expect(row.locator("a")).to_have_attribute("aria-label", "Barrel, new activity, needs you")
        more = page.get_by_role("button", name="More for Barrel", exact=True)
        expect(more).to_be_visible()
        self.assert_more_is_a_touch_target(more, [row.locator(".proj-index__dot").bounding_box(), row.locator(".set-row__go").bounding_box()])
        for name in ("Release check", "Tool shed"):
            self.assert_more_is_a_touch_target(page.get_by_role("button", name=f"More for {name}", exact=True), [])
        more.tap()
        page.get_by_role("menuitem", name="Move up", exact=True).tap()
        self.until(self.server_order, self.ids("Release check", "Barrel", "Garden", "Library", "Tool shed"))
        self.assertEqual(self.phone_names(page), ["Everyone", "Release check", "Barrel", "Garden", "Library", "Tool shed"])
        page.screenshot(path=str(OUT / f"{self.browser.browser_type.name}-light-390-spaces-tab-more.png"))
        # The tablet's drawer, on a touch screen: the same.
        tablet = self.open(self.context(touch_screen=True, viewport={"width": 660, "height": 844}), "/")
        tablet.get_by_role("button", name="Open navigation").tap()
        drawer = tablet.locator("#nav-drawer")
        expect(drawer.get_by_role("button", name="More for Garden", exact=True)).to_be_visible()
        barrel = drawer.locator("li[data-space-id]").filter(has=tablet.locator(".side__label", has_text=re.compile("^Barrel$")))
        self.assert_more_is_a_touch_target(drawer.get_by_role("button", name="More for Barrel", exact=True), [barrel.locator(".side__dot").bounding_box()])
        drawer.get_by_role("button", name="More for Garden", exact=True).tap()
        tablet.get_by_role("menuitem", name="Move down", exact=True).tap()
        self.until(self.server_order, self.ids("Release check", "Barrel", "Library", "Garden", "Tool shed"))
        tablet.screenshot(path=str(OUT / f"{self.browser.browser_type.name}-light-660-drawer-more.png"))

    def test_a_sidebar_that_scrolls_shows_where_and_keeps_the_current_place_in_view_and_the_drawer_holds_the_same_items(self):
        """#1375: where the sidebar's list can scroll its edge fades (there was no sign of rows below the fold), the open space stays in view
        when its address is opened, and the drawer has the sidebar's items: the Spaces ⋯ (no "+" beside Spaces or Messages) and no email."""
        page = self.open(self.context(touch_screen=True, viewport={"width": 1180, "height": 460}), "/")
        scroll = page.locator(".side__scroll")
        expect(scroll).to_have_attribute("data-scroll-down", "")
        expect(scroll).not_to_have_attribute("data-scroll-up", "")
        self.assertNotEqual(scroll.evaluate("el => getComputedStyle(el).maskImage"), "none", "a fade at the lower edge shows the list goes on")
        last = NAMES[-1]
        page.goto(f"/projects/{self.spaces[last]}")
        ready(page)
        page.wait_for_function(
            """(name) => { const label = [...document.querySelectorAll('.side__scroll .side__project.is-open .side__label')].find((el) => el.textContent.trim() === name);
                if (!label) return false; const r = label.getBoundingClientRect(); const s = document.querySelector('.side__scroll').getBoundingClientRect();
                return r.top >= s.top - 1 && r.bottom <= s.bottom + 1; }""", arg=last)
        expect(scroll).to_have_attribute("data-scroll-up", "")
        # The tablet's rail: its list of spaces fades the same way where a tile is cut (it was cut behind the account face).
        rail = self.open(self.context(touch_screen=True, viewport={"width": 820, "height": 520}), "/")
        expect(rail.locator(".side__rail-scroll")).to_have_attribute("data-scroll-down", "")
        self.assertNotEqual(rail.locator(".side__rail-scroll").evaluate("el => getComputedStyle(el).maskImage"), "none")
        # The drawer (a narrow touch screen) holds what the sidebar holds.
        tablet = self.open(self.context(touch_screen=True, viewport={"width": 660, "height": 844}), "/")
        tablet.get_by_role("button", name="Open navigation").tap()
        drawer = tablet.locator("#nav-drawer")
        expect(drawer.get_by_role("button", name="More for Spaces", exact=True)).to_be_visible()
        expect(drawer.get_by_role("button", name="New space", exact=True)).to_have_count(0)
        # No "+" of its own (New creates, #1375); this person has no message and no agent yet, so Messages has the computer sidebar's "+" (#1424).
        expect(drawer.get_by_role("link", name="New message", exact=True)).to_have_count(1)
        mail = drawer.locator(".me__text span").bounding_box()
        self.assertLessEqual(mail["width"], 1, "the email is not drawn under the name")
        self.assertEqual(tablet.evaluate("getComputedStyle(document.getElementById('nav-drawer')).outlineStyle"), "none", "no frame around the whole drawer")

    def test_mark_all_as_read_on_the_phone_from_the_inbox_and_the_spaces_tab(self):
        self.say("Garden", "The sensors arrived.")
        self.say("Library", "Shelves are up.")
        page = self.open(self.context(phone=True), "/projects")
        expect(self.phone_row(page, "Garden").locator("a.is-unread")).to_have_count(1)
        self.assertEqual(self.phone_row(page, "Garden").locator(".set-row__t").evaluate("(el) => getComputedStyle(el).fontWeight"), "600")
        page.get_by_role("button", name="More", exact=True).tap()
        page.get_by_role("menuitem", name="Mark all as read", exact=True).tap()
        toast = page.locator(".ui-toast").filter(has_text="Marked all as read")
        expect(toast).to_be_visible()
        expect(page.locator("ul[aria-label='Spaces'] a.is-unread")).to_have_count(0)
        toast.get_by_role("button", name="Undo").tap()
        expect(page.locator("ul[aria-label='Spaces'] a.is-unread")).to_have_count(2)
        page.goto("/inbox")
        ready(page)
        page.get_by_role("button", name="More", exact=True).tap()
        page.get_by_role("menuitem", name="Mark all as read", exact=True).tap()
        expect(page.locator(".ui-toast").filter(has_text="Marked all as read")).to_be_visible()
        self.until(lambda: api(self.ada, "GET", "/api/v1/return?place=project&id=" + self.spaces["Garden"])["items"], [])

    @unittest.skipUnless(UI_BROWSER == "chromium", "real touch events through CDP are Chromium's")
    def test_with_real_touch_a_held_finger_that_then_moves_lifts_the_row_and_does_not_scroll_the_list(self):
        page = self.open(self.context(phone=True), "/projects")
        expect(self.phone_row(page, "Library")).to_be_visible()
        link = self.phone_row(page, "Library").locator("a")
        x, y = centre(link)
        _, goal = centre(self.phone_row(page, "Release check").locator("a"))
        scrolled = page.evaluate("window.scrollY")
        cdp = page.context.new_cdp_session(page)
        try:
            cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
            page.wait_for_timeout(650)
            for step in range(1, 11):
                cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y + (goal - y) * step / 10}]})
                page.wait_for_timeout(16)
            page.wait_for_timeout(250)
            self.assertEqual(page.locator(".is-lifted").count(), 1)
            cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        finally:
            cdp.detach()
        page.wait_for_timeout(400)
        self.assertEqual(page.evaluate("window.scrollY"), scrolled, "the page did not scroll under the finger")
        self.assertEqual(self.phone_names(page), ["Everyone", "Library", "Release check", "Garden", "Barrel", "Tool shed"])
        self.until(self.server_order, self.ids("Library", "Release check", "Garden", "Barrel", "Tool shed"))
        # A finger that moves at once (a scroll) lifts nothing.
        cdp = page.context.new_cdp_session(page)
        try:
            link = self.phone_row(page, "Garden").locator("a")
            x, y = centre(link)
            cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
            for step in range(1, 6):
                cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y - 12 * step}]})
                page.wait_for_timeout(16)
            page.wait_for_timeout(650)
            self.assertEqual(page.locator(".is-lifted").count(), 0)
            cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        finally:
            cdp.detach()

    # ------------------------------------------------------------------ pictures for the review
    def test_pictures_for_the_review(self):
        """Screenshots of the list at rest, lifted mid-drag, with its menus and on the phone, light and dark (written to FLUX_UI_SCREENSHOT_DIR)."""
        OUT.mkdir(parents=True, exist_ok=True)
        self.say("Garden", "The sensors arrived.")
        self.say("Library", "Shelves are up.")
        self.propose("Barrel", "Cover the barrel in winter")
        engine = self.browser.browser_type.name
        for scheme in ("light", "dark"):
            page = self.open(self.context(scheme=scheme))
            expect(self.row(page, "Garden").locator("a.is-unread")).to_have_count(1)
            sidebar = page.locator(".app__side")
            sidebar.screenshot(path=str(OUT / f"{engine}-{scheme}-1440-sidebar-unread.png"))
            self.row(page, "Garden").hover()
            sidebar.screenshot(path=str(OUT / f"{engine}-{scheme}-1440-sidebar-row-more.png"))
            page.get_by_role("button", name="More for Garden", exact=True).focus()
            page.keyboard.press("Enter")
            expect(page.get_by_role("menu", name="More for Garden", exact=True)).to_be_visible()
            page.wait_for_timeout(300)
            sidebar.screenshot(path=str(OUT / f"{engine}-{scheme}-1440-sidebar-move-menu.png"))
            page.keyboard.press("Escape")
            page.get_by_role("button", name="More for Spaces", exact=True).click()
            expect(page.get_by_role("menuitem", name="Mark all as read", exact=True)).to_be_visible()
            page.wait_for_timeout(300)
            sidebar.screenshot(path=str(OUT / f"{engine}-{scheme}-1440-sidebar-spaces-menu.png"))
            page.keyboard.press("Escape")
            source = self.row(page, "Library").locator("a").bounding_box()
            goal = self.row(page, "Release check").locator("a").bounding_box()
            assert source and goal
            x, y = source["x"] + source["width"] / 2, source["y"] + source["height"] / 2
            page.mouse.move(x, y)
            page.mouse.down()
            for step in range(1, 13):
                page.mouse.move(x - 6 * step / 12, y + (goal["y"] + goal["height"] / 2 - y) * step / 12)
                page.wait_for_timeout(16)
            page.wait_for_timeout(400)
            sidebar.screenshot(path=str(OUT / f"{engine}-{scheme}-1440-sidebar-dragging.png"))
            page.keyboard.press("Escape")
            page.mouse.up()
            self.settle(page)
            phone = self.open(self.context(phone=True, scheme=scheme), "/projects")
            expect(self.phone_row(phone, "Library")).to_be_visible()
            phone.screenshot(path=str(OUT / f"{engine}-{scheme}-390-spaces-tab.png"))
            phone.get_by_role("button", name="More", exact=True).tap()
            expect(phone.get_by_role("menuitem", name="Mark all as read", exact=True)).to_be_visible()
            phone.wait_for_timeout(300)
            phone.screenshot(path=str(OUT / f"{engine}-{scheme}-390-spaces-menu.png"))
            phone.get_by_role("menuitem", name="Mark all as read", exact=True).tap()
            expect(phone.locator(".ui-toast").filter(has_text="Marked all as read")).to_be_visible()
            phone.wait_for_timeout(400)
            phone.screenshot(path=str(OUT / f"{engine}-{scheme}-390-marked-read.png"))
            api(self.ada, "POST", "/api/v1/me/read-all", {})
            self.say("Garden", "A second thing for the garden.")
            self.say("Library", "A second thing for the library.")
            self.propose("Barrel", "Paint the barrel")
            # A long press on the phone lifts a row: the same lifted row and slot as with a mouse.
            phone.reload()
            ready(phone)
            link = self.phone_row(phone, "Library").locator("a")
            px, py = centre(link)
            _, pgoal = centre(self.phone_row(phone, "Release check").locator("a"))
            touch(link, "pointerdown", px, py)
            phone.wait_for_timeout(620)
            for step in range(1, 9):
                touch(link, "pointermove", px, py + (pgoal - py) * step / 8)
                phone.wait_for_timeout(16)
            phone.wait_for_timeout(400)
            phone.screenshot(path=str(OUT / f"{engine}-{scheme}-390-spaces-dragging.png"))
            touch(link, "pointerup", px, pgoal)
            phone.wait_for_timeout(300)
            api(self.ada, "PUT", "/api/v1/me/space-order", {"order": []})


if __name__ == "__main__":
    unittest.main()
