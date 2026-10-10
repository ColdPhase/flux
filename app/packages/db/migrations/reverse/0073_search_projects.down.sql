-- Reversal of 0073 (#465). It is not applied by the migrator and never edits the schema ledger: a
-- reversal runner owns that. Project names stop being searchable; every other search result remains.
DROP TRIGGER IF EXISTS search_index ON projects;
DROP FUNCTION IF EXISTS search_index_project();
DELETE FROM search_documents WHERE kind = 'project';
ALTER TABLE search_documents DROP CONSTRAINT search_documents_kind_check;
ALTER TABLE search_documents ADD CONSTRAINT search_documents_kind_check CHECK (kind IN (
  'message', 'dm_message', 'material', 'doc', 'work', 'decision', 'result', 'sketch', 'thought', 'draft', 'person'));
