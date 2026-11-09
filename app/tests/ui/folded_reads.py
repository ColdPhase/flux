"""Tests that stand in for one read of the API, whether the page asks for it alone or folded with others (#862).

The web client sends the reads a view asks for in the same moment as one `GET /api/v1/reads?path=…&path=…`; the server answers each
from its own route. A test that answers one read itself (a stub) routes both: the read alone, and any fold that holds it, where the real
answers of the others are kept and the stubbed one replaced.
"""

from __future__ import annotations

import json
import re
from typing import Callable
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, Route

FOLD = re.compile(r".*/api/v1/reads\?")


def requested_paths(url: str) -> list[str]:
    """The reads one request asked for: the addresses inside a fold, or the request's own address."""
    parsed = urlparse(url)
    if parsed.path == "/api/v1/reads":
        return parse_qs(parsed.query).get("path", [])
    return [url]


def route_read(page: Page, pattern: re.Pattern[str], answer: Callable[[str], tuple[int, object]]) -> None:
    """Answers every read whose address matches `pattern` with `answer(address) -> (status, body)`, alone or inside a fold."""

    def alone(route: Route) -> None:
        status, body = answer(route.request.url)
        route.fulfill(status=status, content_type="application/json", body=json.dumps(body))

    def folded(route: Route) -> None:
        paths = parse_qs(urlparse(route.request.url).query).get("path", [])
        if not any(pattern.search(path) for path in paths):
            route.fallback()
            return
        response = route.fetch()
        data = response.json()
        for index, path in enumerate(paths):
            if pattern.search(path):
                status, body = answer(path)
                data["answers"][index] = {"status": status, "body": json.dumps(body)}
        route.fulfill(response=response, body=json.dumps(data))

    page.route(pattern, alone)
    page.route(FOLD, folded)
