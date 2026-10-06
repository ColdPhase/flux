-- #153: the recipient's request claim and response operations join the closed standing-grant operation list
-- (0034, widened by 0038 and 0043). Additive and idempotent: every existing grant/receipt row is unchanged. No
-- request, claim or publication authority is created here; the request columns already exist in 0035.
-- Sparse: 0045–0048 are reserved by open branches (#154 files, #228, #238).
ALTER TABLE agent_standing_grants DROP CONSTRAINT IF EXISTS agent_standing_grants_operation_check;
ALTER TABLE agent_standing_grants ADD CONSTRAINT agent_standing_grants_operation_check
  CHECK (operation IN ('work.create','work.update','result.record','decision.propose',
    'map.create','map.rename','map.thought.create','map.thought.update','map.thought.delete',
    'map.positions.update','map.link.create','map.link.delete','doc.create','doc.update','conversation.create','conversation.reply',
    'cowork.claim','cowork.renew','cowork.release','cowork.request','cowork.request.claim','cowork.request.respond'));
