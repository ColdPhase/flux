"""On-demand test modules on GitHub Actions (founder direction, Hubert, 2026-11-12): the shape of
.github/workflows/test-modules.yml and the behaviour of scripts/ci_test.sh.

The workflow runs a ref's own scripts on a runner, so it must stay dispatch-only (never started by a push, a PR or a schedule),
read-only, secret-free, pinned and cancel-on-repeat. The plan and validation steps are bash inside the YAML; they are run here
against a fake checkout. scripts/ci_test.sh is run against a stub `gh`.
"""

import json
import os
import re
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_PATH = ROOT / ".github/workflows/test-modules.yml"
WORKFLOW = WORKFLOW_PATH.read_text(encoding="utf-8")
SCRIPT = ROOT / "scripts/ci_test.sh"


def code_lines(text):
    """The lines that are not comments."""
    return [line for line in text.splitlines() if not line.lstrip().startswith("#")]


def top_level_block(name):
    """The lines under a top-level key (`on:`, `permissions:`...), without comments."""
    lines = WORKFLOW.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith(f"{name}:"))
    block = []
    for line in lines[start + 1:]:
        if line and not line.startswith((" ", "#")):
            break
        if not line.lstrip().startswith("#"):
            block.append(line)
    return block


def step_script(step_name):
    """The `run: |` body of the step with this name."""
    lines = WORKFLOW.splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == f"- name: {step_name}")
    run = next(i for i in range(start, len(lines)) if lines[i].strip() == "run: |")
    indent = len(lines[run + 1]) - len(lines[run + 1].lstrip())
    body = []
    for line in lines[run + 1:]:
        if line.strip() and len(line) - len(line.lstrip()) < indent:
            break
        body.append(line[indent:])
    return "\n".join(body) + "\n"


def run_blocks():
    """Every `run:` body of the workflow, for the injection check."""
    lines = WORKFLOW.splitlines()
    blocks = []
    for i, line in enumerate(lines):
        if re.match(r"^\s*run: [|>]", line):
            base = len(line) - len(line.lstrip())
            body = []
            for follow in lines[i + 1:]:
                if follow.strip() and len(follow) - len(follow.lstrip()) <= base:
                    break
                body.append(follow)
            blocks.append("\n".join(body))
        elif re.match(r"^\s*run: \S", line):
            blocks.append(line)
    return blocks


