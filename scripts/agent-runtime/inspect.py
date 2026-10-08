"""Checks `docker inspect` of a running agent runtime (F-022 T3 #278) against the decided limits.

Usage: docker inspect <every container of the project> | python3 inspect.py <compose project>
Each slot (runtime-<n>): user 1000:1000, read-only root, cap_drop ALL, no-new-privileges, not
privileged, an init, 2 GiB memory without swap, one CPU, 256 pids, a 128 MiB tmpfs /tmp, rotated
json-file logs (3 x 10 MB), restart always, only its own data volume and the read-only tools volume,
and only its own network. runtime-manager and runtime-egress: read-only, cap_drop ALL,
no-new-privileges, no mounts. No container of the project mounts a container engine socket.
"""

from __future__ import annotations

import json
import re
import sys

project = sys.argv[1]
containers = json.load(sys.stdin)
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
    if service.startswith("runtime-"):
        expect(service, "privileged", host["Privileged"], False)
        expect(service, "read-only root", host["ReadonlyRootfs"], True)
        expect(service, "cap_drop", host["CapDrop"], ["ALL"])
        expect(service, "cap_add", host.get("CapAdd") or [], [])
        expect(service, "no-new-privileges", "no-new-privileges:true" in (host.get("SecurityOpt") or []), True)
        expect(service, "user", container["Config"]["User"], "1000:1000")
        expect(service, "devices", host.get("Devices") or [], [])
        expect(service, "pid mode", host.get("PidMode") or "", "")
    if re.fullmatch(r"runtime-[1-9][0-9]*", service):
        checked.append(service)
        expect(service, "memory", host["Memory"], 2 * 1024**3)
        expect(service, "memory+swap", host["MemorySwap"], 2 * 1024**3)
        expect(service, "CPUs", host["NanoCpus"], 1_000_000_000)
        expect(service, "pids", host["PidsLimit"], 256)
        expect(service, "tmpfs", host.get("Tmpfs"), {"/tmp": "rw,nosuid,nodev,size=128m,mode=1777"})
        expect(service, "log driver", host["LogConfig"]["Type"], "json-file")
        expect(service, "log rotation", host["LogConfig"]["Config"], {"max-file": "3", "max-size": "10m"})
        expect(service, "restart", host["RestartPolicy"]["Name"], "always")
        expect(service, "init", host.get("Init"), True)
        mounts = sorted((m["Type"], m.get("Name", ""), m["Destination"], m["RW"]) for m in container["Mounts"])
        expect(service, "mounts", mounts, sorted([("volume", f"{project}_{service}-data", "/data", True),
                                                  ("volume", f"{project}_runtime-tools", "/opt/flux-tools", False)]))
        expect(service, "networks", sorted(container["NetworkSettings"]["Networks"]), [f"{project}_{service}"])
    elif service in ("runtime-manager", "runtime-egress"):
        checked.append(service)
        expect(service, "mounts", container["Mounts"], [])
        expect(service, "networks hold no database network", f"{project}_default" in container["NetworkSettings"]["Networks"], False)

print(json.dumps({"checked": sorted(checked), "failures": failures}, indent=1))
sys.exit(1 if failures or not any(name.startswith("runtime-1") for name in checked) else 0)
