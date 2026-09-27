"""GitHub transport. Commands use argv and structured stdin, never shell text."""

import hashlib
import json
import subprocess
import time


class HarnessError(RuntimeError):
    """An actionable failure that must not be reported as completion."""


def digest(value):
    text = value if isinstance(value, str) else json.dumps(value, sort_keys=True, ensure_ascii=False)
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def command(argv, cwd=None, data=None, timeout=60):
    try:
        result = subprocess.run(argv, cwd=cwd, input=data, text=True,
                                capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise HarnessError(f"{argv[0]} could not complete: {error}") from error
    if result.returncode:
        raise HarnessError(f"{argv[0]} exited {result.returncode}: {result.stderr.strip()[:1000]}")
    return result.stdout


class GitHub:
    def __init__(self, repository, cwd):
        self.repository, self.cwd = repository, cwd
        self.prefix = f"repos/{repository}"
        self.deadline = None

    def api(self, endpoint, method="GET", data=None):
        argv = ["gh", "api", "--hostname", "github.com", endpoint, "--method", method]
        if data is not None:
            argv += ["--input", "-"]
        timeout = 30 if self.deadline is None else min(30, self.deadline - time.monotonic())
        if timeout <= 0:
            raise HarnessError("Run time limit reached during GitHub reconciliation")
        result = json.loads(command(argv, self.cwd, json.dumps(data) if data is not None else None, timeout))
        if isinstance(result, dict) and result.get("errors"):
            raise HarnessError("GitHub returned GraphQL errors; inbox is incomplete")
        return result

    def pages(self, endpoint, key=None):
        items, page = [], 1
        separator = "&" if "?" in endpoint else "?"
        while True:
            result = self.api(f"{endpoint}{separator}per_page=100&page={page}")
            batch = result[key] if key else result
            if not isinstance(batch, list):
                raise HarnessError("GitHub pagination did not return a list")
            items.extend(batch)
            if len(batch) < 100:
                return items
            page += 1

    def comments(self, number):
        return self.pages(f"{self.prefix}/issues/{number}/comments")

    def milestone(self, number):
        return self.api(f"{self.prefix}/milestones/{number}")

    def verify_identity(self, worker):
        login = self.api("user")["login"]
        if login.casefold() != worker["github_login"].casefold():
            raise HarnessError(f"Worker {worker['id']} requires gh account {worker['github_login']}; got {login}")
        repository = self.api(self.prefix)
        if not repository.get("permissions", {}).get("push"):
            raise HarnessError("The authenticated worker needs repository write access")
        return login

    def review_threads(self, number):
        owner, name = self.repository.split("/")
        query = """query($owner:String!,$name:String!,$number:Int!,$after:String){
          repository(owner:$owner,name:$name){pullRequest(number:$number){
            reviewThreads(first:100,after:$after){nodes{id isResolved isOutdated path line}
              pageInfo{hasNextPage endCursor}}}}}"""
        threads, after = [], None
        while True:
            data = self.api("graphql", "POST", {"query": query, "variables": {
                "owner": owner, "name": name, "number": number, "after": after}})
            connection = data["data"]["repository"]["pullRequest"]["reviewThreads"]
            threads.extend(connection["nodes"])
            if not connection["pageInfo"]["hasNextPage"]:
                return threads
            after = connection["pageInfo"]["endCursor"]

    def snapshot(self, number):
        milestone = self.milestone(number)
        records = self.pages(f"{self.prefix}/issues?milestone={number}&state=all&sort=created&direction=asc")
        issues, pr_numbers = [], set()
        for record in records:
            if "pull_request" in record:
                pr_numbers.add(record["number"])
                continue
            item = {key: record.get(key) for key in (
                "number", "title", "body", "state", "state_reason", "user",
                "assignees", "labels", "milestone", "html_url", "updated_at")}
            item["comments"] = self.comments(record["number"])
            timeline = self.pages(f"{self.prefix}/issues/{record['number']}/timeline")
            item["events"] = [event for event in timeline if event.get("event") in (
                "assigned", "unassigned", "milestoned", "demilestoned", "reopened",
                "closed", "labeled", "unlabeled", "cross-referenced")]
            for event in timeline:
                source = event.get("source", {}).get("issue", {})
                if (source.get("pull_request") and source.get("repository_url") ==
                        f"https://api.github.com/{self.prefix}"):
                    pr_numbers.add(source["number"])
            issues.append(item)
        pulls = []
        for pr in sorted(pr_numbers):
            item = self.api(f"{self.prefix}/pulls/{pr}")
            sha = item["head"]["sha"]
            pulls.append({
                "number": pr, "title": item["title"], "body": item["body"],
                "state": item["state"], "draft": item["draft"], "user": item["user"],
                "head_sha": sha, "head_ref": item["head"]["ref"],
                "base_ref": item["base"]["ref"], "merged_at": item["merged_at"],
                "merge_commit_sha": item["merge_commit_sha"],
                "mergeable_state": item["mergeable_state"], "html_url": item["html_url"],
                "comments": self.comments(pr),
                "reviews": self.pages(f"{self.prefix}/pulls/{pr}/reviews"),
                "review_comments": self.pages(f"{self.prefix}/pulls/{pr}/comments"),
                "review_threads": self.review_threads(pr),
                "checks": self.pages(f"{self.prefix}/commits/{sha}/check-runs", "check_runs"),
                "statuses": self.pages(f"{self.prefix}/commits/{sha}/statuses"),
            })
        return {"milestone": {key: milestone.get(key) for key in (
            "number", "title", "description", "state", "html_url")},
            "issues": issues, "pull_requests": pulls}

    def comment_once(self, number, body, message_id, login):
        """Reconcile before retrying, including a POST that succeeded before a timeout."""
        marker = f"<!-- flux-message:{message_id} -->"
        full_body = marker + "\n" + body
        existing = [item for item in self.comments(number)
                    if marker in item.get("body", "") and
                    item.get("user", {}).get("login", "").casefold() == login.casefold()]
        if len(existing) > 1:
            raise HarnessError("Duplicate message IDs exist; reconcile before continuing")
        if existing:
            if existing[0]["body"] != full_body:
                raise HarnessError("Message ID already has different content; use a new revision ID")
            return existing[0]
        return self.api(f"{self.prefix}/issues/{number}/comments", "POST", {"body": full_body})
