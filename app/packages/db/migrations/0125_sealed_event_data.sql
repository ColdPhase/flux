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
-- Object keys are checked too (#721 review P2-1): a key is "$sealed", a UUID, or one of EVENT_DATA_KEYS (the field
-- names the record sites write), seeded here and compared by the registry test.
CREATE TABLE event_data_keys (key text PRIMARY KEY);
INSERT INTO event_data_keys (key) VALUES
  ('access'),
  ('actor'),
  ('actorId'),
  ('additionalProperties'),
  ('agentId'),
  ('agentIds'),
  ('ai'),
  ('assignedTo'),
  ('at'),
  ('audience'),
  ('author'),
  ('automation'),
  ('body'),
  ('boundary'),
  ('by'),
  ('canCreateProject'),
  ('caps'),
  ('changed'),
  ('changes'),
  ('clientCommandId'),
  ('clientMessageId'),
  ('code'),
  ('columns'),
  ('command'),
  ('commandId'),
  ('contentIdentity'),
  ('conversationId'),
  ('createdAt'),
  ('createdBy'),
  ('data'),
  ('decisionId'),
  ('dm'),
  ('dmId'),
  ('docId'),
  ('draft'),
  ('draftId'),
  ('email'),
  ('end'),
  ('error'),
  ('eventId'),
  ('events'),
  ('evidenceRef'),
  ('expected'),
  ('expiresAt'),
  ('fence'),
  ('file'),
  ('fileId'),
  ('fingerprint'),
  ('firstMessageBody'),
  ('from'),
  ('fromTitle'),
  ('goal'),
  ('goalId'),
  ('grantId'),
  ('hasMoreBefore'),
  ('height'),
  ('id'),
  ('ids'),
  ('inbox'),
  ('index'),
  ('input'),
  ('intent'),
  ('intents'),
  ('interpretation'),
  ('invitationId'),
  ('items'),
  ('keys'),
  ('kind'),
  ('level'),
  ('lifecycle'),
  ('limit'),
  ('link'),
  ('linkId'),
  ('linkIds'),
  ('lock'),
  ('materialId'),
  ('maxLength'),
  ('message'),
  ('messageId'),
  ('messageIds'),
  ('messagePage'),
  ('messages'),
  ('myName'),
  ('name'),
  ('nextBeforeSequence'),
  ('noticeId'),
  ('objectId'),
  ('observed'),
  ('ok'),
  ('op'),
  ('operation'),
  ('outcome'),
  ('owner'),
  ('ownerUserId'),
  ('pairKey'),
  ('participantIds'),
  ('password'),
  ('postconditions'),
  ('principal'),
  ('project'),
  ('projectId'),
  ('prompt'),
  ('proposalId'),
  ('provider'),
  ('query'),
  ('questionId'),
  ('queue'),
  ('reason'),
  ('recipientId'),
  ('recipients'),
  ('record'),
  ('recoveryCode'),
  ('replayed'),
  ('requestId'),
  ('requestedQuestion'),
  ('required'),
  ('resultId'),
  ('results'),
  ('resume'),
  ('retained'),
  ('retryDelay'),
  ('retryLimit'),
  ('retryable'),
  ('reviewerConnectionId'),
  ('reviewerOwnerId'),
  ('revision'),
  ('role'),
  ('rootId'),
  ('rootMessageId'),
  ('row'),
  ('runId'),
  ('runToken'),
  ('runtime'),
  ('sampleId'),
  ('scope'),
  ('session'),
  ('sessionId'),
  ('sketch'),
  ('sketchId'),
  ('source'),
  ('sources'),
  ('stage'),
  ('state'),
  ('status'),
  ('step'),
  ('stop'),
  ('stopId'),
  ('stopped'),
  ('sweep'),
  ('task'),
  ('taskId'),
  ('taskIds'),
  ('taskNoticeId'),
  ('tell'),
  ('text'),
  ('thought'),
  ('thoughtId'),
  ('thoughtIds'),
  ('thoughts'),
  ('title'),
  ('to'),
  ('toTitle'),
  ('tool'),
  ('tools'),
  ('total'),
  ('type'),
  ('userId'),
  ('value'),
  ('verdict'),
  ('version'),
  ('view'),
  ('visibility'),
  ('waitingFor'),
  ('width'),
  ('window'),
  ('work'),
  ('workId'),
  ('workerId'),
  ('workspace'),
  ('workspaceId');
