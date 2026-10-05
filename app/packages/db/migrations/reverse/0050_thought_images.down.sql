-- Guarded pre-use reversal of 0050 (#252). It is not applied by the migrator and never edits the schema ledger:
-- a reversal runner owns that. The previous schema cannot publish a file to a map thought, so this refuses
-- (and changes nothing) once any image was placed on a thought. After real use, preserve the upgraded
-- database and files volume, and recover from the paired pre-upgrade backup with the matching image.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM project_files WHERE thought_id IS NOT NULL) THEN
    RAISE EXCEPTION '0050 reversal refused: images placed on map thoughts exist' USING ERRCODE = 'restrict_violation';
  END IF;
END $$;
DROP INDEX project_files_expiry_idx;
CREATE INDEX project_files_expiry_idx ON project_files(expires_at) WHERE message_id IS NULL;
DROP INDEX project_files_thought_idx;
ALTER TABLE project_files DROP CONSTRAINT project_file_replay_receiving;
ALTER TABLE project_files DROP CONSTRAINT project_file_publication;
ALTER TABLE project_files DROP CONSTRAINT project_file_published_ready;
ALTER TABLE project_files DROP CONSTRAINT project_file_unpublished_expires;
ALTER TABLE project_files ADD CONSTRAINT project_file_replay_receiving CHECK (replay_of IS NULL OR (state = 'receiving' AND message_id IS NULL));
ALTER TABLE project_files ADD CONSTRAINT project_file_publication CHECK ((message_id IS NULL) = (position IS NULL) AND (message_id IS NULL) = (published_at IS NULL));
ALTER TABLE project_files ADD CONSTRAINT project_file_published_ready CHECK (message_id IS NULL OR (state = 'ready' AND expires_at IS NULL));
ALTER TABLE project_files ADD CONSTRAINT project_file_unpublished_expires CHECK (message_id IS NOT NULL OR expires_at IS NOT NULL);
ALTER TABLE project_files DROP COLUMN thought_id;
