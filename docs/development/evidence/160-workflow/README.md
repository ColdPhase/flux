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

## Genuine Start, changed plan, Resume in both clients, 2026-10-30

`FLUX_TEST_MCP_LIVE_WORKFLOW=1 ./scripts/check_mcp_clients.sh` with the person's own accounts mounted read-only
(`FLUX_CODEX_AUTH_FILE`, `FLUX_CLAUDE_CREDENTIALS_FILE`), Docker only, ports 33600/33601. The fixture copies each
credential into the disposable client HOME so the client can refresh a token there; the host files are never
written. The project holds only fixture content. Clients: official Codex **0.160.1** (pinned image) and Claude Code
**2.1.285** (signed manifest). Person's input: only the supplied action (Codex `exec` argv of `./flux cowork`, Claude
`/mcp__flux__start_work <project>` then `/mcp__flux__resume_work <project>`).

| Run | Source | Result |
| --- | --- | --- |
| 1 | main `75df7fff` + fixture `b57492bf` | Codex Start stopped after 5 calls; Claude flagged as `rate_limit`. Both diagnoses below. |
| 2 | + fixture `b952f91e` (account stop read from a failed result only; tool failures and last message logged) | **Claude PASS**: Start 21 tool calls (bootstrap, ack, orientation, plan/wiki reads, inbox, `flux_create_task`, create/claim/release unit with orientation); quiet idle 60 s: **0** Flux requests, no process; owner changed the plan; Resume 21 calls incl. `flux_changes_since`, `flux_record_result`; 1 task, durable orientation, result names the changed plan. 189.7 s. Codex still refused (below). |
| 3 | + `44fdca04` (supplied Codex action approves Flux's own tools) | **Codex PASS**: Start 32 calls, exactly one criteria-bearing plan-intent task, unit claimed and released with orientation; quiet idle 60 s: **0** requests, no process; Resume on the exact saved thread (`exec resume <threadId>`) 19 calls incl. `flux_changes_since`, `flux_record_result`, no failed call; no duplicate task; result names the changed plan. 172.1 s, exit 0. |

Diagnoses, recorded as observed:

- **Claude "account stop" was a false positive.** Claude Code's `stream-json` prints routine `rate_limit_event` lines in
  a successful run; the fixture matched `rate_limit` anywhere in the output. It now reads markers only from a failed
  final result. The 2026-10-18 "authentication/usage" Claude stop used the same matcher; it was probably the same
  false positive (inference, not re-observed).
- **Codex refused Flux's write tools.** Codex 0.160.1 answered `flux_acknowledge_playbook` with "MCP tool call requires
  approval, but approval policy is never": `exec` has nobody to approve. The supplied action now passes
  `mcp_servers.flux.default_tools_approval_mode="approve"` (accepted by 0.160.1 and 0.163.0, whose variants are
  `auto|prompt|writes|approve`). Flux's standing grants remain the authority; the flag only stops the client asking.
- Run 3 Start saw 7 failed `flux_project_orientation` calls with an empty error text and one failed inbox call before
  it succeeded. The model recovered; the cause is not diagnosed here (follow-up).
- The Codex legs use the test copy of the launcher argv (`app/tests/app/support/cowork-production-invoke.ts`), not the
  outer `./flux cowork` shell; the shell is covered by `cowork-host-shell.test.ts` with a stub CLI.

## Narrowed scope: Codex Resume unverified, 2026-10-23 (#636) — superseded 2026-10-30 above

No account-backed Codex Resume was run, and none is claimed. The Codex
`./flux cowork resume` leg (`codex exec resume <threadId>` with the explicit saved
thread) is **unverified** with the real binary: it is covered only by the stub-CLI
shell test in `app/tests/app/cowork-host-shell.test.ts`, which is not model or account
evidence. The supplied Codex Start/Resume host action is therefore labelled
"pending native verification" in Connect and the project Agents view (#635). The
native run is stopped by a watchdog after `FLUX_COWORK_WATCHDOG_SECONDS` (default
300); see the [coordination contract](../../cowork-coordination.md#host-action-verification-status-and-watchdog-635636-2026-10-23).
Unblock condition: one real-account Codex Start, then one Resume on that exact
thread, recorded here with tool-call counts and the model and version used.

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
`nativeExitCode=1`. **No token-endpoint HTTP request was observed.** The flow did not complete after consent; the prior instrumentation did not
observe an expected callback response or a token request. It did not classify
a different target or browser transport failure, so missing regex match alone
does not prove that the native callback failed. The previous post-callback
storage hypothesis is not supported by this observation.
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


### Static callback classification preparation

Compared the raw callback regex source against frozen #612: both use the same
JavaScript template escaping for literal dots in `127.0.0.1`. No extra-escape
regression was established. The unchanged matcher is extracted into a pure
helper with synthetic loopback/suffixed/wrong-port/look-alike-host regression
cases. The tests also show that IPv6 can be classified as loopback while the
historical IPv4/localhost regex misses it: a matcher miss is distinct from
transport/native success or failure. These new cases await Docker/CI.

Prepared bounded observations of post-consent top-frame navigation requests,
responses and request failures. They disclose only loopback/expected-port
booleans, base/suffixed/other callback-path classification, iss/code/error
presence booleans, HTTP status and fixed browser transport-failure categories.
They never emit target URLs, path suffixes, query values or browser error text.
Cleanup-triggered request cancellation is excluded. Regression cases cover
secret-bearing input, unknown fields/categories and the 16-observation bound.
Existing native exit and endpoint observations remain separate for correlation;
no new native observation, production fix, Docker build or account/model call
occurred during this preparation.

The next granted model-free comparison is the known successful native `mcp add`
composition with a **bound** URL versus the supplied inline/bound-URL composition,
using the same fixture client registration and callback port, isolated writable
homes and no provider credentials. Current official configuration/auth guidance
([configuration](https://learn.chatgpt.com/docs/config-file/config-reference),
[issuer/callback guidance](https://developers.openai.com/plugins/build/auth))
supplied for this investigation distinguishes per-server callback listener port,
callback target URL and issuer validation. It is a hypothesis guide, not proof
of the pinned Codex0.160.1 behavior. No host0.163 client is used. The comparison
must correlate target, network status/failure and native exit; it must not
convert missing regex match alone into a callback-failure conclusion.

The comparison scenario is prepared as `FLUX_TEST_MCP_OAUTH_COMPARE=1`, requiring
the explicit Codex-only login-only mode. It sequentially runs `persisted_bound`
then `inline_bound` with the same newly seeded fixture client, connection,
project, URL binding and callback port. Both receive fresh writable isolated
homes without provider credentials; only the newly seeded fixture client's
consent is reset between legs so cached consent cannot skip the controlled
step. The persisted leg uses #612's native add/login composition; inline uses
the supplied action's current settings. Both bounded phase reports are retained
even if the first leg fails, and the test fails if either native login fails.
The configuration labels are fixed enums, not raw native arguments. This
scenario is prepared only, not executed. The explicit mode guard has regression
coverage awaiting Docker/CI; no app/helper production bytes changed.

### Granted persisted-bound versus inline-bound comparison, 2026-10-18

The prepared comparison ran once at clean/pushed diagnostic source
`d401a7ab9d5150383580b33166bef728485b99b3`. Focused synthetic diagnostic,
privacy, mode and regex regression passed **3/3**. The actual pinned/checksummed
**Codex0.160.1** then ran both fixed-label OAuth-only legs with the same newly
seeded fixture client, connection, project, bound URL and callback port, fresh
isolated writable homes, and consent reset only for that fixture client. There
were **zero provider credential mounts/symlinks and zero model invocations**.

| Fixed configuration | Callback navigation observation | Callback HTTP | Token HTTP | Native exit |
| --- | --- | --- | --- | --- |
| `persisted_bound` | Request and response: loopback, expected port, base path; iss/code present, error absent | 200 | 200 | 0 |
| `inline_bound` | Request: same safe target classes/presence booleans; no response observed | Not observed | Not observed | 1 |

Both legs observed protected-resource/authorization-server discovery200,
authorize302, continuation200 and consent200. Persisted reached
`callback_response`, `callback_navigation` and `callbackCompleted=true`; inline
reported `callback_wait_failed`, `callbackCompleted=false`. Neither report
contained an allowlisted OAuth error marker. No fixed browser request-failure
category was observed for inline before cleanup; absence of that event is not a
transport-success claim. Only target classes/presence booleans were compared,
not private URL/query values. The comparison finished terminal1 because inline
login failed; both reports were preserved, not replaced by retries.

**Inference:** the bound URL alone does not explain the failure, because it
worked through native persisted `mcp add` configuration. The difference remains
in supplied inline configuration/native callback machinery. The current evidence
does not prove which setting is wrong or justify a production change. The
smallest next action is a safe, fixture-owned configuration-shape/pinned-source
comparison of the native add-generated OAuth callback settings against inline
settings, before any further affected login attempt. Do not inspect global
configuration, use host0.163 or repeat a whole/provider/model lane blindly.

App/helper production bytes remained the frozen `26ef05d9` build context, with
an empty production source diff against the diagnostic head. Exact receipts:

- Compiled helper: `77684670f747093b7ed1e9d79a89827de5eea3fe8268b0811ec4b639c29dd033`.
- Current workflow fixture: `0c5883ad8ad13ad17cc867e03e93ae8da30a38154e5498618860f4c0805d1b84`.
- Current client harness: `54e7753969e9c3edb77db4aabba1529b1d1a062be3830b7dfb0e5ebf443246a7`.
- Current diagnostic helper: `085fb1d2b6a6d6d44d4cc1702a117648880d73ccc14f59a82a97365be2feb5f4`.

The owned project was `flux160-oauth-compare-1792347677-2551880`; the local safe
receipt is `/tmp/flux160-oauth-compare.log`. Both native legs together lasted
12.6s. Exact container/network/volume/image-tag metadata checks returned empty
after cleanup, and the shared heavy slot was explicitly released. No production
fix, Claude retry, account fallback or full issue acceptance occurred. #616
remains Draft; all whole #152/#160 criteria and review limits are unchanged.

### Prepared single default-callback control

The d401 comparison remains mixed: inline explicitly sets `oauth.callback_url`,
whereas the persisted add command does not. Neither storage nor inline
configuration in general has been established as the cause. The fixture-owned
persisted HOME was destroyed by required cleanup, so exact saved callback field
values were not recovered; the available observation is expected-port/base-path
classification and the exact checked-in native command composition. Global
configuration/history is not a substitute for that missing fixture artifact.

A separately guarded `FLUX_TEST_MCP_OAUTH_CALLBACK_DEFAULT=1` login-only control
omits only the inline explicit callback URL, keeping the bound URL, client
registration shape, global callback port and file credential mode. It cannot
select the two-leg comparison or a model/provider path. The original d401 random
client/owner data no longer exists after cleanup; the control necessarily uses
an equivalent newly seeded isolated registration, not a retained global account.
Only fixed state/issuer/redirect/client/config markers on native error lines are
added, never raw native messages. Ordinary authorization URLs are excluded from
that classifier. These are observed markers, not diagnoses. No production helper
configuration is changed. The control awaits its explicit granted execution.

### Granted single default-callback control result, 2026-10-18

The single credential-free/model-free inline control ran at clean/pushed fixture
source `87493f7a920559ea302c2d8abcd0c283b05a23f5`. It omitted explicit inline
`oauth.callback_url` and retained equivalent freshly seeded client registration,
bound URL, global callback port and file credential mode. The original d401
fixture database/homes had been removed, so its random client identifier was
not reused or recovered from global configuration. No production helper changed.

Focused diagnostic/privacy/mode/regex/native-marker regression passed **4/4**.
Pinned/checksummed Codex0.160.1 then reported configuration
`inline_bound_default_callback`: protected-resource and authorization-server
discovery HTTP200 (twice each), authorization302, phases only
`native_login_started`, `authorization_received`, `native_login_finished`.
There was no `sign_in_ready`, callback-target/response or token-request
observation; `callbackCompleted=false`, `nativeExitCode=1`,
`observedCodes=[]`, `observedNativeErrorMarkers=[]`. The fixture lasted30.6s,
whole run terminal1. No raw browser error, URL/query or native message was
printed to infer an unobserved error code.

Dropping explicit callback URL alone did not produce a successful login and
changed the observed stopping point. This is not proof that callback URL,
inline configuration generally or storage is the production cause. The d401
mixed contrast remains intact: persisted-bound succeeds, inline with explicit
callback URL reaches consent and fails later. No additional whole lane/retry,
Claude, provider credential mount/symlink or model invocation occurred.

App/helper production stayed at frozen `26ef05d9`; the compiled helper digest
and harness digest remain the d401 receipts above. Updated mounted source
receipts were:

- Workflow fixture: `65d0b2a4f001a6898c0cdafe0531a843f7491fab362541dc7bac5ff2986633d9`.
- Diagnostic helper: `205e612f3a9b8c5162eb6c4c1be8326f1dac6ef66a5af21366d7404fb9832950`.

Owned project `flux160-oauth-default-1792347951-2562544` was removed, and exact
container/network/volume/image-tag metadata checks returned empty; shared slot
explicitly released. Safe local receipt: `/tmp/flux160-oauth-default.log`.
Smallest next action is pinned-source or fixture-only configuration-shape
inspection of what native `mcp add` actually stores for callback routing, before
any further granted affected login. Stored field values were not retained in
these cleaned fixtures, and current vendor docs alone do not establish pinned
behavior. No production configuration is guessed. #616 stays Draft and all
whole #152/#160 criteria remain required.

### Granted pinned local config-writer micro-observation

One bounded Codex0.160.1 config-writer invocation ran without a stack/build,
browser, provider credentials or model. A fresh empty HOME existed only in a
container tmpfs; the child environment contained no API keys. Docker networking
was disabled and loopback port9 was confirmed closed before the synthetic
command. The command used synthetic URL `http://127.0.0.1:9/mcp`, client
`fixed-fixture-client` and global callback port19831. Native writer exit0,
no timeout, configuration file created; whole actual container invocation was
under1s (8s child timeout). No OAuth login/consent flow was executed.

Allowlisted generated fields:

| Config key | Permitted synthetic value / observation |
| --- | --- |
| `mcp_servers.flux.url` | `http://127.0.0.1:9/mcp` |
| `mcp_servers.flux.oauth.client_id` | `fixed-fixture-client` |
| `mcp_servers.flux.oauth.callback_url` | Key name only; generated value not emitted or retained |

No other fields were written; in particular, no callback-port field was
persisted. This confirms pinned0.160.1 uses the nested `oauth.client_id` schema
already used by the inline fixture and that native add generates callback URL
configuration itself. It rules out the proposed older/flat client-ID field
hypothesis. It does **not** establish equivalence of generated callback URL value
to the inline value, listener semantics or a production fix.

Actual version: `codex-cli 0.160.1`; actual binary SHA-256:
`f34a4d2301892ae96c90097786bfe5dc269f187b6f69faf42a7b357b8c081e35`.
Pre-existing native test image:
`sha256:c4761d89c1f4d026eb5114bcd0f0e3e6700ba934e9d54a9fe39a11fb4c0053ae`.
No host0.163 CLI or user configuration/history was used. The named container
`flux160-config-writer-micro` was removed; exact metadata check returned empty,
and its unmounted tmpfs HOME disappeared with it. The pre-existing image was
preserved. Safe local receipt: `/tmp/flux160-native-config-writer.log`.
All full OAuth attempts remain stopped after the granted874 control. Further
work is static; no additional provider/model or login retry was performed.

### Final granted callback-shape micro-observation

One final separately granted bounded local config-write used the same pinned
Codex0.160.1 image/binary, empty tmpfs HOME, `--network none`, closed loopback9
and synthetic inputs, without stack/build/login/browser/provider/model. Writer
exit0; container removed and exact metadata check empty. Only structural callback
properties were emitted; raw callback URL, suffix ID and query values were not
emitted or retained. Safe receipt: `/tmp/flux160-native-callback-shape.log`.

Generated callback properties: **scheme=http, loopback=true, port=80** (empty
URL port interpreted as HTTP default), **path=suffixed, queryKeys=[]**. Compared
with the explicit synthetic inline `http://127.0.0.1:19831/callback`: scheme and
host equality true; port and path equality false; query equality true; exact
URL equality false. Thus native add's generated callback configuration is
structurally different from the inline value. This is the previously missing
safe observation, not evidence of a successful inline login or an accepted
production fix. No further OAuth flow or source change was performed; all full
issue criteria remain open. The micro-slot was immediately released for the
next author; subsequent conclusions/work are static until separately authorized.

### Static production/fixture parity plan (not execution authorization)

The offline generated callback shape is **not** asserted equal to the callback
configuration after a successful online native add: the offline writer did not
observe issuer capabilities. Preserve both874 failure and the two local
micro-observations without promoting either to a production cause.

Static command comparison:

| Concern | Production supplied action | Current acceptance fixture |
| --- | --- | --- |
| MCP setup | Bound URL + required; native login | Adds pre-registered client, callback URL/port and file-store overrides |
| Invoke | `exec --ignore-user-config --json --skip-git-repo-check --sandbox workspace-write`, bound URL/required, generated entry guidance and app/plugin disabling | Same main flags, but also injects its extra OAuth overrides via `fixtureConfig` |
| Resume | Explicit adapter-created thread ID, same private binding/cwd | Explicit own thread, but not yet reached by current adapter run |

The current fixture therefore cannot simply be rerun as proof of exact
production configuration. The smallest faithful future test, only if granted:

1. Use the known-working persisted-bound native add/login setup in one fresh
   isolated HOME. Preserve its exact server name, bound URL, OAuth cache and
   native storage backend; do not hand-author guessed callback metadata.
2. In that **same** HOME/cwd, invoke the production command flags and internally
   supplied current-server-playbook guidance exactly. Remove fixture-only OAuth
   client/callback/port/store flags from the invoke. Do not drop
   `--ignore-user-config` to make it pass.
3. Record required MCP initialization/authentication separately from any model
   result. The fixture's clean HOME writes file-mode OAuth storage in config,
   while production's ignored-config exec does not force that setting. Whether
   pinned0.160.1 still finds cached authorization under the default backend and
   absent client/callback overrides is unproved; observe this boundary instead
   of reading credential contents or assuming lookup semantics.
4. Only after a successful bounded Start, capture that process's own native
   thread ID and durable source coverage. Use the same HOME/binding/cwd and
   exact ID for the changed-plan Resume. Stop on auth/init/provider limitation;
   do not retry with extra OAuth flags, switch payer or select global history.

This checks compatibility with normal saved native setup; it does not by itself
prove the production first-login path or accept whole #152/#160. No provider
account, model, login, Docker or build was run for this static plan. The existing
production helper remains unchanged; no speculative repair or further OAuth
flow is authorized by this document. Root decides any later execution after the
other author's heavy lane.

### Prepared genuine Codex fixture parity (unrun)

The normal Codex fixture now chooses the successful persisted-bound native
add/login setup in its original isolated HOME, then invokes a test-side copy
of the production argv with **only** bound URL/required, current-playbook entry
guidance, sandbox/JSON/ignored-config and app/plugin switches. It no longer
passes fixture OAuth client/callback/port/store overrides into exec. Resume
uses the same HOME/cwd/binding and the native thread created by that Start.
No backend/cache behavior is forced or claimed: `--ignore-user-config` and
OAuth cache lookup remain unverified. A targeted regression guards absent
OAuth/backend overrides and rejects unbound/`--last` Resume; it awaits CI/Docker.
Production helper/app bytes are unchanged.

The existing explicit Codex-only `FLUX_TEST_MCP_OAUTH_ONLY=1` selector now
controls this persisted-bound setup without provider mounts or model execution;
comparison/default-callback modes remain separately explicit diagnostics.
Codex-only genuine mode has a Codex-only read-only credential overlay, so it
neither requires nor mounts the stopped Claude account. No Claude retry is
added. No Docker/client/account/model call was made for this preparation.
Any future genuine run is limited to one Start and one Resume, with Resume
only after successful Start; auth/quota stops the run without retry or payer
fallback. Setup success alone is not first-login product parity or whole-issue
acceptance.

### Whole #152/#160 evidence and outstanding matrix

Original pins are retained; historical checks are not rerun/reaccepted at this
head. Scripted native model endpoints prove transport/domain composition, not
genuine workflow obedience. Issue closure/supersession is not new runtime proof.

| Criteria / journey | Existing evidence at original pin | Still required / unverified |
| --- | --- | --- |
| #152 AC1/3: owners, connections, consent/authority | Domain delivery #167 `919c1dbf`; native #612 `469ee898` passed22/22 per mode with two owners/five connections, including the requested three-connection composition; API6/6 per era at `d271ac44` | Current integrated genuine activation and same-session workflow; native fresh browser contexts alone do not prove same-browser/cross-tab isolation |
| #152 AC2/5; #160 AC1: bounded domain/bootstrap/orientation | Public domain/grant/receipt machinery exists; #616 `26ef05d9` build/type/lint and focused35/35, compatibility; `64e66020` orientation/checkpoint9/9 corrected rerun; earlier actual Codex Start at that source created one sourced native task/checkpoint | Exact-production-flag fresh Start/Resume, full source/version/gap coverage and changed-plan reanalysis under actual supported models; complete bootstrap/policy/capability resumed-context acceptance |
| #152 AC4/5; #160 AC2: supported onboarding/instructions | #612 native delivery/onboarding at `469ee898` scripted endpoints; earlier actual Start success then fresh generic Resume failure preserved above; current persisted-bound OAuth success at `d401a7ab`, inline controls failed | One genuine exact-production-flag Codex Start then explicit Resume; normal first-login parity; Claude remains pending after actual account/auth stop, no retry. No README/prompt/skill fallback counts |
| #160 AC3: busy recipient, targeted review/fix | #612 `469ee898`: two owners, busy recipient retains unit through busy/after_step defer, checkpoint, targeted review, stale verdict and one fresh review; third-connection inbox isolation and debit/dedup assertions. API versions at `d271ac44` | An actually active model/client receives/dequeues at a safe checkpoint without interrupting unrelated work; full review→fix→fresh-review execution with loaded workflow |
| #160 AC3/4: wake/quiet idle | Durable storage/recovery originally tested at `919038b5`, `664ce62e`; #612 fresh-process reconnect/quiet-renewal controls at `469ee898` | Active/idle adapter scheduling/wake, no idle model polling, measured tool/network/model-call behavior. Current OAuth-only zero-model runs are not idle-wake evidence |
| #160 AC3/4; #152 AC3/5: resilience | Server/API/native scripted replay, exact lease/session/checkpoint recovery, request versions, targeted revocation at pins above; `26ef05d9` binding/replay modern plus legacy1/1 | Integrated genuine duplicate/offline/lost-ACK/artifact-change/revocation/lease-loss/missing-capability/policy-update workflow, durable visible pending/block state; no silent loss/double effects/payer fallback |
| #160 AC3: useful non-code + native task decomposition | #612 `469ee898` stores non-code result/review and bounded intents with scripted selections; actual Start at `64e66020` made one task with criteria/plan intent and orientation checkpoint | Actual useful completion/review, multi-task criteria/dependencies/decomposition, concurrent dedup, changed-plan reanalysis and reuse on genuine Resume |
| #160 AC3: GitHub links | Verified project PR-link domain delivered #168 `cbdf7e11`; same-task deterministic rules #270 `bfdc2d01` and later existing #74/#479 work. No linked-PR native case claimed by #612 | Native plan→task→resulting verified PR links and relevant checks/eligible external approval gates in the integrated workflow; no global scan or substitute Flux-only approval |
| #160 AC5: same Agents/tasks, controls | Original setup/recovery API/browser at `365cd0f2`; #616 Connect Chromium/WebKit×390/1440 at `26ef05d9`; supplied action component also appears in own Agents detail | Agents entry path separately exercised; full same-task Start/Resume/Pause/Stop + busy/outcome state integration. Stop ends Flux hold, not unrelated CLI; no-AI path and quiet ACK/noise behavior remain required |

All #152 AC1–AC5 and #160 AC1–AC5 remain whole contracts, not partially accepted
from these rows. The entire integrated application/release pass and eligible
independent approval remain separate. #616 stays Draft; no new full review was
requested, preserving the agreed comprehensive-review/final-delta limit.

### Exact clean first-login selector and live adapter gap (static preparation)

[Activation/adapter gap](activation-adapter-gap.md) now separates the additional
persisted-bound cache control from a prepared **actual-production-first-login**
model-free selector. The latter uses the exact inline launcher login command,
no seeded registration/add/client/callback override and no configured native
file-store. Its private dynamic loopback callback never enters diagnostics.
It is unrun. New selector/privacy/argv regressions await Docker/CI; static shell,
foundation/link and whitespace checks passed. No product source changed.

A separately granted network-none metadata micro confirmed all requested
app-server methods in pinned0.160.1; the [public extract](codex-0.160.1-app-server-extract.json)
records actual binary/image, required parameter subsets, terminal0 and cleanup.
Two preceding schema generations had extractor read EACCES (outer terminal1),
preserved separately; the final no-bind extraction passed. No native server,
auth, model, provider mount, build or application suite was run. Resource-read's
parameter definition was omitted by the small filename filter and remains a
narrow metadata gap. Presence in a schema does not prove runtime behavior.

The gap note proposes a private owned app-server adapter using existing native
OAuth and canonical Flux state; it does not implement/accept a managed control
protocol. Clean setup, actual current-bundle loading, busy safe checkpoints,
zero-model idle wake, Pause/Stop acknowledgement and every whole-issue matrix
row remain required. Parent must settle the minimum contract amendment before
product code. Heavy application slot remains with the other author; no further
run is authorized by this note.
