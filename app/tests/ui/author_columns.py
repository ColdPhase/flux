"""Observable author alignment required by the accepted F-026 conversation contract."""

import unittest

from playwright.sync_api import Locator, expect


def assert_author_column(case: unittest.TestCase, row: Locator, width: int, label: str) -> None:
    expect(row).to_be_visible()
    own = row.evaluate("el => el.matches('.project-convo__message.is-mine, .thread__root.is-mine')")
    if own:
        case.assertEqual(row.locator(":scope > .author-face, :scope > .ui-avatar, :scope > .thread__root-meta").count(), 0,
            f"{label}: Spokój own messages have no avatar or name")
        return
    observed = row.evaluate("""el => {
      const face = el.querySelector(':scope > :is(.ui-avatar, .author-face), :scope > .thread__root-meta > :is(.ui-avatar, .author-face)');
      const meta = el.querySelector('.project-convo__message-meta, .thread__root-meta, .convo-notice__meta, .agents-msg__meta');
      const r = el.getBoundingClientRect(), f = face.getBoundingClientRect(), m = meta.getBoundingClientRect();
      return {rowX:r.x, rowRight:r.right, faceX:f.x, faceRight:f.right, width:f.width, height:f.height,
        own:el.matches('.project-convo__message.is-mine, .thread__root.is-mine'),
        display:getComputedStyle(face).display, metaX:m.x, metaRight:m.right, direction:getComputedStyle(meta).flexDirection};
    }""")
    case.assertNotEqual(observed["display"], "none", f"{label}: the author's face stays visible")
    case.assertAlmostEqual(observed["width"], 32, delta=0.1, msg=f"{label}: every author has a 32 px face")
    case.assertAlmostEqual(observed["height"], 32, delta=0.1, msg=f"{label}: the full face is retained")
    if observed["own"]:
        case.assertAlmostEqual(observed["faceRight"], observed["rowRight"], delta=1, msg=f"{label}: own face occupies the right column")
        gap = observed["faceX"] - observed["metaRight"]
    else:
        case.assertAlmostEqual(observed["faceX"], observed["rowX"], delta=1, msg=f"{label}: the face occupies the left column")
        gap = observed["metaX"] - observed["faceRight"]
    case.assertAlmostEqual(gap, 10 if width <= 680 else 12, delta=1, msg=f"{label}: the complete author name keeps the required gap")
    case.assertEqual(observed["direction"], "row", f"{label}: metadata keeps its reading order")
