"""Recovery and autonomous roadmap behavior; no real models or paid CI runs."""

import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from flux_harness.github import HarnessError, digest
from flux_harness.options import execution_options, saved_options
from flux_harness.recovery import recovery_context
from flux_harness.roadmap import (accepted_product, milestone_numbers, read_snapshot,
                                scope_check, verify_product_ci)
from flux_harness.state import State
from flux_harness.worker import run, workspace
from test_harness import CONFIG, WORKER, PEER, TempTest, LoopFixture, issue, result, snapshot


def milestone(number, creator=None, scope="flux-full-product", phase="implementation"):
    return {"number": number, "state": "open", "creator": {"login": creator or WORKER["github_login"]},
            "description": '<!-- flux-milestone:v1\n' + json.dumps({"scope": scope, "phase": phase}) + '\n-->'}


class ModelSelectionTests(TempTest):
    def test_both_providers_remember_model_and_effort(self):
        for provider, model in (("codex", "gpt-6-sol"), ("claude", "opus")):
            with self.subTest(provider=provider):
                directory = self.directory / provider
                selected = execution_options(provider, model=model, effort="high")
                state = State(directory)
                state.set("execution_options", selected)
                state.close()
                self.assertEqual(execution_options(provider, saved_options(directory)), selected)

    def test_explicit_model_change_preserves_effort_and_cli_defaults_clear_both(self):
        old = {"model": "old", "reasoning_effort": "high"}
        self.assertEqual(execution_options("claude", old, model="new"),
                         {"model": "new", "reasoning_effort": "high"})
        self.assertEqual(execution_options("claude", old, use_cli_defaults=True),
                         {"model": None, "reasoning_effort": None})

    def test_invalid_selection_fails_before_a_provider_call(self):
        for model in ("", "--bad", "name\ncommand"):
            with self.assertRaises(HarnessError):
                execution_options("codex", model=model)
        with self.assertRaises(HarnessError):
            execution_options("claude", effort="minimal")

    def test_read_only_preview_does_not_create_a_journal(self):
        self.assertIsNone(saved_options(self.directory))
        self.assertFalse((self.directory / "journal.sqlite3").exists())


