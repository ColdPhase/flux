-- A project message can start a thought on that same project's map (#605). Keep the source
-- inside the project and retain its author/time; Undo needs the source id to restore it.
ALTER TABLE sketch_thoughts ADD COLUMN source_author_agent_id uuid REFERENCES agents(id);
ALTER TABLE sketch_thoughts ADD COLUMN source_project_message_id uuid;
ALTER TABLE sketch_thoughts DROP CONSTRAINT sketch_thoughts_source_check;
ALTER TABLE sketch_thoughts ADD CONSTRAINT sketch_thoughts_source_author_kind_check
  CHECK (num_nonnulls(source_author_id, source_author_agent_id) IN (0, 1));
ALTER TABLE sketch_thoughts ADD CONSTRAINT sketch_thoughts_source_presence_check
  CHECK ((source_sent_at IS NULL) = (source_author_name IS NULL)
    AND (source_sent_at IS NULL) = (num_nonnulls(source_author_id, source_author_agent_id) = 0));
ALTER TABLE sketch_thoughts ADD CONSTRAINT sketch_thoughts_source_dm_project_check
  CHECK (source_project_message_id IS NULL OR (source_dm_id IS NULL AND source_message_id IS NULL
    AND source_sent_at IS NOT NULL AND num_nonnulls(source_author_id, source_author_agent_id) = 1));
ALTER TABLE sketch_thoughts ADD CONSTRAINT sketch_thoughts_source_project_message_fk
  FOREIGN KEY (source_project_message_id) REFERENCES project_messages(id);
