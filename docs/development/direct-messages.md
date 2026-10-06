# Direct messages (#107)

A direct message (DM) is a private conversation between people of one workspace. It does not
belong to any project. Its audience is exactly its **current participants**. Workspace owners and
admins who are not in a DM cannot read it, count it or learn that it exists. Agents take part only
through an explicit participant grant, which is not part of this slice, so agents see no DMs.
This follows the "DMs and growing an idea" requirement in
[#44](https://github.com/ColdPhase/flux/issues/44) and the design rule that every place shows its
audience ([direction](../design/direction.md), principle 5).

## Model

Migration `0010_direct_messages.sql` adds three tables.

| Table | Meaning |
| --- | --- |
| `dms` | One conversation: `kind` is `pair` (1:1) or `group`, with an optional group `title`, a `version`, the next message sequence and the last activity time. |
| `dm_participants` | The audience. One row per current participant. |
| `dm_messages` | The #36 message shape: a per-DM `sequence`, author, body, `client_message_id` and the request fingerprint. |

- **One 1:1 DM per pair.** A pair DM stores the two user ids, sorted, as `pair_key`, and
  `UNIQUE (workspace_id, pair_key)` rejects a second one. Creation also takes a transaction
  advisory lock on the pair, so concurrent first opens return the same DM.
- **Participants are workspace members.** `(workspace_id, user_id)` references
  `workspace_members` with `ON DELETE CASCADE`. Removing a membership therefore deletes that
  person's participant rows in the same statement. Joining the workspace again does not
  restore them.
- **Composite keys keep everything in one workspace**, as in the other collaborative tables.
- **Message reuse.** Messages follow the [#36 model](conversations.md): the same
  `ConversationMessage` wire type, `normalizeMessage` (body, `clientMessageId` and fingerprint),
  `normalizeConversationWindow` (newest window, `beforeSequence` paging) and consecutive
  sequences under concurrency. DM rows live in their own table because the project message
  tables enforce the project audience with composite foreign keys. Merging them would weaken
  those keys. `app/apps/server/src/conversation` is unchanged.
- **Citations.** A DM message cannot cite project material yet (`422 DM_SOURCE_UNSUPPORTED`).
  Every participant would first need to be able to read the cited version.
- **Sketches.** A DM can hold sketches, and selected messages can start one
  ([#96](https://github.com/ColdPhase/flux/issues/96), see [sketches](sketches.md#sketches-in-a-direct-message)).
  They follow the same participant audience and the same rule for a 1:1 whose other person left.

## Access policy

`dm` is a resource type in `app/packages/core/src/access/policy.ts`. It has no second policy module
(see [access policy](access-policy.md#one-choke-point)).

| Action | Rule |
| --- | --- |
| `dm.create` (workspace) | An active owner, admin or member. Guests can take part when someone adds them, but cannot start a DM (`403`). |
| `dm.read`, `dm.write` | An active person in the DM's workspace who is a current participant. Roles add nothing. |

- `visibleDmsSql` / `visibleFilter(..., 'dm')` puts `EXISTS (participant row for the caller)` into
  both the list and its count. Invisible DMs therefore never reach counts or pages.
- `evaluateDm` with `{ lock: true }` locks the caller's membership (`loadActor`), then the DM
  row `FOR NO KEY UPDATE`, then the caller's participant row `FOR SHARE`. A concurrent leave,
  which deletes that row, or a membership removal, which locks the membership row and then
  cascades, either commits first and is seen, or waits until the send commits.
- An invisible DM answers `404 DM_NOT_FOUND`, including for owners and admins.
- A new participant must be active in the workspace. Otherwise the answer is
  `422 DM_PARTICIPANT_UNAVAILABLE`.

## Events and the stream

Every change records exactly one event in its transaction: `dm.created.v1`,
`dm.message_sent.v1` or `dm.changed.v1` (rename, leave or rejoin, with `data.op`). The object is
the DM id, and the data never contains message text. The event type is `dm`, so `authorizeEvent`
checks `dm.read`. `recordEvent` then writes `event_audience` rows for exactly the participants at
that moment. Delivery and replay check the current participant row again, so:

- a leave is recorded after the participant row is deleted, and the person who left gets no
  frame for it or for any later event;
- after a membership removal, nothing more about the workspace's DMs reaches that person;
- replay from an older cursor skips events of DMs the person has left.

## HTTP API

Routes are in `app/apps/server/src/direct-messages/routes.ts` and wire types in
`app/packages/contracts/src/direct-message.ts`. Every route needs a live session. POST and PATCH
accept `Idempotency-Key` through `app/apps/server/src/http/commands.ts`. A replay first checks
`dm.read` on the stored DM again.

| Method and path | Use |
| --- | --- |
| `GET /api/v1/workspaces/:workspaceId/dms?limit&offset` | The caller's DMs, latest activity first, with participants and the last message. |
| `POST /api/v1/workspaces/:workspaceId/dms` | `{ participantIds, title? }`. One other person opens the pair's 1:1 DM: `201` when it is created, `200` when it already exists, and the caller joins again if they had left. `409 DM_RECIPIENT_LEFT` / `DM_RECIPIENT_UNAVAILABLE` when the other person no longer takes part (see below). Two or more people create a new group (up to 8 people). Retry with the same `Idempotency-Key`. |
| `GET /api/v1/dms/:dmId?limit&beforeSequence` | The DM with its newest message window (`ETag: "<version>"`). `people` also names former participants who wrote in the window. |
| `PATCH /api/v1/dms/:dmId` | Rename a group: `{ title }` with `If-Match` or `expectedVersion` (`428` when missing, `409 VERSION_CONFLICT` when stale). A 1:1 DM has no title (`422`). |
| `POST /api/v1/dms/:dmId/messages` | `{ body, clientMessageId }` returns `201`. A retry with the same `clientMessageId` returns the original message. The same id with other content returns `409 IDEMPOTENCY_CONFLICT`. A 1:1 whose other person is gone answers `409 DM_RECIPIENT_LEFT` / `DM_RECIPIENT_UNAVAILABLE`. |
| `POST /api/v1/dms/:dmId/leave` | `204`. Access ends on the next request. Leaving again answers `404`, because the DM is invisible by then. |

Leaving a group is final unless someone starts a new conversation with the person. Participants
cannot be added to an existing group in this slice, so a new person never sees earlier messages.

**When the other person of a 1:1 is gone** (decided by the evaluator on #111), nobody is re-added
on their behalf and no message goes to an audience of one:

- Opening the pair's DM ("Message Kai") while Kai has left answers `409 DM_RECIPIENT_LEFT`
  ("Kai left this conversation. They can reopen it by messaging you."). If Kai was removed from
  the workspace the code is `409 DM_RECIPIENT_UNAVAILABLE`. No thread is returned, nothing is
  written and no event is recorded.
- Posting into such a DM answers the same `409`. The remaining person can still read its history.
- Only Kai can reopen it, by opening the 1:1 with the other person; that restores both
  participants. A person removed from the workspace and added back must also reopen it themselves
  (their participant row went with the membership, so the answer is then `DM_RECIPIENT_LEFT`).
- If both people left, whoever opens it first takes their own place back, and still cannot send
  until the other reopens it.
- `counterpart` in DM responses names the other person of a 1:1 even after they left, so the UI
  can explain the state.

## Web

- **Sidebar and rail.** The rail's Direct messages place lists the caller's DMs, loaded for every
  workspace in the shell loader, and has a **New message** entry. On the phone they sit in the
  navigation drawer. The shell refreshes the list on `dm.*` stream events.
- **Starting a DM.** `/dm/new` lists people in the space, with search. Choosing one person opens
  the 1:1 DM, and choosing a few starts a group with an optional name. The audience ("Only you and
  Kai") is shown before sending. A person's name in a project conversation links to
  `/dm/new?workspace=…&with=…`, which opens the 1:1 DM directly.
- **The DM view.** `/dm/:dmId` shows a reading column with the people and the audience, day lines
  and the messages, plus the shared composer. The composer reads "Only you and Kai · direct
  message". The header topic and Details show the same audience. The view refetches on its own
  stream events and when the tab regains focus. Sending is instant, with the shared
  composer queue ([conversations](conversations.md#instant-sending-and-the-offline-queue-264-2026-10-06)):
  the message shows at once as "Sending…", a failed one stays as "Not sent" with **Retry** and
  **Remove**, and messages written offline wait and go when the connection is back. The queue
  and its `clientMessageId`s stay in session storage, so **Retry** never duplicates. A `409
  DM_RECIPIENT_LEFT` / `DM_RECIPIENT_UNAVAILABLE` stored nothing: the text returns to the field
  and the notice below explains why. **Leave** asks for
  confirmation first. A DM that is no longer visible shows one quiet line and no old content.
- **When the other person left.** Choosing them (in New message or from their name) shows the
  server's calm explanation instead of a thread. An open 1:1 whose other person left keeps its
  history, shows a quiet notice above the composer, and disables sending.

## Not yet connected

The "since you left" return view (#106) summarizes project and sketch events only. Showing DM
activity there ("Kai wrote to you", audience = participants) needs a DM place in its place
resolution and wording, and is a follow-up.

## Tests

- `app/tests/app/direct-messages.test.ts` (in `./scripts/check_application.sh`) covers idempotent and
  concurrent 1:1 creation; `404` for the owner, the admin, a non-participant member, a guest and
  another tenant, with lists and counts excluding the DM; agent exclusion through `authorize`;
  message retries, `Idempotency-Key` replay, concurrent sequences and paging; group DMs with
  `If-Match` renames; leaving; workspace removal; and stream and replay audiences. It also covers
  opening or posting to a 1:1 after the other person left or was removed (409, nothing stored, no
  event), removal followed by readdition, and the other person reopening it with delivery to both.
- `app/tests/ui/test_direct_messages.py` (in `./scripts/check_ui.sh`) signs up three people. It covers
  starting a DM from the sidebar, a reply from a second browser that arrives live, a lost response
  retried without a duplicate, an outsider being refused, the phone layout, and a group DM with
  Details and leaving, and clicking a person's name after they left (a notice, then a disabled
  composer until they reopen it). Screenshots are in [`docs/design/direct-messages/`](../design/direct-messages/).
- `./flux demo` seeds a 1:1 DM between the two demo accounts through the public API, and
  `scripts/check_flux_cli.sh` reads it back as the partner.
