-- Focus mode goes (#872 step 1, F-038): the notification pause, "push and email wait until this instant", is removed with its shell toggle.
-- Quiet hours are the only way to pause notifications. There is no existing data to keep.
ALTER TABLE public.notification_preferences DROP COLUMN paused_until;
