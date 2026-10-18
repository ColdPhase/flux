# Roomless conflict correction: selected API and two-process evidence — 2026-10-18

Author verification for whole #228 / Draft #613; not independent acceptance.
The [contract](../2026-10-18-roomless-conflicts.md) was committed before route
code at root 03703152 (local cherry-pick bf7d25cb). Exact clean tested product
source: `aade67efde45b8156fe933c2124ab5a2a96d580a`. This later evidence commit
changes documentation only.

A generic DomainError retains ordinary details only when the request has a known
sketch ID and a post-rollback room check finds no live room. Existing room,
unknown target, capacity-refusal and protected label behavior stay unchanged.
No current/session/confirmation/final fence, audience, private-placement rule,
lock, journal or budget was relaxed. Core single-evaluation policy is unchanged
from the prior tested 1f76588e. This correction adds no further optimization.

## Actual checks

| Same source aade67ef | Result | Duration |
| --- | --- | ---: |
| Docker build/typecheck/lint | PASS (lint 0 errors, 9 existing warnings) | part of selected check |
| Same nine selected API files | 50/50 PASS; 0 fail/skip/cancel/todo | 46.979 s |
| Existing actual two-process fixture | 1/1 PASS; 0 fail/skip/cancel/todo | 2.715 s |

Both commands exited 0. The unchanged four ordinary 409 assertions now pass:
currentVersion/current thought and fresh promotion previews (content/audience).
An added SQL assertion verifies the ordinary conflict creates zero live rooms
and zero journal rows. An existing joined live/native HTTP case now also sends
a real stale mutation and verifies 409 without current/currentVersion or the
protected thought text. Existing private/DM/viewer/agent/current-revocation,
policy-lock and session/confirmation/TTL fences remain in the same selected set.
No test expectation was weakened. Commands/selectors and compact outcomes are
retained alongside this note.

The two-process fixture ran after the 50/50 result, on the SAME frozen code,
through `./scripts/check_live_editing.sh --two-api`. Its exact runner inventory
is retained: two distinct actual container IDs, same image, source aade67ef.
It exercised real commit NOTIFY, pre-drop map preview, wiki edits, named presence,
ordered missed-update catch-up and current revocation/opaque refusal boundaries.
A functional wiki pass is not a wiki latency gain. Browser DOM latency and API
restart remain separate acceptance gates.

## Runtime, cleanup and preserved failures

Actual Node v24.21.0 and PostgreSQL 18.6. The selected API lane used normal live
availability with NODE_ENV production. The two-process lane additionally used
the existing development marker, with telemetry empty; neither used private
transaction instrumentation. Actual CID/image/allowlisted env/version receipts
were captured BEFORE cleanup, without credentials. These running snapshots are
not a canonical terminal resource seal or proof of all final process exit codes.

Both projects were removed: zero owned containers, networks, volumes and image
tags; ports 18685/18686 free. User demo and qwen38-llama-router stayed running.
Cleanup receipts verify both. Heavy slot was returned to root after terminal
checks, before this docs-only receipt. No UI, latency, profile or full-suite
execution occurred in this author follow-up.

Earlier genuine failures remain preserved under their original source pins:

- `00f11151`: author test PrincipalRef type errors, before API startup.
- `1f76588e`: 46/50 API, four missing ordinary conflict-detail failures.
- `fb8764ca`: failed diagnostic flag routing, no raw stages.
- `941a1ff5`: corrected bounded diagnostic, not clean performance acceptance.

See the [earlier API receipt](../2026-10-18-single-sketch-evaluation-api/README.md)
and [diagnostic contract](../2026-10-18-transaction-diagnostic.md).
The original f30 canonical 7/9 and its map/wiki timing failures are not relabelled.
Root retains current integrated UI/timing verification, all original gates and
independent final acceptance; no issue/PR/review state is changed by this note.

Raw logs and full actual inventory stay outside the repository, pinned in
result.json:

- `/home/hubert/flux-evidence/228-roomless-conflicts-aade67ef-api`
- `/home/hubert/flux-evidence/228-roomless-conflicts-aade67ef-two-api`

Only compact test outcomes and sanitized metadata are checked in.
