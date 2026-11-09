-- Pause and Resume go from the server (#985): `POST /projects/:id/agent-pauses`, the table of pauses and the trigger that cleared a
-- pause when the task left its agent. There was no recorded decision and no screen for them. There is no existing data to keep.
DROP TRIGGER agent_pause_follows_hold ON public.project_work_items;
DROP FUNCTION public.flux_agent_pause_follows_hold();
DROP TABLE public.agent_pauses;

-- A space stores no views (#1043): every space shows Conversation, Tasks, Map and Wiki, so there is nothing to add or remove.
ALTER TABLE public.projects DROP COLUMN views;
