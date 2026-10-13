# Exact-head browser results

Source under test: `dd01f6f667ca9d4253f36f5eedf46cb135bd54ee`, based on main `fe4e08f0d6ece3e3b2f6ec5482e7826ab2bfec0b`.

Both invocations selected all 11 `test_agent_stop_questions.StopAndQuestions` methods plus the ordered HandOff methods 01, 05, 18 and 19. The order preserves fixtures used by those selected journeys.

| Engine | Result | Duration | Persisted log | Screenshots |
| --- | ---: | ---: | --- | --- |
| Chromium | 15/15 passed, exit 0 | 28.190s | `chromium.log` | `screens/chromium/` (18 frames) |
| WebKit | 15/15 passed, exit 0 | 39.352s | `webkit.log` | `screens/webkit/` (18 frames) |

Both Compose runs completed cleanup. Each runner removed two per-run images; subsequent container, volume, and network filters for its project were empty.

Exact-head required GitHub Actions checks passed:

- [Agent setup](https://github.com/ColdPhase/flux/actions/runs/38463639270)
- [Application validation](https://github.com/ColdPhase/flux/actions/runs/38463639438)

The focused API test at source `2c6a99b132a9eede3795656f1e4bcc1191331af2` passed 10/10. Production/API files are unchanged between that source and `dd01f6f`. Details and provenance are in `api-provenance.md`.
