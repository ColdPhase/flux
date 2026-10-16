"""Real current-authority map projection/cancel/undo journey; no latency acceptance."""
import asyncio
import json
import os
import unittest
import uuid

from playwright.async_api import expect
from test_live_editing import LiveFixture
from test_app_shell import ORIGIN


@unittest.skipUnless(os.environ.get('FLUX_LIVE_EDITING_TEST') == '1', '#228 needs an explicitly enabled isolated candidate')
class LiveMapProjectionJourney(LiveFixture):
    async def test_connection_label_conflict_reveals_current_label_only_to_authorized_writer(self):
        await self.create_map(2)
        ada, kai = self.pages['ada'], self.pages['kai']
        source, target = self.thoughts
        link = await self.api(kai, 'POST', f'/api/v1/sketches/{self.map_id}/links',
            {'fromId': source['id'], 'toId': target['id']}, 201,
            {'idempotency-key': str(uuid.uuid4())})
        current = 'authorized current label'
        await self.api(kai, 'PATCH', f'/api/v1/sketches/{self.map_id}/links/{link["id"]}',
            {'label': current, 'expectedLabel': None}, 200,
            {'idempotency-key': str(uuid.uuid4())})

        # The request runs through the live-enabled route wrapper. A stale writer
        # receives the checked current public label so the UI can require review.
        conflict = await ada.request.fetch(f'/api/v1/sketches/{self.map_id}/links/{link["id"]}',
            method='PATCH', headers={'origin': ORIGIN, 'content-type': 'application/json',
                'idempotency-key': str(uuid.uuid4())},
            data=json.dumps({'label': 'my stale draft', 'expectedLabel': None}))
        self.assertEqual(conflict.status, 409, await conflict.text())
        details = await conflict.json()
        self.assertEqual(details.get('code'), 'LABEL_CONFLICT')
        self.assertEqual(details.get('currentLabel'), current)
        self.assertEqual(details.get('current', {}).get('label'), current)

        # Revocation is checked before label comparison, so a former writer cannot
        # use the conflict payload as a read channel for the saved label.
        revoked_grant = await ada.request.fetch(
            f'/api/v1/projects/{self.project}/grants/{self.project_grant_id}', method='DELETE',
            headers={'origin': ORIGIN})
        self.assertEqual(revoked_grant.status, 204, await revoked_grant.text())
        revoked = await kai.request.fetch(f'/api/v1/sketches/{self.map_id}/links/{link["id"]}',
            method='PATCH', headers={'origin': ORIGIN, 'content-type': 'application/json',
                'idempotency-key': str(uuid.uuid4())},
            data=json.dumps({'label': 'revoked draft', 'expectedLabel': None}))
        self.assertEqual(revoked.status, 404, await revoked.text())
        revoked_body = await revoked.text()
        self.assertNotIn(current, revoked_body)
        self.assertNotIn('currentLabel', revoked_body)
        self.assertNotIn('"current"', revoked_body)

    async def test_connection_label_save_uses_live_fence_and_replays_same_private_attempt(self):
        await self.create_map(2)
        ada, kai = self.pages['ada'], self.pages['kai']
        source, target = self.thoughts
        link = await self.api(kai, 'POST', f'/api/v1/sketches/{self.map_id}/links',
            {'fromId': source['id'], 'toId': target['id']}, 201,
            {'idempotency-key': str(uuid.uuid4())})
        for page in (ada, kai):
            await page.goto(f'/map/{self.map_id}')
            await expect(page.locator('[data-live-map-status="live"]')).to_be_visible()

        start_frame = len(self.frames['kai'])
        await ada.locator(f'.sk-node[data-id="{source["id"]}"]').click()
        await ada.get_by_role('toolbar', name='Selection actions').get_by_role(
            'button', name='Connections', exact=True).click()
        await ada.get_by_role('dialog', name='Connections').get_by_role(
            'button', name=f'Add label for connection to {target["text"]}', exact=True).click()
        editor = ada.get_by_role('dialog', name='Connection label')
        label = 'confirmed through the live map'
        field = editor.get_by_role('textbox', name='Label', exact=True)
        await field.fill(label)

        attempts = []
        retry_started = asyncio.Event()
        release_retry = asyncio.Event()

        async def lose_receipt_and_hold_replay(route):
            if route.request.method != 'PATCH':
                await route.continue_()
                return
            attempts.append(route.request.headers.get('idempotency-key'))
            if len(attempts) == 1:
                committed = await route.fetch()
                self.assertEqual(committed.status, 200, await committed.text())
                # The database and live room commit, but this browser loses its receipt.
                await route.abort('failed')
            elif len(attempts) == 2:
                retry_started.set()
                await asyncio.wait_for(release_retry.wait(), timeout=10)
                await route.continue_()
            else:
                await route.continue_()

        endpoint = f'**/api/v1/sketches/{self.map_id}/links/{link["id"]}'
        await ada.route(endpoint, lose_receipt_and_hold_replay)
        try:
            await editor.get_by_role('button', name='Save', exact=True).click()
            await asyncio.wait_for(retry_started.wait(), timeout=10)
            await expect(field).to_have_value(label)

            # No reload or read-triggered refresh: the other authorized browser sees
            # a real map delta while the owner's replay is deliberately still held.
            peer_label = kai.locator('.sk-labels').get_by_text(label, exact=True)
            await expect(peer_label).to_be_visible()
            received = [row for row in self.frames['kai'][start_frame:]
                        if row['direction'] == 'received' and row['header'].get('type') == 'map-delta']
            self.assertTrue(received, 'the peer rendered the label from a live map delta')
            peer_readback = await self.api(kai, 'GET', f'/api/v1/sketches/{self.map_id}')
            self.assertEqual(next(item for item in peer_readback['links'] if item['id'] == link['id'])['label'], label,
                'an authorized peer read returns the committed label before the owner receives its replay receipt')
            self.assertEqual(len(attempts), 2)
            self.assertTrue(attempts[0])
            self.assertEqual(attempts, [attempts[0], attempts[0]], 'unknown receipt replay preserves the private save attempt identity')
        finally:
            release_retry.set()
        await expect(editor).to_have_count(0)
        owner_readback = await self.api(ada, 'GET', f'/api/v1/sketches/{self.map_id}')
        self.assertEqual(next(item for item in owner_readback['links'] if item['id'] == link['id'])['label'], label)
        await ada.unroute(endpoint, lose_receipt_and_hold_replay)

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

    async def test_signed_positions_preview_and_land_for_the_peer(self):
        """#509 AC-2: on the live map a thought moves into negative space; the peer sees the preview and the landing."""
        await self.create_map(2)
        ada, kai = self.pages['ada'], self.pages['kai']
        first = self.thoughts[0]
        owner = ada.locator(f'.sk-node[data-id="{first["id"]}"]')
        peer = kai.locator(f'.sk-node[data-id="{first["id"]}"]')
        version = await owner.get_attribute('data-thought-version')
        # Pan into the empty plane above and left of the first thought, then drop it there.
        await ada.locator('.sk-canvas').evaluate('el => { el.scrollLeft -= 300; el.scrollTop -= 300; }')
        bounds = await owner.bounding_box()
        self.assertIsNotNone(bounds)
        await ada.mouse.move(bounds['x'] + 20, bounds['y'] + 20)
        await ada.mouse.down()
        await ada.mouse.move(bounds['x'] - 180, bounds['y'] - 140, steps=6)
        await expect(peer).to_have_attribute('data-live-mover', 'Ada North')
        await expect(peer).to_have_attribute('data-thought-x', str(first['x'] - 200))
        await ada.mouse.up()
        await expect(owner).not_to_have_attribute('data-thought-version', version)
        await self.map_saved(ada)
        stored = next(item for item in (await self.api(kai, 'GET', f'/api/v1/sketches/{self.map_id}'))['thoughts'] if item['id'] == first['id'])
        self.assertEqual((stored['x'], stored['y']), (first['x'] - 200, first['y'] - 160))
        self.assertLess(stored['x'], 0)
        self.assertLess(stored['y'], 0)
        await expect(peer).to_have_attribute('data-thought-x', str(stored['x']))
        await expect(peer).to_have_attribute('data-thought-y', str(stored['y']))
