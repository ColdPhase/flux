"""Visual consistency audit (#763): measures every control on every screen and flags what the eye would catch.

Not a test and not part of the default suite (the name does not match test_*.py): it measures, writes findings and
screenshots, and exits 0 whatever it finds. Functional tests prove that a button works; this proves that it looks like
its neighbours. It found, for example, the Wiki "Edit" button standing far taller than the icon buttons beside it.

Run it with `./scripts/visual_audit.sh` (Docker only): that starts the app on its own Compose project and loopback
port, seeds the `./flux demo` data (scripts/flux-demo.mjs), then runs this file in the pinned Playwright container.
This file adds more realistic multi-user data through the public API (a third member, a newcomer with nothing yet,
tasks in every state, two proposed decisions, mentions, threads, a link card, an agent and an empty project), then
visits each screen and state at each window in each theme and engine, and measures in the page:

  (a) controls in one visual row with different heights, centres or text baselines;
  (b) buttons whose height is not the control height (--ctl: 32 px with a mouse, 44 px on touch; --ctl-lg 44 px is
      the form size), icon buttons of other sizes, and touch targets under 44 px;
  (c) more than one inverted (dark in light theme) button in one region (screen, panel, dialog, floating bar);
  (d) font sizes outside the --fs-* tokens, weights other than 400/500/600, families other than Geist;
  (e) button radius other than --r-btn (10), chips and pills that are not round, field radii;
  (f) text truncated or clipped, controls cut by a container or the window, horizontal page overflow, and content
      that stays under a fixed bar or the floating "+" even at the end of its scroll (phone 360/390/430 included);
  (g) siblings in one list or row with uneven gaps;
  (h) icons of different sizes or stroke widths in one row;
  (i) text below 4.5:1 (3:1 for large text) and icons below 3:1 against the colour actually behind them.

Output in FLUX_AUDIT_OUT (default $FLUX_UI_SCREENSHOTS/visual-audit): shots/<engine>-<theme>-<width>/<screen>.png
(plus -annot.png with the flagged boxes outlined, and -bottom.png scrolled to the end when something stays covered
there), results-<engine>-<theme>.jsonl (every measurement), findings.json and findings.md (deduplicated, P2 first),
and contact sheets in sheets/. The thresholds are the design's (docs/design/final/README.md §2, amendment
2026-10-31), read from the live tokens in the page, so a token change moves the audit with it.

Environment: FLUX_UI_ORIGIN / FLUX_UI_UPSTREAM (from the ui-test service), FLUX_DEMO_OWNER_PASSWORD and
FLUX_DEMO_PARTNER_PASSWORD (the demo logins), and optionally FLUX_AUDIT_BROWSERS (chromium,webkit),
FLUX_AUDIT_THEMES (light,dark), FLUX_AUDIT_VIEWPORTS (360,390,430,820,1440,1920), FLUX_AUDIT_SCREENS (names,
comma-separated; default all) and FLUX_AUDIT_PHASE (all, seed, measure or report; measure processes for different
engines or themes can run side by side and one report merges them).
Emulated windows in headless engines, not devices: the numbers are CSS pixels at device pixel ratio 1.
"""
from __future__ import annotations

import html
import json
import os
import re
import sys
import time
import urllib.parse
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from playwright.sync_api import Browser, BrowserContext, Page, sync_playwright

from test_app_shell import ORIGIN, UPSTREAM, start_forwarder

OUT = Path(os.environ.get("FLUX_AUDIT_OUT") or Path(os.environ.get("FLUX_UI_SCREENSHOTS", "/screenshots")) / "visual-audit")
BROWSERS = [b for b in (os.environ.get("FLUX_AUDIT_BROWSERS") or "chromium,webkit").split(",") if b]
THEMES = [t for t in (os.environ.get("FLUX_AUDIT_THEMES") or "light,dark").split(",") if t]
ONLY = {s for s in (os.environ.get("FLUX_AUDIT_SCREENS") or "").split(",") if s}
PHASE = os.environ.get("FLUX_AUDIT_PHASE") or "all"
TAG = os.environ.get("FLUX_AUDIT_TAG") or ""  # a second measure run into the same folder keeps its own results file
WINDOWS = {
    "360": {"width": 360, "height": 780, "touch": True, "mobile": True},
    "390": {"width": 390, "height": 844, "touch": True, "mobile": True},
    "430": {"width": 430, "height": 932, "touch": True, "mobile": True},
    "820": {"width": 820, "height": 1180, "touch": True, "mobile": False},
    "1024": {"width": 1024, "height": 768, "touch": False, "mobile": False},   # opt-in laptop widths (FLUX_AUDIT_VIEWPORTS)
    "1280": {"width": 1280, "height": 800, "touch": False, "mobile": False},
    "1440": {"width": 1440, "height": 900, "touch": False, "mobile": False},
    "1920": {"width": 1920, "height": 1080, "touch": False, "mobile": False},
}
VIEWPORTS = [v for v in (os.environ.get("FLUX_AUDIT_VIEWPORTS") or "360,390,430,820,1440,1920").split(",") if v in WINDOWS]

DEMO = {
    "ada": ("Ada Kowalska", "ada@demo.flux.test", os.environ.get("FLUX_DEMO_OWNER_PASSWORD", "")),
    "jonas": ("Jonas Berg", "jonas@demo.flux.test", os.environ.get("FLUX_DEMO_PARTNER_PASSWORD", "")),
}
EXTRA_PASSWORD = "audit the quiet buttons on every screen"
EXTRA = {
    "maja": ("Maja Wiśniewska-Lindqvist", "maja@demo.flux.test"),
    "piotr": ("Piotr Zieliński", "piotr@demo.flux.test"),
}
WORKSPACE = "Riverside Makers (demo)"
GARDEN = "Community garden sensors"
LIBRARY = "Tool library for the makerspace"
EMPTY = "Rain barrel monitor"
SEED_MARK = "Calibrate the soil moisture probes in the raised beds"


# ---------------------------------------------------------------------------------------------------------------
# Data: the demo plus realistic multi-user content, through the public API (idempotent: a second run reuses it).
# ---------------------------------------------------------------------------------------------------------------

def call(context: BrowserContext, method: str, path: str, body: dict | None = None, ok=(200, 201)) -> dict:
    response = context.request.fetch(f"{ORIGIN}{path}", method=method, data=body,
                                     headers={"origin": ORIGIN, "idempotency-key": str(uuid.uuid4())})
    if response.status not in ok:
        raise RuntimeError(f"{method} {path}: {response.status} {response.text()[:300]}")
    text = response.text()
    return json.loads(text) if text else {}


def sign_in(browser: Browser, email: str, password: str, name: str | None = None) -> BrowserContext:
    context = browser.new_context(base_url=ORIGIN, service_workers="block")
    response = context.request.post("/api/auth/sign-in/email", data={"email": email, "password": password}, headers={"origin": ORIGIN})
    if response.status != 200 and name:
        response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": password, "name": name},
                                        headers={"origin": ORIGIN})
    if response.status != 200:
        raise RuntimeError(f"sign in {email}: {response.status} {response.text()[:200]}")
    return context


def items(payload) -> list:
    return payload.get("items", []) if isinstance(payload, dict) else payload


