-- Background work goes (#858, F-036 AG-9, F-038): reactions, background suggestions (the proactive comparison and its rules,
-- queue, proposals and allowance) and the plain morning summary of Notifications. An agent's schedules remain.
-- There is no existing data to keep.

-- Reactions: the four taps that queued events, their function, and the three tables.
DROP TRIGGER assistant_mention_reaction ON public.notifications;
DROP TRIGGER assistant_pr_reaction ON public.github_task_links;
DROP TRIGGER assistant_result_reaction ON public.project_object_links;
DROP TRIGGER assistant_task_reaction ON public.project_work_items;
DROP FUNCTION public.assistant_mention_reaction_tap();
DROP FUNCTION public.assistant_pr_reaction_tap();
DROP FUNCTION public.assistant_result_reaction_tap();
DROP FUNCTION public.assistant_task_reaction_tap();
DROP FUNCTION public.assistant_capture_reaction(uuid, text, text, uuid, uuid);
DROP TABLE public.assistant_reaction_notes, public.assistant_reaction_events, public.assistant_reactions;

-- The AI-work backstop no longer has the reaction queue to read a space from.
CREATE OR REPLACE FUNCTION public.ai_work_admission() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  policy record;
BEGIN
  SELECT state, epoch INTO policy FROM project_ai_policies WHERE project_id = NEW.project_id FOR SHARE;
  IF NOT FOUND OR policy.state <> 'allowed' OR NEW.ai_epoch IS DISTINCT FROM policy.epoch THEN
    RAISE EXCEPTION 'AI is turned off in this space' USING ERRCODE = 'FX403', HINT = 'SPACE_AI_OFF';
  END IF;
  RETURN NEW;
END $$;

-- Background suggestions. A task made from one kept the proposal it came from; that link and its check go first.
CREATE OR REPLACE FUNCTION public.flux_guard_task_creation_history() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.creation_baseline_version IS NOT NULL AND
    (NEW.creation_baseline_version IS DISTINCT FROM OLD.creation_baseline_version OR NEW.creation_baseline IS DISTINCT FROM OLD.creation_baseline OR NEW.creation_origin IS DISTINCT FROM OLD.creation_origin) THEN
    RAISE EXCEPTION 'immutable task creation baseline' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.first_persisted_use_at IS NOT NULL AND NEW.first_persisted_use_at IS DISTINCT FROM OLD.first_persisted_use_at THEN
    RAISE EXCEPTION 'immutable first task use' USING ERRCODE = 'check_violation';
  END IF;
  -- Every column this migration knows; a later migration's own new column can still be backfilled.
  IF OLD.creation_reverted_at IS NOT NULL AND (ROW(NEW.id, NEW.workspace_id, NEW.project_id, NEW.title, NEW.outcome, NEW.status, NEW.blocker,
      NEW.owner_user_id, NEW.owner_agent_id, NEW.parked_by_decision_id, NEW.parked_at, NEW.created_by_kind, NEW.created_by_id,
      NEW.client_command_id, NEW.request_fingerprint, NEW.criteria, NEW.version, NEW.created_at, NEW.updated_at,
      NEW.creation_origin, NEW.creation_baseline, NEW.creation_baseline_version, NEW.first_persisted_use_at,
      NEW.creation_reverted_at, NEW.creation_reverted_by_kind, NEW.creation_reverted_by_id, NEW.creation_reversion_notice_id)
    IS DISTINCT FROM ROW(OLD.id, OLD.workspace_id, OLD.project_id, OLD.title, OLD.outcome, OLD.status, OLD.blocker,
      OLD.owner_user_id, OLD.owner_agent_id, OLD.parked_by_decision_id, OLD.parked_at, OLD.created_by_kind, OLD.created_by_id,
      OLD.client_command_id, OLD.request_fingerprint, OLD.criteria, OLD.version, OLD.created_at, OLD.updated_at,
      OLD.creation_origin, OLD.creation_baseline, OLD.creation_baseline_version, OLD.first_persisted_use_at,
      OLD.creation_reverted_at, OLD.creation_reverted_by_kind, OLD.creation_reverted_by_id, OLD.creation_reversion_notice_id)) THEN
    RAISE EXCEPTION 'reverted task is read only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE public.project_work_items DROP CONSTRAINT task_creation_proposal_origin;
