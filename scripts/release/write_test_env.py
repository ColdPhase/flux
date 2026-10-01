#!/usr/bin/env python3
"""Create throwaway credentials for the downloaded Compose smoke test.

Only the values INSTALL.md tells an operator to set are filled in: the integration fixture
endpoint (FLUX_FIXTURE_TOKEN) stays empty, as it must on a real deployment.
"""

from __future__ import annotations

import argparse
import secrets
from pathlib import Path


def write(source: Path, destination: Path, port: int) -> None:
    if destination.exists():
        raise ValueError("refusing to overwrite an existing environment file")
    if not 1024 <= port <= 65535:
        raise ValueError("invalid test port")
    replacements = {
        "POSTGRES_PASSWORD": secrets.token_hex(32),
        "FLUX_AUTH_SECRET": secrets.token_hex(32),
        "FLUX_PORT": str(port),
        "FLUX_PUBLIC_ORIGIN": f"http://127.0.0.1:{port}",
    }
    lines = []
    seen = set()
    for line in source.read_text(encoding="utf-8").splitlines():
        key = line.split("=", 1)[0]
        if key in replacements:
            lines.append(f"{key}={replacements[key]}")
            seen.add(key)
        else:
            lines.append(line)
    missing = {"POSTGRES_PASSWORD", "FLUX_AUTH_SECRET", "FLUX_PUBLIC_ORIGIN"} - seen
    if missing:
        raise ValueError(f"environment template is missing {', '.join(sorted(missing))}")
    lines.extend(f"{key}={value}" for key, value in replacements.items() if key not in seen)
    destination.write_text("\n".join(lines) + "\n", encoding="utf-8")
    destination.chmod(0o600)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    write(args.source, args.destination, args.port)


if __name__ == "__main__":
    main()
