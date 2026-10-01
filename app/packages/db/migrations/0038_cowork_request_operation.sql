-- #152/#153: reserve the sender-side request-enqueue operation in the closed standing-grant operation list.
-- Additive and idempotent: every existing grant/receipt row is unchanged, no queue/request storage, grant target or
-- recipient authority is created here (0034 froze the original list; this adds only 'cowork.request').
ALTER TABLE agent_standing_grants DROP CONSTRAINT IF EXISTS agent_standing_grants_operation_check;
ALTER TABLE agent_standing_grants ADD CONSTRAINT agent_standing_grants_operation_check
  CHECK (operation IN ('work.create','work.update','result.record','decision.propose',
    'map.create','map.rename','map.thought.create','map.thought.update','map.thought.delete',
    'map.positions.update','map.link.create','map.link.delete','cowork.claim','cowork.renew','cowork.release','cowork.request'));
