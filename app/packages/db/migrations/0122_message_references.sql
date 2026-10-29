-- #469 (F-026 §6): a message can cite a map thought or another message, and a stored file keeps what its bytes said at upload.
--
-- A reference stores only the kind and the id of what it cites. Nothing about the target is copied: the title, the author and
-- the place are read for each reader when the message is read, after that reader's own access to the target is decided, so a
-- reader who may not open the target gets an "unavailable" card and nothing of it. The target has no foreign key (a thought
-- removed from its map, a message erased with its thread, or a sketch moved out of reach all read as unavailable). The citing
-- message is the owner: its reference rows go with it, from a project conversation or from a direct message.
CREATE TABLE message_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_message_id uuid REFERENCES project_messages(id) ON DELETE CASCADE,
  dm_message_id uuid REFERENCES dm_messages(id) ON DELETE CASCADE,
  position smallint NOT NULL,
  kind text NOT NULL,
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_references_one_owner CHECK (num_nonnulls(project_message_id, dm_message_id) = 1),
  CONSTRAINT message_references_kind CHECK (kind IN ('thought', 'message')),
  CONSTRAINT message_references_position CHECK (position BETWEEN 0 AND 3)
);
CREATE UNIQUE INDEX message_references_project_position_idx ON message_references (project_message_id, position) WHERE project_message_id IS NOT NULL;
CREATE UNIQUE INDEX message_references_dm_position_idx ON message_references (dm_message_id, position) WHERE dm_message_id IS NOT NULL;
CREATE INDEX message_references_target_idx ON message_references (target_id);

-- Pages, data rows or playing time, read from the plaintext at upload; null when the kind is not read or the bytes did not say.
ALTER TABLE project_files ADD COLUMN page_count integer CHECK (page_count IS NULL OR page_count >= 0);
ALTER TABLE project_files ADD COLUMN row_count integer CHECK (row_count IS NULL OR row_count >= 0);
ALTER TABLE project_files ADD COLUMN duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0);
