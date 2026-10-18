"""Opt-in #593 AC-7 evidence: short videos of the light motion, one per acceptance criterion, light and dark, plus a
reduced-motion run of the same journeys and a phone run.

Not part of normal test_*.py discovery. Run it through the pinned UI stack, once per engine:
`FLUX_UI_BROWSER=chromium|webkit FLUX_UI_SCREENSHOT_DIR=<absolute dir outside the repo> ./scripts/check_ui.sh motion_evidence`.
It writes `<engine>-<scheme>-<criterion>.webm` and, beside each, `.motion.json`: every animation the page started (what it
animates, how long, how it eases), which is the measurement a video cannot be. A video is evidence of what was drawn, not of
interaction or accessibility; those are asserted in test_light_motion.py. Videos stay out of the repository (#319).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import unittest
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright

from create_window import add_task
from light_motion_fixture import LightMotion, ready, recorded, settled
from test_app_shell import ORIGIN, UI_BROWSER, UPSTREAM, start_forwarder

OUT = Path(os.environ.get("FLUX_UI_SCREENSHOTS", "/screenshots"))
BEAT = 650  # a pause long enough to see each motion finish before the next begins
TABS = "nav[aria-label='Project views']"


class MotionEvidence(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}", flush=True)
        expect.set_options(timeout=12000)
        cls.fx = LightMotion(cls.browser).build()
        cls.engine = cls.browser.browser_type.name
        OUT.mkdir(parents=True, exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()
        cls.browser.close()
        cls.pw.stop()

    # ------------------------------------------------------------------ recording
    def film(self, criterion: str, journey, *, scheme: str = "light", reduced: bool = False, phone: bool = False) -> None:
        label = f"{self.engine}-{'phone-' if phone else ''}{scheme}{'-reduced' if reduced else ''}-{criterion}"
        scratch = OUT / f"_{label}"
        shutil.rmtree(scratch, ignore_errors=True)
        context = self.fx.context(scheme=scheme, reduced=reduced, phone=phone, video_dir=str(scratch))
        page = context.new_page()
        self.log = []  # every document of the journey adds its animations before the next one replaces it
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        try:
            journey(page)
            page.wait_for_timeout(BEAT)
            self.harvest(page)
            (OUT / f"{label}.motion.json").write_text(json.dumps(self.log, indent=1) + "\n")
        finally:
            video = page.video
            context.close()
            if video is not None:
                video.save_as(str(OUT / f"{label}.webm"))
            shutil.rmtree(scratch, ignore_errors=True)
        self.assertEqual(errors, [], f"{label}: no uncaught browser errors")

    def beat(self, page: Page, ms: int = BEAT) -> None:
        page.wait_for_timeout(ms)

    def harvest(self, page: Page) -> None:
        self.log.extend(recorded(page))
        page.evaluate("window.__motion && (window.__motion.length = 0)")

    def go(self, page: Page, url: str) -> None:
        self.harvest(page)
        page.goto(url)
        ready(page)

    # ------------------------------------------------------------------ journeys, one per criterion
    def ac1(self, page: Page) -> None:
        """Dialogs, ⌘K, menus and toasts enter and leave; the scrim fades; focus returns at once."""
        self.go(page, self.fx.project_url()); self.beat(page)
        page.keyboard.press("Control+k"); self.beat(page, 900)
        page.keyboard.press("Escape"); self.beat(page)
        self.go(page, self.fx.tasks_url()); self.beat(page)
        page.get_by_role("button", name=re.compile("^(New )?Task$")).first.click(); self.beat(page, 900)
        page.keyboard.press("Escape"); self.beat(page)
        page.locator(".ws-task .ws-item").first.click(); self.beat(page, 900)
        panel = page.get_by_role("complementary", name="Details")
        panel.get_by_role("button", name="Status", exact=True).click(); self.beat(page, 900)
        page.keyboard.press("Escape"); self.beat(page)
        panel.get_by_role("button", name="Status", exact=True).click()
        panel.locator("[role=menuitemradio][aria-checked=false]").first.click(); self.beat(page, 1200)  # a different state: it changes, so the toast comes
        page.locator(".ui-toast").first.get_by_role("button", name="Dismiss notification").click(); self.beat(page)
        panel.locator(".ui-panel__body").focus()
        page.keyboard.press("Escape"); self.beat(page, 900)

    def ac2(self, page: Page) -> None:
        """The panel's content is replaced in the direction of travel; the shell, its head and controls stay still."""
        self.go(page, self.fx.task_url(self.fx.tasks[0])); self.beat(page, 900)
        panel = page.locator("#details")  # its name follows its content: Details, then Replies
        panel.get_by_role("link", name=re.compile("Message: Should the first sensors")).click(); self.beat(page, 1100)
        panel.get_by_role("button", name=re.compile(r"^Task #\d+$")).click(); self.beat(page, 1100)
        panel.get_by_role("link", name=re.compile("Message: Should the first sensors")).click(); self.beat(page, 1100)
        page.keyboard.press("Escape")

    def ac3(self, page: Page) -> None:
        """Views and places crossfade the content area only; the header, sidebar and tab bar stay still."""
        self.go(page, self.fx.project_url()); self.beat(page, 900)
        for name in ("Tasks", "Map", "Wiki", "Agents", "Conversation"):
            page.locator(TABS).get_by_role("link", name=name).click(); self.beat(page, 1000)
        page.get_by_role("navigation", name="Places").get_by_role("link", name="Inbox").click(); self.beat(page, 1000)
        page.get_by_role("navigation", name="Places").get_by_role("link", name="Home").click(); self.beat(page, 1000)
        self.go(page, "/settings/appearance"); self.beat(page, 800)
        self.harvest(page); page.go_back(); self.beat(page, 1000)

    def ac4(self, page: Page) -> None:
        """A state change morphs and the row slides to its group; a row grows in; an accepted decision collapses."""
        self.go(page, self.fx.tasks_url()); self.beat(page, 900)
        glyph = page.locator("button.ws-task__glyph")
        glyph.first.click(); self.beat(page, 1100)
        glyph.last.click(); self.beat(page, 1100)
        add_task(page, "Order the cable ties"); self.beat(page, 1300)
        self.go(page, "/inbox"); self.beat(page, 900)
        page.locator(".nyc").first.get_by_role("button", name=re.compile("^Accept")).click(); self.beat(page, 1300)

    def ac5(self, page: Page) -> None:
        """Every kind of pressable control scales to .97 and springs back; hover fills ease."""
        self.go(page, self.fx.tasks_url()); self.beat(page, 900)
        targets = [page.get_by_role("button", name="Collapse sidebar").first, page.get_by_role("button", name=re.compile("^(New )?Task$")).first,
                   page.locator("button.ws-task__glyph").first, page.locator(".ws-task .ws-item").first, page.locator(".side__project").first]
        for target in targets:
            box = target.bounding_box()
            page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2); self.beat(page, 500)
            page.mouse.down(); self.beat(page, 450)
            page.mouse.move(2, 2); page.mouse.up(); self.beat(page, 700)
        self.go(page, self.fx.project_url())
        page.locator("#project-composer").fill("Probes arrive on Thursday"); self.beat(page, 500)
        send = page.locator(".composer__send").first.bounding_box()
        page.mouse.move(send["x"] + send["width"] / 2, send["y"] + send["height"] / 2)
        page.mouse.down(); self.beat(page, 450)
        page.mouse.move(2, 2); page.mouse.up(); self.beat(page, 700)

    def reduced(self, page: Page) -> None:
        """The same journeys under reduced motion: every surface is in its end state at once."""
        self.ac1(page)
        self.ac2(page)
        self.ac3(page)

    def phone(self, page: Page) -> None:
        """On the phone the detail sheet and its scrim follow the same rules; the press is the same."""
        self.go(page, self.fx.tasks_url()); self.beat(page, 900)
        page.locator(".ws-task .ws-item").first.tap(); self.beat(page, 1200)
        page.get_by_role("dialog", name="Details").get_by_role("button", name="Close details").tap(); self.beat(page, 1000)
        page.get_by_role("button", name="Create", exact=True).tap(); self.beat(page, 1000)
        page.keyboard.press("Escape"); self.beat(page, 800)

    # ------------------------------------------------------------------ frame samples: what the video cannot show
    SAMPLER = r"""
    async ({ action, watch, ms }) => {
      const act = new Function('return (' + action + ')')();
      const frames = [];
      const read = (t) => ({ t: Math.round(t * 10) / 10, v: Object.fromEntries(Object.entries(watch).map(([key, selector]) => {
        const el = document.querySelector(selector); if (!el) return [key, null];
        const s = getComputedStyle(el), r = el.getBoundingClientRect();
        return [key, { opacity: +(+s.opacity).toFixed(3), transform: s.transform, scale: s.scale, x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }]; })) });
      const start = performance.now();
      frames.push(read(0));
      await act();
      await new Promise((resolve) => { const step = () => { const t = performance.now() - start; frames.push(read(t)); t < ms ? requestAnimationFrame(step) : resolve(); }; requestAnimationFrame(step); });
      return frames;
    }"""

    def sample(self, page: Page, action: str, watch: dict[str, str], ms: int = 450) -> list[dict]:
        return page.evaluate(self.SAMPLER, {"action": action, "watch": watch, "ms": ms})

    def test_frame_samples_of_every_criterion(self):
        """Per-frame opacity, transform, scale and boxes while each motion runs, on this engine: the numbers behind the videos."""
        out: dict[str, list[dict]] = {}
        context = self.fx.context()
        page = context.new_page()
        try:
            page.goto(self.fx.project_url()); ready(page); self.beat(page, 600)
            # Each surface is opened once first, so the sample is of the motion and not of a view's code arriving for the first time.
            for warm in (self.fx.tasks_url(), self.fx.project_url()):
                page.goto(warm); ready(page)
            page.keyboard.press("Control+k"); self.beat(page, 800); page.keyboard.press("Escape"); self.beat(page, 600)
            page.locator(f"{TABS} a[href*='/tasks']").click(); self.beat(page, 1200)
            page.locator(f"{TABS} a:first-of-type").click(); self.beat(page, 1200)
            key = "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))"
            out["ac1-dialog-in"] = self.sample(page, f"() => {{ {key}; }}", {"surface": ".ui-overlay__surface", "scrim": ".ui-scrim"})
            self.beat(page, 400)
            out["ac1-dialog-out"] = self.sample(page, "() => { document.querySelector('[role=dialog][aria-label=\"Jump to\"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }", {"surface": ".ui-overlay__surface", "scrim": ".ui-scrim"})
            self.beat(page, 400)
            out["ac3-view-switch"] = self.sample(page, f"() => {{ document.querySelector(\"{TABS} a[href*='/tasks']\").click(); }}",
                                                 {"content": "#content", "header": "header.top", "sidebar": ".app__side", "tabs": TABS}, 800)
            self.beat(page, 600)
            page.goto(self.fx.tasks_url()); ready(page); self.beat(page, 600)
            out["ac1-panel-in"] = self.sample(page, "() => { document.querySelector('.ws-task .ws-item').click(); }", {"panel": "aside.ui-panel"})
            self.beat(page, 600)
            out["ac2-content-swap-forward"] = self.sample(page, "() => { [...document.querySelectorAll('#details a')].find((a) => a.textContent.includes('Should the first sensors'))?.click(); }",
                                                          {"content": "#details .ui-panel__body > *", "head": "#details .ui-panel__head", "close": "#details .ui-panel__close", "panel": "aside.ui-panel"}, 600)
            self.beat(page, 600)
            out["ac2-content-swap-back"] = self.sample(page, "() => { document.querySelector('#details .ui-panel__back')?.click(); }",
                                                       {"content": "#details .ui-panel__body > *", "head": "#details .ui-panel__head", "close": "#details .ui-panel__close", "panel": "aside.ui-panel"}, 600)
            self.beat(page, 600)
            out["ac1-menu-in"] = self.sample(page, "() => { document.querySelector('#details button[aria-label=\"Status\"]').click(); }", {"menu": ".wd-menu__list"}, 450)
            self.beat(page, 400)
            page.goto(self.fx.tasks_url()); ready(page); self.beat(page, 600)
            first = page.locator("button.ws-task__glyph").first
            work = first.evaluate("el => el.closest('.ws-task').dataset.workId")
            out["ac4-state-change"] = self.sample(page, "() => { document.querySelector('button.ws-task__glyph').click(); }",
                                                  {"glyph": f".ws-task[data-work-id='{work}'] svg.ui-glyph", "row": f".ws-task[data-work-id='{work}']"}, 900)
            self.beat(page, 600)
            out["ac5-press"] = self.sample(page, "() => { const el = document.querySelector('.ws-task .ws-item'); el.dispatchEvent(new PointerEvent('pointerdown', { isPrimary: true, button: 0, pointerType: 'mouse', bubbles: true })); setTimeout(() => document.dispatchEvent(new PointerEvent('pointerup', { isPrimary: true, bubbles: true })), 180); }",
                                           {"row": ".ws-task .ws-item"}, 700)
        finally:
            context.close()
        (OUT / f"{self.engine}-frame-samples.json").write_text(json.dumps(out, indent=1) + "\n")
        self.assertTrue(all(out.values()))

    # ------------------------------------------------------------------ the evidence
    def test_videos_for_every_criterion_light_and_dark(self):
        for scheme in ("light", "dark"):
            for criterion, journey in (("ac1-dialogs-menus-toasts", self.ac1), ("ac2-panel-content", self.ac2), ("ac3-views-and-places", self.ac3),
                                       ("ac4-state-and-rows", self.ac4), ("ac5-press", self.ac5)):
                with self.subTest(scheme=scheme, criterion=criterion):
                    self.film(criterion, journey, scheme=scheme)

    def test_videos_of_the_reduced_motion_run_and_the_phone(self):
        self.film("static-frames", self.reduced, reduced=True)
        self.film("sheet", self.phone, phone=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
