-- #868 (F-038, C-50): a task has four states, and a blocked task waits for one thing.
-- "Not pursued" is Done with a "dropped" note. Blocked waits for a person, a decision or another task and goes back to Doing
-- by itself when that is resolved. "What came of it" is the one optional line at Done. Flux has no installations or data yet
-- (founder, 2026-10-31): nothing is converted.

-- The four states.
ALTER TABLE public.project_work_items DROP CONSTRAINT project_work_items_status_check;
ALTER TABLE public.project_work_items ADD CONSTRAINT project_work_items_status_check
  CHECK (status = ANY (ARRAY['open'::text, 'in_progress'::text, 'blocked'::text, 'done'::text]));
ALTER TABLE public.project_work_items DROP CONSTRAINT project_work_items_check3;
ALTER TABLE public.project_work_items ADD CONSTRAINT project_work_items_check3 CHECK (parked_at IS NULL OR status <> 'done'::text);
ALTER TABLE public.github_task_rule_changes DROP CONSTRAINT github_task_rule_changes_from_status_check;
ALTER TABLE public.github_task_rule_changes ADD CONSTRAINT github_task_rule_changes_from_status_check
  CHECK (from_status = ANY (ARRAY['open'::text, 'in_progress'::text, 'blocked'::text, 'done'::text]));
ALTER TABLE public.github_task_rule_changes DROP CONSTRAINT github_task_rule_changes_to_status_check;
ALTER TABLE public.github_task_rule_changes ADD CONSTRAINT github_task_rule_changes_to_status_check
  CHECK (to_status = ANY (ARRAY['open'::text, 'in_progress'::text, 'blocked'::text, 'done'::text]));
ALTER TABLE public.github_task_rules DROP CONSTRAINT github_task_rules_expected_status_check;
ALTER TABLE public.github_task_rules ADD CONSTRAINT github_task_rules_expected_status_check
  CHECK (expected_status = ANY (ARRAY['open'::text, 'in_progress'::text, 'blocked'::text, 'done'::text]));

CREATE OR REPLACE FUNCTION public.flux_agent_pause_follows_hold() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  DELETE FROM agent_pauses p WHERE p.task_id = NEW.id
    AND (NEW.owner_agent_id IS DISTINCT FROM p.agent_id OR NEW.status = 'done' OR NEW.parked_at IS NOT NULL);
  RETURN NULL;
END $$;

-- What a blocked task waits for: one person (waiting_for_user_id since #550), one decision or one other task. What a done task
-- says: dropped, and the one line "what came of it" (sealed in an encrypted space, like the blocker).
ALTER TABLE public.project_work_items
  ADD COLUMN waiting_for_decision_id uuid REFERENCES public.project_decisions(id) ON DELETE SET NULL,
  ADD COLUMN waiting_for_work_id uuid REFERENCES public.project_work_items(id) ON DELETE SET NULL,
  ADD COLUMN dropped boolean NOT NULL DEFAULT false,
  ADD COLUMN came_of_it text;
ALTER TABLE public.project_work_items
  ADD CONSTRAINT project_work_items_one_wait CHECK (num_nonnulls(waiting_for_user_id, waiting_for_decision_id, waiting_for_work_id) <= 1),
  ADD CONSTRAINT project_work_items_wait_only_blocked CHECK ((waiting_for_decision_id IS NULL AND waiting_for_work_id IS NULL) OR status = 'blocked'::text),
  ADD CONSTRAINT project_work_items_not_waiting_for_itself CHECK (waiting_for_work_id IS DISTINCT FROM id),
  ADD CONSTRAINT project_work_items_note_only_done CHECK ((NOT dropped AND came_of_it IS NULL) OR status = 'done'::text),
  ADD CONSTRAINT project_work_items_came_of_it_length CHECK (came_of_it IS NULL OR length(came_of_it) <= 20000);
-- What a task is waited for by: found when a decision is accepted or a task is done.
CREATE INDEX project_work_items_waiting_decision_idx ON public.project_work_items USING btree (waiting_for_decision_id) WHERE (waiting_for_decision_id IS NOT NULL);
CREATE INDEX project_work_items_waiting_work_idx ON public.project_work_items USING btree (waiting_for_work_id) WHERE (waiting_for_work_id IS NOT NULL);

-- The line is the person's words: sealed in an encrypted space like the blocker (F-030).
DROP TRIGGER z_sealed_backstop ON public.project_work_items;
CREATE TRIGGER z_sealed_backstop BEFORE INSERT OR UPDATE ON public.project_work_items FOR EACH ROW WHEN (public.workspace_sealed(new.workspace_id))
  EXECUTE FUNCTION public.flux_sealed_backstop('workspace_id', 'title', 'outcome', 'blocker', 'criteria', 'creation_baseline', 'request_fingerprint', 'came_of_it');

-- The line is also written in the task's discussion, marked as what came of the task; and the stream says when a task can continue.
ALTER TABLE public.project_messages DROP CONSTRAINT project_message_contribution_kind;
ALTER TABLE public.project_messages ADD CONSTRAINT project_message_contribution_kind
  CHECK (contribution_kind = ANY (ARRAY['text'::text, 'blocker'::text, 'result'::text, 'handoff'::text, 'came_of_it'::text]));
ALTER TABLE public.project_task_updates DROP CONSTRAINT project_task_updates_kind_check;
ALTER TABLE public.project_task_updates ADD CONSTRAINT project_task_updates_kind_check
  CHECK (kind = ANY (ARRAY['task.blocked'::text, 'task.unblocked'::text, 'task.resumed'::text]));

-- Event data in an encrypted workspace: the word "not_pursued" goes; "resumedFor" names the owner told that a task can continue.
DELETE FROM public.event_data_tokens WHERE token = 'not_pursued';
INSERT INTO public.event_data_keys (key) VALUES ('resumedFor');
