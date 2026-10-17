-- 0107 (#153 AC-1): a receiving connection may decline a transferred unit before it claims it, which returns the unit
-- paused to the connection that handed it over. Two additive changes:
--  * `cowork.unit.decline` joins the closed standing-grant operation list (rewritten last by 0060; PR #586 owns 0106,
--    which does not touch it). Every existing grant row is unchanged.
--  * `cowork_units.transferred_from_connection_id` remembers the prior assignee for exactly one transfer; a claim or a
--    decline clears it (a stopped unit keeps it harmlessly: decline only acts on a pending unit), so authorship after the first claim (and any artifact) is never rewritten.
ALTER TABLE agent_standing_grants DROP CONSTRAINT IF EXISTS agent_standing_grants_operation_check;
ALTER TABLE agent_standing_grants ADD CONSTRAINT agent_standing_grants_operation_check
  CHECK (operation IN ('work.create','work.update','work.creation.revert','result.record','decision.propose',
    'map.create','map.rename','map.thought.create','map.thought.update','map.thought.delete',
    'map.positions.update','map.link.create','map.link.delete','doc.create','doc.update','conversation.create','conversation.reply',
    'cowork.claim','cowork.renew','cowork.release','cowork.request','cowork.request.claim','cowork.request.respond',
    'cowork.unit.create','cowork.unit.complete','cowork.unit.transfer','cowork.unit.decline'));

ALTER TABLE cowork_units ADD COLUMN IF NOT EXISTS transferred_from_connection_id uuid;
