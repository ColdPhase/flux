-- #1381 (C-62): what a run's own Flux tools returned to be cited. Each tool result that returns a Wiki page, task, decision or message carries
-- its mark (`cite`, `[doc:ID]`); the server keeps the kind and id of every such object a result returned, once per run, and when the answer is
-- committed only a mark the run's tools returned is resolved into a numbered source (a mark a person wrote in a message is words). Like the
-- private Flux text a run read (0049, 0050), it is kept only while the run is in flight: the trigger deletes it when the run ends, whatever
-- ends it, and it goes with the run. No content: kinds and ids. Works on data left by v0.2.0: a new empty table, nothing to convert.
CREATE TABLE public.personal_run_cites (
    run_id uuid NOT NULL,
    kind text NOT NULL,
    object_id uuid NOT NULL,
    CONSTRAINT personal_run_cites_pkey PRIMARY KEY (run_id, kind, object_id),
    CONSTRAINT personal_run_cites_kind_check CHECK (kind = ANY (ARRAY['doc'::text, 'task'::text, 'decision'::text, 'message'::text])),
    CONSTRAINT personal_run_cites_run_fkey FOREIGN KEY (run_id) REFERENCES public.personal_runs(id) ON DELETE CASCADE
);

CREATE FUNCTION public.personal_run_cites_end() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  DELETE FROM personal_run_cites WHERE run_id = NEW.id;
  RETURN NULL;
END $$;
CREATE TRIGGER personal_run_cites_end AFTER UPDATE OF status ON public.personal_runs FOR EACH ROW
  WHEN (NEW.status NOT IN ('queued', 'reading', 'dispatching') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.personal_run_cites_end();
