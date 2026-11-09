-- A run's change that would tell another person something waits for its owner's OK (#1089, F-036 AG-3): a task that waits for them,
-- or a decision or result about their task. Flux has no installs yet, so nothing is converted.
ALTER TABLE public.assistant_changes DROP CONSTRAINT assistant_changes_wait_reason_check;
ALTER TABLE public.assistant_changes ADD CONSTRAINT assistant_changes_wait_reason_check
  CHECK (wait_reason = ANY (ARRAY['ask'::text, 'removal'::text, 'others'::text, 'tells'::text]));
