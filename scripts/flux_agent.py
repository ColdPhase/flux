#!/usr/bin/env python3
"""Start a Flux development worker from its configured GitHub milestone."""

import argparse
import json
import os
from pathlib import Path
import re
import sys

from flux_harness.github import GitHub, HarnessError
from flux_harness.state import State
from flux_harness.options import execution_options, saved_options
from flux_harness.worker import configuration, preflight, run, scope_check


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in ("doctor", "run", "status", "stop", "message"):
        sub = subparsers.add_parser(name)
        sub.add_argument("--worker", required=True)
        if name in ("doctor", "run"):
            sub.add_argument("--model", help="Provider model ID or alias; saved for later runs")
            sub.add_argument("--reasoning-effort", help="Provider reasoning effort (for example medium or high)")
            sub.add_argument("--use-cli-defaults", action="store_true",
                             help="Clear saved overrides before applying any explicit flags")
        if name == "doctor":
            sub.add_argument("--offline", action="store_true")
        elif name == "run":
            sub.add_argument("--once", action="store_true")
            sub.add_argument("--dry-run", action="store_true")
        elif name == "stop":
            sub.add_argument("--after-turn", action="store_true", help="Finish the current checkpoint, then stop")
        elif name == "message":
            sub.add_argument("--issue", type=int, required=True)
            sub.add_argument("--id", required=True)
            sub.add_argument("--body-file", type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    os.umask(0o077)
    try:
        config, worker = configuration(root, args.worker)
        directory = root / ".harness/local" / args.worker
        if args.command == "doctor":
            report = preflight(root, config, worker, live=not args.offline)
            report["execution"] = execution_options(worker["provider"], saved_options(directory),
                args.model, args.reasoning_effort, args.use_cli_defaults)
            print(json.dumps(report, indent=2))
        elif args.command == "run":
            return run(root, args.worker, args.once, args.dry_run, args.model,
                       args.reasoning_effort, args.use_cli_defaults)
        elif args.command == "stop":
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            (directory / ("drain.request" if args.after_turn else "stop.request")).touch(mode=0o600)
            print("Stop requested" + (" after the current checkpoint" if args.after_turn else "") +
                  ". Worktrees and journal are preserved.")
        elif args.command == "status":
            if not (directory / "journal.sqlite3").exists():
                print("No local run recorded for this worker.")
                return 0
            state = State(directory)
            try:
                print(json.dumps({key: state.get(key) for key in (
                    "status", "run_pid", "active_turn", "last_result", "last_error", "parked",
                    "execution_options", "recovery", "saved_worktrees", "product_acceptance")}, indent=2))
            finally:
                state.close()
        elif args.command == "message":
            if args.issue <= 0 or not re.fullmatch(r"[A-Za-z0-9:._-]{1,200}", args.id):
                raise HarnessError("Use a positive issue number and a stable alphanumeric message ID")
            github = GitHub(config["github"]["repository"], root)
            github.verify_identity(worker)
            issue = github.api(f"{github.prefix}/issues/{args.issue}")
            number = (issue.get("milestone") or {}).get("number")
            if number is None:
                raise HarnessError("Message target must belong to a product milestone")
            scope_check(config, github.milestone(number))
            body = args.body_file.read_text(encoding="utf-8")
            if not body.strip():
                raise HarnessError("Message body is empty")
            state = State(directory)
            try:
                message_id = f"{args.worker}:{args.id}"
                state.stage_message(message_id, args.issue, body)
                response = github.comment_once(args.issue, body, message_id, worker["github_login"])
                state.delivered(message_id, response["id"])
                print(response["html_url"])
            finally:
                state.close()
        return 0
    except (HarnessError, OSError, ValueError, KeyError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
