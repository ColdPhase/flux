"""#228: a live undo confirms after its receipt and ordered delivery; a late confirmation never overwrites a newer status.

Run only with FLUX_LIVE_EDITING_TEST=1 against the isolated development candidate (scripts/check_ui.sh).
Before the fix, an Undo whose confirmation lagged the person's next action replaced that action's status with
"Undid: ..." and its "Saved" never showed (test_map_outline.test_05 under load).
"""
import asyncio
import os
import unittest

from playwright.async_api import expect
from test_live_editing import LiveFixture


@unittest.skipUnless(os.environ.get('FLUX_LIVE_EDITING_TEST') == '1', 'Actual isolated live candidate required')
class LiveUndoStatus(LiveFixture):
    async def test_a_late_undo_confirmation_never_replaces_a_newer_status(self):
        await self.create_map(3)
        ada = self.pages['ada']
        first, second = self.thoughts[0], self.thoughts[1]
        node = lambda thought: ada.locator(f'.sk-node[data-id="{thought["id"]}"]')
        status = ada.locator('.sk-status')
        undo = ada.get_by_role('toolbar', name='Sketch tools').get_by_role('button', name='Undo', exact=True)

        await node(first).focus()
        await ada.keyboard.press('Delete')
        await expect(node(first)).to_have_count(0)
        await expect(status).to_contain_text('Saved')

        # Undo, with its response held: the confirmation can only arrive after the next thing the person does.
        release = asyncio.Event()

        async def hold(route):
            await release.wait()
            await route.continue_()

        await ada.route('**/api/v1/sketches/*/live/undo', hold)
        await undo.click()
        await expect(status).to_contain_text('Undo requested')
        await node(second).focus()
        await ada.keyboard.press('Delete')
        await expect(status).to_contain_text('Removed')
        release.set()
        await expect(node(first)).to_have_count(1)  # the undo landed
        await expect(node(second)).to_have_count(0)  # and the later removal still stands
        await expect(status).to_contain_text('Saved')
        self.assertNotIn('Undid', await status.inner_text(), 'the late confirmation did not replace the newer status')

        # An Undo that nothing overtakes still confirms in the status line.
        await ada.unroute('**/api/v1/sketches/*/live/undo', hold)
        await undo.click()
        await expect(status).to_contain_text('Undid: removed a thought')
        self.assertEqual(self.errors, [])
