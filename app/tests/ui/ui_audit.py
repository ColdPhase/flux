"""The v0.2.1 UI and UX audit (#1215, #1245): every route × state × window × theme × engine of the running application.

Not a test and not part of the default suite (the name does not match test_*.py): it captures, measures and writes a report,
and exits 0 whatever it finds. Run it with `./scripts/ui_audit.sh <out>` (Docker only). That starts the app on its own Compose
project, captures the first-run pages of the empty server, seeds the `./flux demo` data (scripts/flux-demo.mjs), then runs
this file in the pinned Playwright container. It builds on the #763 visual consistency audit (`visual_consistency_audit.py`:
its extra people and tasks, and its in-page measurement of every control) and on the documentation scene (`media_scene.py`:
the company, Ada's Assistant, Planner and Reviewer, a guest, decisions, a post from a local client), and adds the states
#1215 lists: long names, a locked encrypted space, a guest, read-only pages, invitations, schedules, not-available pages.

Phases (FLUX_UIAUDIT_PHASES, comma-separated; default all, in this order):

  firstrun  the empty server's sign-up and sign-in (run by ui_audit.sh before the demo seed);
  seed      the data, once (seed.json; a later run reuses it);
  capture   every screen at every window, light and dark, Chromium and WebKit: a screenshot, an ARIA snapshot beside it,
            the #763 measurement (alignment, control heights, touch targets under 44 px, contrast against the composited
            background, type tokens, radii, clipping, occlusion) plus sideways scroll, words ("project", "workspace",
            "Direct messages"), and editable text under 16 px on touch (focus zoom);
  states    loading (the screen's own reads held back) and error (the screen's own reads answered 503), then Try again
            with the reads back: does the page say so, and does Try again recover;
  a11y      focus order and visible focus (Tab walk), 200 % text (root font size), reduced motion (running animations and
            transitions while `reduce`), transitions of properties other than transform and opacity;
  keys      the documented shortcuts (Settings › Keyboard shortcuts) that change no data;
  journeys  interactions in the running app with what they change checked after a reload (both engines, computer and phone);
  mob       MOB-1…MOB-7 as far as emulation goes: the manifest and icons, the service worker, an offline navigation, offline
            in-app reads and a message sent offline, standalone launch, a deep link through sign-in, rotation with a
            draft, coming back after the connection dropped, the push offer (offer, blocked, Home Screen steps);
  report    matrix.md (every cell), findings.md/json (deduplicated), summary.json, contact sheets.

Environment: FLUX_UI_ORIGIN / FLUX_UI_UPSTREAM (ui-test service), FLUX_DEMO_OWNER_PASSWORD, FLUX_DEMO_PARTNER_PASSWORD,
FLUX_FIXTURE_TOKEN, FLUX_AUDIT_OUT (default /screenshots), FLUX_UIAUDIT_BROWSERS (chromium,webkit), FLUX_UIAUDIT_THEMES
(light,dark), FLUX_UIAUDIT_WINDOWS (names from WINDOWS; default all), FLUX_UIAUDIT_SCREENS (names; default all),
FLUX_UIAUDIT_PARALLEL (capture processes side by side, default 4), FLUX_UIAUDIT_STATE_WINDOWS / FLUX_UIAUDIT_A11Y_WINDOWS
(default 1440,390,820p). Emulated windows in headless engines, not devices: CSS pixels at device pixel ratio 1; touch
windows have touch, a coarse pointer and the platform's user agent (Android in Chromium, iPhone/iPad in WebKit).
"""
from __future__ import annotations

import html
import json
import os
import re
import subprocess
import sys
import time
import traceback
import urllib.parse
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from playwright.sync_api import Browser, BrowserContext, Page, sync_playwright

import visual_consistency_audit as vca
from test_app_shell import ORIGIN, UPSTREAM, start_forwarder

OUT = Path(os.environ.get("FLUX_AUDIT_OUT") or os.environ.get("FLUX_UI_SCREENSHOTS") or "/screenshots")
ALL_PHASES = ["firstrun", "seed", "capture", "states", "a11y", "keys", "journeys", "mob", "report"]
PHASES = [p for p in (os.environ.get("FLUX_UIAUDIT_PHASES") or ",".join(p for p in ALL_PHASES if p != "firstrun")).split(",") if p]
BROWSERS = [b for b in (os.environ.get("FLUX_UIAUDIT_BROWSERS") or "chromium,webkit").split(",") if b]
THEMES = [t for t in (os.environ.get("FLUX_UIAUDIT_THEMES") or "light,dark").split(",") if t]
ONLY = {s for s in (os.environ.get("FLUX_UIAUDIT_SCREENS") or "").split(",") if s}
PARALLEL = int(os.environ.get("FLUX_UIAUDIT_PARALLEL") or "12")
# The capture waits on the page far more than it computes: each engine × theme is split into this many groups of windows, run side by side.
CHUNKS = int(os.environ.get("FLUX_UIAUDIT_CHUNKS") or "4")
TAG = os.environ.get("FLUX_UIAUDIT_TAG") or ""  # a later partial run writes its own results files; the report keeps the newest record per cell
ANNOTATE = set((os.environ.get("FLUX_UIAUDIT_ANNOTATE") or "1440,390,820p,320").split(","))

# Every window of #1215 and #1245. kind: computer (mouse), tablet or phone (touch, coarse pointer).
WINDOWS = {
    "1280": dict(width=1280, height=800, kind="computer"),
    "1440": dict(width=1440, height=900, kind="computer"),
    "1920": dict(width=1920, height=1080, kind="computer"),
    "2560": dict(width=2560, height=1440, kind="computer"),
    "3440": dict(width=3440, height=1440, kind="computer"),
    "820p": dict(width=820, height=1180, kind="tablet"),     # iPad Air portrait
    "1180l": dict(width=1180, height=820, kind="tablet"),    # iPad Air landscape
    "1024s": dict(width=1024, height=768, kind="tablet"),    # tablet split view / small tablet landscape
    "800t": dict(width=800, height=1280, kind="tablet"),     # Android tablet
    "430": dict(width=430, height=932, kind="phone"),        # large iPhone
    "412": dict(width=412, height=915, kind="phone"),        # Android
    "390": dict(width=390, height=844, kind="phone"),        # standard iPhone
    "375": dict(width=375, height=667, kind="phone"),        # small iPhone (SE)
    "360": dict(width=360, height=800, kind="phone"),        # Android
    "320": dict(width=320, height=640, kind="phone"),        # smallest phone
    "844l": dict(width=844, height=390, kind="phone"),       # phone landscape
}
WINDOW_NAMES = [w for w in (os.environ.get("FLUX_UIAUDIT_WINDOWS") or ",".join(WINDOWS)).split(",") if w in WINDOWS]
STATE_WINDOWS = [w for w in (os.environ.get("FLUX_UIAUDIT_STATE_WINDOWS") or "1440,390,820p").split(",") if w in WINDOWS]
A11Y_WINDOWS = [w for w in (os.environ.get("FLUX_UIAUDIT_A11Y_WINDOWS") or "1440,390,820p").split(",") if w in WINDOWS]

# The platform a touch window stands for in each engine (Playwright's device descriptors' user agents).
UA_DEVICE = {("chromium", "phone"): "Pixel 7", ("chromium", "tablet"): "Galaxy Tab S4",
             ("webkit", "phone"): "iPhone 15", ("webkit", "tablet"): "iPad Pro 11"}

LONG_SPACE = "Community garden sensors and the long-range LoRa gateway for the far east beds behind the hawthorn hedge"
LONG_TASK = ("Replace every corroded resistive probe in the north raised beds with the capacitive ones from the second order "
             "and write the dry and wet readings into the Wiki before Saturday")
LONG_PAGE = "Sensor placement, wiring, calibration numbers and the volunteer watering rota for the 2027 growing season"
LOCKED = "Grant applications (encrypted)"
NEWCOMER_PASSWORD = vca.EXTRA_PASSWORD
ZERO = "00000000-0000-4000-8000-000000000000"
# Words the design does not use in the interface (#1215 "Words"); seeded content that uses them is skipped by SEEDED_WORDS.
WORDS = [(r"\bprojects?\b", "says “project” (the design says “space”)"), (r"\bworkspaces?\b", "says “workspace”"),
         (r"\bDirect messages\b", "says “Direct messages” (the computer says “Messages”)")]
SEEDED_WORDS = ["garden project", "Welcome to the garden project"]


# ---------------------------------------------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------------------------------------------

def call(context: BrowserContext, method: str, path: str, body: dict | None = None, ok=(200, 201), headers: dict | None = None) -> dict:
    response = context.request.fetch(f"{ORIGIN}{path}", method=method, data=json.dumps(body) if body is not None else None,
                                     headers={"origin": ORIGIN, "content-type": "application/json", "idempotency-key": str(uuid.uuid4()), **(headers or {})})
    if response.status not in ok:
        raise RuntimeError(f"{method} {path}: {response.status} {response.text()[:300]}")
    text = response.text()
    return json.loads(text) if text and text[:1] in "[{" else {}


def soft(label: str, fn, default=None):
    try:
        return fn()
    except Exception as error:  # a missing extra is recorded, never fatal
        print(f"seed note: {label}: {str(error).splitlines()[0][:240]}", flush=True)
        return default


