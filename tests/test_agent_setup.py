"""Regression checks for broken shared agent instructions, skills and links."""

import importlib.util
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
        files = {
            "README.md": "# Fixture\n",
            "GOVERNANCE.md": "# Governance\n",
            "CHANGELOG.md": "# Changelog\n",
            "AGENTS.md": "# Shared instructions\n",
            "CLAUDE.md": "@AGENTS.md\n",
            "docs/README.md": "# Docs\n",
            "docs/CONTRIBUTING.md": "# Contributing\n",
            "docs/agents/README.md": "# Agent design\n",
            ".agents/skills/flux-example/SKILL.md": (
                "---\nname: flux-example\ndescription: Exercise the fixture.\n---\n"
                "# Example\n"
            ),
        }
        for name, content in files.items():
            self.write(name, content)
        (self.root / ".claude").mkdir()
        (self.root / ".claude/skills").symlink_to("../.agents/skills")

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def check(self):
        return CHECKER.validate(self.root)

    def test_minimal_foundation_is_valid(self):
        self.assertEqual(self.check(), [])

    def test_repository_foundation_is_valid(self):
        self.assertEqual(CHECKER.validate(REPOSITORY), [])

    def test_links_are_checked_in_every_docs_folder(self):
        self.write("docs/operations/README.md", "[gone](missing.md)\n")
        self.assertTrue(any("docs/operations/README.md" in error for error in self.check()))

    def test_prototype_storage_keys_are_not_skill_references(self):
        self.write("docs/prototype/README.md", "Key `flux-ux-v8-local`.\n")
        self.assertEqual(self.check(), [])
        self.write("docs/operations/README.md", "Use `flux-missing-skill`.\n")
        self.assertTrue(any("missing skill flux-missing-skill" in error for error in self.check()))

    def test_claude_must_import_shared_instructions(self):
        self.write("CLAUDE.md", "# Separate instructions\n")
        self.assertTrue(any("CLAUDE.md" in error for error in self.check()))

    def test_claude_cannot_silently_use_a_separate_skill_copy(self):
        link = self.root / ".claude/skills"
        link.unlink()
        link.mkdir()
        self.assertTrue(any(".claude/skills" in error for error in self.check()))

    def test_skill_needs_frontmatter_matching_its_folder(self):
        self.write(".agents/skills/flux-example/SKILL.md", "# No frontmatter\n")
        self.assertTrue(any("missing YAML frontmatter" in error for error in self.check()))
        self.write(".agents/skills/flux-example/SKILL.md",
                   "---\nname: other\ndescription: Wrong name.\n---\n")
        self.assertTrue(any("name must match" in error for error in self.check()))
        self.write(".agents/skills/flux-example/SKILL.md", "---\nname: flux-example\n---\n")
        self.assertTrue(any("single-line description" in error for error in self.check()))

    def test_handoff_documentation_cannot_reference_a_missing_file(self):
        self.write("docs/agents/README.md", "[Handoff](missing-handoff.md)\n")
        self.assertTrue(any("missing-handoff.md" in error for error in self.check()))

    def test_referenced_helper_skill_must_be_available(self):
        self.write("docs/agents/README.md", "Use `flux-missing-helper`.\n")
        self.assertTrue(any("missing skill flux-missing-helper" in error for error in self.check()))

    def test_external_links_are_not_resolved_locally(self):
        self.write("docs/agents/README.md", "[GitHub](https://github.com/ColdPhase/flux)\n")
        self.assertEqual(self.check(), [])


if __name__ == "__main__":
    unittest.main()
