"""A draft cannot carry an asset that the reviewed SHA256SUMS does not cover."""

from __future__ import annotations

import hashlib
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "release"))
from check_asset_set import verify  # noqa: E402


class AssetSetTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        lines = []
        for name in ("compose.yaml", "env.example"):
            (self.root / name).write_text(name, encoding="utf-8")
            lines.append(f"{hashlib.sha256(name.encode()).hexdigest()}  {name}\n")
        (self.root / "SHA256SUMS").write_text("".join(lines), encoding="utf-8")

    def test_exact_set_passes(self) -> None:
        verify(self.root)

    def test_unlisted_asset_is_rejected(self) -> None:
        (self.root / "extra.bin").write_text("added after review", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "unlisted .*extra.bin"):
            verify(self.root)

    def test_default_prefixed_dotfile_is_rejected(self) -> None:
        # What GitHub would store for a ".env.example" asset.
        (self.root / "default.env.example").write_text("renamed", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "default.env.example"):
            verify(self.root)

    def test_missing_listed_asset_is_rejected(self) -> None:
        (self.root / "env.example").unlink()
        with self.assertRaisesRegex(ValueError, "missing .*env.example"):
            verify(self.root)

    def test_malformed_checksum_lines_are_rejected(self) -> None:
        digest = "a" * 64
        for line in (f"{digest} compose.yaml", f"{digest[:-1]}  compose.yaml", f"{digest}  ../compose.yaml",
                     f"{digest.upper()}  compose.yaml", f"{digest}  SHA256SUMS"):
            with self.subTest(line=line):
                (self.root / "SHA256SUMS").write_text(line + "\n", encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "malformed"):
                    verify(self.root)


if __name__ == "__main__":
    unittest.main()
