# AC-3 late map-frame gap — pre-code note

Reviewed before implementation on source `d7081a9cd8f1fb6104510eb7a4ac935fa1d8008d`.

AC-3 requires recovery from delayed, duplicated and reordered deliveries, and
expired movement must disappear. Existing actual two-user journeys cover a
newer preview before pointer-up, reconnect, dropped Save acknowledgement,
natural server lease expiry and private recovery. They do not hold a genuine
server `map-move`, deliver a later sequence first, then replay the earlier
frame after an authoritative clear or after its own expiry.

Source inspection finds that `SharedMap.receive` compares a received move's
sequence only with the currently stored preview. `map-delta`/`map-clear` delete
that preview, and the one-second expiry timer removes stored expired previews,
but a later frame for the cleared lease can be inserted again before its next
timer tick. This is a bounded transient UI reappearance, not a durable map write.

Planned narrow correction: reject an already-expired incoming map move and
remember recently cleared lease IDs for a finite window covering the server's
five-second transient expiry; reject late frames for those leases. Keep that
retirement memory bounded and force the existing reconnect/resync path rather
than forgetting a tombstone early if its cap is reached. No wire or authority
change is planned.

Planned browser regression reuses `LiveFixture` and actual authorized accounts,
map WebSocket server frames and trusted pointer input. It will retain at most
two bounded genuine frames, duplicate one unchanged frame, deliver a later
sequence before its earlier frame, and deliver pre-clear frames both before
and after expiry. It will assert monotone visible sequence, no preview revival,
and correct durable final coordinates/version. It will not fabricate or mutate
transport payloads, change collaboration behavior, touch the latency driver or
broaden the existing 32-case suite.

Existing authorized Wiki offline/reconnect, recovered confirmed text, and
immutable Save/history checks remain the evidence for Wiki AC-3 behavior; the
new regression adds only the missing late map-frame case. Browser execution
remains pending the explicitly assigned Docker slot.

## Presence ingress finding before the follow-up correction

Before the presence follow-up code, a focused source audit found that
`MapPresenceStore.expire` removes entries on the one-second timer, but
`MapPresenceStore.set` accepts an already-expired frame until that timer runs.
The new live browser case will also hold one genuine presence frame and replay
it only after its server expiry, asserting no peer overlay revival. The store
will refuse invalid or expired `expiresAt` values before publishing. Presence
frames carry no sequence, and their millisecond timestamp does not provide a
sound strict ordering contract for otherwise-live updates, so this follow-up
does not claim to prevent all stale-but-unexpired reordering.
