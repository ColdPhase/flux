"""Render and audit the O-003 variants in Docker Playwright (light theme, plus a dark-theme text pass for C).

Run from the repository root:
  docker run --rm -v "$PWD/docs/design/proposals/o-003-ui-direction:/work" -w /work \
    mcr.microsoft.com/playwright/python:v1.62.0-noble python3 tools/audit.py

Writes screenshots/ and audit.json. Measurements are automated evidence about the
static prototypes; they do not certify production behavior.
"""

import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / "screenshots"
VARIANTS = {"a": "variant-a-return-ledger.html", "b": "variant-b-state-board.html",
            "c": "variant-c-calm-messenger.html"}
# Extra interactive states for C, rendered and audited like the default view. The default identity is "rail"
# (founder decision, 2026-09-27); a state starting with "accent" uses ?identity=accent. Other names are URL hashes.
STATES = {"c": [
    # Shared export (Tide): return, details, views
    (1440, 900, "since"), (1440, 900, "result"), (1440, 900, "agent-test"), (1280, 800, "decision"),
    (1024, 768, "details"), (1024, 768, "nav"), (768, 1024, "nav"), (390, 844, "details"), (390, 844, "sources"),
    (390, 844, "nav"), (360, 780, "nav"), (390, 844, "since"), (1440, 900, "details"), (1440, 900, "tasks"),
    (1440, 900, "map"), (1280, 800, "map-list"), (1024, 768, "docs"), (390, 844, "tasks"), (390, 844, "map"),
    (360, 780, "docs"), (1440, 900, "capture"), (390, 844, "capture"),
    # #44 scenario: DM with Kai -> select messages -> sketch -> new two-person project
    (1440, 900, "dm"), (1440, 900, "dm-select"), (1440, 900, "dm-sketch"), (1440, 900, "dm-promote"), (1440, 900, "lamp-new"),
    (768, 1024, "dm-select"), (390, 844, "dm"), (390, 844, "dm-select"), (390, 844, "dm-sketch"), (390, 844, "dm-promote"),
    (390, 844, "lamp-new"),
    # Map as a thinking surface: branching sketch, selection, editing, list alternative
    (1440, 900, "lamp-map"), (1440, 900, "lamp-map-select"), (1440, 900, "lamp-map-edit"), (1280, 800, "lamp-map-list"),
    (1024, 768, "lamp-map"), (768, 1024, "lamp-map"), (390, 844, "lamp-map"), (390, 844, "lamp-map-select"),
    (390, 844, "lamp-map-edit"), (390, 844, "lamp-map-list"), (360, 780, "lamp-map"),
    # #57 personal assistant: reader of Kai's assistant, owner asking, answer, no assistant
    (1440, 900, "lamp"), (1440, 900, "lamp-ask"), (1440, 900, "lamp-answer"), (1440, 900, "lamp-noai"),
    (1440, 900, "kai-assistant"), (1440, 900, "lamp-connect"), (768, 1024, "lamp"), (390, 844, "lamp"),
    (390, 844, "lamp-ask"), (390, 844, "lamp-answer"), (390, 844, "lamp-noai"), (390, 844, "kai-assistant"),
    # Identity alternative "accent" (?identity=accent)
    (1440, 900, "accent"), (1280, 800, "accent"), (1024, 768, "accent"), (390, 844, "accent"),
    (1440, 900, "accent-details"), (390, 844, "accent-details"), (768, 1024, "accent-nav"), (390, 844, "accent-nav"),
    (360, 780, "accent-nav"), (1440, 900, "accent-lamp-map"), (390, 844, "accent-dm-select")]}
# Variants that also get the zoom, keyboard-focus and reduced-motion checks with a query string.
EXTRA_QUERIES = {"c": {"accent": "?identity=accent"}}
# Dark theme (prefers-color-scheme: dark): text contrast and text size for these states, in both identities.
DARK_STATES = {"c": [(1440, 900, s) for s in ("", "since", "details", "sources", "agent-test", "map", "tasks", "docs",
                                              "capture", "dm-select", "dm-sketch", "lamp-map", "dm-promote", "lamp-new", "lamp",
                                              "lamp-map-select", "lamp-map-edit", "lamp-map-list", "lamp-ask",
                                              "lamp-answer", "lamp-noai", "kai-assistant", "lamp-connect")]
                    + [(390, 844, s) for s in ("", "details", "nav", "dm-select", "lamp", "lamp-map", "lamp-ask")]}
