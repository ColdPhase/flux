"""The shared fixture of the light-motion journeys (#593): real accounts, a project with a conversation and a thread,
tasks in several states, a proposed decision and a recorder of every animation the page starts.

`test_light_motion.py` asserts on it, `motion_evidence.py` films it and `motion_light_performance.py` measures it, so all
three look at the same screens. Nothing is faked in the page: the recorder only wraps `Element.prototype.animate` and
listens for `animationstart`, so what it reports is what the application asked the browser to run.
"""
from __future__ import annotations

import re
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect

from test_app_shell import ORIGIN
from test_work_pagination import api

PASSWORD = "light motion for a calm shared studio"

# Every animation the page starts, with what it animates, how long it lasts and how it eases (script and CSS).
RECORDER = r"""
(() => {
  if (window.__motion) return;
  const log = window.__motion = [];
  const name = (el) => { const cls = el && el.getAttribute ? (el.getAttribute('class') || '').trim() : ''; return !el || !el.tagName ? '' : el.tagName.toLowerCase() + (cls ? '.' + cls.split(/\s+/).join('.') : ''); };
  const skip = new Set(['offset', 'easing', 'composite']);
  const original = Element.prototype.animate;
  Element.prototype.animate = function (frames, options) {
    const animation = original.call(this, frames, options);
    try {
      const list = Array.isArray(frames) ? frames : [];
      const props = new Set();
      for (const frame of list) for (const key of Object.keys(frame)) if (!skip.has(key)) props.add(key);
      const timing = typeof options === 'number' ? { duration: options } : options || {};
      log.push({ kind: 'script', target: name(this), role: this.getAttribute('role') || '', props: [...props], duration: Number(timing.duration), easing: timing.easing || 'linear',
        from: list[0] || null, to: list[list.length - 1] || null, at: performance.now(), hidden: document.visibilityState === 'hidden' });
    } catch (error) { /* the recorder never changes the page */ }
    return animation;
  };
  const keyframeProps = (animationName) => {
    const props = new Set();
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch (error) { continue; }
      for (const rule of rules) if (rule.type === CSSRule.KEYFRAMES_RULE && rule.name === animationName) for (const frame of rule.cssRules) for (const prop of frame.style) props.add(prop);
    }
    return [...props];
  };
  document.addEventListener('animationstart', (event) => {
    const style = getComputedStyle(event.target, event.pseudoElement || null);
    log.push({ kind: 'css', target: name(event.target), pseudo: event.pseudoElement || '', direction: document.documentElement.dataset.vt || '', role: event.target.getAttribute && event.target.getAttribute('role') || '',
      name: event.animationName, props: keyframeProps(event.animationName),
      duration: parseFloat(style.animationDuration) * (/ms$/.test(style.animationDuration) ? 1 : 1000), easing: style.animationTimingFunction, at: performance.now() });
  }, true);
})();
"""

# What may animate. Opacity and transform (including its individual properties) always; the height family only when a row
# is added or collapses (#593 AC-4).
TRANSFORM_ONLY = {"opacity", "transform", "translate", "scale", "rotate"}
ROW_BOX = {"height", "paddingTop", "paddingBottom", "marginTop", "marginBottom", "borderTopWidth", "borderBottomWidth",
           "padding-top", "padding-bottom", "margin-top", "margin-bottom", "border-top-width", "border-bottom-width"}

NUMBER = re.compile(r"-?\d*\.?\d+")


def numbers(text: str) -> list[float]:
    return [float(n) for n in NUMBER.findall(text or "")]