class RoadmapTests(unittest.TestCase):
    def setUp(self):
        self.config = copy.deepcopy(CONFIG)
        self.config["milestone_discovery"]["enabled"] = True

    def test_discovers_new_trusted_scoped_milestones_without_config_changes(self):
        from unittest.mock import Mock
        github = Mock(prefix="repos/ColdPhase/flux")
        github.pages.return_value = [milestone(1), milestone(2, PEER["github_login"]),
                                    milestone(3, "outsider"), milestone(4, scope="another-project")]
        self.assertEqual(milestone_numbers(github, self.config), [1, 2])
        self.assertEqual(len(self.config["additional_milestones"]), 0)

    def test_marker_alone_does_not_authorize_an_outside_creator(self):
        with self.assertRaisesRegex(HarnessError, "trusted creator"):
            scope_check(self.config, milestone(3, "outsider"))

    def test_agent_can_refine_its_milestone_without_a_founder_digest_update(self):
        item = milestone(1)
        item["description"] += "\nAgreed next coding task and evidence."
        scope_check(self.config, item)

    def test_snapshots_include_dependencies_and_prs_across_milestones(self):
        from unittest.mock import Mock
        github = Mock(prefix="repos/ColdPhase/flux")
        github.pages.return_value = [milestone(1), milestone(2)]
        github.snapshot.side_effect = [
            {"milestone": milestone(1), "issues": [issue(8)], "pull_requests": [{"number": 10}]},
            {"milestone": milestone(2), "issues": [issue(9)], "pull_requests": [{"number": 10}]}]
        combined = read_snapshot(github, self.config)
        self.assertEqual([item["number"] for item in combined["issues"]], [8, 9])
        self.assertEqual(combined["pull_requests"], [{"number": 10}])

    def accepted_snapshot(self):
        data = snapshot(issue(20))
        data["milestone"]["state"] = "closed"
        data["milestones"] = [data["milestone"]]
        task = data["issues"][0]
        task.update(state="closed", state_reason="completed", labels=[{"name": "agent:product-acceptance"}])
        record = {"scope": "flux-full-product", "candidate_sha": "a" * 40,
                  "areas": {f"8.{i}": "pass" for i in range(1, 17)},
                  "evidence": ["https://github.com/ColdPhase/flux/releases/tag/v1.0.0"],
                  "application_checks": ["Final application verification"]}
        task["comments"] = [{"user": {"login": worker["github_login"]},
            "body": '<!-- flux-product-accepted:v1\n' + json.dumps(record) + '\n-->'}
            for worker in (WORKER, PEER)]
        return data

    def test_completion_needs_both_authors_all_areas_and_closed_work(self):
        data = self.accepted_snapshot()
        self.assertEqual(accepted_product(data, self.config)["candidate_sha"], "a" * 40)
        data["issues"].append(issue(21))
        self.assertIsNone(accepted_product(data, self.config))
        data = self.accepted_snapshot()
        data["issues"][0]["comments"].pop()
        self.assertIsNone(accepted_product(data, self.config))
        data = self.accepted_snapshot()
        data["issues"][0]["comments"][1]["body"] = data["issues"][0]["comments"][1]["body"].replace('"8.16": "pass"', '"8.16": "unknown"')
        self.assertIsNone(accepted_product(data, self.config))

    def test_newer_peer_rejection_or_harness_only_checks_cannot_count_as_done(self):
        data = self.accepted_snapshot()
        rejection = copy.deepcopy(data["issues"][0]["comments"][1])
        rejection["body"] = rejection["body"].replace('"8.1": "pass"', '"8.1": "fail"')
        data["issues"][0]["comments"].append(rejection)
        self.assertIsNone(accepted_product(data, self.config))
        data = self.accepted_snapshot()
        for comment in data["issues"][0]["comments"]:
            comment["body"] = comment["body"].replace("Final application verification", "Agent setup")
        self.assertIsNone(accepted_product(data, self.config))

    def test_stale_candidate_or_failed_latest_check_blocks_final_acceptance(self):
        from unittest.mock import Mock
        github = Mock(prefix="repos/ColdPhase/flux")
        acceptance = accepted_product(self.accepted_snapshot(), self.config)
        github.api.return_value = {"sha": "b" * 40}
        with self.assertRaisesRegex(HarnessError, "stale"):
            verify_product_ci(github, self.config, acceptance)
        github.api.return_value = {"sha": "a" * 40}
        passed = {"id": 1, "name": "Final application verification", "head_sha": "a" * 40,
                  "status": "completed", "conclusion": "success", "app": {"slug": "github-actions"}}
        github.pages.return_value = [passed]
        verify_product_ci(github, self.config, acceptance)
        github.pages.return_value = [passed, {**passed, "id": 2, "conclusion": "failure"}]
        with self.assertRaisesRegex(HarnessError, "application checks"):
            verify_product_ci(github, self.config, acceptance)


