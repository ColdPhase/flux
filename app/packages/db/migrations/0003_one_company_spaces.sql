-- F-037 (#874): one Flux is one company, with one flat list of Spaces.

-- The company is the one workspace setup makes for the first account. Nobody creates another; a test deployment may
-- hold more workspaces for isolation, but only one of them is ever the company.
ALTER TABLE public.workspaces ADD COLUMN company boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX workspaces_one_company ON public.workspaces USING btree ((true)) WHERE company;

-- A space admin is a person's `manager` grant; a space member is a `contributor` grant. Agents never hold `manager`.
ALTER TABLE public.project_grants DROP CONSTRAINT project_grants_role_check;
ALTER TABLE public.project_grants ADD CONSTRAINT project_grants_role_check
  CHECK (role = ANY (ARRAY['manager'::text, 'contributor'::text, 'viewer'::text, 'denied'::text]));
ALTER TABLE public.project_grants ADD CONSTRAINT project_grants_manager_person CHECK (role <> 'manager' OR user_id IS NOT NULL);

-- A space has no goal (F-038 supersedes F-028).
DROP TABLE public.project_goals;

-- Invite links join the company only (F-035 as amended by F-037); an invite no longer carries a project.
ALTER TABLE public.workspace_invites DROP COLUMN project_id;

-- People who left the company or were removed: Settings › Company lists them with Restore (Hubert, 2026-11-05).
CREATE TABLE public.workspace_removed_people (
    workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES public.auth_users(id) ON DELETE CASCADE,
    removed_by text NOT NULL,
    removed_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id)
);

-- A space admin is a grant, and an encrypted workspace's events hold registered words only.
INSERT INTO public.event_data_tokens (token) VALUES ('manager');
