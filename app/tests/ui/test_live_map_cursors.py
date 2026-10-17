"""#228 AC-1/AC-2: peer-visible named cursors and presence on the map and the wiki.

Run only with FLUX_LIVE_EDITING_TEST=1 against the isolated development candidate
(scripts/check_live_editing.sh test_live_map_cursors). Two real accounts, real sockets;
FLUX_UI_SCREENSHOTS keeps one screenshot per surface.
"""
import os
import time
import unittest
from pathlib import Path

from playwright.async_api import expect
from test_live_editing import LiveFixture

SHOTS = Path(os.environ.get('FLUX_UI_SCREENSHOTS', '')) if os.environ.get('FLUX_UI_SCREENSHOTS') else None


@unittest.skipUnless(os.environ.get('FLUX_LIVE_EDITING_TEST') == '1', 'Actual isolated live candidate required')
class LiveCursors(LiveFixture):
    async def shoot(self, page, name):
        if SHOTS:
            engine = self.browser.browser_type.name
            await page.screenshot(path=str(SHOTS / f'{name}-{engine}.png'))

    async def test_map_shows_the_peers_named_cursor_and_who_is_here(self):
        await self.create_map(3)
        ada, kai = self.pages['ada'], self.pages['kai']
        node = ada.locator(f'.sk-node[data-id="{self.thoughts[0]["id"]}"]')
        box = await node.bounding_box()
        # Ada moves over empty space beside her first thought; Kai sees her named cursor there.
        await ada.mouse.move(box['x'] + box['width'] + 60, box['y'] + 200, steps=5)
        cursor = kai.locator('.sk-peer[data-live-peer="Ada North"]')
        await expect(cursor).to_have_count(1)
        await expect(cursor).to_contain_text('Ada North')
        await expect(kai.locator('.sk-here')).to_contain_text('Ada North')
        mine = await ada.locator('.sk-peer').count()
        self.assertEqual(mine, 0, 'Nobody sees their own cursor drawn')
        # Her cursor follows the pointer: same offset from the thought on both planes (same plane units).
        first = await kai.locator(f'.sk-node[data-id="{self.thoughts[0]["id"]}"]').bounding_box()
        target = (box['x'] + box['width'] + 160, box['y'] + 260)
        await ada.mouse.move(*target, steps=5)
        want = (target[0] - box['x'], target[1] - box['y'])
        deadline = time.perf_counter() + 3
        while True:
            at = await cursor.bounding_box()
            if abs(at['x'] - first['x'] - want[0]) <= 3 and abs(at['y'] - first['y'] - want[1]) <= 3:
                break
            self.assertLess(time.perf_counter(), deadline, f'The cursor follows the pointer: {at} vs {first} + {want}')
            await kai.wait_for_function('() => new Promise((done) => requestAnimationFrame(done))')
        await kai.mouse.move(first['x'] + 20, first['y'] + 300, steps=3)
        await expect(ada.locator('.sk-peer[data-live-peer="Kai South"]')).to_have_count(1)
        await self.shoot(kai, 'map-peer-cursor')
        await self.shoot(ada, 'map-peer-cursor-ada')
        # Leaving the map takes the cursor away.
        await ada.mouse.move(2, 2)
        await expect(kai.locator('.sk-peer[data-live-peer="Ada North"]')).to_have_count(0)

    async def test_wiki_shows_the_peers_named_cursor_and_writer(self):
        await self.create_doc('First paragraph of the shared field notes.')
        ada = await self.editor('ada')
        kai = await self.editor('kai')
        await self.type_text(self.pages['ada'], ada, ' Ada was here.')
        await expect(self.pages['kai'].locator('.editing-caret[aria-label="Ada North\'s cursor"]')).to_have_count(1)
        await expect(self.pages['kai'].locator('.editing-people')).to_contain_text('Ada North')
        await self.type_text(self.pages['kai'], kai, ' Kai too.')
        await expect(self.pages['ada'].locator('.editing-caret[aria-label="Kai South\'s cursor"]')).to_have_count(1)
        await expect(self.pages['ada'].locator('.editing-people')).to_contain_text('Kai South')
        await self.shoot(self.pages['ada'], 'wiki-peer-cursor')
