-- #154: stored files as message attachments. A file is staged privately by its uploader, then published
-- once, as an attachment of exactly one message. Its bytes live in the files volume under the
-- server-selected id; only this table makes them reachable, and only through current access.
ALTER TABLE project_messages ADD CONSTRAINT project_messages_file_identity UNIQUE (workspace_id, project_id, id);
CREATE TABLE file_garbage (id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE project_files (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  uploader_id text REFERENCES auth_users(id),
  uploader_agent_id uuid,
  -- The client's stable upload UUID: a retry of the same upload returns the same file.
  upload_id uuid NOT NULL,
  -- A bounded private reservation while verifying a retry; it never becomes ready or publishes bytes.
  replay_of uuid REFERENCES project_files(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  -- `receiving` while bytes stream into private scratch (a reservation); `ready` once they are durable.
  -- An expired reservation taken over by a retry is replaced by a new row and id, so a late finish of
  -- the old attempt can neither commit nor touch the new attempt's bytes.
  state text NOT NULL CHECK (state IN ('receiving', 'ready')),
  reserved_bytes integer NOT NULL CHECK (reserved_bytes BETWEEN 0 AND 5242880 AND (reserved_bytes > 0 OR replay_of IS NOT NULL)),
  size integer CHECK (size BETWEEN 1 AND 5242880),
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  -- Unpublished rows expire (a reservation after 15 minutes, a ready file 7 days after it was ready);
  -- a published file never does.
  expires_at timestamptz,
  message_id uuid,
  position smallint CHECK (position BETWEEN 0 AND 9),
  published_at timestamptz,
  CONSTRAINT project_file_replay_receiving CHECK (replay_of IS NULL OR (state = 'receiving' AND message_id IS NULL)),
  CONSTRAINT project_file_exact_uploader CHECK (num_nonnulls(uploader_id, uploader_agent_id) = 1),
  CONSTRAINT project_file_ready_identity CHECK ((state = 'ready') = (size IS NOT NULL AND sha256 IS NOT NULL AND ready_at IS NOT NULL)),
  CONSTRAINT project_file_publication CHECK ((message_id IS NULL) = (position IS NULL) AND (message_id IS NULL) = (published_at IS NULL)),
  CONSTRAINT project_file_published_ready CHECK (message_id IS NULL OR (state = 'ready' AND expires_at IS NULL)),
  CONSTRAINT project_file_unpublished_expires CHECK (message_id IS NOT NULL OR expires_at IS NOT NULL),
  UNIQUE (message_id, position),
  FOREIGN KEY (workspace_id, project_id, message_id) REFERENCES project_messages(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, uploader_agent_id) REFERENCES agents(workspace_id, id)
);
CREATE UNIQUE INDEX project_files_human_upload_idx ON project_files(project_id, uploader_id, upload_id) WHERE uploader_id IS NOT NULL;
CREATE UNIQUE INDEX project_files_agent_upload_idx ON project_files(project_id, uploader_agent_id, upload_id) WHERE uploader_agent_id IS NOT NULL;
CREATE INDEX project_files_replay_idx ON project_files(replay_of) WHERE replay_of IS NOT NULL;
CREATE INDEX project_files_expiry_idx ON project_files(expires_at) WHERE message_id IS NULL;

-- A message may carry attachments instead of text, never neither. The count is the message's own
-- statement of how many published files belong to it.
ALTER TABLE project_messages ADD COLUMN attachment_count smallint NOT NULL DEFAULT 0
  CONSTRAINT project_message_attachment_count CHECK (attachment_count BETWEEN 0 AND 10);
ALTER TABLE project_messages DROP CONSTRAINT project_messages_body_check;
ALTER TABLE project_messages ADD CONSTRAINT project_message_body_or_attachments
  CHECK (length(btrim(body)) <= 100000 AND (length(btrim(body)) >= 1 OR attachment_count > 0));

-- Preserve genuine actors and raw bodies; only the system search title describes attachment-only posts.
CREATE OR REPLACE FUNCTION search_index_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM search_documents WHERE doc_key = 'message:' || OLD.id; RETURN OLD; END IF;
  PERFORM search_put('message:' || NEW.id, 'message', NEW.workspace_id, 'project:' || NEW.project_id, NEW.project_id, NEW.id::text,
    NEW.conversation_id, NULL, NULL, CASE WHEN btrim(NEW.body) = '' THEN 'Attached files' ELSE '' END, NEW.body,
    CASE WHEN NEW.author_id IS NOT NULL THEN 'human' ELSE 'agent' END,
    coalesce(NEW.author_id, NEW.author_agent_id::text), NEW.created_at);
  RETURN NEW;
END $$;
