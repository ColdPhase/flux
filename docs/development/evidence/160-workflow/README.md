# Integrated co-work checkpoint, 2026-10-18

Owner: PelikanFix16. Draft PR [#616](https://github.com/ColdPhase/flux/pull/616),
Refs [#152](https://github.com/ColdPhase/flux/issues/152) and
[#160](https://github.com/ColdPhase/flux/issues/160). Neither whole issue is accepted.
The frozen scripted native-domain evidence in #612 remains unchanged and is not
model-obedience evidence.

## Implemented and checked

Production source at `64e66020ab0c38356f3489706d9ad66153bee442` adds opt-in
bootstrap discovery of a connection's existing units and canonical orientation
coverage in the same durable checkpoint. No migration, separate backlog, lease
secret or native-process control is added. The default bootstrap envelope and
old checkpoint shapes remain compatible. See the
[recorded contract amendment](../../cowork-coordination.md#startresume-recovery-amendment-152160-2026-10-18).

Docker build, typecheck and lint passed. The first targeted MCP run passed 24/25:
the new disabled-source regression expected a tool-200 error, whereas delivery
correctly returned HTTP403. Its assertion was corrected, then the affected
checkpoint/core run passed **9/9**. The unchanged ancillary MCP/playbook/OAuth/
policy/public-extension checks had passed in that first run. Foundation setup,
153 foundation tests and `git diff --check` passed before the final evidence update.
No application browser/UI claim is made.

## Genuine native-account observation

This is independent of the scripted model endpoint. The actual checksummed
official **Codex 0.160.1** and signed-manifest **Claude Code 2.1.285** ran in a
disposable Docker client container, with explicit read-only credential mounts
and fresh Flux fixture owners/projects/OAuth consent. No user home, repository
instructions or existing project content was mounted. Credential contents and
model transcripts were not printed or retained. CLI calls had finite timeouts;
Claude's model invocation also had a 20-turn limit. No payer substitution occurred.

Production images were built with the app/test bytes of `64e66020`. The initial
fixture stopped before any model invocation because first policy publication
correctly returns 201, while its assertion expected 200. The corrected fixture
was mounted read-only against the unchanged images, from source
`0b0b08d429f91bf6583b59c7ac5b7354ca1dac7b`, SHA-256
`35a75a00db43608b1418600915d75c462e30d2f9106de5f7e9eea1a20e52ae9b`.
The stack was flux-mcpclients-1792340769-2099866; all its containers/volumes
were removed after the finite run. The source's later fixture correction to
native `codex exec resume <threadId>` has **not yet been run**. It takes the
explicit ID emitted by Start in the fixture's private HOME, kept until both
invocations finish. The failed fixture was torn down; its thread is not reused.

| Observation | Actual result |
| --- | --- |
| Codex account usability | A bounded official-client call completed against the configured real account. This alone is not workflow proof. |
| Codex supplied Start | **Observed**: actual model discovered/read the supplied resource, bootstrapped, acknowledged 1.8.0, read plan/wiki/tasks, checked its inbox, created exactly one criteria-bearing plan-intent task, created/claimed its unit and released it with durable orientation coverage. The fixture verified the database records. |
| Fresh generic Codex “Resume work on Flux” | **Failed**: a new `codex exec` selected `chatgpt_space.find_pages` and `sites.list_sites`, made no observed Flux recovery calls and produced no result reflecting the changed plan. A natural phrase in a fresh context is not reliable integrated Resume. |
| Claude supplied Start | **Unavailable**: the actual invocation matched an authentication/usage failure category and stopped. The initial fixture did not retain the precise category, so no narrower diagnosis is asserted. That provider was not retried. No Claude model-workflow acceptance is claimed. |

Codex Start exposed these 15 distinct native call names (repeated-call counts and
provider network/model-call counts were not captured, so none are inferred):
`list_mcp_resources`, `read_mcp_resource`, `flux_list_contexts`, `flux_bootstrap`,
`flux_acknowledge_playbook`, `flux_project_orientation`, `flux_get_doc`,
`flux_read_material`, `flux_list_work`, `flux_get_work`,
`flux_coordination_inbox`, `flux_create_task`, `flux_create_unit`,
`flux_claim_unit`, `flux_release_unit`. The Codex subtest including the failed
fresh Resume lasted 112.8s; the unavailable Claude subtest lasted 13.7s. These are
fixture times, not a clean-clone onboarding time for #320.

## Next verification and remaining acceptance

The corrected opt-in fixture uses Codex's explicitly identified saved-session Resume and records
safe tool-call counts/error categories. Official dated documentation confirms
[`codex exec resume <SESSION_ID>`](https://developers.openai.com/codex/noninteractive)
and the supported [local authentication cache](https://developers.openai.com/codex/auth)
(read 2026-10-18); these are vendor capability evidence, not a successful Flux run.
Do not retry Claude until its account/authentication condition changes. A
Codex-only run can select `FLUX_TEST_MCP_LIVE_CLIENT=codex` without using the
unavailable account. The normal opt-in mode builds its source; image reuse is
only for explicitly verified unchanged production sources and prints the
read-only mounted fixture SHA. Never reuse an image to claim a new production
head was tested.

The failed fresh Resume also showed that a clean CLI HOME does not by itself
exclude account-connected native app tools. The next fixture disables the
pinned `apps`, `plugins` and `remote_plugin` features per invocation using the
existing reviewed runtime switches; native code-mode/MCP resource tooling stays
available. These flags do not edit the person's saved configuration. That
containment change and the explicit-thread Resume are unverified until the next
authorized Docker run. No external message or publication was observed in the
failed run; the two unrelated calls were reads.

The supplied product integration still lacks an external native activation
adapter which owns an immutable connection/project/native-thread binding and
invokes Resume internally. The test-only invocation is not a delivered control
or a user instruction to learn CLI flags. Existing mode-(a) embedded runtime
cannot be silently relabeled mode-(b) external MCP support.

Still required: genuine supported Resume and changed-plan reanalysis, Claude
onboarding, a living supported client retaining/deferring busy requests and
handling them at safe checkpoints, quiet idle wake with tool/network/model-call
evidence, integrated resilience and Start/Resume/Pause/Stop on the same task
records. Stop currently ends the Flux task hold; it does not kill the person's
native CLI program. #320's clean-clone timed walkthrough is also unverified.
One consolidated independent review plus at most one final delta/open-findings
check applies; no independent review has been requested for this incomplete draft.

## Supplied host action verification, 2026-10-18

The supplied `./flux cowork start|resume` action now binds the origin, connection,
project, client and working directory to its own explicit native thread. Connect
and the same project's Agents detail show its supplied command and prerequisites.
The browser does not launch a closed native app. The launcher uses the installed
Codex 0.160.1 ChatGPT account path; it does not write global configuration,
select `--last`, copy provider credentials or store a second task backlog.
The current server resource remains authoritative for the playbook. Query binding
narrows existing authority before discovery and at response delivery; the OAuth
resource/audience remains the existing advertised `/mcp`.

**Pins and checks.** App/helper images were built from
`26ef05d90714d90e8be7c9c7fce6fea2c7ce07b6`. Build, typecheck and lint passed.
The focused Docker selection passed **35/35**, including the architecture rule
that had failed CI, orientation/checkpoints, host binding, receipt replay,
playbook, OAuth and public extension compatibility. The earlier checkpoint
normalizer imported an adapter through orientation; it is now a pure module,
and the architecture rule remains unchanged. The host binding regression also
passed **1/1** under MCP `2025-06-18`, in addition to the modern selection.

The changed Connect scenario passed on Chromium and WebKit at 390 and 1440px
(**1 scenario / 4 combinations**, 55.0s), covering supplied exact commands,
phone touch target, enlarged text, lost authorization and revoked history.
Screenshots are local at `/tmp/flux160-adapter-browser-evidence`; this is behavior
and render evidence, not independent visual approval. The existing Agents detail
uses the same action component; that entry path was not separately exercised.

The outer shell test first exposed a watchdog cleanup delay: the original test
ignored the subprocess timeout despite a zero exit status. The launcher now
reaps its timer and sleeper. The tightened Docker shell test passed **1/1** in
5.7s with no subprocess error. It used stub native/Docker commands and the real
compiled metadata helper: **it is not real-model evidence**. The tested launcher
and mounted shell fixture are at `5464ed6f1b909e11efa3d63bde42c3e117ac0e5a`;
app/helper production bytes are unchanged from `26ef05d9`.

**Native activation remains blocked before the model.** Actual checksummed Codex
0.160.1 used a fresh isolated Docker HOME, explicit read-only configured-account
mount and real Flux browser consent. No person's unrelated native history or
global configuration was inspected or resumed. Three bounded OAuth preflight
observations preceded any model invocation:

- The pre-registered fixture callback gained a server suffix and was refused
  as `invalid_redirect`. The fixture now supplies its explicit registered
  callback URL.
- Explicit `oauth_resource` duplicated the canonical resource already supplied
  by native discovery and broke login continuation. The launcher and fixture
  now rely on the advertised resource once; the audience contract is unchanged.
- The corrected flow completed browser consent, but official `mcp login` exited
  **1**. The fixture did not retain its raw OAuth output; the exact safe error
  subtype is therefore **unknown**. This is not evidence of a provider quota,
  expired provider auth or successful native activation. No model Start or
  explicit-thread Resume was reached in this verification. No Claude retry,
  payer fallback or account/login-setting change occurred.

The final native image's compiled helper SHA-256 was
`77684670f747093b7ed1e9d79a89827de5eea3fe8268b0811ec4b639c29dd033`;
its read-only mounted fixture at `5464ed6f` was
`b7615e19cda0361350360387a5b8358caed8530fa242c8720edccd0bd6053966`.
The app/helper source pin remains `26ef05d9`; fixture corrections were not
misattributed to rebuilt production images. Logs are local:
`/tmp/flux160-adapter-verify.log`, `/tmp/flux160-adapter-retry.log`,
`/tmp/flux160-native-final.log` and `/tmp/flux160-adapter-shell-delta.log`.
Do not publish OAuth diagnostic URLs or raw client output from those logs.
Completed model turns in this adapter run: **0**; provider/network request counts
were not instrumented. The earlier genuine Start success and fresh generic
Resume failure above remain at their original pins.

All owned verification containers, volumes, networks and retained image tags
were removed; the heavy slot was explicitly released. These are Linux Docker
observations; another host/platform is not accepted by this evidence.

Official primary documentation, read 2026-10-18:
[configuration reference](https://developers.openai.com/codex/config-reference)
for inline developer instructions, required MCP initialization, callback and
credential-store settings; [noninteractive execution](https://developers.openai.com/codex/noninteractive)
for native JSON thread IDs and explicit `exec resume`. Vendor documentation is
capability evidence, distinct from the failed activation observation.

**Next action / unchanged whole criteria.** Diagnose the native OAuth exit using
safe category/status-only instrumentation before another bounded adapter run.
Complete supported-client activation (Claude still pending), live busy-recipient
queue delivery/checkpoints, quiet idle wake with actual call/network evidence,
restart/retry/revocation/lease/capability/policy and changed-plan resilience, and
Start/Resume/Pause/Stop on the same task records. The adapter has no automatic
idle wake. Stop ends the Flux hold, not the person's unrelated CLI program.
Neither #152 nor #160 is accepted or closed; #320's timed clean-clone walkthrough
is still unverified. PR #616 stays Draft. The single consolidated independent
review and at most one final delta remain available; none was requested here.

### Safe login-only preparation after the blocked run

The `04f0959f` observations above are unchanged. Static comparison with the
successful frozen #612 harness found these differences: #612 uses native
`mcp add` and its saved configuration against bare `/mcp`; the supplied action
uses inline native settings and a connection/project query binding. Both use
file-mode native MCP OAuth storage and a fresh writable isolated HOME. The
read-only single provider `auth.json` was an additional difference in the live
workflow fixture; no evidence identifies it as the cause of OAuth exit1.

A prepared, **unrun** `FLUX_TEST_MCP_OAUTH_ONLY=1` mode requires both the explicit
live-fixture opt-in and `FLUX_TEST_MCP_LIVE_CLIENT=codex`. Its test composition
mounts only current fixture/harness/diagnostic source files, **no provider
credential or user HOME**. The fixture does not create provider-auth symlinks,
clears inherited provider key/base overrides and returns after native MCP login;
it also guards the model invocation against this mode. No Claude path is chosen.
The script suppresses raw server-log dumps on a login-only failure.

The bounded report contains only a fixed phase vocabulary, fixed observed OAuth
error-code markers, allowlisted endpoint HTTP statuses, callback HTTP completion
and a bounded process exit code. HTTP observation never reads response bodies.
Raw native output remains only in the process harness's transient memory for
fixed-marker classification; it is neither printed nor attached to exceptions.
Browser/URL errors in this observed path become one fixed error message. Unknown
codes, arbitrary fields, URLs, query parameters, authorization codes, state,
tokens, credentials and transcripts are excluded from the report. A portable
regression exercises secret-bearing fault input, unknown stages/status, report
bounds and the explicit Codex-only mode guard; it awaits Docker/CI execution.

The next explicitly granted **login-only** diagnosis should distinguish:
callback navigation/HTTP failure, token-endpoint refusal, or token/callback
success followed by native completion failure. A token200/callback2xx plus
exit1 would narrow the hypothesis to native post-callback validation/storage;
it would not prove a specific cause. This preparation makes no authentication
or workflow success claim and performs no Docker, provider/account or model
call. Existing successful checks remain pinned above; no full issue criteria or
review requirements changed.

### Granted login-only observation, 2026-10-18

The prepared privacy/mode-guard regression ran in Docker and passed **2/2**.
The actual checksummed Codex0.160.1 login-only fixture then failed before model
execution. It mounted **no provider credentials or user HOME**, created no
provider-auth symlink and selected no Claude path. No model invocation occurred.

App/helper images reused the identical `26ef05d9` frozen build context; their
production source diff against diagnostic source
`268c874ba2b61df612dea6eb74513fe0ecb56831` is empty. The runtime helper digest
remained `77684670f747093b7ed1e9d79a89827de5eea3fe8268b0811ec4b639c29dd033`.
Read-only current diagnostic fixture receipts:

- `mcp-live-workflow.e2e.ts`: `a8d0f34853bc69de24e3e8f24ec017c513b19ee1586584e3878e92d5c21da09e`.
- `mcp-client-harness.ts`: `b71767a5fcb5834c479c2cd31cf419125d87ab7ea8d6d61feeb8449aaa614f90`.
- `oauth-diagnostics.ts`: `395d9945a97138223cd78514723388affdca01e3628b11206d6ac040ac727a76`.

The safe phase report observed protected-resource and authorization-server
discovery HTTP200 (twice each), authorization302, continuation200 and consent200.
Phases reached `consent_submitted`, then `callback_wait_failed` and
`native_login_finished`; `callbackCompleted=false`, `observedCodes=[]`,
`nativeExitCode=1`. **No token-endpoint HTTP request was observed.** This narrows
the failure to consent-to-native-callback handling before token exchange; the
previous post-callback storage hypothesis is not supported by this observation.
No specific production bug or safe small fix is yet established. The successful
bare-URL/persisted-configuration #612 path remains the comparison; the identity
lane independently reported the same maintained path passing at `847b7408`.
Neither is evidence that the supplied inline/bound-URL action works.

The owned project was `flux160-oauth-only-1792346731-2498313`; its containers,
networks, volumes and image tags were removed and exact metadata queries returned
no matches. The shared slot was explicitly released. The local receipt is
`/tmp/flux160-oauth-only.log`; the native fixture duration was 10.8s, whole run
terminal1. The failure is preserved rather than replaced by an unproven retry
or speculative source change. Next work is static comparison of callback
configuration/registration and the supplied inline binding, followed only by an
explicitly granted affected login check when evidence supports it. All whole
#152/#160 criteria remain required and PR #616 stays Draft.
