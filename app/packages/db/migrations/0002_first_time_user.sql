-- #763 first-time user study (FT-1, FT-3).

-- FT-1: a person asks a project's managers to let their own agent in. Asking grants nothing; a current project manager
-- allows (the ordinary agent grant, still capped at the owner's own access) or declines. One row per agent and project.
CREATE TABLE public.agent_access_requests (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  owner_user_id text NOT NULL REFERENCES public.auth_users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('contributor', 'viewer')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'declined')),
  decided_by text REFERENCES public.auth_users(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT agent_access_requests_agent_project_key UNIQUE (agent_id, project_id),
  CONSTRAINT agent_access_requests_project_fkey FOREIGN KEY (workspace_id, project_id) REFERENCES public.projects(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_access_requests_agent_fkey FOREIGN KEY (workspace_id, agent_id) REFERENCES public.agents(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX agent_access_requests_pending_idx ON public.agent_access_requests (project_id) WHERE state = 'pending';
-- F-030: AI is always off in an encrypted workspace, so no request row can be written there.
CREATE TRIGGER a_sealed_workspace_no_ai BEFORE INSERT ON public.agent_access_requests FOR EACH ROW EXECUTE FUNCTION public.sealed_workspace_no_ai();

-- FT-3: an invite made from a project carries it; joining gives the new person access there.
ALTER TABLE public.workspace_invites ADD COLUMN project_id uuid;
ALTER TABLE public.workspace_invites ADD CONSTRAINT workspace_invites_project_fkey
  FOREIGN KEY (workspace_id, project_id) REFERENCES public.projects(workspace_id, id) ON DELETE SET NULL (project_id);
