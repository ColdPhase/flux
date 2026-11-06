-- #855 (F-036 AG-3, AG-7): an agent acts with exactly its owner's rights; one "What it may do" row per agent; Undo and
-- approvals on the agent's message. Flux has no installations or data yet (founder, 2026-10-31): nothing is converted.

-- Every agent belongs to one person. A workspace-owned agent was only a grant principal, and agents have no grants.
ALTER TABLE public.agents ALTER COLUMN owner_user_id SET NOT NULL;

-- Agent project grants go: an agent's project level is its owner's, read live on every call.
DROP INDEX public.project_grants_agent_idx;
DROP INDEX public.project_grants_agent_lookup_idx;
ALTER TABLE public.project_grants DROP CONSTRAINT project_grants_check;
ALTER TABLE public.project_grants DROP COLUMN agent_id;
ALTER TABLE public.project_grants ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE public.agent_proposals DROP COLUMN agent_grant_id;
ALTER TABLE public.agent_proposals DROP COLUMN agent_grant_role;

-- Both "ask a manager" flows go: the MCP agent's access request (People) and the assistant's join request (Inbox).
DROP TABLE public.agent_access_requests;
ALTER TABLE public.notifications DROP CONSTRAINT notifications_assistant_join_identity_snapshot_fk;
ALTER TABLE public.notifications DROP CONSTRAINT notifications_assistant_join_identity_pair_check;
ALTER TABLE public.notifications DROP COLUMN assistant_join_request_id;
ALTER TABLE public.notifications DROP COLUMN assistant_join_opening_version;
DROP TABLE public.assistant_join_question_identity_snapshots;
DROP TABLE public.assistant_join_requests;

-- The project agent policy goes.
DROP TABLE public.agent_project_policies;

-- The assistant reaches every project its owner can: no project list of its own, and no chosen-projects mode.
DELETE FROM public.agent_connection_projects p USING public.agent_connections c
  WHERE c.id = p.connection_id AND c.compute_source = 'owner_assistant';

-- "What it may do": one row per agent connection (the assistant and every local client). Do it and tell me by default.
ALTER TABLE public.agent_connections ADD COLUMN may_do text DEFAULT 'act' NOT NULL;
ALTER TABLE public.agent_connections ADD CONSTRAINT agent_connections_may_do_check CHECK (may_do = ANY (ARRAY['read'::text, 'act'::text, 'ask'::text]));

-- The global approval mode, the change limit and the project mode go from the assistant's settings.
ALTER TABLE public.assistant_settings DROP CONSTRAINT assistant_settings_approval_mode_check;
ALTER TABLE public.assistant_settings DROP CONSTRAINT assistant_settings_changes_per_run_check;
ALTER TABLE public.assistant_settings DROP CONSTRAINT assistant_settings_project_mode_check;
ALTER TABLE public.assistant_settings DROP COLUMN approval_mode;
ALTER TABLE public.assistant_settings DROP COLUMN changes_per_run;
ALTER TABLE public.assistant_settings DROP COLUMN project_mode;

-- The change log: three reasons a change waits (Ask me first, deleting, other people's things), no expiry, no suggestions
-- to other people, no deferred live-Wiki edits. Skip (or Keep) is `skipped`.
ALTER TABLE public.assistant_changes DROP CONSTRAINT assistant_changes_state_check;
ALTER TABLE public.assistant_changes DROP CONSTRAINT assistant_changes_wait_reason_check;
ALTER TABLE public.assistant_changes DROP CONSTRAINT assistant_changes_after_wait_check;
ALTER TABLE public.assistant_changes DROP CONSTRAINT assistant_changes_authority_check;
ALTER TABLE public.assistant_changes DROP CONSTRAINT assistant_changes_suggestion_check;
ALTER TABLE public.assistant_changes DROP CONSTRAINT assistant_changes_expiry_check;
ALTER TABLE public.assistant_changes DROP COLUMN suggest_to_user_id;
ALTER TABLE public.assistant_changes DROP COLUMN sent_at;
ALTER TABLE public.assistant_changes DROP COLUMN inbox_at;
ALTER TABLE public.assistant_changes DROP COLUMN expires_at;
ALTER TABLE public.assistant_changes ADD CONSTRAINT assistant_changes_state_check
  CHECK (state = ANY (ARRAY['applied'::text, 'waiting'::text, 'applied_after_wait'::text, 'skipped'::text, 'undone'::text, 'refused'::text]));
ALTER TABLE public.assistant_changes ADD CONSTRAINT assistant_changes_wait_reason_check
  CHECK (wait_reason = ANY (ARRAY['ask'::text, 'removal'::text, 'others'::text]));
ALTER TABLE public.assistant_changes ADD CONSTRAINT assistant_changes_authority_check
  CHECK (authority = ANY (ARRAY['owner_request'::text, 'owner_approval'::text]));
ALTER TABLE public.assistant_changes ADD CONSTRAINT assistant_changes_after_wait_check
  CHECK (state <> 'applied_after_wait'::text OR authority = 'owner_approval'::text);

-- "Yours" is what you or your agents made and nobody else has edited (F-036 Terms): maps and thoughts record who edited them.
ALTER TABLE public.sketches ADD COLUMN edited_by text[] DEFAULT '{}'::text[] NOT NULL;
ALTER TABLE public.sketch_thoughts ADD COLUMN edited_by text[] DEFAULT '{}'::text[] NOT NULL;
