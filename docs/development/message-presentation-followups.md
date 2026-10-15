# Message presentation follow-ups (#503)

Accepted boundary, 2026-10-16: the coordinator adopted the independent PR #529 peer
assessment under the [delegated product authority](../product/autonomy.md).
This records required future behavior, **not implemented endpoints or schema**.
PR #529 provides the shared presentation slice. #503 AC-5 remains open for the
DM capabilities below; #534 tracks the unimplemented receipts in AC-3.

## Private DM threads and deliberate task copies

- A DM reply thread inherits exactly the DM's **current participants**. It adds no
  project authority, workspace-manager access, agent access or participant grant.
  Every read, count, command, event and replay preserves the
  [existing DM access policy](direct-messages.md#access-policy), including current
  membership, invisible-resource responses and the pair-recipient-left rule.
- Creating a project task from selected DM text is an explicit copy, not a citation
  or automatic source grant. Before confirmation, show the deliberately selected
  excerpt, destination and its actual audience. Cancel writes nothing. Only the
  approved excerpt is copied; other messages and later edits do not flow into it.
- Use the [sketch promotion preview/token/transaction pattern](sketches.md#sketches-in-a-direct-message):
  bind the token to selected canonical message versions, approved excerpt,
  destination and previewed audience. Recheck source participant/read authority,
  destination write authority and audience under the canonical authority locks in
  the committing transaction. Revocation fails without a copy; stale content or
  audience requires a fresh preview and confirmation. Idempotent retry creates
  one task, not another copy. Follow the existing lock order; do not introduce a
  second authority policy.
- Destination-visible provenance contains **copied by, copy time and the approved
  excerpt only**. Do not automatically expose the private message author's identity,
  participant roster, DM/message IDs or a live private-source link. Do not infer
  participant consent from membership or grant them project access as a side effect.
  Existing sketch-copy provenance is not permission to expose it for this new path.
- Implementation acceptance must exercise cancel/no-write, retry, stale preview,
  source/destination revocation and concurrent audience change, plus outsiders and
  nonparticipant managers, against real persistence/API and Chromium/WebKit UI.
  No extra capability is implied solely to fill the More menu.

## Real grouped viewing receipts (#534)

- Store actual observations of canonical messages by authenticated current human
  viewers. Define visible/focused observation conditions before implementing the
  public protocol. A send, private return point, Inbox read-all, last message or
  high sequence never proves observation of skipped messages.
- For an author run, “Seen by” is the **intersection** of viewers who observed
  **every canonical message in that run**. Seeing only its final message does not
  qualify. Pending local messages do not manufacture canonical observations.
- Partial pagination must be conservative: do not claim a complete-run intersection
  from only the loaded suffix or merge incomplete runs into a stronger receipt.
  The implementation must identify canonical run boundaries/completeness or omit
  an unsupported group claim until it can establish them.
- Both observation writes and receipt identity reads enforce current exact-message
  access and current audience/identity visibility. No forged viewer, revoked
  participant, cross-project/DM ID or historical roster may leak through receipts.
  #534 requires indexed per-message/viewer persistence, migration, idempotency,
  concurrency/privacy tests and pinned independent evaluation before completion.

## Conditional width invariant (#501)

“A bubble that holds” media/reference content is conditional on supported content.
PR #529 measures actual project/thread media; current DM text uses the shared shell
but has no real DM-media journey to test. This does not assert a permanent ban on
DM media or certify unavailable attachments. Any future supported DM media must
satisfy the same phone width invariant and receive real journey coverage.
