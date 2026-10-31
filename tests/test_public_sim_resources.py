"""The simulated public host's resource summary (#63 AC-1): per measured window, from docker stats samples."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "docker/public-sim/resources.py"


def sample(t: float, name: str, cpu: str, mem: str, net: str) -> str:
    return json.dumps({"t": t, "s": {"Name": f"flux-public-sim-1793442173-3938455-{name}", "CPUPerc": cpu, "MemUsage": mem, "NetIO": net}})


class PublicSimResourcesTest(unittest.TestCase):
    def summarize(self, lines: list[str]) -> dict:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "resources.jsonl"
            path.write_text("\n".join(lines) + "\n")
            result = subprocess.run([sys.executable, "-I", str(SCRIPT), str(path)], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_window_rates_from_cumulative_bytes(self) -> None:
        summary = self.summarize([
            sample(100.0, "livekit-1", "2.0%", "50MiB / 61GiB", "1MB / 2MB"),
            '{"t": 101.0, "mark": "run-1 motion begin"}',
            sample(102.0, "livekit-1", "10.0%", "60MiB / 61GiB", "2MB / 4.5MB"),
            sample(104.0, "livekit-1", "20.0%", "70MiB / 61GiB", "3MB / 7MB"),
            '{"t": 105.0, "mark": "run-1 motion end"}',
            sample(106.0, "livekit-1", "1.0%", "70MiB / 61GiB", "3MB / 7MB"),
            "not json",
        ])
        window = summary["windows"]["run-1 motion"]
        self.assertEqual(window["seconds"], 4.0)
        sfu = window["services"]["livekit-1"]
        self.assertEqual((sfu["samples"], sfu["cpuMeanPct"], sfu["cpuPeakPct"]), (2, 15.0, 20.0))
        self.assertEqual(sfu["memPeakMB"], 73.4)
        # 5 MB sent and 2 MB received over the 6 s between the samples around the window.
        self.assertEqual((sfu["txMbps"], sfu["rxMbps"]), (6.67, 2.67))

    def test_unfinished_window_is_left_out(self) -> None:
        summary = self.summarize([sample(1.0, "api-1", "1%", "1MB / 2GB", "0B / 0B"), '{"t": 2.0, "mark": "run-2 weak begin"}'])
        self.assertEqual(summary["windows"], {})


if __name__ == "__main__":
    unittest.main()
