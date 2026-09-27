"""Regression checks for unsafe activation and broken shared agent configuration."""

import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


REPOSITORY = Path(__file__).resolve().parents[1]
MODULE_SPEC = importlib.util.spec_from_file_location(
    "check_agent_setup", REPOSITORY / "scripts/check_agent_setup.py"
)
CHECKER = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(CHECKER)


class FoundationValidationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="flux-agent-check-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.manifest = json.loads(
            (REPOSITORY / ".harness/project.json").read_text(encoding="utf-8")
        )
        # Tests use a deterministic design-stage configuration, even after the
        # repository later activates its real release configuration.
        self.manifest["state"] = "design"
        for capability in ("loop", "merge", "publishing", "deployment"):
            self.manifest[capability]["enabled"] = False
        self.manifest["milestone"] = {
            "number": None, "phase": "release", "brief_path": None,
            "description_digest": None, "spec_path": None, "architecture_path": None,
        }
        for category in ("task_commands", "release_commands", "required_status_checks"):
            self.manifest["verification"][category] = []
        self.manifest["limits"]["max_run_minutes"] = None
        files = {
            "README.md": "# Fixture\n",
            "AGENTS.md": "# Shared instructions\n",
            "CLAUDE.md": "@AGENTS.md\n",
            ".gitignore": "/.harness/local/\n",
            "docs/README.md": "# Docs\n",
            "docs/CONTRIBUTING.md": "# Contributing\n",
            "docs/agents/README.md": "# Agent design\n",
            ".agents/skills/flux-example/SKILL.md": (
                "---\nname: flux-example\ndescription: Exercise the fixture.\n---\n"
                "# Example\n"
            ),
        }
        for name, content in files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        (self.root / ".claude").mkdir()
        (self.root / ".claude/skills").symlink_to("../.agents/skills")

    def check(self, manifest=None):
        directory = self.root / ".harness"
        directory.mkdir(exist_ok=True)
        (directory / "project.json").write_text(
            json.dumps(self.manifest if manifest is None else manifest), encoding="utf-8"
        )
        return CHECKER.validate(self.root)

    def test_design_can_be_valid_without_inventing_application_checks(self):
        self.assertEqual(self.check(), [])

    def test_switching_on_loop_does_not_bypass_missing_release_inputs(self):
        self.manifest["state"] = "active"
        self.manifest["loop"]["enabled"] = True
        errors = self.check()
        self.assertTrue(any("milestone.spec_path" in error for error in errors))
        self.assertTrue(any("verification.task_commands" in error for error in errors))
        self.assertTrue(any("verification.required_status_checks" in error for error in errors))
        self.assertTrue(any("limits.max_run_minutes" in error for error in errors))

    def test_design_cannot_enable_publishing(self):
        self.manifest["publishing"]["enabled"] = True
        errors = self.check()
        self.assertTrue(any("publishing.enabled" in error for error in errors))
        self.assertTrue(any("publishing.formats" in error for error in errors))

    def test_review_identity_cannot_be_shared(self):
        self.manifest["workers"][1]["github_login"] = (
            self.manifest["workers"][0]["github_login"].swapcase()
        )
        self.assertTrue(any("identities must be distinct" in error for error in self.check()))

    def test_claude_cannot_silently_use_a_separate_skill_copy(self):
        link = self.root / ".claude/skills"
        link.unlink()
        link.mkdir()
        self.assertTrue(any(".claude/skills" in error for error in self.check()))

    def test_handoff_documentation_cannot_reference_a_missing_file(self):
        (self.root / "docs/agents/README.md").write_text(
            "[Handoff](missing-handoff.md)\n", encoding="utf-8"
        )
        self.assertTrue(any("missing-handoff.md" in error for error in self.check()))

    def test_referenced_helper_skill_must_be_available(self):
        (self.root / "docs/agents/README.md").write_text(
            "Use `flux-missing-helper`.\n", encoding="utf-8"
        )
        self.assertTrue(any("missing skill flux-missing-helper" in error for error in self.check()))

    def test_unknown_configuration_cannot_be_ignored(self):
        altered = copy.deepcopy(self.manifest)
        altered["loop"]["enabeld"] = True
        self.assertTrue(any("unknown fields" in error for error in self.check(altered)))

    def test_planning_can_run_without_inventing_an_application_stack(self):
        self.manifest["state"] = "active"
        self.manifest["loop"]["enabled"] = True
        self.manifest["milestone"].update(number=1, phase="planning", brief_path="README.md",
                                          description_digest="sha256:" + "a" * 64)
        self.manifest["limits"]["max_run_minutes"] = 120
        self.assertEqual(self.check(), [])

    def test_planning_cannot_enable_application_publication(self):
        self.manifest["milestone"]["phase"] = "planning"
        self.manifest["publishing"].update(enabled=True, formats=["container"])
        self.assertTrue(any("planning milestones" in error for error in self.check()))

    def test_active_configuration_needs_a_pinned_scope(self):
        self.manifest["state"] = "active"
        self.manifest["loop"]["enabled"] = True
        self.assertTrue(any("description_digest" in error for error in self.check()))


if __name__ == "__main__":
    unittest.main()
