"""Paired outage, provider stall and token-free idle behavior, without live models."""

import copy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import time
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from flux_harness.github import GitHub, HarnessError
from flux_harness.presence import MARKER, PeerGuard, PeerUnavailable, record
from flux_harness.providers import run_provider
from flux_harness.roadmap import read_snapshot
from flux_harness.state import State
from flux_harness.worker import run
from test_harness import CONFIG, WORKER, PEER, TempTest, LoopFixture, issue, result, snapshot


class PresenceAPI:
    """Shared server with real authors and server update timestamps."""
    prefix = "repos/ColdPhase/flux"

    def __init__(self, comments, login):
        self.records, self.login = comments, login
        self.before_request = None
        self.deadline = None
        self.failure = False
        self.writes = 0

    def comments(self, number):
        if self.failure:
            raise HarnessError("GitHub offline")
        return copy.deepcopy(self.records)

    def api(self, endpoint, method="GET", data=None):
        if self.failure:
            raise HarnessError("GitHub offline")
        if method == "GET":
            return {"milestone": None}
        self.writes += 1
        if method == "POST":
            target = {"id": len(self.records) + 1, "user": {"login": self.login}}
            self.records.append(target)
        else:
            target = next(item for item in self.records if item["id"] == int(endpoint.rsplit("/", 1)[-1]))
        target.update(body=data["body"], updated_at=datetime.now(timezone.utc).isoformat())
        return copy.deepcopy(target)


class PresenceTests(TempTest):
    def setUp(self):
        super().setUp()
        self.records = []
        self.states, self.guards = [], []
        for worker in (WORKER, PEER):
            state = State(self.directory / worker["id"])
            self.addCleanup(state.close)
            self.states.append(state)
            self.guards.append(PeerGuard(PresenceAPI(self.records, worker["github_login"]), CONFIG, worker, state))
        self.owner, self.peer = self.guards

    def ready_pair(self):
        self.assertIsNotNone(self.owner.start())
        self.assertIsNone(self.peer.start())
        self.assertIsNone(self.owner.poll("working", force=True))

    def test_two_workers_rendezvous_and_update_only_two_comments(self):
        self.ready_pair()
        for _ in range(4):
            self.peer.poll("waiting", force=True)
            self.owner.poll("working", force=True)
        self.assertEqual(len(self.records), 2)
        self.assertEqual(self.states[0].get("peer_presence")["status"], "waiting")

    def test_missing_or_forged_peer_never_establishes_presence(self):
        self.owner.start()
        forged = copy.deepcopy(self.records[0])
        data = record(forged)
        data["worker"] = PEER["id"]
        forged.update(id=99, user={"login": "outsider"}, body=MARKER + json.dumps(data) + "\n-->")
        self.records.append(forged)
        with self.assertRaisesRegex(PeerUnavailable, "No authenticated"):
            self.owner.check()

    def test_expired_future_invalid_and_terminal_peer_are_unavailable(self):
        self.ready_pair()
        original = copy.deepcopy(self.records[1])
        for update in ({"updated_at": "2000-01-01T00:00:00Z"},
                       {"updated_at": "2999-01-01T00:00:00Z"}, {"updated_at": "bad"},
                       {"body": MARKER + "bad JSON\n-->"}):
            self.records[1] = {**original, **update}
            self.owner.last_poll = float("-inf")
            with self.assertRaises(PeerUnavailable):
                self.owner.check()
        self.records[1] = original
        self.peer.close("suspended")
        self.owner.last_poll = float("-inf")
        with self.assertRaisesRegex(PeerUnavailable, "stopped, suspended"):
            self.owner.check()

    def test_mismatched_configuration_and_duplicate_presence_fail_closed(self):
        self.ready_pair()
        original = copy.deepcopy(self.records[1])
        data = record(original)
        data["config_digest"] = "another-version"
        self.records[1]["body"] = MARKER + json.dumps(data) + "\n-->"
        self.owner.last_poll = float("-inf")
        with self.assertRaisesRegex(PeerUnavailable, "configuration"):
            self.owner.check()
        self.records[1] = original
        self.records.append({**original, "id": 3})
        self.owner.last_poll = float("-inf")
        with self.assertRaisesRegex(PeerUnavailable, "Multiple presence"):
            self.owner.check()

    def test_transport_failure_stops_execution_and_close_is_best_effort(self):
        self.ready_pair()
        self.owner.github.failure = True
        self.owner.last_poll = float("-inf")
        with self.assertRaisesRegex(HarnessError, "offline"):
            self.owner.check()
        self.owner.close("suspended")

    def test_restart_reuses_comment_and_previous_run_cannot_overwrite_it(self):
        self.ready_pair()
        fresh = PeerGuard(self.owner.github, CONFIG, WORKER, self.states[0])
        fresh.start()
        self.assertEqual(len(self.records), 2)
        self.owner.last_poll = float("-inf")
        with self.assertRaisesRegex(PeerUnavailable, "replaced"):
            self.owner.check()
        self.owner.close("suspended")
        self.assertEqual(record(self.records[0])["run_id"], fresh.run_id)

    def test_heartbeat_polling_is_throttled(self):
        self.ready_pair()
        before = self.owner.github.writes
        for _ in range(100):
            self.owner.check()
        self.assertEqual(self.owner.github.writes, before)

    def test_failure_propagates_to_both_workers(self):
        for index in (0, 1):
            with self.subTest(failed_worker=index):
                self.records.clear()
                for guard in self.guards:
                    guard.comment_id = None
                self.ready_pair()
                failed, remaining = self.guards[index], self.guards[1 - index]
                failed.close("suspended")
                remaining.last_poll = float("-inf")
                with self.assertRaises(PeerUnavailable):
                    remaining.check()
                remaining.close("suspended")
                self.assertTrue(all(record(item)["status"] == "suspended" for item in self.records))

    def test_presence_issue_is_excluded_from_work_even_if_milestoned(self):
        data = snapshot(issue(1), issue(CONFIG["peer_watch"]["issue_number"]))
        with patch.object(self.owner.github, "snapshot", create=True, return_value=data):
            data["milestone"]["description"] = "fixture"
            config = copy.deepcopy(CONFIG)
            from flux_harness.github import digest
            config["milestone"]["description_digest"] = digest("fixture")
            combined = read_snapshot(self.owner.github, config)
            self.assertEqual([item["number"] for item in combined["issues"]], [1])

    def test_transport_guard_runs_before_each_inbox_request(self):
        github = GitHub("ColdPhase/flux", self.directory)
        github.before_request = lambda: (_ for _ in ()).throw(PeerUnavailable("Peer offline"))
        with patch("flux_harness.github.command") as command:
            with self.assertRaises(PeerUnavailable):
                github.api("repos/ColdPhase/flux/issues")
            command.assert_not_called()


