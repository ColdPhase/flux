-- F-030 encrypted workspaces, S2a-2 (#655; docs/product/encrypted-workspaces.md#idempotency-store):
--  1. The idempotency store's account guard: a stored response with no workspace must name an operation of
--     `IDEMPOTENCY_ACCOUNT_OPERATIONS` (packages/contracts/src/encryption.ts; the registry test compares the two).
--     Every other command declares a scope, so an encrypted workspace's stored responses are sealed (0120's backstop).
--  2. The task-creation Undo receipt fingerprint becomes a sealed digest in a sealed workspace: its check is relaxed
--     like 0120's (validated: the catalog compatibility check requires it, and the table holds one row per Undo).
--  3. Hardening from the S2a-1 review: every function that decides on a seal runs with an explicit pinned
--     search_path, so nothing earlier in a session's search_path can stand in for `workspace_sealed`; and the
--     backstops whose row names its workspace directly run only for a sealed workspace (WHEN), so a plain
--     workspace's insert pays one indexed lookup instead of the trigger body.
CREATE OR REPLACE FUNCTION pg_temp.here(tbl text) RETURNS regclass LANGUAGE sql STABLE AS
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

-- 3. Pinned search_path: every function of this schema that decides on a seal (its source names workspace_sealed or
-- flux_is_sealed), the two predicates themselves and the idempotency guard run with `pg_catalog, <this schema>`, an
-- explicit list: no "$user" entry (a schema named after the role), no caller's path, and pg_temp last (a temporary
-- table cannot shadow `workspaces`), so nothing can stand in for them. The
-- registry test asserts it for every such function, so the next one cannot be missed.
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS fn FROM pg_proc p
    WHERE p.pronamespace = current_schema()::regnamespace
      AND (p.prosrc ~ '(workspace_sealed|flux_is_sealed)' OR p.proname IN ('workspace_sealed', 'flux_is_sealed', 'idempotency_scope_required'))
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, %I, pg_temp', f.fn, current_schema());
  END LOOP;
END $$;

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
