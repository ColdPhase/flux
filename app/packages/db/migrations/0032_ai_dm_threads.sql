-- #1016 (F-036 AG-4, C-40): `/ai` works in the threads of a direct message. A run in a DM thread names the thread's root message, so its
-- answer is a card of that thread, Show everyone posts it as a reply there, and the model is given that thread and nothing else. Flux has no
-- installations or data yet (founder, 2026-10-31): nothing is converted.
ALTER TABLE public.personal_runs ADD COLUMN dm_thread_root_id uuid;
-- The root must be a message of the run's own DM (like dm_messages_thread_root_fk), so the link cannot point into another DM.
ALTER TABLE public.personal_runs ADD CONSTRAINT personal_runs_dm_thread_root_fkey FOREIGN KEY (dm_id, dm_thread_root_id) REFERENCES public.dm_messages(dm_id, id) ON DELETE CASCADE;
-- Only a run in a direct message has a thread of it.
ALTER TABLE public.personal_runs ADD CONSTRAINT personal_runs_dm_thread_check CHECK (dm_thread_root_id IS NULL OR dm_id IS NOT NULL);
CREATE INDEX personal_runs_dm_thread_idx ON public.personal_runs USING btree (dm_thread_root_id, created_at DESC) WHERE (dm_thread_root_id IS NOT NULL);

-- The operation that stores an idempotent response with no workspace (F-030).
INSERT INTO public.idempotency_account_operations (operation) VALUES
  ('POST /api/v1/dms/:dmId/threads/:rootId/assistant-runs');
