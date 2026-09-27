"""Observable recovery/scheduling tests. Fixtures do not claim live model verification."""

import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from flux_harness.github import GitHub, HarnessError, digest
from flux_harness.providers import parse_output, run_provider, validate_result
from flux_harness.state import State, worker_lock
from flux_harness.worker import eligibility, scope_check, task_fingerprint, workspace, run


CONFIG = json.loads((ROOT / ".harness/project.json").read_text())
CONFIG["additional_milestones"] = []
CONFIG["milestone_discovery"]["enabled"] = False
WORKER = CONFIG["workers"][0]
PEER = CONFIG["workers"][1]


def issue(number, owner=None):
    return {"number": number, "state": "open", "title": f"Task {number}", "body": "AC-1: useful work",
            "user": {"login": WORKER["github_login"]},
            "assignees": [{"login": owner or WORKER["github_login"]}],
            "labels": [{"name": "agent:ready"}], "comments": [], "events": []}


def snapshot(*issues):
    return {"milestone": {"number": 1, "title": "Fixture", "state": "open", "description": "fixture"},
            "issues": list(issues), "pull_requests": []}


def result(outcome="progress", task=1):
    return {"outcome": outcome, "task": task, "role": "implementation", "summary": "Recorded actual work",
            "next_action": "Review the remaining criteria", "evidence": ["fixture evidence"]}


class TempTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="flux-harness-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)


class GitHubTests(unittest.TestCase):
    def test_pagination_preserves_comments_after_first_hundred(self):
        github = GitHub("ColdPhase/flux", ROOT)
        with patch.object(github, "api", side_effect=[list(range(100)), [100, 101]]) as api:
            self.assertEqual(github.comments(1), list(range(102)))
            self.assertIn("page=2", api.call_args.args[0])

    def test_transient_read_failure_is_retried(self):
        github = GitHub("ColdPhase/flux", ROOT)
        outcomes = [HarnessError('gh exited 1: Get "https://api.github.com/x": net/http: TLS handshake timeout'),
                    '{"login": "Zamojski5"}']

        def fake(*args, **kwargs):
            outcome = outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

        with patch("flux_harness.github.command", side_effect=fake), patch("flux_harness.github.time.sleep"):
            self.assertEqual(github.api("user")["login"], "Zamojski5")
        self.assertEqual(outcomes, [])

    def test_writes_and_permanent_failures_are_not_retried(self):
        github = GitHub("ColdPhase/flux", ROOT)
        cases = [("POST", HarnessError("gh exited 1: TLS handshake timeout")),
                 ("GET", HarnessError("gh exited 1: HTTP 404: Not Found"))]
        for method, error in cases:
            with patch("flux_harness.github.command", side_effect=error) as call, \
                    patch("flux_harness.github.time.sleep"):
                with self.assertRaises(HarnessError):
                    github.api("repos/x/issues", method, {"body": "x"} if method == "POST" else None)
                self.assertEqual(call.call_count, 1)

    def test_persistent_transient_read_failure_still_stops(self):
        github = GitHub("ColdPhase/flux", ROOT)
        error = HarnessError("gh exited 1: net/http: TLS handshake timeout")
        with patch("flux_harness.github.command", side_effect=error) as call, patch("flux_harness.github.time.sleep"):
            with self.assertRaises(HarnessError):
                github.api("user")
        self.assertEqual(call.call_count, 3)

    def test_timeout_after_successful_post_does_not_duplicate_a_comment(self):
        github = GitHub("ColdPhase/flux", ROOT)
        posted = []

        def api(endpoint, method="GET", data=None):
            if method == "POST":
                posted.append({"id": 10, "body": data["body"], "user": {"login": "PelikanFix16"}})
                raise HarnessError("Lost response after server committed")
            return posted

        with patch.object(github, "api", side_effect=api):
            with self.assertRaises(HarnessError):
                github.comment_once(1, "Actual checkpoint", "worker:step1", "PelikanFix16")
            self.assertEqual(github.comment_once(1, "Actual checkpoint", "worker:step1", "PelikanFix16")["id"], 10)
        self.assertEqual(len(posted), 1)

    def test_a_forged_marker_does_not_establish_author_identity(self):
        github = GitHub("ColdPhase/flux", ROOT)
        with patch.object(github, "comments", return_value=[{
            "id": 10, "body": "<!-- flux-message:worker:1 -->\nhello", "user": {"login": "outsider"}}]), \
                patch.object(github, "api", return_value={"id": 11}) as api:
            self.assertEqual(github.comment_once(1, "hello", "worker:1", "PelikanFix16")["id"], 11)
            self.assertEqual(api.call_args.args[1], "POST")

    def test_changed_message_content_requires_a_new_id(self):
        github = GitHub("ColdPhase/flux", ROOT)
        with patch.object(github, "comments", return_value=[{
            "body": "<!-- flux-message:w:1 -->\noriginal", "user": {"login": "PelikanFix16"}}]):
            with self.assertRaisesRegex(HarnessError, "different content"):
                github.comment_once(1, "edited", "w:1", "PelikanFix16")

    def test_wrong_github_identity_cannot_start_worker(self):
        github = GitHub("ColdPhase/flux", ROOT)
        with patch.object(github, "api", return_value={"login": "someone-else"}):
            with self.assertRaisesRegex(HarnessError, "requires gh account"):
                github.verify_identity(WORKER)

    def test_edited_milestone_description_invalidates_scope(self):
        config = copy.deepcopy(CONFIG)
        config["milestone"]["description_digest"] = digest("accepted")
        with self.assertRaisesRegex(HarnessError, "description changed"):
            scope_check(config, {"number": 1, "description": "expanded scope"})


