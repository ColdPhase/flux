"""scripts/agent-runtime/inspect.py refuses bind mounts that leave the checkout (F-022 T3 #331 m3)."""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "agent-runtime" / "inspect.py"


def failures(mounts: list[dict], checkout: str = "/work/flux", service: str = "api", *key: str) -> list[str]:
    container = {"Config": {"Labels": {"com.docker.compose.service": service}, "User": ""}, "HostConfig": {}, "Mounts": mounts,
                 "NetworkSettings": {"Networks": {}}}
    run = subprocess.run([sys.executable, str(SCRIPT), "p", checkout, *key], input=json.dumps([container]), capture_output=True, text=True, check=False)
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


KEY = "/home/u/.local/state/flux/p/background.key"
KEY_MOUNT = "/run/secrets/flux_background_key"


class RuntimeInspectBackgroundKeyTest(unittest.TestCase):
    """The one bind mount outside the checkout that ./flux up makes (#1451): the key file, read-only, in the api and the worker."""

    def test_the_named_key_file_is_allowed_read_only_in_the_api_and_the_worker(self) -> None:
        for service in ("api", "worker"):
            self.assertEqual(failures([{"Type": "bind", "Source": KEY, "Destination": KEY_MOUNT, "RW": False}], "/work/flux", service, KEY), [], service)

    def test_nothing_else_is_allowed_by_it(self) -> None:
        mount = {"Type": "bind", "Source": KEY, "Destination": KEY_MOUNT, "RW": False}
        self.assertTrue(failures([mount], "/work/flux", "api"), "without the argument")
        self.assertTrue(failures([mount], "/work/flux", "keyring", KEY), "in another service")
        self.assertTrue(failures([{**mount, "RW": True}], "/work/flux", "api", KEY), "writable")
        self.assertTrue(failures([{**mount, "Destination": "/x"}], "/work/flux", "api", KEY), "elsewhere in the container")
        self.assertTrue(failures([{**mount, "Source": "/var/run"}], "/work/flux", "api", KEY), "another host path")
        self.assertTrue(failures([{**mount, "Source": "/var/run", "Destination": "/var/run"}], "/work/flux", "api", KEY), "the engine's directory")


if __name__ == "__main__":
    unittest.main()
