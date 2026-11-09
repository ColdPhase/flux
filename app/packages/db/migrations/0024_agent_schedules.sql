-- #858 part 2, F-036 AG-9: a schedule belongs to one of its owner's agents and to no space. It is made by telling the agent in its private
-- conversation, runs there (reading what its owner can see, changing nothing, C-38, C-53) and its results arrive there. There are no schedules
-- before this (no installs), so the old ones, which were made in a space, go; and a schedule is never paused after failures (C-14).
DELETE FROM public.assistant_job_runs;
DELETE FROM public.assistant_jobs;
ALTER TABLE public.assistant_jobs
    DROP COLUMN project_id,
    DROP COLUMN conversation_id,
    DROP COLUMN post_to_conversation,
    DROP COLUMN paused_reason,
    DROP COLUMN failure_streak,
    ADD COLUMN agent_id uuid NOT NULL REFERENCES public.assistant_settings(agent_id) ON DELETE CASCADE,
    -- The web addresses a run of the schedule may read (C-30): only those its owner typed, in the sentence that asked for it or later in Change.
    -- What the agent wrote in the schedule's text gives none.
    ADD COLUMN given text[] NOT NULL DEFAULT '{}'::text[];
CREATE INDEX assistant_jobs_agent_idx ON public.assistant_jobs USING btree (agent_id, created_at, id) WHERE (deleted_at IS NULL);
-- A firing of a schedule is about a run that reads and reports: nothing in it waits for its owner.
ALTER TABLE public.assistant_job_runs DROP COLUMN needs_you;
-- A schedule's run is in its agent's private chat (no space, conversation or DM), like what the owner says to the agent there.
ALTER TABLE public.personal_runs DROP CONSTRAINT personal_runs_anchor_check;
ALTER TABLE public.personal_runs ADD CONSTRAINT personal_runs_anchor_check CHECK (
  kind = ANY (ARRAY['ask', 'summarize', 'map_thought']) OR conversation_id IS NOT NULL OR (kind = 'scheduled' AND project_id IS NULL AND dm_id IS NULL));
-- A schedule's result is a line in the agent's chat (C-53), and so is what it says when a firing could not start (no run behind it): `run_id`
-- may be empty, and `schedule` names the schedule that said it.
ALTER TABLE public.agent_chat_messages ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE public.agent_chat_messages ADD COLUMN schedule jsonb;
