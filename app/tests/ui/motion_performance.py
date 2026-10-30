"""Opt-in #155/#151 measurement of navigation feedback, motion, typing and layout switches against the agreed budgets.

Not part of normal test_*.py discovery (it takes about twenty minutes). Run it explicitly through the
pinned UI stack: `./scripts/check_ui.sh motion_performance` with FLUX_UI_SCREENSHOT_DIR set; the report
is written to motion-performance.json there.

Method (same as the accepted #151/#155 native-work kickoff, docs/development/performance/
2026-10-01-native-work.md): public commands create a realistic project fixture; Chromium (Python
Playwright) issues trusted clicks/taps/keys; the page's own monotonic clock times each action from the
trusted event's timeStamp to a double-requestAnimationFrame following-frame proxy (not a raster
completion claim). The work-tab, project and key distributions have 30 warm-ups and at least 200 measured
actions over at least 60 s, per profile: 1280x800 DPR1 with tabs, and 390x844 DPR1 with touch, a mobile
viewport and CDP 4x CPU throttling (viewport/CPU emulation, not a physical phone) with the phone's title
menu (#341: the title opens the view menu, choosing a view closes it). API, database and worker are uncapped.

Phone navigation has no traveling highlight, so its three marks are the menu's: feedback is the menu leaving
(`data-state="closing"`), motion end is the menu gone, committed is the header naming the chosen view.

A layout switch (a window resize or rotation, `Page.set_viewport_size`) runs from the resize event to the
last frame in which the shell's landmarks (`LANDMARKS`) changed place or size, plus the following frame; they must
stay unchanged for 150 ms to count as settled (the worst frame gap is read to that point). Layout distributions have 15 warm-ups and
`FLUX_MOTION_LAYOUT_SAMPLES` (default 100) measured switches per destination.

Budgets are the ones agreed in docs/design/adaptive-workspaces.md ("Agreed performance budgets"); the
constants below must equal that table (tests/test_adaptive_budgets.py checks it). Observed failures are
reported, never hidden; the run fails when a budget fails, except a miss listed in KNOWN_MISSES, which names its issue and a
ceiling for its p95, is reported as open, fails the run above that ceiling and fails it once it stops missing. Each distribution also reports its long animation frames (over 50 ms):
how many, how long, and which scripts and how much forced layout they held. Observed, not budgeted.
"""
from __future__ import annotations

import json
import math
from collections import Counter
import os
from pathlib import Path
import re
import time
from urllib.parse import urlparse
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
# The agreed p95 budgets in milliseconds (docs/design/adaptive-workspaces.md, "Agreed performance budgets").
# selectionFeedback: trusted click or tap to the chosen item's first marked frame. motionEnd: to the motion finishing.
# selectionCommitted: to the route showing the choice. keyInput: keydown to the controlled input's paint.
# frameGap: the worst gap between two frames from the action to its committed paint. layoutSwitch: a resize to settled.
# layoutGap: the worst frame gap during it. layoutRequests: API reads a resize causes (a shell that swaps for another reads its two small agent lists on mount; a bigger window of
# the same shell reads nothing).
# heapGrowthMB: the JavaScript heap after a forced collection, at the end of the profile against its start (a single ceiling, not a p95).
# listScroll: a wheel over a long list (the Tasks board's pane, the conversation stream) to the frame after it moved. mapPan: a wheel over the
# map to the frame after its view moved. mapZoom: a zoom (Ctrl+wheel on the computer, the zoom control's tap on the phone) to the
# frame after the map took its new scale. scrollGap: the worst frame gap from that input to its paint.
BUDGETS = {
    "desktop": {"selectionFeedback": 150, "motionEnd": 370, "selectionCommitted": 200, "keyInput": 100, "frameGap": 50,
                "layoutSwitch": 100, "layoutGap": 100, "layoutRequests": 3, "heapGrowthMB": 20,
                "listScroll": 100, "mapPan": 100, "mapZoom": 100, "scrollGap": 50},
    "phone-cpu4": {"selectionFeedback": 300, "motionEnd": 420, "selectionCommitted": 420, "keyInput": 200, "frameGap": 100,
                   "layoutSwitch": 250, "layoutGap": 250, "layoutRequests": 3, "heapGrowthMB": 20,
                   "listScroll": 200, "mapPan": 200, "mapZoom": 200, "scrollGap": 100},
}
# A frame time is a requestAnimationFrame timestamp, quantised to the 16.7 ms frame: three frames read 50.0 to 50.1 ms. A p95 within
# half a millisecond of its budget passes; nothing else is allowed over.
JITTER_MS = 0.5
# Budgets the harness measures as missed today. Each is reported as open (never as passing), names its issue and carries a ceiling
# for its p95 (just above the worst of the runs that found it): the run does not fail for the miss, fails above the ceiling, and
# fails when the miss stops, so a closed one must be deleted from this list.
KNOWN_MISSES = {"phone-cpu4:workTab:maxFrameGap": {"issue": "#716", "maxP95": 150}}


