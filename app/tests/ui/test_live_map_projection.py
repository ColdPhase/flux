"""Real current-authority map projection/cancel/undo journey; no latency acceptance."""
import os
import unittest
import uuid

from playwright.async_api import expect
from test_live_editing import LiveFixture
from test_app_shell import ORIGIN


@unittest.skipUnless(os.environ.get('FLUX_LIVE_EDITING_TEST') == '1', '#228 needs an explicitly enabled isolated candidate')
class LiveMapProjectionJourney(LiveFixture):
    async def test_remote_changes_during_drag_private_cancel_and_independent_own_undo(self):
        await self.create_map(50)
        ada, kai = self.pages['ada'], self.pages['kai']
        first, second, third = self.thoughts[:3]
        canvas = ada.locator('.sk-canvas')
        owner = ada.locator(f'.sk-node[data-id="{first["id"]}"]')
        peer = kai.locator(f'.sk-node[data-id="{first["id"]}"]')
        bounds = await owner.bounding_box()
        self.assertIsNotNone(bounds)
        try:
            await ada.mouse.move(bounds['x'] + 20, bounds['y'] + 20)
            await ada.mouse.down()
            await ada.mouse.move(bounds['x'] + 75, bounds['y'] + 55, steps=4)
            await expect(peer).to_have_attribute('data-live-mover', 'Ada North')
            await expect(peer).not_to_have_attribute('data-thought-x', str(first['x']))
            generation = await canvas.get_attribute('data-live-generation')
            gesture = await canvas.get_attribute('data-live-own-gesture')
            self.assertEqual(str(uuid.UUID(generation)), generation)
            self.assertEqual(str(uuid.UUID(gesture)), gesture)
            # These real native API commands carry the peer's current session and
            # normal server authority; the owner's trusted pointer is still down.
            created = await self.api(kai, 'POST', f'/api/v1/sketches/{self.map_id}/thoughts',
                {'text': 'Peer added while the other movement is unfinished', 'x': 600, 'y': 40},
                201, {'idempotency-key': str(uuid.uuid4())})
            added = created['thought']
            await expect(ada.locator(f'.sk-node[data-id="{added["id"]}"]')).to_be_visible()
            changed = await self.api(kai, 'PATCH', f'/api/v1/sketches/{self.map_id}/thoughts/{second["id"]}',
                {'text': 'Peer confirmed edit survives another movement'}, 200,
                {'idempotency-key': str(uuid.uuid4()), 'if-match': f'"{second["version"]}"'})
            await expect(ada.locator(f'.sk-node[data-id="{second["id"]}"] .sk-t')).to_have_text(changed['text'])
            link = await self.api(kai, 'POST', f'/api/v1/sketches/{self.map_id}/links',
                {'fromId': second['id'], 'toId': added['id'], 'label': 'Peer edge during movement'},
                201, {'idempotency-key': str(uuid.uuid4())})
            await expect(ada.locator('.sk-labels').get_by_text(link['label'], exact=True)).to_be_visible()
            deleted = await kai.request.delete(f'/api/v1/sketches/{self.map_id}/thoughts/{third["id"]}',
                headers={'origin': ORIGIN, 'idempotency-key': str(uuid.uuid4()), 'if-match': f'"{third["version"]}"'})
            self.assertEqual(deleted.status, 204, await deleted.text())
            await expect(ada.locator(f'.sk-node[data-id="{third["id"]}"]')).to_have_count(0)
            await expect(canvas).to_have_attribute('data-live-generation', generation)
            await expect(canvas).to_have_attribute('data-live-own-gesture', gesture)
            before = await peer.get_attribute('data-live-preview-sequence')
            await ada.mouse.move(bounds['x'] + 115, bounds['y'] + 75, steps=3)
            await expect(peer).not_to_have_attribute('data-live-preview-sequence', before)
            await expect(peer).to_have_attribute('data-live-generation', generation)
            confirmed = await self.api(kai, 'GET', f'/api/v1/sketches/{self.map_id}')
            self.assertEqual(next(item for item in confirmed['thoughts'] if item['id'] == first['id'])['x'], first['x'],
                'Before pointerup the actual native graph still contains the original position')
            # Actual navigation ends this editor instance, preserving the unfinished
            # input privately and clearing its authorized preview without committing.
            await ada.goto('/')
        finally:
            await ada.mouse.up()
        recovery_key = f'flux:map-gesture:{self.ada_id}:{self.map_id}'
        private = await ada.evaluate('key => JSON.parse(sessionStorage.getItem(key))', recovery_key)
        self.assertEqual(private['generation'], generation)
        self.assertEqual(private['gestureId'], gesture)
        self.assertEqual(len(private['positions']), 1)
        self.assertEqual(private['positions'][0]['id'], first['id'])
        self.assertNotEqual(private['positions'][0]['x'], first['x'])
        await expect(peer).not_to_have_attribute('data-live-mover', 'Ada North')
        await ada.goto(f'/map/{self.map_id}')
        await expect(ada.locator('[data-live-map-status="live"]')).to_be_visible()
        await expect(ada.get_by_text('An unfinished movement is kept privately', exact=True)).to_be_visible()
        await expect(ada.locator(f'.sk-node[data-id="{first["id"]}"]')).to_have_attribute('data-thought-x', str(first['x']))
        await expect(peer).to_have_attribute('data-thought-x', str(first['x']))
        # A new trusted native command and its own inverse leave every independent
        # peer addition/edit/link/removal intact; the private copy is not replayed.
        await ada.locator(f'.sk-node[data-id="{first["id"]}"]').focus()
        await ada.keyboard.press('ArrowRight')
        await self.map_saved(ada)
        await expect(peer).to_have_attribute('data-thought-x', str(first['x'] + 12))
        async with ada.expect_response(lambda response: response.url.endswith(f'/api/v1/sketches/{self.map_id}/live/undo') and response.request.method == 'POST') as receipt:
            await ada.get_by_role('button', name='Undo', exact=True).click()
        self.assertEqual((await receipt.value).status, 200)
        await expect(peer).to_have_attribute('data-thought-x', str(first['x']))
        after = await self.api(kai, 'GET', f'/api/v1/sketches/{self.map_id}')
        thought_by_id = {thought['id']: thought for thought in after['thoughts']}
        self.assertEqual(thought_by_id[first['id']]['version'], first['version'] + 2)
        self.assertEqual(thought_by_id[second['id']]['text'], changed['text'])
        self.assertIn(added['id'], thought_by_id)
        self.assertNotIn(third['id'], thought_by_id)
        self.assertIn(link['id'], [item['id'] for item in after['links']])
        self.assertEqual((await self.api(kai, 'GET', f'/api/v1/sketches/{self.map_id}/live'))['generation'], generation)
