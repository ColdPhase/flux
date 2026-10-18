# Deferred List outline during Map movement

2026-10-18, author preparation for existing #228 / Draft #613.

Application baseline: `7af776c7dfd4403e3937c8ccd4b9723c7808d587`. The Map does not consume the List outline during movement, yet `useOutline` builds it on each parent render. The retained timed 28ad profile attributes 217.587 ms owner self-time and 240.615 ms peer self-time over 60 seconds to `buildOutline`; its source and hook are unchanged at this baseline. This is modest avoidable work, not proof of the remaining latency failure's cause or a predicted Gate 4 pass.

Defer only `buildOutline` until this render's outline is read (including reveal/move actions), sharing one local result. Keep eager ID-only `rememberThoughts`, preference persistence, current immutable graph/state captures, and all DOM, styling, authority, transport and measurement behavior. No cross-render content cache. Correct the existing outline fixture to launch the requested actual browser.

Verification: the maintained `sketch-outline.test.ts` file, then existing outline methods 04 (reparent/reorder/Undo) and 05 (native edits/deletion/Undo/reveal and Map/List switching) in Chromium and WebKit, serially in Docker. No new implementation-shaped test, profiler or latency run. Author evidence does not replace independent evaluation.

## Confirmed live Undo announcement

The selected production-on journey exposed an existing success message left at “Waiting for confirmation” after a committed inverse. Extend only the live hook's existing confirmed-current completion callback to notify its caller; the editor announces “Undid” there. Exact receipt/ordered-head or current resynchronization, retry identity, scope lifetime and refusal guards stay unchanged. Ordinary Undo still announces immediately. Preserve method 05's success assertion and add success/refusal assertions to the existing private-cancel/own-Undo and peer-conflict journeys. Retain both prior failed invocations.
