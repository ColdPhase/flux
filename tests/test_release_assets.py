"""Release packaging must reject images that can drift from the accepted candidate."""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "release"))
from prepare_assets import MARKER, prepare  # noqa: E402


class ReleaseAssetsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.sources = {}
        for name, content in {
            "compose.yaml": "services:\n  migrate:\n    image: " + MARKER + "\n"
            "  api:\n    image: " + MARKER + "\n"
            "  worker:\n    image: " + MARKER + "\n"
            "  db:\n    image: postgres@sha256:" + "f" * 64 + "\n",
            ".env.example": "POSTGRES_PASSWORD=change-me\n",
            "INSTALL.md": "Install instructions\n",
            "LICENSE": "AGPL-3.0\n",
            "sbom.spdx.json": '{"packages":[{"name":"postgres","versionInfo":"18.1","licenseDeclared":"PostgreSQL"}]}\n',
        }.items():
            path = self.root / name
            path.write_text(content, encoding="utf-8")
            self.sources[name] = path

    def build(self) -> Path:
        output = self.root / "release"
        prepare(
            version="v1.2.3", source_sha="a" * 40, digest="sha256:" + "b" * 64,
            compose=self.sources["compose.yaml"], env=self.sources[".env.example"],
            instructions=self.sources["INSTALL.md"], license_file=self.sources["LICENSE"],
            sbom=self.sources["sbom.spdx.json"], destination=output,
        )
        return output

    def test_assets_pin_all_flux_services_and_checksums(self) -> None:
        output = self.build()
        compose = (output / "compose.yaml").read_text(encoding="utf-8")
        self.assertNotIn("RELEASE_DIGEST", compose)
        self.assertEqual(compose.count("ghcr.io/coldphase/flux@sha256:" + "b" * 64), 3)
        self.assertEqual(json.loads((output / "release.json").read_text())["source_sha"], "a" * 40)
        self.assertEqual(json.loads((output / "THIRD_PARTY_NOTICES.json").read_text())[0]["name"], "postgres")
        for line in (output / "SHA256SUMS").read_text().splitlines():
            checksum, filename = line.split("  ")
            self.assertEqual(hashlib.sha256((output / filename).read_bytes()).hexdigest(), checksum)

    def test_rejects_source_build_and_incomplete_pin(self) -> None:
        compose = self.sources["compose.yaml"]
        compose.write_text(compose.read_text().replace(MARKER, "flux:latest", 1))
        with self.assertRaisesRegex(ValueError, "marker"):
            self.build()
        compose.write_text(compose.read_text().replace("flux:latest", MARKER) + "  build: .\n")
        with self.assertRaisesRegex(ValueError, "pull-only"):
            self.build()

    def test_rejects_invalid_identity_and_stale_destination(self) -> None:
        output = self.build()
        with self.assertRaisesRegex(ValueError, "empty"):
            self.build()
        with self.assertRaisesRegex(ValueError, "digest"):
            prepare(
                version="v1.2.3", source_sha="a" * 40, digest="sha256:nope",
                compose=self.sources["compose.yaml"], env=self.sources[".env.example"],
                instructions=self.sources["INSTALL.md"], license_file=self.sources["LICENSE"],
                sbom=self.sources["sbom.spdx.json"], destination=self.root / "other",
            )


if __name__ == "__main__":
    unittest.main()
