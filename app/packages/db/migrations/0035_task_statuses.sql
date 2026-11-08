-- #868 (F-038, C-50): a task has four states, and a blocked task waits for one thing.
-- #1039: a task has no parked state any more (nothing parks a task since #871), and no decision links work as "still applies".
-- "Not pursued" is Done with a "dropped" note. Blocked waits for a person, a decision or another task and goes back to Doing
-- by itself when that is resolved. "What came of it" is the one optional line at Done. Flux has no installations or data yet
-- (founder, 2026-10-31): nothing is converted.

-- The four states.
ALTER TABLE public.project_work_items DROP CONSTRAINT project_work_items_status_check;
ALTER TABLE public.project_work_items ADD CONSTRAINT project_work_items_status_check
  CHECK (status = ANY (ARRAY['open'::text, 'in_progress'::text, 'blocked'::text, 'done'::text]));
ALTER TABLE public.github_task_rule_changes DROP CONSTRAINT github_task_rule_changes_from_status_check;
ALTER TABLE public.github_task_rule_changes ADD CONSTRAINT github_task_rule_changes_from_status_check
  CHECK (from_status = ANY (ARRAY['open'::text, 'in_progress'::text, 'blocked'::text, 'done'::text]));
ALTER TABLE public.github_task_rule_changes DROP CONSTRAINT github_task_rule_changes_to_status_check;
ALTER TABLE public.github_task_rule_changes ADD CONSTRAINT github_task_rule_changes_to_status_check
  CHECK (to_status = ANY (ARRAY['open'::text, 'in_progress'::text, 'blocked'::text, 'done'::text]));
ALTER TABLE public.github_task_rules DROP CONSTRAINT github_task_rules_expected_status_check;
ALTER TABLE public.github_task_rules ADD CONSTRAINT github_task_rules_expected_status_check
  CHECK (expected_status = ANY (ARRAY['open'::text, 'in_progress'::text, 'blocked'::text, 'done'::text]));

-- A pause on a task ends when its holder changes or the task is done.
DROP TRIGGER agent_pause_follows_hold ON public.project_work_items;
CREATE OR REPLACE FUNCTION public.flux_agent_pause_follows_hold() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  DELETE FROM agent_pauses p WHERE p.task_id = NEW.id
    AND (NEW.owner_agent_id IS DISTINCT FROM p.agent_id OR NEW.status = 'done');
  RETURN NULL;
END $$;
CREATE TRIGGER agent_pause_follows_hold AFTER UPDATE OF owner_agent_id, status ON public.project_work_items FOR EACH ROW EXECUTE FUNCTION public.flux_agent_pause_follows_hold();

