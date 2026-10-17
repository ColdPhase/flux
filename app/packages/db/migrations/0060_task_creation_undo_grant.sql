-- #238: an agent may undo only its own unused native task creation, under the exact `work.creation.revert`
-- standing grant; an ordinary `work.update` grant never authorizes it. The operation joins the closed list
-- (0034, widened by 0038, 0043, 0049, 0050 and 0054). It cannot live in 0048: on a fresh database 0049, 0050 and
-- 0054 run after 0048 and each rewrites the whole list, so the widening has to come after the latest rewrite.
-- Additive and idempotent: every existing grant row is unchanged. A later rewrite of this list must keep it.
-- Extended in place (not rewritten from a fixed list), so a later addition such as 0107's is kept whatever the order.
DO $$
DECLARE ops text[];
BEGIN
  SELECT array_agg(m[1]) INTO ops FROM pg_constraint c,
    regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''::text', 'g') m
  WHERE c.conrelid = 'agent_standing_grants'::regclass AND c.conname = 'agent_standing_grants_operation_check';
  IF ops IS NULL THEN
    RAISE EXCEPTION '0060 refused: agent_standing_grants_operation_check is missing or lists no operations' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT ('work.creation.revert' = ANY(ops)) THEN
    ops := array_append(ops, 'work.creation.revert');
    ALTER TABLE agent_standing_grants DROP CONSTRAINT agent_standing_grants_operation_check;
    EXECUTE 'ALTER TABLE agent_standing_grants ADD CONSTRAINT agent_standing_grants_operation_check CHECK (operation IN ('
      || (SELECT string_agg(quote_literal(o), ',') FROM unnest(ops) o) || '))';
  END IF;
END $$;
