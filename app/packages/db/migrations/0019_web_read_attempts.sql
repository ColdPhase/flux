-- Every address the server sent a request to for an agent's run is kept, not only the pages that came back (#953, F-036 AG-8): a read that
-- the site answered with an error, and each redirect hop, sent the address to the site all the same. `outcome` says what became of the
-- address (`read` is a page that came back; `asked` is written before the request goes out, so a run stopped mid-fetch still lists it);
-- `seen` is the web addresses written in the page that came back, which are the addresses the same run may read next. There is no
-- existing data to keep: a row of the earlier shape is a page that was read.
ALTER TABLE public.personal_run_web_reads
    ADD COLUMN outcome text DEFAULT 'read' NOT NULL,
    ADD COLUMN seen text[] DEFAULT '{}' NOT NULL,
    ADD CONSTRAINT personal_run_web_reads_outcome_check CHECK (outcome IN ('asked', 'read', 'redirected', 'blocked', 'unreachable', 'timeout', 'status', 'type', 'redirects', 'invalid', 'empty')),
    ADD CONSTRAINT personal_run_web_reads_seen_check CHECK (cardinality(seen) <= 50);

-- The web addresses a run was given, fixed when the run starts and made only of text a person wrote (the request, the task, the people's
-- messages in its conversation): what an agent wrote, or the task text after an agent wrote it, is not given (C-30). They are kept with
-- the run because starting a task run moves the task's own timestamp, so the task text cannot be read back later as it was.
ALTER TABLE public.personal_runs
    ADD COLUMN given text[] DEFAULT '{}' NOT NULL,
    ADD CONSTRAINT personal_runs_given_check CHECK (cardinality(given) <= 400);

-- Whether an agent wrote or edited the text of a task (its title, outcome or criteria). Once true it stays true: the text is no longer
-- only a person's, so its addresses are not given to a run.
ALTER TABLE public.project_work_items
    ADD COLUMN text_by_agent boolean DEFAULT false NOT NULL;
