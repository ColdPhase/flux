"""scripts/perf_compare_report.py on a small made-up comparison: server times paired by request id, medians over rounds, verdicts."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/perf_compare_report.py"


def write_side(side: Path, rounds: int, ms: float, statements: int, idle: int, seed: str) -> None:
    side.mkdir(parents=True)
    log = []
    for number in range(1, rounds + 1):
        rdir = side / f"round-{number}"
        rdir.mkdir()
        rows = [{"type": "plan", "views": [{"view": "Home", "requests": [{"label": "me", "method": "GET", "path": "/api/v1/me"},
                                                                          {"label": "since you left", "method": "GET", "path": "/api/v1/return?place=home"}]}]},
                {"type": "count", "phase": "isolated", "label": "me", "method": "GET", "path": "/api/v1/me", "statements": 3},
                {"type": "count", "phase": "isolated", "label": "since you left", "method": "GET", "path": "/api/v1/return?place=home",
                 "statements": statements},
                {"type": "window", "phase": "isolated", "start": 0, "end": 1}]
        for phase in ("warm @2 vcpu", "concurrent @1.0 cpu"):
            for i in range(20):
                for label in ("me", "since you left"):
                    req = f"{seed}-{number}-{phase}-{label}-{i}"
                    rows.append({"type": "client", "view": "Home", "label": label, "method": "GET", "path": "/x", "status": 200, "ms": 999, "reqId": req})
                    log.append(json.dumps({"msg": "request completed", "reqId": req, "responseTime": ms + number + (30 if label == "since you left" else 0)}))
            rows.append({"type": "window", "phase": phase, "start": 0, "end": 1})
        (rdir / "measure.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
        (rdir / "idle.json").write_text(json.dumps({"statements": idle, "apiCpu": 0.2, "workerCpu": 0.2, "dbCpu": 0.4}))
        (rdir / "idle-memory.tsv").write_text(f"a\t1\tapi\t{200 + number}.0\na\t1\tworker\t120.0\n")
        (rdir / "browser.json").write_text(json.dumps({"loads": [{"usableMs": 900, "codeBytesBeforeUsable": 240 * 1024, "codeBytesUntilQuiet": 700 * 1024,
                                                                   "openMs": 300, "openRequests": 7, "openStatements": 120, "openAddresses": ["GET me"]}]}))
    (side / "api.log").write_text("\n".join(log) + "\n")
    (side / "bundle.txt").write_text("First screen: 36 files (30 JS, 6 CSS), 900 KB raw, 241 KB brotli (target at most 250 KB brotli before content)\n")


class PerfCompareReport(unittest.TestCase):
    def test_table_medians_and_verdicts(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            (out / "meta.json").write_text(json.dumps({"base": {"ref": "v0.2.0", "sha": "a" * 40}, "head": {"ref": "main", "sha": "b" * 40},
                                                       "rounds": 3, "runs": 20, "browserLoads": 1, "hostCpus": 4, "serverCpus": "0,1",
                                                       "clientCpus": "2,3", "scripts": "c" * 40}))
            write_side(out / "a", 3, 10, 40, 95, "a")
            write_side(out / "b", 3, 20, 46, 120, "b")
            result = subprocess.run([sys.executable, str(SCRIPT), str(out)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            lines = result.stdout.splitlines()

            def row(prefix):
                return next(line for line in lines if line.startswith(f"| {prefix}"))

            # p95 of me+since you left in round 2 is 10+2+30 = 42 (base) and 52 (head): medians of the rounds, ranges, a breach.
            self.assertIn("| 42 [41–43] | 52 [51–53] | +24 % | ≤ 50 | BREACH, regression |", row("API p95, all requests, warm @2 vcpu"))
            self.assertIn("| 43 | 49 | +14 % |  | regression |", row("Statements, one of each distinct request"))
            self.assertIn("BREACH, regression", row("Idle: statements a minute"))
            self.assertIn("same", row("Cold load: JS+CSS on the wire before usable"))
            self.assertIn("since you left", result.stdout.split("Statements per request that changed")[1])
            data = json.loads((out / "compare.json").read_text())
            self.assertEqual(data["meta"]["head"]["ref"], "main")


if __name__ == "__main__":
    unittest.main()