-- No parked state (#1039): the columns, their foreign key and checks go, and so does what read them.
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
      NEW.owner_user_id, NEW.owner_agent_id, NEW.created_by_kind, NEW.created_by_id,
      NEW.client_command_id, NEW.request_fingerprint, NEW.criteria, NEW.version, NEW.created_at, NEW.updated_at,
      NEW.creation_origin, NEW.creation_baseline, NEW.creation_baseline_version, NEW.first_persisted_use_at,
      NEW.creation_reverted_at, NEW.creation_reverted_by_kind, NEW.creation_reverted_by_id, NEW.creation_reversion_notice_id)
    IS DISTINCT FROM ROW(OLD.id, OLD.workspace_id, OLD.project_id, OLD.title, OLD.outcome, OLD.status, OLD.blocker,
      OLD.owner_user_id, OLD.owner_agent_id, OLD.created_by_kind, OLD.created_by_id,
      OLD.client_command_id, OLD.request_fingerprint, OLD.criteria, OLD.version, OLD.created_at, OLD.updated_at,
      OLD.creation_origin, OLD.creation_baseline, OLD.creation_baseline_version, OLD.first_persisted_use_at,
      OLD.creation_reverted_at, OLD.creation_reverted_by_kind, OLD.creation_reverted_by_id, OLD.creation_reversion_notice_id)) THEN
    RAISE EXCEPTION 'reverted task is read only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.search_index_work() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM search_documents WHERE doc_key = 'work:' || OLD.id; RETURN OLD; END IF;
  PERFORM search_put('work:' || NEW.id, 'work', NEW.workspace_id, 'project:' || NEW.project_id, NEW.project_id, NEW.id::text, NULL, NULL,
    NEW.status,
    NEW.title, concat_ws(E'\n', '#' || NEW.number, nullif(NEW.outcome, ''), NEW.blocker), NEW.created_by_kind, NEW.created_by_id, NEW.updated_at);
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.flux_artifact_task_is_direct(task uuid, boundary public.agent_thread_artifact_boundaries) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
  IF boundary.kind IN ('doc','material') THEN RETURN EXISTS(SELECT 1 FROM project_object_links l
    WHERE l.workspace_id=boundary.workspace_id AND l.project_id=boundary.project_id AND (
      (l.from_type='work' AND l.from_id=task AND l.to_id::text=boundary.source_id AND l.role IN ('source','related')
        AND ((l.to_type='doc' AND boundary.kind='doc') OR(l.to_type='material' AND(l.to_version IS NULL OR l.to_version::text=boundary.revision))))
      OR(boundary.kind='doc' AND l.from_type='doc' AND l.from_id::text=boundary.source_id AND l.to_type='work' AND l.to_id=task AND l.role IN('mentions','source'))));
  ELSIF boundary.kind='result' THEN RETURN EXISTS(SELECT 1 FROM project_object_links l WHERE l.workspace_id=boundary.workspace_id AND l.project_id=boundary.project_id
    AND l.from_type='result' AND l.from_id::text=boundary.source_id AND l.to_type='work' AND l.to_id=task AND l.role='about');
  ELSIF boundary.kind='decision' THEN RETURN EXISTS(SELECT 1 FROM project_object_links l WHERE l.workspace_id=boundary.workspace_id AND l.project_id=boundary.project_id
    AND l.from_type='decision' AND l.from_id::text=boundary.source_id AND l.to_type='work' AND l.to_id=task AND l.role='affects');
  ELSIF boundary.kind='thought' THEN RETURN EXISTS(SELECT 1 FROM project_object_links l JOIN sketch_thoughts t ON t.id=l.to_id JOIN sketches s ON s.id=t.sketch_id
    WHERE l.workspace_id=boundary.workspace_id AND l.project_id=boundary.project_id AND l.from_type='work' AND l.from_id=task AND l.to_type='thought'
      AND l.to_id::text=boundary.source_id AND l.role IN('source','related') AND t.workspace_id=boundary.workspace_id AND s.project_id=boundary.project_id AND s.scope='project');
  ELSIF boundary.kind='file' THEN RETURN EXISTS(SELECT 1 FROM project_files f LEFT JOIN project_messages m ON m.id=f.message_id
    LEFT JOIN project_conversations c ON c.id=m.conversation_id LEFT JOIN project_task_discussions d ON d.conversation_id=c.id
    LEFT JOIN sketch_thoughts t ON t.id=f.thought_id LEFT JOIN sketches s ON s.id=t.sketch_id
    WHERE f.id::text=boundary.source_id AND f.workspace_id=boundary.workspace_id AND f.project_id=boundary.project_id AND(
      (COALESCE(c.work_id,d.work_id)=task AND m.project_id=boundary.project_id AND m.workspace_id=boundary.workspace_id AND c.project_id=boundary.project_id AND c.workspace_id=boundary.workspace_id)
      OR(s.scope='project' AND s.project_id=boundary.project_id AND s.workspace_id=boundary.workspace_id AND EXISTS(SELECT 1 FROM project_object_links l
        WHERE l.workspace_id=boundary.workspace_id AND l.project_id=boundary.project_id AND l.from_type='work' AND l.from_id=task AND l.to_type='thought' AND l.to_id=t.id AND l.role IN('source','related')))));
  ELSE RETURN EXISTS(SELECT 1 FROM github_task_links l JOIN github_bindings b ON b.id=l.binding_id WHERE l.task_id=task AND l.workspace_id=boundary.workspace_id AND l.project_id=boundary.project_id
    AND l.binding_id::text || ':' || b.repository_id || ':' || l.pull_id || ':' || l.task_id::text=boundary.source_id AND l.facts->>'headSha'=boundary.revision AND l.state='current' AND b.state='active');
  END IF;
END $$;


--
-- Name: flux_artifact_xid_is_current(xid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.flux_artifact_xid_is_current(source_xid xid) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='transactionid'
    AND mode='ExclusiveLock' AND transactionid=source_xid)
$$;
ALTER TABLE public.project_work_items DROP CONSTRAINT project_work_items_workspace_id_project_id_parked_by_decis_fkey;
ALTER TABLE public.project_work_items DROP COLUMN parked_by_decision_id, DROP COLUMN parked_at;
ALTER TABLE public.project_object_links DROP CONSTRAINT project_object_links_role_check;
ALTER TABLE public.project_object_links ADD CONSTRAINT project_object_links_role_check
  CHECK (role = ANY (ARRAY['source'::text, 'affects'::text, 'about'::text, 'related'::text, 'mentions'::text, 'part_of'::text]));

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

-- Event data in an encrypted workspace: the words "not_pursued" and "still_applies" go; "resumedFor" names the owner told that a task can continue.
DELETE FROM public.event_data_tokens WHERE token IN ('not_pursued', 'still_applies');
INSERT INTO public.event_data_keys (key) VALUES ('resumedFor');
