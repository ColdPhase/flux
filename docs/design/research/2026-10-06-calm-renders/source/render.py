"""Render the static v5 mockups in this folder to 390x844 PNGs at 2x.

Run inside a container that has Python Playwright and Chromium, with this folder
mounted at /w and an output folder at /out, for example:

    docker run --rm --network none -v "$PWD":/w:ro -v "$PWD/../after":/out \
      --entrypoint python3 <image with playwright> /w/render.py V5Rozmowa V5Watek V5Agenci V5Projekty

Reduced motion is emulated, so the orbs and the shimmering text are captured still.
"""
import sys

from playwright.sync_api import sync_playwright

names = sys.argv[1:]
with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, reduced_motion='reduce')
    page = context.new_page()
    for name in names:
        page.goto(f'file:///w/{name}.html')
        page.wait_for_timeout(300)
        page.screenshot(path=f'/out/{name}.png', clip={'x': 0, 'y': 0, 'width': 390, 'height': 844})
        print('rendered', name)
    browser.close()
