-- #551: erasing a whole project. The references below had no cascade, so deleting a project failed on
-- agent action receipts, standing grants, task discussions, drafts and the proactive comparison rows.
-- As in 0098 the rows go only together with their owner, in the same statement. Nothing else changes:
-- no trigger is touched, and no row is updated or removed by this migration.
--   project: receipts, standing grants, drafts, proactive rules' candidates, proposals and outcomes;
--   task:    its discussion binding (the conversation and messages stay with the project).
-- Retention is recorded in docs/product/cowork-workflow.md (CW-2, "Retention").

-- Agent action receipts and standing grants. A receipt also leaves with the grant it was made under.
ALTER TABLE agent_command_receipts
  DROP CONSTRAINT agent_command_receipts_project_id_fkey,
  DROP CONSTRAINT agent_command_receipts_connection_id_grant_id_fkey,
  ADD CONSTRAINT agent_command_receipts_project_id_fkey FOREIGN KEY (project_id)
    REFERENCES projects(id) ON DELETE CASCADE,
  ADD CONSTRAINT agent_command_receipts_connection_id_grant_id_fkey FOREIGN KEY (connection_id, grant_id)
    REFERENCES agent_standing_grants(connection_id, id) ON DELETE CASCADE;
ALTER TABLE agent_standing_grants
  DROP CONSTRAINT agent_standing_grants_workspace_id_connection_id_project_i_fkey,
  ADD CONSTRAINT agent_standing_grants_workspace_id_connection_id_project_i_fkey FOREIGN KEY (workspace_id, connection_id, project_id)
    REFERENCES agent_connection_projects(workspace_id, connection_id, project_id) ON DELETE CASCADE;

-- Task discussions: the binding of a task to its conversation and root message goes with either.
ALTER TABLE project_task_discussions
  DROP CONSTRAINT project_task_discussions_workspace_id_project_id_conversat_fkey,
  DROP CONSTRAINT project_task_discussions_conversation_id_root_message_id_r_fkey,
  ADD CONSTRAINT project_task_discussions_workspace_id_project_id_conversat_fkey FOREIGN KEY (workspace_id, project_id, conversation_id)
    REFERENCES project_conversations(workspace_id, project_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT project_task_discussions_conversation_id_root_message_id_r_fkey FOREIGN KEY (conversation_id, root_message_id, root_sequence)
    REFERENCES project_messages(conversation_id, id, sequence) ON DELETE CASCADE;

-- Drafts of a project. A document version created from a draft keeps its draft until the same statement ends.
ALTER TABLE drafts
  DROP CONSTRAINT drafts_workspace_id_project_id_fkey,
  ADD CONSTRAINT drafts_workspace_id_project_id_fkey FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE project_material_versions
  ALTER CONSTRAINT project_material_versions_workspace_id_source_draft_id_fkey DEFERRABLE INITIALLY DEFERRED;

-- Proactive comparison: rules already follow their project. Candidates, proposals and outcomes follow
-- their rule, project and result. Proposals, outcomes and candidates point at each other, and a
-- proposal at the task made from it, so those checks wait for the end of the transaction. The
-- reverse check of the task-creation Undo footprint (task_creation_proposal_scope) is pinned by
-- 0048's catalog guard and is left as it is.
ALTER TABLE proactive_comparison_outbox
  DROP CONSTRAINT proactive_comparison_outbox_rule_id_fkey,
  DROP CONSTRAINT proactive_comparison_outbox_result_id_fkey,
  ADD CONSTRAINT proactive_comparison_outbox_rule_id_fkey FOREIGN KEY (rule_id)
    REFERENCES proactive_comparison_rules(id) ON DELETE CASCADE,
  ADD CONSTRAINT proactive_comparison_outbox_result_id_fkey FOREIGN KEY (result_id)
    REFERENCES project_results(id) ON DELETE CASCADE;
ALTER TABLE proactive_comparison_proposals
  DROP CONSTRAINT proactive_comparison_proposals_project_id_fkey,
  DROP CONSTRAINT proactive_comparison_proposals_result_id_fkey,
  ADD CONSTRAINT proactive_comparison_proposals_project_id_fkey FOREIGN KEY (project_id)
    REFERENCES projects(id) ON DELETE CASCADE,
  ADD CONSTRAINT proactive_comparison_proposals_result_id_fkey FOREIGN KEY (result_id)
    REFERENCES project_results(id) ON DELETE CASCADE;
ALTER TABLE proactive_comparison_insufficient_outcomes
  DROP CONSTRAINT proactive_comparison_insufficient_outcomes_project_id_fkey,
  DROP CONSTRAINT proactive_comparison_insufficient_outcomes_result_id_fkey,
  ADD CONSTRAINT proactive_comparison_insufficient_outcomes_project_id_fkey FOREIGN KEY (project_id)
    REFERENCES projects(id) ON DELETE CASCADE,
  ADD CONSTRAINT proactive_comparison_insufficient_outcomes_result_id_fkey FOREIGN KEY (result_id)
    REFERENCES project_results(id) ON DELETE CASCADE;
ALTER TABLE proactive_comparison_outbox
  ALTER CONSTRAINT proactive_comparison_outbox_proposal_id_fkey DEFERRABLE INITIALLY DEFERRED,
  ALTER CONSTRAINT proactive_comparison_outbox_insufficient_outcome_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE proactive_comparison_proposals
  ALTER CONSTRAINT proactive_comparison_proposals_outbox_id_fkey DEFERRABLE INITIALLY DEFERRED,
  ALTER CONSTRAINT proactive_comparison_proposals_used_work_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE proactive_comparison_insufficient_outcomes
  ALTER CONSTRAINT proactive_comparison_insufficient_outcomes_outbox_id_fkey DEFERRABLE INITIALLY DEFERRED;
