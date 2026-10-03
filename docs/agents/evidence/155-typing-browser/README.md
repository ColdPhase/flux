# Native human typing in project conversations and DMs — #155

2026-10-01. The [actual socket endpoint](../155-typing-socket/README.md) now
connects to the real native message composers. Implementation source:
`ecc4537f67f308750bfd7e86132f673ff18a9072`, based on protected main
`7af78f29c7da3799a57bf204b343b5647516afc5`. Later source/test heads
`08a5ec678ca43459eb4c28ed5a8787a9d440db07` and
`a64e722ff0c32d23a61bac1fa8ba1fd92a154583` change only the Python typing
regression. The manifest pins every run separately; it does not claim the full
configured command ran at the later test-only head.

## Actual commands and results

The isolated browser project `flux155browser` uses source Compose, ports
18581/18585 and its own volumes. Docker29.1.2,14 CPUs,8216887296 bytes;
Python Playwright1.62.0, Chromium151.0.7922.34, DPR1, zoom1, reduced motion.
These are desktop Chromium viewport tests, including320/390/820/1280 widths,
not physical phone/tablet installation, keyboard or Push evidence.

| Run | Pinned source | Result |
| --- | --- | --- |
| Docker build/type/lint and targeted core/access/socket/architecture | `9d7ae1fb695d286d8526f56cf380e62ec9be3d89` |50/50,16.594211215s, no skips |
| Corrected implementation Docker build/type/lint | `ecc4537f67f308750bfd7e86132f673ff18a9072` |PASS |
| Eight actual typing browser journeys | `08a5ec678ca43459eb4c28ed5a8787a9d440db07` |8/8,46.773s |
| Native project/DM/personal-assistant browser regressions | same `08a5ec6` full pin above |26/26,48.112s |
| Full configured application command, including all50 targeted cases | same `08a5ec6` full pin above |373/373,64.695239405s; PWA3, access/stream1, session prepare/restart/verify, unavailable Push1 and SMTP1 PASS |
| Nine typing browser journeys, adding private assistant suppression | `a64e722ff0c32d23a61bac1fa8ba1fd92a154583` |9/9,60.171s |

Full configured command:

```sh
FLUX_TEST_PORT=18571 FLUX_TEST_MAILPIT_PORT=18535 ./scripts/check_application.sh
```

The browser container commands are:

```sh
python3 -m unittest discover -s tests/ui -p test_typing.py -v
PYTHONPATH=tests/ui python3 -m unittest -v test_direct_messages test_project_surface test_personal_assistant
```

Run them in the `ui-test` service after the source image, migration and services
are prepared as in `scripts/check_ui.sh`. Targeted Node cases use `pnpm exec
tsx --test` with typing-core, typing-connection, typing-access, typing-socket,
typing-admission and architecture under `tests/app/`. The configured application
command includes these cases and its own additional real PWA/access checks.

Terminal handles23287/39512 build,91161 targeted,43163 eight-case browser,
61119 native regression,80224 full command and52991 nine-case browser all exited0.
The full script removed its own flux-test-1790826442-48841 project, volumes
and three tagged images. Browser project cleanup is recorded with the handoff.

Readable [application](application.log), [typing UI](typing-ui.log),
[native UI](native-ui.log), [targeted](targeted.log), [build](build.log) and
[browser image](browser-image.log) logs remove trailing whitespace only.
Each has a deterministic `.log.gz` containing its exact original bytes.
[Inputs and output hashes](inputs.json) include compressed and decompressed
log hashes. Credential-pattern inspection found no credential value in them.

## What the runtime evidence proves

Real registered humans share a restricted project,100 native persisted messages,
a versioned source and a separate native pair DM. The tests use their actual
cookies, API data, typing socket frames and Chromium controls. They prove:

- Genuine composer input yields current authorized human names in the exact
  remote scope; self is excluded, and typing creates no native message history.
- Blur, native send and conversation navigation stop the activity. A restored
  unsent draft does not advertise activity without a subsequent real edit.