class PairedLoopTests(LoopFixture):
    def invoke(self, data, provider=None, wait=None, once=False):
        with patch("flux_harness.worker.configuration", return_value=(self.config, WORKER)), \
                patch("flux_harness.worker.preflight", return_value={"revision": self.revision, "execution_configured": True}), \
                patch("flux_harness.worker.GitHub") as github, \
                patch("flux_harness.worker.run_provider", side_effect=provider) as calls, \
                patch("flux_harness.worker.wait_until", side_effect=wait):
            def read(number):
                value = copy.deepcopy(data)
                value["milestone"]["number"] = number
                if number != self.config["milestone"]["number"]:
                    value["issues"] = []
                return value
            github.return_value.snapshot.side_effect = read
            self.calls = calls
            return run(self.repo, WORKER["id"], once=once)

    def test_absent_peer_at_start_makes_zero_model_calls(self):
        self.guard.start.return_value = "Peer not running"
        with self.assertRaisesRegex(PeerUnavailable, "startup grace"):
            self.invoke(snapshot(issue(1)), once=True)
        self.calls.assert_not_called()
        self.guard.close.assert_called_with("suspended")

    def test_startup_grace_expires_without_tokens(self):
        self.guard.start.return_value = "Peer not running"
        self.guard.poll.return_value = "Peer not running"
        self.config["peer_watch"]["startup_wait_seconds"] = 0.001
        with self.assertRaisesRegex(PeerUnavailable, "startup grace"):
            self.invoke(snapshot(issue(1)), wait=lambda *args: time.sleep(0.005))
        self.calls.assert_not_called()

    def test_startup_waits_for_peer_before_invoking_model(self):
        self.guard.start.return_value = "Peer not running"
        self.guard.poll.return_value = None
        self.config["limits"]["max_turns"] = 1
        self.invoke(snapshot(issue(1)), provider=lambda *args, **kwargs: (result("waiting", 1), None))
        self.calls.assert_called_once()
        self.guard.poll.assert_called_with("ready", force=True)

    def test_peer_loss_interrupts_turn_preserves_artifact_and_prevents_next_model(self):
        saved = self.repo / ".harness/local" / WORKER["id"] / "saved.txt"

        def provider(*args, **kwargs):
            saved.write_text("uncommitted work")
            self.guard.check.side_effect = PeerUnavailable("Peer stopped")
            args[6]()  # Provider's interruptible tick.

        with self.assertRaisesRegex(PeerUnavailable, "Peer stopped"):
            self.invoke(snapshot(issue(1)), provider=provider)
        self.calls.assert_called_once()
        self.assertEqual(saved.read_text(), "uncommitted work")
        state = State(saved.parent)
        try:
            self.assertEqual(state.get("status"), "peer-unavailable")
            self.assertIsNotNone(state.get("active_turn"))
            self.assertIsNone(state.get("run_pid"))
        finally:
            state.close()
        self.guard.close.assert_called_with("suspended")

    def test_idle_poll_also_stops_when_peer_disappears(self):
        data = snapshot()
        self.config["loop"]["coordinator"] = PEER["id"]

        def wait(deadline, stop, interrupted, tick):
            self.guard.check.side_effect = PeerUnavailable("Peer stopped while idle")
            tick()

        with self.assertRaisesRegex(PeerUnavailable, "idle"):
            self.invoke(data, wait=wait)
        self.calls.assert_not_called()

    def test_provider_failure_publishes_suspension(self):
        with self.assertRaisesRegex(HarnessError, "quota"):
            self.invoke(snapshot(issue(1)), provider=HarnessError("Provider quota exhausted"))
        self.calls.assert_called_once()
        self.guard.close.assert_called_with("suspended")

    def test_empty_next_milestone_does_not_repeat_parked_planning(self):
        self.config["additional_milestones"] = [{**self.config["milestone"], "number": 2}]
        data = snapshot(issue(1))

        def wait(*args):
            raise HarnessError("Test ended at token-free idle")

        with self.assertRaisesRegex(HarnessError, "token-free idle"):
            self.invoke(data, provider=lambda *args, **kwargs: (result("waiting", 1), None), wait=wait)
        self.calls.assert_called_once()
        state = State(self.repo / ".harness/local" / WORKER["id"])
        try:
            self.assertIsNotNone(state.get("bootstrap_digest"))
        finally:
            state.close()


