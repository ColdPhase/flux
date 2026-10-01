# Actual 1000-native-work baseline — #155 / #151 / #136

2026-10-01. Immutable measurement source:
d53622cfef7616af336d74ce1fd1f93df74b0f1f. The experiment completed and returned
exit1 because fetch/render bounds and source/back draft continuity failed. It did
not time out or stop with missing distributions. No runtime optimization, whole
issue acceptance, physical-device verification or application completion is claimed.

## Dataset and method

The explicit opt-in app/tests/ui/native_work_performance.py driver used actual
public commands in an isolated Docker project. Two registered contributors each
read all 1000 native work objects through the public API: 500 open, 300 in
progress, 150 blocked and 50 done, 500 owned per person. A genuine accepted
successor decision parks 30 open work objects (15 per owner) without changing
their status. The superseded predecessor, accepted successor and one proposed
decision remain: 3 real decisions. There are 10 linked results (5 positive/5
negative), 100 actual conversation messages and 100 source links on work (50
messages/50 material version1). API readbacks verify native IDs, versions,
status/owner/park counts and source/version links for both accounts. Setup takes
14.511s and is excluded from measured UI distributions.

The [measurement kickoff](../../../development/performance/2026-10-01-native-work.md)
received independent bounded agreement at7c2d267; the harness source atd53622c
was independently reviewed after correcting incomplete traffic, continuity,
work-row counting and mutation reporting. That reviewer ran no tests or certified
the measurements. The owner ran the actual benchmark below.

Chromium151.0.7922.34 / Python Playwright1.62.0 ran 1280×800 DPR1 desktop and
390×844 DPR1 with CDP4× browser-target CPU throttling. API/database/worker remain
uncapped. Docker Engine29.1.2 has14 CPUs and8,216,887,296 bytes; existing unrelated
projects continued running. This is viewport/CPU emulation, not physical phone
or tablet proof. [Environment](environment.json) records exact image identifiers
and actual API CPU limits. No direct SQL seeding, fake auth, collection mocks,
model/provider request, or forged UI event was used.

Every distribution has30 actual warm-ups,200 measured actions and at least60s.
Fresh-document navigation uses that new document's NavigationTiming.startTime
through verified correct native groups/counts, complete baseline rows and enabled
input, then two following animation frames on the same performance clock. The
other timings start from actual trusted keydown/view-click/wheel events and wait
for verified input/selection/scroll changes plus following frames. This is a
DOM/paint proxy, not GPU raster completion. Python navigation elapsed times are
separately retained. Documents share the browser process/cache/session; this is
not fresh-process/network-cache startup per sample. Key insertion/Backspace
alternates to avoid maxLength no-ops; wheel samples actually move the native pane.

## Observed results

[Complete report](native-work-performance.json) / [terminal log](baseline.log):

| Operation | Desktop p95 | CPU4× p95 | Desktop measured duration | CPU4× measured duration |
| --- | ---: | ---: | ---: | ---: |
| Fresh Tasks document → usable paint proxy |329.1ms |587.8ms |118.987s |177.587s |
| Native keydown → changed input paint proxy |36.6ms |47.7ms |71.723s |75.158s |
| Native view click → correct group paint proxy |65.1ms |176.3ms |79.977s |95.291s |
| Native wheel → moved pane paint proxy |38.5ms |38.4ms |81.696s |82.864s |

All eight latency distributions meet their proposed budgets. All400 measured
initial navigations have complete verified network counters; zero fit the fetch
budget. Both profiles fetch1000 work plus3 decisions/10 results in12 collection
calls,836,816 decoded body bytes and838,905 encoded transfer bytes. Initial
overall API request counts are25 desktop/24 narrow (distinct from collection
calls). Counts come from actual CDP response bodies read AFTER the browser paint
timestamp, not an assumption about page limits. No body overflow, failed or
unreadable collection response is hidden in a passing count.

