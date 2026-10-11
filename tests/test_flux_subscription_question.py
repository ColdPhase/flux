"""The launcher's subscription sign-in question (F-027 AST-1.3 and AST-1.4, issue #410).

Runs the real `flux` launcher with a stub `docker` (the fake host check: what the engine reports, whether it
can make an internal network and what its kernel's Yama policy is) and a pseudo-terminal as the fake TTY.
No Docker resource is created and nothing leaves the temporary checkout.
"""

from __future__ import annotations

import os
import pty
import re
import select
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TODAY = "2026-10-11"

# The engine as `docker info --format '{{json .}}'` reports it, trimmed to what the launcher reads.
INFO_OK = '{"OSType":"linux","OperatingSystem":"Ubuntu 24.04","MemoryLimit":true,"CpuCfsQuota":true,"PidsLimit":true}'
INFO_SCENARIOS = {
    "not-linux": '{"OSType":"windows","MemoryLimit":true,"CpuCfsQuota":true,"PidsLimit":true}',
    "pids-off": '{"OSType":"linux","MemoryLimit":true,"CpuCfsQuota":true,"PidsLimit":false}',
}

DOCKER_STUB = r"""#!/bin/sh
printf '%s\n' "$*" >> "$FLUX_AI_TEST_LOG"
case "$1" in
  info)
    if [ "${2:-}" = --format ]; then
      [ "$FLUX_AI_TEST_HOST" != info-failed ] || exit 1
      printf '%s\n' "$FLUX_AI_TEST_INFO"
    fi ;;
  network)
    [ "$2" != create ] || [ "$FLUX_AI_TEST_HOST" != no-internal ] || exit 1 ;;
  run)
    case "$FLUX_AI_TEST_HOST" in
      probe-failed) exit 125 ;;
      no-yama) exit 1 ;;
      yama0) printf '0\n' ;;
      *) printf '1\n' ;;
    esac ;;
  compose)
    case "$*" in
      *'config --services') printf 'runtime-1\n' ;;
      *'generate-vapid-keys'*) printf '{"publicKey":"PUBLIC","privateKey":"PRIVATE"}\n' ;;
    esac ;;
esac
exit 0
"""

DATE_STUB = """#!/bin/sh
case "$*" in
  '+%Y-%m-%d') printf '{today}\\n' ;;
  *) exec "{real}" "$@" ;;
esac
"""

# Words that only the questions print. Their absence proves nothing was asked.
Q1 = "Let people on this Flux sign in with their own ChatGPT and Claude"
Q2 = "Anthropic's Commercial Terms (for example by creating a Console"
STAYS_OFF = "Subscription sign-in stays off:"


class Terminal:
    """A launcher process whose stdin, stdout and stderr are one pseudo-terminal."""

    def __init__(self, args: list[str], env: dict[str, str], cwd: Path) -> None:
        self.master, slave = pty.openpty()
        self.proc = subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave, cwd=cwd, env=env,
                                     close_fds=True, start_new_session=True)
        os.close(slave)
        self.output = ""
        self.pos = 0
        self.closed = False

    def _read(self, timeout: float) -> None:
        if self.closed or not select.select([self.master], [], [], timeout)[0]:
            return
        try:
            data = os.read(self.master, 4096)
        except OSError:  # Linux: EIO once the slave side is gone
            data = b""
        if data:
            self.output += data.decode(errors="replace")
        else:
            self.closed = True

    def expect(self, text: str, timeout: float = 20) -> None:
        deadline = time.monotonic() + timeout
        while True:
            index = self.output.find(text, self.pos)
            if index >= 0:
                self.pos = index + len(text)
                return
            if self.closed or time.monotonic() > deadline:
                self.proc.kill()
                raise AssertionError(f"never saw {text!r}; output so far:\n{self.output}")
            self._read(0.2)

    def send(self, line: str) -> None:
        os.write(self.master, line.encode())

    def finish(self, timeout: float = 30) -> int:
        deadline = time.monotonic() + timeout
        while not self.closed:
            if time.monotonic() > deadline:
                self.proc.kill()
                raise AssertionError(f"the launcher is still waiting; output:\n{self.output}")
            self._read(0.2)
        code = self.proc.wait(timeout=10)
        os.close(self.master)
        return code


class SubscriptionQuestionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="flux-ai-question-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.checkout = self.base / "checkout"
        (self.checkout / "docker").mkdir(parents=True)
        shutil.copy2(ROOT / "flux", self.checkout / "flux")
        shutil.copy2(ROOT / "docker/.env.example", self.checkout / "docker/.env.example")
        shutil.copy2(ROOT / "docker/Dockerfile", self.checkout / "docker/Dockerfile")
        self.env_file = self.checkout / "docker/.env"
        bin_dir = self.base / "bin"
        bin_dir.mkdir()
        (bin_dir / "docker").write_text(DOCKER_STUB)
        (bin_dir / "date").write_text(DATE_STUB.format(today=TODAY, real=shutil.which("date")))
        for stub in bin_dir.iterdir():
            stub.chmod(0o700)
        self.log = self.base / "docker-calls"
        self.bin_dir = bin_dir

    # --- helpers ---------------------------------------------------------------------------------

    def environment(self, host: str = "ok", **extra: str) -> dict[str, str]:
        env = {k: v for k, v in os.environ.items() if not k.startswith("FLUX_")}
        env.update(PATH=f"{self.bin_dir}:{os.environ['PATH']}", FLUX_AI_TEST_LOG=str(self.log),
                   FLUX_AI_TEST_HOST=host, FLUX_AI_TEST_INFO=INFO_SCENARIOS.get(host, INFO_OK),
                   FLUX_WAIT_TIMEOUT="5")
        env.update(extra)
        return env

    def terminal(self, *args: str, host: str = "ok", **extra: str) -> Terminal:
        return Terminal([str(self.checkout / "flux"), *args], self.environment(host, **extra), self.base)

    def plain(self, *args: str, stdin: str | None = None, host: str = "ok", **extra: str) -> subprocess.CompletedProcess[str]:
        """No terminal: stdin is /dev/null or a pipe, stdout and stderr are pipes."""
        return subprocess.run([str(self.checkout / "flux"), *args], cwd=self.base, env=self.environment(host, **extra),
                              input=stdin, stdin=None if stdin is not None else subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=30)

    def value(self, key: str) -> str:
        match = re.search(rf"^{key}=(.*)$", self.env_file.read_text(), re.MULTILINE)
        self.assertIsNotNone(match, f"{key} is not in docker/.env")
        return match.group(1)

    def calls(self) -> list[str]:
        return self.log.read_text().splitlines() if self.log.exists() else []

    def checked_the_host(self) -> bool:
        return any(call.startswith(("network create", "run ")) for call in self.calls())

    def applied(self) -> bool:
        """Whether `up -d --wait` started the runtime profile."""
        return any("--profile runtime up -d --wait" in call for call in self.calls())

    def existing_env(self, runtime: str = "", terms: str = "") -> None:
        self.env_file.write_text(
            "FLUX_PROJECT=flux-ai-test\nFLUX_PORT=8081\nFLUX_PUBLIC_ORIGIN=http://127.0.0.1:8081\n"
            f"FLUX_AGENT_RUNTIME={runtime}\nFLUX_AGENT_RUNTIME_COMMERCIAL_TERMS={terms}\n"
            "FLUX_RUNTIME_MANAGER_SECRET=" + "a" * 64 + "\nFLUX_RUNTIME_SECRET_1=" + "b" * 64 + "\n")
        self.env_file.chmod(0o600)

    def first_up(self, *answers: str, host: str = "ok", **extra: str) -> Terminal:
        """`./flux up` on a fresh checkout under a terminal, answering each prompt in order."""
        term = self.terminal("up", host=host, **extra)
        for marker, answer in zip(("[Y/n]", "[y/N]"), answers):
            term.expect(marker)
            term.send(answer)
        return term

    # --- AST-1.3: ./flux up on a fresh checkout ---------------------------------------------------

    def test_enter_enter_writes_codex_and_no_statement(self) -> None:
        term = self.first_up("\n", "\n")
        self.assertEqual(term.finish(), 0, term.output)
        self.assertEqual(self.value("FLUX_AGENT_RUNTIME"), "codex")
        self.assertEqual(self.value("FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS"), "")
        self.assertEqual(term.output.count(Q1), 1)
        self.assertEqual(term.output.count(Q2), 1)
        self.assertIn("Claude Code stays off", term.output)
        self.assertTrue(self.applied(), "the runtime profile must start with the answer")

    def test_enter_then_typed_y_writes_both_clients_and_todays_statement(self) -> None:
        term = self.first_up("\n", "y\n")
        self.assertEqual(term.finish(), 0, term.output)
        self.assertEqual(self.value("FLUX_AGENT_RUNTIME"), "codex,claude_code")
        self.assertEqual(self.value("FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS"), TODAY)
        self.assertIn(f"that you accepted Anthropic's Commercial Terms on {TODAY}", term.output)
        self.assertEqual(term.output.count(Q1), 1)
        self.assertEqual(term.output.count(Q2), 1)
        self.assertTrue(self.applied())

    def test_n_writes_nothing_and_does_not_ask_about_claude_code(self) -> None:
        term = self.first_up("n\n")
        self.assertEqual(term.finish(), 0, term.output)
        self.assertEqual(self.value("FLUX_AGENT_RUNTIME"), "")
        self.assertEqual(self.value("FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS"), "")
        self.assertNotIn(Q2, term.output)
        self.assertIn("./flux ai on turns it on later", term.output)
        self.assertFalse(self.applied(), "an off instance starts without the runtime profile")

    def test_only_a_typed_yes_makes_the_commercial_terms_statement(self) -> None:
        for answer, statement in (("\n", False), ("n\n", False), ("maybe\n", False), ("Y\n", True), ("yes\n", True)):
            with self.subTest(answer=answer):
                self.env_file.unlink(missing_ok=True)
                term = self.first_up("\n", answer)
                self.assertEqual(term.finish(), 0, term.output)
                self.assertEqual(self.value("FLUX_AGENT_RUNTIME"), "codex,claude_code" if statement else "codex")
                self.assertEqual(self.value("FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS"), TODAY if statement else "")

    def test_an_unclear_answer_is_asked_again_and_three_of_them_mean_no(self) -> None:
        term = self.terminal("up")
        term.expect("[Y/n]")
        term.send("what\n")
        term.expect("Please answer y or n.")
        term.expect("[Y/n]")
        term.send("n\n")
        self.assertEqual(term.finish(), 0, term.output)
        self.assertEqual(term.output.count("Please answer y or n."), 1)
        self.assertEqual(self.value("FLUX_AGENT_RUNTIME"), "")
        self.env_file.unlink()
        term = self.terminal("up")
        for _ in range(3):
            term.expect("[Y/n]")
            term.send("what\n")
        self.assertEqual(term.finish(), 0, term.output)
        self.assertEqual(self.value("FLUX_AGENT_RUNTIME"), "")
        self.assertNotIn(Q2, term.output)

    def test_end_of_input_decides_nothing(self) -> None:
        term = self.first_up("\x04")
        self.assertEqual(term.finish(), 0, term.output)
        self.assertEqual(self.value("FLUX_AGENT_RUNTIME"), "")
        self.assertNotIn(Q2, term.output)
        self.env_file.unlink()
        term = self.first_up("\n", "\x04")
        self.assertEqual(term.finish(), 0, term.output)
        self.assertEqual(self.value("FLUX_AGENT_RUNTIME"), "codex")
        self.assertEqual(self.value("FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS"), "")

    def test_without_a_terminal_nothing_is_asked_checked_or_written(self) -> None:
        for label, run in (("dev-null", lambda: self.plain("up")),
                           ("piped answers", lambda: self.plain("up", stdin="\ny\n"))):
            with self.subTest(label=label):
                self.env_file.unlink(missing_ok=True)
                self.log.unlink(missing_ok=True)
                result = run()
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertNotIn(Q1, result.stdout + result.stderr)
                self.assertNotIn(STAYS_OFF, result.stdout + result.stderr)
                self.assertEqual(self.value("FLUX_AGENT_RUNTIME"), "")
                self.assertEqual(self.value("FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS"), "")
                self.assertFalse(self.checked_the_host(), "no terminal, so no host check either")
                self.assertFalse(self.applied())

    def test_a_terminal_on_input_only_is_not_enough(self) -> None:
        # stdout is a pipe (./flux up | tee log): the person could not see the question.
        master, slave = pty.openpty()
        self.addCleanup(os.close, master)
        self.addCleanup(os.close, slave)
        result = subprocess.run([str(self.checkout / "flux"), "up"], cwd=self.base, env=self.environment(),
                                stdin=slave, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn(Q1, result.stdout)
        self.assertEqual(self.value("FLUX_AGENT_RUNTIME"), "")

    def test_a_second_up_never_asks_again(self) -> None:
        for answers in (("n\n",), ("\n", "\n"), ("\n", "y\n")):
            with self.subTest(answers=answers):
                self.env_file.unlink(missing_ok=True)
                term = self.first_up(*answers)
                self.assertEqual(term.finish(), 0, term.output)
                before = self.env_file.read_bytes()
                again = self.terminal("up")  # no answers are sent: a question would block
                self.assertEqual(again.finish(), 0, again.output)
                self.assertNotIn("[Y/n]", again.output)
                self.assertNotIn(Q1, again.output)
                self.assertEqual(self.env_file.read_bytes(), before)

    def test_an_existing_env_file_is_never_asked_about_even_with_the_runtime_off(self) -> None:
        self.existing_env()
        before = self.env_file.read_bytes()
        term = self.terminal("up")
        self.assertEqual(term.finish(), 0, term.output)
        self.assertNotIn(Q1, term.output)
        self.assertEqual(self.env_file.read_bytes(), before)

    def test_a_choice_made_in_the_environment_skips_the_question(self) -> None:
        for value in ("", "codex"):
            with self.subTest(FLUX_AGENT_RUNTIME=value):
                self.env_file.unlink(missing_ok=True)
                self.log.unlink(missing_ok=True)
                term = self.terminal("up", FLUX_AGENT_RUNTIME=value)
                self.assertEqual(term.finish(), 0, term.output)
                self.assertNotIn(Q1, term.output)
                self.assertFalse(self.checked_the_host())
                self.assertEqual(self.value("FLUX_AGENT_RUNTIME"), "")

    def test_dev_does_not_ask(self) -> None:
        term = self.terminal("dev")
        self.assertEqual(term.finish(), 0, term.output)
        self.assertNotIn(Q1, term.output)
        self.assertEqual(self.value("FLUX_AGENT_RUNTIME"), "")

    # --- AST-1.4: a host whose check fails -------------------------------------------------------

    HOST_FAILURES = {
        "info-failed": "did not report its settings",
        "not-linux": "is not a Linux engine",
        "pids-off": "PidsLimit is off",
        "no-internal": "cannot create an internal network",
        "probe-failed": "check container could not be run",
        "no-yama": "no Yama ptrace_scope of 1 or higher",
        "yama0": "no Yama ptrace_scope of 1 or higher",
    }

    def test_a_failed_host_check_shows_no_question_and_says_why_in_one_line(self) -> None:
        for host, reason in self.HOST_FAILURES.items():
            with self.subTest(host=host):
                self.env_file.unlink(missing_ok=True)
                term = self.terminal("up", host=host)  # no answers: a question would block
                self.assertEqual(term.finish(), 0, term.output)
                self.assertNotIn(Q1, term.output)
                self.assertNotIn("[Y/n]", term.output)
                reasons = [line for line in term.output.splitlines() if STAYS_OFF in line]
                self.assertEqual(len(reasons), 1, term.output)
                self.assertIn(reason, reasons[0])
                self.assertEqual(self.value("FLUX_AGENT_RUNTIME"), "")
                self.assertFalse(self.applied())

    def test_the_host_check_asks_the_engine_and_cleans_up_after_itself(self) -> None:
        term = self.first_up("n\n")
        self.assertEqual(term.finish(), 0, term.output)
        calls = self.calls()
        created = [call for call in calls if call.startswith("network create --internal ")]
        self.assertEqual(len(created), 1, calls)
        name = created[0].rsplit(" ", 1)[1]
        self.assertIn(f"network rm {name}", calls)
        probe = [call for call in calls if call.startswith("run ")]
        self.assertEqual(len(probe), 1, calls)
        self.assertRegex(probe[0], r"--entrypoint cat node@sha256:[0-9a-f]{64} /proc/sys/kernel/yama/ptrace_scope$")
        for hardening in ("--rm", "--network none", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges"):
            self.assertIn(hardening, probe[0])

    # --- ./flux ai on ----------------------------------------------------------------------------

    def ai_on(self, *answers: str, host: str = "ok", **extra: str) -> Terminal:
        term = self.terminal("ai", "on", host=host, **extra)
        for marker, answer in zip(("[Y/n]", "[y/N]"), answers):
            term.expect(marker)
            term.send(answer)
        return term

    def test_ai_on_asks_the_same_questions_and_applies_the_answer(self) -> None:
        for answers, runtime, terms in ((("\n", "\n"), "codex", ""), (("\n", "y\n"), "codex,claude_code", TODAY)):
            with self.subTest(answers=answers):
                self.existing_env()
                self.log.unlink(missing_ok=True)
                term = self.ai_on(*answers)
                self.assertEqual(term.finish(), 0, term.output)
                self.assertEqual(self.value("FLUX_AGENT_RUNTIME"), runtime)
                self.assertEqual(self.value("FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS"), terms)
                self.assertTrue(self.applied(), "ai on applies the answer like ./flux up")
                self.assertIn("Flux is running:", term.output)

    def test_ai_on_with_no_changes_writes_and_starts_nothing(self) -> None:
        self.existing_env()
        before = self.env_file.read_bytes()
        term = self.ai_on("n\n")
        self.assertEqual(term.finish(), 0, term.output)
        self.assertIn("Nothing changed.", term.output)
        self.assertEqual(self.env_file.read_bytes(), before)
        self.assertFalse(self.applied())

    def test_ai_on_without_a_terminal_refuses_and_writes_nothing(self) -> None:
        self.existing_env()
        before = self.env_file.read_bytes()
        for result in (self.plain("ai", "on"), self.plain("ai", "on", stdin="\ny\n")):
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("needs a terminal", result.stderr)
            self.assertIn("FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS", result.stderr)
            self.assertNotIn(Q1, result.stdout + result.stderr)
        self.assertEqual(self.env_file.read_bytes(), before)
        self.assertEqual(self.calls(), [], "no terminal: not a single Docker call")

    def test_ai_on_on_a_failed_host_says_why_and_changes_nothing(self) -> None:
        for host, reason in self.HOST_FAILURES.items():
            with self.subTest(host=host):
                self.existing_env()
                before = self.env_file.read_bytes()
                term = self.terminal("ai", "on", host=host)
                self.assertNotEqual(term.finish(), 0, term.output)
                self.assertNotIn(Q1, term.output)
                self.assertIn(reason, term.output)
                self.assertEqual(self.env_file.read_bytes(), before)
                self.assertFalse(self.applied())

    def test_ai_on_needs_an_existing_instance(self) -> None:
        term = self.terminal("ai", "on")
        self.assertNotEqual(term.finish(), 0, term.output)
        self.assertIn("start Flux with ./flux up first", term.output)
        self.assertFalse(self.env_file.exists())

    def test_ai_on_can_add_claude_code_but_never_removes_a_client(self) -> None:
        for answer, runtime, terms in (("\n", "codex", ""), ("y\n", "codex,claude_code", TODAY)):
            with self.subTest(answer=answer):
                self.existing_env(runtime="codex")
                self.log.unlink(missing_ok=True)
                term = self.terminal("ai", "on")
                term.expect("[y/N]")  # the first and only question: Codex is already on
                term.send(answer)
                self.assertEqual(term.finish(), 0, term.output)
                self.assertNotIn(Q1, term.output)
                self.assertIn("Subscription sign-in is on for: codex.", term.output)
                self.assertEqual(self.value("FLUX_AGENT_RUNTIME"), runtime)
                self.assertEqual(self.value("FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS"), terms)
                self.assertEqual(self.applied(), bool(terms))
                self.assertEqual("Nothing changed." in term.output, not terms)

    def test_ai_on_when_claude_code_is_already_on_asks_nothing(self) -> None:
        self.existing_env(runtime="claude_code", terms="2026-10-05")
        before = self.env_file.read_bytes()
        term = self.terminal("ai", "on")
        self.assertEqual(term.finish(), 0, term.output)
        self.assertIn("already on for: claude_code", term.output)
        self.assertNotIn("[Y/n]", term.output)
        self.assertNotIn("[y/N]", term.output)
        self.assertEqual(self.env_file.read_bytes(), before)
        self.assertFalse(self.checked_the_host())

    def test_ai_takes_only_on(self) -> None:
        for args in (("ai",), ("ai", "off"), ("ai", "on", "now")):
            with self.subTest(args=args):
                result = self.plain(*args)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertRegex(result.stderr, r"usage: \./flux ai on|ai on takes no options")
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
