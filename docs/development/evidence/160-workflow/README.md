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
