-- 0107 (#153 AC-1): a receiving connection may decline a transferred unit before it claims it, which returns the unit
-- paused to the connection that handed it over. Two additive changes:
--  * `cowork.unit.decline` joins the closed standing-grant operation list (0060 also extends it in place; PR #586 owns 0106,
--    which does not touch it). Every existing grant row is unchanged.
--  * `cowork_units.transferred_from_connection_id` remembers the prior assignee for exactly one transfer; a claim, renewal, release or a
--    decline clears it (a stopped unit keeps it harmlessly: decline only acts on a pending unit), so authorship after the first claim (and any artifact) is never rewritten.
-- The list is extended in place (not rewritten from a fixed list) so it is the same whichever of 0060 and 0107 ran last.
DO $$
DECLARE ops text[];
BEGIN
  SELECT array_agg(m[1]) INTO ops FROM pg_constraint c,
    regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''::text', 'g') m
  WHERE c.conrelid = 'agent_standing_grants'::regclass AND c.conname = 'agent_standing_grants_operation_check';
  IF NOT ('cowork.unit.decline' = ANY(ops)) THEN
    ops := array_append(ops, 'cowork.unit.decline');
    ALTER TABLE agent_standing_grants DROP CONSTRAINT agent_standing_grants_operation_check;
    EXECUTE 'ALTER TABLE agent_standing_grants ADD CONSTRAINT agent_standing_grants_operation_check CHECK (operation IN ('
      || (SELECT string_agg(quote_literal(o), ',') FROM unnest(ops) o) || '))';
  END IF;
END $$;

ALTER TABLE cowork_units ADD COLUMN IF NOT EXISTS transferred_from_connection_id uuid;
