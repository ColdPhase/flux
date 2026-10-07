-- A rollback cannot turn uncertain external work into unfenced admission or
-- silently relabel recovery history. The operator must resolve/archive it first.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM agent_runtime_auth_operations WHERE phase <> 'settled')
    OR EXISTS (SELECT 1 FROM agent_runtime_auth_admission WHERE blocked)
    OR EXISTS (SELECT 1 FROM agent_runtime_bindings WHERE release_reason = 'auth_recovery') THEN
    RAISE EXCEPTION 'Runtime auth recovery/admission/history must be resolved before reversing 0058';
  END IF;
END $$;
DROP TRIGGER agent_runtime_auth_lifecycle ON agent_runtime_bindings;
DROP FUNCTION invalidate_runtime_auth_operations();
DROP TABLE agent_runtime_console_nonces;
DROP TABLE agent_runtime_auth_operations;
DROP TABLE agent_runtime_auth_admission;
ALTER TABLE agent_runtime_bindings DROP CONSTRAINT agent_runtime_bindings_release_reason_check;
ALTER TABLE agent_runtime_bindings ADD CONSTRAINT agent_runtime_bindings_release_reason_check
  CHECK (release_reason IN ('owner', 'operator', 'idle', 'purge', 'bind_failed'));
