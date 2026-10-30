"""The weekly lead measures script (scripts/lead_measures.py, #308). No network: `gh` is faked."""

import argparse
import contextlib
import importlib.util
import io
import json
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("flux_lead_measures", ROOT / "scripts/lead_measures.py")
lm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lm)

TEAM = {"ada", "bo"}
SINCE = datetime(2026, 10, 19, tzinfo=timezone.utc)  # a Monday
UNTIL = datetime(2026, 10, 26, tzinfo=timezone.utc)
NOW = datetime(2026, 10, 26, 9, 0, tzinfo=timezone.utc)


def at(day, hour=0, minute=0):
    return datetime(2026, 10, day, hour, minute, tzinfo=timezone.utc)


def person(login, kind="User"):
    return {"__typename": kind, "login": login}


def event(login, created, association="NONE", kind="User"):
    return {"createdAt": created, "author": person(login, kind), "authorAssociation": association}


class Classification(unittest.TestCase):
    def test_team_comes_from_codeowners_and_ignores_org_teams(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "CODEOWNERS"
            path.write_text("# @commented\n* @Ada @bo\n/docs/ @acme/writers @Cy-Dee a@b.example\n", encoding="utf-8")
            self.assertEqual(lm.team_logins(path, ["Extra"]), {"ada", "bo", "cy-dee", "extra"})
        self.assertEqual(lm.team_logins(Path("/nonexistent/CODEOWNERS")), set())

    def test_the_real_codeowners_name_both_founders(self):
        self.assertTrue({"pelikanfix16", "zamojski5"} <= lm.team_logins(ROOT / ".github/CODEOWNERS"))

    def test_outside_person_rules(self):
        outside = lm.is_outside_person
        self.assertTrue(outside(person("eve"), "FIRST_TIME_CONTRIBUTOR", TEAM))
        self.assertTrue(outside(person("eve"), "CONTRIBUTOR", TEAM))
        self.assertTrue(outside(None, "NONE", TEAM), "a deleted account is not us")
        self.assertFalse(outside(person("Ada"), "NONE", TEAM), "logins compare without case")
        self.assertFalse(outside(person("eve"), "COLLABORATOR", TEAM))
        self.assertFalse(outside(person("eve"), "MEMBER", TEAM))
        self.assertFalse(outside(person("dependabot", "Bot"), "NONE", TEAM))
        self.assertFalse(outside(person("renovate[bot]"), "NONE", TEAM))

    def test_title_type(self):
        self.assertEqual(lm.title_type("feat(web): add x"), "feat")
        self.assertEqual(lm.title_type("fix!: break y"), "fix")
        self.assertEqual(lm.title_type("Update the readme"), "other")


class Times(unittest.TestCase):
    def test_working_hours_skip_the_weekend(self):
        self.assertEqual(lm.working_hours(at(19, 9), at(19, 12)), 3)
        self.assertEqual(lm.working_hours(at(23, 22), at(26, 2)), 4, "Friday 22:00 to Monday 02:00")
        self.assertEqual(lm.working_hours(at(24, 10), at(25, 10)), 0, "Saturday to Sunday")
        self.assertEqual(lm.working_hours(at(20, 9), at(20, 8)), 0, "never negative")

    def test_dates(self):
        self.assertEqual(lm.parse_when("2026-10-19"), SINCE)
        self.assertEqual(lm.parse_when("2026-10-19T02:00:00+02:00"), SINCE)
        with self.assertRaises(argparse.ArgumentTypeError):
            lm.parse_when("last week")

    def test_median(self):
        item = lambda hours: {"answer_hours": hours}  # noqa: E731
        self.assertIsNone(lm.median_hours([]))
        self.assertIsNone(lm.median_hours([item(None)]))
        self.assertEqual(lm.median_hours([item(1.0), item(None), item(5.0), item(30.0)]), 5.0)
        self.assertEqual(lm.median_hours([item(2.0), item(4.0)]), 3.0)


class FirstAnswer(unittest.TestCase):
    def item(self, comments=(), reviews=()):
        return {"number": 7, "title": "t", "url": "u", "createdAt": "2026-10-19T09:00:00Z", "author": person("eve"),
                "authorAssociation": "NONE", "comments": {"nodes": list(comments)}, "reviews": {"nodes": list(reviews)}}

    def test_only_the_team_counts_and_not_the_author_or_bots(self):
        item = self.item(
            comments=[event("eve", "2026-10-19T09:01:00Z"), event("github-actions", "2026-10-19T09:02:00Z", "NONE", "Bot"),
                      event("other-outsider", "2026-10-19T09:03:00Z"), event("ada", "2026-10-19T11:00:00Z")],
            reviews=[event("bo", "2026-10-19T10:00:00Z", "MEMBER")])
        answer = lm.first_answer(item, TEAM)
        self.assertEqual(answer["author"]["login"], "bo", "an earlier review beats a later comment")

    def test_no_answer(self):
        self.assertIsNone(lm.first_answer(self.item(comments=[event("eve", "2026-10-19T09:01:00Z")]), TEAM))

    def test_judge_item_measures_working_hours_or_waiting(self):
        answered = lm.judge_item("issue", self.item(comments=[event("ada", "2026-10-19T14:30:00Z")]), TEAM, NOW)
        self.assertEqual((answered["answer_hours"], answered["waiting_hours"], answered["answered_by"]), (5.5, None, "ada"))
        waiting = lm.judge_item("issue", self.item(), TEAM, NOW)
        # Monday 09:00 to the next Monday 09:00 is five working days.
        self.assertEqual((waiting["answer_hours"], waiting["waiting_hours"]), (None, 120.0))


class FeedbackForm(unittest.TestCase):
    BODY = ("### Team\n\n_No response_\n\n### Flux commit\n\n05f89591\n\n### Where were you?\n\nInstalling (./flux up)\n\n"
            "### How much did it get in your way?\n\nIt stopped me\n\n### Time\n\nabout 9 minutes\n\n"
            "### Counting\n\n- [X] You may count our team as an outside install in the weekly review.\n")

    def issue(self, body):
        return {"number": 9, "url": "u", "createdAt": "2026-10-20T10:00:00Z", "author": person("eve"), "body": body}

    def test_sections_and_consent(self):
        report = lm.partner_report(self.issue(self.BODY))
        self.assertEqual((report["revision"], report["step"], report["impact"], report["time"]),
                         ("05f89591", "Installing (./flux up)", "It stopped me", "about 9 minutes"))
        self.assertTrue(report["counted"])
        self.assertEqual(report["team"], "")

    def test_an_unticked_box_is_not_counted(self):
        body = self.BODY.replace("[X]", "[ ]")
        self.assertFalse(lm.partner_report(self.issue(body))["counted"])
        self.assertFalse(lm.partner_report(self.issue(""))["counted"])


class FakeGh:
    """Answers `gh api` calls by matching a marker in the arguments; records them."""

    def __init__(self, answers):
        self.answers = answers
        self.calls = []

    def __call__(self, args):
        self.calls.append(args)
        text = " ".join(args)
        for marker, answer in self.answers:
            if marker in text:
                if isinstance(answer, Exception):
                    raise answer
                return answer(args) if callable(answer) else json.dumps(answer)
        raise AssertionError(f"unexpected gh call: {text[:200]}")


def search_answer(nodes, count=None):
    return {"data": {"search": {"issueCount": len(nodes) if count is None else count,
                                "pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": nodes}}}


def outside_search(args):
    query = next(a for a in args if a.startswith("q="))
    if "-author:" in query:  # the outside items
        return json.dumps(search_answer([
            {"__typename": "Issue", "number": 11, "title": "Install fails", "url": "https://x/11", "createdAt": "2026-10-19T09:00:00Z",
             "author": person("eve"), "authorAssociation": "NONE",
             "comments": {"nodes": [event("ada", "2026-10-20T09:00:00Z", "MEMBER")]}},
            {"__typename": "PullRequest", "number": 12, "title": "fix: typo", "url": "https://x/12", "createdAt": "2026-10-23T10:00:00Z",
             "author": person("fay"), "authorAssociation": "FIRST_TIME_CONTRIBUTOR", "comments": {"nodes": []}, "reviews": {"nodes": []}},
            {"__typename": "PullRequest", "number": 13, "title": "chore: bump", "url": "https://x/13", "createdAt": "2026-10-20T10:00:00Z",
             "author": person("dependabot", "Bot"), "authorAssociation": "NONE", "comments": {"nodes": []}, "reviews": {"nodes": []}},
        ]))
    if "label:partner-feedback" in query:
        body = FeedbackForm.BODY
        return json.dumps(search_answer([
            {"__typename": "Issue", "number": 20, "title": "[Partner feedback]: x", "url": "https://x/20", "createdAt": "2026-10-21T10:00:00Z",
             "author": person("eve"), "authorAssociation": "NONE", "body": body},
            {"__typename": "Issue", "number": 21, "title": "[Partner feedback]: y", "url": "https://x/21", "createdAt": "2026-10-10T10:00:00Z",
             "author": person("gus"), "authorAssociation": "NONE", "body": body.replace("[X]", "[ ]")},
        ]))
    if "is:merged" in query:
        return json.dumps(search_answer([
            {"__typename": "PullRequest", "number": 1, "title": "feat(web): a", "mergedAt": "2026-10-20T10:00:00Z", "author": person("ada"), "authorAssociation": "MEMBER"},
            {"__typename": "PullRequest", "number": 2, "title": "feat: b", "mergedAt": "2026-10-20T10:00:00Z", "author": person("ada"), "authorAssociation": "MEMBER"},
            {"__typename": "PullRequest", "number": 3, "title": "fix: c", "mergedAt": "2026-10-21T10:00:00Z", "author": person("fay"), "authorAssociation": "CONTRIBUTOR"},
        ]))
    if "author:fay created:<" in query:
        return json.dumps(search_answer([], 0))  # fay never opened anything before: first-time
    if "author:eve created:<" in query:
        return json.dumps(search_answer([{"number": 3}], 1))
    if "is:issue created:" in query:
        return json.dumps(search_answer([], 30))
    if "is:pr created:" in query:
        return json.dumps(search_answer([], 55))
    raise AssertionError(query)


DISCUSSIONS = {"data": {"repository": {"hasDiscussionsEnabled": True, "discussions": {
    "pageInfo": {"hasNextPage": False, "endCursor": None},
    "nodes": [
        {"number": 30, "title": "How do I back up?", "url": "https://x/30", "createdAt": "2026-10-22T08:00:00Z",
         "author": person("hal"), "authorAssociation": "NONE", "comments": {"nodes": [event("bo", "2026-10-22T09:30:00Z", "MEMBER")]}},
        {"number": 29, "title": "Older", "url": "https://x/29", "createdAt": "2026-10-01T08:00:00Z",
         "author": person("hal"), "authorAssociation": "NONE", "comments": {"nodes": []}},
    ]}}}}

REACH = {"data": {"repository": {
    "stargazerCount": 12, "forkCount": 3, "goodFirst": {"totalCount": 6}, "helpWanted": {"totalCount": 1},
    "stargazers": {"edges": [{"starredAt": "2026-10-22T10:00:00Z", "node": {"login": "ivy"}},
                             {"starredAt": "2026-10-21T10:00:00Z", "node": {"login": "Ada"}},
                             {"starredAt": "2026-10-01T10:00:00Z", "node": {"login": "jo"}}]},
    "forks": {"nodes": [{"createdAt": "2026-10-23T10:00:00Z", "owner": {"login": "kim"}}]}}}}

TRAFFIC_DAYS = [{"timestamp": "2026-10-18T00:00:00Z", "count": 100, "uniques": 9},
                {"timestamp": "2026-10-20T00:00:00Z", "count": 10, "uniques": 2},
                {"timestamp": "2026-10-21T00:00:00Z", "count": 5, "uniques": 1}]


def ttfr_download(args):
    directory = Path(args[args.index("-D") + 1]) / "time-to-first-run-5-1"
    directory.mkdir(parents=True)
    (directory / "summary.json").write_text(json.dumps({
        "cold": {"From clone start to the logins": 140.5, "revision": "abc1234567"},
        "warm": {"From clone start to the logins": 18.6, "revision": "abc1234567"}}), encoding="utf-8")
    return ""


def standard_answers(**overrides):
    answers = {
        "repos/ColdPhase/flux/traffic/views": {"views": TRAFFIC_DAYS},
        "repos/ColdPhase/flux/traffic/clones": {"clones": TRAFFIC_DAYS},
        "traffic/popular/referrers": [{"referrer": "github.com", "count": 7, "uniques": 3}],
        "workflows/time-to-first-run.yml/runs": {"workflow_runs": [{"id": 5, "html_url": "https://x/runs/5", "created_at": "2026-10-10T12:00:00Z"}]},
        "run download": ttfr_download,
        "repos/ColdPhase/flux/compare/abc1234567...": {"ahead_by": 40},
        "repos/ColdPhase/flux/commits/main": {"sha": "f" * 40, "commit": {"committer": {"date": "2026-10-25T10:00:00Z"}}},
        "repos/ColdPhase/flux": {"default_branch": "main"},
        "query Discussions": DISCUSSIONS,
        "query Reach": REACH,
        "query Search": outside_search,
    }
    answers.update(overrides)
    # Longer markers must match before the shorter "repos/ColdPhase/flux".
    return sorted(answers.items(), key=lambda pair: -len(pair[0]))


def run_collect(**overrides):
    fake = FakeGh(standard_answers(**overrides))
    return lm.collect(lm.Client("ColdPhase/flux", fake), SINCE, UNTIL, TEAM, NOW), fake


class Collect(unittest.TestCase):
    def test_every_measure_from_canned_answers(self):
        data, _ = run_collect()
        self.assertEqual([(i["kind"], i["number"], i["answer_hours"]) for i in data["outside_items"]],
                         [("issue", 11, 24.0), ("discussion", 30, 1.5), ("pull request", 12, None)],
                         "the bot's PR and the discussion outside the window are left out")
        self.assertEqual(data["answers"], {"median_hours": 12.8, "answered": 2, "unanswered": 1, "over_goal": 0})
        self.assertEqual(data["first_time_authors"], ["fay"], "eve opened an item before; the discussion author is not checked")
        self.assertEqual(data["opened"], {"issues": 30, "prs": 55})
        self.assertEqual(data["partners"]["installs_total"], 1)
        self.assertEqual(data["partners"]["installs_new"], ["eve"])
        self.assertEqual(data["partners"]["reports_in_window"], 1)
        self.assertEqual(data["merged"], {"total": 3, "types": {"feat": 2, "fix": 1}, "outside": 1, "counted": 3})
        reach = data["reach"]
        self.assertEqual((reach["stars_new"], reach["stars_outside"], reach["forks_new"], reach["forks_outside"]), (2, 1, 1, 1))
        self.assertEqual((reach["good_first_issues_open"], reach["help_wanted_open"]), (6, 1))
        self.assertEqual(data["traffic"]["views"], {"count": 15, "daily_uniques": 3}, "only the days of the window")
        run = data["first_run"]
        self.assertEqual((run["run"], run["cold"], run["warm"], run["main_ahead_by"], run["stale"]), (5, 140.5, 18.6, 40, True))

    def test_an_unreadable_measure_is_reported_and_the_rest_still_print(self):
        data, _ = run_collect(**{"repos/ColdPhase/flux/traffic/views": lm.GhError("gh api: HTTP 403: Must have push access")})
        self.assertIn("403", data["traffic"]["unavailable"])
        text = lm.render(data)
        self.assertIn("| Repository page views and clones | unavailable |", text)
        self.assertIn("| 5. Merged PRs | 3 |", text)

    def test_traffic_is_partial_or_unavailable_beyond_fourteen_days(self):
        fake = FakeGh(standard_answers())
        client = lm.Client("ColdPhase/flux", fake)
        self.assertFalse(lm.collect_traffic(client, SINCE, UNTIL, NOW)["partial"])
        self.assertTrue(lm.collect_traffic(client, at(1), UNTIL, NOW)["partial"])
        with self.assertRaises(lm.GhError):
            lm.collect_traffic(client, at(1), at(8), NOW)

    def test_no_workflow_run_and_no_outside_activity(self):
        quiet = lambda args: json.dumps(search_answer([]))  # noqa: E731
        data, _ = run_collect(**{
            "query Search": quiet, "workflows/time-to-first-run.yml/runs": {"workflow_runs": []},
            "query Discussions": {"data": {"repository": {"hasDiscussionsEnabled": False}}}})
        self.assertEqual(data["outside_items"], [])
        text = lm.render(data)
        self.assertIn("| 3. Median time to a first answer | no data | no outside item was opened |", text)
        self.assertIn("never measured", text)
        self.assertIn("| 1. Outside installs reported | 0 new (none) |", text)

    def test_the_team_is_excluded_in_the_search_itself(self):
        _, fake = run_collect()
        queries = [a for call in fake.calls for a in call if a.startswith("q=") and "-author:" in a]
        self.assertTrue(queries and all("-author:ada" in q and "-author:bo" in q for q in queries))

    def test_render_has_the_numbers_and_the_caveats(self):
        data, _ = run_collect()
        text = lm.render(data)
        for expected in ("2026-10-19 to 2026-10-26", "`ffffffff`", "| 2. Outside issues, PRs and discussions opened | issues 1, PRs 1, discussions 1 |",
                         "first-time contributors: fay", "| 3. Median time to a first answer | 12.8 h | 2 answered, 1 waiting",
                         "cold 2 min 20.5 s, warm 18.6 s", "stale: older than this window", "2 feat, 1 fix; 1 from outside",
                         "| Stars | +2 (1 outside) | 12 in total |", "| Documentation site visits | not collected |",
                         "[pull request #12](https://x/12) by fay, **waiting 23 h**", "answered by ada after 24 h",
                         "Partner feedback this window:", "(counted)"):
            self.assertIn(expected, text)

    def test_json_output_round_trips(self):
        data, _ = run_collect()
        self.assertEqual(json.loads(json.dumps(data))["main"]["sha"], "f" * 40)


class Command(unittest.TestCase):
    def run_main(self, argv, runner):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = lm.main(argv, runner=runner, now=NOW)
            except SystemExit as exit_:
                code = exit_.code
        return code, out.getvalue(), err.getvalue()

    def test_default_window_is_the_seven_days_before_now_and_json_is_valid(self):
        fake = FakeGh(standard_answers())
        code, out, _ = self.run_main(["--json"], fake)
        self.assertEqual(code, 0)
        data = json.loads(out)
        self.assertEqual((data["since"], data["until"]), ("2026-10-19T09:00:00Z", "2026-10-26T09:00:00Z"))
        self.assertTrue({"pelikanfix16", "zamojski5"} <= set(data["team"]))

    def test_markdown_and_explicit_window(self):
        code, out, _ = self.run_main(["--since", "2026-10-19", "--until", "2026-10-26", "--team", "kim"], FakeGh(standard_answers()))
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith("# Lead measures for ColdPhase/flux: 2026-10-19 to 2026-10-26"))
        self.assertIn("kim", out)

    def test_a_reversed_window_is_refused(self):
        code, _, err = self.run_main(["--since", "2026-10-26", "--until", "2026-10-19"], FakeGh([]))
        self.assertEqual(code, 2)
        self.assertIn("--since must be before --until", err)

    def test_gh_failing_for_the_repository_is_an_error_with_a_hint(self):
        code, out, err = self.run_main([], FakeGh([("repos/ColdPhase/flux", lm.GhError("gh api: HTTP 404"))]))
        self.assertEqual((code, out), (1, ""))
        self.assertIn("gh auth status", err)

    def test_search_pages_are_followed(self):
        pages = iter([
            {"data": {"search": {"issueCount": 3, "pageInfo": {"hasNextPage": True, "endCursor": "c1"}, "nodes": [{"number": 1}, {"number": 2}]}}},
            {"data": {"search": {"issueCount": 3, "pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": [{"number": 3}]}}}])
        fake = FakeGh([("query Search", lambda args: json.dumps(next(pages)))])
        total, nodes = lm.Client("ColdPhase/flux", fake).search("is:pr", "... on Issue { number }")
        self.assertEqual((total, [n["number"] for n in nodes]), (3, [1, 2, 3]))
        self.assertIn("after=c1", fake.calls[1])
        self.assertNotIn("after=None", [a for call in fake.calls for a in call])


if __name__ == "__main__":
    unittest.main()
