"""The packaged smoke's upgrade leg refuses a bad previous release before any image is pulled (#77),
its content check reports exactly what differs, its encrypted space belongs to the company (#1180), and the upgrade
matrix's richer content (#1241) is checked field by field."""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "release" / "smoke_artifacts.sh"
sys.path.insert(0, str(ROOT / "scripts" / "release"))
from smoke_data import PROJECT_NAME, WORKSPACE_NAME, check, check_more, check_next_times, seed_vault  # noqa: E402

POSTGRES = "postgres@sha256:" + "f" * 64
STUB = """#!/bin/sh
echo "$*" >> "$STUB_LOG"
exit 99
"""


def write_assets(directory: Path, image_digest: str, postgres: str = POSTGRES, sums: bool = True) -> Path:
    directory.mkdir()
    (directory / "compose.yaml").write_text(
        f"services:\n  db:\n    image: {postgres}\n  api:\n    image: ghcr.io/coldphase/flux@{image_digest}\n",
        encoding="utf-8",
    )
    (directory / "env.example").write_text(
        "POSTGRES_PASSWORD=\nFLUX_AUTH_SECRET=\nFLUX_KEYRING_TOKEN=\nFLUX_KEY_PIN_SECRET=\nFLUX_PUBLIC_ORIGIN=http://127.0.0.1:8081\n", encoding="utf-8"
    )
    (directory / "release.json").write_text(
        json.dumps({"version": "v0.1.0-rc.1", "image": f"ghcr.io/coldphase/flux@{image_digest}"}), encoding="utf-8"
    )
    if sums:
        lines = [
            f"{hashlib.sha256((directory / name).read_bytes()).hexdigest()}  {name}\n"
            for name in ("compose.yaml", "env.example", "release.json")
        ]
        (directory / "SHA256SUMS").write_text("".join(lines), encoding="utf-8")
    return directory