def seed(browser: Browser) -> dict:
    import media_scene
    from media_common import COMPANY
    ada_password = vca.DEMO["ada"][2]
    admin = vca.sign_in(browser, "ada@demo.flux.test", ada_password)
    media = media_scene.build(browser, admin)
    print(f"media scene: {json.dumps({k: v for k, v in media.items() if k != 'tasks'})}", flush=True)
    # Extras on top of the scene (#763's people): Maja (a member with a long name), Piotr (a newcomer with nothing yet), an empty
    # space, a DM, a thread with replies, a mention. (visual_consistency_audit.seed predates F-037's spaces and is not used.)
    contexts = {"ada": admin, "jonas": vca.sign_in(browser, "jonas@demo.flux.test", vca.DEMO["jonas"][2])}
    for key, (name, email) in vca.EXTRA.items():
        contexts[key] = vca.sign_in(browser, email, NEWCOMER_PASSWORD, name)
    contexts["tomasz"] = vca.sign_in(browser, "tomasz@demo.flux.test", media_scene.EXTRA_PASSWORD)
    contexts["basia"] = vca.sign_in(browser, "basia@demo.flux.test", media_scene.EXTRA_PASSWORD)
    ada, jonas, maja = contexts["ada"], contexts["jonas"], contexts["maja"]
    me = {key: call(c, "GET", "/api/v1/me")["user"]["id"] for key, c in contexts.items()}
    ws = media["workspace"]
    for key in ("maja", "piotr"):
        soft(f"member {key}", lambda key=key: call(ada, "POST", f"/api/v1/workspaces/{ws}/members", {"email": vca.EXTRA[key][1], "role": "member"}, ok=(201, 409)))
    garden = media["project"]
    soft("maja in garden", lambda: call(ada, "POST", f"/api/v1/projects/{garden}/grants", {"principal": {"kind": "human", "id": me["maja"]}, "role": "contributor"}))
    projects = {p["name"]: p["id"] for p in vca.items(call(ada, "GET", f"/api/v1/workspaces/{ws}/projects"))}
    empty = soft("empty space", lambda: call(ada, "POST", f"/api/v1/workspaces/{ws}/projects", {"name": "Seed swap shelf"})["id"], "")
    ids = {"ws": ws, "p": garden, "p2": projects.get("Tool library", ""), "pe": empty, "sketch": media["sketch"], "doc": media["doc"],
           "decision": media["decision"], "me_ada": me["ada"], "task": media["tasks"].get("calibrate", ""), "blocked": media["tasks"].get("box", "")}
    if ids["p2"]:
        for title in ("Label every drawer in the tool wall", "Fix the band saw guard", "Write the borrowing rules"):
            soft("library task", lambda title=title: call(ada, "POST", f"/api/v1/projects/{ids['p2']}/work", {"title": title}))
    soft("long-name task", lambda: call(ada, "POST", f"/api/v1/projects/{garden}/work", {"title": vca.SEED_MARK + " before the volunteer weekend in May, with the spare probes from the blue box",
                                                                                         "owner": {"kind": "human", "id": me["maja"]}, "status": "in_progress"}))
    soft("mention", lambda: call(maja, "POST", f"/api/v1/projects/{garden}/conversations", {"body": "@Ada Kowalska the volunteer rota is in the Wiki now, could you read it before the weekend?",
                                                                                            "clientMessageId": str(uuid.uuid4())}))
    def dm_maja():
        dm = call(ada, "POST", f"/api/v1/workspaces/{ws}/dms", {"participantIds": [me["maja"]]})["id"]
        ids["dm_maja"] = dm
        for who, body in ((ada, "Welcome to the garden! Ask me anything."), (maja, "Thanks! Where do the spare probes live?"),
                          (ada, "In the blue box under the shed bench, next to the solder station.")):
            call(who, "POST", f"/api/v1/dms/{dm}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())})
    soft("dm maja", dm_maja)
    convs = vca.items(call(ada, "GET", f"/api/v1/projects/{garden}/conversations"))
    threaded = [c for c in convs if (c.get("replyCount") or c.get("replies") or 0)] or convs
    ids["conv"] = media["conversation"] or (threaded or [{"id": ""}])[0]["id"]
    dms = vca.items(call(ada, "GET", f"/api/v1/workspaces/{ws}/dms"))
    ids["dm"] = next((d["id"] for d in dms if any(p.get("id") == me["jonas"] for p in d.get("participants", []))), "")
    states = {}
    # Long names: a space, a task, a Wiki page and a message with a long unbroken address.
    long_space = soft("long space", lambda: call(ada, "POST", f"/api/v1/workspaces/{ws}/projects", {"name": LONG_SPACE})["id"], "")
    if long_space:
        ids["pl"] = long_space
        soft("long task", lambda: call(ada, "POST", f"/api/v1/projects/{long_space}/work", {"title": LONG_TASK, "owner": {"kind": "human", "id": me["ada"]}}))
        soft("long page", lambda: call(ada, "POST", f"/api/v1/projects/{long_space}/docs", {"title": LONG_PAGE, "body": "Short page."}))
        soft("long message", lambda: call(ada, "POST", f"/api/v1/projects/{long_space}/conversations", {
            "body": "The supplier's tracking page: https://public.test/tracking/2027/ORDER-CAPACITIVE-PROBES-6x-GATEWAY-LORA-868MHZ-ANTENNA-5DBI-SHIPPED-VIA-FERRY "
                    + "— Maja Wiśniewska-Lindqvist will collect it on Thursday.", "clientMessageId": str(uuid.uuid4())}))
    # A guest in a space (read-only places for a guest: company settings, AI not for guests).
    soft("guest in space", lambda: call(ada, "POST", f"/api/v1/projects/{ids['p']}/grants", {"principal": {"kind": "human", "id": me["tomasz"]}, "role": "contributor"}))
    # Agents: Assistant, Planner, Reviewer; a schedule on the Assistant; a message to it so its chat is not empty.
    agents = {a["name"]: a["id"] for a in soft("my agents", lambda: call(ada, "GET", "/api/v1/my-agents")["items"], [])}
    ids["assistant"] = agents.get("Assistant") or next(iter(agents.values()), "")
    ids["planner"] = agents.get("Planner", "")
    if ids["assistant"]:
        soft("schedule", lambda: call(ada, "POST", f"/api/v1/my-agents/{ids['assistant']}/schedules", {
            "title": "Monday plan", "text": "Say what the garden space has to do this week", "schedule": {"kind": "daily", "at": "08:00"}, "timeZone": "Europe/Warsaw"}))
    # A DM thread (Ada and Jonas).
    dm = ids.get("dm") or soft("dm", lambda: call(ada, "POST", f"/api/v1/workspaces/{ws}/dms", {"participantIds": [me["jonas"]]})["id"], "")
    ids["dm"] = dm
    if dm:
        def dm_thread():
            first = call(ada, "POST", f"/api/v1/dms/{dm}/messages", {"body": "Can you bring the radar board on Thursday?", "clientMessageId": str(uuid.uuid4())})["id"]
            call(jonas, "POST", f"/api/v1/dms/{dm}/messages", {"body": "Yes, and the spare cable.", "clientMessageId": str(uuid.uuid4())})
            call(jonas, "POST", f"/api/v1/dms/{dm}/threads/{first}/replies", {"body": "It needs the 5 V supply, I will pack that too.", "clientMessageId": str(uuid.uuid4())})
            return first
        ids["dmroot"] = soft("dm thread", dm_thread, "")
    # A message by its id, a material, an invitation link.
    ids["msg"] = soft("message id", lambda: call(ada, "GET", f"/api/v1/conversations/{media['conversation']}")["messages"][0]["id"], "")
    ids["material"] = soft("material", lambda: call(ada, "POST", f"/api/v1/projects/{ids['p']}/materials", {
        "title": "Probe datasheet notes", "body": "Dry 3.1 V, wet 1.4 V. Capacitive probes only.", "clientMutationId": str(uuid.uuid4())}), "")
    if isinstance(ids["material"], dict):
        made = ids["material"]
        ids["material"] = made.get("id") or made.get("materialId") or (made.get("material") or {}).get("id") or (made.get("item") or {}).get("id") or ""
    invite = soft("invite", lambda: call(ada, "POST", f"/api/v1/workspaces/{ws}/invites", {"role": "member"}), {}) or {}
    ids["invite"] = invite.get("link", "").replace(ORIGIN, "") if invite else ""
    # A locked encrypted space: Ada owns it, Jonas is a member; Ada locks it.
    token = os.environ.get("FLUX_FIXTURE_TOKEN", "")

    def locked_space():
        made = call(ada, "POST", "/api/v1/encrypted-workspaces", {"name": LOCKED, "creationId": str(uuid.uuid4()), "password": "grant applications unlock 2027"},
                    headers={"authorization": f"Bearer {token}"})
        enc = made["workspace"]["id"]
        call(ada, "POST", f"/api/v1/workspaces/{enc}/members", {"email": "jonas@demo.flux.test", "role": "member"})
        project = call(ada, "POST", f"/api/v1/workspaces/{enc}/projects", {"name": "Spring grant"})["id"]
        call(ada, "POST", f"/api/v1/projects/{project}/conversations", {"body": "The draft budget is in the Wiki.", "clientMessageId": str(uuid.uuid4())})
        call(ada, "POST", f"/api/v1/workspaces/{enc}/lock", {})
        return enc, project
    ids["enc"], ids["encp"] = soft("locked space", locked_space, ("", ""))
    # `/inbox/:id` takes an Inbox notification's id (what a notice, a push or an email links to), not a Needs-you key.
    inbox = soft("inbox", lambda: vca.items(call(ada, "GET", "/api/v1/inbox")), []) or []
    if inbox:
        ids["inbox"] = inbox[0].get("id", "")
    for key, c in contexts.items():
        states[key] = c.storage_state()
        c.close()
    print(f"seeded ids: {json.dumps(ids)}", flush=True)
    return {"ids": ids, "states": states, "me": me}


# ---------------------------------------------------------------------------------------------------------------
# Screens: the #763 list plus every route of router.tsx and every state of #1215.
# ---------------------------------------------------------------------------------------------------------------

def push_stub(answer: str) -> str:
    """The browser's permission and PushManager, stubbed as push-offer.e2e.ts does (headless Chromium reports "denied" even after a
    grant, and its push service is outside this network). The page, the API and the worker are real. Nothing where the engine has no
    PushManager (Playwright's WebKit): the iPhone/iPad lane then shows what Safari without a Home Screen app shows."""
    return """(() => {
  if (typeof PushManager === 'undefined' || typeof Notification === 'undefined') return;
  let saved = null;
  const endpoint = 'https://push.example.test/audit/' + Math.random().toString(36).slice(2);
  const keys = {p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg'};
  const proto = PushManager.prototype;
  proto.subscribe = async function (options) { saved = {endpoint, expirationTime: null, options, toJSON: () => ({endpoint, expirationTime: null, keys}), unsubscribe: async () => { saved = null; return true; }}; return saved; };
  proto.getSubscription = async function () { return saved; };
  let permission = localStorage.getItem('flux-audit-permission') || 'default';
  proto.permissionState = async function () { return permission === 'granted' ? 'granted' : permission === 'denied' ? 'denied' : 'prompt'; };
  Object.defineProperty(Notification, 'permission', {configurable: true, get: () => permission});
  Notification.requestPermission = async () => { permission = '%s'; try { localStorage.setItem('flux-audit-permission', permission); } catch (e) {} return permission; };
})();""" % answer


@dataclass
class Screen(vca.Screen):
    init: str = ""   # a script run before the page's own (an isolated context): a remembered offer, a refused permission


S = Screen
EXTRA_SCREENS = [
    # Sign-in pages and links that work without signing in.
    S("reset-password-invalid", "/reset-password?token=not-a-real-token", who="anon"),
    S("reset-password-expired", "/reset-password?error=INVALID_TOKEN", who="anon"),
    S("claim", "/claim", who="anon"),
    S("unsubscribe-invalid", "/unsubscribe?token=not-a-real-token", who="anon"),
    S("join-valid", "{invite}", who="anon", needs=("invite",)),
    S("join-valid-signed-in", "{invite}", who="piotr", needs=("invite",)),
    S("deep-link-signed-out", "/projects/{p}/tasks", who="anon"),
    S("offline-page", "/offline.html", who="anon"),
    S("sign-out", "/sign-out"),
    S("consent-without-request", "/consent"),
    # Places and states.
    S("inbox-item", "/inbox/{inbox}", needs=("inbox",)),
    S("message-link", "/projects/{p}/messages/{msg}", needs=("msg",)),
    S("wiki-version", "/projects/{p}/docs/{doc}/versions/1", needs=("doc",)),
    S("live-gone", "/projects/{p}/live/" + ZERO),
    S("material", "/materials/{material}", needs=("material",)),
    S("material-gone", "/materials/" + ZERO),
    S("space-gone", "/projects/" + ZERO),
    S("dm-gone", "/dm/" + ZERO),
    S("agent-gone", "/agents/" + ZERO),
    S("dm-thread", "/dm/{dm}?thread={dmroot}", needs=("dm", "dmroot")),
    S("agent-assistant", "/agents/{assistant}", needs=("assistant",)),
    S("agent-planner", "/agents/{planner}", needs=("planner",)),
    S("agent-schedules", "/agents/{assistant}", steps=[("click", "[data-schedules-header] button")], needs=("assistant",)),
    S("settings-agent-page", "/settings/agents/{planner}", needs=("planner",)),
    S("settings-notifications-verify", "/settings/notifications/verify?token=not-a-real-token"),
    S("long-space", "/projects/{pl}", needs=("pl",)),
    S("long-space-tasks", "/projects/{pl}/tasks?view=list", needs=("pl",)),
    S("long-space-wiki", "/projects/{pl}/docs", needs=("pl",)),
    # Access: read-only, guest, locked.
    S("settings-company-member", "/settings/company", who="jonas"),
    S("settings-company-guest", "/settings/company", who="tomasz"),
    S("guest-home", "/", who="tomasz"),
    S("guest-space", "/projects/{p}", who="tomasz"),
    S("guest-tasks", "/projects/{p}/tasks", who="tomasz"),
    S("guest-ai", "/settings/agents", who="tomasz"),
    S("guest-connect", "/settings/agents/connect", who="tomasz"),
    S("locked-owner", "/spaces/{enc}", needs=("enc",)),
    S("locked-member", "/spaces/{enc}", who="jonas", needs=("enc",)),
    S("locked-member-deep-link", "/projects/{encp}", who="jonas", needs=("encp",)),
    S("member-home", "/", who="basia"),
    # Overlays: menus, sheets, dialogs, notices.
    S("message-actions", "/projects/{p}", steps=[("menu", ".project-convo__message >> nth=-2")]),
    S("dm-message-actions", "/dm/{dm}", steps=[("menu", "[data-message-id] >> nth=-1")], needs=("dm",)),
    S("new-space-encrypted", "/", steps=[("press", "c"), ("click", "[role='dialog'] :text-is('Space')"), ("wait", "[role='dialog'] input"),
                                        ("role", "switch", "Encrypted")], only="wide"),
    S("new-space-encrypted-phone", "/", steps=[("click", ".phone-fab"), ("click", "[role='dialog'] :text-is('Space')"), ("wait", "[role='dialog'] input"),
                                              ("role", "switch", "Encrypted")], only="phone"),
    # Maja's direct message, not the Jonas one the dm screens show: every capture of this state sends one more message.
    S("notice", "/", steps=[("dm_from", "maja", "Are you at the garden this afternoon? I have the ladder."), ("wait", "[role='status'] >> text=Maja")], isolated=True, needs=("dm_maja",)),
    S("push-offer", "/", steps=[("js", "() => { window.scrollTo(0, 1e6); document.querySelectorAll('.pane-scroll, main, [data-scroll]').forEach((e) => e.scrollTo(0, 1e6)); }")], init="localStorage.setItem('flux:push-offer:{me_ada}', JSON.stringify({ready: true}));" + push_stub("denied"), isolated=True, needs=("me_ada",)),
    S("push-blocked", "/", steps=[("click", "section.push-offer button:has-text('Turn on')"), ("wait", "section.push-offer h3:has-text('blocked')"), ("js", "() => { window.scrollTo(0, 1e6); document.querySelectorAll('.pane-scroll, main, [data-scroll]').forEach((e) => e.scrollTo(0, 1e6)); }")],
      init="localStorage.setItem('flux:push-offer:{me_ada}', JSON.stringify({ready: true}));" + push_stub("denied"), isolated=True, needs=("me_ada",)),
    S("photo-sheet-phone", "/projects/{p}", steps=[("role", "button", "Add photos or files|Attach|Add a photo|Photos")], only="phone"),
    S("task-state-menu", "/projects/{p}/tasks?view=board&open=work:{task}", steps=[("role", "button", "In progress|State|Status")], needs=("task",)),
    S("select-open", "/settings/agents", steps=[("click", "button[role='combobox']")]),
]
# #763's ways into New space (⋯ › Details, "New space" buttons) are gone: Create's Space type is the one way (S3, S20).
OPEN_SPACE_WIDE = [("press", "c"), ("click", "[role='dialog'] :text-is('Space')"), ("wait", "[role='dialog'] input")]
OPEN_SPACE_PHONE = [("click", ".phone-fab"), ("click", "[role='dialog'] :text-is('Space')"), ("wait", "[role='dialog'] input")]
REPLACED = {"new-space", "new-project", "new-project-phone"}
EXTRA_SCREENS += [
    S("new-space", "/", steps=OPEN_SPACE_WIDE, only="wide"),
    S("new-space-phone", "/", steps=OPEN_SPACE_PHONE, only="phone"),
]
SCREENS = [s for s in vca.SCREENS if s.name not in REPLACED] + EXTRA_SCREENS
for s in SCREENS:
    if not hasattr(s, "init"):
        s.init = ""


def screen_init(screen) -> str:
    return getattr(screen, "init", "") or ""


# ---------------------------------------------------------------------------------------------------------------
# Browsers, contexts, steps
# ---------------------------------------------------------------------------------------------------------------

def context_options(pw, engine: str, win: str, theme: str, *, who: str, data: dict, reduced: str = "reduce", workers: str = "block") -> dict:
    spec = WINDOWS[win]
    touch = spec["kind"] != "computer"
    options = dict(base_url=ORIGIN, viewport={"width": spec["width"], "height": spec["height"]}, device_scale_factor=1,
                   color_scheme=theme, reduced_motion=reduced, locale="en-GB", timezone_id="Europe/Warsaw",
                   has_touch=touch, service_workers=workers)
    if touch:
        options["is_mobile"] = True
        options["user_agent"] = pw.devices[UA_DEVICE[(engine, spec["kind"])]]["user_agent"]
    if who != "anon":
        options["storage_state"] = data["states"][who]
    return options


def run_step(page: Page, step: tuple, touch: bool, data: dict, apis: dict) -> None:
    kind = step[0]
    if kind == "role":
        target = page.get_by_role(step[1], name=re.compile(step[2])).first
        target.wait_for(state="visible", timeout=6000)
        target.tap(timeout=5000) if touch else target.click(timeout=5000)
        page.wait_for_timeout(350)
    elif kind == "menu":
        from message_gestures import open_message_menu
        open_message_menu(page.locator(step[1]).first if ">>" not in step[1] else page.locator(step[1]), phone=touch)
        page.wait_for_timeout(350)
    elif kind == "js":
        page.evaluate(step[1])
    elif kind == "dm_from":
        who, text = step[1], step[2]
        dm = data["ids"].get("dm_maja") if who == "maja" else data["ids"].get("dm")
        call(apis[who], "POST", f"/api/v1/dms/{dm}/messages", {"body": text, "clientMessageId": str(uuid.uuid4())})
        page.wait_for_timeout(1500)
    else:
        vca.run_step(page, step, touch)


# Checks the #763 measurement does not make: sideways scroll, words, editable text under 16 px on touch.
EXTRA_JS = r"""
(cfg) => {
  const out = [];
  const se = document.scrollingElement || document.documentElement;
  const over = se.scrollWidth - innerWidth;
  if (over > 1) {
    const wide = [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.right > innerWidth + 1 && r.width > 0 && getComputedStyle(e).position !== 'fixed'; })
      .slice(0, 3).map((e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ').slice(0, 2).join('.') : ''));
    out.push({rule: 'hscroll', prio: 'P2', detail: `the page scrolls sideways by ${over}px (widest: ${wide.join(', ')})`});
  }
  // Words: visible interface text, aria-labels, placeholders and titles; message and page bodies are content.
  const content = '.message-body, .msg-body, [data-message-body], .ProseMirror, .wiki-page__body, .doc-body, .cm-content, .thought, [contenteditable="true"]';
  const words = cfg.words.map(([re, why]) => [new RegExp(re, 'i'), why]);
  const seeded = cfg.seeded;
  const seen = new Set();
  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue.trim(); if (!text) continue;
    const el = n.parentElement; if (!el || el.closest(content) || el.closest('script,style,noscript')) continue;
    if (seeded.some((s) => text.includes(s))) continue;
    for (const [re, why] of words) if (re.test(text) && visible(el)) { const key = why + text.slice(0, 80); if (!seen.has(key)) { seen.add(key); out.push({rule: 'words', prio: 'P3', detail: `${why}: “${text.slice(0, 90)}”`}); } }
  }
  for (const el of document.querySelectorAll('[aria-label], [placeholder], [title]')) {
    for (const attr of ['aria-label', 'placeholder', 'title']) {
      const text = el.getAttribute(attr); if (!text || el.closest(content)) continue;
      if (seeded.some((s) => text.includes(s))) continue;
      for (const [re, why] of words) if (re.test(text)) { const key = why + attr + text; if (!seen.has(key)) { seen.add(key); out.push({rule: 'words', prio: 'P3', detail: `${why} in ${attr}: “${text.slice(0, 90)}”`}); } }
    }
  }
  // Editable text under 16 px on a coarse pointer makes iOS Safari zoom in on focus (MOB-2).
  if (matchMedia('(pointer: coarse)').matches) {
    for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]), textarea, select, [contenteditable="true"]')) {
      const box = el.getBoundingClientRect();
      if (!visible(el) || box.width < 8 || box.height < 8) continue;  // a visually hidden input (a file picker's) takes no focus zoom
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 15.99) out.push({rule: 'zoom', prio: 'P2', detail: `editable text at ${size}px on touch (iOS zooms in under 16px): ${el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.tagName.toLowerCase()}`});
    }
  }
  return {flags: out, scrollWidth: se.scrollWidth, title: document.title, h1: (document.querySelector('h1')?.innerText || '').slice(0, 80)};
}
"""


def safe_name(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", text)[:80]


# ---------------------------------------------------------------------------------------------------------------
# Phase: firstrun (empty server)
# ---------------------------------------------------------------------------------------------------------------

def phase_firstrun(pw) -> None:
    sink = (OUT / "results-firstrun.jsonl").open("w", encoding="utf-8")
    for engine in BROWSERS:
        browser = getattr(pw, engine).launch()
        for theme in THEMES:
            for win in WINDOW_NAMES:
                context = browser.new_context(**context_options(pw, engine, win, theme, who="anon", data={}))  # sw-allowed: context_options blocks workers unless asked
                for name, path in (("first-run-sign-up", "/sign-up"), ("first-run-sign-in", "/sign-in"), ("first-run-root", "/")):
                    page = context.new_page()
                    rec = {"screen": name, "engine": engine, "theme": theme, "vp": win}
                    try:
                        page.goto(ORIGIN + path, wait_until="domcontentloaded", timeout=20000)
                        vca.settle(page)
                        rec.update(capture_page(page, engine, theme, win, name))
                    except Exception as error:
                        rec["failed"] = str(error).splitlines()[0][:300]
                    sink.write(json.dumps(rec) + "\n")
                    page.close()
                context.close()
        browser.close()
    sink.close()


# ---------------------------------------------------------------------------------------------------------------
# Phase: capture
# ---------------------------------------------------------------------------------------------------------------

def capture_page(page: Page, engine: str, theme: str, win: str, name: str) -> dict:
    """Measures and saves one state: screenshot, ARIA snapshot, #763 flags, extra flags."""
    base = OUT / "shots" / f"{engine}-{theme}-{win}"
    base.mkdir(parents=True, exist_ok=True)
    rec: dict = {"shot": str((base / f"{name}.png").relative_to(OUT))}
    found = page.evaluate(vca.MEASURE_JS, {})
    extra = page.evaluate(EXTRA_JS, {"words": WORDS, "seeded": SEEDED_WORDS})
    vca.shot(page, base / f"{name}.png")
    try:
        (base / f"{name}.aria.yml").write_text(page.locator("body").aria_snapshot(timeout=8000), encoding="utf-8")
        rec["aria"] = str((base / f"{name}.aria.yml").relative_to(OUT))
    except Exception as error:
        rec["aria_error"] = str(error).splitlines()[0][:160]
    start = page.evaluate(vca.OCCLUSION_JS, {"phase": "start"})
    flags = found["flags"] + start["flags"] + extra["flags"]
    if win in ANNOTATE:
        boxes = [{**f["rect"], "prio": f["prio"], "tag": f"{f['rule']} {f['prio']}"} for f in flags if f.get("rect") and f["rule"] in "abcefhi"][:60]
        if boxes:
            page.evaluate(vca.ANNOTATE_JS, boxes)
            vca.shot(page, base / f"{name}-annot.png")
            page.evaluate("() => document.getElementById('vca-layer')?.remove()")
            rec["annot"] = str((base / f"{name}-annot.png").relative_to(OUT))
    end = page.evaluate(vca.OCCLUSION_JS, {"phase": "end"})
    if end["flags"]:
        page.evaluate(vca.ANNOTATE_JS, [{**f["rect"], "prio": f["prio"], "tag": "f under layer"} for f in end["flags"]][:40])
        vca.shot(page, base / f"{name}-bottom.png")
        rec["bottom"] = str((base / f"{name}-bottom.png").relative_to(OUT))
        for f in end["flags"]:
            f["shot"] = rec["bottom"]
    flags += end["flags"]
    rec.update({k: v for k, v in found.items() if k != "flags"})
    rec["flags"] = flags
    rec["h1"], rec["title"], rec["scrollWidth"] = extra["h1"], extra["title"], extra["scrollWidth"]
    return rec


def layout_of(pw, browser, engine: str, win: str, data: dict) -> str:
    """"phone" when the window gets the phone's layout (the tab bar and the floating +), else "wide" (sidebar, New and C).
    A tablet gets either, by its width; screens limited to one layout are N/A in the other."""
    context = browser.new_context(**context_options(pw, engine, win, "light", who="ada", data=data))  # sw-allowed: context_options blocks workers unless asked
    page = context.new_page()
    try:
        page.goto(ORIGIN + "/", wait_until="domcontentloaded", timeout=25000)
        vca.settle(page)
        return "phone" if page.locator(".phone-fab").count() else "wide"
    finally:
        context.close()


def applies(screen, lay: str) -> bool:
    return not screen.only or screen.only == lay


def capture_combo(pw, engine: str, theme: str, data: dict, chunk: int = 0, chunks: int = 1) -> None:
    browser = getattr(pw, engine).launch()
    windows = WINDOW_NAMES[chunk::chunks]
    apis = {who: browser.new_context(base_url=ORIGIN, storage_state=state, service_workers="block") for who, state in data["states"].items()}
    ids = {k: v for k, v in data["ids"].items()}
    with (OUT / f"results-capture-{engine}-{theme}-c{chunk}{TAG}.jsonl").open("w", encoding="utf-8") as sink:
        for win in windows:
            touch = WINDOWS[win]["kind"] != "computer"
            lay = layout_of(pw, browser, engine, win, data)
            contexts: dict[str, BrowserContext] = {}

            def context_for(who: str, init: str = "") -> BrowserContext:
                if init or who not in contexts:
                    # A page with a script of its own (the push offer) runs with its service worker: push needs one.
                    context = browser.new_context(**context_options(pw, engine, win, theme, who=who, data=data, workers="allow" if init else "block"))  # sw-allowed: only the push offer's page runs its worker (push needs one); it stubs no route
                    if init:
                        for key, value in ids.items():
                            init = init.replace("{" + key + "}", str(value))
                        context.add_init_script(init)
                        return context
                    contexts[who] = context
                return contexts[who]

            for screen in SCREENS:
                if ONLY and screen.name not in ONLY:
                    continue
                rec = {"screen": screen.name, "engine": engine, "theme": theme, "vp": win, "layout": lay}
                if not applies(screen, lay):
                    rec["na"] = f"{screen.only} layout only"
                    sink.write(json.dumps(rec) + "\n")
                    continue
                if any(not ids.get(n) for n in screen.needs):
                    rec["skipped"] = "missing data: " + ",".join(n for n in screen.needs if not ids.get(n))
                    sink.write(json.dumps(rec) + "\n")
                    continue
                if screen.isolated and screen.who in contexts:
                    contexts.pop(screen.who).close()
                own = context_for(screen.who, screen_init(screen))
                page = own.new_page()
                errors: list[str] = []
                page.on("pageerror", lambda error: errors.append(str(error)[:200]))
                started = time.time()
                try:
                    page.goto(ORIGIN + screen.path.format(**ids), wait_until="domcontentloaded", timeout=25000)
                    vca.settle(page)
                    for step in screen.steps:
                        try:
                            run_step(page, step, touch, data, apis)
                        except Exception as error:
                            rec["unreachable"] = f"{step}: {str(error).splitlines()[0][:160]}"
                            break
                    vca.settle(page)
                    rec["url"] = page.url.replace(ORIGIN, "")
                    rec.update(capture_page(page, engine, theme, win, screen.name))
                    rec["errors"] = errors
                except Exception as error:
                    rec["failed"] = str(error).splitlines()[0][:300]
                    try:
                        vca.shot(page, OUT / "shots" / f"{engine}-{theme}-{win}" / f"{screen.name}.png")
                    except Exception:
                        pass
                rec["seconds"] = round(time.time() - started, 1)
                sink.write(json.dumps(rec) + "\n")
                sink.flush()
                page.close()
                if screen_init(screen):
                    own.close()
                elif screen.isolated:
                    contexts.pop(screen.who).close()
                n2 = sum(1 for f in rec.get("flags", []) if f["prio"] == "P2")
                print(f"{engine} {theme} {win} {screen.name}: {len(rec.get('flags', []))} flags ({n2} P2)"
                      + (f" UNREACHABLE {rec['unreachable']}" if rec.get("unreachable") else "")
                      + (f" FAILED {rec['failed']}" if rec.get("failed") else ""), flush=True)
            for c in contexts.values():
                c.close()
    browser.close()


# ---------------------------------------------------------------------------------------------------------------
# Phase: states (loading, error and Try again)
# ---------------------------------------------------------------------------------------------------------------

API_GET = re.compile(r"/api/v1/[^?#]*")
IDLIKE = re.compile(r"/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|/\d+(?=/|$)")
STATE_SCREENS = ["home", "inbox", "inbox-item", "projects", "conversation", "thread", "tasks-board", "tasks-list", "task-panel", "map",
                 "wiki-index", "wiki-page", "wiki-history", "my-map", "workspace-tasks", "dm-index", "dm", "dm-thread", "agent-assistant",
                 "settings", "settings-account", "settings-company", "settings-notifications", "settings-agents", "settings-connect",
                 "settings-ai-connections", "settings-agent-page", "project-people", "decision-panel", "material", "project-github"]
ERROR_WORDS = re.compile(r"couldn.t|could not|can.t be|cannot be|not be loaded|went wrong|try again|retry|failed|offline|not available", re.I)


def norm(url: str) -> str:
    m = API_GET.search(url)
    return IDLIKE.sub("/:id", m.group(0)) if m else ""


def phase_states(pw, engine: str, data: dict) -> None:
    browser = getattr(pw, engine).launch()
    ids = data["ids"]
    with (OUT / f"results-states-{engine}{TAG}.jsonl").open("w", encoding="utf-8") as sink:
        for theme in THEMES:
            for win in STATE_WINDOWS:
                touch = WINDOWS[win]["kind"] != "computer"
                lay = layout_of(pw, browser, engine, win, data)
                for screen in SCREENS:
                    if screen.name not in STATE_SCREENS or (ONLY and screen.name not in ONLY) or not applies(screen, lay):
                        continue
                    if any(not ids.get(n) for n in screen.needs):
                        continue
                    path = screen.path.format(**ids)
                    context = browser.new_context(**context_options(pw, engine, win, theme, who=screen.who, data=data))  # sw-allowed: context_options blocks workers unless asked
                    page = context.new_page()
                    # 1. Which reads are the screen's own (not the shell's): the shell's are those of a page with no data of its own
                    # (Settings › Keyboard shortcuts); a signed-out page has no shell.
                    shell: set[str] = set()
                    own: set[str] = set()
                    target = shell
                    page.on("request", lambda r: (r.method == "GET" and "/api/v1/" in r.url and "/stream" not in r.url) and target.add(norm(r.url)))
                    rec = {"screen": screen.name, "engine": engine, "theme": theme, "vp": win, "kind": "states"}
                    base = OUT / "states" / f"{engine}-{theme}-{win}"
                    base.mkdir(parents=True, exist_ok=True)
                    try:
                        page.goto(ORIGIN + ("/settings/shortcuts" if screen.who != "anon" else "/sign-in"), wait_until="domcontentloaded", timeout=25000)
                        vca.settle(page)
                        target = own
                        page.goto(ORIGIN + path, wait_until="domcontentloaded", timeout=25000)
                        vca.settle(page)
                        reads = sorted(own - shell) or sorted(own)
                        rec["reads"] = reads
                        page.close()
                        if not reads:
                            rec["note"] = "no reads of its own"
                        else:
                            wanted = set(reads)
                            # 2. Loading: the screen's reads wait 5 s; what is on screen after 0.9 s.
                            page = context.new_page()
                            page.route(re.compile(r".*/api/v1/.*"), lambda route: (time.sleep(0) or route.continue_()) if norm(route.request.url) not in wanted or route.request.method != "GET" else hold(route))
                            page.goto(ORIGIN + path, wait_until="commit", timeout=25000)
                            page.wait_for_timeout(900)
                            vca.shot(page, base / f"{screen.name}--loading.png")
                            rec["loading"] = page.evaluate("""() => ({busy: !!document.querySelector('[aria-busy="true"], .ui-spin, [class*="skeleton"], .route-progress.is-active, [role="progressbar"]'),
                                text: (document.body.innerText || '').trim().slice(0, 160)})""")
                            page.close()
                            # 3. Error: the screen's reads answer 503; then Try again with them back.
                            page = context.new_page()
                            failing = {"on": True}
                            page.route(re.compile(r".*/api/v1/.*"), lambda route: route.fulfill(status=503, json={"error": {"code": "UNAVAILABLE", "message": "Service unavailable"}})
                                       if failing["on"] and route.request.method == "GET" and norm(route.request.url) in wanted else route.continue_())
                            page.goto(ORIGIN + path, wait_until="domcontentloaded", timeout=25000)
                            vca.settle(page)
                            page.wait_for_timeout(1500)
                            vca.shot(page, base / f"{screen.name}--error.png")
                            text = page.evaluate("() => document.body.innerText")
                            said = ERROR_WORDS.search(text or "")
                            retry = page.get_by_role("button", name=re.compile(r"^(Try again|Retry|Reload)", re.I))
                            rec["error"] = {"said": said.group(0) if said else None, "retry": retry.count()}
                            failing["on"] = False
                            if retry.count():
                                (retry.first.tap() if touch else retry.first.click())
                                vca.settle(page)
                                page.wait_for_timeout(1200)
                                vca.shot(page, base / f"{screen.name}--retried.png")
                                after = page.evaluate("() => document.body.innerText") or ""
                                rec["error"]["recovered"] = not page.get_by_role("button", name=re.compile(r"^(Try again|Retry)", re.I)).count()
                                rec["error"]["after"] = after.strip()[:120]
                            page.close()
                    except Exception as error:
                        rec["failed"] = str(error).splitlines()[0][:300]
                    context.close()
                    sink.write(json.dumps(rec) + "\n")
                    sink.flush()
                    print(f"states {engine} {theme} {win} {screen.name}: {json.dumps({k: rec.get(k) for k in ('error', 'failed', 'note')})[:300]}", flush=True)
    browser.close()


def hold(route) -> None:
    """Holds a read back 5 s, then lets it through (the loading state)."""
    import threading
    threading.Timer(5.0, lambda: _continue(route)).start()


def _continue(route) -> None:
    try:
        route.continue_()
    except Exception:
        pass


# ---------------------------------------------------------------------------------------------------------------
# Phase: a11y (focus order and visible focus, 200 % text, reduced motion, transitions)
# ---------------------------------------------------------------------------------------------------------------

FOCUS_JS = r"""
() => {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return {body: true};
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  const ring = (st) => (st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) > 0) || (st.boxShadow && st.boxShadow !== 'none');
  let shown = ring(s);
  // A ring drawn by a wrapper (:focus-within) or a pseudo-element counts.
  if (!shown) for (const pseudo of ['::before', '::after']) { const p = getComputedStyle(el, pseudo); if (p.content !== 'none' && ring(p)) shown = true; }
  if (!shown) { let p = el.parentElement; for (let i = 0; p && i < 2; i++, p = p.parentElement) { if (p.matches(':focus-within') && ring(getComputedStyle(p))) { shown = true; break; } } }
  const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 50);
  const inView = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  return {label, tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          visible: shown, focusVisible: el.matches(':focus-visible'), inView, hidden: r.width < 1 || r.height < 1};
}
"""

MOTION_JS = r"""
() => {
  const running = document.getAnimations().filter((a) => a.playState === 'running').map((a) => {
    const t = a.effect && a.effect.getTiming ? a.effect.getTiming() : {}; const target = a.effect && a.effect.target;
    return {name: a.animationName || a.transitionProperty || a.constructor.name, duration: t.duration, iterations: t.iterations,
            target: target ? target.tagName.toLowerCase() + '.' + String(target.className || '').split(' ').slice(0, 2).join('.') : ''};
  }).filter((a) => (typeof a.duration === 'number' ? a.duration : 0) > 20 || a.iterations === Infinity);
  // Rule 9: with reduced motion every duration and delay is zero, so a transition or animation left in CSS is a finding too.
  const timed = new Map();
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el);
    const t = Math.max(...s.transitionDuration.split(',').map(parseFloat), ...s.transitionDelay.split(',').map(parseFloat));
    const a = s.animationName !== 'none' ? Math.max(...s.animationDuration.split(',').map(parseFloat), ...s.animationDelay.split(',').map(parseFloat)) : 0;
    if (t > 0.001 || a > 0.001) { const key = el.tagName.toLowerCase() + '.' + String(el.className || '').split(' ').slice(0, 2).join('.') + (a > 0.001 ? ' animation ' + s.animationName : ' transition ' + s.transitionProperty); timed.set(key, (timed.get(key) || 0) + 1); }
  }
  return running.slice(0, 10).concat([...timed.entries()].slice(0, 10).map(([k, n]) => ({name: 'timed while reduced', target: `${k} ×${n}`, duration: null})));
}
"""

TRANSITIONS_JS = r"""
() => {
  const odd = new Map();
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el);
    if (s.transitionDuration && s.transitionDuration.split(',').some((d) => parseFloat(d) > 0)) {
      const props = s.transitionProperty.split(',').map((p) => p.trim());
      const bad = props.filter((p) => !['transform', 'opacity', 'none', 'translate', 'scale', 'rotate'].includes(p));
      if (bad.length) { const key = el.tagName.toLowerCase() + '.' + String(el.className || '').split(' ').slice(0, 2).join('.') + ' [' + bad.join(',') + ']'; odd.set(key, (odd.get(key) || 0) + 1); }
    }
  }
  return [...odd.entries()].slice(0, 25).map(([k, n]) => `${k} ×${n}`);
}
"""

A11Y_SCREENS = None  # all screens without steps, plus the overlays


def phase_a11y(pw, engine: str, data: dict) -> None:
    browser = getattr(pw, engine).launch()
    ids = data["ids"]
    apis = {who: browser.new_context(base_url=ORIGIN, storage_state=state, service_workers="block") for who, state in data["states"].items()}
    with (OUT / f"results-a11y-{engine}{TAG}.jsonl").open("w", encoding="utf-8") as sink:
        for theme in THEMES:
            for win in A11Y_WINDOWS:
                touch = WINDOWS[win]["kind"] != "computer"
                lay = layout_of(pw, browser, engine, win, data)
                for screen in SCREENS:
                    if (ONLY and screen.name not in ONLY) or not applies(screen, lay) or any(not ids.get(n) for n in screen.needs) or screen_init(screen):
                        continue
                    if screen.name in ("notice", "sign-out"):
                        continue
                    rec = {"screen": screen.name, "engine": engine, "theme": theme, "vp": win, "kind": "a11y"}
                    base = OUT / "a11y" / f"{engine}-{theme}-{win}"
                    base.mkdir(parents=True, exist_ok=True)
                    context = browser.new_context(**context_options(pw, engine, win, theme, who=screen.who, data=data, reduced="reduce"))  # sw-allowed: context_options blocks workers unless asked
                    page = context.new_page()
                    try:
                        page.goto(ORIGIN + screen.path.format(**ids), wait_until="domcontentloaded", timeout=25000)
                        vca.settle(page)
                        for step in screen.steps:
                            run_step(page, step, touch, data, apis)
                        vca.settle(page)
                        # Reduced motion: nothing keeps moving (spinners excepted are reported too, for a person to judge).
                        rec["motion_reduce"] = page.evaluate(MOTION_JS)
                        if theme == THEMES[0] and win == A11Y_WINDOWS[0]:
                            rec["transitions"] = page.evaluate(TRANSITIONS_JS)
                        # Focus: Tab through up to 30 stops (keyboard-only on a computer; on a tablet with a keyboard too).
                        if not screen.steps or screen.name in ("create", "search", "new-project", "project-more", "message-actions"):
                            stops = []
                            for _ in range(30):
                                page.keyboard.press("Tab")
                                page.wait_for_timeout(60)
                                stops.append(page.evaluate(FOCUS_JS))
                            rec["focus"] = stops
                            unseen = [s for s in stops if not s.get("body") and not s.get("visible") and not s.get("hidden")]
                            rec["focus_unseen"] = sorted({s["label"] for s in unseen})[:12]
                            rec["focus_offscreen"] = sorted({s["label"] for s in stops if not s.get("body") and not s.get("inView")})[:12]
                            rec["focus_hidden"] = sorted({s["label"] for s in stops if s.get("hidden")})[:12]
                            if unseen:
                                # The first stop without a visible ring, on screen, for a person to judge.
                                page.keyboard.press("Escape")
                        # 200 % text: the root font size doubles (Android font scale / large text; the tokens are rem).
                        if not screen.steps:
                            page.evaluate("() => { document.documentElement.style.fontSize = '200%'; }")
                            page.wait_for_timeout(400)
                            big = page.evaluate(EXTRA_JS, {"words": [], "seeded": []})
                            clipped = page.evaluate(vca.MEASURE_JS, {})
                            rec["text200"] = {"hscroll": [f["detail"] for f in big["flags"] if f["rule"] == "hscroll"],
                                              "clipped": [f["detail"] + " " + f.get("label", "") for f in clipped["flags"] if f["rule"] == "f"][:8]}
                            vca.shot(page, base / f"{screen.name}--text200.png")
                    except Exception as error:
                        rec["failed"] = str(error).splitlines()[0][:300]
                    context.close()
                    sink.write(json.dumps(rec) + "\n")
                    sink.flush()
                    print(f"a11y {engine} {theme} {win} {screen.name}: unseen={rec.get('focus_unseen')} motion={len(rec.get('motion_reduce') or [])} "
                          f"text200={rec.get('text200', {}).get('hscroll')} {rec.get('failed', '')}", flush=True)
    browser.close()


# ---------------------------------------------------------------------------------------------------------------
# Phase: keys (shortcuts that change no data) and journeys (interactions, persisted after a reload)
# ---------------------------------------------------------------------------------------------------------------

class Check:
    def __init__(self, sink, kind: str, engine: str, win: str, theme: str = "light"):
        self.sink, self.kind, self.engine, self.win, self.theme = sink, kind, engine, win, theme

    def run(self, name: str, page_factory, fn) -> None:
        rec = {"kind": self.kind, "name": name, "engine": self.engine, "vp": self.win, "theme": self.theme}
        page = None
        started = time.time()
        try:
            page = page_factory()
            detail = fn(page)
            rec["result"] = "pass"
            if detail:
                rec["detail"] = detail
        except AssertionError as error:
            rec["result"] = "fail"
            rec["detail"] = str(error)[:400]
        except Exception as error:
            rec["result"] = "unreachable"
            rec["detail"] = (str(error).splitlines() or [""])[0][:300]
        if page is not None:
            try:
                path = OUT / self.kind / f"{self.engine}-{self.win}" / f"{safe_name(name)}.png"
                path.parent.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(path))
                rec["shot"] = str(path.relative_to(OUT))
            except Exception:
                pass
            try:
                page.context.close()
            except Exception:
                pass
        rec["seconds"] = round(time.time() - started, 1)
        self.sink.write(json.dumps(rec) + "\n")
        self.sink.flush()
        print(f"{self.kind} {self.engine} {self.win} {name}: {rec['result']} {rec.get('detail', '')}"[:400], flush=True)


def opener(pw, browser, engine, win, data, who="ada", path="/", workers="block", theme="light", init: str = ""):
    def make():
        context = browser.new_context(**context_options(pw, engine, win, theme, who=who, data=data, workers=workers))  # sw-allowed: the MOB checks need the worker (offline page, push); they stub no route
        if init:
            context.add_init_script(init)
        page = context.new_page()
        if path is not None:
            page.goto(ORIGIN + path.format(**data["ids"]), wait_until="domcontentloaded", timeout=25000)
            vca.settle(page)
        return page
    return make


def press_seq(page: Page, *keys: str) -> None:
    for key in keys:
        page.keyboard.press(key)
        page.wait_for_timeout(120)


def visible_dialog(page: Page) -> bool:
    return page.locator("[role='dialog']:visible, [aria-modal='true']:visible").count() > 0


def phase_keys(pw, engine: str, data: dict) -> None:
    browser = getattr(pw, engine).launch()
    with (OUT / f"results-keys-{engine}{TAG}.jsonl").open("w", encoding="utf-8") as sink:
        win = "1440"
        check = Check(sink, "keys", engine, win)
        open_at = lambda path="/": opener(pw, browser, engine, win, data, path=path)  # noqa: E731

        def c_opens_create(page):
            page.keyboard.press("c")
            page.wait_for_timeout(500)
            assert visible_dialog(page), "C opened no window"
            text = page.locator("[role='dialog']").first.inner_text()
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)
            assert not visible_dialog(page), "Esc did not close the Create window"
            return text[:80]
        check.run("C opens Create, Esc closes it", open_at(), c_opens_create)

        def search(mod):
            def fn(page):
                page.keyboard.press(f"{mod}+k")
                page.wait_for_timeout(500)
                assert page.locator("[role='dialog'] input").count(), f"{mod}+K opened no search"
                page.keyboard.type("sensor", delay=40)
                page.wait_for_timeout(1200)
                n = page.locator("[role='option']").count()
                assert n > 0, "no results for 'sensor'"
                page.keyboard.press("ArrowDown")
                page.keyboard.press("Enter")
                page.wait_for_timeout(1200)
                return f"{n} results; Enter went to {page.url.replace(ORIGIN, '')}"
            return fn
        check.run("Ctrl+K searches and Enter opens a result", open_at(), search("Control"))
        check.run("Meta+K searches (⌘K)", open_at(), search("Meta"))

        def g_i(page):
            press_seq(page, "g", "i")
            page.wait_for_timeout(800)
            assert page.url.rstrip("/").endswith("/inbox"), f"G I went to {page.url}"
        check.run("G I goes to Inbox", open_at(), g_i)

        def j_k(page):
            # The selected item is the open (expanded) card; J and K move it.
            snap = "() => [...document.querySelectorAll('main [aria-expanded=\"true\"], main [aria-selected=\"true\"], main [aria-current=\"true\"], main .is-open, main .is-selected')].map(e => (e.innerText || '').slice(0, 50)).join(' | ') || (document.querySelector('main')?.innerText || '').slice(0, 400)"
            before = page.evaluate(snap)
            press_seq(page, "j")
            one = page.evaluate(snap)
            press_seq(page, "j")
            two = page.evaluate(snap)
            press_seq(page, "k")
            back = page.evaluate(snap)
            assert one != two and back == one, f"J/K did not move the selection: {before[:60]!r} → {one[:60]!r} → {two[:60]!r} → {back[:60]!r}"
            return "J, J, K moved the open item down, down, up"
        check.run("J/K move in the Inbox list", open_at("/inbox"), j_k)

        def r_reply(page):
            message = page.locator(".project-convo__message").nth(-2)
            message.hover()
            message.click(position={"x": 5, "y": 5})
            page.keyboard.press("r")
            page.wait_for_timeout(900)
            assert "conversations/" in page.url or page.locator("[aria-label*='hread' i]").count(), f"R opened no thread ({page.url})"
            return page.url.replace(ORIGIN, "")
        check.run("R replies in thread to the selected message", open_at("/projects/{p}"), r_reply)

        def t_task(page):
            message = page.locator(".project-convo__message").nth(-2)
            message.hover()
            message.click(position={"x": 5, "y": 5})
            page.keyboard.press("t")
            page.wait_for_timeout(900)
            assert visible_dialog(page), "T opened no window"
            text = page.locator("[role='dialog']").first.inner_text()[:100]
            page.keyboard.press("Escape")
            return text
        check.run("T makes a task from the selected message", open_at("/projects/{p}"), t_task)

        def bracket(page):
            width = page.evaluate("() => (document.querySelector('nav, aside') || document.body).getBoundingClientRect().width")
            page.keyboard.press("[")
            page.wait_for_timeout(700)
            after = page.evaluate("() => (document.querySelector('nav, aside') || document.body).getBoundingClientRect().width")
            page.keyboard.press("[")
            page.wait_for_timeout(500)
            assert after != width, f"[ did not change the sidebar ({width} → {after})"
            return f"{width} → {after}"
        check.run("[ collapses the sidebar and back", open_at(), bracket)

        def esc_panel(page):
            assert page.locator("[role='dialog'], aside[aria-label], .side-panel, [data-panel]").count(), "no panel open"
            page.keyboard.press("Escape")
            page.wait_for_timeout(700)
            assert "open=" not in page.url, f"Esc left the panel open ({page.url})"
        check.run("Esc closes the task panel", open_at("/projects/{p}/tasks?view=board&open=work:{task}"), esc_panel)

        def shortcuts_page(page):
            text = page.inner_text("main") if page.locator("main").count() else page.inner_text("body")
            missing = [action for action in ("New (task by default)", "Search or run", "Go to Inbox", "Collapse the sidebar") if action not in text]
            assert not missing, f"missing {missing}"
        check.run("Settings › Keyboard shortcuts lists the keys", open_at("/settings/shortcuts"), shortcuts_page)
    browser.close()


