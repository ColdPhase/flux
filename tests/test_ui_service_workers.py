"""Browser contexts that stub network responses block service workers (#271).

A service worker that controls a page can send requests that Playwright's `page.route` and
`context.route` do not see; #297 measured that for test_agents_view test_04d. A UI module that
installs a route therefore creates every browser context with `service_workers="block"`, so its
stubs answer the same requests on every run. This reads the UI test sources, without starting a
browser, and fails when a module that calls `route` creates a context that does not block workers.
Standard library only.
"""

from __future__ import annotations

import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UI_TESTS = ROOT / "app" / "tests" / "ui"


def _is_call(node: ast.AST, method: str) -> bool:
    return isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == method


def _is_request_context(node: ast.Call) -> bool:
    # `playwright.request.new_context` is an API client without pages or service workers.
    receiver = node.func.value
    return isinstance(receiver, ast.Attribute) and receiver.attr == "request"


def _blocks(value: ast.AST) -> bool:
    # "block", or a flag that chooses between "block" and "allow" (the helpers default to "block").
    if isinstance(value, ast.IfExp):
        return _blocks(value.body)
    return isinstance(value, ast.Constant) and value.value == "block"


def _dict_blocks(node: ast.Dict) -> bool:
    return any(isinstance(key, ast.Constant) and key.value == "service_workers" and _blocks(value) for key, value in zip(node.keys, node.values))


def unblocked_context_lines(source: str) -> list[int]:
    """Line numbers of `new_context` calls in a module that calls `route` but do not block workers."""
    tree = ast.parse(source)
    if not any(_is_call(node, "route") for node in ast.walk(tree)):
        return []
    # Options built as a named dict (`options = {..., "service_workers": "block"}`) and expanded with **.
    named = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Dict) and _dict_blocks(node.value):
            named.update(target.id for target in node.targets if isinstance(target, ast.Name))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.value, ast.Dict) and _dict_blocks(node.value) and isinstance(node.target, ast.Name):
            named.add(node.target.id)
    missing = []
    for node in ast.walk(tree):
        if not _is_call(node, "new_context") or _is_request_context(node):
            continue
        blocked = False
        for keyword in node.keywords:
            if keyword.arg == "service_workers" and _blocks(keyword.value):
                blocked = True
            elif keyword.arg is None and isinstance(keyword.value, ast.Dict) and _dict_blocks(keyword.value):
                blocked = True
            elif keyword.arg is None and isinstance(keyword.value, ast.Name) and keyword.value.id in named:
                blocked = True
        if not blocked:
            missing.append(node.lineno)
    return sorted(missing)


class ServiceWorkersAreBlockedWhereRoutesStub(unittest.TestCase):
    def test_the_detector_tells_blocking_contexts_from_the_rest(self) -> None:
        self.assertEqual(unblocked_context_lines("ctx = browser.new_context(base_url=O)\npage.route('**/x', h)\n"), [1])
        self.assertEqual(unblocked_context_lines("ctx = browser.new_context(base_url=O, service_workers='block')\npage.route('**/x', h)\n"), [])
        self.assertEqual(unblocked_context_lines("ctx = browser.new_context(**{'base_url': O, 'service_workers': 'block', **kw})\npage.route('**/x', h)\n"), [])
        self.assertEqual(unblocked_context_lines("options: dict = {'base_url': O, 'service_workers': 'block'}\nctx = browser.new_context(**options)\nctx.route('**/x', h)\n"), [])
        self.assertEqual(unblocked_context_lines("ctx = browser.new_context(base_url=O, service_workers='block' if flag else 'allow')\npage.route('**/x', h)\n"), [])
        self.assertEqual(unblocked_context_lines("ctx = browser.new_context(base_url=O)\n"), [], "a module without a route needs no block")

    def test_every_context_of_a_module_that_stubs_routes_blocks_service_workers(self) -> None:
        offenders = {}
        for path in sorted(UI_TESTS.glob("*.py")):
            lines = unblocked_context_lines(path.read_text(encoding="utf-8"))
            if lines:
                offenders[path.name] = lines
        self.assertEqual(offenders, {}, "create these contexts with service_workers=\"block\" (#271): module -> line numbers")


if __name__ == "__main__":
    unittest.main()
