"""Opt-in #593 AC-6 measurement: what the light motion costs, against the #151 interaction budgets.

Not part of normal test_*.py discovery. Run it through the pinned UI stack:
`FLUX_UI_SCREENSHOT_DIR=<absolute dir> ./scripts/check_ui.sh motion_light_performance`; the report is written to
motion-light-performance.json there.

Method (the same family as motion_performance.py and docs/development/performance/2026-10-01-native-work.md): the shared
light-motion fixture is real accounts and records through the public API; Chromium issues trusted input; the page's own
monotonic clock takes the timestamp of that input, then every animation frame for 700 ms. Per flow (a dialog, the detail
panel, a view switch, a state change, a press) and per profile (1440x900 DPR1, and 390x844 DPR1 under CDP 4x CPU throttling:
viewport/CPU emulation, not a physical phone) it reports the input's first frame, the largest and the 95th-percentile gap
between frames, how many frames took more than 33 ms, and the CDP layout and style-recalculation counts the motion cost
(opacity and transform animation should add almost none). Budgets are the #151 ones used by motion_performance.py: a first
frame within 150 ms (300 ms under 4x CPU) and no frame gap above 50 ms (100 ms). A reduced-motion desktop run is the
comparison for what the motion itself costs. Observed failures are reported, never hidden; the run fails when a budget fails.
"""
from __future__ import annotations

import json
import math
import os
import re
import time
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright

from light_motion_fixture import LightMotion, ready, settled
from test_app_shell import ORIGIN, UPSTREAM, start_forwarder

OUT = Path(os.environ.get("FLUX_UI_SCREENSHOTS", "/screenshots"))
WARMUPS = int(os.environ.get("FLUX_MOTION_WARMUPS", "4"))
SAMPLES = int(os.environ.get("FLUX_MOTION_SAMPLES", "30"))
WINDOW_MS = 700
BUDGETS = {"desktop": {"firstFrame": 150, "frameGap": 50}, "desktop-reduced": {"firstFrame": 150, "frameGap": 50}, "phone-cpu4": {"firstFrame": 300, "frameGap": 100}}

PROBE = r"""(() => {
  const probe = window.__frames = { run: null };
  const begin = (event) => {
    if (!event.isTrusted) return;
    const run = probe.run = { start: event.timeStamp, frames: [] };
    const tick = (now) => { run.frames.push(now); if (now - run.start < %d) requestAnimationFrame(tick); else run.done = true; };
    requestAnimationFrame(tick);
  };
  document.addEventListener('pointerdown', begin, true);
  document.addEventListener('keydown', begin, true);
})();""" % 700


def percentile(values, q):
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[max(0, min(len(ordered) - 1, math.ceil(q / 100 * len(ordered)) - 1))], 1)


def summary(values, budget=None):
    data = {"n": len(values), "p50": percentile(values, 50), "p95": percentile(values, 95), "max": round(max(values), 1) if values else None}
    if budget is not None:
        data["budgetP95"] = budget
        data["passed"] = data["p95"] is not None and data["p95"] <= budget
    return data


