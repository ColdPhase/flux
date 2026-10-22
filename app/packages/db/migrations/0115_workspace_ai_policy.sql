-- F-029 workspace AI lock (#614, S1). docs/product/workspace-ai-lock.md
--  * One policy row per workspace. Every existing and every new workspace starts `allowed`;
--    a missing row is read as blocked by the application (fail closed).
--  * `ai_epoch` on every AI work table: the policy epoch the item was admitted under. No default
--    after the backfill, so an insert that forgets the stamp fails loudly.
--  * `ai_work_admission`: a backstop that rejects AI work while blocked or under another epoch.
--  * The reaction tap captures only while AI is allowed, stamping the epoch, and never raises.
--  * `personal_runs.end_reason` gains `ai_off`.
CREATE TABLE workspace_ai_policies (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('allowed', 'blocked')),
  epoch bigint NOT NULL DEFAULT 1 CHECK (epoch >= 1),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  changed_by text REFERENCES auth_users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO workspace_ai_policies (workspace_id, state) SELECT id, 'allowed' FROM workspaces;

CREATE FUNCTION workspace_ai_policy_create() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO workspace_ai_policies (workspace_id, state) VALUES (NEW.id, 'allowed');
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_ai_policy_create AFTER INSERT ON workspaces FOR EACH ROW EXECUTE FUNCTION workspace_ai_policy_create();

ALTER TABLE personal_runs ADD COLUMN ai_epoch bigint NOT NULL DEFAULT 1;
ALTER TABLE personal_runs ALTER COLUMN ai_epoch DROP DEFAULT;
ALTER TABLE proactive_comparison_outbox ADD COLUMN ai_epoch bigint NOT NULL DEFAULT 1;
ALTER TABLE proactive_comparison_outbox ALTER COLUMN ai_epoch DROP DEFAULT;
ALTER TABLE assistant_reaction_events ADD COLUMN ai_epoch bigint NOT NULL DEFAULT 1;
ALTER TABLE assistant_reaction_events ALTER COLUMN ai_epoch DROP DEFAULT;
ALTER TABLE cowork_requests ADD COLUMN ai_epoch bigint NOT NULL DEFAULT 1;
ALTER TABLE cowork_requests ALTER COLUMN ai_epoch DROP DEFAULT;
ALTER TABLE cowork_units ADD COLUMN ai_epoch bigint NOT NULL DEFAULT 1;
ALTER TABLE cowork_units ALTER COLUMN ai_epoch DROP DEFAULT;
ALTER TABLE agent_runtime_sessions ADD COLUMN ai_epoch bigint NOT NULL DEFAULT 1;
ALTER TABLE agent_runtime_sessions ALTER COLUMN ai_epoch DROP DEFAULT;

CREATE FUNCTION ai_work_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ws uuid;
  policy record;
BEGIN
  IF TG_TABLE_NAME = 'proactive_comparison_outbox' THEN
    SELECT workspace_id INTO ws FROM projects WHERE id = NEW.project_id;
  ELSIF TG_TABLE_NAME = 'assistant_reaction_events' THEN
    SELECT workspace_id INTO ws FROM assistant_reactions WHERE id = NEW.reaction_id;
  ELSE
    ws := NEW.workspace_id;
  END IF;
  SELECT state, epoch INTO policy FROM workspace_ai_policies WHERE workspace_id = ws FOR SHARE;
  IF NOT FOUND OR policy.state <> 'allowed' OR NEW.ai_epoch IS DISTINCT FROM policy.epoch THEN
    RAISE EXCEPTION 'AI is turned off in this workspace' USING ERRCODE = 'FX403', HINT = 'WORKSPACE_AI_BLOCKED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_work_admission BEFORE INSERT ON personal_runs FOR EACH ROW EXECUTE FUNCTION ai_work_admission();
CREATE TRIGGER ai_work_admission BEFORE INSERT ON proactive_comparison_outbox FOR EACH ROW EXECUTE FUNCTION ai_work_admission();
CREATE TRIGGER ai_work_admission BEFORE INSERT ON assistant_reaction_events FOR EACH ROW EXECUTE FUNCTION ai_work_admission();
CREATE TRIGGER ai_work_admission BEFORE INSERT ON cowork_requests FOR EACH ROW EXECUTE FUNCTION ai_work_admission();
CREATE TRIGGER ai_work_admission BEFORE INSERT ON cowork_units FOR EACH ROW EXECUTE FUNCTION ai_work_admission();
CREATE TRIGGER ai_work_admission BEFORE INSERT ON agent_runtime_sessions FOR EACH ROW EXECUTE FUNCTION ai_work_admission();

-- The reaction tap runs inside a person's own write: it checks first and skips quietly, so the
-- backstop never fails that write.
CREATE OR REPLACE FUNCTION assistant_capture_reaction(p_project uuid,p_owner text,p_event text,p_object uuid,p_source uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  policy record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM assistant_reactions WHERE enabled AND project_id=p_project AND owner_user_id=p_owner AND event=p_event) THEN
    RETURN;
  END IF;
  SELECT a.state, a.epoch INTO policy FROM workspace_ai_policies a JOIN projects p ON p.workspace_id = a.workspace_id
    WHERE p.id = p_project FOR SHARE OF a;
  IF NOT FOUND OR policy.state <> 'allowed' THEN
    RETURN;
  END IF;
  INSERT INTO assistant_reaction_events(reaction_id,owner_user_id,object_id,source_id,action,event,reaction_version,state,ai_epoch)
  SELECT id,p_owner,p_object,p_source,action,event,version,CASE WHEN p_event='pr_ready' THEN 'proof' ELSE 'queued' END,policy.epoch
  FROM assistant_reactions WHERE enabled AND project_id=p_project AND owner_user_id=p_owner AND event=p_event
  ON CONFLICT DO NOTHING;
END $$;

ALTER TABLE personal_runs
  DROP CONSTRAINT personal_runs_end_reason_check,
  ADD CONSTRAINT personal_runs_end_reason_check CHECK (end_reason IN ('sign_in_again', 'plan_limit', 'wall_clock', 'no_event', 'crashed',
    'answer_too_large', 'mcp_results_too_large', 'local_tool', 'slot_busy', 'unknown', 'max_turns', 'refused', 'model_unavailable', 'ai_off'));
