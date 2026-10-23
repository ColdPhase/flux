"""scripts/release/compare_runtime_overlay.py: the release overlay may differ from the source stack only in images."""

from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "release"))
from compare_runtime_overlay import RUNTIME, compare  # noqa: E402


def stack(image_prefix: str) -> dict:
    services = {
        name: {
            "image": f"{image_prefix}-{name}",
            "user": "1000:1000", "read_only": True, "cap_drop": ["ALL"], "mem_limit": "2g",
            "networks": {name: None}, "environment": {"FLUX_AGENT_RUNTIME": ""},
            "command": ["node", "x.js"] if not name[8:].isdigit() else None,
        }
        for name in RUNTIME
    }
    for name in services:
        if services[name]["command"] is None:
            del services[name]["command"]
    for name in ("api", "worker"):
        services[name] = {"image": "app", "networks": {"default": None, "runtime-control": None},
                          "environment": {k: "" for k in (
                              "FLUX_AGENT_RUNTIME", "FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS",
                              "FLUX_AGENT_RUNTIME_IDLE_DAYS", "FLUX_RUNTIME_MANAGER_SECRET")}}
    return {
        "services": services,
        "networks": {"runtime-1": {"internal": True, "name": "p_runtime-1"}},
        "volumes": {"runtime-1-data": {"name": "p_runtime-1-data"}},
    }


class OverlayCompareTest(unittest.TestCase):
    def test_images_and_project_names_may_differ(self) -> None:
        source, release = stack("flux-agent-runtime:tag"), stack("ghcr.io/x@sha256:1")
        release["networks"]["runtime-1"]["name"] = "other_runtime-1"
        self.assertEqual(compare(source, release), [])

    def test_every_isolation_difference_is_reported(self) -> None:
        mutations = {
            "limit": lambda r: r["services"]["runtime-2"].update(mem_limit="8g"),
            "extra capability": lambda r: r["services"]["runtime-3"].update(cap_add=["NET_ADMIN"]),
            "network": lambda r: r["services"]["runtime-1"].update(networks={"default": None}),
            "writable root": lambda r: r["services"]["runtime-4"].update(read_only=False),
            "command": lambda r: r["services"]["runtime-manager"].update(command=["sh"]),
            "source build": lambda r: r["services"]["runtime-egress"].update(build={"context": "."}),
            "bind mount": lambda r: r["services"]["runtime-1"].update(volumes=[{"type": "bind", "source": "/run"}]),
            "network no longer internal": lambda r: r["networks"]["runtime-1"].update(internal=False),
            "missing switch": lambda r: r["services"]["api"]["environment"].pop("FLUX_AGENT_RUNTIME"),
            "missing service": lambda r: r["services"].pop("runtime-install"),
        }
        for label, mutate in mutations.items():
            with self.subTest(label):
                release = copy.deepcopy(stack("ghcr.io/x@sha256:1"))
                mutate(release)
                self.assertNotEqual(compare(stack("flux-agent-runtime:tag"), release), [], label)


if __name__ == "__main__":
    unittest.main()
