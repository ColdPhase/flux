-- #868, #1054: there is no Result object. A task says what came of it in the one optional line at Done (0035), and what matters is
-- written to a Wiki page. The table, the links that named a result, the "result" contribution of a task's discussion, the receipts and
-- search rows of results, the assistant's proposals (a proposal could only record a result) and every check that listed "result" go.
-- Flux has no installations or data yet (founder, 2026-10-31): nothing is converted; what refers to a result in a development
-- database is deleted, and a discussion line that announced one stays as an ordinary line of its task.

-- What refers to a result goes first.
DELETE FROM public.project_object_links WHERE from_type = 'result' OR to_type = 'result' OR role = 'about';
DELETE FROM public.search_documents WHERE kind = 'result';
DELETE FROM public.assistant_changes WHERE object_type = 'result';
DELETE FROM public.native_command_receipts WHERE operation = 'result.create';
DELETE FROM public.live_presentations WHERE ref_type = 'result';
UPDATE public.cowork_units SET outcome_ref = NULL WHERE outcome_ref ->> 'type' = 'result';
DELETE FROM public.notifications WHERE url LIKE '%?open=result:%';
UPDATE public.project_messages SET contribution_kind = 'text', result_id = NULL WHERE contribution_kind = 'result';

-- The assistant's proposals: a scheduled run drafted one and a person accepted it as a result. There is nothing else to propose.
DROP TABLE public.assistant_proposals;

-- A task's discussion line: no "result" kind and no result it names.
DROP INDEX public.project_messages_result_idx;
ALTER TABLE public.project_messages DROP CONSTRAINT project_message_result_reference;
ALTER TABLE public.project_messages DROP CONSTRAINT project_message_result_scope;
ALTER TABLE public.project_messages DROP COLUMN result_id;
ALTER TABLE public.project_messages DROP CONSTRAINT project_message_contribution_kind;
ALTER TABLE public.project_messages ADD CONSTRAINT project_message_contribution_kind
  CHECK (contribution_kind = ANY (ARRAY['text'::text, 'blocker'::text, 'handoff'::text, 'came_of_it'::text]));

-- The receipts of a native command are the receipts of a task's update only.
ALTER TABLE public.native_command_receipts DROP CONSTRAINT native_command_receipts_check;
ALTER TABLE public.native_command_receipts DROP CONSTRAINT native_command_receipts_check1;
ALTER TABLE public.native_command_receipts DROP CONSTRAINT native_command_receipts_operation_check;
ALTER TABLE public.native_command_receipts DROP CONSTRAINT native_command_receipts_workspace_id_project_id_result_id_fkey;
ALTER TABLE public.native_command_receipts DROP COLUMN result_id;
ALTER TABLE public.native_command_receipts ALTER COLUMN work_id SET NOT NULL, ALTER COLUMN work_version SET NOT NULL;
ALTER TABLE public.native_command_receipts ADD CONSTRAINT native_command_receipts_operation_check CHECK (operation = 'work.update'::text);

-- The table, with its trigger of the search index, its backstop of sealed workspaces and its keys.
DROP TABLE public.project_results;
DROP FUNCTION public.search_index_result();

-- Links name a task or a decision, and no link says "about" any more: only a result reported on something.
ALTER TABLE public.project_object_links DROP CONSTRAINT project_object_links_from_type_check;
ALTER TABLE public.project_object_links ADD CONSTRAINT project_object_links_from_type_check
  CHECK (from_type = ANY (ARRAY['work'::text, 'decision'::text, 'doc'::text]));
ALTER TABLE public.project_object_links DROP CONSTRAINT project_object_links_to_type_check;
ALTER TABLE public.project_object_links ADD CONSTRAINT project_object_links_to_type_check
  CHECK (to_type = ANY (ARRAY['message'::text, 'thought'::text, 'material'::text, 'work'::text, 'decision'::text, 'doc'::text, 'sketch'::text]));
ALTER TABLE public.project_object_links DROP CONSTRAINT project_object_links_role_check;
ALTER TABLE public.project_object_links ADD CONSTRAINT project_object_links_role_check
  CHECK (role = ANY (ARRAY['source'::text, 'affects'::text, 'related'::text, 'mentions'::text, 'part_of'::text]));

ALTER TABLE public.search_documents DROP CONSTRAINT search_documents_kind_check;
ALTER TABLE public.search_documents ADD CONSTRAINT search_documents_kind_check
  CHECK (kind = ANY (ARRAY['project'::text, 'message'::text, 'dm_message'::text, 'material'::text, 'doc'::text, 'work'::text, 'decision'::text, 'sketch'::text, 'thought'::text, 'person'::text]));