def classify_misses(failures, p95s, measured=None):
    """Splits budget failures into the known misses still within their ceiling, the failures that are not allowed (an unknown one,
    or a known one above its ceiling) and the known misses that no longer miss. `measured` (when given) is every key the run
    measured, so a run of one test does not report the other test's known miss as closed."""
    known = {failure: {"issue": KNOWN_MISSES[failure]["issue"], "maxP95": KNOWN_MISSES[failure]["maxP95"], "p95": p95s[failure]}
             for failure in failures if failure in KNOWN_MISSES and failure in p95s and p95s[failure] <= KNOWN_MISSES[failure]["maxP95"] + JITTER_MS}
    unexpected = sorted(failure for failure in failures if failure not in known)
    closed = sorted(miss for miss in KNOWN_MISSES if miss not in failures and (measured is None or miss in measured))
    return known, unexpected, closed


# The same desktop journeys with reduced motion (tokens 0 ms): what the motion itself costs.
BUDGETS["desktop-reduced"] = dict(BUDGETS["desktop"])
# Window sizes: the profile's own, and what a person can reach from it (a tablet, a wide screen; a rotation, an unfolded phone).
DESKTOP = {"width": 1280, "height": 800}
LAYOUT_PAIRS = {
    "desktop": {"phone": {"width": 390, "height": 844}, "tablet": {"width": 820, "height": 1180}, "wide": {"width": 3840, "height": 2160}},
    "phone-cpu4": {"landscape": {"width": 844, "height": 390}, "unfolded": {"width": 820, "height": 1180}},
}
MAP_THOUGHTS = 60
LAYOUT_SAMPLES = int(os.environ.get("FLUX_MOTION_LAYOUT_SAMPLES", "100"))
LAYOUT_WARMUPS = int(os.environ.get("FLUX_MOTION_LAYOUT_WARMUPS", "15"))
# The shell's landmarks whose place and size settle when the layout switches (the sidebar or its rail, the header or the
# phone's title, the dock, the work surface).
LANDMARKS = ["#content", "#content > *", ".side", ".top", ".phead", ".phone-dock"]
PROBE = r"""(() => {
  const probe = window.__motionProbe = { result: null, loaf: [] };
  // Every long animation frame (over 50 ms) with where its time went: script, style and layout, render. Observed, not budgeted.
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        probe.loaf.push({ duration: e.duration, blocking: e.blockingDuration, scriptMs: e.scripts.reduce((sum, c) => sum + c.duration, 0),
          styleLayoutMs: e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : null, renderStartMs: e.renderStart ? e.renderStart - e.startTime : null,
          scripts: e.scripts.map((c) => ({ file: c.sourceURL.split('/').pop(), fn: c.sourceFunctionName, invoker: c.invoker, ms: c.duration, forcedMs: c.forcedStyleAndLayoutDuration })) });
      }
    }).observe({ type: 'long-animation-frame' });
  } catch (error) { probe.loaf = null; }
  // One trusted click or tap on a project row, a work tab or (the phone) a view in the title menu: feedback (the
  // highlight/mark on the chosen item, or the menu leaving, then two following frames), the motion's end, the route
  // committing that choice, and frame gaps.
  const watchers = {
    tab: (id) => ({
      mark: () => { const m = document.querySelector('.views .ui-tabs__indicator, .top__views .ui-tabs__indicator'); return m && m.dataset.target === id ? m : null; },
      ended: (m) => !m.getAnimations().some((a) => a.playState === 'running'),
      current: () => document.querySelector(`:is(.views, .top__views) [data-tab="${id}"][aria-current="page"]`),
    }),
    project: (id) => ({
      mark: () => { const m = document.querySelector('.side .side__glide'); return m && m.dataset.target === id ? m : null; },
      ended: (m) => !m.getAnimations().some((a) => a.playState === 'running'),
      current: () => document.querySelector(`.side .side__project.is-open[data-glide-id="${id}"]`),
    }),
    // The title menu has no traveling mark: the menu leaving is the answer, and the header naming the view is the commit.
    phone: (id) => ({
      mark: () => document.querySelector('.ui-overlay[data-state="closing"] .phone-menu') || (document.querySelector('.phone-menu') ? null : document.body),
      ended: () => !document.querySelector('.phone-menu'),
      current: () => { const sub = document.querySelector('.phead__sub'); return sub && sub.textContent.trim().startsWith(id) ? sub : null; },
    }),
  };
  document.addEventListener('click', (event) => {
    const el = event.target instanceof Element ? event.target.closest('.views [data-tab], .top__views [data-tab], .side .side__project, .phone-menu__list a.phone-menu__item') : null;
    if (!el || !event.isTrusted) return;
    const kind = el.matches('.side__project') ? 'project' : el.matches('.phone-menu__item') ? 'phone' : 'tab';
    const id = kind === 'tab' ? el.dataset.tab : kind === 'phone' ? el.querySelector('.phone-menu__l').textContent.trim() : el.dataset.glideId;
    const watch = watchers[kind](id);
    const start = event.timeStamp;
    const run = { kind, id, feedback: null, motionEnd: null, committed: null, maxGap: 0 };
    probe.result = null;
    let last = performance.now(), seen = false, committing = false;
    const step = (now) => {
      run.maxGap = Math.max(run.maxGap, now - last); last = now;
      const m = watch.mark();
      if (!seen && m) {
        seen = true;
        requestAnimationFrame(() => requestAnimationFrame(() => { run.feedback = performance.now() - start; }));
      }
      if (run.feedback !== null && run.motionEnd === null && m && watch.ended(m)) run.motionEnd = performance.now() - start;
      if (watch.current() && !committing) { committing = true; requestAnimationFrame(() => requestAnimationFrame(() => { run.committed = performance.now() - start; })); }
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
  // A wheel, Ctrl+wheel or tap the harness armed on a scroller (a list or the map): from the trusted event to the frame after the
  // scroller's position (or the map's scale) changed, then the following frame; the worst frame gap meanwhile. An input that
  // moves nothing (a list at its end) is not a sample: it times out and the harness fails it rather than counting it.
  const moved = window.__movedProbe = { armed: null, result: null };
  moved.arm = (kind, selector) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`no ${selector}`);
    const state = kind === 'zoom' ? () => document.querySelector('.sk-zoomed')?.style.width ?? '' : () => `${el.scrollTop},${el.scrollLeft}`;
    moved.result = null;
    moved.armed = { kind, el, state, before: state() };
  };
  const onInput = (event) => {
    const armed = moved.armed;
    if (!armed || !event.isTrusted || !(event.target instanceof Node) || !armed.el.contains(event.target)) return;
    if (armed.kind === 'zoom' ? !(event.type === 'click' || (event.type === 'wheel' && (event.ctrlKey || event.metaKey))) : event.type !== 'wheel') return;
    moved.armed = null;
    const start = event.timeStamp;
    let last = performance.now(), maxGap = 0;
    const step = (now) => {
      maxGap = Math.max(maxGap, now - last); last = now;
      if (armed.state() !== armed.before) {
        requestAnimationFrame((a) => { maxGap = Math.max(maxGap, a - last); last = a; requestAnimationFrame((b) => {
          maxGap = Math.max(maxGap, b - last);
          moved.result = { kind: armed.kind, ms: performance.now() - start, maxGap, before: armed.before, after: armed.state() }; }); });
        return;
      }
      if (now - start > 5000) { moved.result = { kind: armed.kind, timeout: true, before: armed.before }; return; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  for (const type of ['wheel', 'click']) document.addEventListener(type, onInput, { capture: true, passive: true });
  // A resize the harness armed: from the resize event to the frame after the last one in which a landmark of the shell
  // changed place or size, once nothing has changed for SETTLE ms (the layout has settled); the worst frame gap meanwhile.
  const SETTLE = 150;
  const layout = window.__layoutProbe = { armed: false, result: null };
  const LANDMARKS = __LANDMARKS__;
  const signature = () => LANDMARKS.map((selector) => {
    const el = document.querySelector(selector);
    if (!el) return '-';
    const r = el.getBoundingClientRect();
    return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
  }).join('|') + `|${innerWidth}x${innerHeight}`;
  window.addEventListener('resize', (event) => {
    if (!layout.armed) return;
    layout.armed = false;
    const start = event.timeStamp;
    let previous = null, followed = null, last = performance.now(), maxGap = 0, frames = 0;
    const step = (now) => {
      frames += 1; maxGap = Math.max(maxGap, now - last); last = now;
      const current = signature();
      if (current !== previous) { previous = current; followed = null; }
      else if (followed === null) followed = now;
      if (followed !== null && now - followed >= SETTLE) { layout.result = { switchMs: followed - start, maxGap: maxGap, frames }; return; }
      if (now - start > 5000) { layout.result = { timeout: true, maxGap, frames }; return; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
})();""".replace("__LANDMARKS__", json.dumps(LANDMARKS))


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
        data["passed"] = data["p95"] is not None and data["p95"] <= budget + JITTER_MS
    return data


