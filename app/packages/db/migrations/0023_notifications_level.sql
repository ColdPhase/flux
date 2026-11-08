-- Notifications are one level and an "Email me too" switch (#872 step 2, C-32 and C-33): the per-reason channel rows and the
-- email destination go; the level and the switch are what a person stores. Flux has no installs yet, so nothing is converted.
ALTER TABLE public.notification_preferences
  ADD COLUMN level text DEFAULT 'needsYou' NOT NULL,
  ADD COLUMN email_me boolean DEFAULT true NOT NULL,
  ADD CONSTRAINT notification_preferences_level_check CHECK (level = ANY (ARRAY['needsYou'::text, 'everything'::text, 'nothing'::text])),
  DROP COLUMN channels,
  DROP COLUMN email_destination;