DARK_SHOTS = {"", "lamp", "lamp-map", "dm-select"}


def target(state):
    """URL suffix for a state: "accent" / "accent-<hash>" select ?identity=accent; anything else is a hash."""
    if state == "accent" or state.startswith("accent-"):
        rest = state[7:]
        return "?identity=accent" + (f"#{rest}" if rest else "")
    return f"#{state}" if state else ""

VIEWPORTS = [(1440, 900), (1280, 800), (1024, 768), (768, 1024), (390, 844), (360, 780)]

TEXT_AUDIT = r"""() => {
  const parse = c => { const m = c.match(/[\d.]+/g); return m ? m.map(Number) : [0,0,0,0]; };
  const lum = ([r,g,b]) => { const f = v => { v /= 255; return v <= .03928 ? v/12.92 : ((v+.055)/1.055) ** 2.4; };
    return .2126*f(r) + .7152*f(g) + .0722*f(b); };
  const bgOf = el => { for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor);
      if ((c[3] ?? 1) > .5 && !(c.length === 4 && c[3] === 0)) return c; } return [255,255,255,1]; };
  const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > .2 &&
      !(s.clip === 'rect(0px, 0px, 0px, 0px)' || (r.width <= 1 && r.height <= 1)); };
  const out = [], small = [];
  for (const e of document.querySelectorAll('body *')) {
    const own = [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!own || !visible(e)) continue;
    const s = getComputedStyle(e), size = parseFloat(s.fontSize), weight = +s.fontWeight || 400;
    const fg = parse(s.color), bg = bgOf(e);
    const a = lum(fg), b = lum(bg), ratio = (Math.max(a,b) + .05) / (Math.min(a,b) + .05);
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const text = e.textContent.trim().replace(/\s+/g, ' ').slice(0, 40);
    if (ratio < need) out.push({text, ratio: +ratio.toFixed(2), need, color: s.color, background: `rgb(${bg.slice(0,3)})`});
    if (size < 12) small.push({text, size, tag: e.tagName.toLowerCase(), aria_hidden: !!e.closest('[aria-hidden="true"]')});
  }
  return {contrast_failures: out, small_text: small};
}"""

# Accepted criterion (AC-3): on a coarse pointer every primary target is at least 44 x 44 CSS px.
# Documented exceptions, by selector (reported per state in audit.json as "target_exceptions"):
TARGET_EXCEPTIONS = {
    ".ref": (24, "inline reference inside a sentence or evidence line: WCAG 2.5.8 inline exception, 24 x 24 px minimum"),
    ".skip": (0, "skip link: off-screen and not a touch target; shown only on keyboard focus"),
}
TARGET_AUDIT = r"""(ex) => [...document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])')]
  .filter(e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width > 1 && r.height > 1 && !e.closest('[inert]') && s.visibility !== 'hidden' && !e.closest('[hidden]'); })
  .map(e => {
    // A stretched link (.obj-open::after) makes its whole card or row the hit area.
    const area = e.classList.contains('obj-open') ? (e.closest('.card, .orow') || e) : e;
    const r = area.getBoundingClientRect();
    const rule = Object.keys(ex).find(sel => e.matches(sel));
    const need = rule ? ex[rule] : 44;
    return {label: (e.getAttribute('aria-label') || e.textContent || e.placeholder || e.name || '').trim().replace(/\s+/g,' ').slice(0,30),
            w: Math.round(r.width), h: Math.round(r.height), need, exception: rule || null}; })
  .filter(t => t.w < t.need || t.h < t.need)"""
EXCEPTION_COUNT = r"""(sels) => Object.fromEntries(sels.map(s => [s, [...document.querySelectorAll(s)].filter(e => {
  const r = e.getBoundingClientRect(); return r.width > 1 && !e.closest('[inert]') && !e.closest('[hidden]'); }).length]))"""
EX_NEED = {k: v[0] for k, v in TARGET_EXCEPTIONS.items()}