class StubbedDocker(unittest.TestCase):
    """A script run with a docker that records its arguments and fails; the subclasses add the tests."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        (self.dir / "bin").mkdir()
        stub = self.dir / "bin" / "docker"
        stub.write_text(STUB)
        stub.chmod(0o755)
        self.log = self.dir / "docker.log"
        self.candidate = write_assets(self.dir / "candidate", "sha256:" + "b" * 64)


class UpgradeLegRefusalTest(StubbedDocker):
    def run_script(self, previous: Path | str | None) -> subprocess.CompletedProcess[str]:
        env = dict(os.environ, STUB_LOG=str(self.log), PATH=f"{self.dir / 'bin'}{os.pathsep}{os.environ['PATH']}")
        env.pop("FLUX_SMOKE_PREVIOUS_ASSETS", None)
        if previous is not None:
            env["FLUX_SMOKE_PREVIOUS_ASSETS"] = str(previous)
        return subprocess.run(
            ["bash", str(SCRIPT), str(self.candidate), str(self.dir / "state"), "projectsrc", "projectrst"],
            env=env, capture_output=True, text=True,
        )

    def assert_refused(self, result: subprocess.CompletedProcess[str], message: str) -> None:
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(message, result.stderr)
        self.assertFalse(self.log.exists(), "docker must not be called before the previous release is accepted")

    def test_previous_must_be_a_directory(self) -> None:
        self.assert_refused(self.run_script(self.dir / "missing"), "is not a directory")

    def test_previous_needs_its_checksums(self) -> None:
        previous = write_assets(self.dir / "previous", "sha256:" + "a" * 64, sums=False)
        self.assert_refused(self.run_script(previous), "has no SHA256SUMS")

    def test_previous_must_match_its_checksums(self) -> None:
        previous = write_assets(self.dir / "previous", "sha256:" + "a" * 64)
        (previous / "compose.yaml").write_text("# edited\n", encoding="utf-8")
        self.assert_refused(self.run_script(previous), "do not match its SHA256SUMS")

    def test_previous_cannot_be_the_candidate(self) -> None:
        previous = write_assets(self.dir / "previous", "sha256:" + "b" * 64)
        self.assert_refused(self.run_script(previous), "pin the same image")

    def test_previous_must_pin_a_database_image(self) -> None:
        previous = write_assets(self.dir / "previous", "sha256:" + "a" * 64, postgres="postgres:18")
        self.assert_refused(self.run_script(previous), "pins no database image")

    def test_a_changed_database_image_reaches_the_upgrade(self) -> None:
        # v0.2.1 moves from the official PostgreSQL image to Flux's own (F-042): the major is checked on the upgraded data, not refused.
        previous = write_assets(self.dir / "previous", "sha256:" + "a" * 64, postgres="postgres@sha256:" + "e" * 64)
        result = self.run_script(previous)
        self.assertNotEqual(result.returncode, 0)  # the stub docker fails the first compose call
        self.assertIn("the database image changes", result.stdout)
        self.assertTrue(self.log.exists())

    def test_without_a_previous_release_the_clean_install_leg_starts_unchanged(self) -> None:
        result = self.run_script(None)
        self.assertNotEqual(result.returncode, 0)  # the stub docker fails the first compose call
        self.assertEqual(self.log.read_text().splitlines()[0].split()[:2], ["compose", "--env-file"])
        self.assertIn("config --quiet", self.log.read_text().splitlines()[0])

    def test_a_valid_previous_release_passes_the_checks_and_reaches_docker(self) -> None:
        previous = write_assets(self.dir / "previous", "sha256:" + "a" * 64)
        result = self.run_script(previous)
        self.assertNotEqual(result.returncode, 0)  # the stub docker fails the first compose call, as above
        self.assertNotIn("previous release", result.stderr)
        self.assertTrue(self.log.exists())


class ContentCheckTest(unittest.TestCase):
    state = {
        "project_id": "p1", "messages": [[1, "first"], [2, "second"]], "file_hex": "00ff",
        "doc_versions": [[1, "draft", "Created"], [2, "published", "Second version"]],
        "work_title": "work", "note_id": "n1", "note_title": "note",
    }

    def observed(self, **changes: object) -> dict[str, object]:
        value: dict[str, object] = {
            "workspace_name": WORKSPACE_NAME, "project_names": {"p1": PROJECT_NAME},
            "messages": [[1, "first"], [2, "second"]], "file_hex": "00ff",
            "doc_versions": [[1, "draft", "Created"], [2, "published", "Second version"]],
            "work_title": "work", "note_titles": {"n1": "note"},
        }
        value.update(changes)
        return value

    def test_equal_content_has_no_problems(self) -> None:
        self.assertEqual(check(self.state, self.observed()), [])

    def test_a_message_written_later_is_not_a_problem(self) -> None:
        later = [[1, "first"], [2, "second"], [3, "written after the upgrade"]]
        self.assertEqual(check(self.state, self.observed(messages=later)), [])

    def test_each_lost_item_is_named(self) -> None:
        problems = check(self.state, self.observed(
            workspace_name="x", project_names={}, messages=[[1, "first"]], file_hex="00",
            doc_versions=[[1, "draft", "Created"]], work_title="y", note_titles={},
        ))
        self.assertEqual(len(problems), 7, problems)


class FakeClient:
    """The calls `seed_vault` makes, recording what it sends."""

    def __init__(self) -> None:
        self.created: list[dict] = []
        self.calls: list[tuple[str, str]] = []

    def expect(self, method: str, path: str, body: dict | None = None, statuses: tuple[int, ...] = (200, 201), headers: dict | None = None):
        self.calls.append((method, path))
        if (method, path) == ("POST", "/api/v1/encrypted-workspaces"):
            self.created.append(body)
            return {"recoveryCode": "AAAA-BBBB", "workspace": {"id": "enc"}, "project": {"id": "space"}}
        if (method, path) == ("POST", "/api/v1/projects/space/conversations"):
            return {"id": "thread"}
        if (method, path) == ("POST", "/api/v1/workspaces/enc/lock"):
            return {}
        raise AssertionError(f"unexpected call {method} {path}")


class EncryptedSpaceTest(unittest.TestCase):
    def test_the_encrypted_space_is_made_for_the_company_written_to_and_locked(self) -> None:
        client = FakeClient()
        vault = seed_vault(client, "company-1", "abcd")  # type: ignore[arg-type]
        self.assertEqual([body["companyId"] for body in client.created], ["company-1"])
        self.assertEqual(client.calls[-1], ("POST", "/api/v1/workspaces/enc/lock"))
        self.assertEqual((vault["workspace_id"], vault["project_id"], vault["thread_id"]), ("enc", "space", "thread"))
        self.assertTrue(vault["password"])


def recorded_more() -> dict:
    return {
        "ben": {"id": "u-ben", "name": "Ben", "role": "member"}, "gina": {"id": "u-gina", "name": "Gina", "role": "guest"},
        "garden_id": "g1", "garden_file_hex": "0900", "garden_video_sha256": "c1ip", "garden_messages": [[1, "u-ada", "root"], [2, "u-ben", "hi"]],
        "dm_bodies": ["hello", "reply"], "group_bodies": ["all"], "group_title": "Crew",
        "wiki_title": "Wiki", "wiki_versions": [[2, "Edited the text"], [1, "Started the page"]],
        "map_thoughts": [["Soil", 10, 10]], "map_links": [["Soil", "Water", "needs"]],
        "tasks": [{"id": "t1", "title": "Calibrate", "status": "open", "dueOn": "2027-03-01", "owner": "u-ben", "waitingOn": None, "waitingFor": None},
                  {"id": "t2", "title": "Ship", "status": "blocked", "dueOn": "2027-03-15", "owner": None, "waitingOn": "t1", "waitingFor": None}],
        "second_task_depends_on": "t1",
        "notifications": {"level": "everything", "emailMe": True, "quiet": ["22:00", "07:00", "Europe/Warsaw"], "muted": ["g1"]},
        "vault": {"message": "VAULT-secret"},
        "ai": {
            "connection_name": "Mock key", "model": "listed-model", "key_last_four": "a33f", "daily_budget_cents": 500, "agent_name": "Planner", "instructions": "Plan.",
            "memory": ["north side", "water Mondays"], "weekly_words": "Every Monday at 9:00", "off_words": "Every day at 7:30",
        },
    }


def observed_more(**changes: object) -> dict:
    value: dict = {
        "people": {"u-ben": "member", "u-gina": "guest"}, "guest_spaces": ["g1"], "guest_denied": True,
        "garden_messages": [[1, "u-ada", "root"], [2, "u-ben", "hi"], [3, "u-gina", "written later"]], "garden_file_hex": "0900", "garden_video_sha256": "c1ip",
        "dm_bodies": ["hello", "reply", "later"], "group_bodies": ["all"], "group_title": "Crew",
        "wiki_versions": [[3, "Edited the text"], [2, "Edited the text"], [1, "Started the page"]],
        "wiki_bodies": {1: "Wiki-v1", 2: "Wiki-v2", 3: "Wiki-v3"},
        "map_thoughts": [["Soil", 10, 10]], "map_links": [["Soil", "Water", "needs"]],
        "tasks": {"t1": {"title": "Calibrate", "status": "open", "dueOn": "2027-03-01", "owner": "u-ben", "waitingOn": None, "waitingFor": None},
                  "t2": {"title": "Ship", "status": "blocked", "dueOn": "2027-03-15", "owner": None, "waitingOn": "t1", "waitingFor": None}},
        "task_prerequisites": ["t1"],
        "notifications": {"level": "everything", "emailMe": True, "quiet": ["22:00", "07:00", "Europe/Warsaw"], "muted": ["g1"]},
        "device_session": True, "vault_messages": ["VAULT-secret", "VAULT-after"],
        "ai": {
            "connection_name": "Mock key", "model": "listed-model", "key_last_four": "a33f", "daily_budget_cents": 500, "agent_name": "Planner", "instructions": "Plan.",
            "memory": ["water Mondays", "north side"], "weekly_words": "Every Monday at 9:00", "off_words": "Every day at 7:30",
            "weekly_enabled": True, "off_enabled": False, "run_status": "completed", "run_answer": '{"body": "UPGRADE-CHECK-ANSWER: yes"}',
            "weekly_next": ["2026-11-16T08:00:00.000Z", "2026-11-23T08:00:00.000Z", "2026-11-30T08:00:00.000Z"], "off_next": [],
        },
    }
    value.update(changes)
    return value


NOW = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)


class MoreContentCheckTest(unittest.TestCase):
    def test_equal_content_and_content_written_later_have_no_problems(self) -> None:
        self.assertEqual(check_more(recorded_more(), observed_more(), NOW), [])

    def test_each_lost_kind_of_content_is_named(self) -> None:
        problems = check_more(recorded_more(), observed_more(
            people={"u-ben": "guest"}, guest_spaces=[], guest_denied=False, garden_messages=[[1, "u-ada", "root"]], garden_file_hex="", garden_video_sha256="",
            dm_bodies=[], group_title="x", wiki_versions=[[1, "Started the page"]], wiki_bodies={1: "other"}, map_thoughts=[], map_links=[],
            tasks={}, task_prerequisites=[], notifications={"level": "nothing", "emailMe": False, "quiet": [], "muted": []},
            device_session=False, vault_messages=[],
        ), NOW)
        for part in ("Ben is", "Gina is", "lost the space", "not in", "garden message 2", "garden file", "garden video", "direct conversation", "group title",
                     "wiki version [2", "wiki version 1 reads", "map thoughts", "map links", "task 'Calibrate' missing", "prerequisites",
                     "notification settings", "quiet hours", "second device", "encrypted space"):
            self.assertTrue(any(part in problem for problem in problems), f"{part!r} not named in {problems}")

    def test_a_changed_task_is_named_with_what_it_reads(self) -> None:
        tasks = observed_more()["tasks"]
        tasks["t2"] = {**tasks["t2"], "dueOn": None}
        problems = check_more(recorded_more(), observed_more(tasks=tasks), NOW)
        self.assertEqual(len(problems), 1)
        self.assertIn("task 'Ship' reads", problems[0])

    def test_the_agents_data_is_checked(self) -> None:
        ai = {**observed_more()["ai"], "memory": ["north side"], "run_status": "provider_failed", "weekly_enabled": False}
        problems = check_more(recorded_more(), observed_more(ai=ai), NOW)
        self.assertTrue(any("agent memory" in problem for problem in problems), problems)
        self.assertTrue(any("earlier run" in problem for problem in problems), problems)
        self.assertTrue(any("switch changed" in problem for problem in problems), problems)


class NextTimesTest(unittest.TestCase):
    WEEKLY = ["2026-11-16T08:00:00.000Z", "2026-11-23T08:00:00.000Z", "2026-11-30T08:00:00.000Z"]

    def test_three_times_a_week_apart_ahead_of_now_pass(self) -> None:
        self.assertEqual(check_next_times(self.WEEKLY, [], NOW), [])

    def test_a_change_of_summer_time_moves_a_week_by_an_hour(self) -> None:
        self.assertEqual(check_next_times(["2027-03-22T08:00:00Z", "2027-03-29T07:00:00Z", "2027-04-05T07:00:00Z"], [], NOW), [])

    def test_a_next_time_in_the_past_a_missing_one_and_times_of_an_off_schedule_are_named(self) -> None:
        self.assertTrue(any("not ahead" in p for p in check_next_times(["2026-11-01T08:00:00Z"] + self.WEEKLY[1:], [], NOW)))
        self.assertTrue(any("expected 3" in p for p in check_next_times(self.WEEKLY[:1], [], NOW)))
        self.assertTrue(any("switched-off" in p for p in check_next_times(self.WEEKLY, ["2026-11-16T08:00:00Z"], NOW)))
        self.assertTrue(any("a week apart" in p for p in check_next_times([self.WEEKLY[0], "2026-11-24T08:00:00Z", "2026-12-01T08:00:00Z"], [], NOW)))


class LegSettingsTest(StubbedDocker):
    """The settings of the matrix are refused before docker runs."""

    def run_with(self, **env: str) -> subprocess.CompletedProcess[str]:
        previous = self.dir / "previous"
        if not previous.exists():
            write_assets(previous, "sha256:" + "a" * 64)
        merged = dict(os.environ, STUB_LOG=str(self.log), PATH=f"{self.dir / 'bin'}{os.pathsep}{os.environ['PATH']}", **env)
        merged["FLUX_SMOKE_PREVIOUS_ASSETS"] = str(previous)
        return subprocess.run(["bash", str(SCRIPT), str(self.candidate), str(self.dir / "state"), "projectsrc", "projectrst"], env=merged, capture_output=True, text=True)

    def test_the_upgrade_only_mode_needs_a_previous_release(self) -> None:
        env = dict(os.environ, STUB_LOG=str(self.log), PATH=f"{self.dir / 'bin'}{os.pathsep}{os.environ['PATH']}", FLUX_SMOKE_LEGS="upgrade")
        env.pop("FLUX_SMOKE_PREVIOUS_ASSETS", None)
        result = subprocess.run(["bash", str(SCRIPT), str(self.candidate), str(self.dir / "state"), "projectsrc", "projectrst"], env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("needs FLUX_SMOKE_PREVIOUS_ASSETS", result.stderr)
        self.assertFalse(self.log.exists())

    def test_unknown_legs_and_injections_are_refused(self) -> None:
        for env, message in (({"FLUX_SMOKE_LEGS": "leg3"}, "FLUX_SMOKE_LEGS is"), ({"FLUX_SMOKE_INJECT": "x"}, "FLUX_SMOKE_INJECT is")):
            result = self.run_with(**env)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(message, result.stderr)
        self.assertFalse(self.log.exists())

    def test_the_upgrade_leg_carries_the_agent_settings_and_the_provider_mock_overlay(self) -> None:
        result = self.run_with(FLUX_SMOKE_LEGS="upgrade")
        self.assertNotEqual(result.returncode, 0)  # the stub docker fails the first compose call
        first = self.log.read_text().splitlines()[0]
        self.assertIn("provider-mock.compose.yaml", first)
        env = (self.dir / "state" / "upgrade" / "source.env").read_text(encoding="utf-8")
        for line in ("FLUX_PERSONAL_RUNS=on", "FLUX_AI_PRIVATE_TARGETS=provider-mock"):
            self.assertIn(line, env.splitlines())
        self.assertRegex(env, r"(?m)^FLUX_BACKGROUND_KEY_HOST_FILE=/.+background\.key$")

    def test_the_clean_default_install_has_no_agent_settings_and_no_overlay(self) -> None:
        """Leg 1 installs exactly as INSTALL.md says: the template filled in with its secrets and port, nothing else (P2 of #1262)."""
        env = dict(os.environ, STUB_LOG=str(self.log), PATH=f"{self.dir / 'bin'}{os.pathsep}{os.environ['PATH']}")
        env.pop("FLUX_SMOKE_PREVIOUS_ASSETS", None)
        result = subprocess.run(["bash", str(SCRIPT), str(self.candidate), str(self.dir / "state"), "projectsrc", "projectrst"], env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)  # the stub docker fails the first compose call
        calls = self.log.read_text().splitlines()
        self.assertTrue(calls)
        for call in calls:
            self.assertNotIn("provider-mock.compose.yaml", call)
            self.assertEqual(call.count(" -f "), 1, call)
        written = (self.dir / "state" / "source.env").read_text(encoding="utf-8")
        template = (self.candidate / "env.example").read_text(encoding="utf-8")
        for key in ("FLUX_PERSONAL_RUNS", "FLUX_AI_PRIVATE_TARGETS", "FLUX_BACKGROUND_KEY_HOST_FILE"):
            self.assertNotIn(key, written)
            self.assertNotIn(key, template)
        self.assertFalse((self.dir / "state" / "background.key").exists(), "no key file is made for a default install")


if __name__ == "__main__":
    unittest.main()