def phase_journeys(pw, engine: str, data: dict) -> None:
    browser = getattr(pw, engine).launch()
    ids = data["ids"]
    with (OUT / f"results-journeys-{engine}{TAG}.jsonl").open("w", encoding="utf-8") as sink:
        for win in ("1440", "390"):
            touch = WINDOWS[win]["kind"] != "computer"
            check = Check(sink, "journeys", engine, win)
            open_at = lambda path="/", who="ada": opener(pw, browser, engine, win, data, who=who, path=path)  # noqa: E731
            tag = f"{engine}-{win}-{uuid.uuid4().hex[:4]}"
            press = (lambda loc: loc.tap()) if touch else (lambda loc: loc.click())

            def send(page):
                if touch:
                    press(page.get_by_role("button", name=re.compile(r"^Send")).last)
                else:
                    page.keyboard.press("Enter")

            def composer(page):
                box = page.locator("textarea:visible, [contenteditable='true']:visible").last
                box.wait_for(state="visible", timeout=8000)
                return box

            def send_in_space(page):
                text = f"Audit message {tag}: the seals arrived."
                box = composer(page)
                press(box)
                page.keyboard.type(text, delay=5)
                send(page)
                page.get_by_text(text).first.wait_for(timeout=8000)
                page.reload()
                vca.settle(page)
                n = page.get_by_text(text).count()
                assert n == 1, f"after a reload the message shows {n} times"
            check.run("send a message in a space, reload", open_at("/projects/{pe}"), send_in_space)

            def send_dm(page):
                text = f"Audit DM {tag}: ladder is in the shed."
                box = composer(page)
                press(box)
                page.keyboard.type(text, delay=5)
                send(page)
                page.get_by_text(text).first.wait_for(timeout=8000)
                page.reload()
                vca.settle(page)
                assert page.get_by_text(text).count() == 1, "the DM is not there exactly once after a reload"
            check.run("send a direct message, reload", open_at("/dm/{dm}"), send_dm)

            def thread_reply(page):
                text = f"Audit reply {tag}: same on bed 4."
                box = composer(page)
                press(box)
                page.keyboard.type(text, delay=5)
                send(page)
                page.get_by_text(text).first.wait_for(timeout=8000)
                page.reload()
                vca.settle(page)
                assert page.get_by_text(text).count() >= 1, "the reply is gone after a reload"
            check.run("reply in a thread, reload", open_at("/projects/{p}/conversations/{conv}"), thread_reply)

            def create_task(page):
                title = f"Audit task {tag} check the gate latch"
                if touch:
                    page.locator(".phone-fab").first.tap()
                else:
                    page.keyboard.press("c")
                page.locator("[role='dialog']").first.wait_for(timeout=6000)
                if touch:  # the phone's Create sheet lists the five types first
                    press(page.locator("[role='dialog']").get_by_text("Task", exact=True).first)
                field = page.locator("[role='dialog']").get_by_placeholder(re.compile("What needs doing")).first
                press(field)
                page.keyboard.type(title, delay=5)
                press(page.locator("[role='dialog']").get_by_role("button", name=re.compile(r"^Create task")).first)
                page.wait_for_timeout(1500)
                toast = page.get_by_text(re.compile(r"Task #\d+ created")).count()
                api = api_for(browser, data, "ada")
                where = ""
                for project in vca.items(call(api, "GET", f"/api/v1/workspaces/{ids['ws']}/projects")):
                    if any(t["title"] == title for t in vca.items(call(api, "GET", f"/api/v1/projects/{project['id']}/work?limit=100"))):
                        where = project["id"]
                assert where, "the task was not saved"
                page.goto(ORIGIN + f"/projects/{where}/tasks?view=list")
                vca.settle(page)
                assert page.get_by_text(title).count() >= 1, "the new task is not listed after a reload"
                return f"toast “Task #N created”: {bool(toast)}; listed at {page.url.replace(ORIGIN, '')}"
            check.run("create a task from Create, find it after a reload", open_at("/" if touch else "/projects/{pe}"), create_task)

            def task_state(page):
                if touch:
                    raise RuntimeError("the 1–5 keys are computer only")
                panel_title = page.locator("[role='dialog'], aside").first
                panel_title.wait_for(timeout=6000)
                page.locator("body").click(position={"x": 2, "y": 300})
                page.goto(ORIGIN + f"/projects/{ids['p2']}/tasks?view=list")
                vca.settle(page)
                row = page.get_by_text("Label every drawer in the tool wall").first
                press(row)
                page.wait_for_timeout(900)
                page.keyboard.press("2")
                page.wait_for_timeout(1200)
                state = call(api_for(browser, data, "ada"), "GET", f"/api/v1/projects/{ids['p2']}/work?limit=100")
                status = next((t.get("status") for t in vca.items(state) if t["title"] == "Label every drawer in the tool wall"), None)
                page.reload()
                vca.settle(page)
                assert status not in (None, "open"), f"key 2 left the task {status}"
                return f"status {status} after key 2, kept after reload"
            check.run("1–5 set a task's state, reload", open_at("/projects/{p2}/tasks?view=board&open=work:{task}"), task_state)

            def inbox_done_undo(page):
                rows = page.locator("[role='listitem'], [role='option'], .inbox-row, li").filter(has=page.locator("button, a"))
                first = page.locator("main").inner_text()[:200]
                if touch:
                    raise RuntimeError("E/Z keys are computer only")
                page.keyboard.press("j")
                page.keyboard.press("e")
                page.wait_for_timeout(900)
                toast = page.get_by_role("button", name=re.compile("^Undo", re.I))
                saw_toast = toast.count() > 0
                page.keyboard.press("z")
                page.wait_for_timeout(1200)
                page.reload()
                vca.settle(page)
                again = page.locator("main").inner_text()[:200]
                assert again == first, f"Done + Undo did not bring the item back after a reload: {first[:80]!r} vs {again[:80]!r}"
                return f"undo toast shown: {saw_toast}; rows {rows.count()}"
            check.run("Inbox E (Done) then Z (Undo), reload", open_at("/inbox"), inbox_done_undo)

            def theme_choice(page):
                dark = page.get_by_role("radio", name=re.compile("^Dark")).first
                if not dark.count():
                    dark = page.get_by_role("button", name=re.compile("^Dark")).first
                press(dark)
                page.wait_for_timeout(600)
                page.reload()
                vca.settle(page)
                theme = page.evaluate("() => document.documentElement.dataset.theme || getComputedStyle(document.body).backgroundColor")
                system = page.get_by_role("radio", name=re.compile("^(System|Automatic|Match)")).first
                if system.count():
                    press(system)
                    page.wait_for_timeout(400)
                assert theme in ("dark",) or theme.startswith("rgb(1") or theme.startswith("rgb(2") is False, f"theme after reload: {theme}"
                return f"after reload: {theme}"
            check.run("Settings › Appearance › Dark, reload", open_at("/settings/appearance", who="piotr"), theme_choice)

            def wiki_edit(page):
                text = f"Audit line {tag}."
                editor = page.locator(".ProseMirror, [contenteditable='true']").first
                editor.wait_for(timeout=8000)
                press(editor)
                page.keyboard.press("Control+End")
                page.keyboard.press("Enter")
                page.keyboard.type(text, delay=5)
                page.wait_for_timeout(2500)
                done = page.get_by_role("button", name=re.compile(r"^(Done|Save)$")).first
                if done.count():
                    press(done)
                    page.wait_for_timeout(1500)
                page.reload()
                vca.settle(page)
                assert page.get_by_text(text).count() >= 1, "the Wiki line is gone after a reload"
            check.run("edit a Wiki page, reload", open_at("/projects/{pl}/docs"), wiki_edit)

            def agent_message(page):
                text = f"Audit question {tag}: what is left this week?"
                box = composer(page)
                press(box)
                page.keyboard.type(text, delay=5)
                send(page)
                page.get_by_text(text).first.wait_for(timeout=8000)
                page.wait_for_timeout(3000)
                page.reload()
                vca.settle(page)
                assert page.get_by_text(text).count() == 1, "the message to the Assistant is not there exactly once after a reload"
            check.run("ask the Assistant, reload", open_at("/agents/{assistant}"), agent_message)

            def sidebar_kept(page):
                if touch:
                    raise RuntimeError("the sidebar is computer only")
                page.keyboard.press("[")
                page.wait_for_timeout(600)
                collapsed = page.evaluate("() => (document.querySelector('nav, aside') || document.body).getBoundingClientRect().width")
                page.reload()
                vca.settle(page)
                after = page.evaluate("() => (document.querySelector('nav, aside') || document.body).getBoundingClientRect().width")
                page.keyboard.press("[")
                assert abs(after - collapsed) < 2, f"collapsed sidebar {collapsed}px came back at {after}px after a reload"
            check.run("[ collapses the sidebar, kept after a reload", open_at("/", who="piotr"), sidebar_kept)

            def map_thought(page):
                text = f"Audit thought {tag}"
                if touch:  # the phone's map is for viewing and adding a thought (S15): one "Add a thought" button
                    press(page.get_by_role("button", name="Add a thought"))
                else:
                    press(page.get_by_role("toolbar", name="Map tools").get_by_role("button", name="Thought", exact=True))
                field = page.get_by_role("form", name="New thought draft").get_by_label("Thought text")
                field.wait_for(timeout=6000)
                field.type(text, delay=5)
                field.press("Enter")
                page.wait_for_timeout(1500)
                page.reload()
                vca.settle(page)
                assert page.get_by_text(text).count() >= 1, "the new thought is gone after a reload"
            check.run("add a thought on My map, reload", open_at("/map"), map_thought)
    browser.close()


