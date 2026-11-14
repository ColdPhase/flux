-- Direct messages have an unread state (founder decision, Hubert, 2026-11-14, #1424 decision 10; docs/development/direct-messages.md).
-- A direct message is read up to the newest of: the newest root message its participant observed (dm_message_observations), their own
-- newest root, and this mark. Only "Mark all as read" (#1250) writes the mark: the DM is read through its newest message, and its Undo
-- puts back the mark that was there. Ids and a position only; a row goes with its DM, its workspace and its account.
-- Works on data left by v0.2.0: a new table, nothing to convert (a DM nobody marked is read by what was observed, as before).
CREATE TABLE public.dm_reads (
    workspace_id uuid NOT NULL,
    dm_id uuid NOT NULL,
    user_id text NOT NULL,
    read_through integer NOT NULL,
    read_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dm_reads_pkey PRIMARY KEY (dm_id, user_id),
    CONSTRAINT dm_reads_dm_fkey FOREIGN KEY (workspace_id, dm_id) REFERENCES public.dms(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT dm_reads_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auth_users(id) ON DELETE CASCADE,
    CONSTRAINT dm_reads_read_through_check CHECK (read_through >= 0)
);
CREATE INDEX dm_reads_user_idx ON public.dm_reads USING btree (user_id);

-- An answer to your question reaches you (founder decision, Hubert, 2026-11-14, #1424 decision 1; docs/development/needs-you.md): the
-- generator marks the asker's notification of an answer as one, from the answer it found, never from the words. The Inbox names it a Reply
-- in a plain and an encrypted space alike (an encrypted space's title stays its fixed words). A flag, no content; false for every other row.
ALTER TABLE public.notifications ADD COLUMN answer boolean DEFAULT false NOT NULL;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_answer_reason CHECK (NOT answer OR reason IN ('mention', 'question'));
