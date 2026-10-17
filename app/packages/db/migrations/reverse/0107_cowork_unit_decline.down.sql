-- Reversal of 0107 (#153). Not applied by the migrator and never edits the schema ledger: a reversal runner owns that.
-- It forgets which connection handed a pending unit over (the unit stays with its receiver) and removes standing
-- grants of the decline operation before restoring the previous closed list.
ALTER TABLE cowork_units DROP COLUMN IF EXISTS transferred_from_connection_id;
DELETE FROM agent_standing_grants WHERE operation = 'cowork.unit.decline';
ALTER TABLE agent_standing_grants DROP CONSTRAINT IF EXISTS agent_standing_grants_operation_check;
ALTER TABLE agent_standing_grants ADD CONSTRAINT agent_standing_grants_operation_check
  CHECK (operation IN ('work.create','work.update','work.creation.revert','result.record','decision.propose',
    'map.create','map.rename','map.thought.create','map.thought.update','map.thought.delete',
    'map.positions.update','map.link.create','map.link.delete','doc.create','doc.update','conversation.create','conversation.reply',
    'cowork.claim','cowork.renew','cowork.release','cowork.request','cowork.request.claim','cowork.request.respond',
    'cowork.unit.create','cowork.unit.complete','cowork.unit.transfer'));