class LightMotionPerformance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        cls.fx = LightMotion(cls.browser).build()
        for index in range(12):
            cls.fx.new_task(f"Measured check {index + 1}", status="in_progress" if index % 4 == 0 else None)
        cls.report = {"schema": 1, "browser": cls.browser.version, "startedUTC": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                      "sourceCommit": os.environ.get("FLUX_GIT_COMMIT", "unavailable"),
                      "method": {"warmups": WARMUPS, "samples": SAMPLES, "windowMs": WINDOW_MS, "budgets": BUDGETS}, "profiles": []}

    @classmethod
    def tearDownClass(cls):
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / "motion-light-performance.json").write_text(json.dumps(cls.report, indent=2) + "\n")
        cls.fx.close()
        cls.browser.close()
        cls.pw.stop()

    def run_flow(self, page, cdp, name, act, undo):
        """One flow, WARMUPS + SAMPLES times: act (trusted input), wait for the window, read the frames, then undo."""
        firsts, gaps, p95s, slow, layouts, styles = [], [], [], [], [], []

        def once(record):
            before = {m["name"]: m["value"] for m in cdp.send("Performance.getMetrics")["metrics"]}
            act()
            page.wait_for_function("() => window.__frames.run && window.__frames.run.done", timeout=15000)
            after = {m["name"]: m["value"] for m in cdp.send("Performance.getMetrics")["metrics"]}
            run = page.evaluate("window.__frames.run")
            frames = run["frames"]
            if record and len(frames) > 2:
                steps = [b - a for a, b in zip(frames, frames[1:])]
                firsts.append(frames[0] - run["start"])
                gaps.append(max(steps))
                p95s.append(percentile(steps, 95))
                slow.append(sum(1 for step in steps if step > 33.4))
                layouts.append(after["LayoutCount"] - before["LayoutCount"])
                styles.append(after["RecalcStyleCount"] - before["RecalcStyleCount"])
            page.evaluate("window.__frames.run = null")
            undo()
            page.wait_for_timeout(150)
            settled(page, 150)

        for _ in range(WARMUPS):
            once(False)
        for _ in range(SAMPLES):
            once(True)
        return {"firstFrame": firsts, "maxFrameGap": gaps, "p95FrameGap": p95s, "slowFrames": slow, "layoutCount": layouts, "recalcStyleCount": styles}

    def test_light_motion_frame_times_against_the_151_budgets(self):
        failures = []
        for label, viewport, cpu, reduced in (("desktop", {"width": 1440, "height": 900}, 1, False), ("desktop-reduced", {"width": 1440, "height": 900}, 1, True),
                                              ("phone-cpu4", {"width": 390, "height": 844}, 4, False)):
            phone = viewport["width"] < 500
            budget = BUDGETS[label]
            context = self.fx.context(phone=phone, reduced=reduced, viewport=viewport, record=False)
            context.add_init_script(PROBE)
            page = context.new_page()
            cdp = context.new_cdp_session(page)
            cdp.send("Performance.enable")
            if cpu > 1:
                cdp.send("Emulation.setCPUThrottlingRate", {"rate": cpu})
            profile = {"label": label, "viewport": viewport, "cpuThrottle": cpu, "reducedMotion": reduced, "flows": {}}

            def go(path):
                page.goto(path)
                ready(page)
                settled(page)

            def measure(name, act, undo, path):
                go(path)
                data = self.run_flow(page, cdp, name, act, undo)
                profile["flows"][name] = {"firstFrame": summary(data["firstFrame"], budget["firstFrame"]), "maxFrameGap": summary(data["maxFrameGap"], budget["frameGap"]),
                                          "p95FrameGap": summary(data["p95FrameGap"]), "slowFramesOver33ms": summary(data["slowFrames"]),
                                          "layoutCount": summary(data["layoutCount"]), "recalcStyleCount": summary(data["recalcStyleCount"])}

            if phone:
                measure("sheet", lambda: page.locator(".ws-task .ws-item").first.tap(), lambda: page.keyboard.press("Escape"), self.fx.tasks_url())
            else:
                measure("dialog", lambda: page.keyboard.press("Control+k"), lambda: page.keyboard.press("Escape"), self.fx.project_url())
                measure("panel", lambda: page.locator(".ws-task .ws-item").first.click(), lambda: (page.locator("aside.ui-panel .ui-panel__body").focus(), page.keyboard.press("Escape")), self.fx.tasks_url())
                measure("view", lambda: page.locator("nav[aria-label='Project views'] a[href*='/tasks']").click(), lambda: page.locator("nav[aria-label='Project views'] a:first-of-type").click(), self.fx.project_url())
            measure("state", lambda: page.locator("button.ws-task__glyph").first.click(), lambda: page.locator("button.ws-task__glyph").first.click(), self.fx.tasks_url())
            target = page.get_by_role("button", name=re.compile("^(New )?Task$")).first if not phone else page.locator(".ws-task .ws-item").first

            def hold():
                box = target.bounding_box()
                page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                page.mouse.down()

            def let_go():
                page.mouse.move(2, 2)
                page.mouse.up()
            if not phone:
                measure("press", hold, let_go, self.fx.tasks_url())
            context.close()
            self.report["profiles"].append(profile)
            for flow, metrics in profile["flows"].items():
                for metric in ("firstFrame", "maxFrameGap"):
                    if metrics[metric].get("passed") is False:
                        failures.append(f"{label}:{flow}:{metric}")
        self.report["observedFailures"] = failures
        self.report["outcome"] = "within-budgets" if not failures else "observed-budget-failures"
        self.assertEqual(failures, [], "every p95 is within its budget")


if __name__ == "__main__":
    unittest.main(verbosity=2)
