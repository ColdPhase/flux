"""#228 AC-3 map delivery recovery: reorder only genuine authorized server frames."""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
import unittest
from datetime import datetime

from playwright.async_api import expect
from test_live_editing import LiveFixture


@unittest.skipUnless(os.environ.get("FLUX_LIVE_EDITING_TEST") == "1",
                     "#228 delivery recovery needs the explicitly enabled isolated candidate")
class LiveMapDeliveryOrder(LiveFixture):
    async def test_01_reordered_duplicates_and_cleared_or_expired_previews_never_regress(self):
        state = {"socket": None, "first": None, "newer": None, "cleared": None, "expired": None,
                 "duplicated": [], "retained_bytes": 0, "retained_count": 0, "max_retained_count": 0}

        def relay(socket):
            state["socket"] = socket
            server = socket.connect_to_server()

            def received(payload):
                if isinstance(payload, str):
                    try:
                        value = json.loads(payload)
                    except ValueError:
                        value = None
                    if isinstance(value, dict) and value.get("type") == "map-move":
                        frame = {"payload": payload, "generation": value.get("generation"),
                                 "gestureId": value.get("gestureId"), "leaseId": value.get("leaseId"),
                                 "sequence": value.get("sequence"), "expiresAt": value.get("expiresAt")}
                        size = len(payload.encode("utf-8"))
                        if size > 65_536:
                            raise AssertionError("One held actual map frame exceeded the existing wire frame bound")
                        if state["first"] is None:
                            frame["bytes"] = size
                            state["first"] = frame
                            state["retained_bytes"] += size
                            state["retained_count"] += 1
                            state["max_retained_count"] = max(state["max_retained_count"], state["retained_count"])
                            return
                        if state["newer"] is None:
                            state["newer"] = frame
                            socket.send(payload)
                            socket.send(payload)  # Duplicate this exact real authorized server frame.
                            state["duplicated"] = [frame["sequence"], frame["sequence"]]
                            return
                        if state["cleared"] is None:
                            frame["bytes"] = size
                            state["cleared"] = frame
                            state["retained_bytes"] += size
                            state["retained_count"] += 1
                            state["max_retained_count"] = max(state["max_retained_count"], state["retained_count"])
                            return
                        if state["expired"] is None:
                            frame["bytes"] = size
                            state["expired"] = frame
                            state["retained_bytes"] += size
                            state["retained_count"] += 1
                            state["max_retained_count"] = max(state["max_retained_count"], state["retained_count"])
                            return
                socket.send(payload)

            server.on_message(received)

        kai = self.pages["kai"]
        await kai.route_web_socket(re.compile(r".*/api/v1/editing\?kind=map.*"), relay)
        await self.create_map(2)
        ada = self.pages["ada"]
        thought = self.thoughts[0]
        owner_node = ada.locator(f'.sk-node[data-id="{thought["id"]}"]')
        peer_node = kai.locator(f'.sk-node[data-id="{thought["id"]}"]')
        await kai.evaluate("""() => {
          window.__lateMapMoverEvents = [];
          new MutationObserver(records => {
            for (const record of records) window.__lateMapMoverEvents.push({
              id: record.target.dataset.id, value: record.target.getAttribute('data-live-mover')
            });
          }).observe(document, {subtree: true, attributes: true, attributeFilter: ['data-live-mover']});
        }""")

        bounds = await owner_node.bounding_box()
        x, y = bounds["x"] + 20, bounds["y"] + 20
        await ada.mouse.move(x, y)
        await ada.mouse.down()

        async def move_until(name):
            loop = asyncio.get_running_loop()
            deadline = loop.time() + 5
            step = 0
            while state[name] is None:
                step += 1
                await ada.mouse.move(x + 12 + step * 2, y + 8 + step, steps=1)
                await ada.wait_for_timeout(45)
                if loop.time() >= deadline:
                    self.fail(f"The real authorized socket never delivered its {name} frame")

        try:
            await move_until("newer")
            first, newer = state["first"], state["newer"]
            self.assertEqual((first["generation"], first["gestureId"], first["leaseId"]),
                             (newer["generation"], newer["gestureId"], newer["leaseId"]))
            self.assertGreater(newer["sequence"], first["sequence"])
            await expect(peer_node).to_have_attribute("data-live-preview-sequence", str(newer["sequence"]))
            await expect(peer_node).to_have_attribute("data-live-mover", "Ada North")

            # A lower sequence is now delivered after the higher one; the visible preview must stay current.
            state["socket"].send(first["payload"])
            first["payload"] = None
            state["retained_bytes"] -= first["bytes"]
            state["retained_count"] -= 1
            await ada.wait_for_timeout(100)
            await expect(peer_node).to_have_attribute("data-live-preview-sequence", str(newer["sequence"]))
            self.assertEqual(state["duplicated"], [newer["sequence"], newer["sequence"]])

            await move_until("expired")
            cleared, expired = state["cleared"], state["expired"]
            self.assertEqual((cleared["generation"], cleared["gestureId"], cleared["leaseId"]),
                             (newer["generation"], newer["gestureId"], newer["leaseId"]))
            self.assertGreater(cleared["sequence"], newer["sequence"])
            self.assertGreater(expired["sequence"], cleared["sequence"])
            self.assertLessEqual(state["retained_bytes"], 2 * 65_536,
                                 "Only two bounded genuine server frames are held")
            self.assertEqual(state["max_retained_count"], 2)
            await ada.mouse.up()
            await self.map_saved(ada)
            await expect(peer_node).not_to_have_attribute("data-live-mover", "Ada North")

            transitions = await kai.evaluate("id => window.__lateMapMoverEvents.filter(event => event.id === id).map(event => event.value)", thought["id"])
            self.assertIn(None, transitions, "The actual committed map delta clears the preview before replay")
            prior_additions = transitions.count("Ada North")

            # Replay a captured same-lease movement frame after the authoritative commit cleared that lease.
            self.assertGreater(datetime.fromisoformat(cleared["expiresAt"].replace("Z", "+00:00")).timestamp() * 1000,
                               time.time() * 1000,
                               "The first post-clear replay is still within its genuine server expiry")
            state["socket"].send(cleared["payload"])
            await ada.wait_for_timeout(100)
            await expect(peer_node).not_to_have_attribute("data-live-mover", "Ada North")
            transitions = await kai.evaluate("id => window.__lateMapMoverEvents.filter(event => event.id === id).map(event => event.value)", thought["id"])
            self.assertEqual(transitions.count("Ada North"), prior_additions,
                             "A late frame for the cleared lease never briefly revives its overlay")

            expiry_ms = datetime.fromisoformat(expired["expiresAt"].replace("Z", "+00:00")).timestamp() * 1000
            wait_ms = max(0, expiry_ms - time.time() * 1000 + 1100)
            await ada.wait_for_timeout(wait_ms)
            state["socket"].send(expired["payload"])
            await ada.wait_for_timeout(100)
            await expect(peer_node).not_to_have_attribute("data-live-mover", "Ada North")
            transitions = await kai.evaluate("id => window.__lateMapMoverEvents.filter(event => event.id === id).map(event => event.value)", thought["id"])
            self.assertEqual(transitions.count("Ada North"), prior_additions,
                             "An actually expired genuine frame cannot revive the overlay")

            saved = next(item for item in (await self.api(kai, "GET", f"/api/v1/sketches/{self.map_id}"))["thoughts"]
                         if item["id"] == thought["id"])
            self.assertEqual(saved["version"], thought["version"] + 1)
            self.assertNotEqual((saved["x"], saved["y"]), (thought["x"], thought["y"]))
            await expect(peer_node).to_have_attribute("data-thought-x", str(saved["x"]))
            await expect(peer_node).to_have_attribute("data-thought-y", str(saved["y"]))
            self.assertFalse([row for rows in self.frames.values() for row in rows
                              if row["direction"] == "received"
                              and row["header"].get("type") in ("error", "resync", "revoked")])
        finally:
            await ada.mouse.up()
