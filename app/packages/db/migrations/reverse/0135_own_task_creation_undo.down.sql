-- Reversal of 0135 (#763 B1). It is not applied by the migrator and never edits the schema ledger: a reversal runner owns that.
-- It fails while a person's own task is stored as creation undone; such rows must be resolved first.
ALTER TABLE project_work_items DROP CONSTRAINT task_creation_reversion_shape;
ALTER TABLE project_work_items ADD CONSTRAINT task_creation_reversion_shape CHECK (
  (creation_reverted_at IS NULL AND creation_reverted_by_kind IS NULL AND creation_reverted_by_id IS NULL AND creation_reversion_notice_id IS NULL)
  OR (creation_reverted_at IS NOT NULL AND creation_reverted_by_kind IS NOT NULL AND creation_reverted_by_id IS NOT NULL AND creation_reversion_notice_id IS NOT NULL
    AND creation_baseline_version IS NOT NULL AND creation_origin IN ('native_agent', 'ai_proposal') AND first_persisted_use_at IS NULL));