ALTER TABLE public.project_work_items DROP CONSTRAINT task_creation_proposal_scope;
ALTER TABLE public.project_work_items DROP COLUMN creation_proposal_id;
DROP TABLE public.proactive_comparison_insufficient_outcomes, public.proactive_comparison_proposals, public.proactive_comparison_outbox,
  public.proactive_comparison_project_changes, public.proactive_comparison_cursor, public.proactive_comparison_rules;
-- An API key no longer has a "background" mark: an agent uses the key its model belongs to.
DROP INDEX public.background_compute_connections_background_owner_idx;
ALTER TABLE public.background_compute_connections DROP COLUMN used_for_background;

-- The plain morning summary, and the one the assistant wrote under it: the person's own columns, the push's kind, the day rows.
CREATE OR REPLACE FUNCTION public.flux_notification_content_free() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $_$
DECLARE
  ws text;
  sep text;
  who text;
BEGIN
  IF NEW.workspace_id IS NULL OR NOT workspace_sealed(NEW.workspace_id) THEN RETURN NEW; END IF;
  -- A read-state or delivery update keeps the stored text, which was checked when written: a later rename of the
  -- account or the workspace must not make the row impossible to mark read (#712 review P2-1).
  IF TG_OP = 'UPDATE' AND NEW.title IS NOT DISTINCT FROM OLD.title AND NEW.body IS NOT DISTINCT FROM OLD.body
    AND NEW.url IS NOT DISTINCT FROM OLD.url AND NEW.workspace_id = OLD.workspace_id THEN RETURN NEW; END IF;
  -- The link carries ids only: one of the generator's forms with every id replaced (#712 review P3).
  IF NEW.url IS NOT NULL AND regexp_replace(NEW.url, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'ID', 'g')
    NOT IN ('/inbox', '/projects/ID/conversations/ID#message-ID', '/dm/ID#message-ID', '/projects/ID/tasks?open=work:ID',
      '/projects/ID/tasks?open=decision:ID', '/projects/ID/tasks?open=result:ID', '/projects/ID/live/ID?invitation=ID') THEN
    RAISE EXCEPTION 'An encrypted workspace''s notification must be content-free' USING ERRCODE = 'FX409', HINT = 'NOTIFICATION_CONTENT_REFUSED';
  END IF;
  SELECT name INTO ws FROM workspaces WHERE id = NEW.workspace_id;
  IF NEW.body = '' THEN
    IF NEW.title = ws || '''s encryption keys were changed outside Flux. It stays locked.' THEN RETURN NEW; END IF;
    IF NEW.title = ws || '''s key change cannot finish yet. Ask your server''s operator.' THEN RETURN NEW; END IF;
    FOREACH sep IN ARRAY ARRAY[' mentioned you in ', ' asked you in ', ' replied in ', ' sent you a message in ', ' assigned you a task in ',
      ' asked for your review in ', ' invited you to work together in ', ' now has an unlock password for '] LOOP
      IF length(NEW.title) > length(sep || ws) AND right(NEW.title, length(sep || ws)) = sep || ws THEN
        who := left(NEW.title, length(NEW.title) - length(sep || ws));
        IF who IN ('Someone', 'An agent') OR EXISTS (SELECT 1 FROM auth_users u WHERE u.name = who) THEN RETURN NEW; END IF;
      END IF;
    END LOOP;
  END IF;
  RAISE EXCEPTION 'An encrypted workspace''s notification must be content-free' USING ERRCODE = 'FX409', HINT = 'NOTIFICATION_CONTENT_REFUSED';
END $_$;

DROP TABLE public.assistant_morning_summaries;
ALTER TABLE public.notifications DROP COLUMN delivery_kind, DROP COLUMN summary_sources;
ALTER TABLE public.notification_preferences DROP COLUMN summary_enabled, DROP COLUMN summary_at, DROP COLUMN summary_last_on, DROP COLUMN summary_by_assistant;

-- Runs of the removed kinds.
DELETE FROM public.personal_runs WHERE kind IN ('morning_summary', 'reaction') OR authority = 'owner_reaction';
ALTER TABLE public.personal_runs DROP CONSTRAINT personal_runs_kind_check,
  ADD CONSTRAINT personal_runs_kind_check CHECK (kind = ANY (ARRAY['ask'::text, 'summarize'::text, 'map_thought'::text, 'scheduled'::text]));
ALTER TABLE public.personal_runs DROP CONSTRAINT personal_runs_authority_check,
  ADD CONSTRAINT personal_runs_authority_check CHECK (authority = ANY (ARRAY['owner_request'::text, 'owner_schedule'::text]));