class WorkflowShape(unittest.TestCase):
    def test_only_a_dispatch_starts_it(self):
        triggers = {line.strip().rstrip(":") for line in top_level_block("on") if re.match(r"^  \S", line)}
        self.assertEqual(triggers, {"workflow_dispatch"})
        for forbidden in ("pull_request", "push:", "schedule", "workflow_run", "workflow_call", "issue_comment", "repository_dispatch"):
            self.assertNotIn(forbidden, "\n".join(code_lines(WORKFLOW)), forbidden)

    def test_inputs_are_the_documented_ones(self):
        names = {m.group(1) for m in re.finditer(r"^      (\w+):$", "\n".join(top_level_block("on")), re.M)}
        self.assertTrue({"ref", "suite", "modules", "browser", "shards"} <= names, names)
        self.assertEqual(re.findall(r"^          - (\w+)$", WORKFLOW, re.M), ["ui", "live", "api", "runtime", "chromium", "webkit"])

    def test_token_is_read_only_everywhere(self):
        self.assertEqual([line.strip() for line in top_level_block("permissions") if line.strip()], ["contents: read"])
        code = "\n".join(code_lines(WORKFLOW))
        self.assertNotRegex(code, r"permissions:\s*\n(\s+\w[\w-]*: (write|admin)\s*\n)")
        self.assertNotRegex(code, r"^\s+[\w-]+: write\s*$")
        self.assertEqual(len(re.findall(r"^\s*permissions:", code, re.M)), 1, "no job may set its own permissions")

    def test_no_secrets(self):
        code = "\n".join(code_lines(WORKFLOW))
        self.assertNotIn("secrets", code)
        self.assertNotIn("GITHUB_TOKEN", code)
        self.assertNotRegex(code, r"github\.token")
        self.assertNotIn("pull_request_target", code)

    def test_every_action_is_pinned_by_sha(self):
        uses = re.findall(r"^\s*(?:- )?uses: (\S+)(?: #.*)?$", WORKFLOW, re.M)
        self.assertEqual(len(uses), 4, uses)
        for ref in uses:
            self.assertRegex(ref, r"^[\w.-]+/[\w.-]+@[0-9a-f]{40}$", ref)

    def test_checkouts_keep_no_credentials(self):
        checkouts = [m.start() for m in re.finditer(r"uses: actions/checkout@", WORKFLOW)]
        self.assertEqual(len(checkouts), 2)
        for start in checkouts:
            self.assertIn("persist-credentials: false", WORKFLOW[start:start + 400])

    def test_every_job_has_a_timeout_and_the_run_cancels_its_repeat(self):
        jobs = re.findall(r"^  (\w+):\n    name: ", WORKFLOW, re.M)
        self.assertEqual(jobs, ["plan", "test"])
        self.assertEqual(len(re.findall(r"^    timeout-minutes: \d+$", WORKFLOW, re.M)), len(jobs))
        group = re.search(r"^  group: (.+)$", WORKFLOW, re.M).group(1)
        for part in ("inputs.ref", "inputs.suite", "inputs.modules_key", "inputs.browser"):
            self.assertIn(part, group)
        self.assertIn("cancel-in-progress: true", WORKFLOW)
        self.assertIn("fail-fast: false", WORKFLOW)

    def test_artifacts_are_short_lived(self):
        retention = [int(n) for n in re.findall(r"retention-days: (\d+)", WORKFLOW)]
        self.assertEqual(len(retention), 2)
        self.assertTrue(all(1 <= n <= 5 for n in retention), retention)

    def test_inputs_reach_the_shell_only_through_env(self):
        for block in run_blocks():
            self.assertNotIn("${{", block)
        self.assertNotIn("github.event.inputs", WORKFLOW)

    def test_vapid_keys_are_blank_and_no_operator_env_is_read(self):
        for name in ("FLUX_VAPID_PUBLIC_KEY", "FLUX_VAPID_PRIVATE_KEY", "FLUX_VAPID_SUBJECT"):
            self.assertTrue(re.search(rf'^\s+{name}: ""$', WORKFLOW, re.M), name)
        self.assertNotIn("docker/.env", WORKFLOW)

    def test_it_runs_the_same_scripts_as_locally(self):
        for script in ("scripts/check_ui.sh", "scripts/check_live_ui.sh", "scripts/check_application.sh"):
            self.assertIn(script, WORKFLOW)
            self.assertTrue((ROOT / script).is_file(), script)
        self.assertIn("FLUX_LIVE_UI_PATTERN", (ROOT / "scripts/check_live_ui.sh").read_text(encoding="utf-8"))
        self.assertIn("FLUX_UI_BROWSER", (ROOT / "scripts/check_ui.sh").read_text(encoding="utf-8"))


