"""A release is the owner's install folder, flux.tar.gz, bound to one set of image digests (#1471, founder decision 5; F-043).

prepare_assets.py packages the repository's real files; verify_assets.py must accept exactly that and refuse each tampering.
Standard library only.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import shutil
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "release"))
from prepare_assets import BUNDLE_FILES, RELEASE_ENV, codex_pin, parse_platforms, prepare  # noqa: E402
from verify_assets import EXPECTED, SIGNATURE, verify as verify_assets  # noqa: E402

APP = "sha256:" + "b" * 64
RUNTIME = "sha256:" + "c" * 64
DATABASE = "sha256:" + "9" * 64
SHA = "a" * 40
VERSION = "v0.2.1"
SBOM = '{"packages":[{"name":"node","versionInfo":"24","licenseDeclared":"MIT"}]}\n'


def schema() -> int:
    return max(int(p.name[:4]) for p in (ROOT / "app" / "packages" / "db" / "migrations").glob("[0-9][0-9][0-9][0-9]_*.sql"))


class ReleaseAssetsTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        for name in ("sbom.json", "runtime-sbom.json", "database-sbom.json"):
            (self.root / name).write_text(SBOM, encoding="utf-8")

    def prepare(self, destination: str = "assets", source: Path = ROOT, **overrides: object) -> Path:
        out = self.root / destination
        arguments = dict(version=VERSION, source_sha=SHA, digest=APP, runtime_digest=RUNTIME, database_digest=DATABASE, source=source,
                         destination=out, sbom=self.root / "sbom.json", runtime_sbom=self.root / "runtime-sbom.json",
                         database_sbom=self.root / "database-sbom.json", mtime=1_700_000_000)
        arguments.update(overrides)
        prepare(**arguments)  # type: ignore[arg-type]
        return out

    def members(self, assets: Path) -> dict[str, tarfile.TarInfo]:
        with tarfile.open(assets / "flux.tar.gz") as archive:
            return {member.name: member for member in archive.getmembers()}

    def read(self, assets: Path, name: str) -> str:
        with tarfile.open(assets / "flux.tar.gz") as archive:
            data = archive.extractfile(f"flux/{name}")
            assert data is not None
            return data.read().decode()

    def copy_source(self) -> Path:
        """The files prepare_assets.py reads, copied, so a test can change one."""
        source = self.root / "source"
        for name in [*BUNDLE_FILES, "docker/Dockerfile"]:
            (source / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, source / name)
        shutil.copytree(ROOT / "app" / "packages" / "db" / "migrations", source / "app" / "packages" / "db" / "migrations")
        return source

    def repack(self, assets: Path, name: str, text: str) -> None:
        """Replaces one file of the install folder and fixes SHA256SUMS and release.json, as an attacker with the files would."""
        source = assets / "flux.tar.gz"
        buffer = io.BytesIO()
        with tarfile.open(source) as old, tarfile.open(fileobj=buffer, mode="w:gz") as new:
            for member in old.getmembers():
                data = old.extractfile(member) if member.isfile() else None
                if member.name == f"flux/{name}":
                    payload = text.encode()
                    member.size = len(payload)
                    new.addfile(member, io.BytesIO(payload))
                else:
                    new.addfile(member, data)
        source.write_bytes(buffer.getvalue())
        release = json.loads((assets / "release.json").read_text())
        release["bundle_sha256"] = hashlib.sha256(source.read_bytes()).hexdigest()
        (assets / "release.json").write_text(json.dumps(release, indent=2) + "\n")
        self.resum(assets)

    def resum(self, assets: Path) -> None:
        lines = [f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n" for p in sorted(assets.iterdir())
                 if p.name not in ("SHA256SUMS", SIGNATURE)]
        (assets / "SHA256SUMS").write_text("".join(lines))

    # --- What a release is

    def test_the_assets_are_the_install_folder_and_its_evidence_and_verify(self) -> None:
        assets = self.prepare()
        self.assertEqual({p.name for p in assets.iterdir()}, EXPECTED)
        result = verify_assets(assets, VERSION, SHA, APP, "linux/amd64")
        self.assertEqual(result["app"], f"ghcr.io/coldphase/flux@{APP}")
        release = json.loads((assets / "release.json").read_text())
        self.assertEqual((release["version"], release["source_sha"], release["schema"]), (VERSION, SHA, schema()))
        self.assertEqual(release["runtime_codex"], codex_pin((ROOT / "docker" / "Dockerfile").read_text()))

    def test_the_folder_holds_the_launcher_and_the_release_compose_files_only(self) -> None:
        members = self.members(self.prepare())
        files = {name.removeprefix("flux/") for name, member in members.items() if member.isfile()}
        self.assertEqual(files, set(BUNDLE_FILES.values()) | {RELEASE_ENV})
        self.assertNotIn("docker/compose.source.yaml", files, "an owner never builds")
        self.assertNotIn("docker/Dockerfile", files)
        self.assertEqual(members["flux/flux"].mode, 0o755)
        self.assertEqual(members["flux/docker/compose.yaml"].mode, 0o644)
        self.assertTrue(all(m.uid == 0 and m.gid == 0 and m.mtime == 1_700_000_000 for m in members.values()))

    def test_release_env_names_the_version_commit_schema_and_three_images_by_digest(self) -> None:
        text = self.read(self.prepare(), RELEASE_ENV)
        values = dict(line.split("=", 1) for line in text.splitlines() if line and not line.startswith("#"))
        self.assertEqual(values, {
            "FLUX_RELEASE_VERSION": VERSION, "FLUX_RELEASE_COMMIT": SHA, "FLUX_RELEASE_SCHEMA": str(schema()),
            "FLUX_RELEASE_IMAGE": f"ghcr.io/coldphase/flux@{APP}", "FLUX_RELEASE_DATABASE_IMAGE": f"ghcr.io/coldphase/flux-database@{DATABASE}",
            "FLUX_RELEASE_RUNTIME_IMAGE": f"ghcr.io/coldphase/flux-agent-runtime@{RUNTIME}",
        })

    def test_the_files_ship_byte_for_byte(self) -> None:
        assets = self.prepare()
        for name, target in BUNDLE_FILES.items():
            with self.subTest(name=name):
                self.assertEqual(self.read(assets, target), (ROOT / name).read_text(encoding="utf-8"))

    def test_the_archive_is_reproducible(self) -> None:
        first = (self.prepare("one") / "flux.tar.gz").read_bytes()
        second = (self.prepare("two") / "flux.tar.gz").read_bytes()
        self.assertEqual(first, second)

    def test_a_local_registry_for_tests(self) -> None:
        assets = self.prepare(registry="127.0.0.1:25000/coldphase")
        self.assertIn("FLUX_RELEASE_IMAGE=127.0.0.1:25000/coldphase/flux@", self.read(assets, RELEASE_ENV))
        verify_assets(assets, VERSION, SHA, APP, registry="127.0.0.1:25000/coldphase")
        with self.assertRaisesRegex(ValueError, "not a digest of ghcr.io/coldphase/flux"):
            verify_assets(assets, None, None, None)

    def test_platforms_default_to_amd64_and_arm64_can_be_named(self) -> None:
        self.assertEqual(parse_platforms("linux/arm64,linux/amd64"), ["linux/amd64", "linux/arm64"])
        with self.assertRaises(ValueError):
            parse_platforms("linux/riscv64")
        release = json.loads((self.prepare(platforms="linux/amd64,linux/arm64") / "release.json").read_text())
        self.assertEqual(release["platforms"], ["linux/amd64", "linux/arm64"])

    # --- What it refuses

    def test_refuses_an_invalid_identity_shared_digests_and_a_stale_destination(self) -> None:
        for overrides, message in (({"version": "0.2.1"}, "version"), ({"source_sha": "abc"}, "source SHA"),
                                   ({"digest": "sha256:short"}, "digest"), ({"runtime_digest": APP}, "different digests"),
                                   ({"database_digest": RUNTIME}, "different digests"), ({"registry": "Bad Registry"}, "registry")):
            with self.subTest(overrides=overrides), self.assertRaisesRegex(ValueError, message):
                self.prepare("refused", **overrides)
        stale = self.root / "stale"
        stale.mkdir()
        (stale / "old").write_text("x")
        with self.assertRaisesRegex(ValueError, "empty"):
            self.prepare("stale")

    def test_refuses_a_compose_file_that_builds_or_names_an_image_itself(self) -> None:
        for name, old, new, message in (
            ("docker/compose.yaml", "  api:\n", "  api:\n    build: ../app\n", "pull-only"),
            ("docker/compose.yaml", "  worker:\n    image: ${FLUX_RELEASE_IMAGE:?run Flux with ./flux, which names the images}",
             "  worker:\n    image: ghcr.io/coldphase/flux:latest", "compose.yaml must run"),
            ("docker/compose.runtime.yaml", "  runtime-manager:\n", "  runtime-manager:\n    build: ../app\n", "pull-only"),
            ("docker/compose.live.yaml", "@sha256:", ":", "pin"),
            ("docker/.env.example", "\nFLUX_PORT=", "\nFLUX_RELEASE_IMAGE=evil\nFLUX_PORT=", "must not name an image"),
        ):
            with self.subTest(name=name, new=new):
                source = self.copy_source()
                path = source / name
                text = path.read_text(encoding="utf-8")
                self.assertIn(old, text)
                path.write_text(text.replace(old, new, 1), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, message):
                    self.prepare("refused", source=source)
                shutil.rmtree(source)
                shutil.rmtree(self.root / "refused", ignore_errors=True)

    def test_verify_refuses_each_tampering(self) -> None:
        cases = {
            "a changed archive": lambda a: (a / "flux.tar.gz").write_bytes((a / "flux.tar.gz").read_bytes() + b"x"),
            "an unlisted asset": lambda a: (a / "INSTALL.md").write_text("x"),
            "another image in release.env": lambda a: self.repack(a, RELEASE_ENV, self.read(a, RELEASE_ENV).replace("b" * 64, "d" * 64)),
            "a compose file that builds": lambda a: self.repack(a, "docker/compose.yaml", "services:\n  api:\n    build: .\n"),
            "a fixture token": lambda a: self.repack(a, "docker/.env.example", "FLUX_FIXTURE_TOKEN=open\n"),
        }
        for label, tamper in cases.items():
            with self.subTest(label):
                assets = self.prepare(re.sub(r"\W", "-", label))
                tamper(assets)
                with self.assertRaises(ValueError):
                    verify_assets(assets, VERSION, SHA, APP)

    def test_the_signature_of_sha256sums_may_sit_beside_the_assets(self) -> None:
        assets = self.prepare()
        (assets / SIGNATURE).write_text("{}")
        verify_assets(assets, VERSION, SHA, APP)

    def test_the_launcher_names_the_same_release_file_and_image_variables(self) -> None:
        launcher = (ROOT / "flux").read_text(encoding="utf-8")
        self.assertIn('RELEASE_FILE="$FLUX_ROOT/docker/release.env"', launcher)
        self.assertIn("RELEASE_IMAGE_KEYS='FLUX_RELEASE_IMAGE FLUX_RELEASE_DATABASE_IMAGE FLUX_RELEASE_RUNTIME_IMAGE'", launcher)
        for name in ("docker/compose.yaml", "docker/compose.https.yaml", "docker/compose.live.yaml", "docker/compose.embeddings.yaml",
                     "docker/compose.runtime.yaml", "scripts/flux-demo.mjs", "docker/env-changes.txt", "docker/.env.example"):
            self.assertIn(name.split("/")[-1], launcher, f"the launcher no longer uses {name}: drop it from the bundle")


if __name__ == "__main__":
    unittest.main()
