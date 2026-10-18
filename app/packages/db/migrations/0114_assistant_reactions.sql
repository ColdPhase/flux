-- F-027 A9 #409. Events contain identifiers, never borrowed authority or a second task store.
CREATE TABLE assistant_reactions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, project_id uuid NOT NULL,
 owner_user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
 event text NOT NULL CHECK (event IN ('assigned','blocked','failed_result','mentioned','pr_ready')),
 action text NOT NULL, enabled boolean NOT NULL DEFAULT false,
 daily_limit integer NOT NULL DEFAULT 10 CHECK (daily_limit BETWEEN 1 AND 24),
 version integer NOT NULL DEFAULT 1 CHECK(version > 0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) ON DELETE CASCADE,
 UNIQUE(owner_user_id,project_id,event),
 CHECK ((event='assigned' AND action IN ('tell','suggest_plan','plan')) OR (event='blocked' AND action IN ('tell','suggest_fix','next_steps'))
 OR (event='failed_result' AND action IN ('tell','suggest_fix')) OR (event='mentioned' AND action IN ('tell','draft_reply')) OR (event='pr_ready' AND action IN ('tell','check_task')))
);
CREATE TABLE assistant_reaction_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reaction_id uuid NOT NULL REFERENCES assistant_reactions(id) ON DELETE CASCADE,
 owner_user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
 object_id uuid NOT NULL, source_id uuid NOT NULL, action text NOT NULL,
 event text NOT NULL CHECK(event IN ('assigned','blocked','failed_result','mentioned','pr_ready')),
 reaction_version integer NOT NULL CHECK(reaction_version>0),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','proof','running','done','skipped','failed')),
 run_id uuid REFERENCES personal_runs(id) ON DELETE SET NULL,
 data jsonb CHECK (data IS NULL OR jsonb_typeof(data)='object' AND octet_length(data::text)<=24000),
 line text NOT NULL DEFAULT '' CHECK(char_length(line)<=500),
 created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
 UNIQUE(reaction_id,source_id)
);
CREATE INDEX assistant_reaction_events_queue ON assistant_reaction_events(created_at) WHERE state IN ('queued','proof','running');
CREATE INDEX assistant_reaction_events_debounce ON assistant_reaction_events(owner_user_id,object_id,started_at DESC) WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX assistant_reaction_one_running ON assistant_reaction_events(reaction_id) WHERE state='running';
CREATE TABLE assistant_reaction_notes (
 owner_user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
 project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE, object_id uuid NOT NULL,
 notification_id uuid REFERENCES notifications(id) ON DELETE CASCADE, event_id uuid NOT NULL REFERENCES assistant_reaction_events(id) ON DELETE CASCADE,
 note text NOT NULL DEFAULT '' CHECK(char_length(note)<=2000), draft text CHECK(draft IS NULL OR char_length(draft)<=8000),
 PRIMARY KEY(owner_user_id,object_id)
);

-- Transactional taps of canonical writes: no text is copied, and only the event's actual owner is selected.
CREATE FUNCTION assistant_capture_reaction(p_project uuid,p_owner text,p_event text,p_object uuid,p_source uuid) RETURNS void LANGUAGE sql AS $$
 INSERT INTO assistant_reaction_events(reaction_id,owner_user_id,object_id,source_id,action,event,reaction_version,state)
 SELECT id,p_owner,p_object,p_source,action,event,version,CASE WHEN p_event='pr_ready' THEN 'proof' ELSE 'queued' END
 FROM assistant_reactions WHERE enabled AND project_id=p_project AND owner_user_id=p_owner AND event=p_event
 ON CONFLICT DO NOTHING
$$;
CREATE FUNCTION assistant_task_reaction_tap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.owner_user_id IS NOT NULL THEN
  IF TG_OP='INSERT' OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id THEN
   PERFORM assistant_capture_reaction(NEW.project_id,NEW.owner_user_id,'assigned',NEW.id,gen_random_uuid());
  END IF;
  IF NEW.status='blocked' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status OR OLD.blocker IS DISTINCT FROM NEW.blocker) THEN
   PERFORM assistant_capture_reaction(NEW.project_id,NEW.owner_user_id,'blocked',NEW.id,gen_random_uuid());
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assistant_task_reaction AFTER INSERT OR UPDATE ON project_work_items FOR EACH ROW EXECUTE FUNCTION assistant_task_reaction_tap();
CREATE FUNCTION assistant_result_reaction_tap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE person text;
BEGIN
 IF NEW.from_type='result' AND NEW.to_type='work' AND EXISTS(SELECT 1 FROM project_results WHERE id=NEW.from_id AND finding='negative' AND project_id=NEW.project_id) THEN
  SELECT owner_user_id INTO person FROM project_work_items WHERE id=NEW.to_id AND project_id=NEW.project_id;
  IF person IS NOT NULL THEN PERFORM assistant_capture_reaction(NEW.project_id,person,'failed_result',NEW.to_id,NEW.from_id); END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assistant_result_reaction AFTER INSERT ON project_object_links FOR EACH ROW EXECUTE FUNCTION assistant_result_reaction_tap();
CREATE FUNCTION assistant_mention_reaction_tap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source_type='project' AND NEW.reason IN ('mention','question') AND NEW.url ~ '/conversations/[0-9a-f-]+#message-[0-9a-f-]+' THEN
  PERFORM assistant_capture_reaction(NEW.source_id,NEW.user_id,'mentioned',NEW.id,NEW.id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assistant_mention_reaction AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION assistant_mention_reaction_tap();
CREATE FUNCTION assistant_pr_reaction_tap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE person text; source uuid := gen_random_uuid();
BEGIN
 IF NEW.state='current' AND NEW.facts->>'execution'='ready_for_review'
 AND (TG_OP='INSERT' OR OLD.facts->>'execution' IS DISTINCT FROM 'ready_for_review' OR OLD.facts->>'headSha' IS DISTINCT FROM NEW.facts->>'headSha')
 AND EXISTS(SELECT 1 FROM github_bindings WHERE id=NEW.binding_id AND state='active') THEN
  SELECT owner_user_id INTO person FROM project_work_items WHERE id=NEW.task_id AND project_id=NEW.project_id;
  IF person IS NOT NULL THEN PERFORM assistant_capture_reaction(NEW.project_id,person,'pr_ready',NEW.task_id,source);
  UPDATE assistant_reaction_events SET data=jsonb_build_object('linkId',NEW.id) WHERE source_id=source; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assistant_pr_reaction AFTER INSERT OR UPDATE ON github_task_links FOR EACH ROW EXECUTE FUNCTION assistant_pr_reaction_tap();

ALTER TABLE personal_runs DROP CONSTRAINT personal_runs_kind_check;
ALTER TABLE personal_runs ADD CONSTRAINT personal_runs_kind_check CHECK(kind IN ('ask','summarize','map_thought','scheduled','morning_summary','reaction'));
