-- #238: undo an unused AI-created task while keeping its history. Additive: every existing task keeps NULL origin,
-- baseline and use facts (its eligibility stays unknown, never guessed), and no notice is backfilled. Order-
-- independent with the shipped 0049-0054: it touches neither their tables nor the standing-grant operation list,
-- which 0057 widens after the latest rewrite of that list.
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
  -- Every column this migration knows; a later migration's own new column can still be backfilled.
  IF OLD.creation_reverted_at IS NOT NULL AND (ROW(NEW.id, NEW.workspace_id, NEW.project_id, NEW.title, NEW.outcome, NEW.status, NEW.blocker,
      NEW.owner_user_id, NEW.owner_agent_id, NEW.parked_by_decision_id, NEW.parked_at, NEW.created_by_kind, NEW.created_by_id,
      NEW.client_command_id, NEW.request_fingerprint, NEW.criteria, NEW.version, NEW.created_at, NEW.updated_at,
      NEW.creation_origin, NEW.creation_baseline, NEW.creation_baseline_version, NEW.creation_proposal_id, NEW.first_persisted_use_at,
      NEW.creation_reverted_at, NEW.creation_reverted_by_kind, NEW.creation_reverted_by_id, NEW.creation_reversion_notice_id)
    IS DISTINCT FROM ROW(OLD.id, OLD.workspace_id, OLD.project_id, OLD.title, OLD.outcome, OLD.status, OLD.blocker,
      OLD.owner_user_id, OLD.owner_agent_id, OLD.parked_by_decision_id, OLD.parked_at, OLD.created_by_kind, OLD.created_by_id,
      OLD.client_command_id, OLD.request_fingerprint, OLD.criteria, OLD.version, OLD.created_at, OLD.updated_at,
      OLD.creation_origin, OLD.creation_baseline, OLD.creation_baseline_version, OLD.creation_proposal_id, OLD.first_persisted_use_at,
      OLD.creation_reverted_at, OLD.creation_reverted_by_kind, OLD.creation_reverted_by_id, OLD.creation_reversion_notice_id)) THEN
    RAISE EXCEPTION 'reverted task is read only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_creation_history_guard BEFORE UPDATE ON project_work_items FOR EACH ROW EXECUTE FUNCTION flux_guard_task_creation_history();
