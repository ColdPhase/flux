-- A project's optional shared goal (#520, F-028, docs/product/project-goals.md): one sentence the
-- team may set, marked reached by a person, never inferred from tasks, PRs or agents. A project has
-- at most one current (unreached) goal; reached rows stay as its history, so an ongoing project can
-- reach goal after goal. The project itself never finishes. No project has a goal yet: no backfill.
CREATE TABLE project_goals (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120 AND title = btrim(title) AND title !~ '[\r\n]'),
  -- Only a person sets a goal or marks it reached; agents read it.
  set_by text NOT NULL REFERENCES auth_users(id),
  set_at timestamptz NOT NULL DEFAULT now(),
  reached_at timestamptz,
  reached_by text REFERENCES auth_users(id),
  CHECK ((reached_at IS NULL) = (reached_by IS NULL)),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE
);
-- At most one current goal per project.
CREATE UNIQUE INDEX project_goals_current_idx ON project_goals(project_id) WHERE reached_at IS NULL;
CREATE INDEX project_goals_reached_idx ON project_goals(project_id, reached_at DESC) WHERE reached_at IS NOT NULL;
