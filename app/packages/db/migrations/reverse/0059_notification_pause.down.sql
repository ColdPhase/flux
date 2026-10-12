-- Fixture/manual pre-use reversal, under an explicit transaction and matching image/backup.
-- Lock before checking so an in-flight preference write cannot race the guard.
LOCK TABLE notification_preferences IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM notification_preferences WHERE paused_until IS NOT NULL) THEN
    RAISE EXCEPTION 'Cannot reverse 0059 while a persisted focus pause remains';
  END IF;
END $$;
ALTER TABLE notification_preferences DROP COLUMN paused_until;
