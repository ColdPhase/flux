#!/usr/bin/env python3
"""Fail publication unless GitHub confirms immutable Releases are enabled."""

from __future__ import annotations

import json
import sys


def verify(payload: str) -> None:
    try:
        setting = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise ValueError("immutable Releases setting response is invalid JSON") from exc
    if not isinstance(setting, dict) or setting.get("enabled") is not True:
        raise ValueError("immutable Releases must be enabled before publication")


if __name__ == "__main__":
    try:
        verify(sys.stdin.read())
    except ValueError as exc:
        print(exc, file=sys.stderr)
        raise SystemExit(1) from exc
