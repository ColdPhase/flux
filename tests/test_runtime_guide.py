"""The operator guide states the runtime's residual risks and release rules as the code enforces them (F-022 T3, #331).

Standard library only. These checks keep the wording from drifting back to claims the review refuted.
"""

from __future__ import annotations

import unittest
from pathlib import Path

GUIDE = Path(__file__).resolve().parents[1] / "docs" / "operations" / "agent-runtime.md"


class RuntimeGuideTest(unittest.TestCase):
    def setUp(self) -> None:
        self.text = GUIDE.read_text(encoding="utf-8")

    def test_the_tls_server_name_risk_is_not_described_as_harmless(self) -> None:
        self.assertNotIn("reaches nothing the slot could not reach", self.text)
        self.assertIn("shared infrastructure", self.text)
        self.assertIn("not measured", self.text)

    def test_a_release_does_not_claim_no_session_can_exist(self) -> None:
        self.assertNotIn("so no session can exist", self.text)
        self.assertIn("unconfirmed-<client>", self.text)


if __name__ == "__main__":
    unittest.main()
