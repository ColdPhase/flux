-- 0103 (#503, #534, #536). Numbered 0103 to stay clear of pending 0100-0102; the coordinator renumbers at merge.
--
-- 1. Private DM reply threads (#536): a reply is a dm_messages row whose thread_root_id names a root
--    of the SAME direct message. A root has no thread_root_id, so every existing message stays a root and
--    no backfill is needed. A reply cannot itself be a root (one level, like a project thread), which a
--    trigger enforces because a CHECK cannot read another row. The audience is still exactly dm_participants:
--    no new membership, grant or table of people exists for threads.
ALTER TABLE dm_messages ADD COLUMN thread_root_id uuid;
ALTER TABLE dm_messages ADD CONSTRAINT dm_messages_thread_root_fk
  FOREIGN KEY (dm_id, thread_root_id) REFERENCES dm_messages(dm_id, id) ON DELETE CASCADE;
ALTER TABLE dm_messages ADD CONSTRAINT dm_messages_thread_root_not_self CHECK (thread_root_id IS NULL OR thread_root_id <> id);
CREATE INDEX dm_messages_thread_idx ON dm_messages(thread_root_id, sequence) WHERE thread_root_id IS NOT NULL;
CREATE INDEX dm_messages_roots_idx ON dm_messages(dm_id, sequence) WHERE thread_root_id IS NULL;
CREATE FUNCTION dm_messages_flat_thread() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.thread_root_id IS NOT NULL AND EXISTS (SELECT 1 FROM dm_messages r WHERE r.id = NEW.thread_root_id AND r.thread_root_id IS NOT NULL) THEN
    RAISE EXCEPTION 'a reply cannot be the root of another thread' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dm_messages_flat_thread BEFORE INSERT OR UPDATE OF thread_root_id ON dm_messages
  FOR EACH ROW EXECUTE FUNCTION dm_messages_flat_thread();

-- 2. Real viewing receipts (#534): one row per message and viewer, written only by the authenticated
--    current viewer after the client observed the message. Rows say nothing about who may read them: every
--    read joins the CURRENT audience (dm_participants / project access), so a former participant's
--    observations never name them. Project and DM messages keep separate tables so each has a real key to
--    its own message and cannot mix identities.
CREATE TABLE dm_message_observations (
  workspace_id uuid NOT NULL,
  dm_id uuid NOT NULL,
  message_id uuid NOT NULL,
  viewer_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, viewer_id),
  FOREIGN KEY (dm_id, message_id) REFERENCES dm_messages(dm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, dm_id) REFERENCES dms(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX dm_message_observations_viewer_idx ON dm_message_observations(dm_id, viewer_id);

CREATE TABLE project_message_observations (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  message_id uuid NOT NULL,
  viewer_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, viewer_id),
  FOREIGN KEY (workspace_id, project_id, message_id) REFERENCES project_messages(workspace_id, project_id, id) ON DELETE CASCADE
);
CREATE INDEX project_message_observations_viewer_idx ON project_message_observations(project_id, viewer_id);
