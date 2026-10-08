-- #350 (F-026 S22): the morning summary. One push at a local time in the quiet-hours time zone,
-- counting what still waits in the person's inbox. `summary_last_on` is the local day it last
-- went out, so a worker replica or a repeated tick never sends a second one that day.
ALTER TABLE notification_preferences
  ADD COLUMN summary_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN summary_at integer NOT NULL DEFAULT 540 CHECK (summary_at >= 0 AND summary_at < 1440),
  ADD COLUMN summary_last_on date;

CREATE INDEX notification_preferences_summary_idx ON notification_preferences(user_id) WHERE summary_enabled;