class LightMotion:
    """Accounts, one project and the records its journeys need."""

    def __init__(self, browser: Browser):
        self.browser = browser
        self.stamp = uuid.uuid4().hex[:8]
        self.states: dict[str, dict] = {}
        self.ids: dict[str, str] = {}
        self.contexts: dict[str, BrowserContext] = {}

    # ------------------------------------------------------------------ the fixture
    def build(self) -> "LightMotion":
        for key, name in (("ada", "Ada Kowalska"), ("jonas", "Jonas Berg")):
            context = self.browser.new_context(base_url=ORIGIN, service_workers="block")
            api(context, "POST", "/api/auth/sign-up/email", {"name": name, "email": f"motion-{key}-{self.stamp}@example.test", "password": PASSWORD})
            self.ids[key] = api(context, "GET", "/api/v1/me")["user"]["id"]
            self.contexts[key] = context
        ada, jonas = self.contexts["ada"], self.contexts["jonas"]
        self.workspace = api(ada, "POST", "/api/v1/workspaces", {"name": "Garden co-op"}, 201)["id"]
        api(ada, "POST", f"/api/v1/workspaces/{self.workspace}/members", {"email": f"motion-jonas-{self.stamp}@example.test", "role": "member"}, 201)
        self.project = api(ada, "POST", f"/api/v1/workspaces/{self.workspace}/projects", {"name": "Community garden sensors", "visibility": "restricted"}, 201)["id"]
        self.root = f"/api/v1/projects/{self.project}"
        api(ada, "POST", self.root + "/grants", {"principal": {"kind": "human", "id": self.ids["jonas"]}, "role": "contributor"}, 201)
        self.thread = api(ada, "POST", self.root + "/conversations", {"body": "Should the first sensors measure soil moisture, or only temperature for the frost warnings?", "clientMessageId": str(uuid.uuid4())}, 201)
        for who, text in ((jonas, "Moisture first. The volunteers keep overwatering the raised beds."), (ada, "Agreed. I compared probes in the shortlist."),
                          (jonas, "Then let us order six and put two on the far beds.")):
            api(who, "POST", f"/api/v1/conversations/{self.thread['id']}/messages", {"body": text, "clientMessageId": str(uuid.uuid4())}, 201)
        self.source = {"type": "message", "id": self.thread["messages"][0]["id"]}
        self.tasks = [self.new_task(title, status=status) for title, status in (
            ("Order six moisture probes", None), ("Raised beds by the fence: overwatered", None), ("Mount the gateway on the shed", "in_progress"),
            ("Calibrate the probes at two depths", None), ("Write the volunteers' watering guide", "done"))]
        self.decision = api(jonas, "POST", self.root + "/decisions", {"title": "Measure soil moisture first", "rationale": "Overwatering is the real problem."}, 201)
        self.second_decision = api(jonas, "POST", self.root + "/decisions", {"title": "Label every bed with a QR code", "rationale": "Volunteers scan, not guess."}, 201)
        self.states["ada"] = ada.storage_state()
        return self

    def new_task(self, title: str, status: str | None = None) -> dict:
        task = api(self.contexts["ada"], "POST", self.root + "/work", {"title": title, "sources": [self.source], "owner": {"kind": "human", "id": self.ids["ada"]}}, 201)
        if status:
            task = api(self.contexts["ada"], "PATCH", f"/api/v1/work/{task['id']}", {"status": status, "expectedVersion": task["version"]})
        return task

    def close(self) -> None:
        for context in self.contexts.values():
            context.close()

    # ------------------------------------------------------------------ pages
    def context(self, *, phone: bool = False, scheme: str = "light", reduced: bool = False, video_dir: str | None = None, viewport: dict | None = None,
                record: bool = True, scale: float = 1) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "storage_state": self.states["ada"], "color_scheme": scheme, "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "service_workers": "block", "reduced_motion": "reduce" if reduced else "no-preference",
                         "viewport": viewport or ({"width": 390, "height": 844} if phone else {"width": 1440, "height": 900}), "device_scale_factor": scale}
        if phone:
            options.update(is_mobile=True, has_touch=True)
        if video_dir:
            options["record_video_dir"] = video_dir
            options["record_video_size"] = options["viewport"]
        context = self.browser.new_context(**options)
        if record:
            context.add_init_script(RECORDER)
        return context

    # ------------------------------------------------------------------ addresses
    def tasks_url(self, view: str = "list") -> str:
        return f"/projects/{self.project}/tasks?view={view}"

    def task_url(self, task: dict) -> str:
        return f"/projects/{self.project}/tasks?view=list&open=work:{task['id']}"

    def thread_url(self) -> str:
        return f"/projects/{self.project}/conversations/{self.thread['id']}"

    def project_url(self) -> str:
        return f"/projects/{self.project}"


def settled(page: Page, ms: int = 450) -> None:
    """Every animation of ours and every CSS animation has finished (endless indicators are ignored)."""
    page.wait_for_function("() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity)", timeout=10000)
    page.wait_for_timeout(ms // 3)


def ready(page: Page) -> None:
    """The shell is committed and motion is allowed (first paint has passed)."""
    expect(page.locator("#content")).to_be_visible()
    page.wait_for_timeout(250)


def recorded(page: Page) -> list[dict]:
    return page.evaluate("window.__motion || []")


def clear(page: Page) -> None:
    page.evaluate("window.__motion && (window.__motion.length = 0)")


# Samples boxes frame by frame while `action` runs inside the page: what an animation does to everything that must not move.
SAMPLE_WHILE = r"""
async ({ action, boxes, ms }) => {
  const act = new Function('return (' + action + ')')();
  const frames = [];
  const read = (t) => ({ t, boxes: Object.fromEntries(Object.entries(boxes).map(([key, selector]) => {
    const el = document.querySelector(selector); if (!el) return [key, null];
    const r = el.getBoundingClientRect(); return [key, [Math.round(r.left * 100) / 100, Math.round(r.top * 100) / 100, Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100]]; })) });
  const start = performance.now();
  frames.push(read(0));
  await act();
  await new Promise((resolve) => { const step = () => { const t = performance.now() - start; frames.push(read(t)); t < ms ? requestAnimationFrame(step) : resolve(); }; requestAnimationFrame(step); });
  return frames;
}
"""


def sample_while(page: Page, action: str, boxes: dict[str, str], ms: int = 700) -> list[dict]:
    return page.evaluate(SAMPLE_WHILE, {"action": action, "boxes": boxes, "ms": ms})


def relative(frames: list[dict], key: str, to: str) -> list[dict]:
    """The same frames with `key` measured from the top left of `to` (a panel's head from the panel, whatever shifts the panel as a whole)."""
    out = []
    for frame in frames:
        a, b = frame["boxes"].get(key), frame["boxes"].get(to)
        out.append({"t": frame["t"], "boxes": {key: [a[0] - b[0], a[1] - b[1], a[2], a[3]] if a and b else None}})
    return out


def moved(frames: list[dict], key: str, tolerance: float = 0.5) -> list[tuple[float, list[float]]]:
    """The frames in which a box differs from the one it had before the action (frames without it are ignored)."""
    base = frames[0]["boxes"][key]
    return [(frame["t"], frame["boxes"][key]) for frame in frames if frame["boxes"][key] is not None and base is not None
            and any(abs(a - b) > tolerance for a, b in zip(frame["boxes"][key], base))]
