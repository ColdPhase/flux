DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM assistant_join_question_identity_snapshots WHERE notification_linked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Cannot reverse 0094 while a manager notification links an assistant join-question identity snapshot; preserve the recorded request identity';
  END IF;
END $$;

ALTER TABLE notifications
  DROP CONSTRAINT notifications_assistant_join_identity_snapshot_fk,
  DROP CONSTRAINT notifications_assistant_join_identity_pair_check,
  DROP COLUMN assistant_join_request_id,
  DROP COLUMN assistant_join_opening_version;
DROP TABLE assistant_join_question_identity_snapshots;
