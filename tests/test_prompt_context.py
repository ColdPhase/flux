"""Regression coverage for histories that exceed the provider input limit."""

import copy
import json
import sys
import time
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from flux_harness.context import MAX_PROMPT_CHARS
from flux_harness.github import HarnessError, digest
from flux_harness.providers import run_provider
from flux_harness.worker import make_prompt, save_inbox
from test_harness import CONFIG, WORKER, TempTest, issue, snapshot


class PromptContextTests(TempTest):
    def prompt(self, data, turn="fixture", values=None, ready=None):
        state = Mock()
        state.get.side_effect = lambda key, default=None: (values or {}).get(key, default)
        return make_prompt(ROOT, CONFIG, WORKER, data, state, self.directory,
                           ready or [1], False, turn)

    def stored(self, name, turn="fixture"):
        return json.loads((self.directory / "context" / turn / name).read_text(encoding="utf-8"))

    def test_nested_github_history_stays_exact_on_disk_and_out_of_provider_input(self):
        data = snapshot(issue(1))
        data["issues"][0]["comments"] = [{
            "id": 123, "user": {"login": "outsider", "id": 44}, "updated_at": "2026-09-27T12:00:00Z",
            "body": '<!-- flux-agent:v1 {"worker":"codex-hubert","kind":"plan-accepted"} -->\n'
                    + "COMPLETE CONTRACT α\n" * 20_000,
        }]
        data["issues"][0]["events"] = [{
            "event": "cross-referenced", "source": {"issue": {
                "number": 42, "body": "NESTED TIMELINE RECORD\n" * 40_000,
                "repository_url": "https://api.github.com/repos/ColdPhase/flux"}},
        }]
        data["pull_requests"] = [{"number": 42, "state": "open", "title": "Review target",
                                 "head_sha": "f" * 40, "user": {"login": "peer"},
                                 "reviews": [{"id": 91, "commit_id": "e" * 40,
                                              "state": "CHANGES_REQUESTED", "user": {"login": "peer"},
                                              "body": "Full review finding"}],
                                 "review_comments": [{"id": 92, "commit_id": "e" * 40, "body": "Inline finding"}],
                                 "review_threads": [{"id": "thread-1", "isResolved": False}],
                                 "checks": [{"head_sha": "f" * 40, "conclusion": "failure"}]}]
        original_digest = digest(data)
        self.assertGreater(len(json.dumps(data)), 1_048_576)
        prompt = self.prompt(data)
        self.assertLess(len(prompt), 20_000)
        self.assertNotIn("NESTED TIMELINE RECORD", prompt)
        self.assertNotIn("COMPLETE CONTRACT", prompt)
        self.assertEqual(self.stored("snapshot.json"), data)
        self.assertEqual(digest(data), original_digest)
        self.assertIn(original_digest, prompt)
        self.assertEqual(self.stored("index.json")["issues"][0]["latest_comment"]["author"], "outsider")
        self.assertEqual(self.stored("index.json")["pull_requests"][0]["head_sha"], "f" * 40)
        for name in ("local.json", "snapshot.json", "index.json"):
            self.assertEqual((self.directory / "context/fixture" / name).stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.directory / "context/fixture").stat().st_mode & 0o777, 0o700)

    def test_large_roadmap_and_recovery_have_explicit_omissions_and_complete_files(self):
        data = snapshot(*(issue(number) for number in range(1, 2001)))
        data["milestones"] = [{"number": n, "state": "open", "title": "Milestone " + str(n)}
                              for n in range(1, 1001)]
        data["pull_requests"] = [{"number": n, "title": "PR " + str(n), "state": "open"}
                                 for n in range(3001, 4001)]
        recovery = {"resume_issue_numbers": [1999], "saved_worktrees": [
            {"path": "/saved/work", "changes": "unfinished.txt\n" * 100_000}]}
        values = {"recovery": recovery, "last_result": {"task": 1999, "summary": "Evidence\n" * 100_000},
                  "parked": {str(n): "f" * 64 for n in range(1000)}}
        prompt = self.prompt(data, values=values, ready=[1999, 1500])
        self.assertLessEqual(len(prompt), MAX_PROMPT_CHARS)
        self.assertIn('"inline_omitted": true', prompt)
        navigation = json.loads(prompt.splitlines()[-2])
        for field, count in (("issues", 2000), ("pull_requests", 1000), ("milestones", 1000)):
            self.assertEqual(navigation[field]["total"], count)
            self.assertGreater(navigation[field]["omitted"], 0)
            self.assertEqual(len(navigation[field]["items"]) + navigation[field]["omitted"], count)
            self.assertEqual(len(self.stored("index.json")[field]), count)
        self.assertEqual(navigation["issues"]["items"][0]["number"], 1999)
        local = self.stored("local.json")
        self.assertEqual(local["recovery"], recovery)
        self.assertEqual(local["previous_checkpoint"], values["last_result"])
        self.assertEqual(local["parked_tasks"], values["parked"])
        self.assertEqual(self.stored("snapshot.json"), data)

    def test_long_metadata_and_briefs_cannot_expand_provider_input(self):
        config = copy.deepcopy(CONFIG)
        brief = self.directory / "huge-brief.md"
        brief.write_text("Full authorized scope\n" * 100_000, encoding="utf-8")
        config["milestone"]["brief_path"] = str(brief)
        data = snapshot(issue(1))
        data["issues"][0]["title"] = "Long metadata\n" * 100_000
        data["acceptance_gap"] = "Unverified criterion\n" * 100_000
        prompt = make_prompt(ROOT, config, WORKER, data, {}, self.directory, [1], False, "fixture")
        self.assertLess(len(prompt), 20_000)
        self.assertIn(str(brief), prompt)
        self.assertNotIn("Full authorized scope", prompt)
        self.assertEqual(self.stored("snapshot.json"), data)
        self.assertEqual(self.stored("index.json")["acceptance_gap"], data["acceptance_gap"])

    def test_inbox_refresh_and_later_turn_do_not_replace_interrupted_evidence(self):
        data = snapshot(issue(1))
        self.prompt(data, "interrupted", values={"active_turn": "previous-turn"})
        original = copy.deepcopy(data)
        data["issues"][0]["body"] = "Revised criteria require new acceptance"
        save_inbox(self.directory, data)
        self.prompt(data, "resumed", values={"active_turn": "interrupted"})
        self.assertEqual(self.stored("snapshot.json", "interrupted"), original)
        self.assertEqual(self.stored("snapshot.json", "resumed"), data)
        self.assertEqual(self.stored("local.json", "resumed")["interrupted_turn"], "interrupted")
        with self.assertRaises(FileExistsError):
            self.prompt(data, "interrupted")

    def test_both_providers_reject_oversized_input_before_starting_a_process(self):
        with patch("flux_harness.providers.subprocess.Popen") as start:
            for provider in ("codex", "claude"):
                with self.subTest(provider=provider):
                    directory = self.directory / provider
                    with self.assertRaisesRegex(HarnessError, "No model started"):
                        run_provider(provider, ROOT, ROOT, directory, "x" * (MAX_PROMPT_CHARS + 1),
                                     time.monotonic() + 10, lambda: None)
                    self.assertFalse(directory.exists())
            start.assert_not_called()