def build_fixture(browser):
    """Two accounts, a workspace and three restricted projects with 60 conversation roots and 40 tasks each, and a 40-reply
    thread in the first (public commands only). Shared with the opt-in trace recorder (motion_trace.py)."""
    states, ids = {}, {}
    started = time.monotonic()
    for key, name in (("ada", "Ada Kowalska"), ("bob", "Bob Nowak")):
        context = browser.new_context(base_url=ORIGIN)
        response = context.request.post("/api/auth/sign-up/email", data={"email": f"perf-{key}-{STAMP}@example.test", "name": name, "password": PASSWORD}, headers={"origin": ORIGIN})
        assert response.status == 200, response.text()
        ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
        states[key] = context.storage_state()
        context.close()
    owner = browser.new_context(base_url=ORIGIN, storage_state=states["ada"])

    def post(path, body):
        response = owner.request.post(path, data=body, headers={"origin": ORIGIN})
        assert response.status in (200, 201), response.text()
        return response.json()
    workspace = post("/api/v1/workspaces", {"name": "Measured studio"})["id"]
    post(f"/api/v1/workspaces/{workspace}/members", {"email": f"perf-bob-{STAMP}@example.test", "role": "member"})
    projects = []
    for name in ("Reading lamp", "Garden sensor", "Library shelf"):
        project = post(f"/api/v1/workspaces/{workspace}/projects", {"name": name, "visibility": "restricted"})["id"]
        post(f"/api/v1/projects/{project}/grants", {"principal": {"kind": "human", "id": ids["bob"]}, "role": "contributor"})
        projects.append(project)
        for index in range(60):
            post(f"/api/v1/projects/{project}/conversations", {"body": f"{name} note {index + 1}: compare the reading at dusk before choosing a threshold.", "clientMessageId": str(uuid.uuid4())})
        for index in range(40):
            post(f"/api/v1/projects/{project}/work", {"title": f"{name} check {index + 1}", "clientCommandId": str(uuid.uuid4())})
    thread = post(f"/api/v1/projects/{projects[0]}/conversations", {"body": "Where should the manual switch go?", "clientMessageId": str(uuid.uuid4())})
    for index in range(40):
        post(f"/api/v1/conversations/{thread['id']}/messages", {"body": f"Reply {index + 1}: the switch should stay reachable in the dark.", "clientMessageId": str(uuid.uuid4())})
    # A map of MAP_THOUGHTS thoughts on a grid wider and taller than the computer's window, each linked to the one before it in its row.
    sketch = post(f"/api/v1/workspaces/{workspace}/sketches", {"title": "Lamp wiring", "scope": "project", "projectId": projects[0]})["id"]
    previous = None
    for index in range(MAP_THOUGHTS):
        column, row = index % 10, index // 10
        extra = {"linkFrom": {"thoughtId": previous}} if previous and column else {}
        previous = post(f"/api/v1/sketches/{sketch}/thoughts", {"text": f"Wire {index + 1}: route it along the shelf, then test the dimmer at dusk.",
                                                                 "x": 40 + column * 300, "y": 40 + row * 220, **extra})["thought"]["id"]
    owner.close()
    return {"states": states, "ids": ids, "projects": projects, "thread": thread, "sketch": sketch, "seconds": round(time.monotonic() - started, 3)}


