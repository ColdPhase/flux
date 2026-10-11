-- Guarded pre-use reversal of 0048 (#238), run after reverse/0060 by the task creation Undo reversal runner, which owns
-- the ledger rows. Lossless only before any feature fact exists: a creation baseline (every task created after the
-- upgrade has one), a first use, a reversion notice or receipt. Otherwise it refuses and changes nothing; recover from
-- the paired pre-upgrade database and files backup with the matching image instead.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM task_creation_undo_receipts) OR EXISTS(SELECT 1 FROM project_task_notices WHERE kind <> 'task.created')
    OR EXISTS(SELECT 1 FROM project_work_items WHERE creation_origin IS NOT NULL OR creation_baseline IS NOT NULL OR creation_baseline_version IS NOT NULL
      OR creation_proposal_id IS NOT NULL OR first_persisted_use_at IS NOT NULL OR creation_reverted_at IS NOT NULL) THEN
    RAISE EXCEPTION '0048 reversal refused: task creation/use history exists' USING ERRCODE = 'restrict_violation';
  END IF;
END $$;
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
