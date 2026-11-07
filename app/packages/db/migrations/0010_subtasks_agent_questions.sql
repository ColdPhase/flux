-- #841 (F-036 TA-2, TA-3): an agent splits a task into subtasks, and agents ask each other questions in a task's discussion.
-- Flux has no installations or data yet (founder, 2026-10-31): nothing is converted.

-- A subtask is a task that is part of another: the link runs from the subtask to its parent.
ALTER TABLE public.project_object_links DROP CONSTRAINT project_object_links_role_check;
ALTER TABLE public.project_object_links ADD CONSTRAINT project_object_links_role_check
  CHECK (role = ANY (ARRAY['source'::text, 'affects'::text, 'still_applies'::text, 'about'::text, 'related'::text, 'mentions'::text, 'part_of'::text]));

-- A question one agent asks another is answered by a run of the other agent, on the same task. `asked_by_run_id` is the run that
-- asked and `exchange_turn` counts the questions in a row since a person last spoke, so an exchange stops at its bound.
ALTER TABLE public.personal_runs
  ADD COLUMN asked_by_run_id uuid,
  ADD COLUMN exchange_turn smallint DEFAULT 0 NOT NULL;
ALTER TABLE public.personal_runs ADD CONSTRAINT personal_runs_asked_by_fkey FOREIGN KEY (asked_by_run_id) REFERENCES public.personal_runs(id) ON DELETE SET NULL;
ALTER TABLE public.personal_runs ADD CONSTRAINT personal_runs_exchange_turn_check CHECK (exchange_turn >= 0);
ALTER TABLE public.personal_runs DROP CONSTRAINT personal_runs_kind_check;
ALTER TABLE public.personal_runs ADD CONSTRAINT personal_runs_kind_check
  CHECK (kind = ANY (ARRAY['ask'::text, 'summarize'::text, 'map_thought'::text, 'scheduled'::text, 'morning_summary'::text, 'reaction'::text, 'task'::text, 'task_answer'::text]));
ALTER TABLE public.personal_runs DROP CONSTRAINT personal_runs_task_check;
ALTER TABLE public.personal_runs ADD CONSTRAINT personal_runs_task_check CHECK ((kind = ANY (ARRAY['task'::text, 'task_answer'::text])) = (work_id IS NOT NULL));