CREATE FUNCTION flux_event_data_free() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v text;
BEGIN
  IF NEW.workspace_id IS NULL OR NOT workspace_sealed(NEW.workspace_id) THEN RETURN NEW; END IF;
  -- The actor and the kind are shapes, never text (#721 review P3-3).
  IF NEW.actor_id !~ '^(human|agent|fixture):[A-Za-z0-9_-]{1,64}$' OR NEW.kind !~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+\.v[0-9]+$' THEN
    RAISE EXCEPTION 'An encrypted workspace''s event must be content-free' USING ERRCODE = 'FX409', HINT = 'EVENT_CONTENT_REFUSED';
  END IF;
  FOR v IN SELECT k #>> '{}' FROM jsonb_path_query(NEW.data, 'strict $.** ? (@.type() == "object").keyvalue().key') AS k LOOP
    CONTINUE WHEN v = '$sealed';
    CONTINUE WHEN v ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
    CONTINUE WHEN EXISTS (SELECT 1 FROM event_data_keys t WHERE t.key = v);
    RAISE EXCEPTION 'An encrypted workspace''s event must be content-free' USING ERRCODE = 'FX409', HINT = 'EVENT_CONTENT_REFUSED';
  END LOOP;
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
CREATE TRIGGER a_sealed_event_data BEFORE INSERT OR UPDATE ON events FOR EACH ROW EXECUTE FUNCTION flux_event_data_free();
-- A wait of a locked workspace's job carries ids only (#717 review P3-5): its payload is {"eventId": <uuid>}.
CREATE FUNCTION flux_sealed_wait_ids_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.queue ~ '^[a-z][a-z0-9_.-]{0,63}$' AND jsonb_typeof(NEW.payload) = 'object' AND NOT EXISTS (SELECT 1 FROM jsonb_each(NEW.payload) p
      WHERE p.key <> 'eventId' OR jsonb_typeof(p.value) <> 'string'
        OR NOT (p.value #>> '{}') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'A sealed job wait carries ids only' USING ERRCODE = 'FX409', HINT = 'EVENT_CONTENT_REFUSED';
END $$;
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION flux_sealed_wait_ids_only() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $$;
CREATE TRIGGER a_sealed_wait_ids_only BEFORE INSERT OR UPDATE ON sealed_job_waits FOR EACH ROW EXECUTE FUNCTION flux_sealed_wait_ids_only();
-- An event's audience row names a principal, never text (#721 review P3-3).
CREATE FUNCTION flux_event_audience_shape() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.recipient ~ '^(human|agent):[A-Za-z0-9_-]{1,64}$' THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM events e WHERE e.id = NEW.event_id AND e.workspace_id IS NOT NULL AND workspace_sealed(e.workspace_id)) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'An encrypted workspace''s event audience names principals only' USING ERRCODE = 'FX409', HINT = 'EVENT_CONTENT_REFUSED';
END $$;
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION flux_event_audience_shape() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $$;
CREATE TRIGGER a_sealed_event_audience BEFORE INSERT OR UPDATE ON event_audience FOR EACH ROW EXECUTE FUNCTION flux_event_audience_shape();
-- A wait whose replay keeps failing is retried a bounded number of times (#721 review P3).
ALTER TABLE sealed_job_waits ADD COLUMN attempts integer NOT NULL DEFAULT 0;
