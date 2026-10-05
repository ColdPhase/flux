"""#228 actual trusted multiselection/drag regression; no latency acceptance.

Run only with FLUX_LIVE_EDITING_TEST=1 against the isolated development candidate.
Selection clicks must not allocate leases. Real50/200 drags still require current
server leases, deliver every selected position before pointerup, and commit native CAS.
"""
import asyncio
import os
import time
import unittest

from playwright.async_api import expect
from test_live_editing import LiveFixture


@unittest.skipUnless(os.environ.get('FLUX_LIVE_EDITING_TEST') == '1', 'Actual isolated live candidate required')
class LiveMapSelectionJourney(LiveFixture):
    async def test_selection_clicks_are_local_then_real_50_and_200_drags_share_and_commit(self):
        for selected in (50, 200):
            with self.subTest(selected=selected):
                await self.create_map(selected)
                ada, kai = self.pages['ada'], self.pages['kai']
                leases = []

                def requested(request):
                    if request.method == 'POST' and request.url.endswith(f'/api/v1/sketches/{self.map_id}/live/gestures'):
                        leases.append(request.post_data_json)

                ada.on('request', requested)
                try:
                    for thought in self.thoughts:
                        await ada.locator(f'.sk-node[data-id="{thought["id"]}"]').click(modifiers=['Shift'])
                    await expect(ada.locator('.sk-node[aria-pressed="true"]')).to_have_count(selected)
                    self.assertEqual(leases, [], 'Selection-only trusted clicks must not allocate or later cancel server leases')
                    self.assertFalse(any(row['header'].get('type') in ('map-move', 'map-cancel') for row in self.frames['ada']),
                        'Selection creates no stale transient intents')
                    target = self.thoughts[-1]
                    node = ada.locator(f'.sk-node[data-id="{target["id"]}"]')
                    peer = kai.locator(f'.sk-node[data-id="{target["id"]}"]')
                    await node.scroll_into_view_if_needed()
                    await peer.scroll_into_view_if_needed()
                    box = await node.bounding_box()
                    self.assertIsNotNone(box)
                    await ada.mouse.move(box['x'] + 20, box['y'] + 20)
                    await ada.mouse.down()
                    self.assertEqual(leases, [], 'Pointerdown alone remains below the established4px movement threshold')
                    await ada.mouse.move(box['x'] + 22, box['y'] + 21)
                    self.assertEqual(leases, [], 'Subthreshold motion still allocates no lease')
                    await ada.mouse.move(box['x'] + 65, box['y'] + 50, steps=4)
                    await expect(peer).to_have_attribute('data-live-mover', 'Ada North')
                    self.assertEqual(len(leases), 1)
                    self.assertEqual({item['id'] for item in leases[0]['thoughts']}, {thought['id'] for thought in self.thoughts})
                    self.assertTrue(all(item['expectedVersion'] == 1 for item in leases[0]['thoughts']))
                    generation = await ada.locator('.sk-canvas').get_attribute('data-live-generation')
                    # Previews are throttled (one frame per 40 ms): the pointer's last position may still
                    # be pending when the peer first shows a mover. Compare with the gesture's latest
                    # sequence, which must be published before pointerup (#239 review: an earlier
                    # frame here made the 50-thought check read one 18 px pointer step behind).
                    own = int(await ada.locator('.sk-canvas').get_attribute('data-live-own-sequence'))
                    deadline = time.perf_counter() + 3
                    while True:
                        sent = [row['header'] for row in self.frames['ada'] if row['direction'] == 'sent'
                            and row['header'].get('type') == 'map-move' and row['header'].get('generation') == generation]
                        if sent and sent[-1].get('sequence') == own:
                            break
                        self.assertLess(time.perf_counter(), deadline, f'The latest movement sequence {own} is published before pointerup')
                        await asyncio.sleep(0.02)
                    publication = sent[-1]
                    self.assertEqual(len(publication['positions']), selected)
                    for position in publication['positions']:
                        visible = kai.locator(f'.sk-node[data-id="{position["id"]}"]')
                        await expect(visible).to_have_attribute('data-live-lease', publication['leaseId'])
                        await expect(visible).to_have_attribute('data-thought-x', str(position['x']))
                        await expect(visible).to_have_attribute('data-thought-y', str(position['y']))
                        await expect(visible).to_have_attribute('data-thought-version', '1')
                    durable = await self.api(kai, 'GET', f'/api/v1/sketches/{self.map_id}/live')
                    self.assertEqual({t['id']: (t['x'], t['y'], t['version']) for t in durable['sketch']['thoughts']},
                        {t['id']: (t['x'], t['y'], 1) for t in self.thoughts}, 'All preview positions remain uncommitted during the active drag')
                    await ada.mouse.up()
                    await self.map_saved(ada)
                    await expect(peer).not_to_have_attribute('data-live-mover', 'Ada North')
                    committed = await self.api(kai, 'GET', f'/api/v1/sketches/{self.map_id}/live')
                    self.assertEqual({t['id']: (t['x'], t['y'], t['version']) for t in committed['sketch']['thoughts']},
                        {p['id']: (p['x'], p['y'], 2) for p in publication['positions']})
                    refusals = [(key, row['header']) for key, rows in self.frames.items() for row in rows if row['header'].get('type') == 'error']
                    self.assertEqual(refusals, [], 'No malformed/capacity refusal may be hidden while selecting or moving a supported group')
                finally:
                    await ada.mouse.up()
                    ada.remove_listener('request', requested)
                    self.frames = {'ada': [], 'kai': []}

    async def test_201_selected_does_not_share_or_commit_any_positions(self):
        await self.create_map(201)
        ada, kai = self.pages['ada'], self.pages['kai']
        leases = []

        def requested(request):
            if request.method == 'POST' and request.url.endswith(f'/api/v1/sketches/{self.map_id}/live/gestures'):
                leases.append(request.post_data_json)

        ada.on('request', requested)
        try:
            for thought in self.thoughts:
                await ada.locator(f'.sk-node[data-id="{thought["id"]}"]').click(modifiers=['Shift'])
            await expect(ada.locator('.sk-node[aria-pressed="true"]')).to_have_count(201)
            target = ada.locator(f'.sk-node[data-id="{self.thoughts[-1]["id"]}"]')
            box = await target.bounding_box()
            self.assertIsNotNone(box)
            await ada.mouse.move(box['x'] + 20, box['y'] + 20)
            await ada.mouse.down()
            await ada.mouse.move(box['x'] + 65, box['y'] + 50, steps=4)
            await ada.mouse.up()
            self.assertEqual(leases, [], 'Unsupported201 selection cannot become a200-item truncated shared lease')
            self.assertFalse(any(row['header'].get('type') in ('map-move', 'map-cancel') for row in self.frames['ada']))
            current = await self.api(kai, 'GET', f'/api/v1/sketches/{self.map_id}/live')
            self.assertEqual({t['id']: (t['x'], t['y'], t['version']) for t in current['sketch']['thoughts']},
                {t['id']: (t['x'], t['y'], 1) for t in self.thoughts})
            # Recovery is a fresh supported trusted selection, without importing any refused
            # movement. Do not change the native document to manufacture this recovery.
            await target.click()
            await expect(ada.locator('.sk-node[aria-pressed="true"]')).to_have_count(1)
            box = await target.bounding_box()
            await ada.mouse.move(box['x'] + 20, box['y'] + 20)
            await ada.mouse.down()
            await ada.mouse.move(box['x'] + 65, box['y'] + 50, steps=4)
            await expect(kai.locator(f'.sk-node[data-id="{self.thoughts[-1]["id"]}"]')).to_have_attribute('data-live-mover', 'Ada North')
            self.assertEqual(len(leases), 1)
            self.assertEqual(len(leases[0]['thoughts']), 1)
            await ada.mouse.up()
            await self.map_saved(ada)
        finally:
            await ada.mouse.up()
            ada.remove_listener('request', requested)


if __name__ == '__main__':
    unittest.main()
