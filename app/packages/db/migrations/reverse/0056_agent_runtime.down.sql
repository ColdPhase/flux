-- Guarded pre-use reversal of 0056 (#278). It is not applied by the migrator and never edits the schema ledger:
-- a reversal runner owns that. It refuses (and changes nothing) once any runtime binding or connection was
-- recorded: the slot volumes then hold owners' logins that the previous version cannot sign out. After real
-- use, run ./flux runtime purge with this version first, or recover from the paired pre-upgrade backup.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_runtime_bindings) OR EXISTS (SELECT 1 FROM agent_runtime_connections) THEN
    RAISE EXCEPTION '0056 reversal refused: runtime bindings exist' USING ERRCODE = 'restrict_violation';
  END IF;
END $$;
DROP TABLE agent_runtime_operator_statements;
DROP TABLE agent_runtime_connections;
DROP TABLE agent_runtime_bindings;
DROP TABLE agent_runtime_slots;