ALTER TABLE public.assistant_changes DROP CONSTRAINT assistant_changes_object_type_check;
ALTER TABLE public.assistant_changes ADD CONSTRAINT assistant_changes_object_type_check
  CHECK (object_type = ANY (ARRAY['work'::text, 'doc'::text, 'map'::text, 'thought'::text, 'link'::text, 'message'::text, 'decision'::text]));

ALTER TABLE public.live_presentations DROP CONSTRAINT live_presentations_ref_type_check;
ALTER TABLE public.live_presentations ADD CONSTRAINT live_presentations_ref_type_check
  CHECK (ref_type = ANY (ARRAY['message'::text, 'material'::text, 'work'::text, 'sketch'::text]));

ALTER TABLE public.cowork_units DROP CONSTRAINT cowork_units_outcome_check;
ALTER TABLE public.cowork_units ADD CONSTRAINT cowork_units_outcome_check
  CHECK ((outcome_ref IS NULL) OR ((state = 'completed'::text) AND (jsonb_typeof(outcome_ref) = 'object'::text)
    AND ((outcome_ref ->> 'type'::text) = ANY (ARRAY['message'::text, 'material'::text, 'doc'::text, 'work'::text, 'thought'::text]))
    AND (octet_length((outcome_ref)::text) <= 1024)));

-- A notification of an encrypted workspace may link a task, a decision, a conversation message, a direct message, the Inbox or a live invitation.
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
      '/projects/ID/tasks?open=decision:ID', '/projects/ID/live/ID?invitation=ID') THEN
    RAISE EXCEPTION 'An encrypted workspace''s notification must be content-free' USING ERRCODE = 'FX409', HINT = 'NOTIFICATION_CONTENT_REFUSED';
  END IF;
  SELECT name INTO ws FROM workspaces WHERE id = NEW.workspace_id;
  IF NEW.body = '' THEN
    IF NEW.title = ws || '''s encryption keys were changed outside Flux. It stays locked.' THEN RETURN NEW; END IF;
    IF NEW.title = ws || '''s key change cannot finish yet. Ask your server''s operator.' THEN RETURN NEW; END IF;
    FOREACH sep IN ARRAY ARRAY[' mentioned you in ', ' asked you in ', ' replied in ', ' sent you a message in ', ' assigned you a task in ',
      ' asked for your review in ', ' invited you to work together in ', ' now has an unlock password for '] LOOP
      IF length(NEW.title) > length(sep || ws) AND right(NEW.title, length(sep || ws)) = sep || ws THEN
        who := left(NEW.title, length(NEW.title) - length(sep || ws));
        IF who IN ('Someone', 'An agent') OR EXISTS (SELECT 1 FROM auth_users u WHERE u.name = who) THEN RETURN NEW; END IF;
      END IF;
    END LOOP;
  END IF;
  RAISE EXCEPTION 'An encrypted workspace''s notification must be content-free' USING ERRCODE = 'FX409', HINT = 'NOTIFICATION_CONTENT_REFUSED';
END $function$;

-- A sealed job wait carries the event it waits for and no result.
CREATE OR REPLACE FUNCTION public.flux_sealed_wait_ids_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $function$
BEGIN
  IF NEW.queue ~ '^[a-z][a-z0-9_.-]{0,63}$' AND jsonb_typeof(NEW.payload) = 'object' AND NOT EXISTS (SELECT 1 FROM jsonb_each(NEW.payload) p
      WHERE p.key <> 'eventId' OR jsonb_typeof(p.value) <> 'string'
        OR NOT (p.value #>> '{}') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'A sealed job wait carries ids only' USING ERRCODE = 'FX409', HINT = 'EVENT_CONTENT_REFUSED';
END $function$;

-- Event data in an encrypted workspace: the words of results and of the assistant's proposals go.
DELETE FROM public.event_data_tokens WHERE token IN ('about', 'result');
DELETE FROM public.event_data_keys WHERE key IN ('resultId', 'proposalId');

-- The two account-scoped commands of the assistant's proposals (accept and dismiss) are gone with them.
DELETE FROM public.idempotency_account_operations WHERE operation IN ('POST /api/v1/assistant-proposals/:proposalId/accept', 'POST /api/v1/assistant-proposals/:proposalId/dismiss');
