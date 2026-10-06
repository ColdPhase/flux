-- #153: the current holder completes a co-work unit with an outcome or transfers it to another connection. Both join
-- the closed standing-grant operation list (0034, widened by 0038, 0043, 0049 and 0050), and a completed unit records
-- its outcome reference. Additive and idempotent: every existing grant/receipt/unit row is unchanged. No unit is
-- completed, transferred or claimed here.
ALTER TABLE agent_standing_grants DROP CONSTRAINT IF EXISTS agent_standing_grants_operation_check;
ALTER TABLE agent_standing_grants ADD CONSTRAINT agent_standing_grants_operation_check
  CHECK (operation IN ('work.create','work.update','result.record','decision.propose',
    'map.create','map.rename','map.thought.create','map.thought.update','map.thought.delete',
    'map.positions.update','map.link.create','map.link.delete','doc.create','doc.update','conversation.create','conversation.reply',
    'cowork.claim','cowork.renew','cowork.release','cowork.request','cowork.request.claim','cowork.request.respond',
    'cowork.unit.create','cowork.unit.complete','cowork.unit.transfer'));

-- One exact native reference (result/message ID or a versioned material/doc/work/thought), only on a completed unit.
-- Content-free: the referenced record keeps its own content and author.
ALTER TABLE cowork_units ADD COLUMN IF NOT EXISTS outcome_ref jsonb;
ALTER TABLE cowork_units DROP CONSTRAINT IF EXISTS cowork_units_outcome_check;
ALTER TABLE cowork_units ADD CONSTRAINT cowork_units_outcome_check
  CHECK (outcome_ref IS NULL OR (state = 'completed' AND jsonb_typeof(outcome_ref) = 'object'
    AND outcome_ref->>'type' IN ('result','message','material','doc','work','thought')
    AND octet_length(outcome_ref::text) <= 1024));
