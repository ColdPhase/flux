# Map presence subscription boundary — 2026-10-18

Preimplementation contract for existing #228 / Draft PR #613, starting from
`6ac818c6082ca7b035f07373bafb749f993ca19e`. The parent coordinator accepted this
bounded implementation plan before code. This is author work, not independent
acceptance, and does not assert that the remaining 200 ms latency criterion passes.

Existing evidence identifies avoidable product work: the timed `251d9d5e` ledger
contains 1,416 peer movement receipts and 809 peer presence receipts. Every
presence-only receipt invokes SharedMap's generic changed callback, which clones
previews/peers into the live document state and rerenders the entire sketch editor.
The graph projection can remain unchanged while the 500-thought view still runs.
The earlier `28ad6b43` timed profile contains substantial React reconciliation and
host-update work; its inclusive costs overlap and cannot be assigned wholly to
presence or used to promise a p95 saving. The relevant predicted effect is less
peer graph work between receipt and rendered condition, with unchanged cursor data.

Implementation boundary:

- An instance-local presence store exposes a cached immutable snapshot and
  subscription. It belongs to the current account/map editor, never a singleton.
- Only the existing People and named-cursor leaves subscribe to presence.
  The editor/geometry state no longer subscribes to cursor-only changes.
- Native deltas, previews, lease/auth/status and private recovery still use their
  current graph/state path. No wire code, limits, cadence, authority or expiry
  durations change; no presence message is discarded or deferred.
- Preserve exact markup, person colors, deduplication, coordinate/zoom formula,
  placement, and original minimap. Clear/expire/retire/disconnect/destroy and
  account/map route replacement must invalidate the corresponding presence.

Verification will use actual trusted pointer movement and real wire receipts.
A public React DevTools observer must see cursors advance while editor/graph
render props stay unchanged. A real native geometry edit is a positive control:
its body/coordinates and graph must update, rather than merely passing a counter.
Existing cursor and map movement/clear/refusal cases will be reused; narrow
expiry/route controls may extend the existing cursor module. The same observer
against the original application must detect the old parent rendering.
Relevant Chromium and WebKit checks will run in isolated Docker stacks after
source commit and slot handoff. No broad suite or new CPU profile is planned.
The parent owns any subsequent single-cohort or final nine-cohort acceptance run.
