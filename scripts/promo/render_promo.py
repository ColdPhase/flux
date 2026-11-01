"""Render the promo SVG to frames for review: a contact sheet and an <img> check (#780).

  render_promo.py sheet <svg> <out.png> <t1,t2,...>   frames at those seconds, side by side, for review
  render_promo.py img   <page.html> <out-dir> <browser> [width]
                                                      real-time capture of a page that shows the SVG as <img>
                                                      (the README as GitHub renders it): proves it animates there
Runs in Docker (scripts/make_promo.sh) on the Playwright image.
"""
from __future__ import annotations

import io
import sys
import time
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

LOOP = 16.0


def frames_at(svg: Path, times: list[float], scale: float = 1.0) -> list[Image.Image]:
    out = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 960, "height": 540}, device_scale_factor=scale)
        page.goto(svg.resolve().as_uri())
        page.wait_for_timeout(300)
        for t in times:
            # Seek every animation, then let two frames paint so composited layers catch up.
            page.evaluate("t => new Promise(done => { document.getAnimations().forEach(a => { a.pause();"
                          " a.currentTime = t; }); requestAnimationFrame(() => requestAnimationFrame(done)); })",
                          t * 1000)
            out.append(Image.open(io.BytesIO(page.screenshot(omit_background=False))).convert("RGB"))
        browser.close()
    return out


def sheet(svg: Path, dest: Path, times: list[float]) -> None:
    frames = frames_at(svg, times)
    cols = 2
    rows = (len(frames) + cols - 1) // cols
    fw, fh = frames[0].size
    canvas = Image.new("RGB", (fw * cols, fh * rows), "white")
    for i, im in enumerate(frames):
        canvas.paste(im, ((i % cols) * fw, (i // cols) * fh))
    canvas.save(dest)
    print(f"{dest}: {len(frames)} frames")


def img_check(page_html: Path, out: Path, engine: str, width: int) -> None:
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = getattr(p, engine).launch()
        for scheme in ("light", "dark"):
            page = browser.new_page(viewport={"width": width, "height": 900}, color_scheme=scheme)
            page.goto(page_html.resolve().as_uri())
            hero = page.locator("img[src*='flux-promo']").first
            hero.wait_for()
            src = hero.evaluate("e => e.currentSrc")
            start = time.monotonic()
            shots = []
            for i in range(6):
                target = start + i * 1.7
                time.sleep(max(0, target - time.monotonic()))
                name = out / f"{engine}-{scheme}-{width}-{i}.png"
                hero.screenshot(path=str(name))
                shots.append(name.read_bytes())
            distinct = len(set(shots))
            print(f"{engine} {scheme} {width}px: src={src.rsplit('/', 1)[-1]} distinct frames {distinct}/6")
            page.close()
        browser.close()


def main(argv: list[str]) -> int:
    mode = argv[1]
    if mode == "sheet":
        sheet(Path(argv[2]), Path(argv[3]), [float(t) for t in argv[4].split(",")])
    elif mode == "img":
        img_check(Path(argv[2]), Path(argv[3]), argv[4], int(argv[5]) if len(argv) > 5 else 1012)
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
