-- F-030 encrypted workspaces, S2a-2 (#655; docs/product/encrypted-workspaces.md#idempotency-store):
--  1. The idempotency store's account guard: a stored response with no workspace must name an operation of
--     `IDEMPOTENCY_ACCOUNT_OPERATIONS` (packages/contracts/src/encryption.ts; the registry test compares the two).
--     Every other command declares a scope, so an encrypted workspace's stored responses are sealed (0120's backstop).
--  2. The task-creation Undo receipt fingerprint becomes a sealed digest in a sealed workspace: its check is relaxed
--     like 0120's (validated: the catalog compatibility check requires it, and the table holds one row per Undo).
--  3. Hardening from the S2a-1 review: the sealing functions run with the search_path of this migration, so a
--     function of the same name earlier in a session's search_path cannot stand in for `workspace_sealed`; and the
--     backstops whose row names its workspace directly run only for a sealed workspace (WHEN), so a plain
--     workspace's insert pays one indexed lookup instead of the trigger body.
CREATE FUNCTION pg_temp.here(tbl text) RETURNS regclass LANGUAGE sql STABLE AS
  $$ SELECT to_regclass(format('%I.%I', current_schema(), tbl)) $$;

-- 1.
CREATE TABLE idempotency_account_operations (operation text PRIMARY KEY);
INSERT INTO idempotency_account_operations (operation) VALUES
  ('POST /api/v1/workspaces'),
  ('POST /api/v1/personal-assistant'),
  ('PATCH /api/v1/personal-assistant'),
  ('PUT /api/v1/personal-assistant/model'),
  ('PUT /api/v1/personal-assistant/agents'),
  ('POST /api/v1/personal-assistant/pause'),
  ('POST /api/v1/personal-assistant/resume'),
  ('POST /api/v1/conversations/:conversationId/assistant-runs'),
  ('POST /api/v1/assistant-runs/:runId/stop'),
  ('POST /api/v1/assistant-runs/:runId/retry'),
  ('POST /api/v1/agent-questions/:questionId/answer'),
  ('POST /api/v1/assistant-proposals/:proposalId/accept'),
  ('POST /api/v1/assistant-proposals/:proposalId/dismiss');
CREATE FUNCTION idempotency_scope_required() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id IS NULL AND NOT EXISTS (SELECT 1 FROM idempotency_account_operations WHERE operation = NEW.operation) THEN
    RAISE EXCEPTION 'An Idempotency-Key response needs the workspace of its command' USING ERRCODE = 'FX409', HINT = 'IDEMPOTENCY_SCOPE_REQUIRED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_idempotency_scope_required BEFORE INSERT ON idempotency_keys FOR EACH ROW EXECUTE FUNCTION idempotency_scope_required();

-- 2.
DO $$
DECLARE tbl regclass := pg_temp.here('task_creation_undo_receipts');
BEGIN
  IF tbl IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT task_creation_undo_receipts_request_fingerprint_check, '
      || 'ADD CONSTRAINT task_creation_undo_receipts_request_fingerprint_check CHECK (flux_is_sealed(request_fingerprint) OR (request_fingerprint ~ ''^[a-f0-9]{64}$''))', tbl);
  END IF;
END $$;

-- 3. Pinned search_path (FROM CURRENT: this migration's own, so a replay in another schema keeps working).
ALTER FUNCTION flux_is_sealed(text) SET search_path FROM CURRENT;
ALTER FUNCTION flux_is_sealed(jsonb) SET search_path FROM CURRENT;
ALTER FUNCTION workspace_sealed(uuid) SET search_path FROM CURRENT;
ALTER FUNCTION flux_sealed_backstop() SET search_path FROM CURRENT;
ALTER FUNCTION sealed_workspace_no_ai() SET search_path FROM CURRENT;
ALTER FUNCTION sealed_workspace_refused() SET search_path FROM CURRENT;
ALTER FUNCTION search_change_log() SET search_path FROM CURRENT;
ALTER FUNCTION preserve_draft_version() SET search_path FROM CURRENT;
ALTER FUNCTION idempotency_scope_required() SET search_path FROM CURRENT;

-- Direct-path backstops: skipped for a plain workspace. `via:` tables keep the body (their row names no workspace).
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tg.tgrelid::regclass AS tbl, encode(tg.tgargs, 'escape') AS args FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
    WHERE tg.tgname = 'z_sealed_backstop' AND c.relnamespace = current_schema()::regnamespace AND split_part(encode(tg.tgargs, 'escape'), '\000', 1) = 'workspace_id'
  LOOP
    EXECUTE format('DROP TRIGGER z_sealed_backstop ON %s', t.tbl);
    EXECUTE format('CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON %s FOR EACH ROW WHEN (workspace_sealed(NEW.workspace_id)) '
      || 'EXECUTE FUNCTION flux_sealed_backstop(%s)', t.tbl,
      (SELECT string_agg(quote_literal(a), ', ' ORDER BY n) FROM unnest(string_to_array(t.args, '\000')) WITH ORDINALITY AS u(a, n) WHERE a <> ''));
  END LOOP;
END $$;
