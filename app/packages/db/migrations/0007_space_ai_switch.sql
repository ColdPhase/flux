-- F-037 (#874): each space has its own AI switch, and the workspace AI lock (F-029) is gone. The policy row, the epoch every
-- AI work row records and the admission backstop keep their design; they are keyed by space (the `projects` row) instead of
-- by workspace. An encrypted space (its own hidden workspace) is always blocked (F-030).

CREATE TABLE public.project_ai_policies (
    project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    state text NOT NULL,
    epoch bigint NOT NULL DEFAULT 1,
    changed_by text REFERENCES public.auth_users(id) ON DELETE SET NULL,
    changed_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT project_ai_policies_pkey PRIMARY KEY (project_id),
    CONSTRAINT project_ai_policies_epoch_check CHECK (epoch >= 1),
    CONSTRAINT project_ai_policies_state_check CHECK (state = ANY (ARRAY['allowed'::text, 'blocked'::text]))
);

-- Every space has a row, from the moment it exists. It starts allowed, blocked in an encrypted workspace; creating a space
-- with AI off then flips it before any AI work can exist.
INSERT INTO public.project_ai_policies (project_id, state, epoch)
  SELECT p.id, CASE WHEN w.encrypted OR a.state = 'blocked' THEN 'blocked' ELSE 'allowed' END, a.epoch
  FROM public.projects p JOIN public.workspaces w ON w.id = p.workspace_id JOIN public.workspace_ai_policies a ON a.workspace_id = p.workspace_id;

CREATE FUNCTION public.project_ai_policy_create() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  INSERT INTO project_ai_policies (project_id, state) VALUES (NEW.id, CASE WHEN workspace_sealed(NEW.workspace_id) THEN 'blocked' ELSE 'allowed' END);
  RETURN NEW;
END $$;
CREATE TRIGGER project_ai_policy_create AFTER INSERT ON public.projects FOR EACH ROW EXECUTE FUNCTION public.project_ai_policy_create();

CREATE FUNCTION public.project_ai_policy_encrypted() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  IF NEW.state = 'allowed' AND workspace_sealed((SELECT p.workspace_id FROM projects p WHERE p.id = NEW.project_id)) THEN
    RAISE EXCEPTION 'AI is always off in an encrypted workspace' USING ERRCODE = 'FX409', HINT = 'WORKSPACE_ENCRYPTED_AI_OFF';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_ai_policy_encrypted BEFORE INSERT OR UPDATE ON public.project_ai_policies FOR EACH ROW EXECUTE FUNCTION public.project_ai_policy_encrypted();

-- The backstop: an AI work row is admitted only while its space has AI on, at the epoch it records.
CREATE OR REPLACE FUNCTION public.ai_work_admission() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  pid uuid;
  policy record;
BEGIN
  IF TG_TABLE_NAME = 'assistant_reaction_events' THEN
    SELECT project_id INTO pid FROM assistant_reactions WHERE id = NEW.reaction_id;
  ELSE
    pid := NEW.project_id;
  END IF;
  SELECT state, epoch INTO policy FROM project_ai_policies WHERE project_id = pid FOR SHARE;
  IF NOT FOUND OR policy.state <> 'allowed' OR NEW.ai_epoch IS DISTINCT FROM policy.epoch THEN
    RAISE EXCEPTION 'AI is turned off in this space' USING ERRCODE = 'FX403', HINT = 'SPACE_AI_OFF';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.assistant_capture_reaction(p_project uuid, p_owner text, p_event text, p_object uuid, p_source uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  policy record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM assistant_reactions WHERE enabled AND project_id=p_project AND owner_user_id=p_owner AND event=p_event) THEN
    RETURN;
  END IF;
  SELECT state, epoch INTO policy FROM project_ai_policies WHERE project_id = p_project FOR SHARE;
  IF NOT FOUND OR policy.state <> 'allowed' THEN
    RETURN;
  END IF;
  INSERT INTO assistant_reaction_events(reaction_id,owner_user_id,object_id,source_id,action,event,reaction_version,state,ai_epoch)
  SELECT id,p_owner,p_object,p_source,action,event,version,CASE WHEN p_event='pr_ready' THEN 'proof' ELSE 'queued' END,policy.epoch
  FROM assistant_reactions WHERE enabled AND project_id=p_project AND owner_user_id=p_owner AND event=p_event
  ON CONFLICT DO NOTHING;
END $$;

-- An external client's session belongs to its person, not to a space: each tool call is checked against the space it names.
DROP TRIGGER ai_work_admission ON public.agent_runtime_sessions;
ALTER TABLE public.agent_runtime_sessions DROP COLUMN ai_epoch;

-- The workspace lock goes.
DROP TRIGGER workspace_ai_policy_create ON public.workspaces;
DROP FUNCTION public.workspace_ai_policy_create();
DROP TABLE public.workspace_ai_policies;
DROP FUNCTION public.workspace_ai_policy_encrypted();
