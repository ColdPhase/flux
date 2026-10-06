-- #153: authorized co-work unit creation joins the closed standing-grant operation list (0034, widened by 0038, 0043
-- and 0049). Additive and idempotent: every existing grant/receipt/unit row is unchanged. No unit, claim or
-- assignment is created here; `cowork_units` already exists in 0035.
ALTER TABLE agent_standing_grants DROP CONSTRAINT IF EXISTS agent_standing_grants_operation_check;
ALTER TABLE agent_standing_grants ADD CONSTRAINT agent_standing_grants_operation_check
  CHECK (operation IN ('work.create','work.update','result.record','decision.propose',
    'map.create','map.rename','map.thought.create','map.thought.update','map.thought.delete',
    'map.positions.update','map.link.create','map.link.delete','doc.create','doc.update','conversation.create','conversation.reply',
    'cowork.claim','cowork.renew','cowork.release','cowork.request','cowork.request.claim','cowork.request.respond',
    'cowork.unit.create'));
