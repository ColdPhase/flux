"""F-030 S2b (#655): two people edit a doc and a map live in an encrypted workspace, in real Chromium.

The workspace is created through the fixture-only route of S1/S2 (the fixture bearer besides the session) and stays unlocked by
its creator. Live Wiki and live maps persist sealed (the API-level test reads the rows); here the people see each other's edits
through the real sockets, a reload rebuilds the room from the sealed rows, and the Lock closes the rooms and keeps them closed.
Run with `FLUX_UI_BROWSER=chromium ./scripts/check_ui.sh test_live_editing_sealed`.
"""
from __future__ import annotations

import os
import unittest
import uuid

from playwright.async_api import expect
from test_live_editing import LiveFixture

PASSWORD = "quartz lantern hollow meadow ripple kestrel 4821"


@unittest.skipUnless(os.environ.get("FLUX_LIVE_EDITING_TEST") == "1", "needs the live editing candidate (FLUX_LIVE_EDITING=on)")
class SealedLiveEditing(LiveFixture):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        ada = self.pages["ada"]
        created = await self.api(ada, "POST", "/api/v1/encrypted-workspaces",
            {"name": "Sealed live studio", "creationId": str(uuid.uuid4()), "password": PASSWORD}, 201,
            {"authorization": f"Bearer {os.environ['FLUX_FIXTURE_TOKEN']}"})
        self.workspace = created["workspace"]["id"]
        await self.api(ada, "POST", f"/api/v1/workspaces/{self.workspace}/members", {"email": self.kai_email, "role": "member"}, 201)
        project = await self.api(ada, "POST", f"/api/v1/workspaces/{self.workspace}/projects", {"name": "Sealed writing", "visibility": "restricted"}, 201,
            {"idempotency-key": str(uuid.uuid4())})
        self.project = project["id"]
        await self.api(ada, "POST", f"/api/v1/projects/{self.project}/grants",
            {"principal": {"kind": "human", "id": self.kai_id}, "role": "contributor"}, 201)

    async def test_01_two_people_write_one_doc_and_a_reload_rebuilds_it_from_the_sealed_rows(self):
        await self.create_doc("A sealed starting paragraph.")
        ada, kai = self.pages["ada"], self.pages["kai"]
        ada_field = await self.editor("ada")
        kai_field = await self.editor("kai")
        await self.type_text(ada, ada_field, " Ada writes the first live sentence.")
        await expect(kai_field).to_contain_text("Ada writes the first live sentence.")
        await self.type_text(kai, kai_field, " Kai answers in the same room.")
        await expect(ada_field).to_contain_text("Kai answers in the same room.")
        # A new session of the room reads the sealed snapshot and log, not a cache of this page.
        kai_again = await self.editor("kai")
        await expect(kai_again).to_contain_text("Ada writes the first live sentence.")
        await expect(kai_again).to_contain_text("Kai answers in the same room.")
        # The saved doc is still the version before the live text until someone saves.
        saved = await self.api(ada, "GET", f"/api/v1/docs/{self.doc_id}")
        self.assertNotIn("Ada writes the first live sentence.", saved["body"])

    async def test_02_a_live_map_shows_the_other_persons_edits_and_the_lock_closes_the_room(self):
        await self.create_map(2)
        ada, kai = self.pages["ada"], self.pages["kai"]
        created = await self.api(ada, "POST", f"/api/v1/sketches/{self.map_id}/thoughts",
            {"text": "Sealed idea from Ada", "x": 600, "y": 400}, 201, {"idempotency-key": str(uuid.uuid4())})
        await expect(kai.locator(f'.sk-node[data-id="{created["thought"]["id"]}"]')).to_contain_text("Sealed idea from Ada")
        await self.api(kai, "PATCH", f"/api/v1/sketches/{self.map_id}/thoughts/{created['thought']['id']}",
            {"text": "Sealed idea, edited by Kai"}, 200, {"idempotency-key": str(uuid.uuid4()), "if-match": f'"{created["thought"]["version"]}"'})
        await expect(ada.locator(f'.sk-node[data-id="{created["thought"]["id"]}"]')).to_contain_text("edited by Kai")
        # The Lock closes the rooms of both people and keeps them closed.
        await self.api(ada, "POST", f"/api/v1/workspaces/{self.workspace}/lock", {})
        for page in (ada, kai):
            await expect(page.locator('[data-live-map-status="live"]')).to_have_count(0, timeout=20000)
        # After the unlock a new session of the map is live again and holds the edits.
        await self.api(ada, "POST", f"/api/v1/workspaces/{self.workspace}/unlock", {"password": PASSWORD})
        await kai.goto(f"/map/{self.map_id}")
        await expect(kai.locator('[data-live-map-status="live"]')).to_be_visible(timeout=20000)
        await expect(kai.locator(f'.sk-node[data-id="{created["thought"]["id"]}"]')).to_contain_text("edited by Kai")


if __name__ == "__main__":
    unittest.main()
