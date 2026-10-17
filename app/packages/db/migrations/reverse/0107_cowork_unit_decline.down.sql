-- Reversal of 0107 (#153). Not applied by the migrator and never edits the schema ledger: a reversal runner owns that.
-- It forgets which connection handed a pending unit over (the unit stays with its receiver) and removes standing
-- grants of the decline operation before restoring the previous closed list.
ALTER TABLE cowork_units DROP COLUMN IF EXISTS transferred_from_connection_id;
DELETE FROM agent_standing_grants WHERE operation = 'cowork.unit.decline';
DO $$
DECLARE ops text[];
BEGIN
  SELECT array_agg(m[1]) INTO ops FROM pg_constraint c,
    regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''::text', 'g') m
  WHERE c.conrelid = 'agent_standing_grants'::regclass AND c.conname = 'agent_standing_grants_operation_check';
  IF 'cowork.unit.decline' = ANY(ops) THEN
    ops := array_remove(ops, 'cowork.unit.decline');
    ALTER TABLE agent_standing_grants DROP CONSTRAINT agent_standing_grants_operation_check;
    EXECUTE 'ALTER TABLE agent_standing_grants ADD CONSTRAINT agent_standing_grants_operation_check CHECK (operation IN ('
      || (SELECT string_agg(quote_literal(o), ',') FROM unnest(ops) o) || '))';
  END IF;
END $$;
