-- #856, #904 (F-036 AG-5): a person's agents run on the server and take tasks assigned to their owner. Flux has no installations
-- or data yet (founder, 2026-10-31): nothing is converted.

-- "When someone assigns a task to me: Do nothing / Give it to [agent]". A row is the second choice; no row is "Do nothing".
CREATE TABLE public.agent_task_taking (
    owner_user_id text NOT NULL,
    agent_id uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_task_taking_pkey PRIMARY KEY (owner_user_id),
    CONSTRAINT agent_task_taking_owner_fkey FOREIGN KEY (owner_user_id) REFERENCES public.auth_users(id) ON DELETE CASCADE,
    CONSTRAINT agent_task_taking_agent_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE
);

-- A run on a task: the same run as any other (queue, lane, room on the server, the provider's limit, Stop, changes with Undo),
-- anchored in the task's discussion. `stop_requested_by` is who pressed Stop, so the owner is told ("Stopped by Maja").
ALTER TABLE public.personal_runs
  ADD COLUMN work_id uuid,
  ADD COLUMN stop_requested_by text;
ALTER TABLE public.personal_runs ADD CONSTRAINT personal_runs_work_fkey FOREIGN KEY (work_id) REFERENCES public.project_work_items(id) ON DELETE CASCADE;
ALTER TABLE public.personal_runs ADD CONSTRAINT personal_runs_stop_by_fkey FOREIGN KEY (stop_requested_by) REFERENCES public.auth_users(id) ON DELETE SET NULL;
ALTER TABLE public.personal_runs DROP CONSTRAINT personal_runs_kind_check;
ALTER TABLE public.personal_runs ADD CONSTRAINT personal_runs_kind_check
  CHECK (kind = ANY (ARRAY['ask'::text, 'summarize'::text, 'map_thought'::text, 'scheduled'::text, 'morning_summary'::text, 'reaction'::text, 'task'::text]));
ALTER TABLE public.personal_runs ADD CONSTRAINT personal_runs_task_check CHECK ((kind = 'task') = (work_id IS NOT NULL));
CREATE INDEX personal_runs_work_idx ON public.personal_runs USING btree (work_id, created_at DESC) WHERE work_id IS NOT NULL;

-- What the server must act on, written in the transaction that caused it: a task was given to an agent, or to a person whose
-- setting names an agent (`assigned`), its agent's run began (`started`) or ended (`finished`), or a task was taken away from an agent
-- (`released`). The API drains it as soon as it is told (NOTIFY), so a task is taken within seconds and nothing is polled while idle.
-- `attempts` bounds a row that keeps failing; a failed row waits `next_try_at` before its next try.
CREATE TABLE public.agent_task_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    work_id uuid NOT NULL,
    run_id uuid,
    owner_user_id text,
    owner_agent_id uuid,
    by_kind text,
    by_id text,
    attempts smallint DEFAULT 0 NOT NULL,
    next_try_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    handled_at timestamp with time zone,
    CONSTRAINT agent_task_events_pkey PRIMARY KEY (id),
    CONSTRAINT agent_task_events_kind_check CHECK (kind = ANY (ARRAY['assigned'::text, 'started'::text, 'finished'::text, 'released'::text])),
    CONSTRAINT agent_task_events_shape_check CHECK ((kind = ANY (ARRAY['started'::text, 'finished'::text])) = (run_id IS NOT NULL)),
    CONSTRAINT agent_task_events_owner_check CHECK (num_nonnulls(owner_user_id, owner_agent_id) <= 1),
    CONSTRAINT agent_task_events_work_fkey FOREIGN KEY (work_id) REFERENCES public.project_work_items(id) ON DELETE CASCADE,
    CONSTRAINT agent_task_events_run_fkey FOREIGN KEY (run_id) REFERENCES public.personal_runs(id) ON DELETE CASCADE
);
CREATE INDEX agent_task_events_pending_idx ON public.agent_task_events USING btree (created_at, id) WHERE handled_at IS NULL;
CREATE INDEX agent_task_events_handled_idx ON public.agent_task_events USING btree (handled_at) WHERE handled_at IS NOT NULL;

CREATE FUNCTION public.agent_task_events_notify() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  PERFORM pg_notify('flux_agent_tasks', '');
  RETURN NULL;
END $$;
CREATE TRIGGER agent_task_events_notify AFTER INSERT ON public.agent_task_events FOR EACH STATEMENT EXECUTE FUNCTION public.agent_task_events_notify();

-- The task is Doing when its agent's run really starts, not while it waits for room (AgentStates 1).
CREATE FUNCTION public.personal_run_task_started() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  INSERT INTO agent_task_events (kind, work_id, run_id) VALUES ('started', NEW.work_id, NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER personal_run_task_started AFTER UPDATE OF status ON public.personal_runs FOR EACH ROW
  WHEN (NEW.work_id IS NOT NULL AND NEW.kind = 'task' AND OLD.status = 'queued' AND NEW.status = 'reading')
  EXECUTE FUNCTION public.personal_run_task_started();

-- Every end of a run on a task is written, whoever ends it: the worker, a sweep, Stop, AI turned off.
CREATE FUNCTION public.personal_run_task_ended() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
  INSERT INTO agent_task_events (kind, work_id, run_id) VALUES ('finished', NEW.work_id, NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER personal_run_task_ended AFTER UPDATE OF status ON public.personal_runs FOR EACH ROW
  WHEN (NEW.work_id IS NOT NULL AND OLD.status IN ('queued', 'reading', 'dispatching') AND NEW.status NOT IN ('queued', 'reading', 'dispatching'))
  EXECUTE FUNCTION public.personal_run_task_ended();