FOCUS_STATE = r"""() => { const e = document.activeElement; if (!e || e === document.body) return null;
  const r = e.getBoundingClientRect();
  const drawn = x => { const s = getComputedStyle(x);
    return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== 'none'); };
  // Some components draw the ring on their container (e.g. :has(:focus-visible) or :focus-within).
  let ring = false; for (let x = e, i = 0; x && i < 4 && !ring; x = x.parentElement, i++) ring = drawn(x);
  const s = getComputedStyle(e);
  return {label: (e.getAttribute('aria-label') || e.textContent || e.placeholder || e.tagName).trim().replace(/\s+/g,' ').slice(0,40),
          tag: e.tagName.toLowerCase(), ring, onscreen: r.bottom > 0 && r.top < innerHeight}; }"""

MOTION = r"""() => [...document.querySelectorAll('*')].filter(e => { const s = getComputedStyle(e);
  const d = v => Math.max(...v.split(',').map(x => parseFloat(x) || 0));
  return d(s.transitionDuration) > .01 || (s.animationName !== 'none' && d(s.animationDuration) > .01); }).length"""


def main():
    SHOTS.mkdir(exist_ok=True)
    report = {}
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for key, file in VARIANTS.items():
            url = f"file://{ROOT / file}"
            entry = report[key] = {"viewports": {}}
            for w, h in VIEWPORTS:
                touch = w <= 1024  # tablets and phones: coarse pointer, as on the real devices
                page = browser.new_page(viewport={"width": w, "height": h}, is_mobile=touch, has_touch=touch)
                errors = []
                page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
                page.goto(url)
                page.wait_for_timeout(300)
                page.screenshot(path=str(SHOTS / f"{key}-{w}x{h}.png"))
                text = page.evaluate(TEXT_AUDIT)
                entry["viewports"][f"{w}x{h}"] = {
                    "horizontal_overflow": page.evaluate("document.documentElement.scrollWidth > innerWidth"),
                    "console_errors": errors,
                    "contrast_failures": text["contrast_failures"],
                    "small_text": text["small_text"],
                    "touch_targets_under_44": page.evaluate(TARGET_AUDIT, EX_NEED) if w <= 1024 else None,
                    "target_exceptions": page.evaluate(EXCEPTION_COUNT, list(TARGET_EXCEPTIONS)) if w <= 1024 else None,
                }
                page.close()

            for w, h, state in STATES.get(key, []):
                touch = w <= 1024
                page = browser.new_page(viewport={"width": w, "height": h}, is_mobile=touch, has_touch=touch)
                errors = []
                page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
                page.goto(url + target(state))
                page.wait_for_timeout(400)
                page.screenshot(path=str(SHOTS / f"{key}-{w}x{h}-{state}.png"))
                text = page.evaluate(TEXT_AUDIT)
                entry["viewports"][f"{w}x{h}#{state}"] = {
                    "horizontal_overflow": page.evaluate("document.documentElement.scrollWidth > innerWidth"),
                    "console_errors": errors,
                    "contrast_failures": text["contrast_failures"],
                    "small_text": text["small_text"],
                    "touch_targets_under_44": page.evaluate(TARGET_AUDIT, EX_NEED) if touch else None,
                    "target_exceptions": page.evaluate(EXCEPTION_COUNT, list(TARGET_EXCEPTIONS)) if touch else None,
                }
                page.close()

            # 200% zoom: a 1440x900 window at 200% lays out as 720x450 CSS px.
            page = browser.new_page(viewport={"width": 720, "height": 450}, device_scale_factor=2)
            page.goto(url)
            page.wait_for_timeout(300)
            page.screenshot(path=str(SHOTS / f"{key}-zoom200-1440x900.png"))
            entry["zoom200"] = {"horizontal_overflow": page.evaluate("document.documentElement.scrollWidth > innerWidth")}
            page.close()

            # Software keyboard: phone viewport shortened to the area left above a typical keyboard.
            page = browser.new_page(viewport={"width": 390, "height": 480}, is_mobile=True, has_touch=True)
            page.goto(url)
            page.wait_for_timeout(300)
            composer = page.locator("textarea, input[type=text]").first
            if composer.count():
                composer.focus()
                page.wait_for_timeout(200)
                box = composer.bounding_box()
                entry["keyboard"] = {"composer_visible": bool(box and box["y"] >= 0 and box["y"] + box["height"] <= 480)}
            else:
                entry["keyboard"] = {"composer_visible": None}
            page.screenshot(path=str(SHOTS / f"{key}-390x480-keyboard.png"))
            page.close()

            # Keyboard order and visible focus for the first 40 tab stops at 1440x900.
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            page.goto(url)
            stops = []
            for _ in range(40):
                page.keyboard.press("Tab")
                state = page.evaluate(FOCUS_STATE)
                if state:
                    stops.append(state)
            entry["keyboard_focus"] = {"stops": len(stops),
                                       "without_visible_ring": [s["label"] for s in stops if not s["ring"]],
                                       "first_stops": [s["label"] for s in stops[:8]]}
            page.close()

            page = browser.new_page(viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
            page.goto(url)
            entry["reduced_motion_animated_elements"] = page.evaluate(MOTION)
            page.close()

            for name, query in EXTRA_QUERIES.get(key, {}).items():
                extra = entry.setdefault("extra", {})[name] = {}
                page = browser.new_page(viewport={"width": 720, "height": 450}, device_scale_factor=2)
                page.goto(url + query)
                page.wait_for_timeout(300)
                page.screenshot(path=str(SHOTS / f"{key}-zoom200-1440x900-{name}.png"))
                extra["zoom200_overflow"] = page.evaluate("document.documentElement.scrollWidth > innerWidth")
                page.close()
                page = browser.new_page(viewport={"width": 1440, "height": 900})
                page.goto(url + query)
                stops = []
                for _ in range(40):
                    page.keyboard.press("Tab")
                    state = page.evaluate(FOCUS_STATE)
                    if state:
                        stops.append(state)
                extra["keyboard_focus"] = {"stops": len(stops),
                                           "without_visible_ring": [s["label"] for s in stops if not s["ring"]],
                                           "first_stops": [s["label"] for s in stops[:8]]}
                page.close()
                page = browser.new_page(viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
                page.goto(url + query)
                extra["reduced_motion_animated_elements"] = page.evaluate(MOTION)
                page.close()
            for w, h, state in DARK_STATES.get(key, []):
                for ident, query in (("rail", ""), ("accent", "?identity=accent")):
                    touch = w <= 1024
                    page = browser.new_page(viewport={"width": w, "height": h}, is_mobile=touch, has_touch=touch,
                                            color_scheme="dark")
                    page.goto(url + query + (f"#{state}" if state else ""))
                    page.wait_for_timeout(400)
                    if state in DARK_SHOTS:
                        page.screenshot(path=str(SHOTS / f"{key}-dark-{ident}-{w}x{h}{'-' + state if state else ''}.png"))
                    text = page.evaluate(TEXT_AUDIT)
                    entry.setdefault("dark", {})[f"{ident} {w}x{h}#{state}"] = {
                        "contrast_failures": text["contrast_failures"], "small_text": text["small_text"]}
                    page.close()
        browser.close()
    (ROOT / "audit.json").write_text(json.dumps(report, indent=2) + "\n")
    for key, entry in report.items():
        vps = entry["viewports"].values()
        print(key, "overflow:", any(v["horizontal_overflow"] for v in vps),
              "errors:", sum(len(v["console_errors"]) for v in vps),
              "contrast failures:", sum(len(v["contrast_failures"]) for v in vps),
              "small text:", sum(len(v["small_text"]) for v in vps),
              "small targets:", sum(len(v["touch_targets_under_44"] or []) for v in vps),
              "zoom200 overflow:", entry["zoom200"]["horizontal_overflow"],
              "keyboard:", entry["keyboard"], "focus:", entry["keyboard_focus"]["stops"],
              "no ring:", len(entry["keyboard_focus"]["without_visible_ring"]),
              "motion:", entry["reduced_motion_animated_elements"])
        if entry.get("dark"):
            dv = entry["dark"].values()
            print(" ", key, "dark states:", len(entry["dark"]), "contrast failures:", sum(len(v["contrast_failures"]) for v in dv),
                  "small text:", sum(len(v["small_text"]) for v in dv))
        for name, extra in entry.get("extra", {}).items():
            print(" ", key, name, "zoom200 overflow:", extra["zoom200_overflow"],
                  "focus:", extra["keyboard_focus"]["stops"], "no ring:", len(extra["keyboard_focus"]["without_visible_ring"]),
                  "motion:", extra["reduced_motion_animated_elements"])


if __name__ == "__main__":
    main()
