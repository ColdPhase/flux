"""#228 natural live-map lease expiry: real pointer/socket/API; no synthetic transport or DOM input."""
import asyncio
import json
import os
import unittest

from playwright.async_api import expect
from test_live_editing import LiveFixture


@unittest.skipUnless(os.environ.get("FLUX_LIVE_EDITING_TEST") == "1",
                     "#228 expiry needs the explicitly enabled isolated candidate")
class LiveMapLeaseExpiry(LiveFixture):
    async def test_01_server_expiry_keeps_private_movement_without_echo_cancel(self):
        await self.create_map(2)
        owner, peer_page = self.pages["ada"], self.pages["kai"]
        thought = self.thoughts[0]
        node = owner.locator(f'.sk-node[data-id="{thought["id"]}"]')
        peer = peer_page.locator(f'.sk-node[data-id="{thought["id"]}"]')
        key = f"flux:map-gesture:{self.ada_id}:{self.map_id}"
        self.assertIsNone(await owner.evaluate("key => sessionStorage.getItem(key)", key))
        box = await node.bounding_box()
        x, y = box["x"] + 20, box["y"] + 20
        await owner.mouse.move(x, y)
        await owner.mouse.down()
        try:
            for step in range(1, 9):
                await owner.mouse.move(x + 6 * step, y + 5 * step)
                await owner.wait_for_timeout(16)
            await expect(peer).to_have_attribute("data-live-mover", "Ada North")
            lease = await peer.get_attribute("data-live-lease")
            gesture = await peer.get_attribute("data-live-gesture")
            self.assertTrue(lease)
            self.assertTrue(gesture)
            # Stop moving with the real pointer still down. The unchanged server5s lease expires.
            await owner.wait_for_function("key => sessionStorage.getItem(key) !== null", arg=key)
            await expect(owner.locator(".editing-map-recovery")).to_be_visible()
            private = json.loads(await owner.evaluate("key => sessionStorage.getItem(key)", key))
            self.assertEqual(private["gestureId"], gesture)
            self.assertEqual(private["versions"], [[thought["id"], thought["version"]]])
            self.assertGreater(private["positions"][0]["x"], thought["x"])

            async def server_cleared():
                while not any(row["direction"] == "received"
                              and row["header"].get("type") == "map-clear"
                              and row["header"].get("leaseId") == lease for row in self.frames["ada"]):
                    await asyncio.sleep(.02)
            await asyncio.wait_for(server_cleared(), 5)
            await expect(peer).not_to_have_attribute("data-live-mover", "Ada North")
            self.assertFalse(any(row["direction"] == "sent"
                                 and row["header"].get("type") == "map-cancel"
                                 and row["header"].get("leaseId") == lease for row in self.frames["ada"]),
                             "a server-cleared/expired lease is retired locally, never echo-cancelled")
            self.assertEqual([row for rows in self.frames.values() for row in rows
                              if row["direction"] == "received" and row["header"].get("type") in ("error", "resync", "revoked")],
                             [], "the real socket must retain the no-error guard")
            saved = next(item for item in (await self.api(peer_page, "GET", f"/api/v1/sketches/{self.map_id}"))["thoughts"]
                         if item["id"] == thought["id"])
            self.assertEqual((saved["version"], saved["x"], saved["y"]),
                             (thought["version"], thought["x"], thought["y"]), "expiry never commits the unfinished movement")
        finally:
            await owner.mouse.up()
        after_release = next(item for item in (await self.api(peer_page, "GET", f"/api/v1/sketches/{self.map_id}"))["thoughts"]
                             if item["id"] == thought["id"])
        self.assertEqual((after_release["version"], after_release["x"], after_release["y"]),
                         (thought["version"], thought["x"], thought["y"]), "late pointerup cannot commit an expired gesture")
        self.assertEqual(json.loads(await owner.evaluate("key => sessionStorage.getItem(key)", key)), private)
        self.assertEqual([row for rows in self.frames.values() for row in rows
                          if row["direction"] == "received" and row["header"].get("type") in ("error", "resync", "revoked")], [])
