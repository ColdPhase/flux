"""The first screen's budget is counted the same way in two places (#1428): `scripts/perf-bundle.mjs` (what the performance script and the
v0.2.0-against-main comparison report) and `app/tests/app/first-screen-budget.test.ts` (what fails a build that goes over). They run in
different images, so neither can import the other; this keeps them counting the same files the same way and against the same budget."""

from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = (ROOT / "scripts/perf-bundle.mjs").read_text()
GUARD = (ROOT / "app/tests/app/first-screen-budget.test.ts").read_text()
ENTRY_LINK = r'<(?:script|link)\b[^>]*?(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"[^>]*>'


class FirstScreenBudget(unittest.TestCase):
    def test_both_read_the_same_files_of_index_html(self):
        self.assertIn(ENTRY_LINK, SCRIPT)
        self.assertIn(ENTRY_LINK, GUARD)

    def test_both_compress_with_brotli_quality_five(self):
        for source in (SCRIPT, GUARD):
            self.assertIn("[constants.BROTLI_PARAM_QUALITY]: 5", source)

    def test_the_budget_is_the_one_the_performance_page_records(self):
        self.assertIn("at most 250 KB brotli", SCRIPT)
        self.assertRegex(GUARD, r"const BUDGET_KB = 250;")
        page = (ROOT / "docs/development/performance-2026-11.md").read_text()
        self.assertTrue(re.search(r"at most 250 KB", page), "the performance page states the 250 KB budget")


if __name__ == "__main__":
    unittest.main()
