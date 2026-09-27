"""Render and audit the #57 personal-assistant prototype in Docker Playwright.

Adapted from docs/design/proposals/o-003-ui-direction/tools/audit.py (variant C). Run from the
repository root:
  docker run --rm -v "$PWD/docs/design/personal-ai:/work" -w /work \
    mcr.microsoft.com/playwright/python:v1.62.0-noble python3 tools/audit.py
On Apple silicon use the v1.62.0-noble-arm64 image with `pip install -q playwright==1.62.0` first.

Writes screenshots/ and audit.json. Measurements are automated evidence about a static prototype;
they do not certify production behavior, billing, permissions or persistence.
"""

import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / "screenshots"
FILE = "prototype.html"

# (width, height, name, query-and-hash). Query: ?ai=on|none|limit|off, ?as=kai. Hash: an opened view.
STATES = [
    (1440, 900, "default", ""), (1280, 800, "default", ""), (1024, 768, "default", ""),
    (768, 1024, "default", ""), (390, 844, "default", ""), (360, 780, "default", ""),
    (1440, 900, "assistant", "#assistant"), (1440, 900, "kai-assistant", "#kai-assistant"),
    (1440, 900, "suggestion", "#suggestion"), (1440, 900, "sources", "#sources"),
    (1440, 900, "ask", "#ask"), (1440, 900, "slash", "#slash"),
    (1440, 900, "map-select", "#map-select"), (1440, 900, "tasks", "#tasks"), (1280, 800, "docs", "#docs"),
    (1440, 900, "as-kai", "?as=kai"), (1440, 900, "as-kai-run", "?as=kai#kai-assistant"),
    (1440, 900, "no-connection", "?ai=none"), (1440, 900, "no-connection-ask", "?ai=none#ask"),
    (1440, 900, "no-connection-connect", "?ai=none#connect"),
    (1440, 900, "limit", "?ai=limit#assistant"), (1440, 900, "limit-ask", "?ai=limit#ask"),
    (1440, 900, "no-ai", "?ai=off"), (1440, 900, "no-ai-map", "?ai=off#map"),
    (1024, 768, "assistant", "#assistant"), (768, 1024, "nav", "#nav"),
    (390, 844, "assistant", "#assistant"), (390, 844, "ask", "#ask"), (390, 844, "slash", "#slash"),
    (390, 844, "suggestion", "#suggestion"), (390, 844, "map-select", "#map-select"),
    (390, 844, "no-ai", "?ai=off"), (390, 844, "no-connection-connect", "?ai=none#connect"),
    (360, 780, "as-kai", "?as=kai"), (1440, 900, "rail", "?identity=rail"),
]

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

TARGET_AUDIT = r"""() => [...document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="option"], [tabindex]:not([tabindex="-1"])')]
  .filter(e => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1 && !e.closest('[inert]') && !e.classList.contains('skip'); })
  .map(e => {
    const r = e.getBoundingClientRect();
    // Inline references inside sentences use the WCAG 2.5.8 inline exception; they need 24 px, not 44.
    const need = e.classList.contains('ref') ? 24 : 44;
    return {label: (e.getAttribute('aria-label') || e.textContent || e.placeholder || e.name || '').trim().replace(/\s+/g,' ').slice(0,30),
            w: Math.round(r.width), h: Math.round(r.height), need}; })
  .filter(t => t.h < t.need || t.w < 24)"""

FOCUS_STATE = r"""() => { const e = document.activeElement; if (!e || e === document.body) return null;
  const r = e.getBoundingClientRect();
  const drawn = x => { const s = getComputedStyle(x);
    return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== 'none'); };
  let ring = false; for (let x = e, i = 0; x && i < 4 && !ring; x = x.parentElement, i++) ring = drawn(x);
  return {label: (e.getAttribute('aria-label') || e.textContent || e.placeholder || e.tagName).trim().replace(/\s+/g,' ').slice(0,40),
          tag: e.tagName.toLowerCase(), ring, onscreen: r.bottom > 0 && r.top < innerHeight}; }"""

MOTION = r"""() => [...document.querySelectorAll('*')].filter(e => { const s = getComputedStyle(e);
  const d = v => Math.max(...v.split(',').map(x => parseFloat(x) || 0));
  return d(s.transitionDuration) > .01 || (s.animationName !== 'none' && d(s.animationDuration) > .01); }).length"""


