-- Schema-only; the guarded reversal runner owns the exact version48 ledger change.
-- Lossless only before feature facts have been used. A paired backup and matching image are needed afterwards.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM task_creation_undo_receipts) OR EXISTS(SELECT 1 FROM project_task_notices WHERE kind <> 'task.created')
    OR EXISTS(SELECT 1 FROM project_work_items WHERE creation_origin IS NOT NULL OR creation_baseline IS NOT NULL OR creation_baseline_version IS NOT NULL
      OR creation_proposal_id IS NOT NULL OR first_persisted_use_at IS NOT NULL OR creation_reverted_at IS NOT NULL) THEN
    RAISE EXCEPTION '0048 reversal refused: task creation/use history exists' USING ERRCODE = 'restrict_violation';
  END IF;
END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM agent_standing_grants WHERE operation = 'work.creation.revert') THEN RAISE EXCEPTION 'Cannot reverse 0048 after Undo grants'; END IF; END $$;
ALTER TABLE agent_standing_grants DROP CONSTRAINT agent_standing_grants_operation_check;
ALTER TABLE agent_standing_grants ADD CONSTRAINT agent_standing_grants_operation_check
 CHECK (operation IN ('work.create','work.update','result.record','decision.propose','map.create','map.rename','map.thought.create','map.thought.update','map.thought.delete','map.positions.update','map.link.create','map.link.delete','doc.create','doc.update','conversation.create','conversation.reply','cowork.claim','cowork.renew','cowork.release','cowork.request'));
DROP TRIGGER task_creation_history_guard ON project_work_items;
DROP FUNCTION flux_guard_task_creation_history();
DROP TRIGGER task_creation_receipt_guard ON task_creation_undo_receipts;
DROP FUNCTION flux_guard_task_creation_receipt();
DROP TABLE task_creation_undo_receipts;
ALTER TABLE project_work_items DROP CONSTRAINT task_creation_reversion_notice_scope;
ALTER TABLE project_task_notices DROP CONSTRAINT task_notice_scope_identity;
ALTER TABLE project_task_notices DROP CONSTRAINT project_task_notices_kind_check;
ALTER TABLE project_task_notices ADD CONSTRAINT project_task_notices_kind_check CHECK(kind = 'task.created');
ALTER TABLE project_work_items DROP CONSTRAINT task_creation_proposal_scope;
ALTER TABLE project_work_items DROP CONSTRAINT task_creation_reversion_shape;
ALTER TABLE project_work_items DROP CONSTRAINT task_creation_proposal_origin;
ALTER TABLE project_work_items DROP CONSTRAINT task_creation_baseline_origin;
ALTER TABLE project_work_items DROP COLUMN creation_origin, DROP COLUMN creation_baseline, DROP COLUMN creation_baseline_version, DROP COLUMN creation_proposal_id,
  DROP COLUMN first_persisted_use_at, DROP COLUMN creation_reverted_at, DROP COLUMN creation_reverted_by_kind,
  DROP COLUMN creation_reverted_by_id, DROP COLUMN creation_reversion_notice_id;

ALTER TABLE proactive_comparison_proposals DROP CONSTRAINT task_creation_proposal_identity;
