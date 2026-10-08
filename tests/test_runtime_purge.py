"""Exercise the real purge command with Docker outcomes, without deleting real resources."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class RuntimePurgeTest(unittest.TestCase):
    def test_cleanup_outcome_reaches_persisted_history(self) -> None:
        for scenario in ("ok", "retry", "failed", "missing-image", "start-failed", "no-volume"):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory(prefix="flux-purge-test-") as directory:
                base = Path(directory).resolve()
                checkout = base / "checkout"
                (checkout / "docker").mkdir(parents=True)
                shutil.copy2(ROOT / "flux", checkout / "flux")
                config = checkout / "docker/.env"
                config.write_text("FLUX_PROJECT=flux-purge-test\nFLUX_AGENT_RUNTIME=\nFLUX_RUNTIME_MANAGER_SECRET=test-secret\nFLUX_RUNTIME_SECRET_1=test-secret\n")
                config.chmod(0o600)
                binary = base / "bin"
                binary.mkdir()
                docker = binary / "docker"
                docker.write_text('''#!/bin/sh
printf '%s\\n' "$*" >> "$FLUX_PURGE_TEST_LOG"
case "$*" in
  'volume inspect -f '*) printf '%s\\n' "$FLUX_PURGE_TEST_CHECKOUT" ;;
  'volume ls '*) [ "$FLUX_PURGE_TEST_SCENARIO" = no-volume ] || printf 'flux-purge-test_runtime-1-data\\n' ;;
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
''')
                docker.chmod(0o700)
                sleep = binary / "sleep"
                sleep.write_text("#!/bin/sh\nexit 0\n")
                sleep.chmod(0o700)
                log = base / "calls"
                env = {key: value for key, value in os.environ.items() if not key.startswith("FLUX_")}
                env.update(PATH=f"{binary}:{os.environ['PATH']}", FLUX_PURGE_TEST_SCENARIO=scenario,
                           FLUX_PURGE_TEST_CHECKOUT=str(checkout), FLUX_PURGE_TEST_LOG=str(log),
                           FLUX_PURGE_TEST_ATTEMPT=str(base / "attempt"))
                result = subprocess.run([str(checkout / "flux"), "runtime", "purge", "-y"],
                                        env=env, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                outcome = "confirmed" if scenario == "ok" else "unconfirmed"
                calls = log.read_text().splitlines()
                persisted = [call for call in calls if "runtime-forget" in call]
                self.assertEqual(len(persisted), 1)
                self.assertTrue(persisted[0].endswith(f"runtime-forget {outcome}"), persisted)
                if scenario == "retry":
                    self.assertEqual(sum("cli.js sign-out-all" in call for call in calls), 2)


if __name__ == "__main__":
    unittest.main()
