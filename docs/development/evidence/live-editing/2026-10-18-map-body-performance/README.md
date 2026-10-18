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

## Subsequent canonical G4 run: FAIL

After the focused checks, the unchanged full nine-cohort driver ran once against
the same frozen `8ba5f87ae065d52b4b69158648f8e863b3d3f9cb` application and test
source. It wrote all **2160 scheduled rows**, with 30 warmups and 240 measured
rows per cohort, no input/socket errors, missing rows or timeouts. Eight cohorts
meet the unchanged 200ms p95 gate; moving 200 of 500 Thoughts still fails it.

| Cohort | p95, ms | Gate |
| --- | ---: | --- |
| Map 50, move 1 | 130.021 | PASS |
| Map 50, move 50 | 153.405 | PASS |
| Map 500, move 1 | 128.896 | PASS |
| Map 500, move 50 | 160.791 | PASS |
| Map 500, move 200 | **230.479** | **FAIL** |
| Wiki 10k, editor | 169.387 | PASS |
| Wiki 10k, reader | 140.589 | PASS |
| Wiki 100k, editor | 175.454 | PASS |
| Wiki 100k, reader | 166.408 | PASS |

The [nine case results](latency/case-results.json) come from every planned
per-case summary. The canonical overall summary's successful-cohort list omits
the failed cohort; its [full structured summary](latency/map-500-drag-200-summary.json.gz)
is retained explicitly. The [original overall summary](latency/summary.json.gz)
and [runner log](latency/runner.log.gz) preserve driver exit 1 and collector exit
0. Runtime identity is in [runtime.json](latency/runtime.json); the unchanged
driver SHA is
`11b71d4f9d34a471367de974ec93bde207b4b6f0a6b813babaa2d68c1a79e3c3`.

The actual queue was sealed **COMPLETE, 3233 records**, with no dropped records
or backpressure. The inventoried producer stopped normally (exit 0, no OOM),
with final resource gauges at zero and no resource-budget violations. Retained
[seal](latency/queue-seal.json), [collector result](latency/collector-result.json),
[finished marker](latency/measurement-finished.json) and
[producer shutdown](latency/producer-shutdown.json) establish completion;
the runtime/per-case `complete: false` metadata was provisional before sealing.
The [manifest](latency/manifest.json) binds original rows, queue, traces and all
retained files to their byte hashes. Original artifacts remain at
`/home/hubert/flux-evidence/228-map-body-8ba5f87a-latency`.
[Cleanup](latency/cleanup.json) confirms no project containers, volumes or
networks remain.

This was a shared host. [Preflight](latency/preflight.json) observed Qwen at 0%
CPU and load 0.576; the [single snapshot after the map cohorts](latency/midrun-host.json)
observed Qwen at 194.54%, the browser runner at 304% and load 5.846. These are
two snapshots, not continuous measurements or a causal attribution. The user's
services were preserved. There was no controlled latency A/B, so neither a
code-only timing improvement nor a regression is established by comparison with
the earlier 215.553ms run at a different source SHA.

For the failed cohort, input-to-covering-publication p95 was 131.201ms,
publication-to-peer-receipt 85.446ms, covering-receipt-to-paint 68.343ms and
two-RAF/recheck 87.157ms. Segment quantiles and superseding publications overlap;
these values must not be added. The proven reduction in unchanged body renders
does not establish the end-to-end latency gate. One private, non-acceptance CPU
profile will locate the next bounded change before another canonical run.

No full application suite was run. #228 stays open and the feature stays off by
default. Its original criteria, 200ms threshold, cadence, policy and independent
acceptance remain required. Later evidence-only commits do not change the tested
application or test source; these results retain their original source SHA.
