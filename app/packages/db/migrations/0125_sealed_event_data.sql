-- F-030 encrypted workspaces, S2a-2c-3 (#655; docs/product/encrypted-workspaces.md#writes-and-reads, Event data): an event
-- of an encrypted workspace carries no content. Every string scalar in its data is a UUID, an ISO timestamp, a sealed
-- envelope, an existing account id, a principal key (human:/agent:) of an existing account or agent, or a token of
-- event_data_tokens, which holds exactly EVENT_DATA_TOKENS of packages/contracts (the registry test compares them).
-- Anything else is refused with EVENT_CONTENT_REFUSED, naming no value. 0124 is S2a-2c-1's.
CREATE TABLE event_data_tokens (token text PRIMARY KEY);
INSERT INTO event_data_tokens (token) VALUES
  ('about'),
  ('accepted'),
  ('admin'),
  ('affects'),
  ('agent'),
  ('assigned'),
  ('blocked'),
  ('contributor'),
  ('conversation'),
  ('copied_from_dm'),
  ('copied_to_project'),
  ('creation_reverted'),
  ('decision'),
  ('denied'),
  ('dm'),
  ('doc'),
  ('done'),
  ('group'),
  ('guest'),
  ('human'),
  ('in_progress'),
  ('invitation'),
  ('left'),
  ('link_added'),
  ('link_removed'),
  ('link_updated'),
  ('map'),
  ('material'),
  ('member'),
  ('mention'),
  ('mentions'),
  ('message'),
  ('not_pursued'),
  ('open'),
  ('owner'),
  ('pair'),
  ('password'),
  ('person'),
  ('private'),
  ('project'),
  ('proposed'),
  ('question'),
  ('recovery'),
  ('rejoined'),
  ('related'),
  ('renamed'),
  ('reply'),
  ('restart'),
  ('restricted'),
  ('result'),
  ('review'),
  ('self'),
  ('sketch'),
  ('source'),
  ('still_applies'),
  ('superseded'),
  ('thought'),
  ('thought_added'),
  ('thought_removed'),
  ('thought_updated'),
  ('thoughts_moved'),
  ('viewer'),
  ('wiki'),
  ('work'),
  ('workspace');
CREATE FUNCTION flux_event_data_free() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v text;
BEGIN
  IF NEW.workspace_id IS NULL OR NOT workspace_sealed(NEW.workspace_id) THEN RETURN NEW; END IF;
  FOR v IN SELECT x #>> '{}' FROM jsonb_path_query(NEW.data, 'strict $.**') AS x WHERE jsonb_typeof(x) = 'string' LOOP
    CONTINUE WHEN v ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
    CONTINUE WHEN v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$';
    CONTINUE WHEN flux_is_sealed(v);
    CONTINUE WHEN EXISTS (SELECT 1 FROM event_data_tokens t WHERE t.token = v);
    CONTINUE WHEN EXISTS (SELECT 1 FROM auth_users u WHERE u.id::text = v);
    CONTINUE WHEN v LIKE 'human:%' AND EXISTS (SELECT 1 FROM auth_users u WHERE u.id::text = substr(v, 7));
    CONTINUE WHEN v LIKE 'agent:%' AND EXISTS (SELECT 1 FROM agents a WHERE a.id::text = substr(v, 7));
    RAISE EXCEPTION 'An encrypted workspace''s event must be content-free' USING ERRCODE = 'FX409', HINT = 'EVENT_CONTENT_REFUSED';
  END LOOP;
  RETURN NEW;
END $$;
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION flux_event_data_free() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $$;
CREATE TRIGGER a_sealed_event_data BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION flux_event_data_free();
-- A wait of a locked workspace's job carries ids only (#717 review P3-5): its payload is {"eventId": <uuid>}.
CREATE FUNCTION flux_sealed_wait_ids_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF jsonb_typeof(NEW.payload) = 'object' AND NOT EXISTS (SELECT 1 FROM jsonb_each(NEW.payload) p
      WHERE p.key <> 'eventId' OR jsonb_typeof(p.value) <> 'string'
        OR NOT (p.value #>> '{}') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'A sealed job wait carries ids only' USING ERRCODE = 'FX409', HINT = 'EVENT_CONTENT_REFUSED';
END $$;
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION flux_sealed_wait_ids_only() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $$;
CREATE TRIGGER a_sealed_wait_ids_only BEFORE INSERT OR UPDATE ON sealed_job_waits FOR EACH ROW EXECUTE FUNCTION flux_sealed_wait_ids_only();