def seed(browser: Browser) -> dict:
    """Signs everyone in, adds the extra data once, and returns ids and storage states."""
    contexts = {key: sign_in(browser, email, password) for key, (_, email, password) in DEMO.items()}
    for key, (name, email) in EXTRA.items():
        contexts[key] = sign_in(browser, email, EXTRA_PASSWORD, name)
    me = {key: call(c, "GET", "/api/v1/me")["user"]["id"] for key, c in contexts.items()}
    ada, jonas, maja = contexts["ada"], contexts["jonas"], contexts["maja"]
    ws = next(w["id"] for w in call(ada, "GET", "/api/v1/workspaces") if w["name"] == WORKSPACE)
    members = {m["userId"] for m in call(ada, "GET", f"/api/v1/workspaces/{ws}/members")}
    if me["maja"] not in members:
        call(ada, "POST", f"/api/v1/workspaces/{ws}/members", {"email": EXTRA["maja"][1], "role": "member"})
    projects = {p["name"]: p["id"] for p in items(call(ada, "GET", f"/api/v1/workspaces/{ws}/projects"))}
    garden = projects[GARDEN]
    for name in (LIBRARY, EMPTY):
        if name not in projects:
            projects[name] = call(ada, "POST", f"/api/v1/workspaces/{ws}/projects", {"name": name, "visibility": "workspace"})["id"]
    tasks = {t["title"]: t["id"] for t in items(call(ada, "GET", f"/api/v1/projects/{garden}/work?limit=100"))}
    if SEED_MARK not in tasks:
        def task(title, owner, status="open", blocker=None):
            body = {"title": title, "owner": {"kind": "human", "id": me[owner]}, "status": status}
            if blocker:
                body["blocker"] = blocker
            tasks[title] = call(ada, "POST", f"/api/v1/projects/{garden}/work", body)["id"]
        task(SEED_MARK, "ada", "in_progress")
        task("Design a weatherproof enclosure for the far-bed sensors", "ada", "blocked", "Waiting for the probe dimensions from the supplier")
        task("Ask the school about two more ESP32 kits", "jonas")
        task("Test the LoRa range from the far east bed through the hedge", "jonas", "done")
        task("Write the volunteer watering guide for the raised beds", "maja")
        task("Replace the corroded resistive probes in the north raised beds with capacitive ones before the volunteer weekend in May", "maja", "in_progress")
        task("Compare frost-warning thresholds with last spring's notes", "jonas", "not_pursued")
        for i in range(1, 6):
            task(f"Mount sensor {i} on bed {i * 2} and log the first reading", ["ada", "jonas", "maja"][i % 3])
        call(jonas, "POST", f"/api/v1/projects/{garden}/decisions", {
            "title": "Order six capacitive probes now and two more after the school replies",
            "rationale": "The grant covers six; waiting for the school would delay the whole first season.",
            "affects": [tasks[SEED_MARK]]})
        call(maja, "POST", f"/api/v1/projects/{garden}/decisions", {
            "title": "Use LoRa for the far beds and Wi-Fi near the shed",
            "rationale": "The hedge test reached 140 m; Wi-Fi only covers the shed and the first two beds."})
        roots = [
            (jonas, "@Ada Kowalska can you check the shed roof mount before Thursday? The bracket looked loose."),
            (maja, "I wrote the first watering rota. Mornings only, and nobody waters a bed that reports above 40%."),
            (ada, "Link for the delivery dates: https://public.test/ferry (the supplier ships on the same ferry)."),
            (maja, "@Ada Kowalska the volunteer rota is in the Wiki now, could you read it before the weekend?"),
            (jonas, "Short update: the second gateway works from the shed roof. Signal is strong on every bed except the far east one, "
                    "which drops to one bar when the hedge is wet. I will try the taller antenna on Saturday and report back here."),
        ]
        first = None
        for who, body in roots:
            made = call(who, "POST", f"/api/v1/projects/{garden}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())})
            first = first or made["id"]
        for who, body in ((ada, "Yes, I will bring the long ladder."), (maja, "Take a photo of the bracket please."), (jonas, "Thanks both!")):
            call(who, "POST", f"/api/v1/conversations/{first}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())})
        for who, body in ((ada, "Started with bed 2; the dry reading is 3.1 V, wet 1.4 V."), (jonas, "Same range as the datasheet, good.")):
            call(who, "POST", f"/api/v1/work/{tasks[SEED_MARK]}/discussion", {"body": body, "clientMessageId": str(uuid.uuid4()), "kind": "text"})
        dm = call(ada, "POST", f"/api/v1/workspaces/{ws}/dms", {"participantIds": [me["maja"]]})["id"]
        for who, body in ((ada, "Welcome to the garden project! Ask me anything."), (maja, "Thanks! Where do the spare probes live?"),
                          (ada, "In the blue box under the shed bench, next to the solder station.")):
            call(who, "POST", f"/api/v1/dms/{dm}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())})
        try:
            agent = call(ada, "POST", f"/api/v1/workspaces/{ws}/agents", {"name": "Ada's assistant", "owner": "self"})["id"]
            call(ada, "POST", f"/api/v1/projects/{garden}/grants", {"principal": {"kind": "agent", "id": agent}, "role": "contributor"})
            call(ada, "POST", "/api/v1/agent-connections", {"agentId": agent, "selectedProjectIds": [garden],
                 "scopes": ["flux.context.read", "flux.proposal.write"], "name": "Desk laptop", "clientDesignation": "claude_code"})
        except RuntimeError as error:  # an agent is welcome, not required
            print(f"note: agent not seeded: {error}", flush=True)
        library = projects[LIBRARY]
        for title in ("Label every drawer in the tool wall", "Fix the band saw guard", "Write the borrowing rules"):
            call(ada, "POST", f"/api/v1/projects/{library}/work", {"title": title})
        call(jonas, "POST", f"/api/v1/projects/{library}/conversations", {"body": "Who has the key for the tool wall?", "clientMessageId": str(uuid.uuid4())})
    # The worker writes the Inbox shortly after the events.
    for _ in range(60):
        if len(call(ada, "GET", "/api/v1/needs-you").get("items", [])) >= 3:
            break
        time.sleep(0.5)
    ids = {"ws": ws, "p": garden, "p2": projects[LIBRARY], "pe": projects[EMPTY]}
    convs = items(call(ada, "GET", f"/api/v1/projects/{garden}/conversations"))
    threaded = [c for c in convs if (c.get("replyCount") or c.get("replies") or 0)] or convs
    ids["conv"] = (threaded or [{"id": ""}])[0]["id"]
    ids["sketch"] = next((s["id"] for s in items(call(ada, "GET", f"/api/v1/workspaces/{ws}/sketches")) if s.get("projectId") == garden), "")
    ids["doc"] = (items(call(ada, "GET", f"/api/v1/projects/{garden}/docs")) or [{"id": ""}])[0]["id"]
    dms = items(call(ada, "GET", f"/api/v1/workspaces/{ws}/dms"))
    ids["dm"] = next((d["id"] for d in dms if any(p["id"] == me["jonas"] for p in d.get("participants", []))), dms[0]["id"] if dms else "")
    tasks = {t["title"]: t["id"] for t in items(call(ada, "GET", f"/api/v1/projects/{garden}/work?limit=100"))}
    ids["task"] = tasks.get(SEED_MARK, "")
    ids["blocked"] = tasks.get("Design a weatherproof enclosure for the far-bed sensors", "")
    decisions = items(call(ada, "GET", f"/api/v1/projects/{garden}/decisions"))
    ids["decision"] = decisions[0]["id"] if decisions else ""
    queue = call(ada, "GET", "/api/v1/needs-you").get("items", [])
    ids["inbox"] = urllib.parse.quote(queue[0].get("key", ""), safe="") if queue else ""
    states = {key: c.storage_state() for key, c in contexts.items()}
    for c in contexts.values():
        c.close()
    print(f"seeded: {json.dumps(ids)}; needs-you items: {len(queue)}", flush=True)
    return {"ids": ids, "states": states}


# ---------------------------------------------------------------------------------------------------------------
# Screens and states. Steps: ("click", css), ("press", key), ("hover", css), ("wait", css); "phone"/"wide" limit
# a step or a screen to touch windows (<= 820) or mouse windows. A step that cannot run marks the state unreachable.
# ---------------------------------------------------------------------------------------------------------------

@dataclass
class Screen:
    name: str
    path: str
    who: str = "ada"
    steps: list = field(default_factory=list)
    only: str = ""          # "", "phone" (touch windows) or "wide" (mouse windows)
    needs: tuple = ()       # ids that must exist


SCREENS = [
    Screen("sign-in", "/sign-in", who="anon"),
    Screen("sign-up", "/sign-up", who="anon"),
    Screen("forgot-password", "/forgot-password", who="anon"),
    Screen("join-invalid", "/join?token=not-a-real-invite", who="anon"),
    Screen("home", "/"),
    Screen("home-newcomer", "/", who="piotr"),
    Screen("home-member", "/", who="jonas"),
    Screen("inbox", "/inbox"),
    Screen("inbox-gone", "/inbox/00000000-0000-4000-8000-000000000000"),   # the error state of a removed item
    Screen("inbox-empty", "/inbox", who="piotr"),
    Screen("projects", "/projects"),
    Screen("conversation", "/projects/{p}"),
    Screen("conversation-hover", "/projects/{p}", steps=[("hover", ".project-convo__message >> nth=-2")], only="wide"),
    Screen("thread", "/projects/{p}/conversations/{conv}", needs=("conv",)),
    Screen("view-menu", "/projects/{p}", steps=[("click", ".phead__menu"), ("wait", "[role='dialog']")], only="phone"),
    Screen("project-more", "/projects/{p}", steps=[("click", "button[aria-label='More']")], only="wide"),
    Screen("tasks-board", "/projects/{p}/tasks?view=board"),
    Screen("tasks-list", "/projects/{p}/tasks?view=list"),
    Screen("task-panel", "/projects/{p}/tasks?view=board&open=work:{task}", needs=("task",)),
    Screen("task-blocked", "/projects/{p}/tasks?view=list&open=work:{blocked}", needs=("blocked",)),
    Screen("decision-panel", "/projects/{p}?open=decision:{decision}", needs=("decision",)),
    Screen("propose-decision", "/projects/{p}?open=propose-decision"),
    Screen("project-people", "/projects/{p}?open=people"),
    Screen("new-space", "/", steps=[("click", "button[aria-label='More']"), ("click", "[role='menuitem']:has-text('Details')"),
                                    ("click", "button.ov-row:has-text('New space')")]),
    Screen("map", "/projects/{p}/map/{sketch}", needs=("sketch",)),
    Screen("wiki-index", "/projects/{p}/docs"),
    Screen("wiki-read", "/projects/{p}/docs/{doc}", needs=("doc",)),
    Screen("wiki-with-panel", "/projects/{p}/docs/{doc}?open=work:{task}", needs=("doc", "task")),   # the Wiki narrowed by the one panel
    Screen("wiki-edit", "/projects/{p}/docs/{doc}/edit", needs=("doc",)),
    Screen("wiki-history", "/projects/{p}/docs/{doc}/history", needs=("doc",)),
    Screen("project-agents", "/projects/{p}/agents"),
    Screen("project-github", "/projects/{p}/github"),
    Screen("empty-conversation", "/projects/{pe}"),
    Screen("empty-tasks", "/projects/{pe}/tasks"),
    Screen("empty-wiki", "/projects/{pe}/docs"),
    Screen("empty-map", "/projects/{pe}/map"),
    Screen("sketchbook", "/map"),
    Screen("workspace-tasks", "/tasks"),
    Screen("workspace-docs", "/docs"),
    Screen("dm-index", "/dm"),
    Screen("dm", "/dm/{dm}", needs=("dm",)),
    Screen("dm-new", "/dm/new"),
    Screen("search", "/search?q=sensor"),
    Screen("search-none", "/search?q=zzqxv"),
    Screen("palette", "/", steps=[("press", "Control+k"), ("wait", "[role='dialog'], [role='combobox']")], only="wide"),
    Screen("create", "/", steps=[("press", "c"), ("wait", "[role='dialog']")], only="wide"),
    Screen("create-phone", "/", steps=[("click", ".phone-fab"), ("wait", "[role='dialog']")], only="phone"),
    Screen("sidebar-rail", "/", steps=[("press", "[")], only="wide"),
    Screen("new-project", "/projects/new"),
    Screen("settings", "/settings"),
    Screen("settings-appearance", "/settings/appearance"),
    Screen("settings-account", "/settings/account"),
    Screen("settings-people", "/settings/people/{ws}"),
    Screen("settings-notifications", "/settings/notifications"),
    Screen("settings-agents", "/settings/agents"),
    Screen("settings-connect", "/settings/agents/connect"),
    Screen("settings-claude-code", "/settings/agents/claude-code"),
    Screen("settings-codex", "/settings/agents/codex"),
    Screen("settings-shortcuts", "/settings/shortcuts"),
    Screen("settings-assistant", "/settings/assistant"),
    Screen("settings-assistant-how", "/settings/assistant/how"),
    Screen("settings-background", "/settings/background-compute"),
    Screen("settings-ai-connections", "/settings/ai-connections"),
    Screen("connect-agent", "/connect-agent"),
    Screen("not-found", "/no-such-page-here"),
]


# ---------------------------------------------------------------------------------------------------------------
# The in-page measurement. Returns every control's numbers and the flags for rules a-i (occlusion is separate).
# ---------------------------------------------------------------------------------------------------------------

MEASURE_JS = r"""
(cfg) => {
  const vw = innerWidth, vh = innerHeight, R = (n) => Math.round(n * 10) / 10;
  const styles = new Map();
  const S = (el) => { let s = styles.get(el); if (!s) { s = getComputedStyle(el); styles.set(el, s); } return s; };
  const coarse = matchMedia('(pointer: coarse)').matches;
  const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light' || document.documentElement.dataset.theme === 'dark';
  // Tokens, resolved in this page (text size, breakpoint and pointer included).
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;left:-9999px;top:0';
  document.body.appendChild(probe);
  const tok = (name, prop) => { probe.style[prop] = `var(${name})`; const v = parseFloat(getComputedStyle(probe)[prop]); probe.style[prop] = ''; return v; };
  const fsNames = ['--fs-glyph','--fs-xs','--fs-sm','--fs-md','--fs-base','--fs-read','--fs-lg','--fs-title','--fs-xl','--fs-2xl','--fs-page','--fs-doc-title','--fs-logo','--fs-logo-lg','--fs-input-touch'];
  const fsAllowed = fsNames.map((n) => tok(n, 'fontSize')).filter((v) => v > 0);
  const ctl = tok('--ctl', 'height') || 32, ctlLg = tok('--ctl-lg', 'height') || 44, rBtn = tok('--r-btn', 'width') || 10, rField = tok('--r', 'width') || 14;
  probe.remove();

  // Colour: any CSS colour to sRGB through a 1x1 canvas.
  const cv = document.createElement('canvas'); cv.width = cv.height = 1; const cx = cv.getContext('2d', { willReadFrequently: true });
  const cache = new Map();
  const color = (c) => {
    if (!c || c === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    if (cache.has(c)) return cache.get(c);
    let out;
    const m = c.match(/^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
    if (m) { let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]); out = { r: +m[1], g: +m[2], b: +m[3], a }; }
    else { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; out = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 }; }
    cache.set(c, out); return out;
  };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const canvasBg = () => { const c = color(S(document.documentElement).backgroundColor); if (c.a > 0.5) return { ...c, a: 1 }; const b = color(S(document.body).backgroundColor); return b.a > 0.5 ? { ...b, a: 1 } : (dark ? { r: 0, g: 0, b: 0, a: 1 } : { r: 255, g: 255, b: 255, a: 1 }); };
  const base = canvasBg();
  // The colour behind an element: its own and its ancestors' backgrounds composed; null over a photo.
  const behind = (el, includeSelf = true) => {
    const layers = []; let e = includeSelf ? el : el.parentElement;
    while (e && e.nodeType === 1) {
      const s = S(e);
      if (s.backgroundImage && s.backgroundImage !== 'none') {
        if (s.backgroundImage.includes('url(')) return null;
        const stops = [...s.backgroundImage.matchAll(/(rgba?\([^)]+\)|#[0-9a-f]{3,8}\b)/gi)].map((m) => color(m[0]));
        if (stops.length) { const n = stops.length; const avg = stops.reduce((acc, c) => ({ r: acc.r + c.r / n, g: acc.g + c.g / n, b: acc.b + c.b / n, a: acc.a + c.a / n }), { r: 0, g: 0, b: 0, a: 0 }); layers.push(avg); if (avg.a >= 0.99) break; }
      }
      const c = color(s.backgroundColor);
      if (c.a > 0.01) { layers.push(c); if (c.a >= 0.99) break; }
      if (e.tagName === 'IMG' || e.tagName === 'VIDEO' || e.tagName === 'CANVAS') return null;
      e = e.parentElement;
    }
    let out = base;
    for (let i = layers.length - 1; i >= 0; i--) out = over(layers[i], out);
    return out;
  };
  const opacityOf = (el) => { let o = 1, e = el; while (e && e.nodeType === 1) { o *= parseFloat(S(e).opacity); e = e.parentElement; } return o; };

  const visible = (el, r = el.getBoundingClientRect()) => {
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) return false;
    const s = S(el);
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    if (s.position === 'absolute' && (s.clip && s.clip !== 'auto' || /inset\(50%/.test(s.clipPath))) return false;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    return true;
  };
  const part = (e) => { const cls = [...e.classList].filter((c) => !/^(is-|has-)/.test(c) && !/^(css|sc)-/.test(c)).slice(0, 3); return e.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : ''); };
  const sig = (el) => { const parts = [part(el)]; let p = el.parentElement, n = 0; while (p && n < 2 && p !== document.body) { if (p.classList.length) { parts.unshift(part(p)); n++; } p = p.parentElement; } return parts.join(' '); };
  const label = (el) => ((el.getAttribute && (el.getAttribute('aria-label') || '')) || (el.innerText || el.value || el.placeholder || el.title || '')).trim().replace(/\s+/g, ' ').slice(0, 48);
  let nextId = 1;
  const tag = (el) => { if (!el.dataset.vca) el.dataset.vca = String(nextId++); return el.dataset.vca; };
  const flags = [];
  const flag = (rule, prio, el, detail, measure = {}, rect = null) => {
    const r = rect || (el ? el.getBoundingClientRect() : null);
    flags.push({ rule, prio, detail, measure, sig: el ? sig(el) : '', label: el ? label(el) : '', id: el ? tag(el) : null,
                 rect: r ? { x: R(r.x), y: R(r.y), w: R(r.width), h: R(r.height) } : null });
  };
  document.querySelectorAll('[data-vca]').forEach((e) => e.removeAttribute('data-vca'));

  // The top layer: when a modal is open, only it is measured.
  const modal = [...document.querySelectorAll('[aria-modal="true"], dialog[open], [role="dialog"]')].filter((d) => visible(d)).pop() || null;
  const inScope = (el) => !modal || modal.contains(el);
  const onTop = (el, r) => {
    const x = Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), y = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === el || el.contains(hit) || hit.contains(el) || (el.labels && [...el.labels].some((l) => l.contains(hit))));
  };

  // ---- Controls -------------------------------------------------------------------------------------------
  const CONTROL = 'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="switch"], [role="checkbox"], [role="radio"], [role="link"], input:not([type="hidden"]), select, textarea, summary, [contenteditable="true"], [contenteditable=""]';
  const CHIP = '.ui-pill, [class*="chip"], [class*="pill"], [class*="tag"]:not(svg *)';
  const controls = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(CONTROL + ',' + CHIP)) {
    if (seen.has(el)) continue;
    const r = el.getBoundingClientRect();
    if (!visible(el, r) || !inScope(el)) continue;
    const isControl = el.matches(CONTROL);
    const outer = el.parentElement && el.parentElement.closest(CONTROL);
    if (outer && !el.matches('input, select, textarea')) continue;   // a part of a larger control
    if (!isControl && outer) continue;
    seen.add(el);
    const s = S(el);
    const tagName = el.tagName.toLowerCase(), type = (el.getAttribute('type') || '').toLowerCase(), role = el.getAttribute('role') || '';
    const text = (el.innerText || '').trim();
    const svg = el.querySelector('svg');
    let kind;
    if (!isControl) kind = 'chip';
    else if (tagName === 'input' && ['checkbox', 'radio', 'range', 'color', 'file'].includes(type) || ['switch', 'checkbox', 'radio'].includes(role)) kind = 'toggle';
    else if (['input', 'select', 'textarea'].includes(tagName) || el.isContentEditable) kind = 'field';
    else if (role === 'tab') kind = 'tab';
    else if (['menuitem', 'menuitemradio', 'menuitemcheckbox', 'option'].includes(role)) kind = 'item';
    else if (!text && svg) kind = 'icon';
    else if (tagName === 'a' && !/ui-btn|btn|button/.test(el.className) && (s.display === 'inline' || el.closest('p, li > p, td, blockquote, .prose, [class*="prose"], [class*="msg__text"], [class*="text"]'))) kind = 'link';
    else if (r.height > 80 || r.width > 520 && r.height > 48) kind = 'card';     // a whole row or card that is clickable
    else if (!/\bui-(icon-)?btn\b/.test(el.className) && /card|row|item|tile|attach|ref|page|side__|crumb|result|thread|nyc__open|title|head/.test(el.className + ' ' + (el.parentElement ? el.parentElement.className : ''))) kind = 'row';
    else if (el.closest('h1, h2, h3, h4, h5, h6')) kind = 'title';
    else if (/\btab\b|tabs__tab|seg/.test(el.className)) kind = 'tab';
    else kind = 'button';
    const bg = color(s.backgroundColor);
    const border = ['Top', 'Right', 'Bottom', 'Left'].some((side) => parseFloat(s[`border${side}Width`]) > 0 && s[`border${side}Style`] !== 'none' && color(s[`border${side}Color`]).a > 0.04);
    const boxed = bg.a > 0.04 || (s.backgroundImage !== 'none' && !s.backgroundImage.includes('url(')) || border || (s.boxShadow !== 'none' && /inset/.test(s.boxShadow));
    const back = behind(el, false);
    const fill = bg.a > 0.04 && back ? over(bg, back) : null;
    const heavy = !!(fill && back && bg.a >= 0.5 && ratio(fill, back) >= 3);
    const chosen = ['true', 'page', 'step', 'location', 'date'].includes(el.getAttribute('aria-selected')) || el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-current') === 'page' || el.getAttribute('aria-current') === 'true' || /(^|\s)(active|is-active|is-current|is-selected|selected|current)(\s|$)/.test(el.className);
    // Text baseline: the bottom of the text's own line box minus its descent (Geist about 0.2 em).
    let base = null;
    const tn = [...el.querySelectorAll('*'), el].map((e) => [...e.childNodes].find((n) => n.nodeType === 3 && /\S/.test(n.textContent))).find(Boolean);
    if (tn) { const rg = document.createRange(); rg.selectNodeContents(tn); const tr = rg.getClientRects()[0]; if (tr) base = R(tr.bottom - parseFloat(S(tn.parentElement).fontSize) * 0.2); }
    let icon = null;
    if (svg) {
      const sr = svg.getBoundingClientRect();
      const shape = svg.querySelector('path, line, circle, rect, polyline, polygon, ellipse');
      const vb = svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width ? svg.viewBox.baseVal.width : sr.width;
      const sw = shape ? parseFloat(getComputedStyle(shape).strokeWidth) || 0 : 0;
      const stroked = shape && getComputedStyle(shape).stroke !== 'none';
      icon = { w: R(sr.width), h: R(sr.height), stroke: stroked ? R(sw * sr.width / vb) : 0, color: getComputedStyle(svg).color };
    }
    const radius = parseFloat(s.borderTopLeftRadius) || 0;
    let capsule = null;
    for (let e = el.parentElement, n = 0; kind !== 'field' && e && n < 3 && e !== document.body; e = e.parentElement, n++) {
      const es = S(e), eb = color(es.backgroundColor), er = e.getBoundingClientRect();
      if (eb.a < 0.04 || (parseFloat(es.borderTopLeftRadius) || 0) < 8 || er.height > r.height + 22) continue;
      const pb = behind(e, false); if (pb && ratio(over(eb, pb), pb) > 1.04) { capsule = er; break; }
    }
    controls.push({ capsule, el, r, s, kind, text: text.slice(0, 40), boxed, heavy, chosen, base, icon, radius, top: onTop(el, r),
      fixedRoot: (() => { let e = el; while (e && e !== document.body) { const p = S(e).position; if (p === 'fixed') return e; e = e.parentElement; } return null; })() });
  }

  // Regions for "one primary": the modal, a fixed layer (the phone "+", a bottom bar), a side panel, the navigation, the page.
  const regionOf = (c) => {
    const el = c.el;
    const d = el.closest('[aria-modal="true"], dialog, [role="dialog"], [role="menu"], [role="listbox"]'); if (d) return { key: 'dialog', el: d };
    if (c.fixedRoot) return { key: 'fixed:' + part(c.fixedRoot), el: c.fixedRoot };
    const p = el.closest('aside, [class*="panel"], [class*="sheet"], [class*="details"]'); if (p && p !== document.body) return { key: 'panel:' + part(p), el: p };
    const n = el.closest('nav, [class*="sidebar"], .side, [class^="side"]'); if (n) return { key: 'nav', el: n };
    return { key: 'page', el: document.body };
  };

  const out = [];
  const regions = {};
  const iconSizes = {};
  for (const c of controls) {
    const { el, r, s, kind } = c;
    const fs = parseFloat(s.fontSize), fw = parseInt(s.fontWeight, 10);
    out.push({ kind, sig: sig(el), label: label(el), x: R(r.x), y: R(r.y), w: R(r.width), h: R(r.height), fs, fw, radius: c.radius,
      bg: s.backgroundColor, img: s.backgroundImage === 'none' ? '' : s.backgroundImage.slice(0, 60), shadow: s.boxShadow === 'none' ? '' : s.boxShadow.slice(0, 80),
      boxed: c.boxed, heavy: c.heavy, chosen: c.chosen, top: c.top, icon: c.icon });
    if (!c.top) continue;
    // (b) control height
    const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
    if (kind === 'button' && c.boxed) {
      const h = R(r.height);
      const inForm = !!el.closest('form, [class*="auth"], [class*="sign"]');
      if (Math.abs(h - ctl) > 0.6 && !(Math.abs(h - ctlLg) < 0.6 && (inForm || coarse))) {
        const big = Math.abs(h - ctl) >= 8;
        flag('b', c.boxed && big ? 'P2' : 'P3', el, `button ${h}px tall, expected ${ctl}px (--ctl)` + (Math.abs(h - ctlLg) < 0.6 ? ' (form size --ctl-lg outside a form)' : '') + (c.boxed ? '' : ' (text button: the box shows on hover)'), { h, w: R(r.width), expected: ctl, boxed: c.boxed, heavy: c.heavy });
      }
    }
    if (kind === 'icon') {
      const key = `${R(r.width)}x${R(r.height)}`;
      const reg = regionOf(c).key;
      (iconSizes[reg] = iconSizes[reg] || {})[key] = (iconSizes[reg][key] || 0) + 1;
      if (!coarse && (Math.abs(r.height - ctl) > 0.6 || Math.abs(r.width - ctl) > 0.6)) flag('b', 'P3', el, `icon button ${key}, expected ${ctl}x${ctl}`, { w: R(r.width), h: R(r.height), expected: ctl });
    }
    if (coarse && ['button', 'icon', 'tab', 'item', 'toggle', 'chip'].includes(kind) && kind !== 'chip' && (r.height < 43.5 || r.width < 43.5) && !disabled) {
      // A pseudo-element may extend the hit area; record the smallest side for review.
      const ext = ['::before', '::after'].some((p) => { const ps = getComputedStyle(el, p); return ps.content !== 'none' && ps.position === 'absolute' && (parseFloat(ps.top) < 0 || parseFloat(ps.left) < 0 || ps.inset && ps.inset.includes('-')); });
      if (!ext) flag('b', 'P3', el, `touch target ${R(r.width)}x${R(r.height)} under 44px`, { w: R(r.width), h: R(r.height) });
    }
    // (e) radius
    if (kind === 'button' && c.boxed && Math.abs(c.radius - rBtn) > 0.6 && c.radius < r.height / 2 - 0.5) flag('e', c.heavy ? 'P2' : 'P3', el, `button radius ${c.radius}px, expected ${rBtn}px (--r-btn)`, { radius: c.radius });
    if (kind === 'button' && c.boxed && !c.chosen && c.radius >= r.height / 2 - 0.5 && r.height > 0) flag('e', c.heavy ? 'P2' : 'P3', el, `button is a pill (radius ${c.radius}px on ${R(r.height)}px), buttons take --r-btn ${rBtn}px`, { radius: c.radius, h: R(r.height) });
    if (kind === 'chip' && c.boxed && c.radius < r.height / 2 - 1) flag('e', 'P3', el, `chip radius ${c.radius}px on ${R(r.height)}px, chips are round`, { radius: c.radius });
    if (kind === 'field' && c.boxed && ![rField, 22, rBtn].some((v) => Math.abs(c.radius - v) < 0.6) && c.radius < r.height / 2 - 1) flag('e', 'P3', el, `field radius ${c.radius}px, fields take --r ${rField}px`, { radius: c.radius });
    // (c) inverted buttons per region
    if (c.heavy && !c.chosen && ['button', 'icon'].includes(kind)) {
      const reg = regionOf(c); (regions[reg.key] = regions[reg.key] || []).push(c);
    }
    // gradients and shadows are retired on buttons
    if (['button', 'icon'].includes(kind) && (s.backgroundImage.includes('gradient') || (s.boxShadow !== 'none' && !/inset/.test(s.boxShadow) && !el.matches(':focus-visible'))))
      flag('e', 'P3', el, `button has ${s.backgroundImage.includes('gradient') ? 'a gradient' : 'a drop shadow'} (retired on buttons)`, { img: s.backgroundImage.slice(0, 60), shadow: s.boxShadow.slice(0, 80) });
  }
  for (const [key, list] of Object.entries(regions)) {
    if (list.length > 1) for (const c of list.slice(1)) flag('c', 'P2', c.el, `${list.length} inverted buttons in one region (${key}): ${list.map((x) => '"' + (label(x.el) || x.kind) + '"').join(', ')}`, { count: list.length, region: key });
  }
  for (const [reg, sizes] of Object.entries(iconSizes)) {
    if (Object.keys(sizes).length > 1) flag('b', 'P3', null, `icon buttons of ${Object.keys(sizes).length} sizes in ${reg}: ${Object.entries(sizes).map(([k, n]) => `${k} x${n}`).join(', ')}`, { sizes, region: reg });
  }

  // ---- (a) rows and (h) icons in a row: controls on one line, near each other, under one parent ---------------
  const rowable = controls.filter((c) => c.top && ['button', 'icon', 'field', 'tab', 'chip', 'toggle', 'title'].includes(c.kind) && c.r.top >= 0 && c.r.bottom <= vh);
  const anc = (el) => { const a = []; let e = el; while (e) { a.push(e); e = e.parentElement; } return a; };
  const ancs = rowable.map((c) => anc(c.el));
  const parent = rowable.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < rowable.length; i++) for (let j = i + 1; j < rowable.length; j++) {
    const a = rowable[i].r, b = rowable[j].r;
    const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (overlap < 0.5 * Math.min(a.height, b.height)) continue;
    const gap = Math.max(a.left, b.left) - Math.min(a.right, b.right);
    if (gap > 24 || gap < -2) continue;
    const setB = new Set(ancs[j]); const lca = ancs[i].findIndex((e) => setB.has(e));
    if (lca < 0 || lca > 4 || ancs[j].indexOf(ancs[i][lca]) > 4) continue;
    parent[find(i)] = find(j);
  }
  const groups = {};
  rowable.forEach((c, i) => { (groups[find(i)] = groups[find(i)] || []).push(c); });
  for (const g of Object.values(groups)) {
    if (g.length < 2) continue;
    const sized = g.filter((c) => c.kind !== 'toggle' && c.kind !== 'chip' && c.kind !== 'title' && !c.el.matches('textarea, [contenteditable="true"], [contenteditable=""]'));
    const box = (c) => c.capsule || c.r;
    const hs = sized.map((c) => R(box(c).height));
    if (hs.length >= 2) {
      const hi = Math.max(...hs), lo = Math.min(...hs);
      if (hi - lo > 1.5) {
        const tallest = sized[hs.indexOf(hi)];
        const p = hi - lo >= 6 && (tallest.boxed || tallest.kind === 'icon' || tallest.kind === 'field') ? 'P2' : 'P3';
        flag('a', p, tallest.el, `controls in one row differ in height: ${sized.map((c) => `${label(c.el) || c.kind} ${R(box(c).height)}${c.capsule ? ' (its track)' : ''}`).join(' | ')}`, { heights: hs, members: sized.map((c) => sig(c.el)) },
             { x: Math.min(...g.map((c) => c.r.left)), y: Math.min(...g.map((c) => c.r.top)), width: Math.max(...g.map((c) => c.r.right)) - Math.min(...g.map((c) => c.r.left)), height: Math.max(...g.map((c) => c.r.bottom)) - Math.min(...g.map((c) => c.r.top)) });
      }
      const centres = sized.map((c) => box(c).top + box(c).height / 2); const mid = centres.slice().sort((x, y) => x - y)[Math.floor(centres.length / 2)];
      const off = centres.map((v) => R(v - mid)); const worst = off.reduce((m, v) => Math.abs(v) > Math.abs(m) ? v : m, 0);
      if (Math.abs(worst) > 2) flag('a', Math.abs(worst) > 5 ? 'P2' : 'P3', sized[off.indexOf(worst)].el, `control off the row's centre by ${worst}px`, { offsets: off });
    }
    const bases = g.filter((c) => c.base !== null && c.kind !== 'field');
    if (bases.length >= 2) {
      const bs = bases.map((c) => c.base); const spread = R(Math.max(...bs) - Math.min(...bs));
      const sameH = new Set(bases.map((c) => R(c.r.height))).size === 1;
      if (spread > 2.5) flag('a', 'P3', bases[0].el, `text baselines in one row differ by ${spread}px` + (sameH ? '' : ' (different heights)'), { baselines: bs });
    }
    const icons = g.filter((c) => c.icon && c.icon.w > 0);
    if (icons.length >= 2) {
      const sizes = [...new Set(icons.map((c) => `${Math.round(c.icon.w)}x${Math.round(c.icon.h)}`))];
      const strokes = icons.map((c) => c.icon.stroke).filter((v) => v > 0);
      const spread = strokes.length ? R(Math.max(...strokes) - Math.min(...strokes)) : 0;
      if (sizes.length > 1) flag('h', 'P3', icons[0].el, `icons of ${sizes.length} sizes in one row: ${icons.map((c) => `${label(c.el) || 'icon'} ${Math.round(c.icon.w)}`).join(' | ')}`, { sizes });
      if (spread > 0.3) flag('h', 'P3', icons[0].el, `icon strokes differ by ${spread}px in one row: ${icons.map((c) => `${label(c.el) || 'icon'} ${c.icon.stroke}`).join(' | ')}`, { strokes });
    }
  }

  // ---- Text: (d) type tokens, (f) truncation and clipping, (i) contrast ------------------------------------
  const textEls = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!/\S/.test(n.textContent)) continue;
    const p = n.parentElement; if (!p || textEls.has(p) || p.closest('script, style, noscript, svg, [aria-hidden="true"] [aria-hidden="true"]')) continue;
    textEls.add(p);
  }
  const typeSeen = new Set();
  for (const el of textEls) {
    const r = el.getBoundingClientRect();
    if (!visible(el, r) || !inScope(el)) continue;
    const s = S(el); const fs = parseFloat(s.fontSize), fw = parseInt(s.fontWeight, 10);
    const fam = s.fontFamily.split(',')[0].replace(/["']/g, '').trim();
    const key = `${sig(el)}|${fs}|${fw}|${fam}`;
    if (!typeSeen.has(key)) {
      typeSeen.add(key);
      if (!fsAllowed.some((v) => Math.abs(v - fs) < 0.15)) flag('d', 'P3', el, `font-size ${R(fs)}px is not a --fs token (${[...new Set(fsAllowed.map(R))].sort((a, b) => a - b).join('/')})`, { fs: R(fs) });
      if (![400, 500, 600].includes(fw)) flag('d', fw >= 700 ? 'P3' : 'P3', el, `font-weight ${fw} (tokens: 400/500/600)`, { fw });
      if (!/^Geist/.test(fam)) flag('d', 'P3', el, `font-family "${fam}" (Geist or Geist Mono)`, { fam });
    }
    // (f) clipped or truncated text on the element or the box that clips it
    const clipX = /hidden|clip/.test(s.overflowX), clipY = /hidden|clip/.test(s.overflowY);
    if (el.clientWidth > 0 && clipX && el.scrollWidth > el.clientWidth + 1) {
      const ell = s.textOverflow === 'ellipsis';
      const isCtl = !!el.closest(CONTROL);
      flag('f', ell ? 'P3' : (isCtl ? 'P2' : 'P3'), el, `${ell ? 'truncated with an ellipsis' : 'text cut without an ellipsis'}: shows ${el.clientWidth}px of ${el.scrollWidth}px` + (isCtl ? ' (in a control)' : ''), { client: el.clientWidth, scroll: el.scrollWidth, text: (el.textContent || '').trim().slice(0, 80) });
    }
    if (el.clientHeight > 0 && clipY && el.scrollHeight > el.clientHeight + 2) {
      const clamp = s.webkitLineClamp && s.webkitLineClamp !== 'none';
      flag('f', clamp ? 'P3' : (el.closest(CONTROL) ? 'P2' : 'P3'), el, `${clamp ? 'clamped to ' + s.webkitLineClamp + ' lines' : 'text cut vertically'}: shows ${el.clientHeight}px of ${el.scrollHeight}px`, { client: el.clientHeight, scroll: el.scrollHeight, text: (el.textContent || '').trim().slice(0, 80) });
    }
    // (i) contrast against what is actually behind the text
    if (color(s.color).a === 0 || s.webkitTextFillColor === 'transparent') continue;
    const bgc = behind(el); if (!bgc) continue;
    const op = opacityOf(el); const tc = color(s.color);
    const eff = over({ ...tc, a: tc.a * op }, bgc);
    const cr = ratio(eff, bgc);
    const large = fs >= 24 || (fs >= 18.66 && fw >= 700);
    const need = large ? 3 : 4.5;
    if (cr < need - 0.05) {
      const disabled = !!el.closest(':disabled, [aria-disabled="true"]');
      const glyph = /^[\s·•|—–\-/]+$/.test(el.textContent || '');
      flag('i', disabled || glyph ? 'P3' : (cr < 3 ? 'P2' : 'P3'), el, `contrast ${R(cr)}:1 (needs ${need}:1) ${hex(eff)} on ${hex(bgc)}` + (op < 1 ? ` at opacity ${R(op)}` : '') + (disabled ? ' (disabled: exempt, review)' : ''), { ratio: R(cr), fg: hex(eff), bg: hex(bgc), fs: R(fs) });
    }
  }
  // Placeholders and icons
  for (const c of controls) {
    if (!c.top) continue;
    if (c.kind === 'field' && c.el.placeholder && !c.el.value) {
      const ps = getComputedStyle(c.el, '::placeholder'); const bgc = behind(c.el);
      if (bgc && ps && ps.color) { const pc = over(color(ps.color), bgc); const cr = ratio(pc, bgc); if (cr < 4.45) flag('i', 'P3', c.el, `placeholder contrast ${R(cr)}:1 ${hex(pc)} on ${hex(bgc)}`, { ratio: R(cr) }); }
    }
    if (c.icon && c.kind === 'icon' && !(c.el.disabled || c.el.getAttribute('aria-disabled') === 'true')) {
      const bgc = behind(c.el); if (!bgc) continue;
      const ic = over({ ...color(c.icon.color), a: color(c.icon.color).a * opacityOf(c.el) }, bgc); const cr = ratio(ic, bgc);
      if (cr < 2.95) flag('i', cr < 2 ? 'P2' : 'P3', c.el, `icon contrast ${R(cr)}:1 (needs 3:1) ${hex(ic)} on ${hex(bgc)}`, { ratio: R(cr) });
    }
  }

  // ---- (f) controls cut by a container or the window; horizontal page overflow ------------------------------
  const se = document.scrollingElement;
  if (se.scrollWidth > vw + 1) {
    const wide = [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.right > vw + 1 && r.width > 0 && visible(e, r); })
      .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right).slice(0, 3);
    flag('f', 'P2', wide[0] || document.body, `the page scrolls sideways: ${se.scrollWidth}px wide in a ${vw}px window` + (wide.length ? `; widest: ${wide.map(sig).join(' ; ')}` : ''), { scrollWidth: se.scrollWidth, vw });
  }
  for (const c of controls) {
    if (!['button', 'icon', 'field', 'tab', 'chip', 'item', 'toggle', 'link'].includes(c.kind)) continue;
    const r = c.r;
    const sideways = (() => { for (let e = c.el.parentElement; e && e !== document.body; e = e.parentElement) { const ox = S(e).overflowX; if (/auto|scroll/.test(ox) && e.scrollWidth > e.clientWidth + 1) return e; } return null; })();
    if (r.right > vw + 1 || r.left < -1) { flag('f', sideways ? 'P3' : 'P2', c.el, `control runs out of the window: ${R(r.left)}..${R(r.right)} of ${vw}px` + (sideways ? ` (in a sideways-scrolling ${part(sideways)})` : ''), { left: R(r.left), right: R(r.right) }); continue; }
    let e = c.el.parentElement;
    while (e && e !== document.body) {
      const s = S(e);
      const ox = s.overflowX, oy = s.overflowY;
      if (ox !== 'visible' || oy !== 'visible') {
        const b = e.getBoundingClientRect();
        const inner = { left: b.left + e.clientLeft, top: b.top + e.clientTop, right: b.left + e.clientLeft + e.clientWidth, bottom: b.top + e.clientTop + e.clientHeight };
        const scrollX = /auto|scroll/.test(ox) && e.scrollWidth > e.clientWidth + 1, scrollY = /auto|scroll/.test(oy) && e.scrollHeight > e.clientHeight + 1;
        const cutX = !scrollX && (r.left < inner.left - 1 || r.right > inner.right + 1) && ox !== 'visible';
        const cutY = !scrollY && (r.top < inner.top - 1 || r.bottom > inner.bottom + 1) && oy !== 'visible';
        const outside = r.left < inner.left - 1 || r.right > inner.right + 1 || r.top < inner.top - 1 || r.bottom > inner.bottom + 1;
        if (outside && !cutX && !cutY) break;
        if ((cutX || cutY) && r.width > 0 && inner.right > inner.left && inner.bottom > inner.top) {
          const visW = Math.max(0, Math.min(r.right, inner.right) - Math.max(r.left, inner.left)), visH = Math.max(0, Math.min(r.bottom, inner.bottom) - Math.max(r.top, inner.top));
          const shown = R(100 * visW * visH / (r.width * r.height));
          if (shown > 0 && shown < 97) flag('f', 'P2', c.el, `control cut by its container (${part(e)}, overflow ${ox}/${oy}): ${shown}% shown`, { shown, container: sig(e) });
          break;
        }
      }
      e = e.parentElement;
    }
  }

  const cardCache = new Map();
  const cardOf = (el) => {
    if (cardCache.has(el)) return cardCache.get(el);
    let found = null;
    for (let e = el.parentElement, n = 0; e && n < 10 && e !== document.body; e = e.parentElement, n++) {
      const es = S(e), er = e.getBoundingClientRect();
      if ((parseFloat(es.borderTopLeftRadius) || 0) < 6 || er.width >= vw - 2) continue;
      const eb = color(es.backgroundColor);
      const pb = behind(e, false);
      const filled = eb.a > 0.04 && pb && ratio(over(eb, pb), pb) > 1.03;
      const edged = (es.boxShadow !== 'none') || ['Top', 'Left'].some((side) => parseFloat(es[`border${side}Width`]) > 0 && es[`border${side}Style`] !== 'none' && color(es[`border${side}Color`]).a > 0.04);
      if (filled || edged) { found = e; break; }
    }
    cardCache.set(el, found);
    return found;
  };
  const between = (el, top) => { for (let e = el.parentElement; e && e !== top; e = e.parentElement) { if (/auto|scroll/.test(S(e).overflowX) && e.scrollWidth > e.clientWidth + 1) return true; } return false; };
  const spilled = new Set();
  const spill = (el, what) => {
    const card = cardOf(el); if (!card) return;
    const r = el.getBoundingClientRect(), b = card.getBoundingClientRect();
    const past = R(Math.max(r.right - b.right, b.left - r.left));
    if (past <= 1 || between(el, card)) return;
    if ([...spilled].some((x) => x.contains(el))) return;
    spilled.add(el);
    flag('f', 'P2', el, `${what} runs ${past}px past the edge of its ${part(card)} (cut or overflowing)`, { past, card: sig(card) });
  };
  for (const c of controls) if (c.top !== undefined && !['card', 'row'].includes(c.kind)) spill(c.el, c.kind === 'field' ? 'field' : 'control');
  for (const el of textEls) { const r = el.getBoundingClientRect(); if (visible(el, r) && inScope(el) && S(el).display !== 'inline') spill(el, 'text'); }

  // ---- (g) uneven gaps between siblings of one kind ------------------------------------------------------
  const sigOf = (e) => e.tagName + '.' + [...e.classList].filter((c) => !/^(is-|has-)|active|selected|current|open|unread|new|own|mine|first|last|pending|done|lead|compact|hover|focus/.test(c)).sort().join('.');
  const gapSeen = new Set();
  for (const box of document.querySelectorAll('body *')) {
    if (box.children.length < 3 || !inScope(box)) continue;
    const kids = [...box.children].map((k) => ({ k, r: k.getBoundingClientRect() })).filter(({ k, r }) => r.height >= 12 && r.width >= 12 && !/absolute|fixed/.test(S(k).position) && visible(k, r));
    if (kids.length < 3) continue;
    for (const axis of ['y', 'x']) {
      let run = [kids[0]];
      const flush = () => {
        if (run.length >= 3) {
          const gaps = [];
          for (let i = 1; i < run.length; i++) gaps.push(R(axis === 'y' ? run[i].r.top - run[i - 1].r.bottom : run[i].r.left - run[i - 1].r.right));
          const ok = gaps.every((g) => g > -1);
          const lo = Math.min(...gaps), hi = Math.max(...gaps);
          const key = sig(box) + axis;
          if (ok && hi - lo > 2.5 && !gapSeen.has(key)) {
            gapSeen.add(key);
            flag('g', hi - lo >= 8 ? 'P3' : 'P3', box, `uneven ${axis === 'y' ? 'vertical' : 'horizontal'} gaps between ${run.length} ${part(run[0].k)}: ${gaps.join(', ')}px`, { gaps, child: part(run[0].k) });
          }
        }
      };
      for (let i = 1; i < kids.length; i++) {
        const a = run[run.length - 1], b = kids[i];
        const sameSig = sigOf(a.k) === sigOf(b.k);
        const aligned = axis === 'y' ? (b.r.top >= a.r.bottom - 1 && Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left) > 0)
                                     : (b.r.left >= a.r.right - 1 && Math.abs(b.r.top - a.r.top) < 3);
        if (sameSig && aligned) run.push(b); else { flush(); run = [b]; }
      }
      flush();
    }
  }

  return { vw, vh, coarse, dark, ctl, ctlLg, rBtn, fsAllowed: [...new Set(fsAllowed.map(R))].sort((a, b) => a - b), modal: !!modal,
           url: location.pathname + location.search, title: document.title, controls: out, flags,
           hscroll: se.scrollWidth > vw + 1 };
}
"""

# Content left under a fixed or floating layer: the end of every scroller (bottom layers) and the start (top layers).
OCCLUSION_JS = r"""
(cfg) => {
  const vw = innerWidth, vh = innerHeight, R = (n) => Math.round(n * 10) / 10;
  const S = (el) => getComputedStyle(el);
  const modal = [...document.querySelectorAll('[aria-modal="true"], dialog[open], [role="dialog"]')].filter((d) => { const r = d.getBoundingClientRect(); return r.width > 2 && r.height > 2; }).pop() || null;
  const scrollers = [document.scrollingElement, ...[...document.querySelectorAll('body *')].filter((e) => { const s = S(e); return /auto|scroll/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 2 && e.clientHeight > 40; })];
  const isScroller = (e) => /auto|scroll/.test(S(e).overflowY) && e.scrollHeight > e.clientHeight + 2;
  const scrollerOf = (el) => { let e = el.parentElement; while (e && e !== document.body) { if (isScroller(e)) return e; e = e.parentElement; } return document.scrollingElement; };
  let current = null;
  const layerOf = (el) => { let e = el; while (e && e !== document.documentElement) { const p = S(e).position; if (p === 'fixed' || p === 'sticky') return e; if (p === 'absolute' && current && !current.contains(e) && current !== document.scrollingElement) return e; e = e.parentElement; } return null; };
  const part = (e) => { const cls = [...e.classList].filter((c) => !/^(is-|has-)/.test(c)).slice(0, 3); return e.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : ''); };
  const sig = (el) => { const parts = [part(el)]; let p = el.parentElement, n = 0; while (p && n < 2 && p !== document.body) { if (p.classList.length) { parts.unshift(part(p)); n++; } p = p.parentElement; } return parts.join(' '); };
  const label = (el) => ((el.getAttribute('aria-label') || '') || (el.innerText || el.value || el.placeholder || '')).trim().replace(/\s+/g, ' ').slice(0, 48);
  const transient = (layer) => layer.matches('[role="status"], [role="alert"], [class*="toast"], [class*="Toast"]') || !!layer.closest('[role="status"], [role="alert"], [class*="toast"]');
  const CONTROL = 'button, a[href], [role="button"], [role="tab"], input:not([type="hidden"]), select, textarea, [contenteditable="true"]';
  const check = (where) => {
    const found = [];
    const cands = new Set();
    for (const el of document.querySelectorAll(CONTROL)) cands.add(el);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (/\S/.test(n.textContent) && n.parentElement) cands.add(n.parentElement);
    for (const el of cands) {
      if (modal && !modal.contains(el)) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
      const s = S(el); if (s.visibility === 'hidden' || (el.checkVisibility && !el.checkVisibility({ opacityProperty: true }))) continue;
      current = scrollerOf(el);
      const own = layerOf(el);
      const isCtl = el.matches(CONTROL);
      const pts = isCtl ? [[0.5, 0.5], [0.12, 0.2], [0.88, 0.2], [0.12, 0.8], [0.88, 0.8]] : [[0.5, 0.5]];
      let covered = 0, by = null;
      for (const [fx, fy] of pts) {
        const x = r.left + r.width * fx, y = r.top + r.height * fy;
        if (x < 0 || y < 0 || x >= vw || y >= vh) continue;
        const hit = document.elementFromPoint(x, y);
        if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
        const layer = layerOf(hit);
        if (!layer || layer === own || layer.contains(el) || transient(layer)) continue;
        const lr = layer.getBoundingClientRect();
        // Top or bottom of the element's own scroller (a sheet's sticky header is a top layer however low the sheet sits).
        const sr = current === document.scrollingElement ? { top: 0, bottom: vh } : current.getBoundingClientRect();
        const lower = lr.top + lr.height / 2 > (Math.max(0, sr.top) + Math.min(vh, sr.bottom)) / 2;
        if ((where === 'end' && !lower) || (where === 'start' && lower)) continue;
        covered++; by = layer;
      }
      if (covered) found.push({ el, r, by, covered, of: pts.length, isCtl });
    }
    // Keep the innermost: a text inside a covered control is the same finding.
    return found.filter((f) => !found.some((g) => g !== f && f.el.contains(g.el)));
  };
  const flags = [];
  const add = (where, list) => {
    for (const f of list) {
      const r = f.r;
      f.el.dataset.vcaOcc = '1';
      flags.push({ rule: 'f', prio: f.isCtl && f.covered >= 1 ? 'P2' : (f.covered === f.of ? 'P2' : 'P3'),
        detail: `${f.isCtl ? 'control' : 'text'} stays under ${part(f.by)} (${f.by.className ? 'fixed layer' : 'layer'}) at the ${where} of its scroll: ${f.covered}/${f.of} points covered`,
        measure: { where, layer: sig(f.by), layerRect: (() => { const b = f.by.getBoundingClientRect(); return { y: R(b.top), h: R(b.height) }; })() },
        sig: sig(f.el), label: label(f.el), id: null, rect: { x: R(r.x), y: R(r.y), w: R(r.width), h: R(r.height) } });
    }
  };
  if (cfg.phase === 'start') {
    add('start', check('start'));
    for (const sc of scrollers) {
      if (sc === document.scrollingElement) continue;
      const b = sc.getBoundingClientRect(); const edge = b.top + sc.clientTop + sc.clientHeight;
      if (edge > vh - 24) continue;   // the pane reaches the window's bottom: nothing below it
      const below = [...document.elementsFromPoint(vw / 2, Math.min(vh - 2, edge + 30))].find((e) => !sc.contains(e) && e !== document.body && e !== document.documentElement && !e.contains(sc));
      for (const el of sc.querySelectorAll(CONTROL)) {
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4 || !(r.top < edge - 2 && r.bottom > edge + 2)) continue;
        if (el.closest('[aria-hidden="true"]') || (el.checkVisibility && !el.checkVisibility({ opacityProperty: true }))) continue;
        if (flags.some((f) => f.label === label(el) && f.measure.where === 'fold')) continue;
        flags.push({ rule: 'f', prio: 'P3', detail: `control cut at the fold: ${R(edge - r.top)}px of ${R(r.height)}px shown, the pane ends at y=${R(edge)} above ${below ? part(below) : 'the bottom bar'}`,
          measure: { where: 'fold', edge: R(edge), below: below ? sig(below) : '' }, sig: sig(el), label: label(el), id: null, rect: { x: R(r.x), y: R(r.y), w: R(r.width), h: R(r.height) } });
      }
    }
    return { flags };
  }
  for (const sc of scrollers) { if (sc === document.scrollingElement) window.scrollTo(0, sc.scrollHeight); else sc.scrollTop = sc.scrollHeight; }
  add('end', check('end'));
  return { flags, scrolled: scrollers.length };
}
"""

ANNOTATE_JS = r"""
(boxes) => {
  const layer = document.createElement('div');
  layer.id = 'vca-layer';
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  for (const b of boxes) {
    const d = document.createElement('div');
    const c = b.prio === 'P2' ? '#e5002b' : '#f08a00';
    d.style.cssText = `position:fixed;left:${b.x - 2}px;top:${b.y - 2}px;width:${b.w + 4}px;height:${b.h + 4}px;outline:2px solid ${c};outline-offset:0`;
    const t = document.createElement('span');
    t.textContent = b.tag;
    t.style.cssText = `position:absolute;left:-2px;top:-15px;font:600 10px/13px monospace;background:${c};color:#fff;padding:0 3px;white-space:nowrap`;
    d.appendChild(t);
    layer.appendChild(d);
  }
  document.body.appendChild(layer);
}
"""


def settle(page: Page) -> None:
    try:
        page.wait_for_load_state("load", timeout=10000)
    except Exception:
        pass
    try:
        page.evaluate("() => document.fonts.ready.then(() => true)")
        page.wait_for_function("() => !document.querySelector('.ui-spin, [aria-busy=\"true\"], .route-progress.is-active, [class*=\"skeleton\"]')", timeout=6000)
    except Exception:
        pass
    page.wait_for_timeout(450)


def run_step(page: Page, step: tuple, touch: bool) -> None:
    kind, arg = step[0], step[1]
    if kind == "click":
        target = page.locator(arg).first
        target.wait_for(state="visible", timeout=6000)
        target.tap(timeout=5000) if touch else target.click(timeout=5000)
    elif kind == "press":
        page.keyboard.press(arg)
    elif kind == "hover":
        target = page.locator(arg)
        target.wait_for(state="visible", timeout=6000)
        target.hover(timeout=5000)
    elif kind == "wait":
        page.locator(arg).first.wait_for(state="visible", timeout=6000)
    page.wait_for_timeout(350)


def shot(page: Page, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(path), animations="disabled", caret="hide")


def measure_combo(pw, engine: str, theme: str, data: dict) -> None:
    browser = getattr(pw, engine).launch()
    results = OUT / f"results-{engine}-{theme}{TAG}.jsonl"
    with results.open("w", encoding="utf-8") as sink:
        for vp in VIEWPORTS:
            spec = WINDOWS[vp]
            touch = spec["touch"]
            contexts: dict[str, BrowserContext] = {}

            def context_for(who: str) -> BrowserContext:
                if who not in contexts:
                    options = dict(base_url=ORIGIN, viewport={"width": spec["width"], "height": spec["height"]}, device_scale_factor=1,
                                   color_scheme=theme, reduced_motion="reduce", locale="en-GB", timezone_id="Europe/Warsaw",
                                   has_touch=touch, service_workers="block")
                    if engine != "firefox":
                        options["is_mobile"] = spec["mobile"]
                    if who != "anon":
                        options["storage_state"] = data["states"][who]
                    contexts[who] = browser.new_context(**options)
                return contexts[who]

            for screen in SCREENS:
                if ONLY and screen.name not in ONLY:
                    continue
                if screen.only == "phone" and not touch or screen.only == "wide" and touch:
                    continue
                if any(not data["ids"].get(n) for n in screen.needs):
                    sink.write(json.dumps({"screen": screen.name, "engine": engine, "theme": theme, "vp": vp, "skipped": "missing data"}) + "\n")
                    continue
                base = OUT / "shots" / f"{engine}-{theme}-{vp}"
                record = {"screen": screen.name, "engine": engine, "theme": theme, "vp": vp, "shot": str((base / f"{screen.name}.png").relative_to(OUT))}
                page = context_for(screen.who).new_page()
                errors: list[str] = []
                page.on("pageerror", lambda error: errors.append(str(error)[:200]))
                started = time.time()
                try:
                    page.goto(ORIGIN + screen.path.format(**data["ids"]), wait_until="domcontentloaded", timeout=20000)
                    settle(page)
                    unreachable = None
                    for step in screen.steps:
                        try:
                            run_step(page, step, touch)
                        except Exception as error:  # the state could not be opened: measure what is there, say so
                            unreachable = f"{step}: {str(error).splitlines()[0][:160]}"
                            break
                    settle(page)
                    found = page.evaluate(MEASURE_JS, {})
                    shot(page, base / f"{screen.name}.png")
                    start = page.evaluate(OCCLUSION_JS, {"phase": "start"})
                    flags = found["flags"] + start["flags"]
                    boxes = [{**f["rect"], "prio": f["prio"], "tag": f"{f['rule']} {f['prio']}"} for f in flags if f.get("rect") and f["rule"] in "abcefhi"][:60]
                    if boxes:
                        page.evaluate(ANNOTATE_JS, boxes)
                        shot(page, base / f"{screen.name}-annot.png")
                        page.evaluate("() => document.getElementById('vca-layer')?.remove()")
                        record["annot"] = str((base / f"{screen.name}-annot.png").relative_to(OUT))
                    end = page.evaluate(OCCLUSION_JS, {"phase": "end"})
                    if end["flags"]:
                        page.evaluate(ANNOTATE_JS, [{**f["rect"], "prio": f["prio"], "tag": "f under layer"} for f in end["flags"]][:40])
                        shot(page, base / f"{screen.name}-bottom.png")
                        record["bottom"] = str((base / f"{screen.name}-bottom.png").relative_to(OUT))
                    for f in end["flags"]:
                        f["shot"] = record.get("bottom")
                    flags += end["flags"]
                    found["flags"] = flags
                    record.update(found)
                    record["unreachable"] = unreachable
                    record["errors"] = errors
                except Exception as error:
                    record["failed"] = str(error).splitlines()[0][:300]
                    try:
                        shot(page, base / f"{screen.name}.png")
                    except Exception:
                        pass
                record["seconds"] = round(time.time() - started, 1)
                sink.write(json.dumps(record) + "\n")
                sink.flush()
                n2 = sum(1 for f in record.get("flags", []) if f["prio"] == "P2")
                print(f"{engine} {theme} {vp} {screen.name}: {len(record.get('flags', []))} flags ({n2} P2)"
                      + (f" UNREACHABLE {record['unreachable']}" if record.get("unreachable") else "")
                      + (f" FAILED {record['failed']}" if record.get("failed") else ""), flush=True)
                page.close()
            for c in contexts.values():
                c.close()
    browser.close()


# ---------------------------------------------------------------------------------------------------------------
# Report: deduplicate across windows, themes and engines; P2 first; contact sheets for the eye.
# ---------------------------------------------------------------------------------------------------------------

def normalise(detail: str) -> str:
    return re.sub(r"-?\d+(\.\d+)?", "#", detail)


def report(pw) -> None:
    records = []
    for path in sorted(OUT.glob("results-*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                records.append(json.loads(line))
            except ValueError:
                continue
    groups: dict[tuple, dict] = {}
    for rec in records:
        for f in rec.get("flags", []):
            key = (f["rule"], rec["screen"], f["sig"], normalise(f["detail"]))
            g = groups.setdefault(key, {"rule": f["rule"], "prio": f["prio"], "screen": rec["screen"], "sig": f["sig"], "label": f["label"],
                                        "detail": f["detail"], "measure": f["measure"], "where": [], "shot": f.get("shot") or rec.get("annot") or rec.get("shot")})
            if f["prio"] == "P2" and g["prio"] != "P2":
                g.update(prio="P2", detail=f["detail"], measure=f["measure"], shot=f.get("shot") or rec.get("annot") or rec.get("shot"))
            g["where"].append(f"{rec['engine']}/{rec['theme']}/{rec['vp']}")
    findings = sorted(groups.values(), key=lambda g: (g["prio"], g["rule"], g["screen"], g["sig"]))
    (OUT / "findings.json").write_text(json.dumps(findings, indent=1, ensure_ascii=False), encoding="utf-8")
    lines = ["# Visual consistency audit", "", f"{len(records)} screen visits, {len(findings)} distinct findings "
             f"({sum(1 for f in findings if f['prio'] == 'P2')} P2, {sum(1 for f in findings if f['prio'] == 'P3')} P3).", ""]
    failed = [r for r in records if r.get("failed") or r.get("unreachable")]
    if failed:
        lines += ["## Not measured or state not reached", ""]
        lines += [f"- {r['screen']} {r['engine']}/{r['theme']}/{r['vp']}: {r.get('failed') or r.get('unreachable')}" for r in failed]
        lines.append("")
    for f in findings:
        where = sorted(set(f["where"]))
        lines.append(f"- **{f['prio']} ({f['rule']})** {f['screen']} — {f['detail']} — `{f['sig']}`" + (f" \"{f['label']}\"" if f["label"] else "")
                     + f" — {len(where)}x: {', '.join(where[:6])}{' …' if len(where) > 6 else ''} — {f['shot']}")
    (OUT / "findings.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    # Contact sheets: every screen of one engine/theme/window on one page, scaled down.
    sheets = OUT / "sheets"
    sheets.mkdir(exist_ok=True)
    combos = sorted({(r["engine"], r["theme"], r["vp"]) for r in records})
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={"width": 1800, "height": 1000})
    for engine, theme, vp in combos:
        recs = [r for r in records if (r["engine"], r["theme"], r["vp"]) == (engine, theme, vp) and r.get("shot")]
        width = WINDOWS[vp]["width"]
        cols = 6 if width <= 430 else 3 if width <= 820 else 2
        tile = int(1760 / cols) - 12
        cells = "".join(
            f'<figure><img src="file://{OUT / (r.get("annot") or r["shot"])}" style="width:{tile}px"><figcaption>{html.escape(r["screen"])}'
            f' ({len(r.get("flags", []))})</figcaption></figure>' for r in recs)
        doc = (f"<html><body style='margin:12px;background:#888;font:12px monospace'><h3>{engine} {theme} {vp}</h3>"
               f"<div style='display:grid;grid-template-columns:repeat({cols},{tile}px);gap:12px'>{cells}</div>"
               "<style>figure{margin:0}figcaption{background:#fff;padding:2px 4px}img{display:block;border:1px solid #333}</style></body></html>")
        sheet = sheets / f"{engine}-{theme}-{vp}.html"
        sheet.write_text(doc, encoding="utf-8")
        page.goto(f"file://{sheet}")
        page.wait_for_timeout(300)
        page.screenshot(path=str(sheets / f"{engine}-{theme}-{vp}.png"), full_page=True)
    browser.close()
    print(f"report: {len(findings)} findings -> {OUT / 'findings.md'}", flush=True)


def main() -> int:
    if UPSTREAM:
        start_forwarder(ORIGIN, UPSTREAM)
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        data_file = OUT / "seed.json"
        if PHASE in ("all", "seed") or not data_file.exists():
            browser = pw.chromium.launch()
            data = seed(browser)
            browser.close()
            data_file.write_text(json.dumps(data), encoding="utf-8")
        data = json.loads(data_file.read_text(encoding="utf-8"))
        if PHASE in ("all", "measure"):
            for engine in BROWSERS:
                for theme in THEMES:
                    measure_combo(pw, engine, theme, data)
        if PHASE in ("all", "report"):
            report(pw)
    return 0


if __name__ == "__main__":
    sys.exit(main())