Both profiles render1000 work rows/1013 total rows. Current DOM element counts
are9346 desktop and9260 narrow.
The [single3840×2160 observation](native-work-wide.png) also renders all1000 work
rows, without horizontal document overflow. It is neither physical4K proof nor
a200-sample wide performance distribution. Desktop and narrow screenshots use
the same actual native fixture:
[desktop](native-work-desktop.png), [narrow](native-work-phone-cpu4.png).

The native Details of a deep blocked work object opens correctly, but independently
reloads all1000 work through another12 collection calls/836,816 decoded bytes.
The existing15-second refresh also reloads complete collections:4–6 refreshes
per action phase fetch4000–6000 work records,3.347–5.021MB decoded collection
bodies. The narrow view phase has72 collection calls/6000 work/5,020,896 decoded
bytes. These phases are explicitly separate from initial navigation counters.

Sampled target JS heap peaks are287,130,036 bytes desktop and282,689,460 narrow,
from80 samples per profile across the four distributions. These include document
navigation churn; they are not settled steady-state or a leak diagnosis. Target
DOM counters include detached nodes and are distinct from current-document element
counts. No driver/container/API-only RSS measurement is claimed.

## Native continuity and next action

Both profiles preserve draft/focus/selection under passive resize, preserve the
draft across view/Only mine/Details, and verify actual Only mine counts:500 owned
work,1 project-wide proposal and5 owned results,506 rendered rows. Both fail
source→back continuity: the same private New work draft returns empty (length0).
The driver records that failure without refilling before the assertion.

There are **zero outbound mutating HTTP requests** during measured UI/continuity
phases. A final actual native readback compares complete work identity/version/
status/owner/park/link digests with the initial state: unchanged. Cookies, auth
headers, email/session/identity payloads and response bodies are not persisted in
measurement reports; endpoint UUIDs are normalized. Screenshots show only the
isolated fixture UI. No ordinary native read acknowledgment was emitted by these
Tasks/source routes; no blanket mutation allowlist was applied.

The [bounded-read design](../../../development/performance/2026-10-01-bounded-native-work.md)
addresses complete typed summaries/pages, native source associations and choices,
bounded relations, bidirectional continuation, coherent read observations and
private draft retention. It has bounded architectural agreement at76b8124;
exact public paths/query/DTOs still need their promised contract delta before
implementation. Existing full-object contracts must remain compatible; no partial
page may masquerade as a complete ProjectWork array. Owner continues that work on
the existing draft PR170. All original task/nativeTask/real-agent/motion/device
and whole-application release criteria remain required.

## Reproduction and provenance

Build/start the isolated source Compose UI stack using the documented development
environment, separate ports/project/volumes and a fixture auth signing secret.
Keep screenshot output mounted and pin the rebuilt source, then explicitly run:

```sh
docker compose -f docker/compose.source.yaml --profile ui run --rm \
  -e FLUX_PERF_SOURCE_COMMIT="$(git rev-parse HEAD)" \
  ui-test python3 tests/ui/native_work_performance.py
```

The harness is deliberately outside normal test_*.py discovery and PR CI. Exit1
here means completed failed baseline; exit2 means incomplete harness evidence.
[Actual current build/type/lint log](build.log) passed. Runtime app/package/tooling/
Docker inputs are unchanged from previously tested4817b88 (385 application tests
and9 affected typing UI cases at their recorded source); no new full suite is
claimed here. Foundation setup/local links and34 Python checks passed separately.
[Source/output manifest](inputs.json) records522 exact source inputs, output hashes
and decompressed raw-log hashes. Raw .gz logs preserve original terminal bytes
with deterministic mtime0; readable logs trim trailing whitespace only.

Owned flux155workperf containers, volumes, network and both image tags were
removed after completion; [actual cleanup log](cleanup.log) records the operation.
Unrelated existing projects remained running. No benchmark/build handles are live.
