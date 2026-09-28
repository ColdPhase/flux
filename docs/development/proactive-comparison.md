# Proactive comparison rule (#58, first implementation slice)

A person can configure one standing low-light comparison rule for a named project
and their own agent. The saved authorization is separate from a committed human
result. `POST /api/v1/projects/:projectId/proactive-comparison-rules` requires the
fixed `human_negative_result` trigger, `camera_sensor_comparison` purpose,
`current_project_published` data scope and `quiet_project_proposal` permitted
effect, plus a current contributor grant for the person's own agent. The caller
must currently be able to write the project. One rule per owner and project is
allowed. `GET` returns only the caller's rules and requires current project read
access; `PATCH /api/v1/proactive-comparison-rules/:ruleId` changes status with an
expected version and current project write access. Revocation is permanent.

The rule starts paused. Enabling currently returns
`BACKGROUND_CONNECTION_REQUIRED`: O-007 requires a separately configured,
owner-authorized Claude Platform key and payer consent. The first slice does not
store credentials, enqueue jobs, call a provider or emit proposals. The persisted
rule is not presented as active automation. The API has no route for a peer to
invoke another person's rule or change its owner, audience, scope or purpose.

Migration `0021_proactive_rules.sql` uses 21 because 14–20 are reserved by the
parallel search, notifications and live-session branches. The migrator applies
individual files in numeric order; #118 will add a strict migration ledger and
same-volume upgrade proof before these branches can be integrated as a release.

Remaining #58 work: credential custody and explicit billing consent; trigger
capture and deduplication from committed human negative results; budgeted worker
execution and cancellation; source/audience rechecks; quiet proposal and UI;
real provider, privacy and no-AI continuation evidence. This file describes a
working configuration slice, not completion of #58.
