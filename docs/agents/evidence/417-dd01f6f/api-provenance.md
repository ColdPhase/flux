# Focused API test provenance

The focused `tests/app/cowork-request-responses.test.ts` run at source `2c6a99b132a9eede3795656f1e4bcc1191331af2` completed 10 tests, 10 passed, 0 failed. Its captured terminal tool output included the Agents view test that asserts a connection appears before removal of its isolated project-ceiling membership and disappears after the removal.

The test result was observed in the command's terminal output but was not tee'd to a file. No transcript is included here and no saved logfile is claimed. The exact runner script is preserved as `api-focused-runner.sh`; it builds and runs the focused test through Docker Compose. The 2c6a99b source and final `dd01f6f` differ only in `app/tests/ui/test_agent_stop_questions.py` and `app/tests/ui/test_agents_handoff.py`, so production and API source are identical across those pins.
