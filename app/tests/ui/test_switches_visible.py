"""Segmented controls and switches are clearly visible in both themes (#1238, v0.2.0): in dark the selected option was darker than its
track (1.1:1) and an off switch was a white knob on a pale track (1.3:1 in light).

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose app; FLUX_UI_BROWSER picks the engine
(chromium by default, webkit too). The numbers are measured in the running app, composited over every ancestor with tests/ui/contrast.py,
never judged by eye, for the Map / List switch, Board / List and Text size, and for the switch of
Settings, light and dark, on the computer (1440) and on the phone (390):
- the selected option's fill against its track at least 1.5:1 and lighter than the track, its label at least 4.5:1 on it, an unselected
  label at least 4.5:1 on the track and not the selected label's colour, and in dark a 1 px light edge (2:1 against the track);
- an off switch's edge and knob at least 3:1 against the card and the track, an on switch's track at least 3:1 against the card and its knob
  at least 4.5:1 on it;
- a switch's SHAPE, on and off, on the phone and the computer: the painted track is a pill (wider than tall, 20 to 30 px tall, fully rounded)
  and the knob sits inside it. On the phone the touch box is 44 px tall but only the padding box is painted (`background-clip`), so a `background`
  shorthand that resets the clip draws a solid 44 px disc and fails here.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest

from playwright.sync_api import Browser, Locator, Page, expect, sync_playwright

from contrast import FILL, MEASURE, RING
from layers import settle
from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, open_map_options, shot, start_forwarder

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
PASSWORD = "a selected option is clear"
EMAIL = f"mia.switches+{int(time.time() * 1000)}@example.test"
HEADERS = {"origin": ORIGIN, "content-type": "application/json"}
# The fill of the selected pill against its track. The tokens give 1.51:1 in light and dark; 1.1:1 was the bug.
FILL_MINIMUM = 1.5
TEXT_MINIMUM = 4.5
NON_TEXT_MINIMUM = 3.0
EDGE_MINIMUM = 2.0  # in dark, where the edge is a light line on the darker track
# The painted track of a switch: its box minus any border the fill is clipped out of (`background-clip: padding-box`). A pill 22 to 28 px
# tall (the phone's 44 px box paints a 28 px track); the knob (a child element) sits inside.
SHAPE = r"""(spec) => {
  const el = document.querySelector(spec.selector);
  if (!el) throw new Error('Missing switch: ' + spec.selector);
  const style = getComputedStyle(el), box = el.getBoundingClientRect();
  const clip = style.backgroundClip;
  const inset = (side) => (clip === 'padding-box' || clip === 'content-box') ? parseFloat(style['border' + side + 'Width']) || 0 : 0;
  const painted = {left: box.left + inset('Left'), top: box.top + inset('Top'), right: box.right - inset('Right'), bottom: box.bottom - inset('Bottom')};
  const width = painted.right - painted.left, height = painted.bottom - painted.top;
  const radius = Math.min(parseFloat(style.borderTopLeftRadius) || 0, width / 2, height / 2);
  let knob = null;
  if (spec.knobSelector) {
    const k = el.querySelector(spec.knobSelector);
    if (k) { const r = k.getBoundingClientRect(); knob = {left: r.left, top: r.top, right: r.right, bottom: r.bottom}; }
  }
  const inside = knob ? knob.left >= painted.left - .5 && knob.right <= painted.right + .5 && knob.top >= painted.top - .5 && knob.bottom <= painted.bottom + .5 : null;
  return {clip, box: [box.width, box.height], width, height, radius, inside};
}"""


class SwitchesVisible(unittest.TestCase):
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
        context = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
        response = context.request.post("/api/auth/sign-up/email", data={"name": "Mia Switches", "email": EMAIL, "password": PASSWORD}, headers={"origin": ORIGIN})
        assert response.status == 200, response.text()

        def post(path: str, body: dict) -> dict:
            made = context.request.post(path, data=json.dumps(body), headers=HEADERS)
            assert made.status == 201, made.text()
            return made.json()

        workspace = post("/api/v1/workspaces", {"name": "Switch company"})["id"]
        project = post(f"/api/v1/workspaces/{workspace}/projects", {"name": "Garden sensors", "visibility": "restricted"})["id"]
        sketch = post(f"/api/v1/workspaces/{workspace}/sketches", {"title": "Sensor directions", "scope": "project", "projectId": project})["id"]
        for text, x, y in (("Soil probes at two depths", 0, 0), ("A weather mast on the shed", 300, 180)):
            post(f"/api/v1/sketches/{sketch}/thoughts", {"text": text, "x": x, "y": y})
        for title in ("Calibrate the soil probes", "Order the weather mast"):
            post(f"/api/v1/projects/{project}/work", {"title": title})
        agent = post(f"/api/v1/workspaces/{workspace}/agents", {"name": "Research agent", "owner": "self"})["id"]
        post("/api/v1/integration/agent-connections", {"agentId": agent, "name": "Research laptop", "clientDesignation": "codex"})
        cls.ids = {"workspace": workspace, "project": project, "sketch": sketch}
        cls.state = context.storage_state()
        context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, scheme: str, phone: bool) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": scheme, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "service_workers": "block",
                         "storage_state": self.state, "viewport": PHONE if phone else DESKTOP, "device_scale_factor": 1, "reduced_motion": "reduce"}
        if phone:
            options.update(is_mobile=True, has_touch=True)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    # ---------------------------------------------------------------- measuring

    def measure(self, page: Page, selector: str, background: str | None = None, **spec) -> dict:
        return page.evaluate(MEASURE, {"selector": selector, **({"backgroundSelector": background} if background else {}), **spec})

    def segmented(self, page: Page, track: Locator, what: str, *, thumb: str | None = None) -> None:
        """One segmented control, as drawn: `track` is the element holding the options (role radiogroup, or a tab bar with a sliding `thumb`)."""
        settle(page)
        track.evaluate("el => el.setAttribute('data-contrast-track', '')")
        try:
            self.measure_segmented(page, what, thumb)
        finally:
            page.evaluate("() => document.querySelectorAll('[data-contrast-track]').forEach((el) => el.removeAttribute('data-contrast-track'))")

    def measure_segmented(self, page: Page, what: str, thumb: str | None) -> None:
        under = "[data-contrast-track]"
        selected = f'{under} :is([role="radio"][aria-checked="true"], [aria-current="page"], [aria-selected="true"])'
        unselected = f'{under} :is([role="radio"][aria-checked="false"], .ui-tabs__tab:not([aria-current="page"]):not([aria-selected="true"]))'
        pill = thumb or selected
        scheme = "dark" if page.evaluate("matchMedia('(prefers-color-scheme: dark)').matches") else "light"
        fill = page.evaluate(FILL, {"selector": pill, "underSelector": under})
        self.assertGreaterEqual(fill["ratio"], FILL_MINIMUM, f"{what} ({scheme}): the selected option's fill against its track {fill}")
        self.assertTrue(fill["lighter"], f"{what} ({scheme}): the selected option is lighter than its track {fill}")
        label = self.measure(page, selected, pill)
        self.assertGreaterEqual(label["ratio"], TEXT_MINIMUM, f"{what} ({scheme}): the selected label on its pill {label}")
        other = self.measure(page, unselected, under)
        self.assertGreaterEqual(other["ratio"], TEXT_MINIMUM, f"{what} ({scheme}): an unselected label on the track {other}")
        self.assertNotEqual(label["foreground"], other["foreground"], f"{what} ({scheme}): the selected and unselected labels differ")
        edge = page.evaluate(RING, {"selector": pill, "outsideSelector": under})
        self.assertIsNotNone(edge.get("edge"), f"{what} ({scheme}): the selected pill has a 1 px inset edge {edge}")
        if scheme == "dark":
            self.assertGreaterEqual(edge["ratio"], EDGE_MINIMUM, f"{what} (dark): the pill's edge against the track {edge}")
        type(self).measured.append(f"{what} {scheme} fill {fill['ratio']:.2f}:1 label {label['ratio']:.1f}:1 unselected {other['ratio']:.1f}:1 edge {edge['ratio']:.2f}:1")

    measured: list[str] = []

    def switch(self, page: Page, control: Locator, what: str, *, part: str, on: bool) -> None:
        """One switch in the state asked: `control` is the element with the track's fill and edge; `part` selects the knob, a child element of it."""
        settle(page)
        control.evaluate("el => { el.setAttribute('data-contrast-switch', ''); el.parentElement.setAttribute('data-contrast-surface', ''); }")
        try:
            self.measure_switch(page, what, part, on)
        finally:
            page.evaluate("() => document.querySelectorAll('[data-contrast-switch], [data-contrast-surface]').forEach((el) => { el.removeAttribute('data-contrast-switch'); el.removeAttribute('data-contrast-surface'); })")

    def measure_switch(self, page: Page, what: str, part: str, on: bool) -> None:
        track, outside = "[data-contrast-switch]", "[data-contrast-surface]"
        scheme = "dark" if page.evaluate("matchMedia('(prefers-color-scheme: dark)').matches") else "light"
        state = "on" if on else "off"
        knob = page.evaluate(FILL, {"selector": f"{track} {part}", "underSelector": track})
        edge = page.evaluate(RING, {"selector": track, "outsideSelector": outside})
        track_fill = page.evaluate(FILL, {"selector": track, "underSelector": outside})
        self.assertIsNotNone(edge.get("edge"), f"{what} {state} ({scheme}): the switch has a 1 px inset edge {edge}")
        shape = page.evaluate(SHAPE, {"selector": track, "knobSelector": part.lstrip("> ")})
        self.assertGreater(shape["width"], shape["height"], f"{what} {state} ({scheme}): the track is a pill, wider than tall {shape}")
        self.assertGreaterEqual(shape["height"], 20, f"{what} {state} ({scheme}): the painted track is at least 20 px tall {shape}")
        self.assertLessEqual(shape["height"], 30, f"{what} {state} ({scheme}): the painted track is at most 30 px tall, not a 44 px disc {shape}")
        self.assertGreaterEqual(shape["radius"], shape["height"] / 2 - .5, f"{what} {state} ({scheme}): the track is fully rounded {shape}")
        if shape["inside"] is not None:
            self.assertTrue(shape["inside"], f"{what} {state} ({scheme}): the knob sits inside the painted track {shape}")
        if on:
            self.assertGreaterEqual(track_fill["ratio"], NON_TEXT_MINIMUM, f"{what} on ({scheme}): the ink track against the card {track_fill}")
            self.assertGreaterEqual(knob["ratio"], TEXT_MINIMUM, f"{what} on ({scheme}): the knob on the ink track {knob}")
        else:
            self.assertGreaterEqual(edge["ratio"], NON_TEXT_MINIMUM, f"{what} off ({scheme}): the edge against the card {edge}")
            self.assertGreaterEqual(knob["ratio"], NON_TEXT_MINIMUM, f"{what} off ({scheme}): the knob on its track {knob}")
        type(self).measured.append(f"{what} {state} {scheme} edge {edge['ratio']:.1f}:1 knob {knob['ratio']:.1f}:1 track {track_fill['ratio']:.1f}:1 painted {shape['width']:.0f} x {shape['height']:.0f} px")

    # ---------------------------------------------------------------- segmented controls

    def test_01_the_computers_segmented_controls_are_clear_in_light_and_dark(self) -> None:
        for scheme in ("light", "dark"):
            page = self.page(scheme, False)
            # The Map / List switch (the space views' own switch becomes underline tabs under #1239 and is not pinned here).
            page.goto(f"/projects/{self.ids['project']}/map/{self.ids['sketch']}")
            expect(page.locator(".sk-canvas")).to_be_visible()
            self.segmented(page, page.get_by_role("radiogroup", name="Show as"), "Map / List")
            shot(page, f"1238-map-list-1440-{scheme}")
            # Board / List.
            page.goto(f"/projects/{self.ids['project']}/tasks")
            expect(page.get_by_role("radiogroup", name="Show tasks as")).to_be_visible()
            self.segmented(page, page.get_by_role("radiogroup", name="Show tasks as"), "Board / List")
            shot(page, f"1238-board-list-1440-{scheme}")
            # Text size.
            page.goto("/settings")
            self.segmented(page, page.get_by_role("radiogroup", name="Text size"), "Text size")

    def test_02_the_phones_segmented_controls_are_clear_in_light_and_dark(self) -> None:
        for scheme in ("light", "dark"):
            page = self.page(scheme, True)
            page.goto(f"/projects/{self.ids['project']}/map/{self.ids['sketch']}")
            sheet = open_map_options(page, touch=True)
            self.segmented(page, sheet.get_by_role("radiogroup", name="Show as"), "Map / List")
            shot(page, f"1238-map-list-390-{scheme}")
            page.keyboard.press("Escape")
            expect(page.get_by_role("dialog", name="Map options", exact=True)).to_have_count(0)
            page.goto(f"/projects/{self.ids['project']}/tasks")
            expect(page.get_by_role("radiogroup", name="Show tasks as")).to_be_visible()
            self.segmented(page, page.get_by_role("radiogroup", name="Show tasks as"), "Board / List")
            shot(page, f"1238-board-list-390-{scheme}")

    # ---------------------------------------------------------------- switches

    def test_03_the_switches_are_clear_off_and_on_in_light_and_dark(self) -> None:
        for scheme, phone in (("light", False), ("dark", False), ("light", True), ("dark", True)):
            size = "390" if phone else "1440"
            page = self.page(scheme, phone)
            # A Settings row's switch (the Kreska row), off and on.
            page.goto("/settings/appearance" if phone else "/settings")
            row = page.get_by_role("switch", name=re.compile(r"^Kreska in"))
            expect(row).to_be_visible()
            if row.get_attribute("aria-checked") == "true":
                row.click()
            expect(row).to_have_attribute("aria-checked", "false")
            self.switch(page, row, "Settings switch", part="> span", on=False)
            shot(page, f"1238-switch-off-{size}-{scheme}")
            row.click()
            expect(row).to_have_attribute("aria-checked", "true")
            self.switch(page, row, "Settings switch", part="> span", on=True)
            shot(page, f"1238-switch-on-{size}-{scheme}")

    def test_04_zz_the_measured_numbers(self) -> None:
        # Printed with -v so a reviewer sees the numbers; the assertions above already hold them to the targets.
        print("\n" + "\n".join(self.measured))
        self.assertTrue(self.measured, "something was measured")


if __name__ == "__main__":
    unittest.main()
