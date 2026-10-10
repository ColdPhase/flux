"""Compact Wiki Together/Join against the real local SFU; no device is turned on."""

import re
import unittest

from playwright.sync_api import expect

from test_live_sessions import LIVE, LiveBase


@unittest.skipUnless(LIVE, "requires the explicitly configured local SFU profile")
class WikiLiveMenu(LiveBase):
    def test_reader_starts_and_peer_joins_from_the_single_overflow(self) -> None:
        self.seed()
        reader = self.page("nia", phone=True)
        url = f"/projects/{self.ids['project']}/docs/{self.ids['doc']}"
        before = self.api(reader, "GET", f"/api/v1/docs/{self.ids['doc']}", status=200)
        reader.goto(url)
        reader.locator("header.top").get_by_role("button", name="More", exact=True).click()
        menu = reader.get_by_role("dialog", name="Page actions")
        menu.get_by_role("button", name="Together", exact=True).click()
        expect(menu).to_have_count(0)
        bar = self.bar(reader)
        expect(bar.get_by_role("status").first).to_contain_text("Live")
        for device in ("Microphone", "Camera"):
            expect(bar.get_by_role("button", name=re.compile(f"^{device} off"))).to_have_attribute("aria-pressed", "false")
        self.assertEqual(reader.evaluate("window.__live.gum + window.__live.gdm"), 0)
        sessions = self.api(reader, "GET", f"/api/v1/projects/{self.ids['project']}/live-sessions", status=200)["items"]
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0]["context"], {"type": "doc", "id": self.ids["doc"]})

        peer = self.page("jonas", phone=True)
        peer.goto(url)
        peer.locator("header.top").get_by_role("button", name="More", exact=True).click()
        peer.get_by_role("dialog", name="Page actions").get_by_role("button", name="Join", exact=True).click()
        expect(self.bar(peer).get_by_role("status").first).to_contain_text("Live")
        self.assertEqual(peer.evaluate("window.__live.gum + window.__live.gdm"), 0)
        self.assertEqual(len(self.api(peer, "GET", f"/api/v1/projects/{self.ids['project']}/live-sessions", status=200)["items"]), 1)
        for page in (peer, reader):
            self.bar(page).get_by_role("button", name="Leave", exact=True).click()
            expect(self.bar(page)).to_have_count(0)
        after = self.api(reader, "GET", f"/api/v1/docs/{self.ids['doc']}", status=200)
        self.assertEqual((after["body"], after["version"]), (before["body"], before["version"]))
