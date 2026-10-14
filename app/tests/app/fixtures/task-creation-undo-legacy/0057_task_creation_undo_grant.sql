-- #238: an agent may undo only its own unused native task creation, under the exact `work.creation.revert`
-- standing grant; an ordinary `work.update` grant never authorizes it. The operation joins the closed list
-- (0034, widened by 0038, 0043, 0049, 0050 and 0054). It cannot live in 0048: on a fresh database 0049, 0050 and
-- 0054 run after 0048 and each rewrites the whole list, so the widening has to come after the latest rewrite.
-- Additive and idempotent: every existing grant row is unchanged. A later rewrite of this list must keep it.
ALTER TABLE agent_standing_grants DROP CONSTRAINT IF EXISTS agent_standing_grants_operation_check;
ALTER TABLE agent_standing_grants ADD CONSTRAINT agent_standing_grants_operation_check
  CHECK (operation IN ('work.create','work.update','work.creation.revert','result.record','decision.propose',
    'map.create','map.rename','map.thought.create','map.thought.update','map.thought.delete',
    'map.positions.update','map.link.create','map.link.delete','doc.create','doc.update','conversation.create','conversation.reply',
    'cowork.claim','cowork.renew','cowork.release','cowork.request','cowork.request.claim','cowork.request.respond',
    'cowork.unit.create','cowork.unit.complete','cowork.unit.transfer'));
