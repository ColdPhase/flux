-- An encrypted workspace's invitation to a call says "a call" like every other notice (founder answer on #1424, 2026-11-13): its stored
-- title is "Ada invited you to a call in <workspace>", no longer "... invited you to work together in ...". Only the content-free check's
-- list of forms changes; it applies to rows written from now on (a row's unchanged title is not checked again, and v0.2.0 left no users).
CREATE OR REPLACE FUNCTION public.flux_notification_content_free() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $function$
DECLARE
  ws text;
  sep text;
  who text;
BEGIN
  IF NEW.workspace_id IS NULL OR NOT workspace_sealed(NEW.workspace_id) THEN RETURN NEW; END IF;
  -- A read-state or delivery update keeps the stored text, which was checked when written: a later rename of the
  -- account or the workspace must not make the row impossible to mark read (#712 review P2-1).
  IF TG_OP = 'UPDATE' AND NEW.title IS NOT DISTINCT FROM OLD.title AND NEW.body IS NOT DISTINCT FROM OLD.body
    AND NEW.url IS NOT DISTINCT FROM OLD.url AND NEW.workspace_id = OLD.workspace_id THEN RETURN NEW; END IF;
  -- The link carries ids only: one of the generator's forms with every id replaced (#712 review P3).
  IF NEW.url IS NOT NULL AND regexp_replace(NEW.url, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'ID', 'g')
    NOT IN ('/inbox', '/projects/ID/conversations/ID#message-ID', '/dm/ID#message-ID', '/projects/ID/tasks?open=work:ID',
      '/projects/ID/tasks?open=decision:ID', '/projects/ID/live/ID?invitation=ID', '/projects/ID/live/ID') THEN
    RAISE EXCEPTION 'An encrypted workspace''s notification must be content-free' USING ERRCODE = 'FX409', HINT = 'NOTIFICATION_CONTENT_REFUSED';
  END IF;
  SELECT name INTO ws FROM workspaces WHERE id = NEW.workspace_id;
  IF NEW.body = '' THEN
    IF NEW.title = ws || '''s encryption keys were changed outside Flux. It stays locked.' THEN RETURN NEW; END IF;
    IF NEW.title = ws || '''s key change cannot finish yet. Ask your server''s operator.' THEN RETURN NEW; END IF;
    FOREACH sep IN ARRAY ARRAY[' mentioned you in ', ' asked you in ', ' replied in ', ' sent you a message in ', ' assigned you a task in ',
      ' asked for your review in ', ' invited you to a call in ', ' now has an unlock password for ', ' started a call in '] LOOP
      IF length(NEW.title) > length(sep || ws) AND right(NEW.title, length(sep || ws)) = sep || ws THEN
        who := left(NEW.title, length(NEW.title) - length(sep || ws));
        IF who IN ('Someone', 'An agent') OR EXISTS (SELECT 1 FROM auth_users u WHERE u.name = who) THEN RETURN NEW; END IF;
      END IF;
    END LOOP;
  END IF;
  RAISE EXCEPTION 'An encrypted workspace''s notification must be content-free' USING ERRCODE = 'FX409', HINT = 'NOTIFICATION_CONTENT_REFUSED';
END $function$;