_apis: dict = {}


def api_for(browser, data, who):
    if who not in _apis:
        _apis[who] = browser.new_context(base_url=ORIGIN, storage_state=data["states"][who], service_workers="block")
    return _apis[who]


# ---------------------------------------------------------------------------------------------------------------
# Phase: mob (MOB-1 … MOB-7 in emulation)
# ---------------------------------------------------------------------------------------------------------------

STANDALONE = r"""
Object.defineProperty(navigator, 'standalone', {get: () => true});
const realMatch = window.matchMedia.bind(window);
window.matchMedia = (q) => /display-mode:\s*standalone/.test(q)
  ? {matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; }}
  : realMatch(q);
"""


def phase_mob(pw, engine: str, data: dict) -> None:
    browser = getattr(pw, engine).launch()
    ids = data["ids"]
    with (OUT / f"results-mob-{engine}{TAG}.jsonl").open("w", encoding="utf-8") as sink:
        for win in ("390", "820p"):
            touch = True
            check = Check(sink, "mob", engine, win)
            open_at = lambda path="/", who="ada", workers="allow", init="": opener(pw, browser, engine, win, data, who=who, path=path, workers=workers, init=init)  # noqa: E731
            tag = f"{engine}-{win}-{uuid.uuid4().hex[:4]}"

            def manifest(page):
                href = page.evaluate("() => document.querySelector('link[rel=manifest]')?.href")
                assert href, "no manifest link"
                body = page.request.get(href).json()
                problems = []
                for key in ("name", "short_name", "start_url", "display", "icons", "id", "scope", "theme_color", "background_color"):
                    if not body.get(key):
                        problems.append(f"no {key}")
                if body.get("display") not in ("standalone", "fullscreen", "minimal-ui"):
                    problems.append(f"display {body.get('display')}")
                sizes = {s for icon in body.get("icons", []) for s in icon.get("sizes", "").split()}
                for need in ("192x192", "512x512"):
                    if need not in sizes:
                        problems.append(f"no {need} icon")
                if not any("maskable" in icon.get("purpose", "") for icon in body.get("icons", [])):
                    problems.append("no maskable icon")
                for icon in body.get("icons", []):
                    status = page.request.get(urllib.parse.urljoin(href, icon["src"])).status
                    if status != 200:
                        problems.append(f"icon {icon['src']} {status}")
                apple = page.evaluate("() => [...document.querySelectorAll('link[rel=apple-touch-icon]')].map(l => l.href)")
                if not apple:
                    problems.append("no apple-touch-icon")
                meta = page.evaluate("() => ({capable: document.querySelector('meta[name=apple-mobile-web-app-capable], meta[name=mobile-web-app-capable]')?.content, viewport: document.querySelector('meta[name=viewport]')?.content})")
                assert not problems, "; ".join(problems)
                return f"{body.get('name')} / {body.get('short_name')}, display {body.get('display')}, icons {sorted(sizes)}, apple {len(apple)}, meta {meta}"
            check.run("MOB-1 manifest, icons, Apple meta", open_at("/sign-in", who="anon"), manifest)

            def worker(page):
                ok = page.evaluate("() => navigator.serviceWorker ? navigator.serviceWorker.ready.then(r => !!r.active) : false")
                assert ok, "no active service worker"
                return page.evaluate("() => navigator.serviceWorker.controller ? 'controls the page' : 'active, not yet controlling'")
            check.run("MOB-1 service worker registers", open_at(), worker)

            def offline_navigation(page):
                page.evaluate("() => navigator.serviceWorker.ready")
                page.reload()
                vca.settle(page)
                page.evaluate("() => navigator.serviceWorker.ready")
                page.context.set_offline(True)
                try:
                    page.goto(ORIGIN + f"/projects/{ids['p']}/tasks", wait_until="domcontentloaded", timeout=15000)
                except Exception as error:
                    page.context.set_offline(False)
                    raise RuntimeError(f"the engine did not hand the offline navigation to the service worker: {str(error).splitlines()[0][:160]}")
                page.wait_for_timeout(1200)
                text = page.inner_text("body")
                page.context.set_offline(False)
                assert re.search(r"offline|no connection|not connected|internet", text, re.I), f"offline navigation showed: {text[:160]!r}"
                return text.strip()[:120]
            check.run("MOB-5 offline navigation shows the offline page", open_at(), offline_navigation)

            def offline_inapp(page):
                page.context.set_offline(True)
                link = page.get_by_role("link", name=re.compile("^Inbox")).first
                link.tap() if link.count() else page.goto(ORIGIN + "/inbox")
                page.wait_for_timeout(2500)
                text = page.inner_text("body")
                said = ERROR_WORDS.search(text)
                retry = page.get_by_role("button", name=re.compile(r"^(Try again|Retry)", re.I))
                path = OUT / "mob" / f"{engine}-{win}" / "offline-inapp-offline.png"
                path.parent.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(path))
                page.context.set_offline(False)
                if retry.count():
                    retry.first.tap()
                    page.wait_for_timeout(1500)
                assert said or retry.count(), "nothing said the page could not be loaded while offline"
                return f"said {said.group(0) if said else None!r}, retry buttons {retry.count()}"
            check.run("MOB-5 in-app read offline says so, Retry recovers", open_at("/"), offline_inapp)

            def offline_send(page):
                text = f"Offline audit {tag}: sent from the field."
                box = page.locator("textarea:visible, [contenteditable='true']:visible").last
                box.wait_for(timeout=8000)
                box.tap()
                page.context.set_offline(True)
                page.keyboard.type(text, delay=5)
                page.get_by_role("button", name=re.compile(r"^Send")).last.tap()
                page.wait_for_timeout(2500)
                pending = page.locator("body").inner_text()
                path = OUT / "mob" / f"{engine}-{win}" / "offline-send-pending.png"
                path.parent.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(path))
                page.context.set_offline(False)
                page.evaluate("() => window.dispatchEvent(new Event('online'))")
                page.wait_for_timeout(6000)
                page.reload()
                vca.settle(page)
                n = page.get_by_text(text).count()
                assert n == 1, f"after reconnecting and a reload the message shows {n} times"
                return "pending line: " + ("yes" if re.search(r"not sent|waiting|sending|retry|offline", pending, re.I) else "no")
            check.run("MOB-5 a message sent offline goes out once", open_at("/projects/{pe}"), offline_send)

            def standalone(page):
                page.wait_for_timeout(500)
                text = page.inner_text("body")
                assert "Sign in" not in text[:200], "the standalone launch asked to sign in"
                flags = page.evaluate("() => ({standalone: navigator.standalone, media: matchMedia('(display-mode: standalone)').matches})")
                page.goto(ORIGIN + "/settings/appearance")
                vca.settle(page)
                install = page.get_by_text(re.compile("Install Flux|Add to Home Screen")).count()
                assert install == 0, "an installed app still offers to install"
                return f"{flags}, url {page.url.replace(ORIGIN, '')}"
            check.run("MOB-1 standalone launch keeps the session, no install row", open_at("/", init=STANDALONE), standalone)

            def deep_link(page):
                target = f"/projects/{ids['p']}/tasks"
                page.goto(ORIGIN + target)
                vca.settle(page)
                assert "sign-in" in page.url, f"signed out, the link opened {page.url}"
                page.get_by_label(re.compile("^Email", re.I)).first.fill("ada@demo.flux.test")
                page.get_by_label(re.compile("^Password", re.I)).first.fill(vca.DEMO["ada"][2])
                page.get_by_role("button", name=re.compile("^(Sign in|Continue)$")).first.tap()
                page.wait_for_url(re.compile(r".*/projects/.*/tasks.*"), timeout=15000)
                return page.url.replace(ORIGIN, "")
            check.run("MOB-1 deep link through sign-in opens the right place", open_at(None, who="anon"), deep_link)

            def rotate(page):
                text = f"Draft across rotation {tag}"
                box = page.locator("textarea:visible, [contenteditable='true']:visible").last
                box.wait_for(timeout=8000)
                box.tap()
                page.keyboard.type(text, delay=5)
                size = page.viewport_size
                # The on-screen keyboard: the window loses about 45 % of its height while the field has focus.
                page.set_viewport_size({"width": size["width"], "height": int(size["height"] * 0.55)})
                page.wait_for_timeout(500)
                send = page.get_by_role("button", name=re.compile("^Send")).first
                send_ok = send.count() and send.is_visible() and (send.bounding_box() or {}).get("y", 9999) + 10 < int(size["height"] * 0.55)
                page.set_viewport_size({"width": size["height"], "height": size["width"]})
                page.wait_for_timeout(600)
                page.set_viewport_size(size)
                page.wait_for_timeout(600)
                kept = page.locator("textarea:visible, [contenteditable='true']:visible").last
                value = kept.input_value() if kept.evaluate("e => 'value' in e") else kept.inner_text()
                assert text in value, f"the draft was lost: {value[:80]!r}"
                assert send_ok, "Send was not visible above the simulated on-screen keyboard"
            check.run("MOB-2 draft and Send survive the keyboard and rotation", open_at("/projects/{pe}"), rotate)

            def reconnect(page):
                texts = [f"While away {tag} #{i}" for i in (1, 2)]
                page.context.set_offline(True)
                page.evaluate("() => { Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'}); document.dispatchEvent(new Event('visibilitychange')); }")
                for text in texts:
                    call(api_for(browser, data, "jonas"), "POST", f"/api/v1/dms/{ids['dm']}/messages", {"body": text, "clientMessageId": str(uuid.uuid4())})
                page.wait_for_timeout(8000)
                page.context.set_offline(False)
                page.evaluate("() => { Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'visible'}); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus')); }")
                deadline = time.time() + 20
                while time.time() < deadline and not all(page.get_by_text(t).count() for t in texts):
                    page.wait_for_timeout(500)
                counts = [page.get_by_text(t).count() for t in texts]
                assert counts == [1, 1], f"after coming back the messages show {counts} times (no reload)"
                return "both messages once, without a reload"
            check.run("MOB-5 back after the connection dropped: caught up, no duplicates", open_at("/dm/{dm}"), reconnect)

            offer = f"localStorage.setItem('flux:push-offer:{ids.get('me_ada', '')}', JSON.stringify({{ready: true}}));"

            def push_answer(expected: str):
                def fn(page):
                    card = page.locator("section.push-offer")
                    card.wait_for(timeout=8000)
                    title = card.locator("h3").inner_text()
                    turn_on = card.get_by_role("button", name="Turn on")
                    if not turn_on.count():
                        assert expected == "home-screen", f"the offer has no Turn on: {title!r}"
                        return f"{title!r} (the Home Screen steps: Safari without an installed app)"
                    turn_on.tap()
                    page.wait_for_timeout(2500)
                    after = page.inner_text("body")
                    if expected == "granted":
                        assert "Notifications are on for this device" in after, f"no confirmation after a grant: {after[:160]!r}"
                        assert not page.locator("section.push-offer").count(), "the card stayed after a grant"
                        page.goto(ORIGIN + "/settings/notifications")
                        vca.settle(page)
                        return f"{title!r} → Turn on → granted → toast; Settings › Notifications: " + page.inner_text("main")[:160].replace("\n", " · ")
                    blocked = page.locator("section.push-offer h3").inner_text() if page.locator("section.push-offer").count() else ""
                    assert "blocked" in blocked, f"after a denial the card says {blocked!r}"
                    page.goto(ORIGIN + "/settings/notifications")
                    vca.settle(page)
                    settings = page.inner_text("main")
                    assert re.search(r"blocked|Allow|allow", settings), "Settings › Notifications does not say how to allow again"
                    return f"{title!r} → Turn on → denied → {blocked!r}; Settings says how to allow"
                return fn
            want = "home-screen" if engine == "webkit" else "granted"
            check.run("MOB-4 push offer → Turn on → allowed (stubbed permission)", open_at("/", init=offer + push_stub("granted")), push_answer(want))
            want = "home-screen" if engine == "webkit" else "denied"
            check.run("MOB-4 push offer → Turn on → blocked, and the way back", open_at("/", init=offer + push_stub("denied")), push_answer(want))

            def settings_notifications(page):
                text = page.inner_text("main") if page.locator("main").count() else page.inner_text("body")
                return text.strip().replace("\n", " · ")[:200]
            check.run("MOB-4 Settings › Notifications on this device", open_at("/settings/notifications"), settings_notifications)
    browser.close()


