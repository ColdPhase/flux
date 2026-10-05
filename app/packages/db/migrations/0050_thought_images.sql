-- #252: a stored file can instead be published once as the image of one map thought
-- (docs/development/task-discussions.md, "Map thought images"). 0050 is the next free number:
-- 0046–0049 are reserved by open branches. Like a placement, `thought_id` has no foreign key:
-- removing the thought neither unpublishes nor deletes the file, and Undo restores the same thought.
ALTER TABLE project_files ADD COLUMN thought_id uuid;

-- "Unpublished" now means neither a message nor a thought; every rule reads `published_at`.
ALTER TABLE project_files DROP CONSTRAINT project_file_replay_receiving;
ALTER TABLE project_files DROP CONSTRAINT project_file_publication;
ALTER TABLE project_files DROP CONSTRAINT project_file_published_ready;
ALTER TABLE project_files DROP CONSTRAINT project_file_unpublished_expires;
ALTER TABLE project_files ADD CONSTRAINT project_file_replay_receiving
  CHECK (replay_of IS NULL OR (state = 'receiving' AND published_at IS NULL));
-- Published to exactly one message (at a position) or to one thought, never both.
ALTER TABLE project_files ADD CONSTRAINT project_file_publication CHECK (
  (message_id IS NULL) = (position IS NULL)
  AND num_nonnulls(message_id, thought_id) <= 1
  AND (num_nonnulls(message_id, thought_id) = 1) = (published_at IS NOT NULL));
ALTER TABLE project_files ADD CONSTRAINT project_file_published_ready
  CHECK (published_at IS NULL OR (state = 'ready' AND expires_at IS NULL));
ALTER TABLE project_files ADD CONSTRAINT project_file_unpublished_expires
  CHECK (published_at IS NOT NULL OR expires_at IS NOT NULL);

-- One image per thought.
CREATE UNIQUE INDEX project_files_thought_idx ON project_files(thought_id) WHERE thought_id IS NOT NULL;
DROP INDEX project_files_expiry_idx;
CREATE INDEX project_files_expiry_idx ON project_files(expires_at) WHERE published_at IS NULL;
