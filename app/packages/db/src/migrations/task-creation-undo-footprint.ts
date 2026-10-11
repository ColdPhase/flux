// Reviewed semantic footprint of 0048; compare actual catalog definitions, never SQL checksums.
export const UNDO_CONSTRAINTS: readonly (readonly [string, string, string])[] = [
  [
    "project_work_items",
    "project_work_items_creation_baseline_version_check",
    "CHECK ((creation_baseline_version > 0))"
  ],
  [
    "project_work_items",
    "project_work_items_creation_origin_check",
    "CHECK ((creation_origin = ANY (ARRAY['native_agent'::text, 'ai_proposal'::text, 'human'::text])))"
  ],
  [
    "project_work_items",
    "project_work_items_creation_reverted_by_kind_check",
    "CHECK ((creation_reverted_by_kind = ANY (ARRAY['human'::text, 'agent'::text])))"
  ],
  [
    "project_work_items",
    "task_creation_baseline_origin",
    "CHECK ((((creation_baseline_version IS NULL) = (creation_origin IS NULL)) AND ((creation_baseline IS NULL) = (creation_origin IS NULL))))"
  ],
  [
    "project_work_items",
    "task_creation_proposal_origin",
    "CHECK ((((creation_origin IS NULL) AND (creation_proposal_id IS NULL)) OR ((creation_origin IS NOT NULL) AND ((creation_origin = 'ai_proposal'::text) = (creation_proposal_id IS NOT NULL)))))"
  ],
  [
    "project_work_items",
    "task_creation_proposal_scope",
    "FOREIGN KEY (project_id, creation_proposal_id) REFERENCES proactive_comparison_proposals(project_id, id)"
  ],
  [
    "project_work_items",
    "task_creation_reversion_notice_scope",
    "FOREIGN KEY (workspace_id, project_id, id, creation_reversion_notice_id) REFERENCES project_task_notices(workspace_id, project_id, work_id, id) DEFERRABLE INITIALLY DEFERRED"
  ],
  [
    "project_work_items",
    "task_creation_reversion_shape",
    "CHECK ((((creation_reverted_at IS NULL) AND (creation_reverted_by_kind IS NULL) AND (creation_reverted_by_id IS NULL) AND (creation_reversion_notice_id IS NULL)) OR ((creation_reverted_at IS NOT NULL) AND (creation_reverted_by_kind IS NOT NULL) AND (creation_reverted_by_id IS NOT NULL) AND (creation_reversion_notice_id IS NOT NULL) AND (creation_baseline_version IS NOT NULL) AND (creation_origin = ANY (ARRAY['native_agent'::text, 'ai_proposal'::text])) AND (first_persisted_use_at IS NULL))))"
  ],
  [
    "proactive_comparison_proposals",
    "task_creation_proposal_identity",
    "UNIQUE (project_id, id)"
  ],
  [
    "project_task_notices",
    "project_task_notices_kind_check",
    "CHECK ((kind = ANY (ARRAY['task.created'::text, 'task.creation_reverted'::text])))"
  ],
  [
    "project_task_notices",
    "task_notice_scope_identity",
    "UNIQUE (workspace_id, project_id, work_id, id)"
  ],
  [
    "task_creation_undo_receipts",
    "task_creation_undo_receipts_actor_id_not_null",
    "NOT NULL actor_id"
  ],
  [
    "task_creation_undo_receipts",
    "task_creation_undo_receipts_actor_kind_check",
    "CHECK ((actor_kind = ANY (ARRAY['human'::text, 'agent'::text])))"
  ],
  [
    "task_creation_undo_receipts",
    "task_creation_undo_receipts_actor_kind_not_null",
    "NOT NULL actor_kind"
  ],
  [
    "task_creation_undo_receipts",
    "task_creation_undo_receipts_client_command_id_not_null",
    "NOT NULL client_command_id"
  ],
  [
    "task_creation_undo_receipts",
    "task_creation_undo_receipts_created_at_not_null",
    "NOT NULL created_at"
  ],
  [
    "task_creation_undo_receipts",
    "task_creation_undo_receipts_notice_id_not_null",
    "NOT NULL notice_id"
  ],
  [
    "task_creation_undo_receipts",
    "task_creation_undo_receipts_pkey",
    "PRIMARY KEY (project_id, actor_kind, actor_id, client_command_id)"
  ],
  [
    "task_creation_undo_receipts",
    "task_creation_undo_receipts_project_id_not_null",
    "NOT NULL project_id"
  ],
  [
    "task_creation_undo_receipts",
    "task_creation_undo_receipts_request_fingerprint_check",
    "CHECK ((request_fingerprint ~ '^[a-f0-9]{64}$'::text))"
  ],
  [
    "task_creation_undo_receipts",
    "task_creation_undo_receipts_request_fingerprint_not_null",
    "NOT NULL request_fingerprint"
  ],
  [
    "task_creation_undo_receipts",
    "task_creation_undo_receipts_work_id_not_null",
    "NOT NULL work_id"
  ],
  [
    "task_creation_undo_receipts",
    "task_creation_undo_receipts_workspace_id_not_null",
    "NOT NULL workspace_id"
  ],
  [
    "task_creation_undo_receipts",
    "task_creation_undo_receipts_workspace_id_project_id_work__fkey1",
    "FOREIGN KEY (workspace_id, project_id, work_id, notice_id) REFERENCES project_task_notices(workspace_id, project_id, work_id, id)"
  ],
  [
    "task_creation_undo_receipts",
    "task_creation_undo_receipts_workspace_id_project_id_work_i_fkey",
    "FOREIGN KEY (workspace_id, project_id, work_id) REFERENCES project_work_items(workspace_id, project_id, id)"
  ]
];
export const UNDO_GUARD_BODIES: Readonly<Record<string, string>> = {
  "flux_guard_task_creation_receipt": "\nBEGIN\n  RAISE EXCEPTION 'immutable task creation Undo receipt' USING ERRCODE = 'check_violation';\nEND ",
  "flux_guard_task_creation_history": "\nBEGIN\n  IF OLD.creation_baseline_version IS NOT NULL AND\n    (NEW.creation_baseline_version IS DISTINCT FROM OLD.creation_baseline_version OR NEW.creation_baseline IS DISTINCT FROM OLD.creation_baseline OR NEW.creation_origin IS DISTINCT FROM OLD.creation_origin\n      OR NEW.creation_proposal_id IS DISTINCT FROM OLD.creation_proposal_id) THEN\n    RAISE EXCEPTION 'immutable task creation baseline' USING ERRCODE = 'check_violation';\n  END IF;\n  IF OLD.first_persisted_use_at IS NOT NULL AND NEW.first_persisted_use_at IS DISTINCT FROM OLD.first_persisted_use_at THEN\n    RAISE EXCEPTION 'immutable first task use' USING ERRCODE = 'check_violation';\n  END IF;\n  -- Every column this migration knows; a later migration's own new column can still be backfilled.\n  IF OLD.creation_reverted_at IS NOT NULL AND (ROW(NEW.id, NEW.workspace_id, NEW.project_id, NEW.title, NEW.outcome, NEW.status, NEW.blocker,\n      NEW.owner_user_id, NEW.owner_agent_id, NEW.parked_by_decision_id, NEW.parked_at, NEW.created_by_kind, NEW.created_by_id,\n      NEW.client_command_id, NEW.request_fingerprint, NEW.criteria, NEW.version, NEW.created_at, NEW.updated_at,\n      NEW.creation_origin, NEW.creation_baseline, NEW.creation_baseline_version, NEW.creation_proposal_id, NEW.first_persisted_use_at,\n      NEW.creation_reverted_at, NEW.creation_reverted_by_kind, NEW.creation_reverted_by_id, NEW.creation_reversion_notice_id)\n    IS DISTINCT FROM ROW(OLD.id, OLD.workspace_id, OLD.project_id, OLD.title, OLD.outcome, OLD.status, OLD.blocker,\n      OLD.owner_user_id, OLD.owner_agent_id, OLD.parked_by_decision_id, OLD.parked_at, OLD.created_by_kind, OLD.created_by_id,\n      OLD.client_command_id, OLD.request_fingerprint, OLD.criteria, OLD.version, OLD.created_at, OLD.updated_at,\n      OLD.creation_origin, OLD.creation_baseline, OLD.creation_baseline_version, OLD.creation_proposal_id, OLD.first_persisted_use_at,\n      OLD.creation_reverted_at, OLD.creation_reverted_by_kind, OLD.creation_reverted_by_id, OLD.creation_reversion_notice_id)) THEN\n    RAISE EXCEPTION 'reverted task is read only' USING ERRCODE = 'check_violation';\n  END IF;\n  RETURN NEW;\nEND "
};
