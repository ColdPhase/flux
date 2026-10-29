-- F-030 encrypted workspaces, S2a-2c (#655; docs/product/encrypted-workspaces.md#notifications-push-and-e-mail):
-- a sealed workspace's notification is content-free. Its body is empty and its title is one of the fixed templates,
-- whose only variable parts are an existing account name (or "Someone" / "An agent") and the workspace's current
-- name: "<who> mentioned you in <workspace>" and the six other reasons, "<who> now has an unlock password for
-- <workspace>", and "<workspace>'s encryption keys were changed outside Flux. It stays locked.". Anything else is
-- refused with NOTIFICATION_CONTENT_REFUSED, naming no value. 0122 is #704's; 0123 is S2a-2b's.
CREATE FUNCTION flux_notification_content_free() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ws text;
  sep text;
  who text;
BEGIN
  IF NEW.workspace_id IS NULL OR NOT workspace_sealed(NEW.workspace_id) THEN RETURN NEW; END IF;
  SELECT name INTO ws FROM workspaces WHERE id = NEW.workspace_id;
  IF NEW.body = '' THEN
    IF NEW.title = ws || '''s encryption keys were changed outside Flux. It stays locked.' THEN RETURN NEW; END IF;
    FOREACH sep IN ARRAY ARRAY[' mentioned you in ', ' asked you in ', ' replied in ', ' sent you a message in ', ' assigned you a task in ',
      ' asked for your review in ', ' invited you to work together in ', ' now has an unlock password for '] LOOP
      IF length(NEW.title) > length(sep || ws) AND right(NEW.title, length(sep || ws)) = sep || ws THEN
        who := left(NEW.title, length(NEW.title) - length(sep || ws));
        IF who IN ('Someone', 'An agent') OR EXISTS (SELECT 1 FROM auth_users u WHERE u.name = who) THEN RETURN NEW; END IF;
      END IF;
    END LOOP;
  END IF;
  RAISE EXCEPTION 'An encrypted workspace''s notification must be content-free' USING ERRCODE = 'FX409', HINT = 'NOTIFICATION_CONTENT_REFUSED';
END $$;
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION flux_notification_content_free() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $$;
CREATE TRIGGER z_notification_content_free BEFORE INSERT OR UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION flux_notification_content_free();
