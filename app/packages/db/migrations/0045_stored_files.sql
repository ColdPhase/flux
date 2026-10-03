-- #154: stored files as message attachments. A file is staged privately by its uploader, then published
-- once, as an attachment of exactly one message. Its bytes live in the files volume under the
-- server-selected id; only this table makes them reachable, and only through current access.
CREATE TABLE project_files (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  uploader_id text REFERENCES auth_users(id),
  uploader_agent_id uuid,
  -- The client's stable upload UUID: a retry of the same upload returns the same file.
  upload_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  -- `receiving` while bytes stream into private scratch (a reservation); `ready` once they are durable.
  -- An expired reservation taken over by a retry is replaced by a new row and id, so a late finish of
  -- the old attempt can neither commit nor touch the new attempt's bytes.
  state text NOT NULL CHECK (state IN ('receiving', 'ready')),
  reserved_bytes integer NOT NULL CHECK (reserved_bytes BETWEEN 1 AND 5242880),
  size integer CHECK (size BETWEEN 1 AND 5242880),
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  -- Unpublished rows expire (a reservation after 15 minutes, a ready file 7 days after it was ready);
  -- a published file never does.
  expires_at timestamptz,
  message_id uuid REFERENCES project_messages(id),
  position smallint CHECK (position BETWEEN 0 AND 9),
  published_at timestamptz,
  CONSTRAINT project_file_exact_uploader CHECK (num_nonnulls(uploader_id, uploader_agent_id) = 1),
  CONSTRAINT project_file_ready_identity CHECK ((state = 'ready') = (size IS NOT NULL AND sha256 IS NOT NULL AND ready_at IS NOT NULL)),
  CONSTRAINT project_file_publication CHECK ((message_id IS NULL) = (position IS NULL) AND (message_id IS NULL) = (published_at IS NULL)),
  CONSTRAINT project_file_published_ready CHECK (message_id IS NULL OR (state = 'ready' AND expires_at IS NULL)),
  CONSTRAINT project_file_unpublished_expires CHECK (message_id IS NOT NULL OR expires_at IS NOT NULL),
  UNIQUE (message_id, position),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, uploader_agent_id) REFERENCES agents(workspace_id, id)
);
CREATE UNIQUE INDEX project_files_human_upload_idx ON project_files(project_id, uploader_id, upload_id) WHERE uploader_id IS NOT NULL;
CREATE UNIQUE INDEX project_files_agent_upload_idx ON project_files(project_id, uploader_agent_id, upload_id) WHERE uploader_agent_id IS NOT NULL;
CREATE INDEX project_files_expiry_idx ON project_files(expires_at) WHERE message_id IS NULL;

-- A message may carry attachments instead of text, never neither. The count is the message's own
-- statement of how many published files belong to it.
ALTER TABLE project_messages ADD COLUMN attachment_count smallint NOT NULL DEFAULT 0
  CONSTRAINT project_message_attachment_count CHECK (attachment_count BETWEEN 0 AND 10);
ALTER TABLE project_messages DROP CONSTRAINT project_messages_body_check;
ALTER TABLE project_messages ADD CONSTRAINT project_message_body_or_attachments
  CHECK (length(btrim(body)) <= 100000 AND (length(btrim(body)) >= 1 OR attachment_count > 0));
