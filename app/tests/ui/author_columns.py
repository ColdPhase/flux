"""Observable author alignment required by the accepted F-026 conversation contract."""

import unittest

from playwright.sync_api import Locator, expect


def assert_author_column(case: unittest.TestCase, row: Locator, width: int, label: str) -> None:
    expect(row).to_be_visible()
    observed = row.evaluate("""el => {
      const face = el.querySelector(':scope > :is(.ui-avatar, .author-face)');
      const meta = el.querySelector('.project-convo__message-meta, .convo-notice__meta, .agents-msg__meta');
      const r = el.getBoundingClientRect(), f = face.getBoundingClientRect(), m = meta.getBoundingClientRect();
      return {rowX:r.x, faceX:f.x, faceRight:f.right, width:f.width, height:f.height,
        display:getComputedStyle(face).display, metaX:m.x, direction:getComputedStyle(meta).flexDirection};
    }""")
    case.assertNotEqual(observed["display"], "none", f"{label}: the author's face stays visible")
    case.assertAlmostEqual(observed["width"], 32, delta=0.1, msg=f"{label}: every author has a 32 px face")
    case.assertAlmostEqual(observed["height"], 32, delta=0.1, msg=f"{label}: the full face is retained")
    case.assertAlmostEqual(observed["faceX"], observed["rowX"], delta=1, msg=f"{label}: the face occupies the common left column")
    case.assertAlmostEqual(observed["metaX"] - observed["faceRight"], 10 if width <= 680 else 12,
                           delta=1, msg=f"{label}: the complete author name follows the required gap")
    case.assertEqual(observed["direction"], "row", f"{label}: own and other authors keep the same order")
