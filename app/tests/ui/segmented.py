"""Geometry of the app's segmented controls (README, Segmented controls, #1561): the options take equal shares of the track and are never narrower
than their own label, so the selected pill is the same size and shape whichever option is selected, inside the track, with nothing scrolling sideways.

`check_segmented(case, page, track, what)` measures one control, as drawn: `track` is a callable returning the element that holds the options (a radio
group `.seg`, or the bar of a tab list), opened afresh each time because the phone's Map / List sheet closes when an option is chosen. Radio options are
chosen by a click or a tap; tabs by a click or a tap too; `skip` names options that must not be chosen (the Create window's Space tab leaves its tabs).
"""

from __future__ import annotations

from typing import Callable

from playwright.sync_api import Locator, Page

# The control as it is now: every option's box, whether its words are cut, the track's own width, and the width it would hug (every option as wide as the widest).
GEOMETRY = r"""(track) => {
  const box = (el) => { const r = el.getBoundingClientRect(); return {left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height}; };
  const options = [...track.querySelectorAll('[role="radio"], [role="tab"]')];
  const kept = [track.style.width, track.style.maxWidth];
  track.style.width = 'max-content'; track.style.maxWidth = 'none';
  const hugging = track.offsetWidth;
  [track.style.width, track.style.maxWidth] = kept;
  const style = getComputedStyle(track);
  const selected = options.find((o) => o.getAttribute('aria-checked') === 'true' || o.getAttribute('aria-selected') === 'true' || o.getAttribute('aria-current') === 'page');
  const thumb = track.querySelector('.ui-tabs__indicator');
  return {
    track: box(track), hugging, scrollWidth: track.scrollWidth, clientWidth: track.clientWidth,
    pad: [parseFloat(style.paddingLeft), parseFloat(style.paddingRight)], gap: parseFloat(style.columnGap) || 0,
    pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    options: options.map((o) => ({ label: (o.querySelector('.ui-tabs__label')?.getAttribute('data-text') ?? o.textContent ?? '').trim(), ...box(o), cut: o.scrollWidth - o.clientWidth,
      selected: o === selected, radius: parseFloat(getComputedStyle(o).borderTopLeftRadius) })),
    pill: thumb ? box(thumb) : selected ? box(selected) : null,
  };
}"""

ROUND = 1.01  # px: the layout's own rounding


def measure(track: Locator) -> dict:
    return track.evaluate(GEOMETRY)


def check_segmented(case, page: Page, track: Callable[[], Locator], what: str, *, skip: tuple[str, ...] = (), touch: bool = False,
                    shot: Callable[[str], None] | None = None) -> list[str]:
    """Measures one control and every state of it; returns the numbers (one line per option) for the log."""
    lines: list[str] = []
    first = measure(track())
    options = first["options"]
    case.assertGreaterEqual(len(options), 2, f"{what}: has options")
    widths = [item["width"] for item in options]
    # The words are never cut, whatever the width: an option is never narrower than its own label, and nothing scrolls inside the track or the page.
    for item in options:
        case.assertLessEqual(item["cut"], 1, f"{what}: {item['label']!r} is narrower than its label {item}")
    case.assertLessEqual(first["scrollWidth"], first["clientWidth"] + 1, f"{what}: the track scrolls sideways {first}")
    case.assertLessEqual(first["pageOverflow"], 1, f"{what}: the page scrolls sideways {first['pageOverflow']}")
    # Equal widths wherever the words fit at equal widths: a track that hugs its options (or one wide enough for the widest word times the number of
    # options) shares its width equally to the pixel.
    fits = first["hugging"] <= first["track"]["width"] + 1
    if fits:
        case.assertLessEqual(max(widths) - min(widths), ROUND, f"{what}: the options have different widths {widths} {first}")
    # Every option has the same height, and on touch a 44 px target.
    heights = [item["height"] for item in options]
    case.assertLessEqual(max(heights) - min(heights), ROUND, f"{what}: the options have different heights {heights}")
    if touch:
        case.assertGreaterEqual(min(heights), 43.9, f"{what}: a touch option is a 44 px target {heights}")
    pills: list[dict] = []
    for index, item in enumerate(options):
        if item["label"] in skip:
            continue
        control = track().locator('[role="radio"], [role="tab"]').nth(index)
        control.tap() if touch else control.click()
        page.wait_for_timeout(350)  # the pill slides to its option
        now = measure(track())
        pill, bar = now["pill"], now["track"]
        case.assertIsNotNone(pill, f"{what}: {item['label']} selected has a pill")
        selected = [entry["label"] for entry in now["options"] if entry["selected"]]
        case.assertEqual(selected, [item["label"]], f"{what}: {item['label']} is the selected option")
        case.assertGreaterEqual(pill["left"], bar["left"] - .5, f"{what}: the pill is inside the track {pill} {bar}")
        case.assertLessEqual(pill["right"], bar["right"] + .5, f"{what}: the pill is inside the track {pill} {bar}")
        case.assertGreaterEqual(pill["top"], bar["top"] - .5, f"{what}: the pill is inside the track {pill} {bar}")
        case.assertLessEqual(pill["bottom"], bar["bottom"] + .5, f"{what}: the pill is inside the track {pill} {bar}")
        case.assertGreaterEqual(pill["width"], 1.25 * pill["height"], f"{what}: the pill is a pill, never a circle {pill}")
        pills.append(pill)
        lines.append(f"{what}: {item['label']} selected, pill {pill['width']:.1f} x {pill['height']:.1f}")
        if shot:
            shot(item["label"])
    sizes = {(round(p["width"]), round(p["height"])) for p in pills}
    if fits:
        case.assertLessEqual(max(p["width"] for p in pills) - min(p["width"] for p in pills), ROUND, f"{what}: the pill's width changes with the option {sizes}")
    case.assertLessEqual(max(p["height"] for p in pills) - min(p["height"] for p in pills), ROUND, f"{what}: the pill's height changes with the option {sizes}")
    lines.append(f"{what}: options {[round(w, 1) for w in widths]} track {first['track']['width']:.1f} hugging {first['hugging']:.1f} fits-equal {fits}")
    return lines
