-- A live invitation becomes one quiet notification for its recipient (#62). The generator
-- derives it from the committed `project.live_invited.v1` event; only the reason is new.
-- 0015 declared the reason CHECK inline, so PostgreSQL named it notifications_reason_check.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_reason_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_reason_check
  CHECK (reason IN ('mention', 'question', 'reply', 'dm', 'assigned', 'review', 'invitation'));

INSERT INTO flux_schema_version(version) VALUES (21) ON CONFLICT DO NOTHING;
