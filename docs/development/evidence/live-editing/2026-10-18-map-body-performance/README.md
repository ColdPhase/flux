# Thought content during movement, 2026-10-18

This bounded continuation of #228 removes repeated unchanged content work during
successive live movement updates. It does not complete the parent's 200ms gate
or enable the default-off feature. The previous full run remains an
[8/9-cohort failure](../2026-10-18-map-performance/README.md).

## Change

The moving button still receives current native geometry, preview generation,
gesture/lease/sequence, selection, resize state and current input handlers.
Its content now has a separate ordinary React memo boundary. Explicit props
cover text, placement, file, source, creator, creation time, version, height,
current person, task entry and mover. Position-only previews retain those props;
native content changes refresh them. There is no custom comparator that ignores
parts of a Thought. The task chooser also receives its content separately from
its moving slot. The rendered DOM and visual styles are unchanged.

## Pinned verification

Tested implementation and test source:
`8ba5f87ae065d52b4b69158648f8e863b3d3f9cb`, based on protected main
`608532da0ff6d7c6824e9bb0b15335517344d641` (#611).

| Execution | Result | Browser test time |
| --- | --- | ---: |
| Chromium, 10 selected journeys | PASS, 10/10, no skips | 53.106s |
| WebKit, same 10 journeys | PASS, 10/10, no skips | 64.095s |
| Chromium baseline, new regression only | Expected FAIL, 1/1 assertion failure, no errors/skips | 2.574s |

The Docker image build includes application build, typecheck and lint; they
passed. Both positive commands use the maintained `check_live_editing.sh` with
ports 18685/18686 and the actual Chromium/WebKit engines. Exact selectors and
environment are in [commands.json](commands.json).

The new real-browser regression uses React's DevTools commit observer, actual
trusted pointer movement and the real peer socket/native API path. After the
initial mover label appears, eight consecutive preview updates produce at least
eight moving-button renders and **zero additional content renders**. Geometry
and preview sequence advance. A native edit to a neighbour is visible while
movement continues; editing the moving thought refreshes its text, version and
height and clears the old lease. The observer detects these native body changes,
so a silent observer cannot satisfy the assertions.

Other selected journeys cover unrelated native changes during drag, own Undo
refusal after a peer change, private cancellation, stationary presence and stable
neighbours, independent own Undo, actual 50/200-item drag and native commit,
linked task counts/chooser contents and current task updates.

## Baseline negative control

The unchanged application at `608532da0ff6d7c6824e9bb0b15335517344d641` was
built in a separate detached worktree. Only the exact new test file was overlaid
(80 added lines; no product edits). The same Chromium regression passed its
moving-button observer control, then failed at the intended content assertion:

```text
AssertionError: 12 != 4 : Successive actual movement previews do not render unchanged content
```

That is eight extra content renders across the eight actual movement updates.
This control establishes that the regression distinguishes the content
extraction. It is not a controlled latency A/B measurement. The shared user's
demo and Qwen services were preserved; no code-only timing improvement is claimed.

## Evidence and limits

[Source/overlay hashes](source-inventory.json), [results](results.json),
[Chromium runtime inventory](chromium-runtime.json) and
[WebKit runtime inventory](webkit-runtime.json) bind the positive checks to source
and actual container/image identities. The baseline's build/run and assertion
are retained in its log; no separate baseline runtime inventory was captured.
Raw byte hashes and deterministic compressed-log hashes are in
[manifest.json](manifest.json).

- [Chromium log](chromium.log.gz)
- [WebKit log](webkit.log.gz)
- [Baseline negative-control log](baseline-negative.log.gz)

Original logs remain under `/home/hubert/flux-evidence/228-map-body-*`; metadata
is under `/home/hubert/flux-evidence/228-map-body-performance-8ba5f87a`.
The baseline checkout with its test-only overlay is preserved at
`.worktrees/228-map-body-control-608532da`.

[Cleanup inventory](cleanup.json) confirms no containers, volumes or networks
remain for the three owned projects, and both ports are free. Each runner
removed its two per-run images; shared build cache was retained.

No full latency driver or full application suite was run for this continuation.
The parent will run the unchanged nine-cohort driver once after the focused
checks. #228's original criteria, 200ms threshold, cadence, policy and independent
acceptance remain required. Later evidence-only commits do not change the tested
application or test source; these results retain their original source SHA.