class PlanSteps(unittest.TestCase):
    """The validation and plan steps, executed against a fake checkout."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.checkout = Path(self.tmp.name) / "checkout"
        (self.checkout / "app/tests/ui").mkdir(parents=True)
        (self.checkout / "app/tests/app").mkdir(parents=True)
        for name in ("test_a", "test_b", "test_c", "test_d", "test_e"):
            (self.checkout / f"app/tests/ui/{name}.py").write_text("", encoding="utf-8")
        (self.checkout / "app/tests/app/search.test.ts").write_text("", encoding="utf-8")
        subprocess.run(["git", "init", "-q", str(self.checkout)], check=True)
        subprocess.run(["git", "-C", str(self.checkout), "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q",
                        "--allow-empty", "-m", "x"], check=True)
        self.sha = subprocess.run(["git", "-C", str(self.checkout), "rev-parse", "HEAD"], check=True,
                                  capture_output=True, text=True).stdout.strip()

    def run_step(self, name, env, cwd):
        output = Path(self.tmp.name) / f"output-{abs(hash(name))}"
        output.write_text("", encoding="utf-8")
        script = Path(self.tmp.name) / "step.sh"
        script.write_text(step_script(name), encoding="utf-8")
        result = subprocess.run(["bash", str(script)], cwd=cwd, capture_output=True, text=True,
                                env={**os.environ, "GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": os.devnull, **env})
        return result, dict(line.split("=", 1) for line in output.read_text(encoding="utf-8").splitlines() if "=" in line)

    def validate(self, **inputs):
        env = {"INPUT_REF": "main", "INPUT_SUITE": "ui", "INPUT_MODULES": "test_a", "INPUT_BROWSER": "chromium", "INPUT_SHARDS": "1"}
        env.update({f"INPUT_{key.upper()}": value for key, value in inputs.items()})
        return self.run_step("Validate inputs", env, self.checkout)

    def plan(self, suite="ui", modules="test_a", shards="1"):
        return self.run_step("Plan the shards", {"INPUT_SUITE": suite, "INPUT_MODULES": modules, "INPUT_SHARDS": shards}, self.checkout)

    def test_valid_inputs_pass_and_the_ref_is_passed_on(self):
        for ref in ("main", "claude-hubert/ci-test-modules", "a" * 40, "v0.2.1"):
            result, outputs = self.validate(ref=ref)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(outputs["ref"], ref)
        for suite, modules in (("ui", "test_a test_b.Class.test_x"), ("live", "test_live_sessions"), ("api", "tests/app/search.test.ts"),
                              ("runtime", "check_agent_runtime check_cli_runtime check_runtime_sandbox")):
            result, _ = self.validate(suite=suite, modules=modules)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_refused_inputs(self):
        refused = [
            {"ref": "-x"}, {"ref": "a..b"}, {"ref": "a b"}, {"ref": "x;id"}, {"ref": "$(id)"}, {"ref": ""},
            {"suite": "all"}, {"browser": "firefox"}, {"suite": "live", "browser": "webkit", "modules": "test_live_sessions"},
            {"shards": "0"}, {"shards": "9"}, {"shards": "x"}, {"shards": "-1"},
            {"modules": ""}, {"modules": "test_a; id"}, {"modules": "$(id)"}, {"modules": "../x"},
            {"modules": " ".join(f"test_{i}" for i in range(41))},
            {"suite": "ui", "modules": "tests/app/search.test.ts"}, {"suite": "live", "modules": "test_a.Class"},
            {"suite": "api", "modules": "test_a"}, {"suite": "api", "modules": "tests/app/../x.test.ts"},
            {"suite": "api", "modules": "tests/app/a/b.test.ts"},
            {"suite": "runtime", "modules": "check_application"}, {"suite": "runtime", "modules": "check_agent_runtime.sh"},
        ]
        for inputs in refused:
            result, outputs = self.validate(**inputs)
            self.assertNotEqual(result.returncode, 0, inputs)
            self.assertNotIn("ref", outputs, inputs)

    def test_plan_splits_round_robin_and_never_makes_an_empty_shard(self):
        result, outputs = self.plan(modules="test_a test_b test_c test_d test_e", shards="2")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(outputs["sha"], self.sha)
        self.assertEqual(json.loads(outputs["matrix"]), {"include": [
            {"shard": 1, "shards": 2, "modules": "test_a test_c test_e"},
            {"shard": 2, "shards": 2, "modules": "test_b test_d"},
        ]})
        _, outputs = self.plan(modules="test_a test_b", shards="8")
        self.assertEqual([entry["modules"] for entry in json.loads(outputs["matrix"])["include"]], ["test_a", "test_b"])
        _, outputs = self.plan(modules="test_a test_a test_b", shards="1")
        self.assertEqual(json.loads(outputs["matrix"])["include"], [{"shard": 1, "shards": 1, "modules": "test_a test_b"}])

    def test_plan_checks_the_module_files_of_the_commit(self):
        result, _ = self.plan(modules="test_a test_missing")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("app/tests/ui/test_missing.py", result.stdout)
        result, outputs = self.plan(suite="live", modules="test_a")
        self.assertEqual(result.returncode, 0, result.stdout)
        result, outputs = self.plan(suite="ui", modules="test_a.Class.test_name")
        self.assertEqual(result.returncode, 0, result.stdout)
        result, outputs = self.plan(suite="api", modules="tests/app/search.test.ts")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(json.loads(outputs["matrix"])["include"][0]["modules"], "tests/app/search.test.ts")
        result, _ = self.plan(suite="api", modules="tests/app/nothing.test.ts")
        self.assertNotEqual(result.returncode, 0)


class CollectStep(unittest.TestCase):
    """The evidence step keeps the result lines of a unittest run, a node test run and a failure."""

    def collect(self, log):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "test-modules"
            (out / "screenshots/sub").mkdir(parents=True)
            (out / "screenshots/sub/a.png").write_bytes(b"png")
            (out / "run.log").write_text(log, encoding="utf-8")
            (out / "command.txt").write_text("./scripts/check_ui.sh test_a\n", encoding="utf-8")
            (out / "seconds.txt").write_text("77\n", encoding="utf-8")
            script = Path(tmp) / "step.sh"
            script.write_text(step_script("Collect the evidence"), encoding="utf-8")
            summary = Path(tmp) / "summary"
            summary.write_text("", encoding="utf-8")
            env = {**os.environ, "RUNNER_TEMP": tmp, "GITHUB_STEP_SUMMARY": str(summary), "RUN_OUTCOME": "failure", "TESTED_SHA": "a" * 40,
                   "SUITE": "ui", "BROWSER": "webkit", "MODULES": "test_a", "SHARD": "1", "SHARDS": "2", "GITHUB_SERVER_URL": "https://github.com",
                   "GITHUB_REPOSITORY": "ColdPhase/flux", "GITHUB_RUN_ID": "1", "GITHUB_RUN_ATTEMPT": "1"}
            result = subprocess.run(["bash", str(script)], capture_output=True, text=True, env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            keep = Path(tmp) / "test-modules-result"
            shots = sorted(p.name for p in (Path(tmp) / "test-modules-screenshots").rglob("*.png"))
            return (keep / "result.txt").read_text(encoding="utf-8"), (keep / "summary.md").read_text(encoding="utf-8"), shots, sorted(p.name for p in keep.iterdir())

    def test_unittest_failure_lines_are_kept(self):
        log = (
            "\x1b[32mbuilding\x1b[0m\n"
            "test_one (test_a.A.test_one) ... ok\n"
            "test_two (test_a.A.test_two) ... FAIL\n"
            "FAIL: test_two (test_a.A.test_two)\n"
            "Traceback (most recent call last):\n"
            "Ran 2 tests in 12.345s\n"
            "FAILED (failures=1)\n"
        )
        result, summary, shots, files = self.collect(log)
        self.assertEqual(result.splitlines(), [
            "test_two (test_a.A.test_two) ... FAIL", "FAIL: test_two (test_a.A.test_two)", "Ran 2 tests in 12.345s", "FAILED (failures=1)",
        ])
        self.assertIn("shard 1 of 2, failure", summary)
        self.assertIn("browser: `webkit`", summary)
        self.assertIn("Checks ran for 77 s", summary)
        self.assertEqual(shots, ["a.png"])
        self.assertEqual(files, ["command.txt", "result.txt", "run.log.gz", "summary.md"])

    def test_node_test_summary_lines_are_kept(self):
        result, _, _, _ = self.collect("ℹ tests 4\nℹ pass 3\nℹ fail 1\n✖ failing tests:\nNamed API test files only: browser, restart and unavailable-configuration checks skipped.\n")
        self.assertEqual(result.splitlines()[:3], ["ℹ tests 4", "ℹ pass 3", "ℹ fail 1"])
        self.assertIn("✖ failing tests:", result)

    def test_a_log_without_result_lines_shows_its_tail(self):
        result, _, _, _ = self.collect("one\ntwo\n")
        self.assertIn("No test result lines were found", result)
        self.assertIn("two", result)


class RunStep(unittest.TestCase):
    """The run step against stub scripts: which script, with what arguments and environment, and whether a failure is the step's result."""

    def run_suite(self, suite, modules, browser="chromium"):
        with tempfile.TemporaryDirectory() as tmp:
            checkout = Path(tmp) / "checkout"
            (checkout / "scripts").mkdir(parents=True)
            subprocess.run(["git", "init", "-q", str(checkout)], check=True)
            subprocess.run(["git", "-C", str(checkout), "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty",
                            "-m", "x"], check=True)
            sha = subprocess.run(["git", "-C", str(checkout), "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
            for name in ("check_ui.sh", "check_live_ui.sh", "check_application.sh", "check_agent_runtime.sh", "check_runtime_sandbox.sh"):
                stub = checkout / "scripts" / name
                stub.write_text(
                    '#!/bin/sh\necho "$0 $* browser=${FLUX_UI_BROWSER:-} pattern=${FLUX_LIVE_UI_PATTERN:-} vapid=[${FLUX_VAPID_PUBLIC_KEY-unset}]"\n'
                    'case "$*$FLUX_LIVE_UI_PATTERN" in *bad*) exit 1 ;; esac\n', encoding="utf-8")
                stub.chmod(0o755)
            script = Path(tmp) / "step.sh"
            script.write_text(step_script("Run the checks"), encoding="utf-8")
            env = {**os.environ, "RUNNER_TEMP": tmp, "SUITE": suite, "BROWSER": browser, "MODULES": modules, "TESTED_SHA": sha,
                   "FLUX_VAPID_PUBLIC_KEY": ""}
            result = subprocess.run(["bash", str(script)], cwd=checkout, capture_output=True, text=True, env=env)
            return result, (Path(tmp) / "test-modules/run.log").read_text(encoding="utf-8"), (Path(tmp) / "test-modules/command.txt").read_text(encoding="utf-8")

    def test_ui_runs_check_ui_with_the_engine(self):
        result, log, command = self.run_suite("ui", "test_a test_b.C.test_d", "webkit")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("check_ui.sh test_a test_b.C.test_d browser=webkit", log)
        self.assertIn("vapid=[]", log)
        self.assertEqual(command, "FLUX_UI_BROWSER=webkit ./scripts/check_ui.sh test_a test_b.C.test_d\n")

    def test_api_runs_the_named_files_once(self):
        result, log, _ = self.run_suite("api", "tests/app/a.test.ts tests/app/b.test.ts")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(log.count("check_application.sh"), 1)
        self.assertIn("tests/app/a.test.ts tests/app/b.test.ts", log)

    def test_live_runs_each_module_by_pattern_and_a_failure_fails_the_step_after_the_rest_ran(self):
        result, log, _ = self.run_suite("live", "test_live_a test_live_bad test_live_c")
        self.assertEqual(result.returncode, 1)
        for module in ("test_live_a", "test_live_bad", "test_live_c"):
            self.assertIn(f"pattern={module}.py", log)
        result, log, _ = self.run_suite("live", "test_live_a test_live_c")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_runtime_runs_each_named_check_and_says_the_kernel(self):
        result, log, command = self.run_suite("runtime", "check_runtime_sandbox check_agent_runtime")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ptrace_scope=", log)
        self.assertLess(log.index("check_runtime_sandbox.sh"), log.index("check_agent_runtime.sh"))
        self.assertIn("for each check", command)

    def test_a_failing_ui_script_fails_the_step(self):
        result, _, _ = self.run_suite("ui", "test_bad")
        self.assertEqual(result.returncode, 1)

    def test_a_checkout_that_is_not_the_planned_commit_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(["git", "init", "-q", tmp], check=True)
            subprocess.run(["git", "-C", tmp, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "x"],
                           check=True)
            script = Path(tmp) / "step.sh"
            script.write_text(step_script("Run the checks"), encoding="utf-8")
            result = subprocess.run(["bash", str(script)], cwd=tmp, capture_output=True, text=True,
                                    env={**os.environ, "RUNNER_TEMP": tmp, "SUITE": "ui", "BROWSER": "chromium", "MODULES": "a", "TESTED_SHA": "0" * 40})
            self.assertNotEqual(result.returncode, 0)


STUB_GH = """#!/bin/sh
# A stand-in for the GitHub CLI: records every call and answers what scripts/ci_test.sh asks.
printf '%s\\n' "$*" >> "$STUB_DIR/calls"
case "$1 $2" in
  "repo view") echo ColdPhase/flux ;;
  "api repos/ColdPhase/flux/commits/"*) [ "$STUB_KNOWN_SHA" = "${2##*/}" ] && echo "$STUB_FULL_SHA" || exit 1 ;;
  "api repos/ColdPhase/flux/actions/runs/"*) echo completed ;;
  "api repos/ColdPhase/flux/git/ref/heads/"*) [ "${2##*/heads/}" = "$STUB_BRANCH" ] && echo "$STUB_FULL_SHA" || exit 1 ;;
  "api repos/ColdPhase/flux/git/ref/tags/"*) exit 1 ;;
  "workflow run") ;;
  "run list")
    request=$(sed -n 's/.*request_id=\\(ci-[^ ]*\\).*/\\1/p' "$STUB_DIR/calls" | head -n 1)
    [ -z "$STUB_LIST_EMPTY" ] && echo 4242 || true
    ;;
  "run watch") ;;
  "run view")
    case "$*" in
      *conclusion*) echo "$STUB_CONCLUSION" ;;
      *--log-failed*)
        echo "the failing log line"
        [ -z "$STUB_ERROR_ANNOTATION" ] || printf 'Plan\tPlan the shards\t2026-11-12T16:34:35.2221471Z ##[error]Not found at abc: app/tests/ui/test_nope.py\n'
        ;;
    esac
    ;;
  "run download")
    [ -z "$STUB_NO_ARTIFACT" ] || exit 1
    while [ "$#" -gt 0 ]; do [ "$1" = --dir ] && dir=$2; shift; done
    mkdir -p "$dir/result-shard-1-attempt-1"
    printf 'Ran 3 tests in 1.5s\\nOK\\n' > "$dir/result-shard-1-attempt-1/result.txt"
    ;;
  *) echo "unexpected gh call: $*" >&2; exit 99 ;;
esac
"""


class CiTestScript(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        for name, body in (("gh", STUB_GH), ("sleep", '#!/bin/sh\n[ "$1" = 180 ] && exit 1\nexit 0\n')):
            path = self.dir / name
            path.write_text(body, encoding="utf-8")
            path.chmod(path.stat().st_mode | stat.S_IXUSR)
        self.full = "0123456789abcdef0123456789abcdef01234567"

    def run_script(self, *args, **env):
        merged = {
            **os.environ, "PATH": f"{self.dir}:{os.environ['PATH']}", "STUB_DIR": str(self.dir), "HOME": str(self.dir),
            "STUB_KNOWN_SHA": "0123456", "STUB_FULL_SHA": self.full, "STUB_BRANCH": "feature/x", "STUB_CONCLUSION": "success",
            "FLUX_CI_OUT": str(self.dir / "out"),
        }
        merged.update(env)
        return subprocess.run(["sh", str(SCRIPT), *args], capture_output=True, text=True, env=merged, cwd=ROOT, timeout=60)

    def calls(self):
        return (self.dir / "calls").read_text(encoding="utf-8")

    def test_syntax_and_mode(self):
        self.assertTrue(SCRIPT.stat().st_mode & stat.S_IXUSR, "scripts/ci_test.sh must be executable")
        subprocess.run(["sh", "-n", str(SCRIPT)], check=True)

    def test_wrong_arguments_exit_2_before_any_call(self):
        wrong = [
            [], ["main"], ["main", "ui", "chromium"], ["main", "all", "chromium", "a"], ["main", "ui", "firefox", "a"],
            ["main", "live", "webkit", "a"], ["--shards", "0", "main", "ui", "chromium", "a"], ["--shards", "9", "main", "ui", "chromium", "a"],
            ["--shards", "x", "main", "ui", "chromium", "a"], ["main", "ui", "chromium", "a;b"], ["-x", "ui", "chromium", "a"],
            ["a..b", "ui", "chromium", "a"], ["--bogus", "main", "ui", "chromium", "a"],
        ]
        for args in wrong:
            result = self.run_script(*args)
            self.assertEqual(result.returncode, 2, (args, result.stderr))
            self.assertFalse((self.dir / "calls").exists(), args)

    def test_dispatches_the_resolved_sha_and_reports_success(self):
        result = self.run_script("--shards", "2", "origin/feature/x", "ui", "webkit", "test_a", "test_b")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        dispatch = next(line for line in self.calls().splitlines() if line.startswith("workflow run"))
        self.assertIn("test-modules.yml", dispatch)
        self.assertIn("--ref main", dispatch)
        for expected in (f"ref={self.full}", "suite=ui", "browser=webkit", "modules=test_a test_b", "shards=2", "request_id=ci-"):
            self.assertIn(expected, dispatch)
        self.assertIn("run https://github.com/ColdPhase/flux/actions/runs/4242", result.stdout)
        self.assertIn("Ran 3 tests in 1.5s", result.stdout)
        self.assertIn("gh run download 4242 -R ColdPhase/flux --pattern \"screenshots-*\"", result.stdout)

    def test_a_short_sha_is_resolved_and_a_failed_run_exits_1(self):
        result = self.run_script("0123456", "api", "chromium", "tests/app/search.test.ts", STUB_CONCLUSION="failure")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(f"ref={self.full}", self.calls())
        self.assertIn("finished: failure", result.stdout)
        self.assertNotIn("screenshots", result.stdout)

    def test_a_ref_that_is_not_pushed_exits_3_without_dispatching(self):
        result = self.run_script("nowhere", "ui", "chromium", "test_a")
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertIn("not on GitHub", result.stderr)
        self.assertNotIn("workflow run", self.calls())

    def test_a_run_that_cannot_be_found_exits_3(self):
        result = self.run_script("feature/x", "ui", "chromium", "test_a", STUB_LIST_EMPTY="1")
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertIn("not found", result.stderr)

    def test_a_run_without_artifacts_prints_the_failing_log(self):
        result = self.run_script("feature/x", "ui", "chromium", "test_a", STUB_NO_ARTIFACT="1", STUB_CONCLUSION="failure")
        self.assertEqual(result.returncode, 1)
        self.assertIn("the failing log line", result.stdout)
        self.assertNotIn("screenshots", result.stdout)

    def test_a_failed_plan_prints_its_error_annotation_only(self):
        result = self.run_script("feature/x", "ui", "chromium", "test_nope", STUB_NO_ARTIFACT="1", STUB_CONCLUSION="failure", STUB_ERROR_ANNOTATION="1")
        self.assertEqual(result.returncode, 1)
        self.assertIn("##[error]Not found at abc: app/tests/ui/test_nope.py", result.stdout)
        self.assertNotIn("the failing log line", result.stdout)


if __name__ == "__main__":
    unittest.main()
