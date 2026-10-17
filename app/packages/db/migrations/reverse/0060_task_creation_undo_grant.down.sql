-- Guarded pre-use reversal of 0060 (#238), run before reverse/0048 by the task creation Undo reversal runner, which
-- owns the ledger rows. It refuses (and changes nothing) once an owner granted `work.creation.revert`; after that,
-- recover from the paired pre-upgrade backup with the matching image.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_standing_grants WHERE operation = 'work.creation.revert') THEN
    RAISE EXCEPTION '0060 reversal refused: work.creation.revert grants exist' USING ERRCODE = 'restrict_violation';
  END IF;
END $$;
DO $$
DECLARE ops text[];
BEGIN
  SELECT array_agg(m[1]) INTO ops FROM pg_constraint c,
    regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''::text', 'g') m
  WHERE c.conrelid = 'agent_standing_grants'::regclass AND c.conname = 'agent_standing_grants_operation_check';
  IF ops IS NULL THEN
    RAISE EXCEPTION '0060 reversal refused: agent_standing_grants_operation_check is missing or lists no operations' USING ERRCODE = 'restrict_violation';
  END IF;
  IF 'work.creation.revert' = ANY(ops) THEN
    ops := array_remove(ops, 'work.creation.revert');
    ALTER TABLE agent_standing_grants DROP CONSTRAINT agent_standing_grants_operation_check;
    EXECUTE 'ALTER TABLE agent_standing_grants ADD CONSTRAINT agent_standing_grants_operation_check CHECK (operation IN ('
      || (SELECT string_agg(quote_literal(o), ',') FROM unnest(ops) o) || '))';
  END IF;
END $$;
