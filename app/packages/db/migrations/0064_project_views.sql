-- Views that appear when needed (#351, F-026 S21): a project keeps the optional views (map, docs, agents)
-- it was given on purpose. Every project that exists now keeps all of them, so none loses a view it uses;
-- new projects start with what their template adds.
ALTER TABLE projects ADD COLUMN views text[] NOT NULL DEFAULT '{}'::text[];
UPDATE projects SET views = ARRAY['map', 'docs', 'agents'];
