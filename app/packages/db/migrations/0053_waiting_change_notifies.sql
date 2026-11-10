-- An agent waiting for your OK notifies (F-036 item 10, #1186): a run's (or a local client's) first change that waits for its owner's OK
-- sends the owner one notification, reason `approval`, by push and email at "Only what needs me" and above. Flux has no installations
-- or data yet (founder, 2026-10-31).
ALTER TABLE public.notifications DROP CONSTRAINT notifications_reason_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_reason_check CHECK (reason = ANY (ARRAY['mention'::text, 'question'::text, 'reply'::text,
  'dm'::text, 'assigned'::text, 'review'::text, 'invitation'::text, 'security'::text, 'approval'::text]));
