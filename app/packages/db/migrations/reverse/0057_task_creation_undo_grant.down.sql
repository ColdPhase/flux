-- Guarded pre-use reversal of 0057 (#238), run before reverse/0048 by the task creation Undo reversal runner, which
-- owns the ledger rows. It refuses (and changes nothing) once an owner granted `work.creation.revert`; after that,
-- recover from the paired pre-upgrade backup with the matching image.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_standing_grants WHERE operation = 'work.creation.revert') THEN
    RAISE EXCEPTION '0057 reversal refused: work.creation.revert grants exist' USING ERRCODE = 'restrict_violation';
  END IF;
END $$;
ALTER TABLE agent_standing_grants DROP CONSTRAINT IF EXISTS agent_standing_grants_operation_check;
ALTER TABLE agent_standing_grants ADD CONSTRAINT agent_standing_grants_operation_check
  CHECK (operation IN ('work.create','work.update','result.record','decision.propose',
    'map.create','map.rename','map.thought.create','map.thought.update','map.thought.delete',
    'map.positions.update','map.link.create','map.link.delete','doc.create','doc.update','conversation.create','conversation.reply',
    'cowork.claim','cowork.renew','cowork.release','cowork.request','cowork.request.claim','cowork.request.respond',
    'cowork.unit.create','cowork.unit.complete','cowork.unit.transfer'));
