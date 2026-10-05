# Real human typing stress checkpoint — #155

2026-10-01. Baseline source9a39b1ea81972a9f7a58b1e901395a3b88fee3e7 failed;
optimized source4817b88f7c9546ee60940005905f51e36baa0664 passed the development
profile and the constrained CPU profile. Whole #155, nativeTask integration, agent motion, physical-device
and integrated application acceptance remain open.

## Method and failed baseline

The explicit `app/tests/app/typing-stress.ts` driver creates32 actual native
human accounts, grants a restricted project's current contributor access,
creates one native conversation, and signs each person into a real Better Auth
session. Each opens four actual same-origin cookie WebSockets:32 publishers
and96 additional watchers. The in-process API uses the production typing route,
current session/native policy, PostgreSQL clock and LISTEN/NOTIFY adapters.
No fixture identity/policy, forged server frames or public diagnostics endpoint.
The ordinary API and worker also run in the same isolated Compose project.
Docker Engine29.1.2 provides14 CPUs and8,216,887,296 bytes across the development
VM; other existing projects are not stopped. This is not physical device proof.

Baseline [report](baseline.json) and [log](baseline.log) show128 established
transports but all closed1011 during dense initial publication. There were zero
warm-up or measured samples: no latency distribution can be claimed. Repeated
per-recipient sender checks exceeded the2-second delivery deadline. The report
retains112 unfinished sender/delivery checks and their admission reservations.
Messages/events/notifications/outbox/audience counts remained unchanged.
[Baseline inputs and output hashes](baseline-inputs.json.gz) pin the failed source.

## Optimization and independent assessment

The [agreed contract](../../../development/typing/2026-10-01-contract.md) shares
one immutable exact-session/write/session-name sender proof only within one
captured canonical-context delivery cycle. Every recipient retains both native
session/read checks, the earliest sender-proof completion+1000ms deadline,
current stop/scope/listener/clock/expiry fences, and queued-output reconciliation.
Four global jobs, one running/latest pending per context,128 retained context
slots and4096 captured job pulses bound the work. Invalidated unfinished SQL
keeps its reservation until actual settlement; there is no cross-cycle authority
cache. Monotonic captured cycle IDs and pre-launch current-pulse validation fix
late lazy requests replacing fresh cycles or launching withdrawn sender checks.

A separate read-only source reviewer first identified both lazy-cycle defects,
then confirmed bounded source agreement at full4817b88 after their correction.
The reviewer ran no tests and gave no eligible GitHub/whole-task approval.
[62 targeted tests](shared-targeted.log) passed16.680s with no skips, including
real native auth/SQL/socket cases plus clearly distinct controlled scheduler,
held shared-authority→stop/unwatched scope/listener, late initial-recipient-auth,
revocation, immutable capture, oldest-proof deadline, capacity and diagnostics
carry-in cases. [Docker build/type/lint](shared-build.log) passed at the same
application inputs.

## Development profile measurement

[Actual report](shared-stress.json.gz) and [full log](shared-stress.log.gz):30 warm-up
updates followed by200 measured stop/active updates over94,987ms. All128 sockets
stayed open and received new ready snapshots after warm-up. Callback-level
ready interarrival maximum930ms, sampled ready-age maximum626ms, and zero stale
or unavailable frames/observations support sustained service for all recipients.
Publisher input here means an actual closed socket command; browser DOM input
is separately tested by the nine-case browser evidence, not measured here.

| Measured phase | p50 | p95 | maximum |
| --- | ---: | ---: | ---: |
| Driver send → first remote ready receipt |130ms |312ms |393ms |
| API publish completion → first remote receipt |119ms |223ms |317ms |
| Driver stop → fresh remote absence |145ms |197ms |248ms |
| Server command execution |26ms upper bin |45ms upper bin |62ms |
| Command queue wait |29ms upper bin |110ms upper bin |151ms |

Driver and instrumented API share one monotonic process clock. The publication
metric retains the signed first-receipt minus publish-promise-completion value:
PG notification receipt can precede that completion microtask. It never waits
for a later heartbeat to fabricate a receipt timestamp. API histograms use fixed
1ms upper bins and report overflow/uncompleted/carry-in work explicitly.
The command budget measures execution including authorization/publication;
queue wait is reported separately. These are API/network, not DOM, distributions.

Exact scheduler peaks: one running proof job, one pending job,64 captured pulses
and one retained context. Other work counters are sampled once/second and cannot
prove exact transient peaks; source caps and controlled tests provide separate
bounds. Sampled peak RSS617,631,744 bytes and heap261,259,272 bytes combine the
in-process production route,32-account setup and driver. They are not API-only
memory figures. The bounded512-point ring retains aggregate sampled extrema.
85,107 received frames/176,614,469 bytes cover bootstrap/warm-up/measurement;
the report labels their whole-experiment transport scope. Durable native counts
are equal before/after typing. No current names/session IDs/cookies/draft text
are written to these measurement reports.

