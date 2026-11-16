-- Done in the Inbox on a task given to you or on a blocked item changes the task, and its Undo and the "done today" Put back change it
-- back (personas-33, docs/development/needs-you.md "What Done changed is kept with the choice"). The choice keeps what to put back: ids and
-- numbers only (the task, its version right after, the state to return to and what it waited for), never words; the reason a blocked task
-- had is read from the activity entry of its move out of Blocked, sealed there. Nothing to convert: a choice made before has no restore.
ALTER TABLE public.needs_you_states ADD COLUMN restore jsonb;
