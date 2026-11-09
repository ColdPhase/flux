-- An agent may open any web address (#1065, founder direction 2026-11-09, C-30): the lists of addresses a run or a schedule was given go,
-- and so do the addresses kept from each page a run read, the mark of a task whose text an agent wrote (it only kept that text from
-- giving addresses), and a search's "in progress" (a read waited for it only to see whether its results gave an address). What the server checks instead is that an address does not
-- carry private Flux text the run read: that text is kept with the run, already compared-ready (lower case, decoded, the addresses and
-- host names written in it left out), until the run is deleted. Flux has no installations or data yet (founder, 2026-10-31): nothing is
-- converted.
ALTER TABLE public.personal_runs DROP COLUMN given;
ALTER TABLE public.assistant_jobs DROP COLUMN given;
ALTER TABLE public.project_work_items DROP COLUMN text_by_agent;
ALTER TABLE public.personal_run_web_searches DROP COLUMN pending;
ALTER TABLE public.personal_run_web_reads DROP COLUMN seen;

CREATE TABLE public.personal_run_private_texts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    body text NOT NULL,
    read_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT personal_run_private_texts_pkey PRIMARY KEY (id),
    CONSTRAINT personal_run_private_texts_run_fkey FOREIGN KEY (run_id) REFERENCES public.personal_runs(id) ON DELETE CASCADE
);
CREATE INDEX personal_run_private_texts_run_idx ON public.personal_run_private_texts USING btree (run_id);
