"""scripts/agent-runtime/inspect.py refuses bind mounts that leave the checkout (F-022 T3 #331 m3)."""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "agent-runtime" / "inspect.py"


def failures(mounts: list[dict], checkout: str = "/work/flux") -> list[str]:
    container = {"Config": {"Labels": {"com.docker.compose.service": "api"}, "User": ""}, "HostConfig": {}, "Mounts": mounts,
                 "NetworkSettings": {"Networks": {}}}
    run = subprocess.run([sys.executable, str(SCRIPT), "p", checkout], input=json.dumps([container]), capture_output=True, text=True, check=False)
    return json.loads(run.stdout)["failures"]


def bind(source: str) -> dict:
    return {"Type": "bind", "Source": source, "Destination": "/x", "RW": False}


class RuntimeInspectBindMountTest(unittest.TestCase):
    def test_directory_bind_mounts_outside_the_checkout_are_refused(self) -> None:
        for source in ("/var/run", "/run", "/", "/work/flux-other", "/work/flux/../../var/run"):
            self.assertTrue(any("outside the checkout" in text for text in failures([bind(source)])), source)

    def test_binds_inside_the_checkout_and_volumes_pass(self) -> None:
        self.assertEqual(failures([bind("/work/flux/docker/background-key-unavailable"),
                                   {"Type": "volume", "Name": "p_files", "Destination": "/data/files", "RW": True}]), [])


if __name__ == "__main__":
    unittest.main()