class SchedulingTests(unittest.TestCase):
    def test_parked_task_does_not_block_another_owned_task(self):
        data = snapshot(issue(1), issue(2))
        parked = {"1": task_fingerprint(data, 1)}
        self.assertEqual(eligibility(data, WORKER, CONFIG, parked), ([2], False))

    def test_peer_answer_wakes_parked_task(self):
        data = snapshot(issue(1))
        parked = {"1": task_fingerprint(data, 1)}
        data["issues"][0]["comments"].append({"id": 20, "body": "Here is the missing interface",
                                              "user": {"login": PEER["github_login"]}})
        self.assertEqual(eligibility(data, WORKER, CONFIG, parked), ([1], False))

    def test_edited_peer_message_is_new_input(self):
        data = snapshot(issue(1))
        data["issues"][0]["comments"] = [{"id": 20, "body": "Investigating",
                                            "user": {"login": PEER["github_login"]}}]
        parked = {"1": task_fingerprint(data, 1)}
        data["issues"][0]["comments"][0]["body"] = "The missing contract is now available"
        self.assertEqual(eligibility(data, WORKER, CONFIG, parked), ([1], False))

    def test_dependency_completion_wakes_parked_work(self):
        data = snapshot(issue(1), issue(2))
        parked = {"1": task_fingerprint(data, 1)}
        data["issues"][1]["state"] = "closed"
        self.assertEqual(eligibility(data, WORKER, CONFIG, parked), ([1], False))

    def test_unknown_public_report_cannot_wake_an_executor(self):
        task = issue(1)
        task["user"]["login"] = "outsider"
        self.assertEqual(eligibility(snapshot(task), WORKER, CONFIG, {}), ([], False))

    def test_implementation_assignment_does_not_prevent_peer_review(self):
        task = issue(1, PEER["github_login"])
        task["labels"] = [{"name": "agent:review"}]
        self.assertEqual(eligibility(snapshot(task), WORKER, CONFIG, {}), ([1], False))

    def test_only_coordinator_bootstraps_an_empty_milestone(self):
        self.assertEqual(eligibility(snapshot(), WORKER, CONFIG, {}), ([], True))
        self.assertEqual(eligibility(snapshot(), PEER, CONFIG, {}), ([], False))


class JournalTests(TempTest):
    def test_interrupted_turn_and_outbox_survive_reopening(self):
        state = State(self.directory)
        state.begin("turn1", "snapshot1")
        state.stage_message("task:1", 1, "checkpoint")
        state.close()
        state = State(self.directory)
        try:
            self.assertEqual(state.get("active_turn"), "turn1")
            self.assertEqual(state.pending(), [("task:1", 1, "checkpoint")])
            state.delivered("task:1", 25)
            self.assertEqual(state.pending(), [])
        finally:
            state.close()

    def test_duplicate_local_worker_is_rejected_and_lock_releases(self):
        with worker_lock(self.directory):
            with self.assertRaisesRegex(HarnessError, "Another runner"):
                with worker_lock(self.directory):
                    pass
        with worker_lock(self.directory):
            pass

    def test_message_intent_cannot_change_after_a_crash(self):
        state = State(self.directory)
        try:
            state.stage_message("msg1", 1, "first")
            with self.assertRaisesRegex(HarnessError, "different action"):
                state.stage_message("msg1", 2, "second")
        finally:
            state.close()


