-- A run's change that would tell another person something waits for its owner's OK (#1089, F-036 AG-3): a task that waits for them,
-- new words on a task that waits for them, or a decision or result about their task. `told_user_id` is that person, kept with a waiting
-- change so its card can show who would read what, also when the change waits for another reason (a task for someone else that would
-- tell a third person). Flux has no installs yet, so nothing is converted.
ALTER TABLE public.assistant_changes DROP CONSTRAINT assistant_changes_wait_reason_check;
ALTER TABLE public.assistant_changes ADD CONSTRAINT assistant_changes_wait_reason_check
  CHECK (wait_reason = ANY (ARRAY['ask'::text, 'removal'::text, 'others'::text, 'tells'::text]));
ALTER TABLE public.assistant_changes ADD COLUMN told_user_id text;
ALTER TABLE ONLY public.assistant_changes
    ADD CONSTRAINT assistant_changes_told_user_id_fkey FOREIGN KEY (told_user_id) REFERENCES public.auth_users(id) ON DELETE SET NULL;
