-- Simpler first minutes (founder decisions, Hubert, 2026-11-13, #1438). Both columns are new and nullable, so rows left by v0.2.0 keep working:
-- an invite made before this has no space, and a person who never hid Home's first-steps card sees it while it has steps left.
-- A space's Add people invites a new person by email: the link also adds them to that space when they join. The space going away
-- leaves the invite, which then joins the company only.
ALTER TABLE public.workspace_invites ADD COLUMN space_id uuid;
ALTER TABLE ONLY public.workspace_invites
    ADD CONSTRAINT workspace_invites_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.projects(id) ON DELETE SET NULL;
-- Home's first-steps card, hidden by its person for good (on every device).
ALTER TABLE public.auth_users ADD COLUMN first_steps_hidden_at timestamp with time zone;