## Constrained CPU profile

[Report](constrained-stress.json.gz) and [log](constrained-stress.log.gz): another
independent32-human/128-socket native dataset,30 warm-ups and200 measured updates
over97,624ms. The [Compose override](constrained-compose.yaml) caps ONLY the test
container (driver plus in-process API) at2 CPUs. Actual Docker inspect returned
`NanoCpus=2000000000`; PostgreSQL, ordinary API/worker and existing projects remain
uncapped. This is labelled CPU emulation, not Android/iPhone/iPad or API-only proof.

| Measured phase | p50 | p95 | maximum |
| --- | ---: | ---: | ---: |
| Driver send → first remote ready receipt |136ms |360ms |714ms |
| API publish completion → first remote receipt |121ms |231ms |712ms |
| Driver stop → fresh remote absence |147ms |200ms |304ms |
| Server command execution |21ms upper bin |51ms upper bin |100ms |

All128 remained open/fresh with zero unavailable frames or stale observations;
ready interarrival maximum929ms and sampled ready age798ms. Exact proof peaks
remain1 running/1 pending/64 captured/1 context. Sampled combined peak RSS is
612,868,096 bytes. Thirty background commands were actually still in flight at
report time and are explicitly reported, not counted as completed latency samples.
Measured command completions1907 exceed200; all query/admission reservations
remain owned until settlement and are retired during shutdown. Native durable
counts again remain equal. Whole-experiment transport:85,650 frames and
177,934,925 bytes. There is no claim of physical-device, multi-context fairness
under production traffic, browser DOM/render/input/scroll stress or1000 native
work-object performance acceptance.

## Reproduction and integration verification

The benchmark is explicit and is not included in lightweight PR/ordinary
`*.test.ts` discovery. After building/starting the isolated source Compose test
stack with the documented test environment, the actual commands are:

```sh
docker compose -f docker/compose.source.yaml --profile test run --rm \
  -e FLUX_GIT_COMMIT="$(git rev-parse HEAD)" test pnpm exec tsx tests/app/typing-stress.ts
docker compose -f docker/compose.source.yaml -f /tmp/flux155-stress-cpu.yaml \
  --profile test run --rm -e FLUX_GIT_COMMIT="$(git rev-parse HEAD)" \
  -e FLUX_STRESS_CPU_PROFILE="Docker driver/API2CPU emulation; DB uncapped" \
  test pnpm exec tsx tests/app/typing-stress.ts
FLUX_TEST_PORT=18571 FLUX_TEST_MAILPIT_PORT=18575 ./scripts/check_application.sh
```

The local CPU override is the preserved constrained-compose.yaml above.
Both benchmark processes returned exit0. The failed baseline returned exit1.
Full [configured application run](application.log.gz) passed build/type/lint,
**385/385 tests, no skips,62.082s**, then PWA3/access-stream1/session
prepare→restart→verify/Push-unavailable1/SMTP-unavailable1. This includes the
62 targeted cases. These are the actual immutable4817b88 application inputs;
PWA Chromium fixtures do not certify physical installations/notifications.

The affected [nine native two-account browser journeys](browser-ui.log) also
passed54.291s, with [fresh Docker browser/API build](browser-build.log) at4817b88.
They retain actual input/blur/send/navigation/expiry, cookie-account isolation,
private assistant suppression, reader/session revocation, real-frame receiver
stall and stable draft/source/focus/feed evidence. Client/UI source is unchanged
from the separately source/neutral-visual-reviewed browser checkpoint; this
server optimization does not add animation or claim a new visual/device review.
Foundation setup/links,34 Python foundation tests and whole-branch whitespace
checks passed. Source inputs, output hashes and exact compressed/original log
hashes are recorded in inputs.json. Readable logs trim trailing whitespace only;
raw gzip files retain original terminal bytes with deterministic mtime0.

Next: owner continues1000-native-work-object/large-surface measurement and the
remaining Task/real-agent/motion/device criteria. Existing PR stays draft. The
other agent must independently evaluate the final whole-task head; bounded
source agreement cannot substitute for protected-branch eligible approval.

All owned stress/browser Compose containers, volumes, networks and their image
tags have been removed after the runs; the configured application script removed
its own isolated project and three tags. Existing unrelated projects remain
running. No protected merge, nativeTask substitute, real-provider/agent run,
physical PWA/Push verification or release acceptance occurred at this checkpoint.
