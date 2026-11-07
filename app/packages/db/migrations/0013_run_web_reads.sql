-- The pages an agent's run read on the web (#918, F-036 AG-8): "Web: read-only, always citing the sources". The tool writes one row per page
-- it returned to the run; the run's answer ends with these pages as Flux's own words, so a source is kept by Flux and not by the model.
-- `url` is what the agent asked for, `final_url` where the guarded fetch ended after its redirects. The page's text is never stored.
CREATE TABLE public.personal_run_web_reads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    url text NOT NULL,
    final_url text NOT NULL,
    title text,
    read_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT personal_run_web_reads_pkey PRIMARY KEY (id),
    CONSTRAINT personal_run_web_reads_run_fkey FOREIGN KEY (run_id) REFERENCES public.personal_runs(id) ON DELETE CASCADE,
    CONSTRAINT personal_run_web_reads_url_check CHECK (char_length(url) <= 2048 AND char_length(final_url) <= 2048),
    CONSTRAINT personal_run_web_reads_title_check CHECK (title IS NULL OR char_length(title) <= 300)
);
CREATE INDEX personal_run_web_reads_run_idx ON public.personal_run_web_reads USING btree (run_id, read_at);
