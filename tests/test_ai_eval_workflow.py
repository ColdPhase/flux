"""The answer-accuracy evaluation on GitHub Actions (#1295, #1441): the shape of .github/workflows/ai-eval.yml.

It runs a ref's own scripts with a real provider key, so it must stay dispatch-only, read-only, one run at a time, capped, pinned, and the
key must reach exactly one step (the one that writes the script's key file), never a command line, a log or an artifact.
"""

import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / ".github/workflows/ai-eval.yml").read_text(encoding="utf-8")
CODE = "\n".join(line for line in WORKFLOW.splitlines() if not line.lstrip().startswith("#"))


def step(name):
    """The lines of the step with this name, up to the next step."""
    lines = CODE.splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == f"- name: {name}")
    end = next((i for i in range(start + 1, len(lines)) if lines[i].strip().startswith("- name: ")), len(lines))
    return "\n".join(lines[start:end])


def run_body(name):
    lines = step(name).splitlines()
    run = next(i for i, line in enumerate(lines) if line.strip() == "run: |")
    indent = len(lines[run + 1]) - len(lines[run + 1].lstrip())
    return "\n".join(line[indent:] for line in lines[run + 1:]) + "\n"


class AiEvalWorkflowShape(unittest.TestCase):
    def test_only_a_dispatch_starts_it_and_one_run_at_a_time(self):
        on = CODE.split("\non:\n", 1)[1].split("\nrun-name:", 1)[0]
        self.assertEqual(re.findall(r"^  (\w+):", on, re.M), ["workflow_dispatch"])
        for forbidden in ("pull_request", "push:", "schedule", "workflow_run", "workflow_call", "repository_dispatch"):
            self.assertNotIn(forbidden, CODE, forbidden)
        self.assertIn("group: ai-eval\n", CODE)
        self.assertIn("cancel-in-progress: false", CODE)

    def test_token_is_read_only(self):
        self.assertEqual(len(re.findall(r"^\s*permissions:", CODE, re.M)), 1)
        self.assertIn("permissions:\n  contents: read\n", CODE)
        self.assertNotRegex(CODE, r"^\s+[\w-]+: write\s*$")
        self.assertNotIn("GITHUB_TOKEN", CODE)
        self.assertNotIn("github.token", CODE)

    def test_the_key_reaches_only_the_step_that_writes_the_key_file(self):
        self.assertEqual(re.findall(r"secrets\.(\w+)", CODE), ["FLUX_EVAL_ANTHROPIC_KEY"])
        self.assertIn("secrets.FLUX_EVAL_ANTHROPIC_KEY", step("Write the key file"))
        body = run_body("Write the key file")
        self.assertIn("umask 077", body)
        self.assertNotRegex(body, r"\becho\b.*\$\{?FLUX_EVAL_ANTHROPIC_KEY")
        self.assertIn("environment: ai-eval", CODE)
        # Removed before the upload; the evidence is checked for it again.
        collect = run_body("Collect the evidence")
        self.assertIn('rm -f "$out/anthropic.key"', collect)
        self.assertIn("grep -rlF -f", collect)

    def test_actions_are_pinned_and_checkouts_keep_no_credentials(self):
        for ref in re.findall(r"^\s*(?:- )?uses: (\S+)(?: #.*)?$", WORKFLOW, re.M):
            self.assertRegex(ref, r"^[\w.-]+/[\w.-]+@[0-9a-f]{40}$", ref)
        start = CODE.index("uses: actions/checkout@")
        self.assertIn("persist-credentials: false", CODE[start:start + 400])

    def test_inputs_reach_the_shell_only_through_env(self):
        for name in ("Validate inputs", "Write the key file", "Run the evaluation", "Collect the evidence"):
            self.assertNotIn("${{", run_body(name), name)
        self.assertNotIn("github.event.inputs", CODE)

    def test_it_runs_the_same_script_and_the_artifact_is_short_lived(self):
        self.assertIn("./scripts/check_ai_eval.sh", run_body("Run the evaluation"))
        self.assertIn("export FLUX_EVAL_ENGINE=pi", run_body("Run the evaluation"))
        self.assertEqual([int(n) for n in re.findall(r"retention-days: (\d+)", CODE)], [7])
        self.assertRegex(CODE, r"timeout-minutes: \d+")

    def test_validation_caps_the_money_and_refuses_shell_characters(self):
        script = run_body("Validate inputs")

        def validate(**inputs):
            values = {"INPUT_REF": "claude-hubert/1441-pi", "INPUT_ENGINE": "pi", "INPUT_QUESTIONS": "", "INPUT_LABEL": "", "INPUT_MAX_USD": "1.50"}
            values.update(inputs)
            with tempfile.NamedTemporaryFile() as output:
                env = {"PATH": "/usr/bin:/bin", "GITHUB_OUTPUT": output.name, **values}
                return subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True).returncode

        self.assertEqual(validate(), 0)
        self.assertEqual(validate(INPUT_MAX_USD="2"), 0)
        self.assertEqual(validate(INPUT_QUESTIONS="facts,q01"), 0)
        for bad in ({"INPUT_MAX_USD": "2.01"}, {"INPUT_MAX_USD": "0"}, {"INPUT_MAX_USD": "10"}, {"INPUT_MAX_USD": "1;rm"},
                    {"INPUT_ENGINE": "claude_code"}, {"INPUT_REF": "a..b"}, {"INPUT_REF": "$(id)"}, {"INPUT_QUESTIONS": "q1 q2"},
                    {"INPUT_LABEL": "a b"}):
            self.assertNotEqual(validate(**bad), 0, bad)


if __name__ == "__main__":
    unittest.main()