# ---------------------------------------------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------------------------------------------

def load(pattern: str) -> list:
    """Every record of the matching results files, oldest file first; a cell measured again (a later tagged run) keeps its newest record."""
    newest: dict = {}
    for path in sorted(OUT.glob(pattern), key=lambda p: p.stat().st_mtime):
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            key = (rec.get("kind", "capture"), rec.get("screen") or rec.get("name"), rec.get("engine"), rec.get("theme"), rec.get("vp"))
            newest.pop(key, None)
            newest[key] = rec
    return list(newest.values())


def report(pw) -> None:
    capture = load("results-capture-*.jsonl") + load("results-firstrun.jsonl")
    # What lies under an open menu's or dialog's own backdrop is meant to: those occlusion flags are not findings.
    backdrop = re.compile(r"scrim|backdrop|overlay__bg|sheet__veil", re.I)
    for r in capture:
        r["flags"] = [f for f in r.get("flags", []) if not (f["rule"] == "f" and backdrop.search(f["detail"]))]
    states = load("results-states-*.jsonl")
    a11y = load("results-a11y-*.jsonl")
    checks = load("results-keys-*.jsonl") + load("results-journeys-*.jsonl") + load("results-mob-*.jsonl")
    sha = os.environ.get("FLUX_UIAUDIT_SHA", "")
    # Matrix: one row per screen, one column per window; a cell is "engines×themes passed / flagged / not reached".
    screens = list(dict.fromkeys(r["screen"] for r in capture))
    wins = [w for w in WINDOWS if any(r["vp"] == w for r in capture)]
    cells: dict = {}
    for r in capture:
        cells.setdefault((r["screen"], r["vp"]), []).append(r)

    def cell(rs: list) -> str:
        if not rs:
            return "·"
        if all(r.get("na") for r in rs):
            return "N/A"
        if any(r.get("failed") for r in rs):
            return "FAIL"
        if all(r.get("skipped") for r in rs):
            return "no data"
        n2 = sum(1 for r in rs for f in r.get("flags", []) if f["prio"] == "P2")
        un = sum(1 for r in rs if r.get("unreachable"))
        done = sum(1 for r in rs if r.get("shot") and not r.get("na"))
        mark = f"{done}" + (f" ⚠{n2}" if n2 else "") + (f" ✗{un}" if un else "")
        return mark
    lines = [f"# UI audit matrix ({sha})", "", "Cell: captures done (engines × themes), ⚠ P2 flags, ✗ state not reached; N/A: the screen does not exist at that window.", "",
             "| Screen | " + " | ".join(wins) + " |", "| --- | " + " | ".join("---" for _ in wins) + " |"]
    for s in screens:
        lines.append(f"| {s} | " + " | ".join(cell(cells.get((s, w), [])) for w in wins) + " |")
    (OUT / "matrix.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    # Findings, deduplicated across windows, themes and engines.
    groups: dict = {}
    for r in capture:
        for f in r.get("flags", []):
            key = (f["rule"], r["screen"], f.get("sig", ""), vca.normalise(f["detail"]))
            g = groups.setdefault(key, {"rule": f["rule"], "prio": f["prio"], "screen": r["screen"], "sig": f.get("sig", ""), "label": f.get("label", ""),
                                        "detail": f["detail"], "where": [], "shot": f.get("shot") or r.get("annot") or r.get("shot")})
            if f["prio"] == "P2" and g["prio"] != "P2":
                g.update(prio="P2", detail=f["detail"], shot=f.get("shot") or r.get("annot") or r.get("shot"))
            g["where"].append(f"{r['engine']}/{r['theme']}/{r['vp']}")
    findings = sorted(groups.values(), key=lambda g: (g["prio"], g["rule"], g["screen"], g["sig"]))
    (OUT / "findings.json").write_text(json.dumps(findings, indent=1, ensure_ascii=False), encoding="utf-8")
    out = [f"# UI audit findings ({sha})", ""]
    visits = [r for r in capture if r.get("shot")]
    out.append(f"{len(visits)} captures of {len(screens)} screens; {len(findings)} distinct measured findings "
               f"({sum(1 for f in findings if f['prio'] == 'P2')} P2, {sum(1 for f in findings if f['prio'] == 'P3')} P3).")
    out += ["", "## Not captured or state not reached", ""]
    for r in capture:
        if r.get("failed") or r.get("unreachable") or r.get("skipped"):
            out.append(f"- {r['screen']} {r['engine']}/{r['theme']}/{r['vp']}: {r.get('failed') or r.get('unreachable') or r.get('skipped')}")
    errors = {}
    for r in capture:
        for e in r.get("errors") or []:
            errors.setdefault(e[:140], []).append(f"{r['screen']} {r['engine']}/{r['vp']}")
    if errors:
        out += ["", "## Uncaught page errors", ""] + [f"- `{e}` — {len(w)}×: {', '.join(w[:5])}" for e, w in errors.items()]
    out += ["", "## Loading and error states", ""]
    for r in states:
        e = r.get("error") or {}
        verdict = ("FAIL " + r["failed"]) if r.get("failed") else r.get("note") or (
            f"loading busy={r.get('loading', {}).get('busy')}; error said={e.get('said')!r} retry={e.get('retry')} recovered={e.get('recovered')}")
        out.append(f"- {r['screen']} {r['engine']}/{r['theme']}/{r['vp']}: {verdict}")
    out += ["", "## Focus, 200 % text, reduced motion", ""]
    for r in a11y:
        bits = []
        if r.get("focus_unseen"):
            bits.append(f"no visible focus on {r['focus_unseen']}")
        if r.get("focus_offscreen"):
            bits.append(f"focus off screen on {r['focus_offscreen']}")
        if r.get("motion_reduce"):
            bits.append(f"moving while reduced: {[m['name'] + ' ' + m['target'] for m in r['motion_reduce']][:4]}")
        if (r.get("text200") or {}).get("hscroll"):
            bits.append(f"200 % text scrolls sideways: {r['text200']['hscroll']}")
        if (r.get("text200") or {}).get("clipped"):
            bits.append(f"200 % text clipped: {r['text200']['clipped'][:3]}")
        if r.get("transitions"):
            bits.append(f"transitions of layout/colour properties: {r['transitions'][:6]}")
        if r.get("failed"):
            bits.append("FAILED " + r["failed"])
        if bits:
            out.append(f"- {r['screen']} {r['engine']}/{r['theme']}/{r['vp']}: " + "; ".join(bits))
    out += ["", "## Shortcuts, journeys and MOB checks", "", "| Check | Engine | Window | Result | Detail |", "| --- | --- | --- | --- | --- |"]
    for r in checks:
        out.append(f"| {r['kind']}: {r['name']} | {r['engine']} | {r['vp']} | {r['result']} | {str(r.get('detail', '')).replace('|', '/')[:200]} |")
    out += ["", "## Measured findings", ""]
    for f in findings:
        where = sorted(set(f["where"]))
        out.append(f"- **{f['prio']} ({f['rule']})** {f['screen']} — {f['detail']} — `{f['sig']}`" + (f" \"{f['label']}\"" if f["label"] else "")
                   + f" — {len(where)}×: {', '.join(where[:6])}{' …' if len(where) > 6 else ''} — {f['shot']}")
    (OUT / "findings.md").write_text("\n".join(out) + "\n", encoding="utf-8")
    summary = {"sha": sha, "captures": len(visits), "screens": len(screens), "windows": wins, "findings": len(findings),
               "p2": sum(1 for f in findings if f["prio"] == "P2"), "checks": {k: sum(1 for r in checks if r["result"] == k) for k in ("pass", "fail", "unreachable")},
               "states": len(states), "a11y": len(a11y)}
    (OUT / "summary.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
    # Contact sheets: every screen of one engine/theme/window on one page.
    sheets = OUT / "sheets"
    sheets.mkdir(exist_ok=True)
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={"width": 1800, "height": 1000})
    for engine, theme, vp in sorted({(r["engine"], r["theme"], r["vp"]) for r in visits}):
        recs = [r for r in visits if (r["engine"], r["theme"], r["vp"]) == (engine, theme, vp)]
        width = WINDOWS[vp]["width"]
        cols = 8 if width <= 430 else 4 if width <= 1280 else 3 if width <= 1920 else 2
        tile = int(1760 / cols) - 12
        figures = "".join(f'<figure><img src="file://{OUT / r["shot"]}" style="width:{tile}px"><figcaption>{html.escape(r["screen"])}</figcaption></figure>' for r in recs)
        doc = (f"<html><body style='margin:12px;background:#888;font:12px monospace'><h3>{engine} {theme} {vp}</h3>"
               f"<div style='display:grid;grid-template-columns:repeat({cols},{tile}px);gap:12px'>{figures}</div>"
               "<style>figure{margin:0}figcaption{background:#fff;padding:2px 4px}img{display:block;border:1px solid #333}</style></body></html>")
        sheet = sheets / f"{engine}-{theme}-{vp}.html"
        sheet.write_text(doc, encoding="utf-8")
        try:
            page.goto(f"file://{sheet}")
            page.wait_for_timeout(400)
            page.screenshot(path=str(sheets / f"{engine}-{theme}-{vp}.jpg"), full_page=True, type="jpeg", quality=70)
        except Exception as error:
            print(f"sheet {sheet.name}: {error}", flush=True)
    browser.close()
    print(f"report: {json.dumps(summary)}", flush=True)


# ---------------------------------------------------------------------------------------------------------------

def child(args: list[str]) -> subprocess.Popen:
    env = dict(os.environ)
    return subprocess.Popen([sys.executable, __file__, *args], env=env)


def main() -> int:
    if UPSTREAM and len(sys.argv) == 1:  # the children use the parent's forwarder
        start_forwarder(ORIGIN, UPSTREAM)
    OUT.mkdir(parents=True, exist_ok=True)
    if len(sys.argv) > 1:  # a child process: one phase for one engine (and theme)
        phase, engine, *rest = sys.argv[1:]
        data = json.loads((OUT / "seed.json").read_text(encoding="utf-8"))
        with sync_playwright() as pw:
            try:
                if phase == "capture":
                    capture_combo(pw, engine, rest[0], data, int(rest[1]), int(rest[2]))
                elif phase == "states":
                    phase_states(pw, engine, data)
                elif phase == "a11y":
                    phase_a11y(pw, engine, data)
                elif phase == "keys":
                    phase_keys(pw, engine, data)
                elif phase == "journeys":
                    phase_journeys(pw, engine, data)
                elif phase == "mob":
                    phase_mob(pw, engine, data)
            except Exception:
                traceback.print_exc()
                return 1
        return 0
    with sync_playwright() as pw:
        if "firstrun" in PHASES:
            phase_firstrun(pw)
        data_file = OUT / "seed.json"
        if "seed" in PHASES and not data_file.exists():
            browser = pw.chromium.launch()
            data = seed(browser)
            browser.close()
            data_file.write_text(json.dumps(data), encoding="utf-8")
    if not (OUT / "seed.json").exists():
        return 0 if PHASES == ["firstrun"] else 1

    def run_parallel(jobs: list[list[str]]) -> None:
        running: list[subprocess.Popen] = []
        for job in jobs:
            while len([p for p in running if p.poll() is None]) >= PARALLEL:
                time.sleep(2)
            running.append(child(job))
        for p in running:
            p.wait()

    if "capture" in PHASES:
        chunks = max(1, min(CHUNKS, len(WINDOW_NAMES)))
        run_parallel([["capture", e, t, str(c), str(chunks)] for c in range(chunks) for e in BROWSERS for t in THEMES])
    read_only = [ph for ph in ("states", "a11y", "keys") if ph in PHASES]
    if read_only:
        run_parallel([[ph, e] for ph in read_only for e in BROWSERS])
    # The journeys and MOB checks change data: one engine after the other, after everything that only reads.
    for ph in ("journeys", "mob"):
        if ph in PHASES:
            for e in BROWSERS:
                child([ph, e]).wait()
    if "report" in PHASES:
        with sync_playwright() as pw:
            report(pw)
    return 0


if __name__ == "__main__":
    sys.exit(main())
