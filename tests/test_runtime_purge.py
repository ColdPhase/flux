"""Exercise the real purge command with Docker outcomes, without deleting real resources."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

DOCKER_STUB = '''#!/bin/sh
printf '%s\\n' "$*" >> "$FLUX_PURGE_TEST_LOG"
case "$*" in
  'volume inspect -f '*) printf '%s\\n' "$FLUX_PURGE_TEST_CHECKOUT" ;;
  'volume ls '*) [ "$FLUX_PURGE_TEST_SCENARIO" = no-volume ] || printf 'flux-purge-test_runtime-1-data\\n' ;;
  *'runtime-begin-purge')
    [ "$FLUX_PURGE_TEST_SCENARIO" != db-unavailable ] || exit 1
    if [ "$FLUX_PURGE_TEST_SCENARIO" = invalid-fence ]; then printf 'FLUX_RUNTIME_PURGE bad\n'
    else printf 'FLUX_RUNTIME_PURGE 11111111-1111-4111-8111-111111111111\n'; fi ;;
  *'rm -sf '*) [ "$FLUX_PURGE_TEST_SCENARIO" != remove-failed ] ;;
  'volume rm '*) [ "$FLUX_PURGE_TEST_SCENARIO" != volume-failed ] ;;
  'image inspect '*) [ "$FLUX_PURGE_TEST_SCENARIO" != missing-image ] ;;
  *'config --services') printf 'runtime-1\\n' ;;
  *'up -d --no-deps '*) [ "$FLUX_PURGE_TEST_SCENARIO" != start-failed ] ;;
  *'cli.js sign-out-all')
    [ "$FLUX_PURGE_TEST_SCENARIO" != failed ] || exit 1
    if [ "$FLUX_PURGE_TEST_SCENARIO" = retry ] && [ ! -f "$FLUX_PURGE_TEST_ATTEMPT" ]; then
      touch "$FLUX_PURGE_TEST_ATTEMPT"
      exit 1
    fi
    ;;
esac
'''


def make_checkout(checkout: Path) -> None:
    (checkout / "docker").mkdir(parents=True)
    shutil.copy2(ROOT / "flux", checkout / "flux")
    config = checkout / "docker/.env"
    config.write_text("FLUX_PROJECT=flux-purge-test\nFLUX_AGENT_RUNTIME=\nFLUX_RUNTIME_MANAGER_SECRET=test-secret\nFLUX_RUNTIME_SECRET_1=test-secret\n")
    config.chmod(0o600)


def run_purge(base: Path, checkout: Path, owner: str, scenario: str = "ok") -> tuple[subprocess.CompletedProcess, Path]:
    """Run `flux runtime purge -y` from checkout with a stub Docker that reports owner as the project owner."""
    binary = base / "bin"
    binary.mkdir(exist_ok=True)
    docker = binary / "docker"
    docker.write_text(DOCKER_STUB)
    docker.chmod(0o700)
    sleep = binary / "sleep"
    sleep.write_text("#!/bin/sh\nexit 0\n")
    sleep.chmod(0o700)
    log = base / "calls"
    env = {key: value for key, value in os.environ.items() if not key.startswith("FLUX_")}
    env.update(PATH=f"{binary}:{os.environ['PATH']}", FLUX_PURGE_TEST_SCENARIO=scenario,
               FLUX_PURGE_TEST_CHECKOUT=owner, FLUX_PURGE_TEST_LOG=str(log),
               FLUX_PURGE_TEST_ATTEMPT=str(base / "attempt"))
    result = subprocess.run([str(checkout / "flux"), "runtime", "purge", "-y"],
                            env=env, capture_output=True, text=True, timeout=10)
    return result, log


class RuntimePurgeTest(unittest.TestCase):
    def test_cleanup_outcome_reaches_persisted_history(self) -> None:
        for scenario in ("ok", "retry", "failed", "missing-image", "start-failed", "no-volume", "db-unavailable", "invalid-fence", "remove-failed", "volume-failed"):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory(prefix="flux-purge-test-") as directory:
                # The launcher records its checkout as `pwd -P`, so the fixture records the same
                # canonical path (TMPDIR is /var/folders/... -> /private/var/folders/... on macOS).
                base = Path(directory).resolve()
                checkout = base / "checkout"
                make_checkout(checkout)
                result, log = run_purge(base, checkout, str(checkout), scenario)
                calls = log.read_text().splitlines()
                stopped = next(i for i, call in enumerate(calls) if 'stop api worker' in call)
                fenced = next(i for i, call in enumerate(calls) if 'runtime-begin-purge' in call)
                self.assertLess(stopped, fenced, 'services stop before even a failed DB fence')
                if scenario in ('db-unavailable', 'invalid-fence', 'remove-failed', 'volume-failed'):
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(any('runtime-forget' in call for call in calls), 'failure must leave admission blocked')
                    if scenario in ('db-unavailable', 'invalid-fence'):
                        self.assertFalse(any('cli.js sign-out-all' in call or 'volume rm ' in call for call in calls))
                    continue
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                outcome = "confirmed" if scenario == "ok" else "unconfirmed"
                calls = log.read_text().splitlines()
                persisted = [call for call in calls if "runtime-forget" in call]
                self.assertEqual(len(persisted), 1)
                self.assertTrue(persisted[0].endswith(f"runtime-forget 11111111-1111-4111-8111-111111111111 {outcome}"), persisted)
                self.assertTrue(all(fenced < i for i, call in enumerate(calls) if 'cli.js sign-out-all' in call or 'volume rm ' in call))
                if scenario == "retry":
                    self.assertEqual(sum("cli.js sign-out-all" in call for call in calls), 2)

    def test_owner_recorded_through_symlink_is_the_same_checkout(self) -> None:
        with tempfile.TemporaryDirectory(prefix="flux-purge-test-") as directory:
            base = Path(directory).resolve()
            real = base / "real"
            checkout = real / "checkout"
            make_checkout(checkout)
            link = base / "link"
            os.symlink(real, link)
            # Run through the real path; the owner label names the same checkout via the symlink.
            result, log = run_purge(base, checkout, str(link / "checkout"))
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue(any(call.endswith("runtime-forget confirmed") for call in log.read_text().splitlines()))

    def test_purge_refuses_project_of_another_checkout(self) -> None:
        with tempfile.TemporaryDirectory(prefix="flux-purge-test-") as directory:
            base = Path(directory).resolve()
            checkout = base / "checkout"
            make_checkout(checkout)
            other = base / "other"
            make_checkout(other)
            link = base / "link-to-other"
            os.symlink(other, link)
            for owner in (other, link, base / "deleted-checkout"):
                with self.subTest(owner=owner.name):
                    result, log = run_purge(base, checkout, str(owner))
                    self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertIn("belongs to another checkout", result.stderr)
                    calls = log.read_text().splitlines() if log.exists() else []
                    self.assertFalse(any("runtime-forget" in call or "volume rm" in call for call in calls), calls)


if __name__ == "__main__":
    unittest.main()
