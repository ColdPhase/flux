-- Reversal of 0101 (#551). It is not applied by the migrator and never edits the schema ledger: a
-- reversal runner owns that. It restores the references without cascade and without deferral, so
-- deleting a whole project fails again on the rows named in 0101. It fails if rows now exist that
-- the restored checks forbid, and changes no row.
ALTER TABLE agent_command_receipts
  DROP CONSTRAINT agent_command_receipts_project_id_fkey,
  DROP CONSTRAINT agent_command_receipts_connection_id_grant_id_fkey,
  ADD CONSTRAINT agent_command_receipts_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id),
  ADD CONSTRAINT agent_command_receipts_connection_id_grant_id_fkey FOREIGN KEY (connection_id, grant_id)
    REFERENCES agent_standing_grants(connection_id, id);
ALTER TABLE agent_standing_grants
  DROP CONSTRAINT agent_standing_grants_workspace_id_connection_id_project_i_fkey,
  ADD CONSTRAINT agent_standing_grants_workspace_id_connection_id_project_i_fkey FOREIGN KEY (workspace_id, connection_id, project_id)
    REFERENCES agent_connection_projects(workspace_id, connection_id, project_id);
ALTER TABLE project_task_discussions
  DROP CONSTRAINT project_task_discussions_workspace_id_project_id_conversat_fkey,
  DROP CONSTRAINT project_task_discussions_conversation_id_root_message_id_r_fkey,
  ADD CONSTRAINT project_task_discussions_workspace_id_project_id_conversat_fkey FOREIGN KEY (workspace_id, project_id, conversation_id)
    REFERENCES project_conversations(workspace_id, project_id, id),
  ADD CONSTRAINT project_task_discussions_conversation_id_root_message_id_r_fkey FOREIGN KEY (conversation_id, root_message_id, root_sequence)
    REFERENCES project_messages(conversation_id, id, sequence);
ALTER TABLE drafts
  DROP CONSTRAINT drafts_workspace_id_project_id_fkey,
  ADD CONSTRAINT drafts_workspace_id_project_id_fkey FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id);
ALTER TABLE project_material_versions
  ALTER CONSTRAINT project_material_versions_workspace_id_source_draft_id_fkey NOT DEFERRABLE;
ALTER TABLE proactive_comparison_outbox
  DROP CONSTRAINT proactive_comparison_outbox_rule_id_fkey,
  DROP CONSTRAINT proactive_comparison_outbox_result_id_fkey,
  ADD CONSTRAINT proactive_comparison_outbox_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES proactive_comparison_rules(id),
  ADD CONSTRAINT proactive_comparison_outbox_result_id_fkey FOREIGN KEY (result_id) REFERENCES project_results(id);
ALTER TABLE proactive_comparison_proposals
  DROP CONSTRAINT proactive_comparison_proposals_project_id_fkey,
  DROP CONSTRAINT proactive_comparison_proposals_result_id_fkey,
  ADD CONSTRAINT proactive_comparison_proposals_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id),
  ADD CONSTRAINT proactive_comparison_proposals_result_id_fkey FOREIGN KEY (result_id) REFERENCES project_results(id);
ALTER TABLE proactive_comparison_insufficient_outcomes
  DROP CONSTRAINT proactive_comparison_insufficient_outcomes_project_id_fkey,
  DROP CONSTRAINT proactive_comparison_insufficient_outcomes_result_id_fkey,
  ADD CONSTRAINT proactive_comparison_insufficient_outcomes_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id),
  ADD CONSTRAINT proactive_comparison_insufficient_outcomes_result_id_fkey FOREIGN KEY (result_id) REFERENCES project_results(id);
ALTER TABLE proactive_comparison_outbox
  ALTER CONSTRAINT proactive_comparison_outbox_proposal_id_fkey NOT DEFERRABLE,
  ALTER CONSTRAINT proactive_comparison_outbox_insufficient_outcome_id_fkey NOT DEFERRABLE;
ALTER TABLE proactive_comparison_proposals
  ALTER CONSTRAINT proactive_comparison_proposals_outbox_id_fkey NOT DEFERRABLE,
  ALTER CONSTRAINT proactive_comparison_proposals_used_work_id_fkey NOT DEFERRABLE;
ALTER TABLE proactive_comparison_insufficient_outcomes
  ALTER CONSTRAINT proactive_comparison_insufficient_outcomes_outbox_id_fkey NOT DEFERRABLE;
