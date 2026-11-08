"""The performance report (scripts/perf_report.py, #298, #827). The API's request log has no query string, so a server time is matched to
its request by id; a path alone is used only when no other request of the plan shares it."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("flux_perf_report", ROOT / "scripts/perf_report.py")
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)

SEARCH_A = "/api/v1/search?q=LoRa&limit=20"
SEARCH_B = "/api/v1/search?q=frost&limit=8"
WORK_OPEN = "/api/v1/projects/p/work-view?group=open"
WORK_DONE = "/api/v1/projects/p/work-view?group=finished"
ME = "/api/v1/me"
PLAN = {"type": "plan", "views": [
    {"view": "Search", "requests": [{"label": "search", "method": "GET", "path": SEARCH_A}]},
    {"view": "Jump to", "requests": [{"label": "jump to", "method": "GET", "path": SEARCH_B}]},
    {"view": "Tasks", "requests": [{"label": "open", "method": "GET", "path": WORK_OPEN}, {"label": "finished", "method": "GET", "path": WORK_DONE}]},
    {"view": "Shell", "requests": [{"label": "me", "method": "GET", "path": ME}]},
]}


def served(request_id, url, ms, at, status=200):
    """The two log lines Fastify writes for one request; the url has no query string."""
    return [json.dumps({"time": at, "reqId": request_id, "msg": "incoming request", "req": {"method": "GET", "url": url.split("?")[0]}}),
            json.dumps({"time": at, "reqId": request_id, "msg": "request completed", "res": {"statusCode": status}, "responseTime": ms})]


def summarise(measure, log):
    rows, phases = summarise_all(measure, log)
    return {row["path"]: row for row in rows}, phases


def summarise_all(measure, log):
    with tempfile.TemporaryDirectory() as directory:
        measure_path, log_path = Path(directory, "measure.jsonl"), Path(directory, "api.log")
        measure_path.write_text("\n".join(json.dumps(row) for row in measure) + "\n", encoding="utf-8")
        log_path.write_text("\n".join(log) + "\n", encoding="utf-8")
        rows, phases, _ = report.summarise(str(measure_path), str(log_path))
    return rows, phases


def client(request_id, path):
    return {"type": "client", "method": "GET", "path": path, "label": "x", "reqId": request_id}


class PerfReport(unittest.TestCase):
    def test_requests_that_share_a_path_are_told_apart_by_their_id(self) -> None:
        measure = [PLAN, {"type": "window", "phase": "warm", "start": 100, "end": 200},
                   client("perf-a-1", SEARCH_A), client("perf-a-2", SEARCH_B), client("perf-a-3", WORK_OPEN), client("perf-a-4", WORK_DONE)]
        log = [*served("perf-a-1", SEARCH_A, 30, 110), *served("perf-a-2", SEARCH_B, 5, 111),
               *served("perf-a-3", WORK_OPEN, 12, 112), *served("perf-a-4", WORK_DONE, 40, 113)]
        rows, _ = summarise(measure, log)
        self.assertEqual({path: row["phases"]["warm"]["p50"] for path, row in rows.items() if "warm" in row["phases"] and row["phases"]["warm"]["n"]},
                         {SEARCH_A: 30, SEARCH_B: 5, WORK_OPEN: 12, WORK_DONE: 40})

    def test_every_planned_request_with_a_query_gets_its_server_time(self) -> None:
        # 41 of 41, not 12 of 41: the rows with a query string used to show "–" in every run.
        measure = [PLAN, {"type": "window", "phase": "warm", "start": 100, "end": 200}]
        log = []
        for number, path in enumerate([SEARCH_A, SEARCH_B, WORK_OPEN, WORK_DONE, ME]):
            measure.append(client(f"perf-b-{number}", path))
            log += served(f"perf-b-{number}", path, 10 + number, 120 + number)
        rows, _ = summarise(measure, log)
        self.assertEqual([row["phases"]["warm"]["n"] for row in rows.values()], [1] * 5)

    def test_a_log_line_without_an_id_is_matched_by_path_only_when_the_path_is_the_plans_alone(self) -> None:
        measure = [PLAN, {"type": "window", "phase": "warm", "start": 100, "end": 200}]
        log = [*served("req-1", ME, 7, 130), *served("req-2", SEARCH_A, 99, 131)]
        rows, _ = summarise(measure, log)
        self.assertEqual(rows[ME]["phases"]["warm"]["p50"], 7, "/me is the only request of the plan with that path")
        self.assertEqual(rows[SEARCH_A]["phases"]["warm"]["n"], 0, "two requests share /search, so an unmarked line belongs to neither")
        self.assertEqual(rows[SEARCH_B]["phases"]["warm"]["n"], 0)

    def test_only_requests_inside_a_window_count_and_errors_are_reported(self) -> None:
        measure = [PLAN, {"type": "window", "phase": "warm", "start": 100, "end": 200}, client("perf-c-1", ME), client("perf-c-2", ME), client("perf-c-3", ME)]
        log = [*served("perf-c-1", ME, 4, 150), *served("perf-c-2", ME, 6, 160, status=500), *served("perf-c-3", ME, 900, 400)]
        rows, _ = summarise(measure, log)
        stats = rows[ME]["phases"]["warm"]
        self.assertEqual((stats["n"], stats["errors"]), (2, 1))




class PerfTargets(unittest.TestCase):
    """#850 AC-3: the CPU-limited phase (its name ends in "@<n> cpu") is held to p95 <= 50 ms, and the report names what is over."""

    def test_a_cpu_limited_phase_passes_or_names_the_requests_over_the_target(self) -> None:
        measure = [PLAN, {"type": "window", "phase": "warm @1.0 cpu", "start": 100, "end": 200}, client("perf-d-1", ME), client("perf-d-2", WORK_OPEN)]
        quick = [*served("perf-d-1", ME, 8, 150), *served("perf-d-2", WORK_OPEN, 31, 151)]
        rows, phases = summarise_all(measure, quick)
        passing = report.target_lines(rows, phases)
        self.assertEqual(len(passing), 1)
        self.assertIn("warm @1.0 cpu: PASS", passing[0])
        slow = [*served("perf-d-1", ME, 8, 150), *served("perf-d-2", WORK_OPEN, 77, 151)]
        rows, phases = summarise_all(measure, slow)
        failing = report.target_lines(rows, phases)[0]
        self.assertIn("warm @1.0 cpu: FAIL", failing)
        self.assertIn("Tasks: open p95 77 ms", failing)
        self.assertNotIn("me p95", failing, "a request under the target is not listed")

    def test_a_phase_without_a_cpu_limit_is_not_judged(self) -> None:
        measure = [PLAN, {"type": "window", "phase": "warm", "start": 100, "end": 200}, client("perf-e-1", ME)]
        rows, phases = summarise_all(measure, served("perf-e-1", ME, 400, 150))
        self.assertEqual(report.target_lines(rows, phases), [])


if __name__ == "__main__":
    unittest.main()
