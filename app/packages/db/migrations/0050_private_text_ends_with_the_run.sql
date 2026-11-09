-- The private Flux text a run read is kept only while the run is in flight (#1136, C-30, RT-5): the address check needs it only while the
-- run's token is live. A run that ends (answered, stopped, refused, failed, swept as lost: any status but queued, reading or dispatching)
-- deletes it in the same transaction, whatever path ends the run. A row written while the run ends either commits before the run's
-- update (which then deletes it) or sees the run ended and is never written (`addPrivateText` share-locks the run's row). Flux has no
-- installations or data yet (founder, 2026-10-31): the rows of runs that already ended are simply deleted.
CREATE FUNCTION public.personal_run_private_texts_end() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  DELETE FROM personal_run_private_texts WHERE run_id = NEW.id;
  RETURN NULL;
END $$;
CREATE TRIGGER personal_run_private_texts_end AFTER UPDATE OF status ON public.personal_runs FOR EACH ROW
  WHEN (NEW.status NOT IN ('queued', 'reading', 'dispatching') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.personal_run_private_texts_end();

DELETE FROM public.personal_run_private_texts p USING public.personal_runs r
  WHERE p.run_id = r.id AND r.status NOT IN ('queued', 'reading', 'dispatching');
