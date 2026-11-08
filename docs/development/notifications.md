# Notifications: inbox, preferences and email (issue #116)

This page is the contract for foundation area 8.9 as built in
[#116](https://github.com/ColdPhase/flux/issues/116). It covers the SMTP/SSO mail cases of
[#113](https://github.com/ColdPhase/flux/issues/113) and follows Hubert's founder direction on
[#44](https://github.com/ColdPhase/flux/issues/44) (email delivery, 2026-09-27). It builds on
the #41 inbox and Web Push ([mobile PWA](../product/mobile-pwa.md#lock-screen-privacy)).
Migration `0015_notifications.sql`, `FLUX_SCHEMA_VERSION` 15. Migration `0023_notifications_level.sql` (#872) keeps
the level and `email_me` and drops the per-reason `channels` and `email_destination`.

## What notifies, and why

A notification exists only for a reason a person can act on (`reason` on every row):

| Reason | Event | Who |
| --- | --- | --- |
| `mention` | `project.message_sent.v1` / `project.conversation_created.v1` | People named with `@Name` (or opened with `Name,`), as the return view (#106) matches them. |
| `question` | same | A mention that asks something (`?`); or, for an agent's question card (`flux_ask_question`, #347), exactly the one person asked, and nobody else because of that message. |
| `reply` | same | The conversation's starter and earlier writers, unless the message mentions them. |
| `dm` | `dm.message_sent.v1` (now carries `messageId`) | The other current participants. |
| `assigned` | `project.work_created.v1` / `project.work_updated.v1` with `assignedTo` | A person someone else made the owner. |
| `review` | `project.decision_proposed.v1`, `project.result_recorded.v1` | Owners of work the decision affects or the result is about, and the owner of the agent that produced it. |
| `invitation` | `project.live_invited.v1` (`{ sessionId, invitationId, recipientId }`, recorded only when a new invitation row is inserted) | The invited person, while the invitation is still `pending` and its live session `available` ([live sessions](live-sessions.md), #62). |

The actor is never notified. Nothing else notifies: no digests, counts or "you have been away".

## Generation from committed events

The worker (`app/apps/worker/src/notifications`) runs the core use case
`generateNotifications` (`app/packages/core/src/notifications/generate.ts`). In one transaction it
locks `notification_cursor`, reads up to 100 events after it (events commit in `seq` order,
migration 0004), creates their notifications and advances the cursor. A LISTEN on
`flux_events` wakes it right after a commit; a one-minute poll is the backstop. Worker replicas
serialize on the cursor row. Each event runs in its own savepoint. When one fails, the cursor
stops just before it (earlier events commit), the attempt is counted in
`notification_generation_failures`, and the worker retries on a timer with backoff (2, 4 … 60 s), so a
transient error never loses an event's notifications. After 5 failed attempts the event is
dead-lettered (`dead_at` set, logged) and passed, so one poisoned event cannot block everyone.

For each candidate the generator requires, in this order:

1. the person was in the event's recorded audience (`event_audience`, decided at write time);
2. the place (project or DM) is not muted and the person's level lets the reason through (not `nothing`);
3. the access policy lets them read the source **now** (`policySourceReader`, which now
   includes `dm.read`); someone removed in between gets nothing.

Rows are unique per `(user_id, event_id)`, so reprocessing the log never duplicates them. The
source is the project or DM (`source_type` gains `dm`), so the #41 inbox, push preview and
tap-time rechecks apply unchanged. The URL opens the exact message
(`/projects/:p/conversations/:c#message-:m`, `/dm/:d#message-:m`) or the object in Details
(`/projects/:p/tasks?open=work:<id>`). An invitation reads "<inviter> invited you to work
together", body `On “<anchor label>” in <project>` (the conversation's opening message or the
work item, project sketch or doc title, excerpted to 80 characters) and opens
`/projects/:p/live/:session?invitation=:invitation`. Repeated invites of the same person to
the same session converge on one invitation row and record no second event, so there is one
inbox row and one push. Migration `0021_live_invitation_notifications.sql` (`FLUX_SCHEMA_VERSION`
21) adds the reason to the `notifications.reason` check.

## Edited and deleted messages (#1006)

A notice keeps the words it was sent with: an **edit** neither rewrites the notices already stored nor sends new ones (nobody newly
mentioned is told), and an email or push already sent cannot be recalled. A **delete** removes the notices about that message
(`url` = its address), and, for the opening message of a conversation, the `reply` notices of that conversation, whose titles quote
it. Generation skips a message that was deleted before it ran.

## Preferences

`GET/PATCH /api/v1/notification-preferences`; `PUT …/mutes` with `{ type, id, muted }`.
A `PATCH` is partial and atomic: the row is locked (`SELECT … FOR UPDATE`, created with the
defaults if missing), the given fields are merged and written in one transaction, so concurrent
edits of different fields never overwrite each other; for the same field the later request wins.
The settings page sends its saves one after another, numbered, and shows only the newest answer.

- **Level** (#350, F-026 S22; #872): `needsYou` (default, "Only what needs me"), `everything` or `nothing`.
  The inbox always fills, for every reason (the Inbox "always shows everything that waits for you"). Push goes
  to the needs-you reasons (`mention`, `question`, `dm`, `assigned`, `review`, `invitation`) at `needsYou`, to every
  reason (adding `reply`) at `everything`, and to none at `nothing`. Email follows push except for `invitation`: a live call
  invitation is Inbox and push only, because the call can be over before a mail is read (live-sessions.md). Nothing else is stored per reason: the per-kind
  matrix and the per-reason inbox switches went with C-33.
- **Email me too** (`emailMe`, default on, C-32 and C-35): the same events as the level, by email, to every
  enabled, confirmed address (today the sign-in address and a confirmed extra address; one switch per address
  comes with several notification emails). It is a switch beside the level, not a second level: at `nothing`
  it sends nothing. `GET` reports `level`, `emailMe`, `email` (`accountAddress`, `extra`, `available`,
  `lastFailureAt`), `quietHours` and `muted`.
- **Mute a place** (a project or DM the person can read): nothing from it notifies, on any
  channel. The page keeps it behind a "Muted places" row with Change.
- **Quiet hours** (`start`/`end` as `HH:MM`, may cross midnight, IANA `timeZone`; C-31): while they last Flux
  sends no push and no email, and **nothing is sent when they end**. The inbox keeps everything. The window is the
  person's wall clock in their zone (`inQuietHours`, daylight-saving aware). It is checked when the notification is
  generated (no push or email job is queued) and again when a job runs (a job queued before quiet hours began is
  skipped with `quiet hours`; the email row ends `skipped`). Nothing is deferred or queued again, so there is no
  burst when the window ends.
- **Focus mode** (#340, F-026 S19) **went in v0.2** (F-038, #872): there is no pause, no `F` key and no `paused_until`
  column (dropped by migration 0019). Quiet hours are the only way to stop push and email for a while.

Push delivery (#41) rechecks the same preferences before each send (`stillWanted`): a level that no longer
pushes the reason, a muted place or quiet hours skip it. The payload and its lock-screen rule are unchanged.

## Delivery addresses

One extra address per person, in `notification_addresses` — not an auth table. Better Auth never
reads it, so it can never sign in, receive a password reset, or change sessions or grants, and
turning it off never changes the account. `POST /api/v1/notification-address` replaces it and
emails a single-use link (SHA-256 of the token stored, 24 hours, earlier links invalidated);
`POST …/resend`. Verification sends are bounded per person across add, replace and resend — at
least 60 s apart and at most 5 per rolling hour — by one conditional upsert on
`notification_verification_sends` (concurrent requests cannot both pass); otherwise `429
VERIFICATION_RECENTLY_SENT` with `Retry-After`; `POST …/verify` with the token, signed in as the
account that added it (anyone else, a used or an expired token get the same `400
VERIFICATION_INVALID`); `DELETE` removes it and changes nothing else (`emailMe` stays as it was). The
sign-in address cannot be added as extra. The page lists the sign-in address first, then the extra address as
"Confirmed" or waiting ("Send again", Remove), then a field to add another, with the line "We send a
confirmation link to a new address before any notification goes there."; the first email goes only after
confirmation.

## Email

- **Transport.** The administrator sets `FLUX_SMTP_URL` and `FLUX_MAIL_FROM` once for the
  instance (the password reset transport); links use `FLUX_PUBLIC_ORIGIN`. The worker needs all
  three. TLS: `smtps://user:pass@host:465` (implicit TLS) or
  `smtp://user:pass@host:587?requireTLS=true` (STARTTLS required; without `requireTLS`, nodemailer
  upgrades when offered). Certificates are verified; a private CA is trusted with
  `NODE_EXTRA_CA_CERTS`. Keep the password in the environment or a secret store, never in the
  repository. Both TLS modes are tested against TLS-only Mailpit instances in
  `check_application.sh`; a plain-text send to a server that requires TLS fails and is reported.
- **Unavailable.** Without `FLUX_SMTP_URL` no email rows are queued, settings show "Email
  delivery unavailable", adding an address answers `503 EMAIL_UNAVAILABLE`, and the inbox and push
  keep working (`app/tests/app/email-unavailable.check.ts`).
- **Outbox and no duplicates.** `notification_emails` holds one row per (notification, address
  kind), each sent by a `notification.email.v1` job carrying only the row id. The worker locks the
  row, rechecks source access, the level and Email me too for the reason, mute, quiet hours and the address
  (the current sign-in address, or the verified extra one), marks it `sending` with a fresh
  unsubscribe token and commits — only then talks to SMTP. A row that is not `queued` is never
  sent again, so a retry, a concurrent job or a crash after SMTP accepted cannot send it twice
  (at most once). An SMTP failure puts it back to `queued` with `last_error`, pg-boss retries 5
  times (30 s … 15 min), and settings show "A recent notification email could not be delivered";
  the inbox keeps the item.
- **One message per mailbox.** When the account and extra address resolve to the same mailbox,
  the copy claimed second is skipped (`this mailbox already gets this notification`). If the
  copy that had the mailbox fails on its last attempt (the sixth), it ends as `skipped`
  (`delivery failed permanently`) and, in the same locked transaction, the skipped copy goes back
  to `queued` with one new job (#329). That promoted copy is claimed like any other, so access,
  preferences, quiet hours and the address are rechecked at send time, and it has its own retries.
  A failure that is later retried successfully promotes nothing.
- **Calm.** At most one email per person and place in 10 minutes; the inbox holds the rest.
- **Content.** Subject is always "New activity in Flux". The body has only
  `${origin}/inbox/:id` (which rechecks access and opens the source), a settings link and an
  unsubscribe link: no project, person or message text, so nothing leaks to someone removed
  since. `Message-ID` is `<notification-<row id>@host>`.
- **Unsubscribe.** `List-Unsubscribe: <…/api/v1/notifications/unsubscribe?token=…>` and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). The token is bound to the exact
  address the email went to. The POST needs no session. For the sign-in address it turns **Email me too**
  off (`stopped: "account"`, answered with the current `emailMe`); for the extra address it removes that
  address (`stopped: "extra"`), only while that address is still the current one. A link for a replaced
  extra address or a changed sign-in address answers `result: "stale"`, changes nothing, and the page says
  "This link no longer applies". The body links to `/unsubscribe?token=…`, a page with one button. The words
  say what the link does: an email to the sign-in address offers "Stop all notification email" and the page
  before the click says that it turns off Email me too for every address; an email to an extra address offers
  "Stop notification email to this address".

## Inbox UI

The sidebar's **Inbox**, between Home and My tasks, shows how many items are unread (F-026 §4;
the 64 px rail shows the same number). `/inbox` lists "New" and "Earlier" items,
each with its reason, title, excerpt and time; opening one marks it read and opens the source;
"Mark all read" only quiets the dot. `/settings/notifications` (Settings → Notifications, #350)
holds "Tell me about" (Only what needs me, Everything, Nothing), then "Where" (Email me too, On this device and
Quiet hours as one row each), the email addresses, and muted places behind a link row (#872; the focus pause went
with F-038, the plain morning summary is gone, F-038, #858). Installing Flux is the last row, when the browser
offers it. The account menu has no notifications row any more: the name, Settings and Sign out (C-34). `/inbox/:id` (email link) and
`/settings/notifications/verify` are routes of the signed-in app.

## Tests

- `app/tests/app/notifications.test.ts`: generation per reason, once per (person, event) after a
  cursor rewind, mute, Nothing keeping the inbox, generic email content through Mailpit with
  one-click unsubscribe, access recheck before email and push, push preferences, duplicate and
  concurrent sends, extra address verification and expiry, extra address never signing in or
  receiving a reset, the two-SSO-user Email me too matrix (#113), quiet hours dropping what a queued job held,
  STARTTLS and smtps paths. `notification-levels-core.test.ts` and `notifications-core.test.ts`: the level and
  Email me too rules, and quiet hours across daylight-saving changes.
- `app/tests/app/live-invitation-notifications.test.ts`: one invitation item with the exact link,
  repeated invites, the inviter, and invitations that lost access, were answered or whose
  session ended before generation (the cursor is held while they change).
- `app/tests/app/email-unavailable.check.ts` after restarting API and worker without SMTP.
- `app/tests/ui/test_notifications.py`: inbox from the rail, opening sources, mark read, the level, Email me too,
  quiet hours, muting, verifying an address through Mailpit, phone layout, dark mode and the unsubscribe page, a
  failed add keeping its error and address, the first-load error and its Retry, queued saves acknowledging only
  the newest, a failed mute keeping the choice. `test_focus_lifecycle.py`: a queued save is never sent as the next
  account.

Not verified here: real Android/iPhone/iPad push display (MOB-4/MOB-7 in #20) and delivery
through a production mail provider (SPF/DKIM/DMARC are the operator's; see the operator notes
in [containers](containers.md)).