class ProviderStallTests(TempTest):
    def test_silent_provider_is_terminated_and_turn_files_survive(self):
        executable = self.directory / "claude"
        executable.write_text("#!/usr/bin/env python3\nimport time\ntime.sleep(60)\n")
        executable.chmod(0o700)
        with patch.dict(os.environ, {"PATH": str(self.directory) + os.pathsep + os.environ["PATH"]}):
            with self.assertRaisesRegex(HarnessError, "stalled"):
                run_provider("claude", self.directory, self.directory, self.directory / "turn", "fixture",
                             time.monotonic() + 10, lambda: None, idle_timeout=0.1)
        self.assertTrue((self.directory / "turn/prompt.txt").exists())

    def test_activity_resets_idle_deadline_and_success_is_retained(self):
        executable = self.directory / "claude"
        payload = {"type": "result", "session_id": "fixture", "structured_output": result()}
        program = "#!/usr/bin/env python3\nimport json, time\n"
        program += "for i in range(4):\n print(json.dumps({'type':'assistant', 'n':i}), flush=True)\n time.sleep(0.3)\n"
        program += "print(" + repr(json.dumps(payload)) + ", flush=True)\n"
        executable.write_text(program)
        executable.chmod(0o700)
        with patch.dict(os.environ, {"PATH": str(self.directory) + os.pathsep + os.environ["PATH"]}):
            actual, _ = run_provider("claude", self.directory, self.directory, self.directory / "turn", "fixture",
                                    time.monotonic() + 10, lambda: None, idle_timeout=0.8)
        self.assertEqual(actual, result())