class ResumeAndContinuationTests(LoopFixture):
    def test_drain_finishes_one_checkpoint_and_starts_no_next_turn(self):
        data = snapshot(issue(1))

        def provider(name, root, cwd, turn, prompt, deadline, tick, session, options, idle_timeout=None):
            (self.repo / ".harness/local" / WORKER["id"] / "drain.request").touch()
            return result("progress", 1), "fixture"

        with patch("flux_harness.worker.configuration", return_value=(self.config, WORKER)), \
                patch("flux_harness.worker.preflight", return_value={"revision": self.revision, "execution_configured": True}), \
                patch("flux_harness.worker.GitHub") as github, \
                patch("flux_harness.worker.run_provider", side_effect=provider) as provider_call:
            github.return_value.snapshot.return_value = data
            self.assertEqual(run(self.repo, WORKER["id"]), 0)
            provider_call.assert_called_once()
        state = State(self.repo / ".harness/local" / WORKER["id"])
        try:
            self.assertEqual(state.get("status"), "stopped-at-checkpoint")
            self.assertIsNone(state.get("active_turn"))
            self.assertEqual(state.get("last_result")["task"], 1)
        finally:
            state.close()

    def test_closed_milestones_without_product_evidence_do_not_end_the_goal(self):
        data = snapshot()
        data["milestone"]["state"] = "closed"
        with patch("flux_harness.worker.configuration", return_value=(self.config, WORKER)), \
                patch("flux_harness.worker.preflight", return_value={"revision": self.revision, "execution_configured": True}), \
                patch("flux_harness.worker.GitHub") as github, \
                patch("flux_harness.worker.run_provider", return_value=(result("waiting", None), "fixture")) as provider:
            github.return_value.snapshot.return_value = data
            self.assertEqual(run(self.repo, WORKER["id"], once=True), 0)
            provider.assert_called_once()
            self.assertIn('"bootstrap": true', provider.call_args.args[4])

    def test_restart_recovers_newer_claim_and_preserves_uncommitted_files(self):
        directory = self.repo / ".harness/local" / WORKER["id"]
        path = workspace(self.repo, directory, self.revision)
        (path / "unfinished.txt").write_text("Saved before stop")
        state = State(directory)
        state.set("last_result", result("waiting", 9))
        state.begin("interrupted-turn", "old snapshot")
        state.set("execution_options", {"model": "gpt-6-sol", "reasoning_effort": "high"})
        state.close()
        data = snapshot(issue(8), issue(9))
        data["issues"][0]["comments"] = [{"id": 100, "user": {"login": WORKER["github_login"]},
            "body": '<!-- flux-agent:v1\n' + json.dumps({"worker": WORKER["id"], "task": 8,
                "kind": "claim", "role": "implementation"}) + '\n-->'}]

        def provider(name, root, cwd, turn, prompt, deadline, tick, session, options, idle_timeout=None):
            self.assertIn('"resume_issue_numbers": [8]', prompt)
            self.assertIn("unfinished.txt", prompt)
            self.assertEqual((path / "unfinished.txt").read_text(), "Saved before stop")
            self.assertEqual(options, {"model": "gpt-6-sol", "reasoning_effort": "high"})
            return result("progress", 8), "resumed"

        with patch("flux_harness.worker.configuration", return_value=(self.config, WORKER)), \
                patch("flux_harness.worker.preflight", return_value={"revision": self.revision, "execution_configured": True}), \
                patch("flux_harness.worker.GitHub") as github, \
                patch("flux_harness.worker.run_provider", side_effect=provider):
            github.return_value.snapshot.return_value = data
            self.assertEqual(run(self.repo, WORKER["id"], once=True), 0)

    def test_closed_planning_milestone_does_not_stop_ready_implementation(self):
        second = {**self.config["milestone"], "number": 2}
        self.config["additional_milestones"] = [second]
        first_data = snapshot()
        first_data["milestone"]["state"] = "closed"
        second_data = snapshot(issue(22))
        second_data["milestone"]["number"] = 2
        second_data["issues"][0]["milestone"] = {"number": 2}
        with patch("flux_harness.worker.configuration", return_value=(self.config, WORKER)), \
                patch("flux_harness.worker.preflight", return_value={"revision": self.revision, "execution_configured": True}), \
                patch("flux_harness.worker.GitHub") as github, \
                patch("flux_harness.worker.run_provider", return_value=(result("progress", 22), "fixture")) as provider:
            github.return_value.snapshot.side_effect = lambda number: copy.deepcopy(first_data if number == 1 else second_data)
            self.assertEqual(run(self.repo, WORKER["id"], once=True), 0)
            provider.assert_called_once()
            self.assertIn('"eligible_issue_numbers": [22]', provider.call_args.args[4])


if __name__ == "__main__":
    unittest.main()
