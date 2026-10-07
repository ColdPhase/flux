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

    def test_link_anchor_must_name_an_existing_heading(self):
        self.write("docs/agents/guide.md", "# Guide\n\n## Working rules\n\n## Working rules\n\n```\n## Not a heading\n```\n")
        self.write("docs/agents/README.md", "# Agent design\n\n[Rules](guide.md#working-rules) [Second](guide.md#working-rules-1) [Own](#agent-design)\n")
        self.assertEqual(self.check(), [])
        self.write("docs/agents/README.md", "[Old](guide.md#identity) [Fenced](guide.md#not-a-heading)\n")
        errors = self.check()
        self.assertTrue(any("guide.md#identity" in error and "missing heading anchor" in error for error in errors))
        self.assertTrue(any("guide.md#not-a-heading" in error for error in errors))

    def test_numeric_reference_requires_a_definition_in_the_same_file(self):
        self.write("docs/agents/README.md", "# Agent design\n\nSee [#1].\n")
        self.write("docs/agents/guide.md", "[#1]: https://github.com/ColdPhase/flux/issues/1\n")
        self.assertEqual(self.check(), ["docs/agents/README.md:3: undefined numeric reference [#1]"])
        self.write("docs/agents/README.md", "# Agent design\n\nSee [#1].\n\n[#1]: https://github.com/ColdPhase/flux/issues/1\n")
        self.assertEqual(self.check(), [])

    def test_numeric_reference_check_ignores_research_labels_and_inline_links(self):
        self.write("docs/agents/README.md", "[S4] [P12] [#1](https://example.com) [#2][source]\n")
        self.assertEqual(self.check(), [])

    def test_numeric_full_and_collapsed_references_resolve_the_target_label(self):
        self.assertEqual(CHECKER.undefined_numeric_references("[text][#1] [#2][] [#3][#4]\n"),
                         [(1, "#1"), (1, "#2"), (1, "#4")])
        self.assertEqual(CHECKER.undefined_numeric_references(
            "[text][#1] [#2][]\n\n[#1]: https://example.com\n[#2]:\n  https://example.com\n"), [])

    def test_numeric_references_ignore_inline_code_with_matching_backtick_runs(self):
        self.assertEqual(CHECKER.undefined_numeric_references(
            "`[#1]` ``literal ` [#2]`` ```[#3]`` [#4]```\n`across\n[#5]`\n[#6]\n"), [(4, "#6")])
        self.assertEqual(CHECKER.undefined_numeric_references("Unmatched ` then [#1]\n"), [(1, "#1")])

    def test_numeric_references_ignore_fences_only_until_a_matching_close(self):
        self.assertEqual(CHECKER.undefined_numeric_references(
            "````md\n[#1]\n```\n[#2]\n~~~\n[#3]\n`````\n[#4]\n"
            "  ~~~\n[#5]\n   ~~~~\n[#6]\n"), [(8, "#4"), (12, "#6")])

    def test_code_examples_cannot_define_real_numeric_references(self):
        self.assertEqual(CHECKER.undefined_numeric_references(
            "```md\n[#1]: https://example.com\n```\n`[#2]: https://example.com`\n[#1] [#2]\n"),
                         [(5, "#1"), (5, "#2")])

    def test_escaped_numeric_reference_is_literal_but_even_backslashes_are_not(self):
        self.assertEqual(CHECKER.undefined_numeric_references(r"\[#1] \\[#2] \\\[#3]"), [(1, "#2")])
        self.assertEqual(CHECKER.undefined_numeric_references(r"\` [#1]"), [(1, "#1")])
        self.assertEqual(CHECKER.undefined_numeric_references(r"\``[#1]`"), [])

    def test_unmatched_inline_code_cannot_hide_a_reference_in_the_next_block(self):
        self.assertEqual(CHECKER.undefined_numeric_references(
            "Unmatched `\n\nSee [#30].\n\nTrailing `\n"), [(3, "#30")])
        self.assertEqual(CHECKER.undefined_numeric_references(
            "Unmatched `\n~~~md\nignored [#31]\n~~~\nSee [#32] `\n"), [(5, "#32")])
        self.assertEqual(CHECKER.undefined_numeric_references(
            "Unmatched `\n## See [#34]\nTrailing `\n"), [(2, "#34")])

    def test_quoted_fenced_code_does_not_hide_references_after_the_quote(self):
        self.assertEqual(CHECKER.undefined_numeric_references(
            "> ~~~md\n> [#33]\n> ~~~\n"), [])
        self.assertEqual(CHECKER.undefined_numeric_references(
            "> ```md\n> [#33]\nOutside [#34]\n"), [(3, "#34")])
        self.assertEqual(CHECKER.undefined_numeric_references(
            "> > ~~~md\n> > [#33]\n> > ~~~\n\n[#34]\n"), [(5, "#34")])

    def test_list_item_fences_ignore_code_but_not_following_references(self):
        self.assertEqual(CHECKER.undefined_numeric_references(
            "- ```md\n  [#35]\n  ```\n\n[#36]\n"), [(5, "#36")])
        self.assertEqual(CHECKER.undefined_numeric_references(
            "123. ~~~md\n     [#35]\n     ~~~\n\n[#36]\n"), [(5, "#36")])
        self.assertEqual(CHECKER.undefined_numeric_references(
            "> - ~~~md\n>   [#35]\n>   ~~~\n\n[#36]\n"), [(5, "#36")])
        self.assertEqual(CHECKER.undefined_numeric_references(
            "- ```md\n  [#35]\nOutside [#36]\n"), [(3, "#36")])

if __name__ == "__main__":
    unittest.main()
