"""One install path (#1471, founder decision 5; F-043): the launcher of a release pulls that release's images.

A release folder is made the way an owner gets it: scripts/release/prepare_assets.py packages this repository into flux.tar.gz, which
is unpacked. The real `./flux` then runs against a stand-in `docker` that records each call, so these checks need no Docker: `up` pulls
the release's images it does not have and never builds, writes no fixture token, and `upgrade` refuses an archive that does not match
SHA256SUMS or whose signature does not verify (with the host's cosign, or else the pinned cosign image through Docker) or cannot be
checked, before it changes anything. Where Docker Compose is installed,
the launcher's own Compose arguments are rendered: every Flux service runs an image of docker/release.env, pinned by digest, and nothing
builds. Standard library only.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "release"))
from prepare_assets import prepare  # noqa: E402

DOCKER = shutil.which("docker")
SBOM = '{"packages":[{"name":"node","versionInfo":"24","licenseDeclared":"MIT"}]}\n'
DIGESTS = {"digest": "sha256:" + "b" * 64, "runtime_digest": "sha256:" + "c" * 64, "database_digest": "sha256:" + "9" * 64}
APP = "ghcr.io/coldphase/flux@" + DIGESTS["digest"]
DATABASE = "ghcr.io/coldphase/flux-database@" + DIGESTS["database_digest"]
RUNTIME = "ghcr.io/coldphase/flux-agent-runtime@" + DIGESTS["runtime_digest"]
# The stand-in docker: records every call; `config --images` names the release images the launcher exported; `image inspect` finds
# only what FLUX_TEST_PRESENT lists.
STUB = r'''#!/bin/sh
printf '%s\n' "$*" >> "$FLUX_TEST_LOG"
case "$*" in
  *"config --images"*) printf '%s\n%s\n' "$FLUX_RELEASE_IMAGE" "$FLUX_RELEASE_DATABASE_IMAGE"
     case "$*" in *"--profile runtime"*) printf '%s\n' "$FLUX_RELEASE_RUNTIME_IMAGE" ;; esac ;;
  *"image inspect ghcr.io/sigstore/cosign/"*) [ "${FLUX_TEST_COSIGN_IMAGE:-present}" = present ]; exit ;;
  "image inspect"*) case " ${FLUX_TEST_PRESENT:-} " in *" $3 "*) exit 0 ;; esac; exit 1 ;;
  *"pull --quiet ghcr.io/sigstore/cosign/"*) [ "${FLUX_TEST_COSIGN_IMAGE:-present}" != unavailable ]; exit ;;
  "run "*"ghcr.io/sigstore/cosign/"*) exit "${FLUX_TEST_COSIGN_STATUS:-0}" ;;
esac
exit 0
'''


def has_compose() -> bool:
    if not DOCKER:
        return False
    try:
        return subprocess.run([DOCKER, "compose", "version"], capture_output=True, timeout=20).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def release(destination: Path, version: str = "v0.2.1", sha: str = "a" * 40, **digests: str) -> Path:
    """Release assets of this repository, as the release workflow makes them."""
    sboms = destination.parent / f"sboms-{destination.name}"
    sboms.mkdir()
    for name in ("app", "runtime", "database"):
        (sboms / name).write_text(SBOM, encoding="utf-8")
    prepare(version=version, source_sha=sha, source=ROOT, destination=destination, sbom=sboms / "app", runtime_sbom=sboms / "runtime",
            database_sbom=sboms / "database", **{**DIGESTS, **digests})
    return destination


class LauncherReleaseTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory(prefix="flux-release-")
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name).resolve()
        self.assets = release(self.base / "assets")
        with tarfile.open(self.assets / "flux.tar.gz") as archive:
            archive.extractall(self.base / "owner", filter="data")
        self.folder = self.base / "owner" / "flux"
        self.env_file = self.folder / "docker" / ".env"
        self.bin = self.base / "bin"
        self.bin.mkdir()
        self.log = self.base / "docker-calls"
        self.stub("docker", STUB)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("FLUX_")}
        self.env.update(PATH=f"{self.bin}:/usr/bin:/bin", FLUX_TEST_LOG=str(self.log))

    def stub(self, name: str, body: str) -> None:
        path = self.bin / name
        path.write_text(body if body.startswith("#!") else "#!/bin/sh\n" + body, encoding="utf-8")
        path.chmod(0o755)

    def flux(self, *args: str, **env: str) -> subprocess.CompletedProcess[str]:
        if self.log.exists():
            self.log.unlink()
        return subprocess.run([str(self.folder / "flux"), *args], cwd=self.base, env={**self.env, **env}, capture_output=True, text=True,
                              timeout=120, stdin=subprocess.DEVNULL)

    def calls(self) -> list[str]:
        return self.log.read_text(encoding="utf-8").splitlines() if self.log.exists() else []

    def write_env(self, extra: str = "") -> None:
        self.env_file.write_text("POSTGRES_PASSWORD=pw\nFLUX_AUTH_SECRET=secret\nFLUX_PROJECT=flux-release-test\n"
                                 "FLUX_PUBLIC_ORIGIN=http://127.0.0.1:8081\n" + extra, encoding="utf-8")
        self.env_file.chmod(0o600)

    # --- up

    def test_up_pulls_the_release_images_it_does_not_have_and_never_builds(self) -> None:
        result = self.flux("up", FLUX_TEST_PRESENT=DATABASE)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        calls = self.calls()
        self.assertIn(f"pull --quiet {APP}", calls)
        self.assertNotIn(f"pull --quiet {DATABASE}", calls, "an image this Docker has is not downloaded again")
        self.assertFalse([c for c in calls if " build" in f" {c}" and "compose" in c], "a release never builds")
        self.assertFalse([c for c in calls if "pull" in c and "agent-runtime" in c], "the runtime image only when the runtime is on")
        compose = [c for c in calls if c.startswith("--log-level error compose ")]
        self.assertTrue(compose)
        for call in compose:
            self.assertIn(f"-f {self.folder}/docker/compose.yaml", call)
            self.assertNotIn("compose.source", call)
        self.assertIn("Downloading Flux v0.2.1", result.stdout)
        env = dict(line.split("=", 1) for line in self.env_file.read_text().splitlines() if "=" in line and not line.startswith("#"))
        self.assertEqual(env["FLUX_FIXTURE_TOKEN"], "", "a release leaves the integration fixtures off")
        self.assertRegex(env["POSTGRES_PASSWORD"], r"^[0-9a-f]{64}$")
        self.assertEqual(oct(self.env_file.stat().st_mode & 0o777), "0o600")

    def test_the_runtime_image_is_pulled_when_the_runtime_is_on(self) -> None:
        self.write_env("FLUX_AGENT_RUNTIME=codex\n")
        self.flux("up", FLUX_TEST_PRESENT=f"{APP} {DATABASE}")
        calls = self.calls()
        self.assertIn(f"pull --quiet {RUNTIME}", calls)
        self.assertFalse([c for c in calls if c.endswith("build runtime-install runtime-1")])
        runtime = [c for c in calls if "--profile runtime" in c and c.startswith("--log-level error compose ")]
        self.assertTrue(runtime and all(f"-f {self.folder}/docker/compose.runtime.yaml" in c for c in runtime))

    def test_with_the_runtime_off_its_own_file_comes_only_with_its_profile(self) -> None:
        """A release defines the runtime's services in compose.runtime.yaml: `down` (profile runtime) must still know them while the
        runtime is off, so it can remove a runtime that was switched off; `logs` must not join the API to the runtime's networks."""
        self.write_env("FLUX_AGENT_RUNTIME=\n")
        self.assertEqual(self.flux("down").returncode, 0)
        down = [c for c in self.calls() if c.startswith("--log-level error compose ") and "--profile runtime" in c]
        self.assertTrue(down and all(f"-f {self.folder}/docker/compose.runtime.yaml" in c for c in down), down)
        self.assertEqual(self.flux("logs").returncode, 0)
        logs = [c for c in self.calls() if c.startswith("--log-level error compose ")]
        self.assertTrue(logs and not [c for c in logs if "compose.runtime.yaml" in c], logs)

    def test_a_damaged_release_file_stops_every_command(self) -> None:
        release_env = self.folder / "docker" / "release.env"
        release_env.write_text(release_env.read_text().replace(APP, "ghcr.io/coldphase/flux:latest"))
        result = self.flux("logs")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("docker/release.env is damaged: FLUX_RELEASE_IMAGE is not an image pinned by digest", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_dev_is_for_a_source_checkout(self) -> None:
        self.write_env()
        result = self.flux("dev")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("needs a source checkout", result.stderr)

    @unittest.skipUnless(has_compose(), "Docker Compose is not installed")
    def test_compose_renders_every_flux_service_on_a_release_image_and_builds_nothing(self) -> None:
        for extra, runtime in (("", False), ("FLUX_AGENT_RUNTIME=codex\nFLUX_PUBLIC_ORIGIN=https://flux.example.org\nFLUX_CALLS=on\n"
                                             "FLUX_LIVEKIT_PUBLIC_IP=203.0.113.9\nFLUX_LIVEKIT_API_KEY=k\nFLUX_LIVEKIT_API_SECRET=s\n"
                                             "FLUX_EMBEDDINGS=on\n", True)):
            with self.subTest(runtime=runtime):
                self.write_env(extra)
                self.assertEqual(self.flux("logs").returncode, 0)
                call = next(c for c in self.calls() if c.startswith("--log-level error compose "))
                args = call.split(" ")
                args = args[:args.index("logs")]
                exported = {"FLUX_RELEASE_IMAGE": APP, "FLUX_RELEASE_DATABASE_IMAGE": DATABASE, "FLUX_RELEASE_RUNTIME_IMAGE": RUNTIME,
                            "FLUX_HTTPS_PORT": "443", "FLUX_HTTPS_HOST": "flux.example.org", "FLUX_LIVEKIT_DOMAIN": "flux.example.org"}
                profiles = ["--profile", "setup", "--profile", "ops"] + (["--profile", "runtime"] if runtime else [])
                rendered = subprocess.run([str(DOCKER), *args, *profiles, "config", "--format", "json"], capture_output=True, text=True,
                                          timeout=60, env={**os.environ, **exported})
                self.assertEqual(rendered.returncode, 0, rendered.stderr)
                services = json.loads(rendered.stdout)["services"]
                self.assertFalse([name for name, service in services.items() if "build" in service], "a release builds nothing")
                expected = {"db": DATABASE, "files-archive": DATABASE, "migrate": APP, "files-init": APP, "api": APP, "worker": APP,
                            "keyring": APP}
                if runtime:
                    expected.update({"runtime-install": RUNTIME, "runtime-1": RUNTIME, "runtime-manager": APP, "runtime-egress": APP})
                for name, image in expected.items():
                    self.assertEqual(services[name]["image"], image, name)
                for name, service in services.items():
                    self.assertRegex(service["image"], r"@sha256:[0-9a-f]{64}$", f"{name} is not pinned by digest")
                if runtime:
                    self.assertTrue({"proxy", "livekit", "embeddings"} <= set(services), "the overlays come along")
                api = services["api"]
                self.assertEqual(api["environment"]["FLUX_FIXTURE_TOKEN"], "")
                self.assertIn("/run/secrets/flux_background_key", [v["target"] for v in api["volumes"]])
                self.assertNotIn("FLUX_TEST_CSP_EVAL", api["environment"], "no test switch in an owner's Flux")

    # --- upgrade

    def new_release(self, version: str = "v0.2.2") -> Path:
        """A newer release with a signature file beside SHA256SUMS (the stand-ins decide whether it verifies)."""
        assets = release(self.base / f"assets-{version}", version=version, sha="e" * 40, digest="sha256:" + "1" * 64,
                         runtime_digest="sha256:" + "2" * 64, database_digest="sha256:" + "3" * 64)
        (assets / "SHA256SUMS.sigstore.json").write_text("{}")
        return assets

    def snapshot(self) -> dict[str, str]:
        return {str(p.relative_to(self.folder)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in sorted(self.folder.rglob("*")) if p.is_file()}

    def test_upgrade_refuses_an_archive_that_does_not_match_sha256sums_and_changes_nothing(self) -> None:
        self.write_env()
        new = self.new_release()
        sums = new / "SHA256SUMS"
        sums.write_text(sums.read_text().replace(hashlib.sha256((new / "flux.tar.gz").read_bytes()).hexdigest(), "0" * 64))
        before = self.snapshot()
        result = self.flux("upgrade", "--file", str(new / "flux.tar.gz"), "-y")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("flux.tar.gz does not match SHA256SUMS", result.stderr)
        self.assertIn("nothing was changed", result.stderr)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse([c for c in self.calls() if " stop " in f" {c} " or "pull" in c], "nothing stopped or pulled")

    def test_upgrade_refuses_without_sha256sums_or_with_one_that_does_not_name_the_archive(self) -> None:
        self.write_env()
        new = self.new_release()
        sums = new / "SHA256SUMS"
        sums.write_text("".join(line + "\n" for line in sums.read_text().splitlines() if not line.endswith("flux.tar.gz")))
        result = self.flux("upgrade", "--file", str(new / "flux.tar.gz"), "-y")
        self.assertIn("SHA256SUMS names no flux.tar.gz", result.stderr)
        sums.unlink()
        result = self.flux("upgrade", "--file", str(new / "flux.tar.gz"), "-y")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SHA256SUMS is not next to", result.stderr)

    def test_the_signature_is_always_required(self) -> None:
        self.write_env()
        new = self.new_release()
        (new / "SHA256SUMS.sigstore.json").unlink()
        before = self.snapshot()
        result = self.flux("upgrade", "--file", str(new / "flux.tar.gz"), "-y")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("the release has no signature", result.stderr)
        self.assertEqual(self.snapshot(), before)

    def test_with_cosign_installed_it_verifies_with_the_pinned_identity(self) -> None:
        self.write_env()
        new = self.new_release()
        self.stub("cosign", 'printf "%s\\n" "$*" > "$FLUX_TEST_LOG.cosign"\nexit 1\n')
        result = self.flux("upgrade", "--file", str(new / "flux.tar.gz"), "-y")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SHA256SUMS does not verify as signed by Flux's release workflow", result.stderr)
        cosign = Path(str(self.log) + ".cosign").read_text()
        self.assertIn("verify-blob --bundle", cosign)
        self.assertIn("--certificate-identity https://github.com/ColdPhase/flux/.github/workflows/final-release.yml@refs/heads/main ", cosign)
        self.assertIn("--certificate-oidc-issuer https://token.actions.githubusercontent.com", cosign)
        self.assertFalse([c for c in self.calls() if "sigstore/cosign" in c], "the host's cosign is used, not the image")
        self.assertFalse((self.folder / ".flux-upgrade").exists())

    def test_without_host_cosign_the_pinned_image_verifies_with_only_the_two_files_read_only(self) -> None:
        self.write_env()
        new = self.new_release()
        self.assertIsNone(shutil.which("cosign", path=self.env["PATH"]), "this test needs a PATH without cosign")
        result = self.flux("upgrade", "--file", str(new / "flux.tar.gz"), "-y", FLUX_TEST_COSIGN_IMAGE="missing", FLUX_TEST_COSIGN_STATUS="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SHA256SUMS does not verify as signed by Flux's release workflow", result.stderr)
        calls = self.calls()
        image = "ghcr.io/sigstore/cosign/cosign:v3.0.6@sha256:de9c65609e6bde17e6b48de485ee788407c9502fa08b8f4459f595b21f56cd00"
        self.assertIn(f"pull --quiet {image}", calls, "a missing image is pulled")
        run = next(c for c in calls if c.startswith("run ") and image in c)
        stage = self.folder / ".flux-upgrade"
        self.assertEqual(run, f"run --rm --read-only --cap-drop ALL --security-opt no-new-privileges --user {os.getuid()}:{os.getgid()} "
                              f"-e HOME=/tmp --tmpfs /tmp -v {stage}/SHA256SUMS:/verify/SHA256SUMS:ro,z "
                              f"-v {stage}/SHA256SUMS.sigstore.json:/verify/SHA256SUMS.sigstore.json:ro,z {image} verify-blob "
                              "--bundle /verify/SHA256SUMS.sigstore.json --certificate-identity "
                              "https://github.com/ColdPhase/flux/.github/workflows/final-release.yml@refs/heads/main "
                              "--certificate-oidc-issuer https://token.actions.githubusercontent.com /verify/SHA256SUMS")
        self.assertNotIn("docker.sock", run)
        # It verifies: the upgrade goes past the check (to the confirmation, which nobody gives here).
        result = self.flux("upgrade", "--file", str(new / "flux.tar.gz"), FLUX_TEST_COSIGN_STATUS="0")
        self.assertIn("Verified the release's signature (the cosign image)", result.stdout)
        self.assertIn("Checked Flux v0.2.2", result.stdout)

    def test_when_the_signature_cannot_be_checked_the_upgrade_is_refused(self) -> None:
        self.write_env()
        new = self.new_release()
        before = self.snapshot()
        result = self.flux("upgrade", "--file", str(new / "flux.tar.gz"), "-y", FLUX_TEST_COSIGN_IMAGE="unavailable")
        self.assertNotEqual(result.returncode, 0)
        message = [line for line in result.stderr.splitlines() if "cannot be checked" in line]
        self.assertEqual(len(message), 1, result.stderr)
        self.assertIn("neither cosign nor the cosign image", message[0])
        self.assertIn("docker pull ghcr.io/sigstore/cosign/cosign:v3.0.6@sha256:", message[0])
        self.assertIn("docker save and docker load", message[0])
        self.assertEqual(self.snapshot(), before)
        self.assertFalse((self.folder / ".flux-upgrade").exists())
        self.assertFalse([c for c in self.calls() if c.startswith("run ")], "nothing ran unverified")

    def test_upgrade_to_the_same_release_changes_nothing(self) -> None:
        self.write_env()
        (self.assets / "SHA256SUMS.sigstore.json").write_text("{}")
        result = self.flux("upgrade", "--file", str(self.assets / "flux.tar.gz"), "-y")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("already runs Flux v0.2.1", result.stdout)
        self.assertFalse((self.folder / ".flux-upgrade").exists())

    def test_upgrade_refuses_an_older_release_even_with_the_same_schema(self) -> None:
        self.write_env()
        old = self.new_release("v0.2.0")
        before = self.snapshot()
        result = self.flux("upgrade", "--file", str(old / "flux.tar.gz"), "-y")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Flux v0.2.0 is older than this folder's Flux v0.2.1", result.stderr)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse((self.folder / ".flux-upgrade").exists())
        self.assertFalse([c for c in self.calls() if "pull" in c], "nothing pulled")

    def test_upgrade_downloads_from_the_release_url_and_a_source_checkout_refuses_a_version(self) -> None:
        self.write_env()
        self.stub("curl", 'for a; do last=$a; done; printf "%s\\n" "$*" >> "$FLUX_TEST_LOG.curl"; exit 22\n')
        result = self.flux("upgrade", "v0.2.2", "-y", FLUX_RELEASE_URL="https://mirror.example.org/flux/releases")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("could not download https://mirror.example.org/flux/releases/download/v0.2.2/flux.tar.gz", result.stderr)
        launcher = (ROOT / "flux").read_text(encoding="utf-8")
        self.assertIn('base="$RELEASE_URL/latest/download"', launcher)
        self.assertIn("RELEASE_URL=${FLUX_RELEASE_URL:-https://github.com/ColdPhase/flux/releases}", launcher)


if __name__ == "__main__":
    unittest.main()