- A receiver keeps its focused textarea, draft, selected material version,
  feed position, feed height and mounted message count as activity changes.
  The existing project history15-second/focus fallback is explicitly observed;
  typing does not replace it with history polling or replay.
- A viewer observes but has no active publication. Current access withdrawal
  removes the name; its measured clock starts conservatively before the grant
  request. Exact-session revocation and nondurable SQL counts are also covered
  by the actual socket tests in the full373 run.
- Receiver-side application frame loss clears names and shows unavailable
  within its monotonic freshness deadline; reconnect performs a fresh watch.
  This controlled relay drops only real server frames, never fabricates data.
- The server sends a closed own-account acknowledgement before watch/input.
  Actual shared-cookie A→B→A changes in both project and DM preserve each
  account's own draft, clear another account's editor state and publish no
  B activity before genuine B input. Account-keyed remounts also protect state
  when shell revalidation discovers the changed account before reconnect.
- A deliberately injected browser send failure retires its generation before
  delayed real checked frames can restore ready names. The old native close is
  delayed and the next real ACK withheld solely to make that race observable.
  This is a transport fault fixture, not an additional identity implementation.
- Private assistant mode, editing its prompt, Escape restoration and `/ai`
  conversion publish no human typing. No provider call is made by this case.
- Static notices reserve the same line at320/390/820/1280, preserve textarea
  geometry/focus and cause no horizontal overflow. Unchanged checked heartbeat
  snapshots do not mutate live-region text or repeat its DOM announcement.

Single final-run observations in [the timing JSON](rendered/typing-observations.json):
project first visible299.619ms, blur34.905ms, idle expiry5323.957ms,
navigation66.084ms, native send24.984ms; DM first visible311.466ms and
send44.031ms; grant request→withdrawn DOM866.821ms; dropped receiver frames
→unavailable3320.912ms. These are regression observations, not the required
30-warmup/200-sample/60-second sustained performance acceptance.

The [live project recording](rendered/typing-project-live.webm) and six final
`rendered/*.png` show the actual application. No raw network trace or cookies
are published. The source/draft screenshot intentionally shows synthetic private
fixture text to demonstrate the retained editor, not an actual person's draft.

## Independent review, corrections and remaining work

Read-only independent source review found missing browser freshness, stale
account binding, and late frames after known send failure. The author corrected
them and added the real regressions above. First browser execution additionally
found a private draft retained when the shell account changed: storage keys
were already scoped by account, but the content component React keys were not.
Both project and DM content now remount by account. The other initial failures
were test assumptions: native project delivery has an existing15-second fallback,
and an intercepted upstream close alone did not certify browser disconnection.
The final account test explicitly closes both relay halves and observes real
native ACKs. [Initial failure](initial-browser-failure.log) and
[relay-fixture failure](relay-fixture-failure.log), with exact gzip counterparts,
are preserved rather than concealed.

Final bounded implementation source agreement is pinned to `ecc4537`; final
test-delta source agreement is pinned to `a64e722` full SHAs above. That reviewer
ran no tests and gave no eligible GitHub whole-task approval. A separate fresh
visual reviewer received only a neutral reading/reply brief and the six actual
captures now retained under `visual-review/`, at the `ecc4537` runtime pin. It
found no material visible hierarchy/readability/clipping finding. Screenshot
agreement does not establish interaction, accessibility or physical devices;
the author-executed live tests provide the narrower behavior evidence above.

The [current contract](../../../development/typing/2026-10-01-contract.md)
still requires canonical #154 Task composition, actual32 publishers+96 watchers,
repeated latency/work/RSS/input/scroll measurements,1000-work-item evidence,
real agent execution and accepted motion/interruption semantics, enlarged text,
4K/ultrawide and physical Android/iPhone/iPad PWA/Push. All original #155 AC1–AC5,
#151/#136, supported model clients, integrated full-product acceptance and release
remain open. This browser checkpoint is not completion of #155 or Flux.