# The profiles: label, window, CPU throttling, reduced motion. The phone is a touch device with a mobile viewport.
PROFILES = (("desktop", DESKTOP, 1, False), ("desktop-reduced", DESKTOP, 1, True), ("phone-cpu4", {"width": 390, "height": 844}, 4, False))


class MotionPerformance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        fixture = build_fixture(cls.browser)
        cls.p95s = {}
        cls.states, cls.ids, cls.projects, cls.thread, cls.sketch = fixture["states"], fixture["ids"], fixture["projects"], fixture["thread"], fixture["sketch"]
        cls.measured = set()
        cls.report = {"schema": 2, "sourceCommit": os.environ.get("FLUX_GIT_COMMIT", "unavailable"), "browser": cls.browser.version,
                      "startedUTC": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "fixtureSeconds": fixture["seconds"],
                      "fixture": {"projects": 3, "rootsPerProject": 60, "tasksPerProject": 40, "threadReplies": 40, "people": 2, "mapThoughts": MAP_THOUGHTS},
                      "method": {"warmups": WARMUPS, "samples": SAMPLES, "minSeconds": SECONDS, "layoutWarmups": LAYOUT_WARMUPS, "layoutSamples": LAYOUT_SAMPLES},
                      "budgets": BUDGETS, "profiles": []}

    @classmethod
    def tearDownClass(cls):
        failed, known = cls.report.get("observedFailures"), cls.report.get("knownMisses")
        cls.report["outcome"] = "observed-budget-failures" if failed else "within-budgets-except-known-misses" if known else "within-budgets"
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / "motion-performance.json").write_text(json.dumps(cls.report, indent=2) + "\n")
        cls.browser.close()
        cls.pw.stop()

    def open(self, who, viewport, cpu, path, reduced=False, phone=False):
        context = self.browser.new_context(base_url=ORIGIN, storage_state=self.states[who], viewport=viewport, device_scale_factor=1, locale="en-GB",
                                           reduced_motion="reduce" if reduced else "no-preference", has_touch=phone, is_mobile=phone)
        context.add_init_script(PROBE)
        page = context.new_page()
        if cpu > 1:
            context.new_cdp_session(page).send("Emulation.setCPUThrottlingRate", {"rate": cpu})
        page.goto(path)
        # A tab bar's mark (computer), the phone's title menu, or a thread opened by its address.
        page.wait_for_selector(".top__views .ui-tabs__indicator[data-target], .views .ui-tabs__indicator[data-target], .phead__menu, #thread-composer")
        page.wait_for_timeout(1000)
        return context, page

    def moved(self, page, kind, selector, act):
        """One wheel or tap on a scroller, timed in the page from the trusted event to the frame after it moved (or zoomed)."""
        page.evaluate("([kind, selector]) => window.__movedProbe.arm(kind, selector)", [kind, selector])
        act()
        page.wait_for_function("() => window.__movedProbe.result !== null", timeout=30000)
        result = page.evaluate("() => window.__movedProbe.result")
        self.assertFalse(result.get("timeout"), f"{kind} on {selector} moved it: {result}")
        page.wait_for_timeout(120)
        return result

    def moved_series(self, page, kind, selector, acts):
        """Warm-ups, then at least SAMPLES inputs over at least SECONDS; the inputs alternate so no sample lands at an end."""
        for index in range(WARMUPS):
            self.moved(page, kind, selector, acts[index % len(acts)])
        results, begun, index = [], time.monotonic(), 0
        while len(results) < SAMPLES or time.monotonic() - begun < SECONDS:
            results.append(self.moved(page, kind, selector, acts[index % len(acts)]))
            index += 1
        return results, round(time.monotonic() - begun, 3)

    def wheel_at(self, page, selector, dx, dy, ctrl=False):
        def act():
            box = page.locator(selector).first.bounding_box()
            page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            if ctrl:
                page.keyboard.down("Control")
            page.mouse.wheel(dx, dy)
            if ctrl:
                page.keyboard.up("Control")
        return act

    def sample(self, page, act, kind):
        act()
        page.wait_for_function("() => window.__motionProbe.result !== null", timeout=30000)
        result = page.evaluate("() => window.__motionProbe.result")
        self.assertFalse(result.get("timeout"), f"{kind} completed: {result}")
        page.wait_for_timeout(120)
        result["loaf"] = page.evaluate("() => { const l = window.__motionProbe.loaf || []; window.__motionProbe.loaf = l === null ? null : []; return l; }")
        return result

    def series(self, page, actions, kind):
        for index in range(WARMUPS):
            self.sample(page, actions[index % len(actions)], kind)
        results, begun, index = [], time.monotonic(), 0
        while len(results) < SAMPLES or time.monotonic() - begun < SECONDS:
            results.append(self.sample(page, actions[index % len(actions)], kind))
            index += 1
        return results, round(time.monotonic() - begun, 3)

    def heap_mb(self, page):
        """The JavaScript heap in use after a forced collection (Chromium's own accounting, not a quantised estimate)."""
        cdp = page.context.new_cdp_session(page)
        cdp.send("HeapProfiler.collectGarbage")
        return round(cdp.send("Runtime.getHeapUsage")["usedSize"] / 1048576, 1)

    def phone_view(self, page, name):
        """The phone's way to a view (#341): the title opens the menu, the view is a row in it; only the row's tap is timed."""
        def act():
            page.locator(".phead__menu").first.tap()
            menu = page.locator(".phone-menu__list")
            menu.wait_for()
            page.wait_for_timeout(300)  # the menu has finished entering
            menu.get_by_role("link", name=re.compile(f"^{name}")).tap()
        return act

    def switch(self, page, size, requests):
        """One window resize or rotation, timed in the page from the resize event to the settled layout; `requests` is the
        list the page's API requests are appended to, so the switch also reports how many it caused."""
        page.evaluate("() => { window.__layoutProbe.result = null; window.__layoutProbe.armed = true; }")
        before = len(requests)
        page.set_viewport_size(size)
        page.wait_for_function("() => window.__layoutProbe.result !== null", timeout=30000)
        result = page.evaluate("() => window.__layoutProbe.result")
        self.assertFalse(result.get("timeout"), f"layout settled after {size}: {result}")
        result["apiRequests"] = len(requests) - before
        result["apiPaths"] = [re.sub(r"[0-9a-f]{8}-[0-9a-f-]{27}", "{id}", urlparse(url).path) for url in requests[before:]]
        page.wait_for_timeout(100)
        return result

    def layout_distributions(self, page, base, others, budget):
        """Every switch from `base` to each of `others` and back: warm-ups first, then LAYOUT_SAMPLES of each direction."""
        distributions = {}
        requests = []
        page.on("request", lambda request: requests.append(request.url) if "/api/" in request.url else None)
        for name, size in others.items():
            there, back = [], []
            for index in range(LAYOUT_WARMUPS + LAYOUT_SAMPLES):
                for results, target in ((there, size), (back, base)):
                    result = self.switch(page, target, requests)
                    if index >= LAYOUT_WARMUPS:
                        results.append(result)
            for direction, results in ((f"switch-to-{name}", there), (f"switch-from-{name}", back)):
                distributions[direction] = {"viewport": others[name] if direction.startswith("switch-to") else base,
                    "layoutSwitch": summary([r["switchMs"] for r in results], budget["layoutSwitch"]),
                    "maxFrameGap": summary([r["maxGap"] for r in results], budget["layoutGap"]),
                    "apiRequests": summary([r["apiRequests"] for r in results], budget["layoutRequests"]),
                    "apiPaths": dict(Counter(path for r in results for path in r["apiPaths"]).most_common(8))}
        return distributions

    @staticmethod
    def long_frames(results):
        """Where the long animation frames (over 50 ms) of a distribution spent their time: observed, not budgeted."""
        frames = [f for r in results for f in r.get("loaf", [])]
        work = {}
        for f in frames:
            for c in f["scripts"]:
                entry = work.setdefault(f'{c["file"]} {c["fn"] or "-"} {c["invoker"]}', {"count": 0, "ms": 0.0, "forcedStyleLayoutMs": 0.0})
                entry["count"] += 1
                entry["ms"] += c["ms"]
                entry["forcedStyleLayoutMs"] += c["forcedMs"]
        mean = lambda key: round(sum(f[key] or 0 for f in frames) / len(frames), 1) if frames else None
        return {"actions": len(results), "actionsWithALongFrame": sum(1 for r in results if r.get("loaf")), "frames": len(frames),
                "durationP50": percentile([f["duration"] for f in frames], 50), "durationP95": percentile([f["duration"] for f in frames], 95),
                "durationMax": round(max((f["duration"] for f in frames), default=0), 1),
                "meanScriptMs": mean("scriptMs"), "meanStyleLayoutMs": mean("styleLayoutMs"), "meanBlockingMs": mean("blocking"),
                "topScripts": {k: {"count": v["count"], "ms": round(v["ms"], 1), "forcedStyleLayoutMs": round(v["forcedStyleLayoutMs"], 1)}
                               for k, v in sorted(work.items(), key=lambda item: -item[1]["ms"])[:6]}}

    def selection_distribution(self, results, seconds, budget):
        return {"seconds": seconds, "longFrames": self.long_frames(results),
                "selectionFeedback": summary([r["feedback"] for r in results], budget["selectionFeedback"]),
                "motionEnd": summary([r["motionEnd"] for r in results], budget["motionEnd"]),
                "selectionCommitted": summary([r["committed"] for r in results], budget["selectionCommitted"]),
                "maxFrameGap": summary([r["maxGap"] for r in results], budget["frameGap"])}

    def test_motion_and_navigation_feedback_budgets(self):
        failures = []
        for label, viewport, cpu, reduced in PROFILES:
            phone = label.startswith("phone")
            budget = BUDGETS[label]
            profile = {"label": label, "viewport": viewport, "cpuThrottle": cpu, "reducedMotion": reduced, "touch": phone, "distributions": {},
                       "note": "maxFrameGap spans click to committed paint, so it includes the chosen view's own render"}
            context, page = self.open("ada", viewport, cpu, f"/projects/{self.projects[0]}", reduced, phone)
            if phone:
                actions = [self.phone_view(page, "Tasks"), self.phone_view(page, "Conversation")]
            else:
                tabs = page.locator(".views, .top__views").first
                actions = [(lambda name: (lambda: tabs.locator(f'[data-tab="{name}"]').click()))(name) for name in ("tasks", "conversation")]
            heap = {}

            def grown(name, start):
                """One segment of the profile in one document: heap at its start and end, growth against the ceiling."""
                end = self.heap_mb(page)
                heap[name] = {"startMB": start, "endMB": end, "growthMB": round(end - start, 1), "budgetGrowthMB": budget["heapGrowthMB"], "passed": end - start <= budget["heapGrowthMB"]}
            heap_start = None if reduced else self.heap_mb(page)
            results, seconds = self.series(page, actions, "tab")
            profile["distributions"]["workTab"] = self.selection_distribution(results, seconds, budget)
            if not phone:
                pick = lambda index: (lambda: page.locator(f'.side .side__project[data-glide-id="{self.projects[index]}"]').click())
                results, seconds = self.series(page, [pick(1), pick(2), pick(0)], "project")
                profile["distributions"]["project"] = self.selection_distribution(results, seconds, budget)
            if not reduced:
                grown("navigation", heap_start)
                # Layout switches run on the project's conversation, the page a person has open most.
                page.goto(f"/projects/{self.projects[0]}")
                page.wait_for_selector(".top__views .ui-tabs__indicator[data-target], .views .ui-tabs__indicator[data-target], .phead__menu")
                page.wait_for_timeout(1000)
                heap_start = self.heap_mb(page)
                profile["distributions"].update(self.layout_distributions(page, viewport, LAYOUT_PAIRS[label], budget))
                grown("layout", heap_start)
                profile["heapMB"] = heap
            context.close()
            if reduced:
                self.finish(profile, label, failures)
                continue
            # Keys with typing presence live: Bob watches the same thread, so Ada's input publishes activity.
            watcher, _ = self.open("bob", DESKTOP, 1, f"/projects/{self.projects[0]}/conversations/{self.thread['id']}")
            context, page = self.open("ada", viewport, cpu, f"/projects/{self.projects[0]}/conversations/{self.thread['id']}", phone=phone)
            box = page.locator("#thread-composer")
            box.click()
            box.fill("Measured reply text")
            keys = [lambda: page.keyboard.press("x"), lambda: page.keyboard.press("Backspace")]
            results, seconds = self.series(page, keys, "key")
            profile["distributions"]["composerKeyWithTyping"] = {"seconds": seconds, "keyInput": summary([r["key"] for r in results], budget["keyInput"])}
            self.assertTrue(box.input_value().startswith("Measured reply text"), "the measurement only typed and erased one character")
            context.close(); watcher.close()
            self.finish(profile, label, failures)
        misses, unexpected, closed = classify_misses(failures, self.p95s, self.measured)
        self.report.setdefault("knownMisses", {}).update(misses)
        self.report["observedFailures"] = sorted(set(self.report.get("observedFailures", [])) | set(unexpected))
        self.assertEqual(unexpected, [], "every p95 is within its budget, or its known miss's ceiling")
        self.assertEqual(closed, [], "a known miss that no longer misses is deleted from KNOWN_MISSES")

    def test_map_and_list_latency_budgets(self):
        """#151 AC-4: list scroll, map pan and map zoom, wheel or tap to the following paint, per profile (not reduced motion)."""
        failures = []
        for label, viewport, cpu, reduced in PROFILES:
            if reduced:
                continue
            phone = label.startswith("phone")
            budget = BUDGETS[label]
            profile = {"label": label, "viewport": viewport, "cpuThrottle": cpu, "touch": phone, "distributions": {},
                       "note": "wheel input on both profiles (a touch drag has no trusted start event to time from); the phone zooms with the zoom control in its Map options sheet"}
            lists = (("tasksList", f"/projects/{self.projects[0]}/tasks", ".tb-board, .ws-task", "closest"), ("stream", f"/projects/{self.projects[0]}", ".project-convo__feed", "self"))
            for name, path, selector, how in lists:
                context, page = self.open("ada", viewport, cpu, path, phone=phone)
                page.locator(selector).first.wait_for()
                if how == "closest":
                    page.evaluate("(s) => document.querySelector(s).closest('.pane-scroll').setAttribute('data-measured', '')", selector)
                    scroller = "[data-measured]"
                else:
                    scroller = selector
                room = page.evaluate("(s) => { const el = document.querySelector(s); el.scrollTop = Math.max(0, (el.scrollHeight - el.clientHeight) / 2); return el.scrollHeight - el.clientHeight; }", scroller)
                self.assertGreater(room, 400, f"the {name} is long enough to scroll at {viewport}")
                page.wait_for_timeout(300)
                results, seconds = self.moved_series(page, "scroll", scroller, [self.wheel_at(page, scroller, 0, 180), self.wheel_at(page, scroller, 0, -180)])
                profile["distributions"][name] = {"seconds": seconds, "scrollRoom": room, "listScroll": summary([r["ms"] for r in results], budget["listScroll"]),
                                                  "maxFrameGap": summary([r["maxGap"] for r in results], budget["scrollGap"])}
                context.close()
            context, page = self.open("ada", viewport, cpu, f"/projects/{self.projects[0]}/map/{self.sketch}", phone=phone)
            page.wait_for_function(f"() => document.querySelectorAll('.sk-node').length === {MAP_THOUGHTS}", timeout=30000)
            page.wait_for_timeout(500)
            canvas = ".sk-canvas"
            # Pan from the middle of the map, down and back (and sideways on the computer, where the plane is wider than the window).
            page.evaluate("(s) => { const el = document.querySelector(s); el.scrollTop = (el.scrollHeight - el.clientHeight) / 2; el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2; }", canvas)
            page.wait_for_timeout(300)
            pans = [self.wheel_at(page, canvas, 0, 180), self.wheel_at(page, canvas, 0, -180)]
            if not phone:
                pans += [self.wheel_at(page, canvas, 180, 0), self.wheel_at(page, canvas, -180, 0)]
            results, seconds = self.moved_series(page, "scroll", canvas, pans)
            profile["distributions"]["mapPan"] = {"seconds": seconds, "mapPan": summary([r["ms"] for r in results], budget["mapPan"]),
                                                  "maxFrameGap": summary([r["maxGap"] for r in results], budget["scrollGap"])}
            if phone:
                # The phone's zoom is in its Map options sheet (#341), which stays open while the map zooms behind it.
                page.get_by_role("button", name="Map options", exact=True).tap()
                sheet = page.get_by_role("dialog", name="Map options", exact=True)
                sheet.get_by_role("button", name="Zoom out", exact=True).wait_for()
                page.wait_for_timeout(500)
                zoom = lambda name: (lambda: sheet.get_by_role("button", name=name, exact=True).tap())
                zooms, scope = [zoom("Zoom in"), zoom("Zoom out")], ".sk-options-sheet"
            else:
                zooms, scope = [self.wheel_at(page, canvas, 0, -100, ctrl=True), self.wheel_at(page, canvas, 0, 100, ctrl=True)], canvas
            results, seconds = self.moved_series(page, "zoom", scope, zooms)
            profile["distributions"]["mapZoom"] = {"seconds": seconds, "input": "the zoom control, tapped" if phone else "Ctrl+wheel",
                                                   "mapZoom": summary([r["ms"] for r in results], budget["mapZoom"]),
                                                   "maxFrameGap": summary([r["maxGap"] for r in results], budget["scrollGap"])}
            context.close()
            self.finish(profile, label, failures)
        misses, unexpected, closed = classify_misses(failures, self.p95s, self.measured)
        self.report.setdefault("knownMisses", {}).update(misses)
        self.report["observedFailures"] = sorted(set(self.report.get("observedFailures", [])) | set(unexpected))
        self.assertEqual(unexpected, [], "every p95 is within its budget, or its known miss's ceiling")
        self.assertEqual(closed, [], "a known miss that no longer misses is deleted from KNOWN_MISSES")

    def finish(self, profile, label, failures):
        for segment, data in profile.get("heapMB", {}).items():
            if data["passed"] is False:
                failures.append(f"{label}:heap:{segment}")
        for name, distribution in profile["distributions"].items():
            for metric, data in distribution.items():
                if isinstance(data, dict) and "passed" in data:
                    self.measured.add(f"{label}:{name}:{metric}")
                if isinstance(data, dict) and data.get("passed") is False:
                    failures.append(f"{label}:{name}:{metric}")
                    self.p95s[f"{label}:{name}:{metric}"] = data["p95"]
        self.report["profiles"].append(profile)


if __name__ == "__main__":
    unittest.main(verbosity=2)
