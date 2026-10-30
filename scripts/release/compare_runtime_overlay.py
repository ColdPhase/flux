#!/usr/bin/env python3
"""Fail when the release runtime overlay differs from the source Compose in anything but its images.

Input: two `docker compose ... config --format json` documents, the source stack
(docker/compose.source.yaml + compose.source.runtime.yaml, profile runtime) and the release stack (compose.yaml + compose.runtime.yaml,
profile runtime). Every runtime service, network and volume must carry the same isolation, limits,
users, networks, volumes and environment keys; only the image (and the source's build) may differ.
"""

from __future__ import annotations

import json
import sys

RUNTIME = ("runtime-install", "runtime-manager", "runtime-egress", "runtime-1", "runtime-2", "runtime-3", "runtime-4")


def normalized(service: dict) -> dict:
    service = json.loads(json.dumps(service))
    for key in ("build", "image", "pull_policy", "command", "entrypoint"):
        service.pop(key, None)
    return service


def compare(source: dict, release: dict) -> list[str]:
    problems: list[str] = []
    for name in RUNTIME:
        if name not in source["services"] or name not in release["services"]:
            problems.append(f"{name}: missing")
            continue
        a, b = normalized(source["services"][name]), normalized(release["services"][name])
        if a != b:
            for key in sorted(set(a) | set(b)):
                if a.get(key) != b.get(key):
                    problems.append(f"{name}.{key}: source {a.get(key)!r} != release {b.get(key)!r}")
        # The command decides what runs: slots keep the image default, the others are explicit.
        ca, cb = source["services"][name].get("command"), release["services"][name].get("command")
        if name.startswith("runtime-") and name[8:].isdigit():
            if cb not in (None, ["node", "--disable-sigusr1", "apps/runtime/dist/supervisor/main.js"]):
                problems.append(f"{name}.command: {cb!r}")
        elif ca != cb:
            problems.append(f"{name}.command: source {ca!r} != release {cb!r}")
    for name in ("api", "worker"):
        for key in ("FLUX_AGENT_RUNTIME", "FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS", "FLUX_AGENT_RUNTIME_IDLE_DAYS", "FLUX_RUNTIME_MANAGER_SECRET"):
            if key not in release["services"][name].get("environment", {}):
                problems.append(f"{name}: release lacks {key}")
        if sorted(release["services"][name].get("networks", {})) != sorted(source["services"][name].get("networks", {})):
            problems.append(f"{name}.networks differ")
    for section in ("networks", "volumes"):
        for name in [n for n in source.get(section, {}) if n.startswith("runtime-")]:
            sa = json.loads(json.dumps(source[section][name])).copy()
            sb = json.loads(json.dumps(release.get(section, {}).get(name, "MISSING")))
            for item in (sa, sb):
                if isinstance(item, dict):
                    item.pop("name", None)
            if sa != sb:
                problems.append(f"{section}.{name}: source {sa!r} != release {sb!r}")
    for name, service in release["services"].items():
        if "build" in service:
            problems.append(f"{name}: release builds from source")
        for volume in service.get("volumes", []):
            if volume.get("type") == "bind":
                problems.append(f"{name}: bind mount {volume.get('source')}")
    return problems


def main() -> None:
    source = json.load(open(sys.argv[1], encoding="utf-8"))
    release = json.load(open(sys.argv[2], encoding="utf-8"))
    problems = compare(source, release)
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        raise SystemExit(1)
    print(f"runtime overlay matches the source stack for {', '.join(RUNTIME)}")


if __name__ == "__main__":
    main()
