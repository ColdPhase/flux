-- #763 B1 (2026-10-30): a person may undo their own new task from the toast after creating it, through the #238 creation
-- Undo command and history. The reverted-row shape now also admits origin 'human'; the core decides who (its creator only)
-- and when (unchanged, unused). Every other part of the shape is unchanged. No row changes. Sparse after 0134 (0133 belongs
-- to other open work).
ALTER TABLE project_work_items DROP CONSTRAINT task_creation_reversion_shape;
ALTER TABLE project_work_items ADD CONSTRAINT task_creation_reversion_shape CHECK (
  (creation_reverted_at IS NULL AND creation_reverted_by_kind IS NULL AND creation_reverted_by_id IS NULL AND creation_reversion_notice_id IS NULL)
  OR (creation_reverted_at IS NOT NULL AND creation_reverted_by_kind IS NOT NULL AND creation_reverted_by_id IS NOT NULL AND creation_reversion_notice_id IS NOT NULL
    AND creation_baseline_version IS NOT NULL AND creation_origin IN ('native_agent', 'ai_proposal', 'human') AND first_persisted_use_at IS NULL));