class ProviderTests(TempTest):
    def test_output_must_be_structured_and_cannot_assert_complete(self):
        with self.assertRaises(HarnessError):
            validate_result(result("complete"))
        with self.assertRaises(HarnessError):
            validate_result({"outcome": "progress"})

    def test_claude_permission_denial_is_not_success(self):
        response = {"type": "result", "structured_output": result(),
                    "permission_denials": [{"tool_name": "Bash"}]}
        (self.directory / "events.jsonl").write_text(json.dumps(response))
        with self.assertRaisesRegex(HarnessError, "denied"):
            parse_output("claude", self.directory)

    def test_claude_background_agent_results_use_latest_structured_output(self):
        # Claude Code 2.1.283 emits a result per turn resumed by a background subagent report.
        events = [{"type": "result", "session_id": "s", "result_index": 0, "structured_output": result(task=1)},
                  {"type": "result", "session_id": "s", "result_index": 1, "origin": {"kind": "peer"}},
                  {"type": "result", "session_id": "s", "result_index": 2, "structured_output": result(task=2)},
                  {"type": "result", "session_id": "s", "result_index": 3, "origin": {"kind": "peer"}}]
        (self.directory / "events.jsonl").write_text("\n".join(map(json.dumps, events)))
        parsed, session = parse_output("claude", self.directory)
        self.assertEqual((parsed["task"], session), (2, "s"))

    def test_claude_any_failed_or_denied_result_is_not_success(self):
        for extra, message in (({"is_error": True}, "successful"),
                               ({"permission_denials": [{"tool_name": "Bash"}]}, "denied")):
            events = [{"type": "result", "session_id": "s", "structured_output": result()},
                      dict({"type": "result", "session_id": "s"}, **extra)]
            (self.directory / "events.jsonl").write_text("\n".join(map(json.dumps, events)))
            with self.assertRaisesRegex(HarnessError, message):
                parse_output("claude", self.directory)

    def test_codex_failed_turn_cannot_reuse_a_plausible_result(self):
        (self.directory / "events.jsonl").write_text(json.dumps({"type": "turn.failed"}))
        (self.directory / "result.json").write_text(json.dumps(result()))
        with self.assertRaisesRegex(HarnessError, "failed turn"):
            parse_output("codex", self.directory)

    def test_both_adapters_invoke_a_cli_with_stdin_and_parse_results(self):
        # Real subprocesses, artificial model output; no model/network credentials.
        binary = self.directory / "bin"
        binary.mkdir()
        program = """#!/usr/bin/env python3
import json, pathlib, sys
prompt = sys.stdin.read()
assert 'literal $(touch /tmp/flux-not-a-shell-command)' in prompt
assert sys.argv[sys.argv.index('--model')+1] == 'fixture-model'
if pathlib.Path(sys.argv[0]).name == 'claude':
    assert sys.argv[sys.argv.index('--effort')+1] == 'high'
else:
    assert 'model_reasoning_effort="high"' in sys.argv
response = {"outcome":"waiting","task":None,"role":"planning","summary":"Checked fixture","next_action":"Wait for peer","evidence":[]}
if pathlib.Path(sys.argv[0]).name == 'codex':
    pathlib.Path(sys.argv[sys.argv.index('--output-last-message')+1]).write_text(json.dumps(response))
    print(json.dumps({"type":"thread.started","thread_id":"fixture-session"}))
    print(json.dumps({"type":"turn.completed"}))
else:
    print(json.dumps({"type":"result","structured_output":response,"session_id":"fixture-session"}))
"""
        for provider in ("codex", "claude"):
            executable = binary / provider
            executable.write_text(program)
            executable.chmod(0o700)
        with patch.dict(os.environ, {"PATH": str(binary) + os.pathsep + os.environ["PATH"]}):
            for provider in ("codex", "claude"):
                with self.subTest(provider=provider):
                    response, session = run_provider(provider, self.directory, self.directory,
                        self.directory / provider, "literal $(touch /tmp/flux-not-a-shell-command)",
                        time.monotonic() + 10, lambda: None, options={"model":"fixture-model", "reasoning_effort":"high"})
                    self.assertEqual(response["outcome"], "waiting")
                    self.assertEqual(session, "fixture-session")

    def test_stop_callback_terminates_the_active_process(self):
        executable = self.directory / "claude"
        executable.write_text("#!/usr/bin/env python3\nimport time\ntime.sleep(60)\n")
        executable.chmod(0o700)
        started = time.monotonic()

        def stop():
            raise HarnessError("Stop requested")

        with patch.dict(os.environ, {"PATH": str(self.directory) + os.pathsep + os.environ["PATH"]}):
            with self.assertRaisesRegex(HarnessError, "Stop requested"):
                run_provider("claude", self.directory, self.directory, self.directory / "turn",
                             "fixture", time.monotonic() + 30, stop)
        self.assertLess(time.monotonic() - started, 10)


