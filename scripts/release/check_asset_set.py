#!/usr/bin/env python3
"""Fail unless a release asset directory holds exactly what SHA256SUMS covers."""

from __future__ import annotations

import sys
from pathlib import Path

CHECKSUMS = "SHA256SUMS"


def verify(directory: Path) -> None:
    listed: set[str] = set()
    for line in (directory / CHECKSUMS).read_text(encoding="utf-8").splitlines():
        digest, separator, name = line.partition("  ")
        if (not separator or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest)
                or not name or "/" in name or name == CHECKSUMS):
            raise ValueError(f"malformed {CHECKSUMS} line: {line!r}")
        listed.add(name)
    present = {path.name for path in directory.iterdir()} - {CHECKSUMS}
    # sha256sum -c only proves that listed files match. An unlisted asset would be published
    # without ever having been covered by the independently reviewed checksum list.
    if present != listed:
        raise ValueError(
            f"release assets differ from {CHECKSUMS}: unlisted {sorted(present - listed)}, "
            f"missing {sorted(listed - present)}"
        )


if __name__ == "__main__":
    try:
        verify(Path(sys.argv[1]))
    except (IndexError, OSError, ValueError) as exc:
        print(exc, file=sys.stderr)
        raise SystemExit(1) from exc
