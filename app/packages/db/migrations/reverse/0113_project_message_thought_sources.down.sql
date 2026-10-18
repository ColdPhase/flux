-- A project-message source has no representation in the older schema. Clear that provenance
-- before restoring its author/time constraint; existing DM sources remain unchanged.
UPDATE sketch_thoughts SET source_author_id = NULL, source_author_name = NULL, source_sent_at = NULL
WHERE source_project_message_id IS NOT NULL;
ALTER TABLE sketch_thoughts DROP CONSTRAINT sketch_thoughts_source_project_message_fk;
ALTER TABLE sketch_thoughts DROP CONSTRAINT sketch_thoughts_source_dm_project_check;
ALTER TABLE sketch_thoughts DROP CONSTRAINT sketch_thoughts_source_presence_check;
ALTER TABLE sketch_thoughts DROP CONSTRAINT sketch_thoughts_source_author_kind_check;
ALTER TABLE sketch_thoughts ADD CONSTRAINT sketch_thoughts_source_check
  CHECK ((source_author_id IS NULL) = (source_sent_at IS NULL) AND (source_author_id IS NULL) = (source_author_name IS NULL));
ALTER TABLE sketch_thoughts DROP COLUMN source_project_message_id;
ALTER TABLE sketch_thoughts DROP COLUMN source_author_agent_id;
