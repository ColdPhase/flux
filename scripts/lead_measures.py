#!/usr/bin/env python3
"""Print the weekly lead measures of the Flux repository from the GitHub API (#308, L-4).

Definitions and caveats: docs/product/lead-measures.md. The weekly review that uses the
output: docs/product/weekly-review.md.

Only the Python standard library and an authenticated `gh` are used. Nothing is added to the
application: every number comes from GitHub (issues, pull requests, discussions, stars,
forks, the repository traffic API and the "Time to first run" workflow). The script only
reads. Traffic needs push access to the repository; a measure that cannot be read is printed
as "unavailable" with the reason, and the other measures are still printed.

Examples:
    python3 scripts/lead_measures.py                      # the last 7 days, as Markdown
    python3 scripts/lead_measures.py --since 2026-10-19 --until 2026-10-26
    python3 scripts/lead_measures.py --json               # the same numbers as JSON
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_REPO = "ColdPhase/flux"
PARTNER_LABEL = "partner-feedback"
TTFR_WORKFLOW = "time-to-first-run.yml"
# Comments of these kinds do not make someone "outside": a person with these rights on the
# repository is part of the team for the weekly review.
INSIDE_ASSOCIATIONS = {"OWNER", "MEMBER", "COLLABORATOR"}
# The response goal of L-2: a first answer to an outside issue or PR within 2 working days.
ANSWER_GOAL_HOURS = 48.0

Runner = Callable[[list[str]], str]


class GhError(RuntimeError):
    """`gh` failed or answered something that is not JSON."""


# ---------------------------------------------------------------------------- gh access

def run_gh(args: list[str]) -> str:
    try:
        done = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise GhError(f"gh {' '.join(args[:2])}: {error}") from error
    if done.returncode != 0:
        detail = (done.stderr or done.stdout).strip().splitlines()
        raise GhError(f"gh {' '.join(args[:2])}: {detail[0] if detail else 'exit ' + str(done.returncode)}")
    return done.stdout


class Client:
    def __init__(self, repo: str, runner: Runner = run_gh):
        self.repo = repo
        self.owner, self.name = repo.split("/", 1)
        self.runner = runner

    def graphql(self, query: str, **variables: str | None) -> dict[str, Any]:
        args = ["api", "graphql", "-f", f"query={query}"]
        for key, value in variables.items():
            if value is not None:
                args += ["-f", f"{key}={value}"]
        return self._json(args)["data"]

    def rest(self, path: str, accept: str | None = None) -> Any:
        args = ["api"] + (["-H", f"Accept: {accept}"] if accept else []) + [path]
        return self._json(args)

    def _json(self, args: list[str]) -> Any:
        text = self.runner(args)
        try:
            data = json.loads(text)
        except ValueError as error:
            raise GhError(f"gh {' '.join(args[:2])}: the answer is not JSON") from error
        if isinstance(data, dict) and data.get("errors"):
            raise GhError(f"gh {' '.join(args[:2])}: {data['errors'][0].get('message', 'GraphQL error')}")
        return data

    def search(self, query: str, nodes: str, max_pages: int = 10) -> tuple[int, list[dict[str, Any]]]:
        """GraphQL issue/PR search: (total count, nodes of up to max_pages pages of 50)."""
        document = SEARCH.replace("__NODES__", nodes)
        found: list[dict[str, Any]] = []
        after: str | None = None
        total = 0
        for _ in range(max_pages):
            result = self.graphql(document, q=f"repo:{self.repo} {query}", after=after)["search"]
            total = result["issueCount"]
            found += [node for node in result["nodes"] if node]
            if not result["pageInfo"]["hasNextPage"]:
                break
            after = result["pageInfo"]["endCursor"]
        return total, found


SEARCH = """query Search($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 50, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { __typename __NODES__ }
  }
}"""

WHO = "author { __typename login } authorAssociation"
EVENTS = f"nodes {{ createdAt {WHO} }}"
OUTSIDE_NODES = (
    f"... on Issue {{ number title url createdAt {WHO} comments(first: 30) {{ {EVENTS} }} }}"
    f"... on PullRequest {{ number title url createdAt {WHO} comments(first: 30) {{ {EVENTS} }} "
    f"reviews(first: 30) {{ {EVENTS} }} }}"
)
MERGED_NODES = f"... on PullRequest {{ number title mergedAt {WHO} }}"
PARTNER_NODES = f"... on Issue {{ number title url createdAt body {WHO} }}"
COUNT_NODES = "... on Issue { number }"

DISCUSSIONS = f"""query Discussions($owner: String!, $name: String!, $after: String) {{
  repository(owner: $owner, name: $name) {{
    hasDiscussionsEnabled
    discussions(first: 50, after: $after, orderBy: {{field: CREATED_AT, direction: DESC}}) {{
      pageInfo {{ hasNextPage endCursor }}
      nodes {{ number title url createdAt {WHO} comments(first: 30) {{ {EVENTS} }} }}
    }}
  }}
}}"""

REACH = """query Reach($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    stargazerCount forkCount
    goodFirst: issues(labels: ["good first issue"], states: OPEN) { totalCount }
    helpWanted: issues(labels: ["help wanted"], states: OPEN) { totalCount }
    stargazers(first: 100, orderBy: {field: STARRED_AT, direction: DESC}) { edges { starredAt node { login } } }
    forks(first: 100, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { createdAt owner { login } } }
  }
}"""


# ----------------------------------------------------------------------- pure functions

def parse_time(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)


def parse_when(text: str) -> datetime:
    """`YYYY-MM-DD` (00:00 UTC) or an ISO 8601 date and time."""
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
            return datetime.fromisoformat(text).replace(tzinfo=timezone.utc)
        return parse_time(text)
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"not a date: {text!r} (use YYYY-MM-DD or ISO 8601)") from error


def stamp(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def team_logins(codeowners: Path, extra: list[str] | None = None) -> set[str]:
    """The people who are "us": every @login in CODEOWNERS (not @org/team) plus --team."""
    logins = {login.lower() for login in (extra or [])}
    if codeowners.is_file():
        for line in codeowners.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("#"):
                continue
            logins.update(m.lower() for m in re.findall(r"(?<![\w/])@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(?![\w/-])", line))
    return logins


def login_of(actor: dict[str, Any] | None) -> str:
    return (actor or {}).get("login") or "(deleted account)"


def is_bot(actor: dict[str, Any] | None) -> bool:
    return bool(actor) and (actor.get("__typename") == "Bot" or str(actor.get("login", "")).endswith("[bot]"))


def is_inside(actor: dict[str, Any] | None, association: str | None, team: set[str]) -> bool:
    return login_of(actor).lower() in team or association in INSIDE_ASSOCIATIONS


def is_outside_person(actor: dict[str, Any] | None, association: str | None, team: set[str]) -> bool:
    """A person (not a bot) who is not part of the team."""
    return not is_bot(actor) and not is_inside(actor, association, team)


def working_hours(start: datetime, end: datetime) -> float:
    """Hours from start to end without Saturdays and Sundays (UTC); 24 hours per working day."""
    if end <= start:
        return 0.0
    total = 0.0
    day = start.replace(hour=0, minute=0, second=0, microsecond=0)
    while day < end:
        following = day + timedelta(days=1)
        if day.weekday() < 5:
            total += (min(end, following) - max(start, day)).total_seconds()
        day = following
    return total / 3600


def first_answer(item: dict[str, Any], team: set[str]) -> dict[str, Any] | None:
    """The first comment or review on an outside item by one of us (bots do not count)."""
    author = login_of(item.get("author")).lower()
    events = list((item.get("comments") or {}).get("nodes") or []) + list((item.get("reviews") or {}).get("nodes") or [])
    for event in sorted(events, key=lambda e: e["createdAt"]):
        who = event.get("author")
        if login_of(who).lower() != author and not is_bot(who) and is_inside(who, event.get("authorAssociation"), team):
            return event
    return None


def judge_item(kind: str, item: dict[str, Any], team: set[str], now: datetime) -> dict[str, Any]:
    opened = parse_time(item["createdAt"])
    answer = first_answer(item, team)
    answered_at = parse_time(answer["createdAt"]) if answer else None
    return {
        "kind": kind, "number": item["number"], "title": item["title"], "url": item["url"],
        "author": login_of(item.get("author")), "created": stamp(opened),
        "answered_by": login_of(answer.get("author")) if answer else None,
        "answered_at": stamp(answered_at) if answered_at else None,
        "answer_hours": round(working_hours(opened, answered_at), 1) if answered_at else None,
        "waiting_hours": None if answered_at else round(working_hours(opened, now), 1),
    }


def median_hours(items: list[dict[str, Any]]) -> float | None:
    hours = [item["answer_hours"] for item in items if item["answer_hours"] is not None]
    return round(statistics.median(hours), 1) if hours else None


def feedback_sections(body: str) -> dict[str, str]:
    """The answers of a GitHub issue form: `### Label` followed by the answer."""
    sections: dict[str, str] = {}
    for block in re.split(r"(?m)^### ", body or "")[1:]:
        label, _, answer = block.partition("\n")
        sections[label.strip()] = answer.strip()
    return sections


def partner_report(issue: dict[str, Any]) -> dict[str, Any]:
    answers = feedback_sections(issue.get("body", ""))
    counting = answers.get("Counting", "")
    return {
        "number": issue["number"], "url": issue["url"], "author": login_of(issue.get("author")),
        "created": issue["createdAt"], "team": answers.get("Team", "").replace("_No response_", "").strip(),
        "revision": answers.get("Flux commit", ""), "step": answers.get("Where were you?", ""),
        "impact": answers.get("How much did it get in your way?", ""),
        "time": answers.get("Time", "").replace("_No response_", "").strip(),
        "counted": "[x]" in counting.lower(),
    }


def title_type(title: str) -> str:
    """The conventional-commit type of a pull request title, `feat` in `feat(web): ...`."""
    match = re.match(r"^([a-z]+)(?:\([^)]*\))?!?:", title)
    return match[1] if match else "other"


# ----------------------------------------------------------------------------- measures

def window_query(field: str, since: datetime, until: datetime) -> str:
    return f"{field}:{stamp(since)}..{stamp(until)}"


def outside_exclusion(team: set[str]) -> str:
    return " ".join(f"-author:{login}" for login in sorted(team))


def collect_outside_items(client: Client, since: datetime, until: datetime, team: set[str], now: datetime) -> list[dict[str, Any]]:
    _, nodes = client.search(f"created:{stamp(since)}..{stamp(until)} {outside_exclusion(team)}", OUTSIDE_NODES)
    items = [
        judge_item("pull request" if node["__typename"] == "PullRequest" else "issue", node, team, now)
        for node in nodes if is_outside_person(node.get("author"), node.get("authorAssociation"), team)
    ]
    repository = client.graphql(DISCUSSIONS, owner=client.owner, name=client.name)["repository"]
    if repository["hasDiscussionsEnabled"]:
        after = None
        while True:
            page = repository["discussions"]
            for node in page["nodes"]:
                created = parse_time(node["createdAt"])
                if since <= created < until and is_outside_person(node.get("author"), node.get("authorAssociation"), team):
                    items.append(judge_item("discussion", node, team, now))
            if not page["pageInfo"]["hasNextPage"] or (page["nodes"] and parse_time(page["nodes"][-1]["createdAt"]) < since):
                break
            after = page["pageInfo"]["endCursor"]
            repository = client.graphql(DISCUSSIONS, owner=client.owner, name=client.name, after=after)["repository"]
    return sorted(items, key=lambda item: item["created"])


def first_time_authors(client: Client, items: list[dict[str, Any]], since: datetime) -> list[str]:
    """Outside authors of an issue or PR in this window who opened no issue or PR before it."""
    authors = {item["author"] for item in items if item["kind"] != "discussion" and item["author"] != "(deleted account)"}
    first_timers = []
    for author in sorted(authors):
        earlier, _ = client.search(f"author:{author} created:<{stamp(since)}", COUNT_NODES, max_pages=1)
        if earlier == 0:
            first_timers.append(author)
    return first_timers


def collect_partners(client: Client, since: datetime, until: datetime, team: set[str]) -> dict[str, Any]:
    _, nodes = client.search(f"is:issue label:{PARTNER_LABEL}", PARTNER_NODES)
    reports = [partner_report(node) for node in nodes if is_outside_person(node.get("author"), node.get("authorAssociation"), team)]
    first_counted: dict[str, str] = {}
    for report in sorted(reports, key=lambda r: r["created"]):
        if report["counted"]:
            first_counted.setdefault(report["author"], report["created"])
    new = [a for a, created in first_counted.items() if since <= parse_time(created) < until]
    in_window = [r for r in reports if since <= parse_time(r["created"]) < until]
    return {
        "installs_total": len(first_counted), "installs_new": sorted(new),
        "reports_in_window": len(in_window), "reports_total": len(reports),
        "teams_reporting": sorted({r["author"] for r in in_window}),
        "reports": in_window,
    }


def collect_merged(client: Client, since: datetime, until: datetime, team: set[str]) -> dict[str, Any]:
    total, nodes = client.search(f"is:pr is:merged {window_query('merged', since, until)}", MERGED_NODES)
    types: dict[str, int] = {}
    for node in nodes:
        kind = title_type(node["title"])
        types[kind] = types.get(kind, 0) + 1
    outside = [n for n in nodes if is_outside_person(n.get("author"), n.get("authorAssociation"), team)]
    return {"total": total, "types": dict(sorted(types.items(), key=lambda kv: (-kv[1], kv[0]))),
            "outside": len(outside), "counted": len(nodes)}


def collect_reach(client: Client, since: datetime, until: datetime, team: set[str]) -> dict[str, Any]:
    repository = client.graphql(REACH, owner=client.owner, name=client.name)["repository"]
    stars = [e for e in repository["stargazers"]["edges"] if since <= parse_time(e["starredAt"]) < until]
    forks = [n for n in repository["forks"]["nodes"] if since <= parse_time(n["createdAt"]) < until]
    return {
        "stars_total": repository["stargazerCount"], "stars_new": len(stars),
        "stars_outside": sum(1 for e in stars if e["node"]["login"].lower() not in team),
        "forks_total": repository["forkCount"], "forks_new": len(forks),
        "forks_outside": sum(1 for n in forks if n["owner"]["login"].lower() not in team),
        "good_first_issues_open": repository["goodFirst"]["totalCount"],
        "help_wanted_open": repository["helpWanted"]["totalCount"],
    }


def collect_traffic(client: Client, since: datetime, until: datetime, now: datetime) -> dict[str, Any]:
    """The repository traffic API: 14 days at most, and only for people with push access."""
    first, last = since.date().isoformat(), until.date().isoformat()
    horizon = (now.date() - timedelta(days=13)).isoformat()  # the oldest day GitHub still holds
    if last < horizon:
        raise GhError(f"the window ends before {horizon}; the traffic API keeps only 14 days")

    def window(days: list[dict[str, Any]]) -> dict[str, int]:
        chosen = [d for d in days if first <= d["timestamp"][:10] <= last]
        return {"count": sum(d["count"] for d in chosen), "daily_uniques": sum(d["uniques"] for d in chosen)}

    base = f"repos/{client.repo}/traffic"
    views, clones = client.rest(f"{base}/views"), client.rest(f"{base}/clones")
    referrers = client.rest(f"{base}/popular/referrers")
    return {
        "views": window(views["views"]), "clones": window(clones["clones"]),
        "referrers_14d": [{"site": r["referrer"], "count": r["count"], "uniques": r["uniques"]} for r in referrers[:5]],
        "partial": first < horizon,
    }


def collect_first_run(client: Client, since: datetime, main_sha: str) -> dict[str, Any]:
    """The latest successful "Time to first run" run: its times and how far main has moved."""
    runs = client.rest(f"repos/{client.repo}/actions/workflows/{TTFR_WORKFLOW}/runs?status=success&per_page=1")["workflow_runs"]
    if not runs:
        return {"run": None}
    run = runs[0]
    result: dict[str, Any] = {"run": run["id"], "url": run["html_url"], "created": run["created_at"],
                              "stale": parse_time(run["created_at"]) < since}
    with tempfile.TemporaryDirectory(prefix="flux-ttfr-") as directory:
        client.runner(["run", "download", str(run["id"]), "-R", client.repo, "-p", "time-to-first-run-*", "-D", directory])
        summaries = sorted(Path(directory).rglob("summary.json"))
        if not summaries:
            raise GhError(f"run {run['id']} has no summary.json artifact")
        summary = json.loads(summaries[0].read_text(encoding="utf-8"))
    label = "From clone start to the logins"
    for pass_ in ("cold", "warm"):
        result[pass_] = summary.get(pass_, {}).get(label)
    revision = (summary.get("cold") or {}).get("revision", "")
    result["revision"] = revision
    if revision:
        try:
            compare = client.rest(f"repos/{client.repo}/compare/{revision}...{main_sha}")
            result["main_ahead_by"] = compare["ahead_by"]
        except GhError:
            result["main_ahead_by"] = None
    return result


def section(name: str, collect: Callable[[], Any]) -> Any:
    try:
        return collect()
    except GhError as error:
        return {"unavailable": str(error), "section": name}


def collect(client: Client, since: datetime, until: datetime, team: set[str], now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    repo = client.rest(f"repos/{client.repo}")
    head = client.rest(f"repos/{client.repo}/commits/{repo['default_branch']}")
    data: dict[str, Any] = {
        "repo": client.repo, "since": stamp(since), "until": stamp(until), "generated": stamp(now),
        "team": sorted(team), "main": {"branch": repo["default_branch"], "sha": head["sha"],
                                       "date": head["commit"]["committer"]["date"]},
    }
    items = section("outside", lambda: collect_outside_items(client, since, until, team, now))
    data["outside_items"] = items
    if isinstance(items, list):
        answered = [i for i in items if i["answer_hours"] is not None]
        data["answers"] = {
            "median_hours": median_hours(items), "answered": len(answered), "unanswered": len(items) - len(answered),
            "over_goal": sum(1 for i in items if (i["answer_hours"] or i["waiting_hours"] or 0) > ANSWER_GOAL_HOURS),
        }
        data["first_time_authors"] = section("first-time", lambda: first_time_authors(client, items, since))
    data["opened"] = section("opened", lambda: {
        "issues": client.search(f"is:issue {window_query('created', since, until)}", COUNT_NODES, max_pages=1)[0],
        "prs": client.search(f"is:pr {window_query('created', since, until)}", COUNT_NODES, max_pages=1)[0],
    })
    data["partners"] = section("partners", lambda: collect_partners(client, since, until, team))
    data["merged"] = section("merged", lambda: collect_merged(client, since, until, team))
    data["reach"] = section("reach", lambda: collect_reach(client, since, until, team))
    data["traffic"] = section("traffic", lambda: collect_traffic(client, since, until, now))
    data["first_run"] = section("first-run", lambda: collect_first_run(client, since, head["sha"]))
    return data


# ---------------------------------------------------------------------------- rendering

def hours(value: float | None) -> str:
    return "n/a" if value is None else f"{value:g} h"


def duration(seconds: float | None) -> str:
    if seconds is None:
        return "n/a"
    minutes, rest = divmod(seconds, 60)
    return f"{int(minutes)} min {rest:04.1f} s" if minutes else f"{rest:.1f} s"


def render(data: dict[str, Any]) -> str:
    since, until, main = data["since"], data["until"], data["main"]
    lines = [
        f"# Lead measures for {data['repo']}: {since[:10]} to {until[:10]} (UTC)",
        "",
        f"Counted by `scripts/lead_measures.py` at {data['generated']}. `{main['branch']}` is at `{main['sha'][:8]}` "
        f"({main['date'][:10]}). \"Outside\" means a person who is not one of {', '.join(data['team']) or 'the team'}, "
        "not a bot, and has no owner, member or collaborator rights "
        "([definitions](docs/product/lead-measures.md)).",
        "",
    ]

    def bad(name: str) -> str | None:
        value = data.get(name)
        return value["unavailable"] if isinstance(value, dict) and "unavailable" in value else None

    rows: list[tuple[str, str, str]] = []
    partners = data["partners"]
    if bad("partners"):
        rows.append(("1. Outside installs reported", "unavailable", bad("partners") or ""))
    else:
        new = ", ".join(partners["installs_new"]) or "none"
        rows.append(("1. Outside installs reported", f"{len(partners['installs_new'])} new ({new})",
                     f"{partners['installs_total']} in total, from {partners['reports_total']} partner feedback issues"))
    items = data["outside_items"]
    if bad("outside_items"):
        rows.append(("2. Outside issues, PRs and discussions", "unavailable", bad("outside_items") or ""))
        rows.append(("3. Median time to a first answer", "unavailable", ""))
    else:
        by_kind = {kind: sum(1 for i in items if i["kind"] == kind) for kind in ("issue", "pull request", "discussion")}
        first = data.get("first_time_authors")
        first_text = "unavailable" if isinstance(first, dict) else (", ".join(first) or "none")
        rows.append(("2. Outside issues, PRs and discussions opened",
                     f"issues {by_kind['issue']}, PRs {by_kind['pull request']}, discussions {by_kind['discussion']}",
                     f"first-time contributors: {first_text}"))
        answers = data["answers"]
        if not items:
            rows.append(("3. Median time to a first answer", "no data", "no outside item was opened"))
        else:
            rows.append(("3. Median time to a first answer", hours(answers["median_hours"]),
                         f"{answers['answered']} answered, {answers['unanswered']} waiting, {answers['over_goal']} over the "
                         f"{ANSWER_GOAL_HOURS:g} working-hour goal (weekends excluded)"))
    run = data["first_run"]
    if bad("first_run"):
        rows.append(("4. Time to first run on `main`", "unavailable", bad("first_run") or ""))
    elif run.get("run") is None:
        rows.append(("4. Time to first run on `main`", "never measured", f"dispatch the {TTFR_WORKFLOW} workflow"))
    else:
        ahead = run.get("main_ahead_by")
        note = f"run {run['run']} on {run['created'][:10]} at `{run['revision'][:8]}`" + (f", `main` is {ahead} commits ahead" if ahead else "")
        if run["stale"]:
            note += "; **stale: older than this window, dispatch it again**"
        cold, warm = run.get("cold"), run.get("warm")
        rows.append(("4. Time to first run on `main` (clone to logins, Linux amd64)", f"cold {duration(cold)}, warm {duration(warm)}", note))
    merged = data["merged"]
    if bad("merged"):
        rows.append(("5. Merged PRs", "unavailable", bad("merged") or ""))
    else:
        types = ", ".join(f"{count} {kind}" for kind, count in merged["types"].items())
        partial = f" (types and outside count only the first {merged['counted']})" if merged["counted"] < merged["total"] else ""
        rows.append(("5. Merged PRs", str(merged["total"]), f"{types or 'none'}; {merged['outside']} from outside{partial}"))
    lines += ["| Lead measure | This window | Context |", "| --- | --- | --- |"]
    lines += [f"| {a} | {b} | {c} |" for a, b, c in rows]

    lines += ["", "Reach signals. These are not adoption: a star is not an install (rule 17).", "",
              "| Signal | This window | Context |", "| --- | --- | --- |"]
    reach = data["reach"]
    if bad("reach"):
        lines.append(f"| Stars, forks, labelled issues | unavailable | {bad('reach')} |")
    else:
        lines += [
            f"| Stars | +{reach['stars_new']} ({reach['stars_outside']} outside) | {reach['stars_total']} in total |",
            f"| Forks | +{reach['forks_new']} ({reach['forks_outside']} outside) | {reach['forks_total']} in total |",
            f"| Open `good first issue` / `help wanted` | {reach['good_first_issues_open']} / {reach['help_wanted_open']} | L-2 asks for at least 5 |",
        ]
    opened = data["opened"]
    if not bad("opened"):
        lines.append(f"| Issues and PRs opened by anyone | issues {opened['issues']}, PRs {opened['prs']} | mostly us |")
    traffic = data["traffic"]
    if bad("traffic"):
        lines.append(f"| Repository page views and clones | unavailable | {bad('traffic')} |")
    else:
        part = "; the traffic API keeps 14 days, so earlier days are missing" if traffic["partial"] else ""
        sites = ", ".join(f"{r['site']} {r['count']}" for r in traffic["referrers_14d"]) or "none"
        lines += [
            f"| Repository page views | {traffic['views']['count']} (sum of daily unique visitors: {traffic['views']['daily_uniques']}) | includes us{part} |",
            f"| Repository clones | {traffic['clones']['count']} (sum of daily unique cloners: {traffic['clones']['daily_uniques']}) | includes CI and agents |",
            f"| Top referrers of the repository page, last 14 days | {sites} | |",
        ]
    lines += ["| Documentation site visits | not collected | GitHub Pages has no analytics and we add no tracking |"]

    if not bad("outside_items") and items:
        lines += ["", "Outside items:", ""]
        for item in items:
            state = f"answered by {item['answered_by']} after {hours(item['answer_hours'])}" if item["answered_at"] \
                else f"**waiting {hours(item['waiting_hours'])}**"
            lines.append(f"- [{item['kind']} #{item['number']}]({item['url']}) by {item['author']}, {state}: {item['title']}")
    if not bad("partners") and partners["reports"]:
        lines += ["", "Partner feedback this window:", ""]
        for report in partners["reports"]:
            time = f", time: {report['time']}" if report["time"] else ""
            counted = "counted" if report["counted"] else "not counted"
            lines.append(f"- [#{report['number']}]({report['url']}) by {report['author']} ({counted}): {report['step']}; {report['impact']}{time}")
    return "\n".join(lines) + "\n"


# ------------------------------------------------------------------------------- command

def main(argv: list[str] | None = None, runner: Runner = run_gh, now: datetime | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", default=DEFAULT_REPO, help=f"owner/name (default {DEFAULT_REPO})")
    parser.add_argument("--since", type=parse_when, help="start of the window (default: 7 days before --until)")
    parser.add_argument("--until", type=parse_when, help="end of the window (default: now)")
    parser.add_argument("--team", action="append", default=[], metavar="LOGIN",
                        help="a login that counts as the team, besides the CODEOWNERS (repeatable)")
    parser.add_argument("--json", action="store_true", help="print JSON instead of Markdown")
    args = parser.parse_args(argv)
    now = now or datetime.now(timezone.utc)
    until = args.until or now
    since = args.since or until - timedelta(days=7)
    if since >= until:
        parser.error("--since must be before --until")
    if runner is run_gh and not shutil.which("gh"):
        print("ERROR: gh is not installed or not on PATH (https://cli.github.com/); run `gh auth login`.", file=sys.stderr)
        return 2
    team = team_logins(ROOT / ".github" / "CODEOWNERS", args.team)
    try:
        data = collect(Client(args.repo, runner), since, until, team, now)
    except GhError as error:
        print(f"ERROR: {error}. Is `gh auth status` logged in with access to {args.repo}?", file=sys.stderr)
        return 1
    print(json.dumps(data, indent=2) if args.json else render(data), end="" if not args.json else "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
