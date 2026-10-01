"""Release packaging must reject images that can drift from the accepted candidate."""

from __future__ import annotations

import hashlib
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "release"))
from prepare_assets import ASSET_NAME, IMAGE, MARKER, prepare, render_compose  # noqa: E402

REAL_COMPOSE = ROOT / "docker" / "compose.yaml"
REAL_ENV = ROOT / "docker" / ".env.example"
GUIDE = ROOT / "docs" / "operations" / "release-guide.md"


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

    def test_rejects_marker_on_wrong_service(self) -> None:
        compose = self.sources["compose.yaml"]
        text = compose.read_text().replace("  api:\n    image: " + MARKER, "  api:\n    image: flux:v1")
        text += "  unrelated:\n    image: " + MARKER + "\n"
        compose.write_text(text)
        with self.assertRaisesRegex(ValueError, "api, worker and migrate"):
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

    def test_asset_names_must_survive_github(self) -> None:
        # GitHub stores a leading-period asset under another name and Actions artifacts skip it.
        for name in (".env.example", "env.", "-env", "a b", "a/b", ""):
            with self.subTest(name=name):
                self.assertIsNone(ASSET_NAME.fullmatch(name))
        for name in ("env.example", "default.env.example", "THIRD_PARTY_NOTICES.json", "SHA256SUMS", "a"):
            with self.subTest(name=name):
                self.assertIsNotNone(ASSET_NAME.fullmatch(name))

    def test_release_header_replaces_only_the_leading_comment_block(self) -> None:
        template = (
            "# repository header: RELEASE_DIGEST is replaced by the release workflow\n#\n"
            "name: ${FLUX_PROJECT:-flux}\n# keep this comment\nservices:\n"
            "  migrate:\n    image: " + MARKER + "\n  api:\n    image: " + MARKER + "\n"
            "  worker:\n    image: " + MARKER + "\n"
        )
        pinned = f"{IMAGE}@sha256:" + "c" * 64
        rendered = render_compose(template, version="v2.0.0", source_sha="d" * 40, digest=pinned.split("@")[1])
        self.assertTrue(rendered.startswith("# Flux v2.0.0 operator Compose, built from source commit " + "d" * 40))
        self.assertNotIn("repository header", rendered)
        self.assertNotIn("RELEASE_DIGEST", rendered)
        self.assertIn("name: ${FLUX_PROJECT:-flux}\n# keep this comment\nservices:\n", rendered)
        self.assertEqual(rendered.count(f"image: {pinned}\n"), 3)


class RealOperatorAssetsTest(unittest.TestCase):
    """The repository's own operator files (#76) must package without any adjustment."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        sbom = root / "sbom.spdx.json"
        sbom.write_text('{"packages":[{"name":"flux","versionInfo":"1.0.0"}]}\n', encoding="utf-8")
        self.output = root / "release"
        self.digest = "sha256:" + "b" * 64
        prepare(
            version="v1.2.3-rc.1", source_sha="a" * 40, digest=self.digest,
            compose=REAL_COMPOSE, env=REAL_ENV, instructions=GUIDE,
            license_file=ROOT / "LICENSE", sbom=sbom, destination=self.output,
        )

    def test_asset_set_and_checksums(self) -> None:
        names = {path.name for path in self.output.iterdir()}
        self.assertEqual(names, {
            "compose.yaml", "env.example", "INSTALL.md", "LICENSE", "release.json",
            "sbom.spdx.json", "SHA256SUMS", "THIRD_PARTY_NOTICES.json",
        })
        for name in names:
            self.assertRegex(name, ASSET_NAME, "GitHub would rename this asset")
        listed = {line.split("  ")[1] for line in (self.output / "SHA256SUMS").read_text().splitlines()}
        self.assertEqual(listed, names - {"SHA256SUMS"})

    def test_compose_differs_from_the_tested_file_only_in_comments_and_the_digest(self) -> None:
        def code(text: str) -> list[str]:
            return [line for line in text.splitlines() if not line.lstrip().startswith("#")]

        packaged = (self.output / "compose.yaml").read_text(encoding="utf-8")
        expected = [line.replace(MARKER, f"{IMAGE}@{self.digest}") for line in code(REAL_COMPOSE.read_text())]
        self.assertEqual(code(packaged), expected)
        self.assertNotIn("RELEASE_DIGEST", packaged)
        self.assertEqual(packaged.count(f"image: {IMAGE}@{self.digest}\n"), 3)

    def test_compose_header_describes_the_release_not_the_repository(self) -> None:
        header = (self.output / "compose.yaml").read_text(encoding="utf-8").split("\nname:", 1)[0]
        self.assertIn("Flux v1.2.3-rc.1 operator Compose, built from source commit " + "a" * 40, header)
        self.assertIn("cp env.example .env", header)
        for stale in (".env.example", "docs/operations", "./flux", "docker/", "placeholder"):
            self.assertNotIn(stale, header)

    def test_environment_template_is_shipped_unchanged(self) -> None:
        self.assertEqual((self.output / "env.example").read_bytes(), REAL_ENV.read_bytes())

    def test_installation_guide_is_self_contained_and_matches_the_assets(self) -> None:
        guide = (self.output / "INSTALL.md").read_text(encoding="utf-8")
        self.assertEqual(guide, GUIDE.read_text(encoding="utf-8"))
        for link in re.findall(r"\]\(([^)\s]+)\)", guide):
            self.assertRegex(link, r"^https://", "INSTALL.md is read without the repository")
        for name in sorted(path.name for path in self.output.iterdir()):
            self.assertIn(name, guide, f"INSTALL.md does not mention the {name} asset")
        for source in re.findall(r"\bcp (\S+) \.env\b", guide):
            self.assertEqual(source, "env.example", "the shipped template has no leading period")
        for line in guide.splitlines():
            if "docker compose" in line:
                self.assertIn("--env-file", line, "every command must name its settings file")

    def test_installation_guide_variables_match_the_operator_files(self) -> None:
        keys = {line.partition("=")[0] for line in REAL_ENV.read_text().splitlines()
                if line.strip() and not line.startswith("#")}
        guide = GUIDE.read_text(encoding="utf-8")
        mentioned = set(re.findall(r"`((?:FLUX|POSTGRES)_[A-Z0-9_]+)`", guide))
        self.assertEqual(sorted(mentioned - keys), [], "INSTALL.md names a variable the template lacks")
        compose = "\n".join(line for line in REAL_COMPOSE.read_text().splitlines() if not line.lstrip().startswith("#"))
        required = set(re.findall(r"\$\{([A-Z_]+):\?", compose))
        self.assertEqual(required, {"POSTGRES_PASSWORD", "FLUX_AUTH_SECRET", "FLUX_PUBLIC_ORIGIN"})
        for name in required:
            self.assertRegex(guide, rf"\| `{name}` \| yes \|", f"{name} must be listed as required")


if __name__ == "__main__":
    unittest.main()