def audit_page(page, touch):
    text = page.evaluate(TEXT_AUDIT)
    return {
        "horizontal_overflow": page.evaluate("document.documentElement.scrollWidth > innerWidth"),
        "contrast_failures": text["contrast_failures"],
        "small_text": text["small_text"],
        "touch_targets_under_44": page.evaluate(TARGET_AUDIT) if touch else None,
    }


def focus_walk(browser, url):
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.goto(url)
    stops = []
    for _ in range(40):
        page.keyboard.press("Tab")
        state = page.evaluate(FOCUS_STATE)
        if state:
            stops.append(state)
    page.close()
    return {"stops": len(stops), "without_visible_ring": [s["label"] for s in stops if not s["ring"]],
            "first_stops": [s["label"] for s in stops[:10]]}


def main():
    SHOTS.mkdir(exist_ok=True)
    url = f"file://{ROOT / FILE}"
    report = {"states": {}}
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for w, h, name, suffix in STATES:
            touch = w <= 1024  # tablets and phones: coarse pointer, as on the real devices
            page = browser.new_page(viewport={"width": w, "height": h}, is_mobile=touch, has_touch=touch)
            errors = []
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda exc: errors.append(str(exc)))
            page.goto(url + suffix)
            page.wait_for_timeout(350)
            page.screenshot(path=str(SHOTS / f"{w}x{h}-{name}.png"))
            entry = audit_page(page, touch)
            entry["console_errors"] = errors
            report["states"][f"{w}x{h}#{name}"] = entry
            page.close()

        # 200% zoom: a 1440x900 window at 200% lays out as 720x450 CSS px.
        for name, suffix in [("default", ""), ("assistant", "#assistant"), ("ask", "#ask")]:
            page = browser.new_page(viewport={"width": 720, "height": 450}, device_scale_factor=2)
            page.goto(url + suffix)
            page.wait_for_timeout(300)
            page.screenshot(path=str(SHOTS / f"zoom200-{name}.png"))
            report.setdefault("zoom200", {})[name] = page.evaluate("document.documentElement.scrollWidth > innerWidth")
            page.close()

        # Software keyboard: phone viewport shortened to the area above a typical keyboard, ask mode on.
        page = browser.new_page(viewport={"width": 390, "height": 480}, is_mobile=True, has_touch=True)
        page.goto(url + "#ask")
        page.wait_for_timeout(300)
        page.locator("#reply").focus()
        page.wait_for_timeout(200)
        box = page.locator("#reply").bounding_box()
        bar = page.locator("#ask-bar").bounding_box()
        report["keyboard"] = {"composer_visible": bool(box and box["y"] >= 0 and box["y"] + box["height"] <= 480),
                              "ask_bar_visible": bool(bar and bar["y"] >= 0)}
        page.screenshot(path=str(SHOTS / "390x480-keyboard-ask.png"))
        page.close()

        report["keyboard_focus"] = {"default": focus_walk(browser, url), "no-ai": focus_walk(browser, url + "?ai=off"),
                                    "as-kai": focus_walk(browser, url + "?as=kai")}

        motion = {}
        for name, suffix in [("default", ""), ("assistant", "#assistant"), ("slash", "#slash")]:
            page = browser.new_page(viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
            page.goto(url + suffix)
            page.wait_for_timeout(200)
            motion[name] = page.evaluate(MOTION)
            page.close()
        report["reduced_motion_animated_elements"] = motion
        browser.close()

    (ROOT / "audit.json").write_text(json.dumps(report, indent=2) + "\n")
    st = report["states"].values()
    print("states:", len(report["states"]),
          "overflow:", sum(v["horizontal_overflow"] for v in st),
          "errors:", sum(len(v["console_errors"]) for v in st),
          "contrast failures:", sum(len(v["contrast_failures"]) for v in st),
          "small text:", sum(len(v["small_text"]) for v in st),
          "small targets:", sum(len(v["touch_targets_under_44"] or []) for v in st))
    print("zoom200 overflow:", report["zoom200"], "keyboard:", report["keyboard"])
    for k, v in report["keyboard_focus"].items():
        print("focus", k, "stops:", v["stops"], "no ring:", len(v["without_visible_ring"]))
    print("reduced motion:", report["reduced_motion_animated_elements"])
    for key, v in report["states"].items():
        bad = {k: v[k] for k in ("contrast_failures", "small_text", "touch_targets_under_44", "console_errors") if v[k]}
        if bad or v["horizontal_overflow"]:
            print(" !", key, json.dumps(bad)[:600], "overflow" if v["horizontal_overflow"] else "")


if __name__ == "__main__":
    main()