class LoopFixture(TempTest):
    def setUp(self):
        super().setUp()
        self.repo = self.directory / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        (self.repo / "README.md").write_text("Fixture\n")
        (self.repo / ".gitignore").write_text("/.harness/\n")
        subprocess.run(["git", "-C", str(self.repo), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.repo), "-c", "user.name=Fixture",
                        "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], check=True)
        self.revision = subprocess.check_output(["git", "-C", str(self.repo), "rev-parse", "HEAD"], text=True).strip()
        self.config = copy.deepcopy(CONFIG)
        self.config["milestone"].update(brief_path="README.md", description_digest=digest("fixture"))
        self.config["limits"]["max_turns"] = 2
        (self.repo / ".harness").mkdir()
        (self.repo / ".harness/project.json").write_text(json.dumps(self.config))
        # Scheduler fixtures isolate coordination from the tested provider behavior.
        # Dedicated peer-presence tests exercise the real guard and its transport.
        self.guard_patch = patch("flux_harness.worker.PeerGuard")
        self.guard = self.guard_patch.start().return_value
        self.guard.start.return_value = None
        self.guard.poll.return_value = None
        self.addCleanup(self.guard_patch.stop)

class LoopTests(LoopFixture):
    def test_workspace_is_isolated_and_reused_without_deleting_work(self):
        directory = self.repo / ".harness/local/fixture"
        directory.mkdir(parents=True)
        path = workspace(self.repo, directory, self.revision)
        (path / "progress.txt").write_text("unfinished work")
        self.assertEqual(workspace(self.repo, directory, self.revision), path)
        self.assertEqual((path / "progress.txt").read_text(), "unfinished work")
        self.assertFalse((self.repo / "progress.txt").exists())

    def test_config_upgrade_preserves_dirty_coordination_workspace(self):
        directory = self.repo / ".harness/local/fixture"
        directory.mkdir(parents=True)
        path = workspace(self.repo, directory, self.revision)
        (path / "saved.txt").write_text("Do not delete")
        with self.assertRaisesRegex(HarnessError, "saved changes"):
            workspace(self.repo, directory, "0" * 40)
        self.assertEqual((path / "saved.txt").read_text(), "Do not delete")

    def test_loop_continues_other_work_after_one_task_blocks(self):
        data = snapshot(issue(1), issue(2))
        calls = []

        class FakeGitHub:
            def __init__(self, *args):
                pass

            def snapshot(self, number):
                return copy.deepcopy(data)

            def verify_identity(self, worker):
                return worker["github_login"]

        def provider(name, root, cwd, directory, prompt, deadline, tick, session, options=None, idle_timeout=None):
            calls.append(prompt)
            if len(calls) == 1:
                return result("blocked", 1), "fixture"
            self.assertIn('"eligible_issue_numbers": [2]', prompt)
            return result("waiting", 2), "fixture"

        with patch("flux_harness.worker.configuration", return_value=(self.config, WORKER)), \
                patch("flux_harness.worker.preflight", return_value={"revision": self.revision, "execution_configured": True}), \
                patch("flux_harness.worker.GitHub", FakeGitHub), \
                patch("flux_harness.worker.run_provider", side_effect=provider):
            self.assertEqual(run(self.repo, WORKER["id"]), 2)
        self.assertEqual(len(calls), 2)
        state = State(self.repo / ".harness/local" / WORKER["id"])
        try:
            self.assertIn("1", state.get("parked"))
            self.assertEqual(state.get("status"), "limit-reached")
        finally:
            state.close()

    def test_idle_peer_does_not_start_a_model_or_call_it_complete(self):
        data = snapshot()
        with patch("flux_harness.worker.configuration", return_value=(self.config, PEER)), \
                patch("flux_harness.worker.preflight", return_value={"revision": self.revision, "execution_configured": True}), \
                patch("flux_harness.worker.GitHub") as github, \
                patch("flux_harness.worker.run_provider") as provider:
            github.return_value.snapshot.return_value = data
            self.assertEqual(run(self.repo, PEER["id"], once=True), 0)
            provider.assert_not_called()
        state = State(self.repo / ".harness/local" / PEER["id"])
        try:
            self.assertEqual(state.get("status"), "waiting-for-work")
        finally:
            state.close()

    def test_waiting_for_review_parks_only_that_task(self):
        data = snapshot(issue(1), issue(2))
        calls = []

        def provider(name, root, cwd, directory, prompt, deadline, tick, session, options=None, idle_timeout=None):
            calls.append(prompt)
            if len(calls) == 2:
                self.assertIn('"eligible_issue_numbers": [2]', prompt)
            return result("waiting", len(calls)), "fixture"

        with patch("flux_harness.worker.configuration", return_value=(self.config, WORKER)), \
                patch("flux_harness.worker.preflight", return_value={"revision": self.revision, "execution_configured": True}), \
                patch("flux_harness.worker.GitHub") as github, \
                patch("flux_harness.worker.run_provider", side_effect=provider):
            github.return_value.snapshot.return_value = data
            self.assertEqual(run(self.repo, WORKER["id"]), 2)
        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
