"""Opt-in #155 motion/navigation-feedback measurement against the #151 interaction budgets.

Not part of normal test_*.py discovery (it takes several minutes). Run it explicitly through the
pinned UI stack: `./scripts/check_ui.sh motion_performance` with FLUX_UI_SCREENSHOT_DIR set; the report
is written to motion-performance.json there.

Method (same as the accepted #151/#155 native-work kickoff, docs/development/performance/
2026-10-01-native-work.md): public commands create a realistic project fixture; Chromium (Python
Playwright) issues trusted clicks/keys; the page's own monotonic clock times each action from the
trusted event's timeStamp to a double-requestAnimationFrame following-frame proxy (not a raster
completion claim). Every distribution has 30 warm-ups and at least 200 measured actions over at least
60 s, per profile: 1280x800 DPR1, and 390x844 DPR1 with CDP 4x CPU throttling (viewport/CPU
emulation, not a physical phone). API, database and worker are uncapped.

Budgets (p95, desktop / CPU4x), inherited from #151 for a view click to selected-state paint and a
keydown to input paint: 150/300 ms and 100/200 ms. The traveling highlight is decorative; its motion
must finish within the selection budget plus its token duration (UI116-5: 160-220 ms) and keep frames
continuous. Observed failures are reported, never hidden; the run fails when a budget fails.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import time
import unittest
import uuid

from playwright.sync_api import sync_playwright
from test_app_shell import ORIGIN, UPSTREAM, start_forwarder

OUT = Path(os.environ.get("FLUX_UI_SCREENSHOTS", "/screenshots"))
WARMUPS = int(os.environ.get("FLUX_MOTION_WARMUPS", "30"))
SAMPLES = int(os.environ.get("FLUX_MOTION_SAMPLES", "200"))
SECONDS = float(os.environ.get("FLUX_MOTION_SECONDS", "60"))
PASSWORD = "measured calm motion in a shared studio"
STAMP = uuid.uuid4().hex[:10]
BUDGETS = {
    "desktop": {"selectionFeedback": 150, "selectionCommitted": 2000, "motionEnd": 150 + 220, "keyInput": 100, "frameGap": 50},
    "phone-cpu4": {"selectionFeedback": 300, "selectionCommitted": 4000, "motionEnd": 300 + 220, "keyInput": 200, "frameGap": 100},
}
PROBE = r"""(() => {
  const probe = window.__motionProbe = { result: null };
  // One trusted click on a project row or a work tab: feedback (the highlight/mark on the chosen item,
  // then two following frames), the motion's end, the route committing that choice, and frame gaps.
  document.addEventListener('click', (event) => {
    const el = event.target instanceof Element ? event.target.closest('.views [data-tab], .side .side__project') : null;
    if (!el || !event.isTrusted) return;
    const kind = el.matches('.side__project') ? 'project' : 'tab';
    const id = kind === 'tab' ? el.dataset.tab : el.dataset.glideId;
    const start = event.timeStamp;
    const run = { kind, id, feedback: null, motionEnd: null, committed: null, maxGap: 0 };
    probe.result = null;
    let last = performance.now(), seen = false, committing = false;
    const mark = () => document.querySelector(kind === 'tab' ? '.views .ui-tabs__indicator' : '.side .side__glide');
    const step = (now) => {
      run.maxGap = Math.max(run.maxGap, now - last); last = now;
      const m = mark();
      if (!seen && m && m.dataset.target === id) {
        seen = true;
        requestAnimationFrame(() => requestAnimationFrame(() => { run.feedback = performance.now() - start; }));
      }
      if (run.feedback !== null && run.motionEnd === null && m && !m.getAnimations().some((a) => a.playState === 'running')) run.motionEnd = performance.now() - start;
      const current = kind === 'tab' ? document.querySelector(`.views [data-tab="${id}"][aria-current="page"]`) : document.querySelector(`.side .side__project.is-open[data-glide-id="${id}"]`);
      if (current && !committing) { committing = true; requestAnimationFrame(() => requestAnimationFrame(() => { run.committed = performance.now() - start; })); }
      if (run.feedback !== null && run.motionEnd !== null && run.committed !== null) { probe.result = run; return; }
      if (now - start > 20000) { probe.result = { ...run, timeout: true }; return; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, true);
  // One trusted key in the reply composer: the controlled value changes, then two following frames.
  document.addEventListener('keydown', (event) => {
    const box = event.target;
    if (!event.isTrusted || !(box instanceof HTMLTextAreaElement) || box.id !== 'thread-composer') return;
    const start = event.timeStamp, before = box.value;
    probe.result = null;
    const step = () => {
      if (box.value !== before) { requestAnimationFrame(() => requestAnimationFrame(() => { probe.result = { kind: 'key', key: performance.now() - start }; })); return; }
      if (performance.now() - start > 5000) { probe.result = { kind: 'key', timeout: true }; return; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, true);
})();"""


def percentile(values, q):
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(q / 100 * len(ordered)) - 1))
    return round(ordered[index], 1)


def summary(values, budget=None):
    data = {"n": len(values), "p50": percentile(values, 50), "p95": percentile(values, 95), "max": round(max(values), 1) if values else None}
    if budget is not None:
        data["budgetP95"] = budget
        data["passed"] = data["p95"] is not None and data["p95"] <= budget
    return data


class MotionPerformance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        cls.states, cls.ids = {}, {}
        started = time.monotonic()
        for key, name in (("ada", "Ada Kowalska"), ("bob", "Bob Nowak")):
            context = cls.browser.new_context(base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": f"perf-{key}-{STAMP}@example.test", "name": name, "password": PASSWORD}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            context.close()
        owner = cls.browser.new_context(base_url=ORIGIN, storage_state=cls.states["ada"])

        def post(path, body):
            response = owner.request.post(path, data=body, headers={"origin": ORIGIN})
            assert response.status in (200, 201), response.text()
            return response.json()
        workspace = post("/api/v1/workspaces", {"name": "Measured studio"})["id"]
        post(f"/api/v1/workspaces/{workspace}/members", {"email": f"perf-bob-{STAMP}@example.test", "role": "member"})
        cls.projects = []
        for name in ("Reading lamp", "Garden sensor", "Library shelf"):
            project = post(f"/api/v1/workspaces/{workspace}/projects", {"name": name, "visibility": "restricted"})["id"]
            post(f"/api/v1/projects/{project}/grants", {"principal": {"kind": "human", "id": cls.ids["bob"]}, "role": "contributor"})
            cls.projects.append(project)
            for index in range(60):
                post(f"/api/v1/projects/{project}/conversations", {"body": f"{name} note {index + 1}: compare the reading at dusk before choosing a threshold.", "clientMessageId": str(uuid.uuid4())})
            for index in range(40):
                post(f"/api/v1/projects/{project}/work", {"title": f"{name} check {index + 1}", "clientCommandId": str(uuid.uuid4())})
        cls.thread = post(f"/api/v1/projects/{cls.projects[0]}/conversations", {"body": "Where should the manual switch go?", "clientMessageId": str(uuid.uuid4())})
        for index in range(40):
            post(f"/api/v1/conversations/{cls.thread['id']}/messages", {"body": f"Reply {index + 1}: the switch should stay reachable in the dark.", "clientMessageId": str(uuid.uuid4())})
        owner.close()
        cls.report = {"schema": 1, "sourceCommit": os.environ.get("FLUX_GIT_COMMIT", "unavailable"), "browser": cls.browser.version,
                      "startedUTC": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "fixtureSeconds": round(time.monotonic() - started, 3),
                      "fixture": {"projects": 3, "rootsPerProject": 60, "tasksPerProject": 40, "threadReplies": 40, "people": 2},
                      "method": {"warmups": WARMUPS, "samples": SAMPLES, "minSeconds": SECONDS}, "profiles": []}

    @classmethod
    def tearDownClass(cls):
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / "motion-performance.json").write_text(json.dumps(cls.report, indent=2) + "\n")
        cls.browser.close()
        cls.pw.stop()

    def open(self, who, viewport, cpu, path):
        context = self.browser.new_context(base_url=ORIGIN, storage_state=self.states[who], viewport=viewport, device_scale_factor=1, locale="en-GB")
        context.add_init_script(PROBE)
        page = context.new_page()
        if cpu > 1:
            context.new_cdp_session(page).send("Emulation.setCPUThrottlingRate", {"rate": cpu})
        page.goto(path)
        page.wait_for_selector(".views .ui-tabs__indicator[data-target]")
        page.wait_for_timeout(1000)
        return context, page

    def sample(self, page, act, kind):
        act()
        page.wait_for_function("() => window.__motionProbe.result !== null", timeout=30000)
        result = page.evaluate("() => window.__motionProbe.result")
        self.assertFalse(result.get("timeout"), f"{kind} completed: {result}")
        page.wait_for_timeout(120)
        return result

    def series(self, page, actions, kind):
        for index in range(WARMUPS):
            self.sample(page, actions[index % len(actions)], kind)
        results, begun, index = [], time.monotonic(), 0
        while len(results) < SAMPLES or time.monotonic() - begun < SECONDS:
            results.append(self.sample(page, actions[index % len(actions)], kind))
            index += 1
        return results, round(time.monotonic() - begun, 3)

    def test_motion_and_navigation_feedback_budgets(self):
        failures = []
        for label, viewport, cpu in (("desktop", {"width": 1280, "height": 800}, 1), ("phone-cpu4", {"width": 390, "height": 844}, 4)):
            budget = BUDGETS[label]
            profile = {"label": label, "viewport": viewport, "cpuThrottle": cpu, "distributions": {}}
            context, page = self.open("ada", viewport, cpu, f"/projects/{self.projects[0]}")
            tabs = page.locator(".views")
            go = lambda name: (lambda: tabs.locator(f'[data-tab="{name}"]').click())
            results, seconds = self.series(page, [go("tasks"), go("conversation")], "tab")
            profile["distributions"]["workTab"] = {"seconds": seconds,
                "selectionFeedback": summary([r["feedback"] for r in results], budget["selectionFeedback"]),
                "motionEnd": summary([r["motionEnd"] for r in results], budget["motionEnd"]),
                "selectionCommitted": summary([r["committed"] for r in results], budget["selectionCommitted"]),
                "maxFrameGap": summary([r["maxGap"] for r in results], budget["frameGap"])}
            if label == "desktop":
                pick = lambda index: (lambda: page.locator(f'.side .side__project[data-glide-id="{self.projects[index]}"]').click())
                results, seconds = self.series(page, [pick(1), pick(2), pick(0)], "project")
                profile["distributions"]["project"] = {"seconds": seconds,
                    "selectionFeedback": summary([r["feedback"] for r in results], budget["selectionFeedback"]),
                    "motionEnd": summary([r["motionEnd"] for r in results], budget["motionEnd"]),
                    "selectionCommitted": summary([r["committed"] for r in results], budget["selectionCommitted"]),
                    "maxFrameGap": summary([r["maxGap"] for r in results], budget["frameGap"])}
            context.close()
            # Keys with typing presence live: Bob watches the same thread, so Ada's input publishes activity.
            watcher, _ = self.open("bob", {"width": 1280, "height": 800}, 1, f"/projects/{self.projects[0]}/conversations/{self.thread['id']}")
            context, page = self.open("ada", viewport, cpu, f"/projects/{self.projects[0]}/conversations/{self.thread['id']}")
            box = page.locator("#thread-composer")
            box.click()
            box.fill("Measured reply text")
            keys = [lambda: page.keyboard.press("x"), lambda: page.keyboard.press("Backspace")]
            results, seconds = self.series(page, keys, "key")
            profile["distributions"]["composerKeyWithTyping"] = {"seconds": seconds, "keyInput": summary([r["key"] for r in results], budget["keyInput"])}
            self.assertTrue(box.input_value().startswith("Measured reply text"), "the measurement only typed and erased one character")
            context.close(); watcher.close()
            for name, distribution in profile["distributions"].items():
                for metric, data in distribution.items():
                    if isinstance(data, dict) and data.get("passed") is False:
                        failures.append(f"{label}:{name}:{metric}")
            self.report["profiles"].append(profile)
        self.report["observedFailures"] = failures
        self.report["outcome"] = "within-budgets" if not failures else "observed-budget-failures"
        self.assertEqual(failures, [], "every p95 is within its budget")


if __name__ == "__main__":
    unittest.main(verbosity=2)
