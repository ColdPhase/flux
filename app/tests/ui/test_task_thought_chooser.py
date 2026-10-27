"""The thought chooser of a task's Details, as the phone reads it (#289 follow-up to #449).

Runs with the other tests/ui journeys through scripts/check_ui.sh (`./scripts/check_ui.sh test_task_thought_chooser`,
Chromium by default, `FLUX_UI_BROWSER=webkit` for WebKit). One person, one project with a map of thoughts (one of them
long enough to wrap on a phone) and one task. The task's "Linked thoughts" section opens a chooser: a map select and the
map's thoughts as buttons. The chooser's primary content is the thought title, so on the phone it takes the phone body
size (--fs-base, 15 px; Prostota "Body: 15-16 on the phone") instead of the 14 px control size the rows inherit; the
computer keeps its own. The rows keep their wrapping, one trailing glyph edge, 44 px targets, the press and reduced
motion, and the text size (rem tokens). The linking itself is scenario 2b of tests/ui/test_scenarios.py.
"""

from __future__ import annotations

import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")

STAMP = int(time.time() * 1000)
PASSWORD = "choose the thought, link the task"
TASK = "Order a VL53L1X breakout board"
MAP = "Sensing directions"
THOUGHTS = (
    "Variant B: a VL53L1X sensor behind the shade",
    "Low light: below 10 lux the camera has to guess",
    "Variant C: a long, descriptive thought about the shade and the sensor so that its title wraps across several lines on a phone",
)
# A button's background and transform, as the press check reads them (HIG-16: Prostota presses to .97).
PRESS_STYLE = "el => { const s = getComputedStyle(el); return { background: s.backgroundColor, scale: s.scale }; }"
# The rows' type sizes beside the body and control tokens as they resolve now, each row's height, whether its title overflows,
# its line count, and where the trailing glyph sits.
TITLE_METRICS = """els => {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;font-size:var(--fs-base)';
  document.body.append(probe);
  const body = parseFloat(getComputedStyle(probe).fontSize);
  probe.style.fontSize = 'var(--fs-md)';
  const control = parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  return { body, control, rows: els.map((el) => {
    const title = el.querySelector('span'), glyph = el.querySelector('svg').getBoundingClientRect(), row = el.getBoundingClientRect();
    const style = getComputedStyle(title);
    return { size: parseFloat(style.fontSize), lines: Math.round(title.getBoundingClientRect().height / parseFloat(style.lineHeight)),
             height: row.height, overflow: title.scrollWidth > title.clientWidth + 1,
             glyphRight: glyph.right, glyphMid: glyph.top + glyph.height / 2, rowMid: row.top + row.height / 2 };
  }) };
}"""
# The title scaled with the root text size: the phone follows the system size, the computer's setting scales the same rem tokens.
TITLE_SCALES = """() => {
  const html = document.documentElement, title = document.querySelector('.wd-pick .wd-links .wd-link span');
  const before = parseFloat(getComputedStyle(title).fontSize), saved = html.style.fontSize;
  html.style.fontSize = '125%';
  const after = parseFloat(getComputedStyle(title).fontSize);
  html.style.fontSize = saved;
  return after / before;
}"""


