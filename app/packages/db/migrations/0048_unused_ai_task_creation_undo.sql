-- #238: no historical origin, baseline, use or notice is reconstructed.
ALTER TABLE project_work_items
  ADD COLUMN creation_origin text CHECK (creation_origin IN ('native_agent', 'ai_proposal', 'human')),
  ADD COLUMN creation_baseline jsonb,
  ADD COLUMN creation_baseline_version integer CHECK (creation_baseline_version > 0),
  ADD COLUMN creation_proposal_id uuid,
  ADD COLUMN first_persisted_use_at timestamptz,
  ADD COLUMN creation_reverted_at timestamptz,
  ADD COLUMN creation_reverted_by_kind text CHECK (creation_reverted_by_kind IN ('human', 'agent')),
  ADD COLUMN creation_reverted_by_id text,
  ADD COLUMN creation_reversion_notice_id uuid,
  ADD CONSTRAINT task_creation_baseline_origin CHECK ((creation_baseline_version IS NULL) = (creation_origin IS NULL) AND (creation_baseline IS NULL) = (creation_origin IS NULL)),
  ADD CONSTRAINT task_creation_proposal_origin CHECK ((creation_origin IS NULL AND creation_proposal_id IS NULL) OR
    (creation_origin IS NOT NULL AND (creation_origin = 'ai_proposal') = (creation_proposal_id IS NOT NULL))),
  ADD CONSTRAINT task_creation_reversion_shape CHECK (
    (creation_reverted_at IS NULL AND creation_reverted_by_kind IS NULL AND creation_reverted_by_id IS NULL AND creation_reversion_notice_id IS NULL)
    OR (creation_reverted_at IS NOT NULL AND creation_reverted_by_kind IS NOT NULL AND creation_reverted_by_id IS NOT NULL AND creation_reversion_notice_id IS NOT NULL
      AND creation_baseline_version IS NOT NULL AND creation_origin IN ('native_agent', 'ai_proposal') AND first_persisted_use_at IS NULL));
ALTER TABLE proactive_comparison_proposals ADD CONSTRAINT task_creation_proposal_identity UNIQUE(project_id, id);
ALTER TABLE project_work_items ADD CONSTRAINT task_creation_proposal_scope FOREIGN KEY (project_id, creation_proposal_id) REFERENCES proactive_comparison_proposals(project_id, id);
ALTER TABLE project_task_notices DROP CONSTRAINT project_task_notices_kind_check;
ALTER TABLE project_task_notices ADD CONSTRAINT project_task_notices_kind_check CHECK (kind IN ('task.created', 'task.creation_reverted'));
ALTER TABLE project_task_notices ADD CONSTRAINT task_notice_scope_identity UNIQUE(workspace_id, project_id, work_id, id);
ALTER TABLE project_work_items ADD CONSTRAINT task_creation_reversion_notice_scope
  FOREIGN KEY (workspace_id, project_id, id, creation_reversion_notice_id) REFERENCES project_task_notices(workspace_id, project_id, work_id, id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE task_creation_undo_receipts (
  workspace_id uuid NOT NULL, project_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK(actor_kind IN ('human', 'agent')), actor_id text NOT NULL,
  client_command_id uuid NOT NULL, request_fingerprint text NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
  work_id uuid NOT NULL, notice_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(project_id, actor_kind, actor_id, client_command_id),
  FOREIGN KEY(workspace_id, project_id, work_id) REFERENCES project_work_items(workspace_id, project_id, id),
  FOREIGN KEY(workspace_id, project_id, work_id, notice_id) REFERENCES project_task_notices(workspace_id, project_id, work_id, id)
);
-- Exact original receipt identity/payload/history cannot be edited or removed by a later writer.
CREATE FUNCTION flux_guard_task_creation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable task creation Undo receipt' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER task_creation_receipt_guard BEFORE UPDATE OR DELETE ON task_creation_undo_receipts
  FOR EACH ROW EXECUTE FUNCTION flux_guard_task_creation_receipt();
-- Retained history and monotonic use cannot be revived or reassigned by a later writer.
CREATE FUNCTION flux_guard_task_creation_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.creation_baseline_version IS NOT NULL AND
    (NEW.creation_baseline_version IS DISTINCT FROM OLD.creation_baseline_version OR NEW.creation_baseline IS DISTINCT FROM OLD.creation_baseline OR NEW.creation_origin IS DISTINCT FROM OLD.creation_origin
      OR NEW.creation_proposal_id IS DISTINCT FROM OLD.creation_proposal_id) THEN
    RAISE EXCEPTION 'immutable task creation baseline' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.first_persisted_use_at IS NOT NULL AND NEW.first_persisted_use_at IS DISTINCT FROM OLD.first_persisted_use_at THEN
    RAISE EXCEPTION 'immutable first task use' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.creation_reverted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'reverted task is read only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_creation_history_guard BEFORE UPDATE ON project_work_items FOR EACH ROW EXECUTE FUNCTION flux_guard_task_creation_history();

-- Exact destructive authority; existing work.update grants confer no Undo permission.
ALTER TABLE agent_standing_grants DROP CONSTRAINT agent_standing_grants_operation_check;
ALTER TABLE agent_standing_grants ADD CONSTRAINT agent_standing_grants_operation_check
 CHECK (operation IN ('work.create','work.update','work.creation.revert','result.record','decision.propose',
 'map.create','map.rename','map.thought.create','map.thought.update','map.thought.delete','map.positions.update',
 'map.link.create','map.link.delete','doc.create','doc.update','conversation.create','conversation.reply',
 'cowork.claim','cowork.renew','cowork.release','cowork.request'));
