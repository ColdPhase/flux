# Inbox read reconciliation (#519, #541)

The personal Needs you queue applies successful reads while local actions are
pending. Each queue instance keeps only its latest hide/show intent for each item,
scoped to the signed-in user. Unrelated incoming items remain available even if
another item's write never answers.

A read can retire an intent only if that exact intent's write had already settled
before the read began. Otherwise the response is merged with the latest local
intent: hidden items stay out, and Undo restores its item in sorted position.
The completion of an earlier write cannot retire a later Undo. Rollbacks and
Undo failure feedback apply only while their originating intent is still current;
a failed older command cannot override a newer choice. Each settlement
requests reconciliation independently, including failures. Aborted reads cannot
apply after the instance's user or lifetime changes; asynchronous action callbacks
retain the queue instance where the action began.

Accept remains a delayed command during the Undo window. The shared accepting
set hides the proposal until the command answers. Success synchronously broadcasts the originating user and item key to mounted
queues, removing any cached proposal in Inbox or Home before announcing the
change and requesting a fresh read; failure
restores it. There is no new request timeout or change to the Undo window.

The maintained Inbox browser module covers reads begun before and after Undo,
keyboard selection, unanswered writes with unrelated real updates and failure
recovery, and Accept success while fresh reads are held. Browser clock control
keeps the Accept-window scenario independent of wall-clock speed and toast hover.
