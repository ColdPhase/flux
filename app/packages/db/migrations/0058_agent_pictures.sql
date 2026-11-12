-- An agent attaches a picture to its answer (#1217, F-036 AG-8, C-59): the change log names it as a picture, so its line reads "attached the
-- picture …" with Undo. The picture itself is an ordinary stored file staged for the asker; nothing else of the schema changes. Works on data
-- left by v0.2.0: it widens a CHECK and replaces one trigger function.
ALTER TABLE public.assistant_changes DROP CONSTRAINT assistant_changes_object_type_check;
ALTER TABLE public.assistant_changes ADD CONSTRAINT assistant_changes_object_type_check
  CHECK (object_type = ANY (ARRAY['work'::text, 'doc'::text, 'map'::text, 'thought'::text, 'link'::text, 'message'::text, 'decision'::text, 'picture'::text]));

-- While a picture of a run waits for its owner's OK, the run keeps the private Flux text it read (C-30), so that Approve checks the address and
-- every redirect hop against it as the run's own call did (founder decision on #1217, 2026-11-12). It goes once the run has ended and nothing
-- of it waits: at the run's end (the function of 0050, replaced) or when its last waiting picture is decided.
CREATE OR REPLACE FUNCTION public.personal_run_private_texts_end() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM assistant_changes WHERE run_id = NEW.id AND operation = 'answer.picture.attach' AND state = 'waiting') THEN
    DELETE FROM personal_run_private_texts WHERE run_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE FUNCTION public.personal_run_private_texts_decided() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  IF NEW.run_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM personal_runs WHERE id = NEW.run_id AND status NOT IN ('queued', 'reading', 'dispatching'))
    AND NOT EXISTS (SELECT 1 FROM assistant_changes WHERE run_id = NEW.run_id AND operation = 'answer.picture.attach' AND state = 'waiting') THEN
    DELETE FROM personal_run_private_texts WHERE run_id = NEW.run_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER personal_run_private_texts_decided AFTER UPDATE OF state ON public.assistant_changes FOR EACH ROW
  WHEN (OLD.state = 'waiting' AND NEW.state <> 'waiting' AND NEW.operation = 'answer.picture.attach')
  EXECUTE FUNCTION public.personal_run_private_texts_decided();