class TaskThoughtChooser(unittest.TestCase):
    pw = None
    browser: Browser
    state: dict
    ids: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)
        context = cls.browser.new_context(base_url=ORIGIN)
        email = f"chooser+{STAMP}@example.test"
        response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": "Ada Chooser"}, headers={"origin": ORIGIN})
        assert response.status == 200, response.text()

        def post(path: str, body: dict) -> dict:
            made = context.request.post(path, data=body, headers={"origin": ORIGIN, "idempotency-key": str(uuid.uuid4())})
            assert made.status == 201, made.text()
            return made.json()

        workspace = post("/api/v1/workspaces", {"name": "Lamp studio"})["id"]
        project = post(f"/api/v1/workspaces/{workspace}/projects", {"name": "Gesture lamp", "visibility": "workspace"})["id"]
        sketch = post(f"/api/v1/workspaces/{workspace}/sketches", {"title": MAP, "scope": "project", "projectId": project})["id"]
        for index, text in enumerate(THOUGHTS):
            post(f"/api/v1/sketches/{sketch}/thoughts", {"text": text, "x": 60 + index * 360, "y": 80})
        task = post(f"/api/v1/projects/{project}/work", {"title": TASK})["id"]
        cls.ids = {"project": project, "sketch": sketch, "task": task}
        cls.state = context.storage_state()
        context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, *, phone: bool, dark: bool = False, reduced_motion: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "storage_state": self.state, "color_scheme": "dark" if dark else "light", "locale": "en-GB",
                         "timezone_id": "Europe/Warsaw", "service_workers": "block", "reduced_motion": "reduce" if reduced_motion else "no-preference"}
        options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def chooser(self, page: Page, *, phone: bool):
        """The task's Details with its thought chooser open on the project's map; returns the chooser."""
        page.goto(f"/projects/{self.ids['project']}/tasks?open=work:{self.ids['task']}")
        card = page.locator(f".wd[data-detail-kind='work'][data-detail-id='{self.ids['task']}']")
        expect(card).to_be_visible()
        control = card.get_by_role("button", name="Link thought")  # one of the task's small actions (#488)
        control.tap() if phone else control.click()
        picker = card.get_by_role("group", name=re.compile("^Thoughts to link to "))
        expect(picker).to_be_visible()
        picker.get_by_label("Map", exact=True).select_option(self.ids["sketch"])
        expect(picker.get_by_role("button", name=THOUGHTS[2])).to_be_visible()
        return picker

    def press_changes(self, page: Page, button) -> tuple[dict, dict]:
        """The button at rest and held down by a real press (the one press, ui/press.ts: it scales the control, the fill is CSS :active)."""
        button.scroll_into_view_if_needed()
        rest = button.evaluate(PRESS_STYLE)
        box = button.bounding_box()
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.mouse.down()
        try:
            page.wait_for_timeout(300)  # past the press-in
            pressed = button.evaluate(PRESS_STYLE)
        finally:
            page.mouse.move(2, 2)  # let go elsewhere: nothing is chosen
            page.mouse.up()
        page.wait_for_timeout(450)  # and the spring back
        return rest, pressed

    def rows(self, picker) -> dict:
        metrics = picker.locator(".wd-links button.wd-link").evaluate_all(TITLE_METRICS)
        rows = metrics["rows"]
        self.assertEqual(len(rows), len(THOUGHTS), "the chooser lists every thought of the map")
        for row in rows:
            self.assertFalse(row["overflow"], "a title wraps instead of overflowing")
            self.assertLessEqual(abs(row["glyphMid"] - row["rowMid"]), 1, "the trailing glyph is centred on its row, wrapped or not")
        self.assertEqual({round(row["glyphRight"], 1) for row in rows}, {round(rows[0]["glyphRight"], 1)}, "every trailing glyph shares one right edge")
        self.assertGreaterEqual(max(row["lines"] for row in rows), 2, "the long thought wraps onto more than one line")
        self.assertAlmostEqual(picker.page.evaluate(TITLE_SCALES), 1.25, delta=0.01, msg="the title follows the text size (rem token)")
        return metrics

    def test_01_phone_thought_titles_take_the_phone_body_size_in_light_and_dark(self) -> None:
        for dark in (False, True):
            page = self.page(phone=True, dark=dark)
            picker = self.chooser(page, phone=True)
            metrics = self.rows(picker)
            self.assertGreaterEqual(metrics["body"], 15, "the phone body token is at least 15 px")
            self.assertGreater(metrics["body"], metrics["control"], "and larger than the 14 px control size the rows inherited")
            for row in metrics["rows"]:
                self.assertAlmostEqual(row["size"], metrics["body"], delta=0.01, msg="every thought title takes the phone body size")
                self.assertGreaterEqual(row["height"], 44, "each thought choice is a 44 px target")
            self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"), "no horizontal page scroll")
            picker.get_by_role("button", name=THOUGHTS[2]).scroll_into_view_if_needed()  # the whole list is in the capture
            shot(page, f"chooser-phone-390-{'dark' if dark else 'light'}-{UI_BROWSER}")

    def test_02_the_computer_keeps_the_control_size(self) -> None:
        page = self.page(phone=False)
        metrics = self.rows(self.chooser(page, phone=False))
        for row in metrics["rows"]:
            self.assertAlmostEqual(row["size"], metrics["control"], delta=0.01, msg="the computer's thought rows are unchanged")
        page.get_by_role("button", name=THOUGHTS[2]).scroll_into_view_if_needed()
        shot(page, f"chooser-desktop-1440-light-{UI_BROWSER}")

    def test_03_a_pressed_thought_choice_scales_and_reduced_motion_keeps_only_the_fill(self) -> None:
        page = self.page(phone=True)
        choice = self.chooser(page, phone=True).get_by_role("button", name=THOUGHTS[0])
        rest, pressed = self.press_changes(page, choice)
        self.assertEqual(rest["scale"], "none", "a thought choice rests unscaled")
        self.assertEqual(pressed["scale"], "0.97", "a pressed thought choice scales to --press (.97)")
        self.assertNotEqual(pressed["background"], rest["background"], "and takes the pressed fill")
        page = self.page(phone=True, reduced_motion=True)
        choice = self.chooser(page, phone=True).get_by_role("button", name=THOUGHTS[0])
        rest, pressed = self.press_changes(page, choice)
        self.assertEqual(pressed["scale"], "none", "under reduced motion a pressed thought choice does not scale")
        self.assertNotEqual(pressed["background"], rest["background"], "and still takes the pressed fill")


if __name__ == "__main__":
    unittest.main()
