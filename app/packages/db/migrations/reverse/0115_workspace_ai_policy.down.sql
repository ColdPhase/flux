-- Reverses 0115 (F-029). Runs that ended for `ai_off` keep their status; their reason becomes `unknown`.
UPDATE personal_runs SET end_reason = 'unknown' WHERE end_reason = 'ai_off';
ALTER TABLE personal_runs
  DROP CONSTRAINT personal_runs_end_reason_check,
  ADD CONSTRAINT personal_runs_end_reason_check CHECK (end_reason IN ('sign_in_again', 'plan_limit', 'wall_clock', 'no_event', 'crashed',
    'answer_too_large', 'mcp_results_too_large', 'local_tool', 'slot_busy', 'unknown', 'max_turns', 'refused', 'model_unavailable'));
DROP FUNCTION assistant_capture_reaction(uuid,text,text,uuid,uuid);
CREATE FUNCTION assistant_capture_reaction(p_project uuid,p_owner text,p_event text,p_object uuid,p_source uuid) RETURNS void LANGUAGE sql AS $$
 INSERT INTO assistant_reaction_events(reaction_id,owner_user_id,object_id,source_id,action,event,reaction_version,state)
 SELECT id,p_owner,p_object,p_source,action,event,version,CASE WHEN p_event='pr_ready' THEN 'proof' ELSE 'queued' END
 FROM assistant_reactions WHERE enabled AND project_id=p_project AND owner_user_id=p_owner AND event=p_event
 ON CONFLICT DO NOTHING
$$;
DROP TRIGGER ai_work_admission ON personal_runs;
DROP TRIGGER ai_work_admission ON proactive_comparison_outbox;
DROP TRIGGER ai_work_admission ON assistant_reaction_events;
DROP TRIGGER ai_work_admission ON cowork_requests;
DROP TRIGGER ai_work_admission ON cowork_units;
DROP TRIGGER ai_work_admission ON agent_runtime_sessions;
DROP FUNCTION ai_work_admission();
ALTER TABLE personal_runs DROP COLUMN ai_epoch;
ALTER TABLE proactive_comparison_outbox DROP COLUMN ai_epoch;
ALTER TABLE assistant_reaction_events DROP COLUMN ai_epoch;
ALTER TABLE cowork_requests DROP COLUMN ai_epoch;
ALTER TABLE cowork_units DROP COLUMN ai_epoch;
ALTER TABLE agent_runtime_sessions DROP COLUMN ai_epoch;
DROP TRIGGER workspace_ai_policy_create ON workspaces;
DROP FUNCTION workspace_ai_policy_create();
DROP TABLE workspace_ai_policies;
