-- Reversal of 0121 (F-030 S2a-2, #655). Not applied by the migrator. Refuses while an encrypted workspace exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM workspaces WHERE encrypted) THEN
    RAISE EXCEPTION 'An encrypted workspace exists; 0121 cannot be reversed' USING ERRCODE = 'FX409', HINT = 'WORKSPACE_ENCRYPTION_IMMUTABLE';
  END IF;
END $$;
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tg.tgrelid::regclass AS tbl, encode(tg.tgargs, 'escape') AS args FROM pg_trigger tg
    WHERE tg.tgname = 'z_sealed_backstop' AND split_part(encode(tg.tgargs, 'escape'), '\000', 1) = 'workspace_id'
  LOOP
    EXECUTE format('DROP TRIGGER z_sealed_backstop ON %s', t.tbl);
    EXECUTE format('CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION flux_sealed_backstop(%s)', t.tbl,
      (SELECT string_agg(quote_literal(a), ', ' ORDER BY n) FROM unnest(string_to_array(t.args, '\000')) WITH ORDINALITY AS u(a, n) WHERE a <> ''));
  END LOOP;
END $$;
ALTER FUNCTION flux_is_sealed(text) RESET search_path;
ALTER FUNCTION flux_is_sealed(jsonb) RESET search_path;
ALTER FUNCTION workspace_sealed(uuid) RESET search_path;
ALTER FUNCTION flux_sealed_backstop() RESET search_path;
ALTER FUNCTION sealed_workspace_no_ai() RESET search_path;
ALTER FUNCTION sealed_workspace_refused() RESET search_path;
ALTER FUNCTION search_change_log() RESET search_path;
ALTER FUNCTION preserve_draft_version() RESET search_path;
ALTER TABLE task_creation_undo_receipts DROP CONSTRAINT task_creation_undo_receipts_request_fingerprint_check,
  ADD CONSTRAINT task_creation_undo_receipts_request_fingerprint_check CHECK (request_fingerprint ~ '^[a-f0-9]{64}$');
DROP TRIGGER a_idempotency_scope_required ON idempotency_keys;
DROP FUNCTION idempotency_scope_required();
DROP TABLE idempotency_account_operations;
