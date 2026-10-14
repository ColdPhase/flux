"""Temporary visual evidence harness for #389; mounted read-only into ui-test."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path

from playwright.async_api import expect
from test_live_editing import LiveEditingJourney


async def main() -> None:
    output = Path(os.environ["FLUX_UI_SCREENSHOTS"])
    output.mkdir(parents=True, exist_ok=True)
    case = LiveEditingJourney(
        "test_02_ordinary_reader_tracks_working_text_and_history_stays_saved"
    )
    await case.asyncSetUp()
    try:
        await case.create_doc(
            "A saved starting paragraph.\n\n## Saved reference\n\n"
            "The saved copy remains unchanged while Ada edits."
        )
        writer = case.pages["ada"]
        reader = case.pages["kai"]
        field = await case.editor("ada")
        await reader.goto(case.doc_url)
        await expect(reader.locator("[data-live-reader]")).to_be_visible()
        await case.type_text(
            writer,
            field,
            "\n\n## Working heading\n\nThe live reader sees this before Save.",
        )
        await expect(reader.locator(".doc-prose h2").filter(has_text="Working heading")).to_be_visible()
        await expect(reader.locator(".doc-prose")).to_contain_text("The live reader sees this before Save.")
        await expect(reader.get_by_role("complementary", name="On this page").get_by_role("link", name="Working heading")).to_be_visible()
        await reader.screenshot(path=str(output / "live-reader-desktop-1440-light.png"))
        await reader.set_viewport_size({"width": 390, "height": 844})
        await reader.wait_for_timeout(450)
        await reader.screenshot(path=str(output / "live-reader-phone-390-light.png"))
    finally:
        await case.asyncTearDown()


if __name__ == "__main__":
    asyncio.run(main())
