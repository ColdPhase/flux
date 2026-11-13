"""Checks `docker inspect` of a running agent runtime (F-022 T3 #278) against the decided limits.

Usage: docker inspect <every container of the project> | python3 inspect.py <compose project> [<checkout directory>]
The runtime (runtime-<n>): root inside the container with exactly the six capabilities that give each person their own
user id (#860), read-only root, cap_drop ALL, no-new-privileges, not privileged, an init, a memory limit without
swap, a CPU limit, 2048 pids, a 256 MiB tmpfs /tmp, a 1 GiB tmpfs /scratch (#1437), rotated json-file logs (3 x 10 MB), restart
unless-stopped, a health check, only its own data volume and the read-only tools volume, and only its own
network. runtime-manager and runtime-egress: user 1000:1000, read-only, cap_drop ALL, no capabilities,
no-new-privileges, no mounts. No container of the project mounts a container engine socket, directly
or through a directory that holds one (/var/run, /run): a bind mount must come from inside the
checkout directory given as the optional second argument, anything else is refused.
"""

from __future__ import annotations

import json
import os
import re
import sys

project = sys.argv[1]
checkout = os.path.realpath(sys.argv[2]) if len(sys.argv) > 2 else None
containers = json.load(sys.stdin)
PERSON_CAPABILITIES = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "SETGID", "SETUID"]
failures: list[str] = []
checked: list[str] = []


def expect(name: str, what: str, actual: object, wanted: object) -> None:
    if actual != wanted:
        failures.append(f"{name}: {what} is {actual!r}, expected {wanted!r}")


for container in containers:
    labels = container["Config"]["Labels"] or {}
    service = labels.get("com.docker.compose.service", "?")
    host = container["HostConfig"]
    for mount in container.get("Mounts", []):
        text = f"{mount.get('Source', '')} {mount.get('Destination', '')} {mount.get('Name', '')}"
        if re.search(r"(docker|podman|containerd)\.sock|/var/run/docker|/run/podman", text):
            failures.append(f"{service}: mounts a container engine socket ({text.strip()})")
    for mount in container.get("Mounts", []):
        if mount.get("Type") != "bind":
            continue
        source = os.path.realpath(mount.get("Source", ""))
        if checkout is None or not (source == checkout or source.startswith(checkout + os.sep)):
            failures.append(f"{service}: bind mount from {mount.get('Source', '')!r} is outside the checkout (allowlist)")
    if service.startswith("runtime-"):
        expect(service, "privileged", host["Privileged"], False)
        expect(service, "read-only root", host["ReadonlyRootfs"], True)
        expect(service, "cap_drop", host["CapDrop"], ["ALL"])
        expect(service, "no-new-privileges", "no-new-privileges:true" in (host.get("SecurityOpt") or []), True)
        expect(service, "devices", host.get("Devices") or [], [])
        expect(service, "pid mode", host.get("PidMode") or "", "")
    if re.fullmatch(r"runtime-[1-9][0-9]*", service):
        checked.append(service)
        expect(service, "user", container["Config"]["User"], "0:0")
        expect(service, "cap_add", sorted(name.removeprefix("CAP_") for name in host.get("CapAdd") or []), PERSON_CAPABILITIES)
        expect(service, "a memory limit", host["Memory"] > 0, True)
        expect(service, "memory+swap", host["MemorySwap"], host["Memory"])
        expect(service, "a CPU limit", host["NanoCpus"] > 0, True)
        expect(service, "pids", host["PidsLimit"], 2048)
        expect(service, "tmpfs", host.get("Tmpfs"), {"/tmp": "rw,nosuid,nodev,size=256m,mode=1777", "/dev/shm": "ro,nosuid,nodev,noexec,size=4k", "/scratch": "rw,nosuid,nodev,size=1g,mode=0711"})
        expect(service, "health check", bool((container["Config"].get("Healthcheck") or {}).get("Test")), True)
        expect(service, "log driver", host["LogConfig"]["Type"], "json-file")
        expect(service, "log rotation", host["LogConfig"]["Config"], {"max-file": "3", "max-size": "10m"})
        expect(service, "restart", host["RestartPolicy"]["Name"], "unless-stopped")
        expect(service, "init", host.get("Init"), True)
        mounts = sorted((m["Type"], m.get("Name", ""), m["Destination"], m["RW"]) for m in container["Mounts"])
        expect(service, "mounts", mounts, sorted([("volume", f"{project}_{service}-data", "/data", True),
                                                  ("volume", f"{project}_runtime-tools", "/opt/flux-tools", False)]))
        expect(service, "networks", sorted(container["NetworkSettings"]["Networks"]), [f"{project}_{service}"])
    elif service in ("runtime-manager", "runtime-egress"):
        checked.append(service)
        expect(service, "user", container["Config"]["User"], "1000:1000")
        expect(service, "cap_add", host.get("CapAdd") or [], [])
        expect(service, "mounts", container["Mounts"], [])
        expect(service, "networks hold no database network", f"{project}_default" in container["NetworkSettings"]["Networks"], False)

print(json.dumps({"checked": sorted(checked), "failures": failures}, indent=1))
sys.exit(1 if failures or not any(name.startswith("runtime-1") for name in checked) else 0)
