"""Release packaging must reject images that can drift from the accepted candidate."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "release"))
from prepare_assets import (  # noqa: E402
    ASSET_NAME, IMAGE, MARKER, RUNTIME_IMAGE, RUNTIME_MARKER, codex_pin, parse_platforms, prepare, render_compose,
    render_live_compose, render_runtime_compose,
)
from verify_assets import EXPECTED, verify as verify_assets  # noqa: E402

REAL_COMPOSE = ROOT / "docker" / "compose.yaml"
REAL_ENV = ROOT / "docker" / ".env.example"
GUIDE = ROOT / "docs" / "operations" / "release-guide.md"
REAL_OVERLAY = ROOT / "docker" / "compose.runtime.yaml"
REAL_SCRIPT = ROOT / "docker" / "runtime.sh"
DOCKERFILE = ROOT / "docker" / "Dockerfile"
REAL_LIVE = ROOT / "docker" / "compose.live.yaml"
REAL_TURN = ROOT / "docker" / "compose.live.turn.yaml"
SFU = "livekit/livekit-server:v1.13.7@sha256:" + "e" * 64
LIVE = (
    "# repository header: layer with compose.source.yaml\n"
    "services:\n  api:\n    environment:\n      FLUX_LIVEKIT_API_URL: http://livekit:7880\n"
    "  livekit:\n    image: " + SFU + "\n    ports:\n      - 7882:7882/udp\n"
)
TURN = (
    "# repository header\nservices:\n  livekit:\n    volumes:\n"
    "      - ${FLUX_LIVEKIT_TURN_CERT_DIR:?Set it}:/run/livekit-turn-certs:ro,z\n"
)
RUNTIME_DIGEST = "sha256:" + "c" * 64
APP_DIGEST = "sha256:" + "b" * 64
OVERLAY = (
    "x-runtime-slot: &runtime-slot\n  image: " + RUNTIME_MARKER + "\n"
    "services:\n  runtime-install:\n    image: " + RUNTIME_MARKER + "\n"
    "  runtime-manager:\n    image: " + MARKER + "\n"
    "  runtime-egress:\n    image: " + MARKER + "\n  runtime-1:\n    <<: *runtime-slot\n"
)


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
            "  keyring:\n    image: " + MARKER + "\n"
            "  db:\n    image: postgres@sha256:" + "f" * 64 + "\n",
            ".env.example": "POSTGRES_PASSWORD=change-me\n",
            "INSTALL.md": "Install instructions\n",
            "LICENSE": "AGPL-3.0\n",
            "compose.runtime.yaml": OVERLAY,
            "runtime.sh": "#!/bin/sh\necho runtime\n",
            "compose.live.yaml": LIVE,
            "compose.live.turn.yaml": TURN,
            "Dockerfile": "ADD https://github.com/openai/codex/releases/download/rust-v0.9.1/codex-x86_64.tar.gz /c.tgz\n",
            "sbom-agent-runtime.spdx.json": '{"packages":[{"name":"node","versionInfo":"24","licenseDeclared":"MIT"}]}\n',
            "sbom.spdx.json": '{"packages":[{"name":"postgres","versionInfo":"18.1","licenseDeclared":"PostgreSQL"}]}\n',
        }.items():
            path = self.root / name
            path.write_text(content, encoding="utf-8")
            self.sources[name] = path

    def runtime_args(self) -> dict:
        return dict(
            runtime_digest=RUNTIME_DIGEST, runtime_compose=self.sources["compose.runtime.yaml"],
            runtime_script=self.sources["runtime.sh"], runtime_sbom=self.sources["sbom-agent-runtime.spdx.json"],
            dockerfile=self.sources["Dockerfile"], live_compose=self.sources["compose.live.yaml"],
            live_turn_compose=self.sources["compose.live.turn.yaml"],
        )

    def build(self) -> Path:
        output = self.root / "release"
        prepare(
            version="v1.2.3", source_sha="a" * 40, digest=APP_DIGEST,
            compose=self.sources["compose.yaml"], env=self.sources[".env.example"],
            instructions=self.sources["INSTALL.md"], license_file=self.sources["LICENSE"],
            sbom=self.sources["sbom.spdx.json"], destination=output, **self.runtime_args(),
        )
        return output

    def test_assets_pin_all_flux_services_and_checksums(self) -> None:
        output = self.build()
        compose = (output / "compose.yaml").read_text(encoding="utf-8")
        self.assertNotIn("RELEASE_DIGEST", compose)
        self.assertEqual(compose.count("ghcr.io/coldphase/flux@sha256:" + "b" * 64), 4)
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
        with self.assertRaisesRegex(ValueError, "api, worker, keyring and migrate"):
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
                sbom=self.sources["sbom.spdx.json"], destination=self.root / "other", **self.runtime_args(),
            )
        with self.assertRaisesRegex(ValueError, "runtime image digest"):
            prepare(
                version="v1.2.3", source_sha="a" * 40, digest=APP_DIGEST,
                compose=self.sources["compose.yaml"], env=self.sources[".env.example"],
                instructions=self.sources["INSTALL.md"], license_file=self.sources["LICENSE"],
                sbom=self.sources["sbom.spdx.json"], destination=self.root / "other",
                **{**self.runtime_args(), "runtime_digest": "latest"},
            )
        with self.assertRaisesRegex(ValueError, "different digests"):
            prepare(
                version="v1.2.3", source_sha="a" * 40, digest=APP_DIGEST,
                compose=self.sources["compose.yaml"], env=self.sources[".env.example"],
                instructions=self.sources["INSTALL.md"], license_file=self.sources["LICENSE"],
                sbom=self.sources["sbom.spdx.json"], destination=self.root / "other",
                **{**self.runtime_args(), "runtime_digest": APP_DIGEST},
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
            "  keyring:\n    image: " + MARKER + "\n"
        )
        pinned = f"{IMAGE}@sha256:" + "c" * 64
        rendered = render_compose(template, version="v2.0.0", source_sha="d" * 40, digest=pinned.split("@")[1])
        self.assertTrue(rendered.startswith("# Flux v2.0.0 operator Compose, built from source commit " + "d" * 40))
        self.assertNotIn("repository header", rendered)
        self.assertNotIn("RELEASE_DIGEST", rendered)
        self.assertIn("name: ${FLUX_PROJECT:-flux}\n# keep this comment\nservices:\n", rendered)
        self.assertEqual(rendered.count(f"image: {pinned}\n"), 4)

    def test_runtime_assets_pin_both_images_and_record_codex(self) -> None:
        output = self.build()
        overlay = (output / "compose.runtime.yaml").read_text(encoding="utf-8")
        self.assertEqual(overlay.count(f"image: {RUNTIME_IMAGE}@{RUNTIME_DIGEST}\n"), 2)
        self.assertEqual(overlay.count(f"image: {IMAGE}@{APP_DIGEST}\n"), 2)
        self.assertNotIn("_DIGEST", overlay)
        release = json.loads((output / "release.json").read_text())
        self.assertEqual(release["runtime_image"], f"{RUNTIME_IMAGE}@{RUNTIME_DIGEST}")
        self.assertEqual(release["runtime_codex"], "rust-v0.9.1")
        self.assertTrue(release["runtime_claude_code"].startswith("not included"))
        notices = json.loads((output / "THIRD_PARTY_NOTICES.agent-runtime.json").read_text())
        self.assertIn(("codex-cli", "0.9.1", "Apache-2.0"), {(n["name"], n["version"], n["license_declared"]) for n in notices})
        self.assertEqual({path.name for path in output.iterdir()}, EXPECTED)

    def test_rejects_runtime_overlay_with_a_build_or_a_stray_image(self) -> None:
        overlay = self.sources["compose.runtime.yaml"]
        original = overlay.read_text()
        overlay.write_text(original + "  extra:\n    image: busybox:latest\n")
        with self.assertRaisesRegex(ValueError, "and nothing else"):
            self.build()
        overlay.write_text(original.replace("  runtime-egress:\n    image: " + MARKER, "  runtime-egress:\n    image: " + RUNTIME_MARKER))
        with self.assertRaisesRegex(ValueError, "and nothing else"):
            self.build()
        overlay.write_text(original + "  runtime-9:\n    build: .\n")
        with self.assertRaisesRegex(ValueError, "pull-only"):
            self.build()

    def test_rejects_a_socket_in_the_runtime_script_and_an_unpinned_codex(self) -> None:
        self.sources["runtime.sh"].write_text("docker -H unix:///var/run/docker.sock ps\n")
        with self.assertRaisesRegex(ValueError, "socket"):
            self.build()
        self.sources["runtime.sh"].write_text("echo ok\n")
        self.sources["Dockerfile"].write_text(
            "ADD https://github.com/openai/codex/releases/download/rust-v0.9.1/a.tgz /a\n"
            "ADD https://github.com/openai/codex/releases/download/rust-v0.9.2/b.tgz /b\n")
        with self.assertRaisesRegex(ValueError, "exactly one"):
            self.build()

    def test_platforms_default_to_amd64_and_arm64_can_be_named_again(self) -> None:
        release = json.loads((self.build() / "release.json").read_text())
        self.assertEqual((release["platforms"], release["runtime_platforms"]), (["linux/amd64"], ["linux/amd64"]))
        self.assertEqual(verify_assets(self.root / "release", None, None, None, "linux/amd64")["platforms"], "linux/amd64")
        with self.assertRaisesRegex(ValueError, "expected linux/amd64,linux/arm64"):
            verify_assets(self.root / "release", None, None, None, "linux/amd64,linux/arm64")
        output = self.root / "both"
        prepare(
            version="v1.2.3", source_sha="a" * 40, digest=APP_DIGEST,
            compose=self.sources["compose.yaml"], env=self.sources[".env.example"],
            instructions=self.sources["INSTALL.md"], license_file=self.sources["LICENSE"],
            sbom=self.sources["sbom.spdx.json"], destination=output,
            platforms="linux/arm64,linux/amd64", **self.runtime_args(),
        )
        self.assertEqual(json.loads((output / "release.json").read_text())["platforms"], ["linux/amd64", "linux/arm64"])
        self.assertEqual(parse_platforms("linux/arm64"), ["linux/arm64"])
        for bad in ("", "linux/amd64,", "linux/riscv64", "linux/amd64,linux/amd64", "amd64"):
            with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, "subset"):
                parse_platforms(bad)

    def test_live_overlays_ship_digest_pinned_with_a_release_header(self) -> None:
        output = self.build()
        live = (output / "compose.live.yaml").read_text()
        self.assertTrue(live.startswith("# Flux v1.2.3 live-media overlay"))
        self.assertNotIn("repository header", live)
        self.assertIn("services:\n  api:\n", live)
        self.assertEqual(json.loads((output / "release.json").read_text())["live_media_image"], SFU)
        self.assertIn("TURN/TLS overlay", (output / "compose.live.turn.yaml").read_text())
        self.assertEqual({path.name for path in output.iterdir()}, EXPECTED)

    def test_rejects_live_overlays_that_build_float_or_point_into_a_checkout(self) -> None:
        cases = {
            "pull-only": LIVE + "    build: .\n",
            "not pinned": LIVE.replace(SFU, "livekit/livekit-server:v1.13.7"),
            "source path": LIVE + "    volumes:\n      - ./livekit.yaml:/etc/livekit.yaml\n",
            "must not name": LIVE + "  x:\n    image: " + MARKER + "\n",
        }
        for message, text in cases.items():
            with self.subTest(message):
                with self.assertRaisesRegex(ValueError, message):
                    render_live_compose("compose.live.yaml", text, version="v1.2.3", source_sha="a" * 40)
        self.sources["compose.live.turn.yaml"].write_text(TURN + "  coturn:\n    image: " + SFU + "\n")
        with self.assertRaisesRegex(ValueError, "compose.live.turn.yaml none"):
            self.build()

    def test_verify_assets_accepts_the_prepared_set_and_refuses_each_tampering(self) -> None:
        output = self.build()
        self.assertEqual(verify_assets(output, "v1.2.3", "a" * 40, APP_DIGEST)["runtime"], f"{RUNTIME_IMAGE}@{RUNTIME_DIGEST}")
        with self.assertRaisesRegex(ValueError, "release.json version"):
            verify_assets(output, "v9.9.9", None, None)
        with self.assertRaisesRegex(ValueError, "accepted digest"):
            verify_assets(output, None, None, "sha256:" + "d" * 64)

        def retouch(name: str, mutate) -> Path:
            copy = self.root / f"tampered-{len(list(self.root.glob('tampered-*')))}"
            shutil.copytree(output, copy)
            target = copy / name
            target.write_text(mutate(target.read_text()), encoding="utf-8")
            sums = [
                f"{hashlib.sha256((copy / f.name).read_bytes()).hexdigest()}  {f.name}\n"
                for f in sorted(copy.iterdir()) if f.name != "SHA256SUMS"
            ]
            (copy / "SHA256SUMS").write_text("".join(sums), encoding="utf-8")  # a consistent checksum list
            return copy

        cases = {
            "runtime image swapped for the application image":
                ("compose.runtime.yaml", lambda t: t.replace(f"{RUNTIME_IMAGE}@{RUNTIME_DIGEST}", f"{IMAGE}@{APP_DIGEST}", 1), "expected the two release images"),
            "floating tag": ("compose.runtime.yaml", lambda t: t + "  x:\n    image: foo:latest\n", "floating tag"),
            "source build": ("compose.yaml", lambda t: t + "  build: .\n", "source build"),
            "engine socket": ("runtime.sh", lambda t: t + "\n# /var/run/docker.sock\n", "socket"),
            "claude code claimed": ("release.json", lambda t: t.replace("not included", "bundled"), "Claude Code"),
            "sfu swapped": ("compose.live.yaml", lambda t: t.replace(SFU, SFU.replace("e" * 64, "d" * 64)), "live_media_image"),
            "sfu floating": ("compose.live.yaml", lambda t: t.replace(SFU, "livekit/livekit-server:latest"), "floating tag"),
            "flux image in the overlay": ("compose.live.turn.yaml", lambda t: t + f"  x:\n    image: {IMAGE}@{APP_DIGEST}\n", "Flux image"),
            "platforms differ": ("release.json", lambda t: t.replace('"runtime_platforms": [\n    "linux/amd64"', '"runtime_platforms": [\n    "linux/arm64"'), "same supported platforms"),
        }
        for label, (name, mutate, message) in cases.items():
            with self.subTest(label):
                with self.assertRaisesRegex(ValueError, message):
                    verify_assets(retouch(name, mutate), None, None, None)
        stale = self.root / "stale"
        shutil.copytree(output, stale)
        (stale / "compose.yaml").write_text("changed\n")
        with self.assertRaisesRegex(ValueError, "does not match SHA256SUMS"):
            verify_assets(stale, None, None, None)
        extra = self.root / "extra"
        shutil.copytree(output, extra)
        (extra / "notes.txt").write_text("stray\n")
        with self.assertRaisesRegex(ValueError, "differ"):
            verify_assets(extra, None, None, None)


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
            runtime_digest=RUNTIME_DIGEST, runtime_compose=REAL_OVERLAY, runtime_script=REAL_SCRIPT,
            runtime_sbom=sbom, dockerfile=DOCKERFILE, live_compose=REAL_LIVE, live_turn_compose=REAL_TURN,
        )

    def test_asset_set_and_checksums(self) -> None:
        names = {path.name for path in self.output.iterdir()}
        self.assertEqual(names, EXPECTED)
        verify_assets(self.output, "v1.2.3-rc.1", "a" * 40, self.digest)
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
        self.assertEqual(packaged.count(f"image: {IMAGE}@{self.digest}\n"), 4)

    def test_runtime_overlay_and_script_ship_unchanged_but_for_digests_and_header(self) -> None:
        def code(text: str) -> list[str]:
            return [line for line in text.splitlines() if not line.lstrip().startswith("#")]

        packaged = (self.output / "compose.runtime.yaml").read_text(encoding="utf-8")
        expected = [
            line.replace(MARKER, f"{IMAGE}@{self.digest}").replace(RUNTIME_MARKER, f"{RUNTIME_IMAGE}@{RUNTIME_DIGEST}")
            for line in code(REAL_OVERLAY.read_text())
        ]
        self.assertEqual(code(packaged), expected)
        self.assertEqual((self.output / "runtime.sh").read_bytes(), REAL_SCRIPT.read_bytes())
        header = packaged.split("\nx-runtime-network-opts", 1)[0]
        self.assertIn("Flux v1.2.3-rc.1 agent runtime Compose overlay", header)
        for stale in ("docs/operations", "./flux", "docker/", "placeholder", "repository"):
            self.assertNotIn(stale, header)

    def test_live_overlays_ship_unchanged_but_for_the_header(self) -> None:
        def body(text: str) -> str:
            lines = text.splitlines(keepends=True)
            return "".join(lines[next(i for i, line in enumerate(lines) if not line.startswith("#")):])

        for name, source in (("compose.live.yaml", REAL_LIVE), ("compose.live.turn.yaml", REAL_TURN)):
            with self.subTest(name):
                packaged = (self.output / name).read_text(encoding="utf-8")
                self.assertEqual(body(packaged), body(source.read_text(encoding="utf-8")))
                header = packaged[: len(packaged) - len(body(packaged))]
                self.assertIn("Flux v1.2.3-rc.1", header)
                for stale in ("compose.source", "docker/", "./flux"):
                    self.assertNotIn(stale, header)
        release = json.loads((self.output / "release.json").read_text())
        self.assertIn(f"image: {release['live_media_image']}\n", REAL_LIVE.read_text())

    def test_codex_pin_is_read_from_the_real_dockerfile(self) -> None:
        self.assertRegex(codex_pin(DOCKERFILE.read_text()), r"^rust-v\d+\.\d+\.\d+$")

    def test_the_base_compose_never_mentions_the_runtime(self) -> None:
        self.assertNotIn("runtime", (self.output / "compose.yaml").read_text().split("\nname:", 1)[1])

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
            self.assertRegex(link, r"^(https://|#)", "INSTALL.md is read without the repository")
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
        # The live-media settings belong to the optional overlays; INSTALL.md lists them for .env.
        live = REAL_LIVE.read_text() + REAL_TURN.read_text()
        live_keys = set(re.findall(r"\$\{(FLUX_LIVEKIT_[A-Z0-9_]+)", live))
        keys |= live_keys
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
