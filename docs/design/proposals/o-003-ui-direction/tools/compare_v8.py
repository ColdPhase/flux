"""Render flux-ux-v8.html at the same viewports and states as C's comparison shots.

Run from the repository root (v8 lives there, so the whole repository is mounted):
  docker run --rm -v "$PWD:/repo" -w /repo/docs/design/proposals/o-003-ui-direction \
    mcr.microsoft.com/playwright/python:v1.62.0-noble python3 tools/compare_v8.py

Writes screenshots/v8-<viewport>.png and screenshots/v8-<viewport>-details.png.
C's matching shots (c-1440x900.png, c-1440x900-details.png, c-390x844.png,
c-390x844-details.png) come from tools/audit.py.
Desktop v8 always shows its context column, so its "details" state opens the
discussed task from its card; on the phone it opens the context sheet.
"""

from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
V8 = ROOT.parents[3] / "flux-ux-v8.html"
SHOTS = ROOT / "screenshots"
DETAILS = {1440: '.msg [data-act="v8-open"], [data-act="v8-open"]', 390: '[data-act="v8-context-toggle"]'}

with sync_playwright() as p:
    browser = p.chromium.launch()
    for w, h in [(1440, 900), (390, 844)]:
        touch = w <= 1024
        for state in ("", "details"):
            page = browser.new_page(viewport={"width": w, "height": h}, is_mobile=touch, has_touch=touch)
            page.goto(V8.as_uri())
            page.wait_for_timeout(800)
            if state:
                target = page.locator(DETAILS[w]).locator("visible=true").first
                target.click()
                page.wait_for_timeout(600)
            name = f"v8-{w}x{h}" + (f"-{state}" if state else "")
            page.screenshot(path=str(SHOTS / f"{name}.png"))
            print(name)
            page.close()
    browser.close()
